# Chapter 30: Stream Processing — Kafka Internals, Exactly-Once, and Schema Evolution

> **Core Question**: How does Kafka guarantee that every event is processed exactly once — and what happens to consumers when an event schema changes?

**Prerequisites**: Chapter 15 (Write-Ahead Logs), Chapter 17 (Primary-Backup Replication), Chapter 22 (Raft), Chapter 26 (Two-Phase Commit)

---

## Why Kafka Exists

Traditional message queues (RabbitMQ, ActiveMQ) route messages and delete them once consumed. This works for task distribution, but it fails for event-driven architectures where:

- Multiple consumers need the same event (fan-out)
- A new consumer needs to replay the entire event history (rebuilding a read model, analytics backfill)
- You need to audit exactly what happened and when
- You need delivery guarantees stronger than "at-least-once"

LinkedIn built Kafka (Kreps, Narkhede & Rao, 2011) to solve these problems. The key insight: **a message queue is a distributed commit log**.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│                        Kafka Cluster                           │
│                                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ Broker 0  │  │ Broker 1  │  │ Broker 2  │  │ Broker 3  │   │
│  │           │  │           │  │           │  │           │    │
│  │ T1-P0 (L) │  │ T1-P0 (F) │  │ T1-P1 (L) │  │ T1-P1 (F) │  │
│  │ T1-P2 (F) │  │ T1-P2 (L) │  │ T2-P0 (F) │  │ T2-P0 (L) │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
│                                                                │
│  L = Leader replica    F = Follower replica                    │
│  T1 = Topic "orders"   T2 = Topic "payments"                  │
│  P0, P1, P2 = Partitions                                      │
└────────────────────────────────────────────────────────────────┘
         ▲ ▲ ▲                              │ │ │
         │ │ │  Produce                     │ │ │  Consume
    ┌────┘ │ └────┐                    ┌────┘ │ └────┐
    │      │      │                    │      │      │
┌──────┐┌──────┐┌──────┐        ┌──────┐┌──────┐┌──────┐
│Prod 1││Prod 2││Prod 3│        │Cons 1││Cons 2││Cons 3│
└──────┘└──────┘└──────┘        └──────┘└──────┘└──────┘
                                 └─── Consumer Group ──┘
```

### Core Concepts

**Topic**: A named stream of events (e.g., "orders", "page-views"). Analogous to a database table, but append-only.

**Partition**: A topic is split into partitions, each of which is an ordered, immutable sequence of records. Partitions are the unit of parallelism — a topic with 12 partitions can be consumed by up to 12 consumers in parallel.

**Broker**: A Kafka server that stores partitions. Each broker holds a subset of partitions for each topic.

**Producer**: A client that publishes records to topics.

**Consumer**: A client that reads records from topics.

**Consumer Group**: A set of consumers that cooperatively consume a topic. Each partition is assigned to exactly one consumer in the group.

---

## The Commit Log Abstraction

Each partition is a **commit log** — an append-only, totally ordered sequence of records:

```
Partition 0 of topic "orders":

Offset:  0     1     2     3     4     5     6     7     8
       ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┐
       │ Rec │ Rec │ Rec │ Rec │ Rec │ Rec │ Rec │ Rec │ Rec │
       │  0  │  1  │  2  │  3  │  4  │  5  │  6  │  7  │  8  │
       └─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┘
                                             ▲              ▲
                                             │              │
                                      Consumer's         Log end
                                      current offset    (high watermark)
