# Chapter 31: The Dual-Write Problem and the Outbox Pattern

> **Core question**: How do I keep my relational database and my message bus in sync without using 2PC — and what is the production-grade solution?

## Prerequisites

- Two-Phase Commit and its blocking problem (Chapter 26)
- Write-Ahead Logs (Chapter 15)
- Stream processing fundamentals (Chapter 30)

---

## The Problem in One Sentence

Every time your application writes to a database **and** publishes an event to a message broker in the same operation, you have a consistency bug — even if it passes every test you write.

This is the **dual-write problem**, and it is the single most common data-consistency defect in event-driven microservice architectures. It doesn't appear in textbooks because it lives in the gap between "database transactions" and "message queues" — two topics that are usually taught separately.

---

## What Is a Dual Write?

A dual write occurs whenever application code performs two side effects that each target a different system, without an atomic boundary spanning both.

Here is the pattern that appears in almost every microservice codebase:

```python
def place_order(order):
    # Side effect 1: write to the database
    db.execute("INSERT INTO orders (id, customer_id, total) VALUES (?, ?, ?)",
               order.id, order.customer_id, order.total)
    db.commit()

    # Side effect 2: publish to the message broker
    kafka.send("order-events", {
        "type": "OrderPlaced",
        "order_id": order.id,
        "customer_id": order.customer_id,
        "total": order.total
    })
```

The database commit and the Kafka publish are **two independent operations** with **no shared transactional boundary**. The code looks sequential — first the database, then Kafka — but sequentiality does not imply atomicity.

---

## The Four Failure Scenarios

To understand why this breaks, consider what happens when a failure occurs at each possible point:

### Scenario 1: Both Succeed

```
Application ──▶ DB.commit()  ✓
            ──▶ Kafka.send() ✓
```

Everything works. The order is in the database, and downstream consumers receive the event. This is the case that passes all your tests.

### Scenario 2: Database Succeeds, Kafka Fails

```
Application ──▶ DB.commit()  ✓
            ──▶ Kafka.send() ✗  (broker unreachable, network timeout)
```

The order exists in the database, but no event was published. Downstream services — inventory, shipping, billing — never learn about it. The order is a ghost: it exists in one system but is invisible to every other.

**Real-world consequence**: A customer is charged, but their order is never fulfilled.

### Scenario 3: Database Fails, Kafka Succeeds

What if you reverse the order and publish first?

```python
def place_order(order):
    kafka.send("order-events", {"type": "OrderPlaced", ...})
    db.execute("INSERT INTO orders ...")
    db.commit()
```

```
Application ──▶ Kafka.send() ✓
            ──▶ DB.commit()  ✗  (constraint violation, disk full, deadlock)
```

An event was published for an order that doesn't exist. Downstream services try to fulfill an order that no database can find. The inventory service reserves stock for a phantom order.

### Scenario 4: Application Crashes Between the Two Writes

```
Application ──▶ DB.commit()  ✓
            ──▶ [CRASH]
            ──▶ Kafka.send() (never executed)
```

The process dies — OOM kill, hardware fault, deployment restart — after the database commit but before the Kafka publish. The database has the order. The event was never sent. If the application restarts, it has no record that it needs to retry the publish.

This is the most insidious failure because it's invisible. No error is logged. No exception is thrown. The operation simply didn't happen.

---

## Why Retries Don't Fix It

The natural instinct is to add retry logic:

```python
def place_order(order):
    db.execute("INSERT INTO orders ...")
    db.commit()

    for attempt in range(3):
        try:
            kafka.send("order-events", {...})
            return  # Success
        except KafkaException:
            time.sleep(2 ** attempt)

    # All retries failed — now what?
    log.error("Failed to publish event for order %s", order.id)
```

This helps with transient Kafka failures (Scenario 2) but fails completely for Scenario 4 (process crash). A dead process cannot retry. And even for Scenario 2, if all retries fail, you're left with the same inconsistency — plus a log message that someone needs to act on manually.

Retries also introduce a new problem: **duplicate events**. If Kafka received the message but the acknowledgment was lost (a network fault between `kafka.send()` returning and the application reading the ack), the retry publishes the event twice. Now downstream consumers see two `OrderPlaced` events for the same order.

```
Application ──▶ Kafka.send()  ✓ (message stored in Kafka)
            ◀── ack lost       ✗ (application thinks it failed)
            ──▶ Kafka.send()  ✓ (duplicate message stored)
```

