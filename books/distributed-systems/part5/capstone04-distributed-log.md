# Capstone 4: Distributed Log Service (Kafka-like)

> **Design Goal**: Build a distributed, partitioned, replicated commit log that guarantees exactly-once delivery semantics, tolerates broker failures without data loss, and scales horizontally by adding partitions and brokers.

**Key Concepts Practiced**: Append-only replication, consumer group coordination, exactly-once delivery, ISR (in-sync replica) management, leader election, failure detection.

**Prerequisites**: Chapters 7–8 (failure detection), 15 (WAL), 17 (primary-backup replication), 22 (Raft), 24 (ZooKeeper), 30 (Kafka internals).

---

## 1. Problem Statement

You need a system where:

1. **Producers** append records to named **topics**.
2. Each topic is split into **partitions** for parallelism.
3. Each partition is **replicated** across multiple brokers for durability.
4. **Consumers** read records in order, tracking their position.
5. A consumer crash must not lose or double-process records.
6. A broker crash must not lose acknowledged records.

The core invariant: **a record acknowledged to a producer is never lost, and every acknowledged record is delivered to every consumer in partition order exactly once.**

---

## 2. Architecture Overview

```
                        ┌──────────────────────────────────┐
                        │         Controller Quorum         │
                        │  (Raft-based metadata consensus)  │
                        └──────┬──────────┬──────────┬──────┘
                               │          │          │
                ┌──────────────┼──────────┼──────────┼──────────────┐
                │              │          │          │              │
           ┌────▼────┐   ┌────▼────┐   ┌─▼──────┐  │   ┌─────────┐
           │Broker 0 │   │Broker 1 │   │Broker 2│  │   │Broker 3 │
           │         │   │         │   │        │  │   │         │
           │ P0-lead │   │ P0-foll │   │P0-foll │  │   │ P1-lead │
           │ P1-foll │   │ P1-foll │   │P2-lead │  │   │ P2-foll │
           └─────────┘   └─────────┘   └────────┘  │   └─────────┘
                                                    │
                                               ┌────▼────┐
                                               │Broker 4 │
                                               │ P1-foll │
                                               │ P2-foll │
                                               └─────────┘

           Topic "orders" has 3 partitions (P0, P1, P2)
           Replication factor = 3
```

### Components

| Component | Role |
|-----------|------|
| **Broker** | Stores partition log segments on disk, serves produce and fetch requests |
| **Controller Quorum** | Manages metadata: partition assignments, leader elections, ISR lists. Runs a Raft group for fault tolerance (replaces ZooKeeper in modern Kafka) |
| **Producer** | Appends records to a partition's leader broker |
| **Consumer** | Reads records sequentially from a partition's leader broker |
| **Consumer Group** | A set of consumers that collectively consume a topic, each assigned a subset of partitions |

---

## 3. The Partition Log

Each partition is an ordered, immutable, append-only sequence of records. Every record gets a monotonically increasing **offset** — its position in the log.

```
Partition P0:

Offset:  0    1    2    3    4    5    6    7    8
       ┌────┬────┬────┬────┬────┬────┬────┬────┬────┐
       │ r0 │ r1 │ r2 │ r3 │ r4 │ r5 │ r6 │ r7 │ r8 │
       └────┴────┴────┴────┴────┴────┴────┴────┴────┘
                              ▲              ▲
                              │              │
                         High Watermark   Log End Offset
                         (committed)      (latest appended)
```

### Key Offsets

- **Log End Offset (LEO)**: The offset of the next record to be written. Only the leader appends here.
- **High Watermark (HW)**: The highest offset replicated to all ISR members. Records at or below HW are **committed** — safe to expose to consumers.

**Invariant**: `HW ≤ LEO` on the leader. Consumers never see records above HW.

### On-Disk Layout

```
partition-0/
├── 00000000000000000000.log      # Segment file: records 0–999
├── 00000000000000000000.index    # Sparse offset → file position index
├── 00000000000000000000.timeindex
├── 00000000000000001000.log      # Segment file: records 1000–1999
├── 00000000000000001000.index
└── ...
```