```

Each record has:
- **Offset**: A monotonically increasing 64-bit integer (per partition). Offsets are never reused.
- **Key** (optional): Used for partitioning. All records with the same key go to the same partition.
- **Value**: The actual event data (bytes).
- **Timestamp**: Set by the producer or broker.
- **Headers** (optional): Key-value metadata pairs.

The log is append-only. Records are never modified or deleted in place (they're eventually removed by retention policy — time-based or size-based — but this is a background process, not a mutation).

### Why a Log?

The commit log structure gives Kafka several properties that traditional message queues lack:

1. **Ordering**: Records within a partition are totally ordered by offset. This is stronger than most message queues, which guarantee order only within a single producer's messages (if at all).

2. **Replayability**: Any consumer can seek to any offset and re-read from there. Adding a new consumer group doesn't affect existing consumers — it just starts reading from the beginning (or any chosen offset).

3. **Durability**: Records persist on disk until the retention policy removes them, regardless of whether any consumer has read them. This decouples producers from consumers in time.

4. **Performance**: Sequential disk I/O is fast. Kafka leverages the OS page cache and the `sendfile` system call (zero-copy transfer from disk to network socket) to achieve throughput measured in gigabytes per second per broker.

---

## Partition Leadership and ISR

Each partition is replicated across multiple brokers for fault tolerance. One replica is the **leader**; the rest are **followers**.

### The Replication Protocol

```
Producer                    Broker 0 (Leader)        Broker 1 (Follower)    Broker 2 (Follower)
   │                              │                         │                       │
   │  Produce(record)             │                         │                       │
   ├─────────────────────────────▶│                         │                       │
   │                              │  Append to local log    │                       │
   │                              ├────────────┐            │                       │
   │                              │            │            │                       │
   │                              │◀───────────┘            │                       │
   │                              │                         │                       │
   │                              │  Fetch request          │                       │
   │                              │◀────────────────────────┤                       │
   │                              │  Return new records     │                       │
   │                              ├────────────────────────▶│                       │
   │                              │                         │  Append to local log  │
   │                              │                         │                       │
   │                              │  Fetch request                                  │
   │                              │◀────────────────────────────────────────────────┤
   │                              │  Return new records                             │
   │                              ├────────────────────────────────────────────────▶│
   │                              │                                    Append       │
   │                              │                                                 │
   │                              │  Both followers caught up                       │
   │                              │  Advance high watermark                         │
   │  Ack (if acks=all)           │                                                 │
   │◀─────────────────────────────┤                                                 │
```

Followers replicate by **pulling** from the leader (not push). Each follower issues fetch requests to the leader, similar to how a consumer reads — the follower is essentially a consumer of the leader's log.

### In-Sync Replicas (ISR)

The ISR is the set of replicas that are "caught up" with the leader. A replica is in the ISR if:

1. It has fetched all records up to the leader's log end offset within a configurable time window (`replica.lag.time.max.ms`, default 30 seconds)
2. It has an active session with the controller (ZooKeeper heartbeat or KRaft heartbeat)

The ISR is dynamic — replicas fall out when they lag and rejoin when they catch up.

```
Leader log:     [0] [1] [2] [3] [4] [5] [6] [7]
                                                 ▲ Log End Offset (LEO)

Follower 1 log: [0] [1] [2] [3] [4] [5] [6] [7]  ← In sync (ISR member)
Follower 2 log: [0] [1] [2] [3] [4] [5]            ← Lagging but within threshold
Follower 3 log: [0] [1] [2]                         ← Fell behind, removed from ISR
```

### The High Watermark

The **high watermark** is the offset of the last record that has been replicated to **all ISR members**. Only records at or below the high watermark are visible to consumers.

```
Leader log:     [0] [1] [2] [3] [4] [5] [6] [7]
                                     ▲           ▲
                                     │           │
                              High Watermark   Log End Offset
                              (committed)      (not yet committed)

Consumer can read: [0] through [5]
Records [6] and [7] exist on the leader but are NOT yet committed
```

Why? If the leader crashes before [6] and [7] are replicated, a new leader won't have them. Exposing uncommitted records would violate Kafka's durability guarantee.

### Leader Election

When a partition leader fails, the controller (a broker elected via ZooKeeper or KRaft) selects a new leader from the ISR:

```
Before failure:
  Partition 0:  Leader = Broker 0,  ISR = {Broker 0, Broker 1, Broker 2}
  
Broker 0 crashes.

After election:
  Partition 0:  Leader = Broker 1,  ISR = {Broker 1, Broker 2}
```

By default, the new leader must come from the ISR (`unclean.leader.election.enable = false`). This guarantees no committed data is lost — every ISR member has all committed records.

If `unclean.leader.election.enable = true`, a non-ISR replica can become leader. This prioritizes **availability** over **consistency** — the partition becomes available sooner, but committed records that only existed on the old leader are lost. This is Kafka's CAP trade-off knob.

---

## Producer Acknowledgment Levels

The producer's `acks` setting controls the durability guarantee:

### acks=0 (Fire and Forget)

```
Producer ──── Produce ────▶ Broker
         (no ack waited)