---

## Why Not Just Use 2PC?

Two-Phase Commit (Chapter 26) can coordinate atomic writes across a database and a message broker. XA transactions provide exactly this capability. So why not use them?

1. **Performance**: 2PC requires holding locks on both the database and the message broker for the duration of the protocol. In a system processing thousands of orders per second, this creates a bottleneck that limits throughput.

2. **Availability**: If the coordinator crashes after sending PREPARE but before sending COMMIT, all participants are stuck in the **in-doubt state** (Chapter 26). Neither the database nor Kafka can proceed until the coordinator recovers. A single coordinator failure stalls the entire system.

3. **Kafka doesn't support XA**: Apache Kafka has its own transactional protocol (idempotent producers and transactional APIs, covered in Chapter 30), but it does not participate in XA distributed transactions. You cannot enlist a Kafka producer as an XA resource alongside a PostgreSQL connection.

4. **Operational complexity**: XA transaction managers are notoriously difficult to operate. Recovery after a coordinator crash requires manual intervention. In a microservice architecture with hundreds of services, this operational burden is unsustainable.

The industry's answer: **don't try to make two systems atomic. Make one system the source of truth, and derive the other.**

---

## The Outbox Pattern

The Outbox pattern eliminates dual writes by converting the two-system problem into a single-system problem. Instead of writing to the database and Kafka separately, the application writes the event **to the database** as part of the same transaction that writes the business data. A separate process then reads those events from the database and publishes them to Kafka.

### The Key Insight

A relational database already provides ACID transactions. If both the business data and the event are written in the same transaction, they are atomic by definition — either both are committed or neither is.

### The Architecture

```
┌─────────────────────────────────────────────┐
│                 Application                  │
│                                              │
│  BEGIN TRANSACTION                           │
│    INSERT INTO orders (id, total) VALUES ... │
│    INSERT INTO outbox (id, payload) VALUES ..│
│  COMMIT                                      │
└──────────────────────┬──────────────────────┘
                       │ (single DB transaction)
                       ▼
┌─────────────────────────────────────────────┐
│              PostgreSQL                      │
│  ┌──────────┐    ┌──────────────────┐       │
│  │  orders   │    │     outbox        │       │
│  │  table    │    │  table            │       │
│  │           │    │                   │       │
│  │ id: 1001  │    │ id: evt_1         │       │
│  │ total: 99 │    │ aggregate_id: 1001│       │
│  └──────────┘    │ type: OrderPlaced │       │
│                   │ payload: {...}    │       │
│                   │ published: false  │       │
│                   └──────────────────┘       │
└──────────────────────┬──────────────────────┘
                       │
          ┌────────────┴────────────┐
          │                         │
          ▼                         ▼
   (Option A)                (Option B)
   Polling relay              CDC relay
   process                   (Debezium)
          │                         │
          ▼                         ▼
   ┌──────────────────────────────────┐
   │            Apache Kafka           │
   │  Topic: order-events              │
   │  Partition 0: [OrderPlaced:1001]  │
   └──────────────────────────────────┘
```

### The Application Code

```python
def place_order(order):
    with db.transaction() as txn:
        # Business data
        txn.execute(
            "INSERT INTO orders (id, customer_id, total, status) VALUES (?, ?, ?, ?)",
            order.id, order.customer_id, order.total, 'PLACED'
        )

        # Event in the same transaction
        event = {
            "type": "OrderPlaced",
            "order_id": order.id,
            "customer_id": order.customer_id,
            "total": order.total,
            "timestamp": datetime.utcnow().isoformat()
        }
        txn.execute(
            "INSERT INTO outbox (id, aggregate_type, aggregate_id, type, payload, created_at) "
            "VALUES (?, ?, ?, ?, ?, NOW())",
            uuid4(), 'Order', order.id, 'OrderPlaced', json.dumps(event)
        )
    # Transaction commits atomically — both rows or neither
    # No Kafka call here at all
```

The application **never talks to Kafka directly**. It writes events to the outbox table, and a separate relay process handles publication.

### The Outbox Table Schema