Each segment holds a configurable number of records (or bytes). Old segments are deleted or compacted based on retention policy.

A record on disk:

```
┌──────────┬───────────┬──────────┬──────────┬─────────────┐
│ Offset   │ Timestamp │ Key Size │ Val Size │ Key | Value  │
│ (8 bytes)│ (8 bytes) │ (4 bytes)│ (4 bytes)│ (variable)  │
└──────────┴───────────┴──────────┴──────────┴─────────────┘
```

Records are written sequentially (append-only) and read with `sendfile()` / zero-copy I/O — this is why the log is fast.

---

## 4. Replication Protocol

Each partition has one **leader** and `replication_factor - 1` **followers**. All produce and consume requests go to the leader.

### 4.1 The In-Sync Replica Set (ISR)

The ISR is the set of replicas that are "caught up" to the leader within a configurable lag threshold.

```
ISR Membership Criteria:
  1. The replica has sent a fetch request within replica.lag.time.max.ms
  2. The replica's LEO is not more than replica.lag.max.messages behind
     (deprecated in modern Kafka; time-based is preferred)
```

**Why ISR exists**: We want strong durability (no data loss on leader crash) without paying the latency cost of synchronous replication to *all* replicas. The ISR is the set we trust — if all ISR members have a record, we consider it committed.

### 4.2 Produce Path (Step by Step)

```
Producer              Leader (Broker 0)         Follower (Broker 1)      Follower (Broker 2)
   │                       │                          │                        │
   │── ProduceRequest ────▶│                          │                        │
   │   (records, acks=all) │                          │                        │
   │                       │                          │                        │
   │                       │── Append to local log ──▶│                        │
   │                       │   LEO = 9                │                        │
   │                       │                          │                        │
   │                       │◀── FetchRequest ─────────│                        │
   │                       │    (fetch_offset=8)      │                        │
   │                       │                          │                        │
   │                       │── FetchResponse ────────▶│                        │
   │                       │   (records at offset 8)  │                        │
   │                       │                          │── Append to local log  │
   │                       │                          │   LEO = 9              │
   │                       │                          │                        │
   │                       │◀── FetchRequest ─────────┼────────────────────────│
   │                       │                          │   (fetch_offset=8)     │
   │                       │── FetchResponse ─────────┼───────────────────────▶│
   │                       │                          │                        │
   │                       │                          │        Append, LEO = 9 │
   │                       │                          │                        │
   │                       │── All ISR at LEO ≥ 9 ───▶│                        │
   │                       │   Advance HW to 9        │                        │
   │                       │                          │                        │
   │◀─ ProduceResponse ───│                          │                        │
   │   (offset=8, no error)│                          │                        │
```

**Critical detail**: Followers *pull* from the leader (FetchRequest), the leader doesn't push. This simplifies flow control — each follower fetches at its own pace.

### 4.3 Acknowledgment Levels

| Setting | Behavior | Durability | Latency |
|---------|----------|------------|---------|
| `acks=0` | Don't wait for any acknowledgment | Records can be lost on any failure | Lowest |
| `acks=1` | Wait for leader to write to its local log | Records lost if leader crashes before replication | Medium |
| `acks=all` | Wait for all ISR members to replicate | Records survive any single broker failure | Highest |

`acks=all` combined with `min.insync.replicas=2` means: the leader won't acknowledge until at least 2 replicas (including itself) have the record. If the ISR shrinks below 2, the partition becomes unavailable for writes — **choosing consistency over availability** (a CP decision during the failure).

### 4.4 High Watermark Advancement

The leader advances HW when it learns that all ISR members have replicated up to a certain offset. It learns this from the `fetch_offset` in each follower's FetchRequest:

```python
def advance_high_watermark(self):
    # For each ISR member, track their confirmed LEO
    isr_leos = [self.follower_leo[r] for r in self.isr]
    isr_leos.append(self.leo)  # Include leader's own LEO
    
    # HW = minimum LEO across all ISR members
    new_hw = min(isr_leos)
    
    if new_hw > self.high_watermark:
        self.high_watermark = new_hw
```

Followers learn the new HW from the leader's FetchResponse (which includes the current HW). This is how committed records become visible to consumers.

---

## 5. Leader Election

When a partition's leader fails, the controller must elect a new leader.

### 5.1 Detection

The controller detects broker failure when the broker's session (heartbeat) expires. The controller uses the phi accrual failure detector (Chapter 8) or a simple timeout on heartbeats.

### 5.2 Election Protocol

```
Controller                   Broker 1 (ISR)           Broker 2 (ISR)
    │                             │                        │
    │── Broker 0 session expired ─┤                        │
    │                             │                        │
    │── Choose new leader from ISR                         │
    │   Broker 1 has highest LEO                           │
    │                             │                        │
    │── LeaderAndIsr(leader=1) ──▶│                        │
    │                             │── I am now leader      │
    │                             │   Truncate? No (ISR)   │
    │                             │                        │
    │── LeaderAndIsr(leader=1) ───┼───────────────────────▶│
    │                             │                        │── Follow Broker 1
    │                             │                        │
    │── Update metadata cache     │                        │
    │   Notify all brokers        │                        │
```

**Leader selection rule**: Pick an ISR member. Prefer the one with the highest LEO (fewest records to recover). If the ISR is empty, either:
- **Wait** (no data loss, but partition is unavailable) — `unclean.leader.election.enable=false`
- **Elect a non-ISR replica** (may lose committed records!) — `unclean.leader.election.enable=true`

This is a direct CP vs AP trade-off from the CAP theorem (Chapter 20).

### 5.3 Log Truncation After Election

When a new leader is elected, followers must truncate any records beyond the new leader's LEO. These are records the old leader had but hadn't replicated — they were never committed (never reached HW), so no consumer saw them.

```
Before leader crash:
  Old Leader (Broker 0): [r0, r1, r2, r3, r4, r5]  LEO=6, HW=4
  Follower   (Broker 1): [r0, r1, r2, r3, r4]       LEO=5
  Follower   (Broker 2): [r0, r1, r2, r3]            LEO=4

After Broker 0 crashes, Broker 1 becomes leader:
  New Leader (Broker 1): [r0, r1, r2, r3, r4]       LEO=5, HW=4
  Follower   (Broker 2): [r0, r1, r2, r3]            LEO=4
  
  r5 is LOST — it was never committed (HW was 4).
  The producer that sent r5 with acks=all never received an ack,
  so it knows to retry.
```

**Key insight**: The high watermark is the dividing line between "safe" and "possibly lost." Records below HW survive any single broker failure. Records above HW may be lost, but the producer was never told they succeeded.

---

## 6. Producer Exactly-Once Semantics

### 6.1 The Problem

A producer sends a record, the leader writes it, the leader crashes before sending the acknowledgment. The producer retries. Now the record is written twice.

```
Producer              Leader
   │                    │
   │── Produce(r5) ───▶│
   │                    │── Write r5 at offset 5
   │                    │── CRASH before sending ack
   │                    │
   │   (timeout)        │
   │                    │   (new leader elected)
   │── Produce(r5) ───▶│   (retry)
   │                    │── Write r5 at offset 6  ← DUPLICATE!
   │◀── Ack(offset=6) ─│
```

### 6.2 Idempotent Producer

Each producer is assigned a unique **Producer ID (PID)** by the broker. For each partition, the producer maintains a **sequence number** that increments with each record.

```
ProduceRequest:
  PID: 42
  Partition: P0
  First Sequence: 100
  Records: [r_100, r_101, r_102]
```

The broker tracks the last sequence number for each `(PID, partition)` pair:

```python
class PartitionLog:
    def __init__(self):
        self.producer_state = {}  # PID -> last_sequence
    
    def append(self, pid, first_sequence, records):
        expected = self.producer_state.get(pid, -1) + 1
        
        if first_sequence == expected:
            # Normal case: write records
            self._write(records)
            self.producer_state[pid] = first_sequence + len(records) - 1
            return SUCCESS
        
        elif first_sequence <= self.producer_state.get(pid, -1):
            # Duplicate! Already have these records.
            return DUPLICATE_SEQUENCE
        
        elif first_sequence > expected:
            # Gap — records were lost in transit
            return OUT_OF_ORDER_SEQUENCE
```

Now the retry scenario:

```
Producer (PID=42)      Leader
   │                     │
   │── Produce(seq=5) ──▶│
   │                     │── Write r5 at offset 5, record producer_state[42]=5
   │                     │── CRASH
   │                     │
   │   (timeout)         │   (new leader, recovers producer_state from log)
   │── Produce(seq=5) ──▶│   (retry)
   │                     │── producer_state[42] == 5, seq == 5
   │                     │── DUPLICATE! Return ack without writing.
   │◀── Ack(offset=5) ──│
```

**No duplicate.** The sequence number is persisted in the log (alongside the record), so it survives broker crashes and leader elections.

### 6.3 Transactional Producer

Idempotent producers prevent duplicates within a single partition. For atomic writes across multiple partitions (and atomic read-process-write in stream processing), we need transactions.

```
Producer                  Transaction Coordinator         Partition Leaders
   │                              │                            │
   │── InitTransactions(TID) ───▶│                            │
   │◀── PID assigned ────────────│                            │
   │                              │                            │
   │── BeginTransaction ─────────│                            │
   │                              │                            │
   │── Produce to P0 ────────────┼───────────────────────────▶│ P0 leader
   │── Produce to P1 ────────────┼───────────────────────────▶│ P1 leader
   │                              │                            │
   │── CommitTransaction ────────│                            │
   │                              │── Write PREPARE to txn log │
   │                              │                            │
   │                              │── WriteTxnMarker(COMMIT)──▶│ P0 leader
   │                              │── WriteTxnMarker(COMMIT)──▶│ P1 leader
   │                              │                            │
   │                              │── Write COMMITTED to log   │
   │◀── CommitResponse ──────────│                            │
```

The Transaction Coordinator uses a special internal topic (`__transaction_state`) to durably log transaction state. This is 2PC (Chapter 26) over the commit log itself — the log is both the data store and the transaction log.

**Consumer isolation**: Consumers with `isolation.level=read_committed` skip records belonging to open or aborted transactions. They see committed records in offset order.

---

## 7. Consumer Group Protocol

### 7.1 Partition Assignment

A consumer group collectively consumes a topic. Each partition is assigned to exactly one consumer in the group.

```
Topic "orders" with 6 partitions, Consumer Group "processing" with 3 consumers:

  Consumer C0: P0, P1
  Consumer C1: P2, P3  
  Consumer C2: P4, P5

If C1 crashes:
  Consumer C0: P0, P1, P2    (rebalance: took P2)
  Consumer C2: P3, P4, P5    (rebalance: took P3)
```

### 7.2 The Rebalance Protocol

Rebalancing is coordinated by a **Group Coordinator** — one of the brokers, chosen by hashing the group ID.

```
Consumer C0                  Group Coordinator              Consumer C1
   │                              │                            │
   │── JoinGroup ────────────────▶│                            │
   │                              │◀── JoinGroup ─────────────│
   │                              │                            │
   │                              │── Pick C0 as group leader  │
   │                              │                            │
   │◀── JoinResponse(leader) ────│                            │
   │   (includes all member IDs)  │── JoinResponse(follower) ─▶│
   │                              │                            │
   │── Compute assignment         │                            │
   │   (range, round-robin, etc.) │                            │
   │                              │                            │
   │── SyncGroup(assignment) ────▶│                            │
   │                              │── SyncGroup ───────────────│
   │                              │                            │
   │◀── SyncResponse ────────────│── SyncResponse(P2,P3) ────▶│
   │   (P0, P1 assigned to me)   │                            │
```