```

The producer doesn't wait for any acknowledgment. If the broker is down, the record is silently lost. Maximum throughput, no durability guarantee.

### acks=1 (Leader Acknowledgment)

```
Producer ──── Produce ────▶ Leader ──── Ack ────▶ Producer
                             │
                             │ (replication happens asynchronously)
                             ▼
                          Followers
```

The leader acknowledges after writing to its local log, before followers replicate. If the leader crashes after acknowledging but before replication, the record is lost.

### acks=all (Full ISR Acknowledgment)

```
Producer ──── Produce ────▶ Leader
                             │
                             ├──── Replicate ────▶ Follower 1
                             ├──── Replicate ────▶ Follower 2
                             │
                             │ (wait for all ISR members)
                             │
                       Advance high watermark
                             │
              Ack ◀──────────┘
              ▼
           Producer
```

The leader acknowledges only after all ISR members have replicated the record. Combined with `min.insync.replicas=2` (minimum ISR size for writes to succeed), this guarantees that committed records survive the loss of any single broker.

This is the setting required for **exactly-once semantics** (discussed below).

---

## Consumer Offset Management

A consumer's **offset** is its position in a partition's log — the next record it will read. Kafka stores consumer offsets in a special internal topic: `__consumer_offsets`.

### The Commit Protocol

```
Consumer                                  Kafka Broker
   │                                           │
   │  Fetch(topic=orders, partition=0,         │
   │        offset=42, max_bytes=1MB)          │
   ├──────────────────────────────────────────▶│
   │                                           │
   │  Records [42, 43, 44, 45, 46]             │
   │◀──────────────────────────────────────────┤
   │                                           │
   │  (process records 42-46)                  │
   │                                           │
   │  CommitOffset(group=mygroup,              │
   │               topic=orders,               │
   │               partition=0,                │
   │               offset=47)                  │
   ├──────────────────────────────────────────▶│
   │                                           │  Write to __consumer_offsets
   │  Ack                                      │
   │◀──────────────────────────────────────────┤
```

The consumer commits offsets **after** processing records. If the consumer crashes between fetching and committing, it will re-read and re-process those records on restart. This gives **at-least-once delivery** by default.

### Auto-Commit vs Manual Commit

**Auto-commit** (`enable.auto.commit=true`): The consumer automatically commits offsets at a fixed interval (default 5 seconds). Simple, but can cause:
- **Data loss**: If the consumer processes and crashes before the next auto-commit, offsets weren't committed, but neither was processing — actually this causes re-processing, not loss
- **Duplicate processing**: The consumer processes records, then crashes before auto-commit fires. On restart, it re-processes from the last committed offset.

**Manual commit**: The application explicitly calls `commitSync()` or `commitAsync()` after processing each batch. This gives precise control over the at-least-once guarantee.

```python
while True:
    records = consumer.poll(timeout_ms=1000)
    for record in records:
        process(record)  # Application logic
    consumer.commit_sync()  # Commit only after successful processing
```

---

## Idempotent Producers

At-least-once delivery means duplicates can occur when a producer retries after a timeout:

```
Without idempotent producer:

Producer ── Produce(msg A) ──▶ Leader
                                │ Append msg A (offset 5)
                                │ Ack
                                ✗ Network drops the ack
                                
Producer: "Timeout — did the write succeed?"
Producer ── Produce(msg A) ──▶ Leader
                                │ Append msg A AGAIN (offset 6)  ← DUPLICATE!
                                │ Ack ──▶ Producer
```

Kafka's **idempotent producer** (introduced in 0.11.0) eliminates this by assigning each producer a **Producer ID (PID)** and each record a **sequence number**:

```
With idempotent producer:

Producer (PID=7) ── Produce(msg A, seq=0) ──▶ Leader
                                               │ Append msg A (offset 5)
                                               │ Record: PID=7, seq=0 → offset 5
                                               │ Ack
                                               ✗ Network drops the ack

Producer: "Timeout — retry"
Producer (PID=7) ── Produce(msg A, seq=0) ──▶ Leader
                                               │ Check: PID=7, seq=0 already seen
                                               │ Return existing offset 5
                                               │ Ack ──▶ Producer (no duplicate!)
```

The broker maintains a mapping of `(PID, partition) → last sequence number` for each active producer. If a produce request arrives with a sequence number that has already been recorded, the broker returns success without appending a duplicate.

### Sequence Number Mechanics

Sequence numbers are **per-partition, per-producer**:

```
Producer PID=7:
  Partition 0: seq 0, 1, 2, 3, 4, ...
  Partition 1: seq 0, 1, 2, 3, ...
  Partition 2: seq 0, 1, 2, ...