```sql
CREATE TABLE outbox (
    id              UUID PRIMARY KEY,
    aggregate_type  VARCHAR(255) NOT NULL,  -- e.g., 'Order', 'Customer'
    aggregate_id    VARCHAR(255) NOT NULL,  -- e.g., order ID
    type            VARCHAR(255) NOT NULL,  -- e.g., 'OrderPlaced'
    payload         JSONB NOT NULL,         -- the event data
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    published_at    TIMESTAMP NULL          -- NULL = not yet published
);

CREATE INDEX idx_outbox_unpublished ON outbox (created_at)
    WHERE published_at IS NULL;
```

The `published_at` column tracks whether the relay has successfully published each event. The partial index on unpublished rows makes polling efficient even when the table contains millions of historical events.

---

## Relay Implementation: Polling vs CDC

The relay process reads events from the outbox table and publishes them to Kafka. There are two approaches.

### Option A: Polling Relay

The simplest implementation polls the outbox table on a fixed interval:

```python
class OutboxPollingRelay:
    def __init__(self, db, kafka_producer, poll_interval_ms=100):
        self.db = db
        self.producer = kafka_producer
        self.poll_interval = poll_interval_ms / 1000.0

    def run(self):
        while True:
            events = self.fetch_unpublished()
            for event in events:
                self.publish(event)
            time.sleep(self.poll_interval)

    def fetch_unpublished(self):
        return self.db.query(
            "SELECT id, aggregate_type, aggregate_id, type, payload "
            "FROM outbox "
            "WHERE published_at IS NULL "
            "ORDER BY created_at "
            "LIMIT 100 "
            "FOR UPDATE SKIP LOCKED"  # Prevent duplicate processing
        )

    def publish(self, event):
        topic = f"{event.aggregate_type.lower()}-events"
        key = event.aggregate_id  # Partition by aggregate for ordering

        # Publish to Kafka
        self.producer.send(topic, key=key, value=event.payload)
        self.producer.flush()

        # Mark as published
        self.db.execute(
            "UPDATE outbox SET published_at = NOW() WHERE id = ?",
            event.id
        )
        self.db.commit()
```

**Key details**:

- `FOR UPDATE SKIP LOCKED` prevents two relay instances from processing the same event. If you run multiple relays for availability, this ensures each event is handled by exactly one.

- The relay publishes to Kafka **and then** marks the event as published. If the relay crashes after publishing but before marking, it will re-publish on restart. This means **at-least-once delivery** — consumers must be idempotent (we address this below).

- Ordering is preserved per aggregate: events for the same `aggregate_id` go to the same Kafka partition (keyed by aggregate ID), and the `ORDER BY created_at` ensures they're published in creation order.

**Trade-offs of polling**:

| Advantage | Disadvantage |
|-----------|-------------|
| Simple to implement and reason about | Polling interval adds latency (100ms–1s typical) |
| Works with any database | Puts load on the database (one query per interval) |
| No additional infrastructure | `FOR UPDATE` locks can contend under high throughput |
| Easy to monitor and debug | Must tune interval: too fast = DB load, too slow = latency |

### Option B: Change Data Capture (CDC)

Instead of polling the outbox table, use the database's own replication stream to capture inserts to the outbox table in real time. This is **Change Data Capture** — reading the database's write-ahead log (WAL) to detect changes.

The most widely used CDC tool is **Debezium**, which reads PostgreSQL's logical replication slot (or MySQL's binlog) and streams row-level changes to Kafka.

```
┌────────────┐     WAL / logical     ┌───────────┐     ┌───────────┐
│ PostgreSQL │ ──replication stream──▶│ Debezium  │────▶│   Kafka   │
│            │                       │ Connector │     │           │
│ outbox     │                       └───────────┘     └───────────┘
│ table      │
└────────────┘
```

**How it works**:

1. The application writes to the outbox table (same as before)
2. PostgreSQL writes the INSERT to its WAL
3. Debezium reads the WAL via a logical replication slot
4. Debezium publishes each outbox row as a message to a Kafka topic
5. Debezium tracks its position in the WAL, so it survives restarts

**Debezium configuration** (simplified):

```json
{
  "name": "outbox-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "orders-db",
    "database.port": "5432",
    "database.dbname": "orders",
    "table.include.list": "public.outbox",
    "transforms": "outbox",
    "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
    "transforms.outbox.table.field.event.id": "id",
    "transforms.outbox.table.field.event.key": "aggregate_id",
    "transforms.outbox.table.field.event.type": "type",
    "transforms.outbox.table.field.event.payload": "payload",
    "transforms.outbox.route.topic.replacement": "${routedByValue}-events"
  }
}
```