The group leader (a consumer, not the broker) computes the partition assignment and sends it to the coordinator, which distributes it to all members.

### 7.3 Offset Management

Each consumer tracks its position in each assigned partition by committing offsets to a special internal topic (`__consumer_offsets`).

```python
class Consumer:
    def poll(self):
        records = self.fetch(self.current_offset)
        return records
    
    def commit(self):
        # Write current offset to __consumer_offsets
        # This is itself a produce to an internal topic — durable and replicated
        self.coordinator.commit_offset(
            group=self.group_id,
            partition=self.partition,
            offset=self.current_offset
        )
```

**At-least-once** (default): Process records, then commit offset. If consumer crashes after processing but before commit, records are reprocessed on restart.

**At-most-once**: Commit offset, then process records. If consumer crashes after commit but before processing, records are skipped.

**Exactly-once**: Use the transactional API — commit offset and produce output records in the same transaction.

```python
def exactly_once_consume_produce(consumer, producer):
    producer.begin_transaction()
    
    records = consumer.poll()
    for record in records:
        result = process(record)
        producer.produce("output-topic", result)
    
    # Commit input offsets as part of the transaction
    producer.send_offsets_to_transaction(
        consumer.offsets(),
        consumer.group_metadata()
    )
    
    producer.commit_transaction()
    # If commit succeeds: output records AND offset commit are atomic
    # If commit fails: neither is visible — consumer re-reads from last committed offset
```

---

## 8. Failure Scenarios

### Scenario 1: Leader Broker Crashes Mid-Replication

```
Initial state:
  Broker 0 (Leader): [r0..r7]  LEO=8, HW=6
  Broker 1 (ISR):    [r0..r6]  LEO=7
  Broker 2 (ISR):    [r0..r5]  LEO=6
  
  ISR = {0, 1, 2}
  min.insync.replicas = 2

Timeline:
  t0: Producer sends r8 to Broker 0 (acks=all)
  t1: Broker 0 appends r8, LEO=9
  t2: Broker 1 fetches r7 and r8, LEO=9
  t3: Broker 0 crashes before Broker 2 fetches r7/r8
  
After crash:
  Broker 1: [r0..r8]  LEO=9  ← has all records
  Broker 2: [r0..r5]  LEO=6  ← missing r6, r7, r8

Controller action:
  1. Detect Broker 0 failure (heartbeat timeout)
  2. Remove Broker 0 from ISR → ISR = {1, 2}
  3. Elect Broker 1 as leader (highest LEO in ISR)
  4. Broker 2 fetches r6, r7, r8 from new leader
  
What about the producer's ack for r8?
  - HW was 6 when Broker 0 crashed
  - r7 and r8 were not committed (above HW)
  - BUT r7 and r8 exist on Broker 1
  - New leader (Broker 1) has them
  - Once Broker 2 catches up, HW advances to 9
  - Producer never got ack → it retries
  - Idempotent producer deduplicates the retry → no duplicate
```

**Result**: No data loss. The producer retries and discovers its records were already committed.

### Scenario 2: Network Partition Between Brokers

```
┌─────────────────────────┐    PARTITION    ┌─────────────────────┐
│  Broker 0 (Leader)      │ ─── ✕ ✕ ✕ ──── │  Broker 1           │
│  Broker 2               │                 │  Controller         │
└─────────────────────────┘                 └─────────────────────┘

Broker 0 can talk to Broker 2 but not Broker 1 or Controller.
```

**Timeline**:

1. Controller can't reach Broker 0. After timeout, declares Broker 0 dead.
2. Controller elects Broker 1 as new leader (it's in the ISR and reachable).
3. Broker 0 doesn't know it's been deposed. It still thinks it's leader.

**Split-brain prevention**:

Brokers use **epoch numbers** (analogous to Raft terms). The controller increments the epoch when electing a new leader. Producers and consumers include the expected epoch in their requests.

```
Producer ── Produce(epoch=5) ──▶ Broker 0
Broker 0: "My epoch is 5, request epoch is 5, OK"

Controller elects Broker 1 with epoch=6

Producer discovers new leader:
Producer ── Produce(epoch=6) ──▶ Broker 1
Broker 1: "My epoch is 6, request epoch is 6, OK"

Late message from old producer to Broker 0:
Broker 0 ── tries to replicate ──▶ Broker 1
Broker 1: "Your epoch is 5, mine is 6 → FENCED, you are not leader"
```

The fencing mechanism prevents the old leader from accepting writes that the new leader doesn't know about.

### Scenario 3: Slow Replica (ISR Shrinkage)

```
Broker 0 (Leader): LEO=1000, HW=998
Broker 1 (ISR):    LEO=999    ← 1 behind, OK
Broker 2 (ISR):    LEO=500    ← 500 behind! GC pause? Disk issue?

Broker 2 hasn't fetched in 30 seconds (replica.lag.time.max.ms=10000)
```

**Action**: Leader removes Broker 2 from ISR. ISR = {0, 1}.

Now HW can advance based on just Broker 0 and Broker 1's LEOs:
```
HW = min(LEO_0, LEO_1) = min(1000, 999) = 999
```

Without ISR shrinkage, Broker 2 would hold back the HW at 500, and consumers would see a 500-record lag. The ISR mechanism trades durability (fewer replicas) for availability (records keep flowing).

When Broker 2 catches up, the leader adds it back to the ISR.

**Danger**: If `min.insync.replicas=2` and another broker fails while ISR is {0, 1}, the partition becomes unavailable. The ISR is a dynamic safety margin — when it shrinks, the system is running on reduced redundancy.

### Scenario 4: Transaction Coordinator Crash

```
Producer                  Coordinator (Broker 3)
   │                              │
   │── BeginTransaction ─────────│
   │── Produce to P0 ────────────│──── Forwarded
   │── Produce to P1 ────────────│──── Forwarded
   │── CommitTransaction ────────│
   │                              │── Write PREPARE to __transaction_state
   │                              │── Send COMMIT marker to P0  ✓
   │                              │── CRASH before sending COMMIT to P1
   │                              │
   │   (timeout)                  │
```

**Recovery**: The `__transaction_state` topic is replicated. A new coordinator takes over:

1. Reads the PREPARE record from the transaction state log.
2. Sees that a COMMIT was initiated but not completed.
3. Resumes: sends COMMIT marker to P1.
4. Writes COMMITTED to the transaction state log.

This is identical to 2PC coordinator recovery (Chapter 26). The key insight: the prepare record in the durable log is the "point of no return" — once it's written, the transaction must eventually commit (or be explicitly aborted).

---

## 9. Performance Characteristics

### Write Path

```
1. Producer batches records (linger.ms, batch.size)
2. Compress batch (snappy, lz4, zstd)
3. Send to partition leader over TCP
4. Leader appends to page cache (sequential write)
5. OS flushes to disk asynchronously (or sync with flush.messages)
6. Followers fetch and append
7. HW advances, ack sent

Typical latency (acks=all, 3 replicas):
  - 99th percentile: 5–15ms (within datacenter)
  - Throughput: 100K–1M records/sec per partition
```

### Read Path

```
1. Consumer sends FetchRequest(offset=N, max_bytes=1MB)
2. Leader reads from page cache or disk (sequential read)
3. Uses sendfile() syscall (zero-copy: kernel → NIC, no userspace copy)
4. Returns batch of records

Consumers that are caught up read entirely from page cache —
the OS's page cache acts as a read-through cache for the log.
```

### Why the Log Is Fast

| Property | Why It's Fast |
|----------|--------------|
| Sequential I/O | Append-only writes, sequential reads — SSDs and HDDs optimized for this |
| Page cache | The OS caches recent writes in RAM; caught-up consumers read from RAM |
| Zero-copy | `sendfile()` bypasses userspace for network transfers |
| Batching | Amortize network and disk I/O over many records |
| Compression | Compress at the batch level for better ratios |

---

## 10. Design Decisions and Trade-offs

### Why Pull-Based Replication?

Followers pull (fetch) from the leader instead of the leader pushing.

- **Advantage**: Each follower controls its own fetch rate. A slow follower doesn't back-pressure the leader.
- **Advantage**: Simpler flow control — the leader doesn't need to track what each follower needs.
- **Disadvantage**: Slightly higher replication latency (followers poll on an interval).
- **Mitigation**: Long-polling FetchRequests — the follower blocks until new data arrives or a timeout.

### Why ISR Instead of Strict Quorum?

Unlike Raft (majority quorum), our log uses ISR (a dynamic set):

| | Raft Quorum | ISR |
|---|---|---|
| Commit rule | Majority of all voters | All current ISR members |
| Membership | Fixed (config change = joint consensus) | Dynamic (leader adds/removes) |
| Write availability | Needs majority alive | Needs min.insync.replicas alive |
| Replication overhead | Majority only | All ISR (but ISR can shrink) |

ISR is more flexible: it can shrink during failures (maintaining availability) and grow during recovery (restoring durability). But it requires a correct implementation of ISR management — bugs here cause data loss.

### Why Not Use Raft Directly for Each Partition?

You could run a Raft group per partition. Some systems do (e.g., TiKV). Trade-offs:

- **Raft per partition**: Stronger guarantees (linearizable), simpler correctness argument. But: one Raft group per partition means thousands of Raft groups on a single broker — the election and heartbeat overhead adds up.
- **ISR-based**: Higher throughput (fewer protocol rounds), more flexible. But: the ISR protocol is harder to get right (as Jepsen tests have shown).

---

## 11. Correctness Argument

**Claim**: A record acknowledged with `acks=all` and `min.insync.replicas=N` is never lost as long as at most `N-1` brokers fail simultaneously.

**Proof sketch**:

1. When the leader sends an ack, all current ISR members have the record.
2. ISR has at least `min.insync.replicas` members (or the write was rejected).
3. If the leader crashes, the new leader is chosen from the ISR.
4. The new leader has the record (it was in the ISR when the record was committed).
5. If up to `N-1` ISR members crash, at least 1 ISR member survives and can become leader.
6. Therefore the record exists on the new leader.

**Where this breaks**: If all ISR members fail simultaneously (e.g., an entire rack loses power), or if `unclean.leader.election.enable=true` allows a non-ISR replica to become leader.

---

## 12. Exercises

1. **Trace a partition reassignment**: Broker 0 holds Partition P0. The operator adds Broker 4 and wants to move P0 there. Describe the step-by-step protocol: how does the data get moved without downtime or data loss? When does the ISR change? When does the leader change?

2. **Design log compaction**: Some topics represent changelogs where only the latest value per key matters. Design a compaction strategy that: (a) removes old records with the same key, (b) doesn't interfere with active consumers, (c) preserves ordering within a key. What invariants must it maintain?

3. **Handle the "zombie leader"**: Broker 0 has a long GC pause (30 seconds). The controller elects Broker 1 as new leader. Broker 0 wakes up and doesn't know it's been deposed. It has 5 records in its log that Broker 1 doesn't have. Trace the protocol that ensures these records don't corrupt the partition. What if a consumer read those records during the GC pause?

4. **Exactly-once across systems**: A consumer reads from the log and writes to an external database. How do you guarantee exactly-once semantics when the database is not part of the transaction? (Hint: this connects to the Outbox pattern in Chapter 31.)

---

**Next**: [Capstone 5 — Fault-Tolerant Batch Analytics →](capstone05-batch-analytics.md)