```

The broker enforces that sequence numbers arrive in order. If seq=5 arrives but the broker last saw seq=3, it rejects the request with an `OutOfOrderSequenceException` — this indicates a bug or a producer restart.

If the producer restarts, it gets a new PID and new sequence numbers. Idempotency doesn't survive producer restarts by itself — that's what the transactional API is for.

---

## The Transactional API

Idempotent producers prevent duplicates within a single producer session and a single partition. The **transactional API** extends this to:

1. Atomic writes across multiple partitions
2. Exactly-once semantics that survive producer restarts
3. Atomic read-process-write cycles (consume from one topic, produce to another)

### Transactional ID

Instead of a server-assigned PID, the producer registers a **transactional.id** — a stable, user-chosen identifier. Across restarts, a producer with the same transactional ID receives a new PID but the broker associates it with the previous PID's transactions, allowing it to **fence** (abort) any incomplete transactions from the previous incarnation.

```python
producer = KafkaProducer(
    transactional_id="order-processor-1",
    acks="all",
    enable_idempotence=True
)

producer.init_transactions()

try:
    producer.begin_transaction()
    
    # Consume from input topic
    records = consumer.poll(timeout_ms=1000)
    
    for record in records:
        result = process(record)
        # Produce to output topic within the same transaction
        producer.produce("output-topic", key=result.key, value=result.value)
    
    # Commit consumer offsets within the same transaction
    producer.send_offsets_to_transaction(
        consumer.position(),   # Current consumer offsets
        consumer.group_id()
    )
    
    producer.commit_transaction()
    
except Exception:
    producer.abort_transaction()
```

### How Transactions Work Internally

Kafka transactions use a variant of **two-phase commit** (Chapter 26), coordinated by a **Transaction Coordinator** (a broker assigned to manage a given transactional ID).

```
Phase 1: Prepare
─────────────────

Producer                    Transaction Coordinator        Partition Leaders
   │                                  │                          │
   │  InitPID(txn.id="order-proc-1") │                          │
   ├─────────────────────────────────▶│                          │
   │  PID=42, epoch=1                │                          │
   │◀─────────────────────────────────┤                          │
   │                                  │                          │
   │  BeginTransaction                │                          │
   ├─────────────────────────────────▶│                          │
   │                                  │  Log: txn started        │
   │                                  │                          │
   │  AddPartitionsToTxn(P0, P1)     │                          │
   ├─────────────────────────────────▶│                          │
   │                                  │  Log: partitions added   │
   │                                  │                          │
   │  Produce(P0, data, PID=42)      │                          │
   ├─────────────────────────────────────────────────────────────▶│
   │                                  │                    Append with│
   │                                  │                    txn marker │
   │  Produce(P1, data, PID=42)      │                          │
   ├─────────────────────────────────────────────────────────────▶│
   │                                  │                          │

Phase 2: Commit
────────────────

   │  CommitTransaction               │                          │
   ├─────────────────────────────────▶│                          │
   │                                  │  Log: prepare-commit     │
   │                                  │                          │
   │                                  │  WriteTxnMarker(COMMIT)  │
   │                                  ├─────────────────────────▶│
   │                                  │                   Write COMMIT │
   │                                  │                   marker to log│
   │                                  │  Ack                     │
   │                                  │◀─────────────────────────┤
   │                                  │                          │
   │                                  │  Log: committed          │
   │  Ack                             │                          │
   │◀─────────────────────────────────┤                          │
```

The **transaction log** (`__transaction_state` internal topic) is the coordinator's durable state. It survives coordinator failures — if the coordinator crashes, a new coordinator reads the transaction log and completes (or aborts) any in-progress transactions.

### Consumer Isolation Levels

For transactions to provide exactly-once semantics end-to-end, consumers must also participate:

**`isolation.level=read_uncommitted`** (default): The consumer sees all records, including those in uncommitted transactions. This is the traditional at-least-once behavior.

**`isolation.level=read_committed`**: The consumer sees only records that are either:
- Not part of any transaction, or
- Part of a **committed** transaction

Records from aborted transactions are filtered out. Records from in-progress transactions are held back until the transaction commits or aborts.

```
Partition log:
  [0: normal] [1: txn-A] [2: txn-A] [3: normal] [4: txn-B] [5: normal] [6: txn-A commit]