Debezium's **Outbox Event Router** transform is purpose-built for this pattern. It takes the raw outbox table row and transforms it into a clean event message, routing it to the correct Kafka topic based on the aggregate type.

**Trade-offs of CDC**:

| Advantage | Disadvantage |
|-----------|-------------|
| Near-zero latency (events published within milliseconds of commit) | Requires logical replication support in the database |
| No polling load on the database | Additional infrastructure (Debezium, Kafka Connect) |
| Captures events in WAL order — ordering is guaranteed | WAL-based, so schema changes to the outbox table require care |
| Survives relay crashes (WAL position is checkpointed) | Debugging requires understanding replication internals |

### Which to Choose?

| Criterion | Polling | CDC |
|-----------|---------|-----|
| Latency requirement < 100ms | No | Yes |
| Team has Kafka Connect expertise | Either | Preferred |
| Database doesn't support logical replication | Only option | Not possible |
| Simplicity is top priority | Preferred | No |
| Throughput > 10,000 events/second | Challenging | Handles well |

For most teams starting out, **polling** is the right choice. It's simple, debuggable, and works with any database. Switch to CDC when latency or throughput demands it.

---

## Guaranteeing Exactly-Once Processing: The Inbox Pattern

The Outbox pattern guarantees **at-least-once delivery** to Kafka. If the relay crashes after publishing but before marking the event as published, it re-publishes on restart. This means consumers may see duplicate events.

The **Inbox pattern** makes consumers idempotent by tracking which events have already been processed:

```sql
-- Consumer's database
CREATE TABLE inbox (
    event_id    UUID PRIMARY KEY,
    processed_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

```python
class IdempotentConsumer:
    def handle(self, event):
        with self.db.transaction() as txn:
            # Check if already processed
            existing = txn.query(
                "SELECT 1 FROM inbox WHERE event_id = ?", event.id
            )
            if existing:
                return  # Already processed, skip

            # Process the event (business logic)
            self.process_order(event, txn)

            # Record that we processed it
            txn.execute(
                "INSERT INTO inbox (event_id) VALUES (?)", event.id
            )
        # Both the business effect and the deduplication record
        # are in the same transaction — atomic

    def process_order(self, event, txn):
        txn.execute(
            "INSERT INTO shipments (order_id, status) VALUES (?, ?)",
            event.payload['order_id'], 'PENDING'
        )
