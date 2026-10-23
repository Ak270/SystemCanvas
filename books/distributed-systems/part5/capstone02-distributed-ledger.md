# Capstone 2: Distributed Ledger / Payment System

> Design a payment processing system that handles cross-service transactions correctly, with a focus on the correctness of the distributed coordination protocol.

**Concepts exercised**: Two-phase commit and in-doubt recovery (Ch 26), Outbox pattern (Ch 31), idempotency (Ch 6, Ch 30), saga compensation, exactly-once semantics (Ch 30).

---

## 1. Requirements

A customer pays for an order. The system must:

1. **Debit** the customer's wallet (Wallet Service + its own database)
2. **Reserve** inventory for the ordered items (Inventory Service + its own database)
3. **Record** the completed order (Order Service + its own database)

If any step fails, all previous steps must be rolled back. The customer must never be charged without receiving the goods, and inventory must never be reserved without a matching payment.

### Correctness Properties

| Property | Meaning |
|----------|---------|
| **Atomicity** | All three steps succeed or none do |
| **Idempotency** | Retrying the same payment request produces the same result, never a double charge |
| **Exactly-once effect** | Even if messages are delivered more than once, the side effect occurs exactly once |
| **Eventual consistency** | All services converge to the same final state, even after transient failures |

### Why Not 2PC?

Two-phase commit (Ch 26) would solve atomicity directly — a coordinator proposes the transaction to all three services, they vote, and the coordinator decides commit or abort. But 2PC has fatal practical problems in a microservice architecture:

1. **Blocking**: If the coordinator crashes after collecting YES votes, all participants are stuck in the in-doubt state. They hold locks and cannot release them until the coordinator recovers.
2. **Heterogeneous datastores**: The Wallet Service might use PostgreSQL, the Inventory Service might use DynamoDB. They don't speak XA.
3. **Latency**: 2PC requires synchronous coordination across all participants. In a geo-distributed system, this means cross-datacenter round trips on every payment.
4. **Availability**: Any single participant being unreachable blocks the entire transaction.

Instead, we use the **Saga pattern** with the **Outbox pattern** for reliable event delivery.

---

## 2. Architecture

```
                              ┌──────────────┐
                              │   API        │
                              │   Gateway    │
                              └──────┬───────┘
                                     │
                              ┌──────▼───────┐
                              │   Order      │
                              │   Service    │
                              │   (Saga      │
                              │  Orchestrator)│
                              └──────┬───────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
             ┌──────▼───────┐ ┌─────▼──────┐ ┌──────▼───────┐
             │   Wallet     │ │ Inventory  │ │   Ledger     │
             │   Service    │ │  Service   │ │   Service    │
             │              │ │            │ │              │
             │ ┌──────────┐ │ │┌──────────┐│ │ ┌──────────┐ │
             │ │PostgreSQL│ │ ││PostgreSQL││ │ │PostgreSQL│ │
             │ │          │ │ ││          ││ │ │          │ │
             │ │ wallets  │ │ ││inventory ││ │ │  orders  │ │
             │ │ outbox   │ │ ││ outbox   ││ │ │  outbox  │ │
             │ └──────────┘ │ │└──────────┘│ │ └──────────┘ │
             └──────┬───────┘ └─────┬──────┘ └──────┬───────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    │
                            ┌───────▼────────┐
                            │   Message Bus  │
                            │   (Kafka)      │
                            └────────────────┘
```

### Key Design Decisions

- **Saga Orchestrator**: The Order Service drives the saga. It decides the sequence of steps and handles compensation.
- **Outbox Pattern**: Each service writes its domain data and an outbox event in a single local transaction. A separate process (Debezium CDC or a polling publisher) reads the outbox and publishes to Kafka.
- **Idempotency Keys**: Every request carries an idempotency key. Every service stores the key-to-result mapping so retries are safe.

---

## 3. The Payment Flow

### Happy Path