Consumer with read_committed sees (in order):
  [0: normal] → [3: normal] → [5: normal]
  
  (waits for txn-A to commit/abort)
  
  After txn-A commits:
  [0: normal] [1: txn-A] [2: txn-A] [3: normal] [5: normal]
  
  If txn-B aborts:
  Record 4 is never delivered
```

### The Exactly-Once Recipe

To achieve exactly-once semantics for a consume-process-produce pipeline:

1. **Producer**: `enable.idempotence=true`, `transactional.id=<unique-id>`, `acks=all`
2. **Consumer**: `isolation.level=read_committed`, `enable.auto.commit=false`
3. **Application**: Wrap consume + produce + offset commit in a single transaction

```
Within one transaction:
  1. Consume records from input topic
  2. Process records (application logic)
  3. Produce output records to output topic
  4. Commit consumer offsets to __consumer_offsets
  5. Commit transaction (atomic: either all of 3+4 happen, or none)
```

If the application crashes after consuming but before committing the transaction, the transaction is aborted. Consumer offsets are not committed, so on restart the application re-reads and re-processes the same records. The idempotent producer ensures no duplicates from retries. The transaction ensures atomic all-or-nothing semantics.

---

## Consumer Group Rebalancing

When consumers join or leave a group, partitions must be **rebalanced** — redistributed among the remaining consumers.

### The Rebalancing Protocol

Kafka uses a **coordinator-based** protocol. One broker is the **group coordinator** for each consumer group (determined by hashing the group ID).

```
Phase 1: JoinGroup
───────────────────

Consumer 1 ── JoinGroup(group="mygroup") ──▶ Coordinator
Consumer 2 ── JoinGroup(group="mygroup") ──▶ Coordinator
Consumer 3 ── JoinGroup(group="mygroup") ──▶ Coordinator

Coordinator selects Consumer 1 as the "group leader"
Coordinator ── JoinGroup response (you are leader, members=[C1,C2,C3]) ──▶ C1
Coordinator ── JoinGroup response (you are follower) ──▶ C2
Coordinator ── JoinGroup response (you are follower) ──▶ C3

Phase 2: SyncGroup
───────────────────

C1 (leader): Computes partition assignment:
  C1 → {P0, P1}
  C2 → {P2, P3}
  C3 → {P4, P5}

C1 ── SyncGroup(assignments={C1:[P0,P1], C2:[P2,P3], C3:[P4,P5]}) ──▶ Coordinator
C2 ── SyncGroup() ──▶ Coordinator
C3 ── SyncGroup() ──▶ Coordinator

Coordinator distributes assignments:
Coordinator ── SyncGroup response (your partitions: [P0,P1]) ──▶ C1
Coordinator ── SyncGroup response (your partitions: [P2,P3]) ──▶ C2
Coordinator ── SyncGroup response (your partitions: [P4,P5]) ──▶ C3
```

### Assignment Strategies

The group leader decides how to assign partitions:

**Range**: Assign partitions sequentially to consumers. Simple but can create imbalance.
```
6 partitions, 3 consumers:
  C1 → [P0, P1]
  C2 → [P2, P3]
  C3 → [P4, P5]
```

**RoundRobin**: Distribute partitions in a round-robin fashion across consumers. Better balance.
```
6 partitions, 3 consumers:
  C1 → [P0, P3]
  C2 → [P1, P4]
  C3 → [P2, P5]