```

The inbox check and the business logic are in the **same database transaction**. This means:

- If the consumer crashes after processing but before committing, both the business effect and the inbox record are rolled back. On retry, the event is processed again — correctly.
- If the consumer commits successfully, the inbox record prevents reprocessing on a duplicate delivery.

This gives **effectively exactly-once semantics**: at-least-once delivery (Outbox) + idempotent processing (Inbox) = exactly-once effect.

### Inbox Cleanup

The inbox table grows with every processed event. To prevent it from growing without bound:

```sql
-- Delete inbox entries older than 7 days
-- (the Outbox relay won't re-publish events older than its retention period)
DELETE FROM inbox WHERE processed_at < NOW() - INTERVAL '7 days';
```

The retention period must exceed the maximum time between the original publish and a potential duplicate delivery. In practice, 7 days is conservative — duplicates from relay restarts typically arrive within seconds.

---

## Ordering Guarantees

The Outbox pattern preserves event ordering **per aggregate**, not globally.

### Per-Aggregate Ordering

Events for the same order (same `aggregate_id`) are:
1. Inserted into the outbox table in transaction commit order
2. Read by the relay in `created_at` order
3. Published to the same Kafka partition (keyed by `aggregate_id`)
4. Consumed in offset order within that partition

So if you create an order and then cancel it, the consumer always sees `OrderPlaced` before `OrderCancelled` — for the same order.

### Cross-Aggregate Ordering

Events for **different** orders may arrive out of order. If Order A is placed at T1 and Order B is placed at T2 (T1 < T2), a consumer might see Order B's event before Order A's. This is because:

- The events may go to different Kafka partitions
- Even within the same partition, concurrent relay instances might publish them out of order
- Consumer processing time varies

If you need global ordering, you need a single Kafka partition — which limits throughput to what one partition can handle. In practice, per-aggregate ordering is sufficient for almost all use cases.

---

## Distributed Tracing: Debugging Across Service Boundaries

When an order event flows through five services, debugging a failure requires correlating logs across all of them. The Outbox pattern makes this harder because there's an additional hop (the relay process) between the application and Kafka.

### Correlation IDs

Every event carries a correlation ID that flows through every service:

```python
def place_order(order, correlation_id):
    with db.transaction() as txn:
        txn.execute("INSERT INTO orders ...")
        event = {
            "type": "OrderPlaced",
            "order_id": order.id,
            "correlation_id": correlation_id,  # Flows through every service
            "trace_id": get_current_trace_id(), # OpenTelemetry trace
            "timestamp": datetime.utcnow().isoformat()
        }
        txn.execute("INSERT INTO outbox ... VALUES ...", ..., json.dumps(event))
```

### OpenTelemetry Integration

Modern distributed tracing uses OpenTelemetry to create spans that cross service and transport boundaries:

```
Trace: abc-123
├── Span: API Gateway (POST /orders)
│   ├── Span: Order Service (place_order)
│   │   ├── Span: DB Transaction (INSERT orders + outbox)
│   │   └── [gap: relay latency]
│   │       ├── Span: Outbox Relay (publish to Kafka)
│   │       └── Span: Inventory Consumer (reserve_stock)
│   │           └── Span: DB Transaction (UPDATE inventory)
```

The gap between the DB transaction and the relay publish is a physical delay (polling interval or CDC latency). OpenTelemetry's `SpanLink` API connects the producer span to the consumer span even though they're in different processes:

```python
# In the Outbox relay
with tracer.start_as_current_span(
    "outbox.publish",
    links=[Link(extract_context(event.payload['trace_id']))]
) as span:
    kafka.send(topic, event.payload)
```

### Clock Skew in Traces

When correlating events across services, timestamps come from different machines with different NTP offsets. A span that appears to start before its parent (negative duration) is almost always a clock skew artifact, not a time-travel bug.

Solutions:
- Use **logical ordering** (Kafka offsets, database sequence numbers) as the primary ordering, not wall-clock timestamps
- Deploy a clock sync service (like Amazon Time Sync Service or Chrony with multiple upstream servers) to minimize skew below 1ms
- In trace visualization, use the **happens-before** relation from causal metadata (trace/span IDs) rather than raw timestamps

---

## The Saga Pattern: Multi-Service Transactions

The Outbox pattern solves the problem of keeping one database and one message broker in sync. But what about operations that span multiple services — like "reserve a seat AND charge the payment"?

The **Saga pattern** replaces a single distributed transaction with a sequence of local transactions, each publishing an event that triggers the next step. If any step fails, **compensating transactions** undo the previous steps.

### Choreography-Based Saga

Each service listens for events and acts independently:

```
Order Service          Inventory Service       Payment Service
     │                        │                       │
     │ OrderPlaced            │                       │
     ├───────────────────────▶│                       │
     │                        │ StockReserved         │
     │                        ├──────────────────────▶│
     │                        │                       │ PaymentCharged
     │◀───────────────────────┼───────────────────────┤
     │ OrderConfirmed         │                       │
     │                        │                       │
```

If the payment fails:

```
     │                        │                       │ PaymentFailed
     │                        │◀──────────────────────┤
     │                        │ StockReleased         │
     │◀───────────────────────┤ (compensating txn)    │
     │ OrderCancelled         │                       │
     │ (compensating txn)     │                       │
```

### Orchestration-Based Saga

A central orchestrator coordinates the steps:

```python
class OrderSaga:
    def execute(self, order):
        # Step 1: Reserve inventory
        self.publish("ReserveStock", {"order_id": order.id, "items": order.items})
        # Wait for StockReserved or StockInsufficient event

    def on_stock_reserved(self, event):
        # Step 2: Charge payment
        self.publish("ChargePayment", {"order_id": event.order_id, "amount": event.total})
        # Wait for PaymentCharged or PaymentFailed event

    def on_payment_charged(self, event):
        # Step 3: Confirm order
        self.publish("ConfirmOrder", {"order_id": event.order_id})

    def on_payment_failed(self, event):
        # Compensate: release inventory
        self.publish("ReleaseStock", {"order_id": event.order_id})

    def on_stock_insufficient(self, event):
        # No compensation needed — nothing was done yet
        self.publish("RejectOrder", {"order_id": event.order_id, "reason": "out of stock"})
```

### Saga + Outbox

Each service in the saga uses the Outbox pattern for its local transitions:

```python
# Inside Inventory Service
def handle_reserve_stock(event):
    with db.transaction() as txn:
        # Business logic
        txn.execute("UPDATE inventory SET reserved = reserved + ? WHERE item_id = ?",
                    event.quantity, event.item_id)

        # Outbox event for the next saga step
        txn.execute("INSERT INTO outbox (type, payload) VALUES (?, ?)",
                    'StockReserved', json.dumps({...}))
```

Each step is a local transaction with an outbox event. No distributed transaction is needed. The saga as a whole provides **eventual consistency** — intermediate states are visible (stock is reserved but payment hasn't been charged yet), but the system converges to a consistent final state.

### Designing Compensating Transactions

Compensating transactions are not simple rollbacks. They must be:

1. **Idempotent**: The compensation might be triggered multiple times (duplicate events)
2. **Commutative with concurrent operations**: Other sagas might be modifying the same data
3. **Semantically correct**: "Unreserve stock" is not the same as "the stock was never reserved" — other operations might have seen the reservation

```python
# Bad: this loses concurrent reservations
def compensate_reservation(order_id):
    db.execute("UPDATE inventory SET reserved = 0 WHERE order_id = ?", order_id)

# Good: this only undoes this specific reservation
def compensate_reservation(order_id, quantity, item_id):
    db.execute(
        "UPDATE inventory SET reserved = reserved - ? WHERE item_id = ? AND reserved >= ?",
        quantity, item_id, quantity
    )
```

---

## Production Considerations

### Outbox Table Cleanup

The outbox table is a staging area, not a permanent store. After events are published and confirmed, old rows should be deleted:

```sql
-- Run periodically (every hour, for example)
DELETE FROM outbox
WHERE published_at IS NOT NULL
  AND published_at < NOW() - INTERVAL '24 hours';
```

Keep rows for at least as long as your monitoring window (so you can query "how many events were published in the last hour?") but delete them well before the table becomes a performance problem.

### Monitoring

Critical metrics:

| Metric | What It Tells You | Alert Threshold |
|--------|------------------|----------------|
| Unpublished event count | Relay is falling behind | > 1000 for > 5 minutes |
| Oldest unpublished event age | Latency from write to publish | > 30 seconds |
| Relay publish rate | Throughput | Sudden drop > 50% |
| Consumer lag per partition | Consumers falling behind | > 10,000 offsets |
| Inbox deduplication rate | Frequency of duplicate deliveries | Sudden spike (relay instability) |

### Outbox Per Service, Not Per Database

Each microservice that owns a database should have its own outbox table. Do not share an outbox table across services — that re-introduces the dual-write problem at the database level (two services writing to the same outbox means two services in the same transaction boundary).

---

## Complete Flow: End to End

Let's trace a complete order through the entire pattern:

```
1. Client POST /orders {item: "laptop", qty: 1}
         │
2.  ┌────▼────────────────────────────────┐
    │ Order Service                        │
    │  BEGIN TRANSACTION                   │
    │    INSERT INTO orders (...)          │
    │    INSERT INTO outbox (OrderPlaced)  │
    │  COMMIT                              │
    └────┬────────────────────────────────┘
         │  (outbox table now has one unpublished row)
         │
3.  ┌────▼────────────────────────────────┐
    │ Outbox Relay (polling or CDC)        │
    │  SELECT * FROM outbox               │
    │    WHERE published_at IS NULL        │
    │  kafka.send("order-events", event)   │
    │  UPDATE outbox SET published_at=NOW()│
    └────┬────────────────────────────────┘
         │
4.  ┌────▼────────────────────────────────┐
    │ Kafka: order-events topic            │
    │  Partition 0: [OrderPlaced:laptop]   │
    └────┬────────────┬───────────────────┘
         │            │
5.  ┌────▼──────┐ ┌──▼──────────────────┐
    │ Inventory │ │ Analytics Service    │
    │ Service   │ │  (read-only, no     │
    │  inbox ✓  │ │   dedup needed for  │
    │  reserve  │ │   idempotent        │
    │  stock    │ │   aggregations)     │
    └───────────┘ └─────────────────────┘
```

At every step, exactly one system is the transactional authority:
- Step 2: PostgreSQL's ACID transaction
- Step 3: Kafka's append (at-least-once from relay; idempotent on consumer side)
- Step 5: Each consumer's own database transaction (with inbox deduplication)

No distributed transactions. No 2PC. No XA. Just local transactions chained by events.

---

## Real-World Examples

### Wolt (Food Delivery)

Wolt uses the Outbox pattern for order state transitions. When an order moves from PLACED to ACCEPTED, the state change and the event are written in the same PostgreSQL transaction. A Debezium CDC connector publishes events to Kafka within ~50ms of the commit. Downstream services (restaurant notification, driver dispatch, customer notification) consume from the order-events topic.

### Zalando (E-Commerce)

Zalando's open-source **Nakadi** event bus uses the Outbox pattern internally. Their services write events to a local outbox table, and Nakadi's relay publishes them to Kafka. This powers their entire event-driven architecture across hundreds of microservices.

### Stripe (Payments)

Stripe uses a variant of the Outbox pattern for webhook delivery. When a payment succeeds, the success record and the pending webhook delivery are stored in the same database transaction. A separate delivery service reads pending webhooks and sends them to merchants. Failed deliveries are retried with exponential backoff for up to 72 hours.

---

## Common Mistakes

### Mistake 1: Writing to Kafka from the Outbox Relay Without Idempotency

If the relay doesn't track which events it has published, a restart causes it to re-publish everything in the outbox table. Always mark events as published and have consumers deduplicate.

### Mistake 2: Deleting Outbox Rows Before Confirming Publication

```python
# WRONG — if Kafka publish fails, the event is lost
db.execute("DELETE FROM outbox WHERE id = ?", event.id)
kafka.send(topic, event.payload)
```

Always publish first, then mark as published (or delete). The worst case is a duplicate; the worst case of the reverse is data loss.

### Mistake 3: Using the Outbox for Inter-Service Synchronous Calls

The Outbox pattern is for asynchronous event publication. If Service A needs a synchronous response from Service B, use an RPC call — don't try to route it through the outbox.

### Mistake 4: Putting the Event Schema in the Outbox Payload

If the event schema evolves (Chapter 30), old events in the outbox table may have the old schema. Either:
- Version the schema in the payload: `{"schema_version": 2, ...}`
- Use a schema registry (Confluent Schema Registry) and store the schema ID
- Keep the outbox retention short enough that schema migration is never a problem

### Mistake 5: Not Monitoring Outbox Lag

An unmonitored outbox relay can silently fall behind. If events stop flowing for 30 minutes, downstream services are 30 minutes stale — and nobody knows until a customer complains.

---

## Key Takeaways

1. **Dual writes are a consistency bug.** Any code that writes to two systems without a shared transactional boundary will eventually produce inconsistent state.

2. **The Outbox pattern eliminates dual writes** by writing the event to the database in the same transaction as the business data. A separate relay publishes events to the message broker.

3. **The relay provides at-least-once delivery.** Consumers must be idempotent — the Inbox pattern provides this through deduplication.

4. **Polling is simple; CDC is fast.** Start with polling; switch to Debezium CDC when latency or throughput demands it.

5. **The Saga pattern extends the Outbox pattern** to multi-service transactions by chaining local transactions with compensating actions for rollback.

6. **Distributed tracing is essential** for debugging event flows across service boundaries. Use correlation IDs and OpenTelemetry to connect spans across transports.

---

## References

- Hohpe, G., & Woolf, B. (2003). *Enterprise Integration Patterns*. Addison-Wesley. (The foundational text on messaging patterns.)
- Richardson, C. (2018). *Microservices Patterns*. Manning. (Chapter 4 covers sagas; Chapter 3 covers the Outbox pattern.)
- Debezium documentation: Outbox Event Router. (The production-grade CDC implementation of the Outbox pattern.)
- Kleppmann, M. (2017). *Designing Data-Intensive Applications*. O'Reilly. (Chapters 9 and 11 cover exactly-once semantics and event-driven architectures.)
- Helland, P. (2012). "Idempotence Is Not a Medical Condition." *ACM Queue*. (Why idempotency is the foundation of reliable distributed processing.)
- Garcia-Molina, H., & Salem, K. (1987). "Sagas." *ACM SIGMOD Record*. (The original saga paper, defining compensating transactions for long-lived transactions.)

---

**Next**: [Chapter 32 — Byzantine Fault Tolerance →](ch32-byzantine-fault-tolerance.md)