```
Order Service          Wallet Service        Inventory Service
(Orchestrator)
     │                      │                      │
     │ 1. Create order      │                      │
     │    status=PENDING    │                      │
     │    saga_state=STARTED│                      │
     │                      │                      │
     │ DebitWallet           │                      │
     │  {order_id, amount,  │                      │
     │   idempotency_key}   │                      │
     ├─────────────────────▶│                      │
     │                      │                      │
     │                      │ BEGIN TX              │
     │                      │  UPDATE wallets       │
     │                      │    SET balance -= amt │
     │                      │    WHERE id = ?       │
     │                      │    AND balance >= amt  │
     │                      │  INSERT INTO outbox   │
     │                      │    (WalletDebited,    │
     │                      │     order_id, amount) │
     │                      │ COMMIT TX             │
     │                      │                      │
     │  WalletDebited       │                      │
     │◀─────────────────────┤                      │
     │                      │                      │
     │ saga_state=           │                      │
     │   WALLET_DEBITED     │                      │
     │                      │                      │
     │ ReserveInventory      │                      │
     │  {order_id, items,   │                      │
     │   idempotency_key}   │                      │
     ├──────────────────────────────────────────────▶
     │                      │                      │
     │                      │                      │ BEGIN TX
     │                      │                      │  UPDATE inventory
     │                      │                      │    SET reserved += qty
     │                      │                      │    WHERE sku = ?
     │                      │                      │    AND available >= qty
     │                      │                      │  INSERT INTO outbox
     │                      │                      │    (InventoryReserved,
     │                      │                      │     order_id, items)
     │                      │                      │ COMMIT TX
     │                      │                      │
     │  InventoryReserved   │                      │
     │◀────────────────────────────────────────────┤
     │                      │                      │
     │ saga_state=COMPLETED │                      │
     │ order status=PAID    │                      │
     │                      │                      │
```

### The Critical Invariant

At every point in the saga, the system state is one of:

| Saga State | Wallet | Inventory | Order | Consistent? |
|-----------|--------|-----------|-------|-------------|
| STARTED | Unchanged | Unchanged | PENDING | Yes — nothing happened yet |
| WALLET_DEBITED | Debited | Unchanged | PENDING | Temporarily inconsistent — money taken, no items reserved |
| COMPLETED | Debited | Reserved | PAID | Yes — money taken, items reserved |

The `WALLET_DEBITED` state is **temporarily inconsistent**. The customer has been charged but hasn't received their items. If the saga stays in this state forever (Inventory Service is permanently down), the system is broken. Compensation fixes this.

---

## 4. Compensation (The Failure Path)

### Inventory Reservation Fails

```
Order Service          Wallet Service        Inventory Service
(Orchestrator)
     │                      │                      │
     │ (saga_state =        │                      │
     │  WALLET_DEBITED)     │                      │
     │                      │                      │
     │ ReserveInventory      │                      │
     ├──────────────────────────────────────────────▶
     │                      │                      │
     │  InventoryFailed     │                      │
     │  {reason: "out of    │                      │
     │   stock"}            │                      │
     │◀────────────────────────────────────────────┤
     │                      │                      │
     │ saga_state=           │                      │
     │   COMPENSATING       │                      │
     │                      │                      │
     │ CreditWallet          │                      │
     │  {order_id, amount,  │                      │
     │   idempotency_key:   │                      │
     │   "refund-{order_id}"}│                      │
     ├─────────────────────▶│                      │
     │                      │                      │
     │                      │ BEGIN TX              │
     │                      │  UPDATE wallets       │
     │                      │    SET balance += amt │
     │                      │  INSERT INTO outbox   │
     │                      │    (WalletCredited,   │
     │                      │     order_id)         │
     │                      │ COMMIT TX             │
     │                      │                      │
     │  WalletCredited      │                      │
     │◀─────────────────────┤                      │
     │                      │                      │
     │ saga_state=FAILED    │                      │
     │ order status=         │                      │
     │   REFUNDED           │                      │
     │                      │                      │
```

### Saga State Machine

```
                    ┌─────────┐
                    │ STARTED │
                    └────┬────┘
                         │ DebitWallet
                         ▼
                  ┌──────────────┐
         ┌───────│WALLET_DEBITED│───────┐
         │       └──────────────┘       │
         │ ReserveInventory OK          │ ReserveInventory FAIL
         ▼                              ▼
   ┌───────────┐                ┌──────────────┐
   │ COMPLETED │                │ COMPENSATING │
   └───────────┘                └──────┬───────┘
                                       │ CreditWallet
                                       ▼
                                ┌───────────┐
                                │  FAILED   │
                                └───────────┘
```

Each state transition is persisted in the Order Service's database. If the orchestrator crashes, it restarts from the last persisted state and resumes the saga.

---

## 5. The Outbox Pattern in Detail

The Outbox pattern is what makes the saga reliable. Without it, we have the dual-write problem (Ch 31):

```
# WRONG — dual write
def debit_wallet(order_id, amount):
    db.execute("UPDATE wallets SET balance -= ? WHERE ...", amount)
    db.commit()
    # What if we crash here? DB committed, but Kafka never gets the event.
    kafka.publish("WalletDebited", {order_id, amount})
```

With the outbox:

```python
def debit_wallet(order_id, amount, idempotency_key):
    # Check idempotency
    existing = db.query(
        "SELECT result FROM idempotency WHERE key = ?",
        idempotency_key
    )
    if existing:
        return existing.result

    # Single atomic transaction
    with db.transaction():
        # 1. Apply the domain change
        rows = db.execute("""
            UPDATE wallets
            SET balance = balance - :amount
            WHERE customer_id = :cid AND balance >= :amount
        """, amount=amount, cid=customer_id)

        if rows == 0:
            result = {"status": "insufficient_funds"}
        else:
            result = {"status": "debited", "amount": amount}

        # 2. Write the event to the outbox (same transaction!)
        db.execute("""
            INSERT INTO outbox (id, aggregate_id, event_type, payload, created_at)
            VALUES (:id, :order_id, 'WalletDebited', :payload, NOW())
        """, id=uuid4(), order_id=order_id, payload=json.dumps(result))

        # 3. Record idempotency result
        db.execute("""
            INSERT INTO idempotency (key, result, created_at)
            VALUES (:key, :result, NOW())
        """, key=idempotency_key, result=json.dumps(result))

    # Transaction committed — both the balance change and the outbox
    # event are now durable. They cannot diverge.
    return result
```

### Outbox Publisher

A separate process reads the outbox table and publishes events to Kafka:

```python
class OutboxPublisher:
    """Polls the outbox table and publishes events to Kafka."""

    def run(self):
        while True:
            events = db.query("""
                SELECT id, event_type, payload
                FROM outbox
                WHERE published = FALSE
                ORDER BY created_at
                LIMIT 100
            """)

            for event in events:
                kafka.publish(
                    topic=event.event_type,
                    key=event.aggregate_id,
                    value=event.payload,
                    headers={"outbox_id": event.id}
                )
                db.execute(
                    "UPDATE outbox SET published = TRUE WHERE id = ?",
                    event.id
                )

            if not events:
                time.sleep(0.5)
```

**Alternative: CDC (Change Data Capture).** Instead of polling, use Debezium to stream the outbox table's WAL directly to Kafka. This is lower latency and doesn't require the polling loop:

```
PostgreSQL WAL ──▶ Debezium Connector ──▶ Kafka Topic
                   (reads outbox table
                    changes from WAL)
```

### Exactly-Once Delivery

The outbox publisher might crash after publishing to Kafka but before marking the row as published. On restart, it re-publishes the same event. This means Kafka consumers see duplicates.

Consumers must be **idempotent**. The Inbox pattern handles this:

```python
class IdempotentConsumer:
    def handle(self, event):
        # Check if we've already processed this event
        if db.query("SELECT 1 FROM inbox WHERE event_id = ?", event.id):
            return  # Already processed, skip

        with db.transaction():
            # Process the event
            self.process(event)

            # Record that we've processed it
            db.execute(
                "INSERT INTO inbox (event_id, processed_at) VALUES (?, NOW())",
                event.id
            )
```

---

## 6. Failure Scenario Analysis

### Scenario 1: Orchestrator Crashes Mid-Saga

```
Timeline:
1. Order Service creates order, saga_state=STARTED
2. Order Service sends DebitWallet to Wallet Service
3. Wallet Service debits the wallet, publishes WalletDebited
4. Order Service CRASHES before processing WalletDebited
```

**Recovery:**

1. Order Service restarts.
2. It queries its database: `saga_state=STARTED` for this order.
3. It doesn't know if the wallet was debited or not.
4. It **re-sends** DebitWallet with the same idempotency key.
5. Wallet Service looks up the idempotency key, finds the cached result, returns "already debited."
6. Order Service advances saga to WALLET_DEBITED and continues.

The idempotency key is what makes this safe. Without it, the wallet would be debited twice.

### Scenario 2: Wallet Service Crashes After Committing, Before Publishing

```
Timeline:
1. Wallet Service receives DebitWallet
2. Wallet Service commits: balance decremented + outbox event written
3. Wallet Service CRASHES before the outbox publisher sends to Kafka
```

**Recovery:**

1. Wallet Service restarts.
2. Outbox publisher resumes, finds unpublished events in the outbox table.
3. Publishes WalletDebited to Kafka.
4. Saga continues normally.

The outbox pattern guarantees that if the domain change committed, the event will eventually be published. They are in the same transaction.

### Scenario 3: Kafka Is Unreachable

```
Timeline:
1. Wallet Service commits the debit + outbox event
2. Outbox publisher tries to publish to Kafka — connection refused
3. Outbox publisher retries... and retries... and retries...
```

The outbox events accumulate in the database. When Kafka recovers, the publisher catches up and publishes all pending events in order. The saga is delayed but not corrupted.

**Backpressure concern**: If Kafka is down for hours, the outbox table grows large. Monitoring the outbox table size is critical. If it exceeds a threshold, the service should stop accepting new requests (circuit breaker).