```

**Sticky**: Like RoundRobin, but tries to minimize partition movement during rebalancing. If C2 leaves:
```
Before:  C1=[P0,P3], C2=[P1,P4], C3=[P2,P5]
After:   C1=[P0,P3,P1], C3=[P2,P5,P4]    (C2's partitions redistributed, others unchanged)
```

**Cooperative Sticky** (incremental rebalancing): Instead of revoking all partitions and reassigning from scratch, only the partitions that need to move are revoked. This avoids the "stop-the-world" pause during rebalancing.

### The Rebalancing Problem

During a rebalance (the "eager" protocol), **all consumers stop processing**. In a consumer group handling high-throughput streams, this pause can last seconds to minutes, causing:

- Message processing lag spikes
- Timeout cascades if downstream services expect timely responses
- Duplicate processing of records that were fetched but not committed before the rebalance

Cooperative rebalancing (KIP-429, Kafka 2.4+) mitigates this by allowing consumers to keep processing their existing partitions while only the migrating partitions are paused.

---

## Schema Evolution

In an event-driven architecture, producers and consumers evolve independently. When a producer changes the schema of events (adds a field, removes a field, changes a type), existing consumers must not break. This is the **schema evolution** problem.

### The Problem

```
Version 1 of "OrderCreated" event:
{
  "order_id": "ord_123",
  "amount": 99.50,
  "currency": "USD"
}

Version 2 adds a new field:
{
  "order_id": "ord_456",
  "amount": 150.00,
  "currency": "EUR",
  "customer_tier": "gold"     ← new field
}
```

If Consumer A was written for V1 and doesn't know about `customer_tier`, what happens? It depends entirely on the serialization format.

### JSON: No Schema Enforcement

With JSON, there's no enforcement at all. Consumers silently ignore unknown fields (in most libraries). Missing fields cause `NullPointerException` or equivalent. Schema evolution is implicit and error-prone.

### Avro: Schema-Based Evolution

Apache Avro is the standard serialization format for Kafka in production. It provides:

1. **Compact binary encoding** (field names are not repeated in each record)
2. **Schema-based deserialization** (reader and writer schemas can differ)
3. **Formal compatibility rules** checked at registration time

#### How Avro Deserialization Works

```
Writer schema (what the producer used):         Reader schema (what the consumer expects):
{                                                {
  "type": "record",                               "type": "record",
  "name": "OrderCreated",                         "name": "OrderCreated",
  "fields": [                                     "fields": [
    {"name": "order_id", "type": "string"},          {"name": "order_id", "type": "string"},
    {"name": "amount", "type": "double"},             {"name": "amount", "type": "double"},
    {"name": "currency", "type": "string"},           {"name": "currency", "type": "string"}
    {"name": "customer_tier", "type": "string",     ]
     "default": "standard"}                       }
  ]
}
```

Avro resolves the difference:
- `customer_tier` is in the writer schema but not the reader schema → **ignored** (the reader doesn't need it)
- If a field were in the reader schema but not the writer schema → **use the default value**

This resolution happens automatically at deserialization time, with zero application code.

### Confluent Schema Registry

The Schema Registry is a centralized service that stores Avro (or Protobuf or JSON Schema) schemas and enforces compatibility rules:

```
┌──────────┐     Register schema v2     ┌─────────────────┐
│ Producer  │──────────────────────────▶│ Schema Registry  │
│           │     Schema ID = 7         │                  │
│           │◀──────────────────────────│  Checks:         │
│           │                           │  v2 compatible   │
│           │                           │  with v1?        │
└─────┬────┘                           └────────┬─────────┘
      │                                         │
      │  Produce: [schema_id=7][avro_bytes]     │
      ▼                                         │
┌──────────┐                                    │
│  Kafka   │                                    │
│  Broker  │                                    │
└─────┬────┘                                    │
      │                                         │
      │  Consume: [schema_id=7][avro_bytes]     │
      ▼                                         │
┌──────────┐     Fetch schema for ID=7  ┌───────┘
│ Consumer  │──────────────────────────▶│
│           │     Returns Avro schema   │
│           │◀──────────────────────────│
│           │                           │
│  Deserialize using writer schema (ID=7) + reader schema (local)
└──────────┘
```

The registry caches schemas by ID, so the overhead per record is just a 4-byte schema ID prefix (after the first lookup).

### Compatibility Modes

The registry enforces one of these compatibility rules per subject (typically per topic):

**BACKWARD** (default): New schema can read data written with the previous schema.
- **Allowed**: Add a field with a default value. Remove a field.
- **Forbidden**: Add a field without a default (old data won't have it). Change a field type.

```
Backward compatible change:
  v1: {order_id, amount, currency}
  v2: {order_id, amount, currency, customer_tier(default="standard")}
  
  ✓ Consumer with v2 schema can read v1 data (customer_tier gets default)
```

**FORWARD**: Old schema can read data written with the new schema.
- **Allowed**: Remove a field. Add a field with a default.
- **Forbidden**: Add a required field (old consumers can't handle it).

```
Forward compatible change:
  v1: {order_id, amount, currency}
  v2: {order_id, amount}   (removed currency)
  
  ✓ Consumer with v1 schema can read v2 data (currency gets default)
     (only if currency had a default value in v1)
```

**FULL**: Both backward AND forward compatible. The strictest useful mode.
- **Allowed**: Add a field with a default. Remove a field that has a default.
- **Forbidden**: Add or remove fields without defaults. Change types.

**NONE**: No compatibility checking. Danger zone — producers can break consumers at will.

### Compatibility Decision Matrix

| Change | BACKWARD | FORWARD | FULL |
|--------|----------|---------|------|
| Add field with default | ✅ | ✅ | ✅ |
| Add field without default | ❌ | ✅ | ❌ |
| Remove field with default | ✅ | ✅ | ✅ |
| Remove field without default | ✅ | ❌ | ❌ |
| Rename field | ❌ | ❌ | ❌ |
| Change field type | ❌* | ❌* | ❌ |

*Type promotions (int→long, float→double) are allowed in Avro.

### Protobuf Schema Evolution

Protocol Buffers use field numbers instead of names, which changes the evolution rules:

```protobuf
// Version 1
message OrderCreated {
  string order_id = 1;
  double amount = 2;
  string currency = 3;
}

// Version 2
message OrderCreated {
  string order_id = 1;
  double amount = 2;
  string currency = 3;
  string customer_tier = 4;  // New field, new field number
}
```

Protobuf evolution rules:
- **Safe**: Add new fields (with new field numbers). Remove fields (but never reuse the field number).
- **Unsafe**: Change a field's type. Change a field's number. Reuse a deleted field's number.
- **Required fields** (proto2): Cannot be safely added or removed. This is why proto3 removed the `required` keyword.

The "never reuse field numbers" rule is critical. Protobuf identifies fields by number, not name. If you delete field 3 and later add a new field 3 with a different type, old data with the original field 3 will be misinterpreted.

```protobuf
// DANGEROUS: reusing field number 3
message OrderCreated {
  string order_id = 1;
  double amount = 2;
  // string currency = 3;        ← deleted
  string region = 3;             ← WRONG! Old data has currency bytes at field 3
  string customer_tier = 4;
}

// SAFE: reserve deleted field numbers
message OrderCreated {
  string order_id = 1;
  double amount = 2;
  reserved 3;                    ← prevents accidental reuse
  string customer_tier = 4;
  string region = 5;             ← new field number
}
```

### Breaking vs Non-Breaking Changes: A Summary

| Change | JSON | Avro | Protobuf |
|--------|------|------|----------|
| Add optional field | Non-breaking (consumers ignore) | Non-breaking (with default) | Non-breaking |
| Remove field | Non-breaking (consumers handle null) | Depends on compatibility mode | Non-breaking (don't reuse number) |
| Rename field | Breaking | Breaking (matched by name) | Non-breaking (matched by number) |
| Change type | Breaking | Usually breaking | Breaking |
| Reorder fields | Non-breaking | Non-breaking | Non-breaking |

---

## Kafka Without ZooKeeper: KRaft

Historically, Kafka depended on ZooKeeper for:
- Broker registration and failure detection
- Partition leader election
- Controller election
- Topic configuration storage
- Consumer group offset storage (moved to Kafka in 0.9)

KRaft (Kafka Raft, KIP-500, production-ready in Kafka 3.3) replaces ZooKeeper with a built-in Raft-based consensus layer:

```
Before (with ZooKeeper):                After (KRaft mode):

┌──────────────┐                        ┌──────────────┐
│  ZooKeeper   │                        │ Controller   │
│  Ensemble    │                        │ Quorum       │
│  (3-5 nodes) │                        │ (3-5 brokers)│
└──────┬───────┘                        │ using Raft   │
       │                                └──────┬───────┘
  ┌────┼────┐                             ┌────┼────┐
  ▼    ▼    ▼                             ▼    ▼    ▼
┌────┐┌────┐┌────┐                    ┌────┐┌────┐┌────┐
│ B0 ││ B1 ││ B2 │                    │ B0 ││ B1 ││ B2 │
└────┘└────┘└────┘                    └────┘└────┘└────┘
```

Benefits:
- Simpler deployment (no separate ZooKeeper cluster)
- Faster controller failover (Raft leader election is fast)
- Better scalability (metadata stored in a replicated log, not a hierarchical key-value store)
- Broker metadata is eventually consistent via a Raft log, reducing the "metadata out of sync" bugs that plagued the ZooKeeper-based architecture

---

## Performance Characteristics

### Why Kafka Is Fast

1. **Sequential I/O**: Appending to the end of a log file is the fastest disk operation. Kafka's write path is a sequential append.

2. **OS page cache**: Kafka relies on the OS page cache rather than managing its own heap-based cache. This means:
   - No GC pauses from caching data on the JVM heap
   - Reads of recent data hit the page cache (memory speed)
   - The OS handles cache eviction efficiently

3. **Zero-copy transfer**: When a consumer fetches data, Kafka uses the `sendfile()` system call to transfer data directly from the page cache to the network socket, bypassing the JVM entirely:

```
Traditional path:
  Disk → OS buffer → Application buffer → Socket buffer → NIC

Zero-copy path:
  Disk → OS buffer → NIC
  (sendfile syscall, data never enters JVM)
```

4. **Batching**: Producers batch multiple records into a single produce request. Consumers fetch batches of records. The broker compresses batches on disk. This amortizes network and I/O overhead.

5. **Partitioning**: Parallelism scales linearly with partitions. A topic with 100 partitions spread across 10 brokers can serve 100 consumers in parallel.

### Typical Numbers

| Metric | Typical Value |
|--------|--------------|
| Single broker write throughput | 100-200 MB/s |
| Single partition latency (acks=1) | 2-5 ms |
| Single partition latency (acks=all, 3 replicas) | 5-15 ms |
| End-to-end latency (produce → consume) | 5-30 ms |
| Records per second (single broker) | 500K-2M (depending on record size) |

---

## Summary

Kafka is a distributed commit log that provides:

1. **Durable, ordered storage**: Each partition is a totally ordered, append-only log replicated across multiple brokers
2. **Configurable durability**: `acks=0` (none), `acks=1` (leader), `acks=all` (full ISR) — the trade-off between latency and data safety
3. **Exactly-once semantics**: Idempotent producers (per-partition deduplication) + transactional API (cross-partition atomicity) + consumer `read_committed` isolation
4. **Elastic consumption**: Consumer groups distribute partitions among consumers; rebalancing handles joins and leaves
5. **Schema evolution**: Avro + Schema Registry enforce compatibility rules, preventing producers from breaking consumers

The key distributed systems concepts at work:
- **Primary-backup replication** (Chapter 17): Leaders and followers, with ISR tracking
- **Failure detection** (Chapter 7): Heartbeat-based broker and consumer health checks
- **Two-phase commit** (Chapter 26): The transactional API uses a coordinator and prepare/commit markers
- **Write-ahead logs** (Chapter 15): The partition log IS a WAL; the transaction log is a WAL for transaction state

---

## Key Takeaways

- Kafka models each partition as an append-only commit log where records are immutable and identified by offset, enabling replay, fan-out, and decoupled consumption
- The ISR (In-Sync Replica) set tracks which followers are caught up; the high watermark ensures consumers only see records replicated to all ISR members
- Idempotent producers use (PID, sequence number) pairs to deduplicate retries within a producer session, eliminating the most common source of duplicates
- The transactional API extends exactly-once guarantees across partitions and producer restarts using a two-phase commit protocol coordinated through the `__transaction_state` internal topic
- Consumer group rebalancing redistributes partitions when consumers join or leave; cooperative rebalancing minimizes processing pauses
- Schema evolution with Avro and the Schema Registry enforces backward/forward/full compatibility at registration time, preventing producers from deploying breaking changes
- Protobuf evolution relies on field numbers (not names), making field renames safe but field number reuse dangerous

## References

- Kreps, J., Narkhede, N., & Rao, J. (2011). "Kafka: a Distributed Messaging System for Log Processing." NetDB Workshop.
- Wang, G. et al. (2015). "Building a Replicated Logging System with Apache Kafka." VLDB.
- Narkhede, N., Shapira, G., & Palino, T. (2017). *Kafka: The Definitive Guide*. O'Reilly.
- KIP-98: Exactly Once Delivery and Transactional Messaging. Apache Kafka.
- KIP-500: Replace ZooKeeper with a Self-Managed Metadata Quorum. Apache Kafka.

---

**Next**: [Chapter 31 — The Dual-Write Problem and the Outbox Pattern →](ch31-dual-write-outbox.md)