### Scenario 4: Compensation Fails

```
Timeline:
1. Wallet debited successfully
2. Inventory reservation fails (out of stock)
3. Orchestrator sends CreditWallet (compensation)
4. Wallet Service is unreachable
```

The orchestrator retries the compensation with exponential backoff. The saga stays in COMPENSATING state until the compensation succeeds. This is why sagas require that compensation steps are always eventually possible:

**Saga rule**: Every forward step must have a compensation that is guaranteed to eventually succeed, given enough retries.

In practice:
- Debiting a wallet → Credit it back (always possible if the wallet exists)
- Reserving inventory → Release the reservation (always possible)
- Sending an email → Send a correction email (always possible, though awkward)

Some operations are inherently non-compensable (sending a physical letter, calling an external API that doesn't support refunds). These must be the **last step** in the saga so they never need compensation.

### Scenario 5: The Orchestrator's Database Loses the Saga State

If the Order Service's database loses data (disk failure, no replicas), the saga state is gone. Some sagas will be in intermediate states with no record of it.

**Mitigation**: The Order Service's database must be replicated (see Capstone 1). The saga state is mission-critical data.

**Detection**: Periodic reconciliation. Compare the Wallet Service's debit records against the Order Service's completed orders. Any debit without a matching completed order indicates a stuck saga that needs manual intervention.

---

## 7. Idempotency Key Design

### Where Keys Are Generated

```
Mobile App → API Gateway → Order Service → Wallet/Inventory Services
    │                           │                    │
    │  idempotency_key =        │                    │
    │  "pay_<user_click_uuid>"  │                    │
    │                           │                    │
    │                           │ saga_idempotency = │
    │                           │ "saga_<order_id>"  │
    │                           │                    │
    │                           │  step_idempotency= │
    │                           │  "debit_<order_id>"│
    │                           │                    │
```

- **Client key**: Generated once per user intent (one click of the "Pay" button). Persisted across retries. If the app crashes and the user taps "Pay" again, it must use the same key (stored in local storage before the first attempt).

- **Saga key**: Derived deterministically from the order ID. The orchestrator never generates a random key for a saga step — it derives it: `debit_{order_id}`, `reserve_{order_id}`. This ensures that restarting the saga from any state produces the same idempotency keys.

### Key Lifecycle

```
1. Client generates key: "pay_abc123"
2. API Gateway forwards key to Order Service
3. Order Service checks: have I seen "pay_abc123"?
   - No → create new order, start saga
   - Yes → return cached result
4. Order Service derives step keys:
   - "debit_ord_789" for Wallet Service
   - "reserve_ord_789" for Inventory Service
5. Each downstream service caches its key → result mapping
6. Keys expire after 7 days (configurable)
```

---

## 8. Distributed Tracing

When a payment fails, reconstructing what happened across three services and a message bus requires correlation:

```python
# Every request and event carries:
{
    "trace_id": "abc-123-def",      # Unique per end-to-end flow
    "span_id": "span-456",          # Unique per service hop
    "parent_span_id": "span-123",   # Links to the caller
    "timestamp": "2024-03-15T14:22:01.003Z",
    "service": "wallet-service",
    "operation": "debit_wallet",
    "order_id": "ord_789",
    "saga_state": "WALLET_DEBITED",
    "duration_ms": 45
}
```

The trace ID propagates through HTTP headers and Kafka message headers. A distributed tracing system (Jaeger, Zipkin) reconstructs the full timeline. But remember from Part 2: timestamps from different machines may not be perfectly synchronized. Use **causal ordering** (message send → message receive) as the ground truth, not wall-clock timestamps.

---

## 9. Summary

| Problem | Solution | Chapter Reference |
|---------|----------|-------------------|
| Atomicity across services | Saga pattern (orchestrated) | — |
| Reliable event delivery | Outbox pattern + CDC | Ch 31 |
| Duplicate processing | Idempotency keys + Inbox pattern | Ch 6, Ch 30 |
| Partial failure | Compensating transactions | — |
| Orchestrator crash | Persistent saga state + idempotent steps | Ch 15 |
| Message bus unavailable | Outbox accumulates, publishes on recovery | Ch 31 |
| Debugging failures | Distributed tracing with causal ordering | Ch 10, Ch 31 |

The payment system trades the strong atomicity of 2PC for the weaker but more practical guarantee of **eventual atomicity**: all steps will eventually either all succeed or all be compensated, provided every service eventually recovers and every step is idempotent and compensable.

---

**Next**: [Capstone 3 — Real-Time Collaborative Editor →](capstone03-collaborative-editor.md)
