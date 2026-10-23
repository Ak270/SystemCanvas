# Chapter 25: Serializability vs Linearizability — Why They're Different

> **Core question**: What is the difference between database transaction isolation and distributed consistency — and why is combining them so expensive?

## Prerequisites

- Chapter 12: The Consistency Model Hierarchy
- Chapter 13: Linearizability: Herlihy's Formal Definition
- Basic understanding of database transactions (BEGIN, COMMIT, ROLLBACK)

---

## The Confusion

Ask a senior engineer what "consistency" means and you'll get one of two answers:

1. "It means all replicas see the same data" — they're thinking about **linearizability**, a distributed systems concept.
2. "It means transactions execute as if they ran one at a time" — they're thinking about **serializability**, a database concept.

Both answers are correct. They're just answering different questions. And the fact that these two properties share the word "consistency" has caused more confusion than almost any other terminology clash in computer science.

This chapter will make the distinction razor-sharp. We'll define each property formally, show concrete examples where one holds and the other doesn't, explain why combining them is expensive, and show how Google Spanner pays that cost.

---

## Serializability: A Transaction Isolation Property

### The Problem Serializability Solves

Imagine a bank database with two accounts:

```
Account A: $500
Account B: $500
```

Two transactions run concurrently:

```
T1: Transfer $100 from A to B
    read(A) → 500
    write(A, 400)
    read(B) → 500
    write(B, 600)

T2: Calculate total balance
    read(A) → ???
    read(B) → ???
    return A + B
```

If T2 runs between T1's write to A and write to B, it reads:

```
A = 400 (T1 already wrote)
B = 500 (T1 hasn't written yet)
Total = 900  ← $100 vanished!
```

This is a **non-serializable** execution. It cannot correspond to any serial order of T1 and T2.

### Formal Definition

A schedule (interleaving) of transactions is **serializable** if its effect is equivalent to *some* serial execution of those same transactions.

More precisely: given transactions T1, T2, ..., Tn executing concurrently, the interleaved schedule S is serializable if there exists a permutation (Ti1, Ti2, ..., Tin) such that the result of S is identical to running Ti1 to completion, then Ti2 to completion, and so on.

Key points:
- **It doesn't matter which serial order** — just that *some* equivalent serial order exists.
- **It says nothing about real time** — T2 might have started before T1 in wall-clock time, but a serializable schedule could be equivalent to one where T1 runs first.
- **It's about multi-object, multi-operation transactions** — it governs groups of reads and writes that must appear atomic.

### What Serializability Allows

Consider three transactions:

```
T1: write(x, 1); write(y, 1)
T2: write(x, 2); write(y, 2)
T3: read(x); read(y)
```

These are all serializable outcomes for T3:

| Equivalent serial order | T3 reads |
|------------------------|----------|
| T1, T2, T3 | x=2, y=2 |
| T2, T1, T3 | x=1, y=1 |
| T1, T3, T2 | x=1, y=1 |
| T2, T3, T1 | x=2, y=2 |
| T3, T1, T2 | x=0, y=0 (initial values) |
| T3, T2, T1 | x=0, y=0 |

What T3 **cannot** read under serializability: `x=1, y=2` or `x=2, y=1`. Those results correspond to no serial ordering.

### What Serializability Does NOT Guarantee

Serializability makes no promises about **which** serial order the system picks. If T1 finishes at 3:00 PM and T2 starts at 3:01 PM, a serializable system is still allowed to produce a result equivalent to T2 running before T1 — as long as no external observer can tell the difference from the database state alone.

This is the critical gap that linearizability fills.

---

## Linearizability: A Distributed Consistency Property

### The Problem Linearizability Solves

You have a distributed register (a single key-value pair) replicated on three servers. A client writes a value, then another client reads it:

```
Time ────────────────────────────────────────────▶

Client 1:  ├── write(x, 42) ──┤
Client 2:              ├── read(x) ──┤

                       ↑
                 Client 2's read starts
                 AFTER Client 1's write starts
                 but BEFORE it completes
```

What should `read(x)` return? Under linearizability, once any client observes the value 42, every subsequent read must also return 42 (or a later value). The system must behave as if there is a single copy of the data, and every operation takes effect atomically at some point between its invocation and its response.

### Formal Definition (Recap from Chapter 13)

A history H of operations on a shared object is **linearizable** if there exists a total order S of the operations in H such that:

1. **S is a legal sequential history** — it respects the object's sequential specification (e.g., a read returns the most recent write).
2. **S respects real-time ordering** — if operation op1 completes before operation op2 begins (in real time), then op1 appears before op2 in S.

Key points:
- **Single-object** — linearizability is defined for individual objects (a single register, a single queue, a single counter), not transactions spanning multiple objects.
- **Real-time constraint** — unlike serializability, linearizability respects wall-clock ordering. If a write finishes before a read starts, the read must see that write.
- **It says nothing about multi-object transactions** — linearizability alone doesn't help you atomically transfer money between two accounts.

---

## The Two Axes

Here is the core insight:

```
                        ┌───────────────────────────────────────┐
                        │          Correctness Properties       │
                        ├───────────────────┬───────────────────┤
                        │   Serializability  │  Linearizability  │
                        ├───────────────────┼───────────────────┤
  Scope                 │   Multi-object     │   Single-object   │
                        │   (transactions)   │   (one register)  │
                        ├───────────────────┼───────────────────┤
  Time constraint       │   No real-time     │   Respects real-  │
                        │   ordering         │   time ordering   │
                        ├───────────────────┼───────────────────┤
  Domain                │   Database theory  │   Distributed     │
                        │                    │   systems theory  │
                        ├───────────────────┼───────────────────┤
  What it prevents      │   Anomalies from   │   Stale reads,    │
                        │   concurrent txns  │   ordering         │
                        │   (dirty reads,    │   violations       │
                        │   write skew)      │   across replicas  │
                        ├───────────────────┼───────────────────┤
  Formal origin         │   Papadimitriou    │   Herlihy & Wing  │
                        │   1979             │   1990             │
                        └───────────────────┴───────────────────┘
```

They are **orthogonal**. A system can provide one without the other, both, or neither.

---

## Concrete Examples

### Example 1: Serializable but NOT Linearizable

Consider a single-node database running two transactions:

```
Real time ─────────────────────────────────────▶

T1: BEGIN                    COMMIT
    ├── write(x, 1) ──────────┤

T2:      BEGIN                         COMMIT
         ├── read(x) ──────────────────┤
         reads x = 0 (initial value)
```

T2 starts after T1's write(x, 1) but reads the old value. Is this serializable? **Yes** — it's equivalent to T2 running before T1:

```
Serial order: T2, T1
T2 reads x = 0 (initial), then T1 writes x = 1.
```

Is this linearizable? **No** — T1's write of x=1 completed before T2's read of x started (in real time). A linearizable system would require T2 to see x=1.

This happens in databases using **Snapshot Isolation** (SI). When T2 begins, it gets a snapshot of the database from before T1 committed. This is serializable (equivalent to T2 running first) but not linearizable (T2 ignores a write it should have seen in real time).

### Example 2: Linearizable but NOT Serializable

Consider a linearizable key-value store (like etcd) that doesn't support multi-key transactions:

```
Real time ─────────────────────────────────────▶

Client 1: write(x, 1)     write(y, 1)
           ├──────┤         ├──────┤

Client 2:          read(x)→1    read(y)→0
                    ├──────┤     ├──────┤
```

Each individual operation is linearizable:
- Client 1's write(x, 1) takes effect before Client 2's read(x) → correct, reads 1.
- Client 1's write(y, 1) hasn't happened yet when Client 2 reads y → correct, reads 0.

But if we treat Client 1's two writes and Client 2's two reads as transactions:

```
T1: write(x, 1); write(y, 1)
T2: read(x) → 1; read(y) → 0
```

This is **not serializable**. In serial order T2 before T1, T2 would read x=0, y=0. In serial order T1 before T2, T2 would read x=1, y=1. No serial order produces x=1, y=0.

The system is linearizable (each key is individually correct) but not serializable (cross-key transactions show impossible states).

### Example 3: Neither Serializable nor Linearizable

A system using eventual consistency (e.g., Cassandra with consistency level ONE):

```
Client 1: write(x, 42) → ack from one replica
Client 2: read(x) → 0 (hits a different, stale replica)
```

Not linearizable (stale read after completed write). Not serializable either if multi-key operations can observe partial states.

### Example 4: Both Serializable AND Linearizable — Strict Serializability

Google Spanner provides **strict serializability** (also called **external consistency**): transactions are serializable, AND the serial order respects real-time ordering.

If transaction T1 commits before T2 begins, then in the equivalent serial order, T1 comes before T2. No time travel.

```
                     ┌──────────────────────────────┐
                     │     Strict Serializability    │
                     │  (Serializable + Linearizable │
                     │   = External Consistency)     │
                     │                               │
                     │  ┌──────────┐ ┌─────────────┐│
                     │  │Serializ- │ │Lineariz-    ││
                     │  │ability   │ │ability      ││
                     │  │(multi-   │ │(single-     ││
                     │  │object    │ │object       ││
                     │  │txn       │ │real-time)   ││
                     │  │ordering) │ │             ││
                     │  └──────────┘ └─────────────┘│
                     └──────────────────────────────┘
```

---

## How Databases Achieve Serializability

### Two-Phase Locking (2PL)

The classical approach. Every transaction acquires locks on data it accesses:

```
Phase 1 (Growing): Acquire locks. Don't release any.
Phase 2 (Shrinking): Release locks. Don't acquire any.
```

```
T1: lock(A) → read(A) → lock(B) → write(A) → write(B) → unlock(A) → unlock(B)
                                    ↑ growing phase ends
```

**Proof of serializability**: If T1 holds a lock that T2 needs, T2 waits. The dependency graph of "who waited for whom" defines a serial order. Because no transaction releases a lock before acquiring all its locks, no cycles can form.

**Cost**: Transactions block each other. In a distributed database, acquiring a lock on a remote shard requires a network round trip. Under contention, throughput collapses.

**Variants**:
- **Strict 2PL (S2PL)**: Hold all locks until commit. Prevents cascading aborts. This is what most databases actually implement.
- **Strong Strict 2PL (SS2PL)**: Same as S2PL — hold all locks until commit/abort. Provides **strict serializability** because the serial order matches commit order, which matches real-time order.

### Serializable Snapshot Isolation (SSI)

An optimistic approach used by PostgreSQL (since 9.1) and CockroachDB:

1. Each transaction reads from a consistent snapshot (no locks for reads).
2. The system tracks read-write conflicts.
3. At commit time, if the system detects a dangerous pattern (specifically, an **rw-antidependency cycle**), it aborts one of the conflicting transactions.

```
Dangerous structure (write skew):

T1: read(x) ───────────────────────── write(y)
T2: ──────── read(y) ── write(x) ────────────

T1 read x before T2 wrote it (rw-antidependency: T1 → T2)
T2 read y before T1 wrote it (rw-antidependency: T2 → T1)

Cycle detected! Abort one transaction.
```

**Cost**: No blocking for reads (much better throughput than 2PL), but:
- Transactions may be aborted and must retry.
- The system must track read sets, which has memory overhead.
- False positives: some safe executions get aborted because the detection is conservative.

**SSI provides serializability but NOT linearizability** — transactions read from snapshots, so they might miss real-time-ordered writes (as in Example 1 above).

### Actual Serial Execution

The simplest approach: run all transactions on a single thread. No concurrency, no conflicts.

```
Single thread: T1 → T2 → T3 → T4 → ...
```

Used by Redis (single-threaded command execution) and VoltDB (partition-level serial execution). Provides strict serializability trivially — the serial order IS the execution order, which IS the real-time order.

**Cost**: Throughput limited by single-core speed. Only works if transactions are fast (no disk I/O during execution — everything must be in memory).

---

## How Distributed Systems Achieve Linearizability

### Single Leader with Synchronous Replication

All reads and writes go through a single leader. The leader processes operations in order. Followers replicate synchronously before the leader acknowledges.

```
Client → Leader: write(x, 42)
Leader → Followers: replicate write(x, 42)
Followers → Leader: ack
Leader → Client: ok

Client → Leader: read(x) → 42 ✓
```

This is linearizable because the leader serializes all operations and synchronous replication ensures acknowledged writes are durable before any subsequent read.

**Cost**: Every write waits for replication. Reads must go to the leader (or to followers with read leases that bound staleness).

### Consensus-Based Replication (Raft, Paxos)

Each operation is proposed to the consensus group. The leader assigns a log position, replicates to a majority, and then applies the operation.

```
Client → Leader: write(x, 42)
Leader: assigns log position 7
Leader → Majority: AppendEntries(position 7, write(x, 42))
Majority → Leader: ack
Leader: applies write(x, 42)
Leader → Client: ok
```

Linearizable because:
- Each operation gets a unique position in a totally ordered log.
- The log is agreed upon by a majority (consensus).
- Operations are applied in log order.

Systems: etcd, ZooKeeper (linearizable writes, sequential reads by default), CockroachDB (per-range Raft).

**Cost**: Every write requires a consensus round (1 RTT in the common case for Raft). Reads from the leader must verify leadership is still valid (either via read leases or a quorum read).

---

## The Cost of Combining Both: Strict Serializability

To get strict serializability (serializability + linearizability), a distributed database must:

1. **Serialize transactions** across all partitions — preventing anomalies like write skew across shards.
2. **Respect real-time ordering** — if T1 commits before T2 starts, the serial order places T1 first.

This requires **cross-shard coordination** for every transaction that touches multiple shards:

```
Client: BEGIN
Client: read(key_on_shard_1)      ← needs lock or timestamp on shard 1
Client: read(key_on_shard_2)      ← needs lock or timestamp on shard 2
Client: write(key_on_shard_1, v)  ← acquires write lock on shard 1
Client: COMMIT                    ← 2PC across shard 1 and shard 2
                                     + must ensure commit timestamp
                                       respects real-time order
```

### What This Costs in Practice

| Operation | Without strict serializability | With strict serializability |
|-----------|-------------------------------|----------------------------|
| Single-shard read | Local | Local (with timestamp) |
| Single-shard write | Local + replication | Local + replication + timestamp coordination |
| Cross-shard read | Parallel reads | Parallel reads + consistent snapshot |
| Cross-shard write | Parallel writes + 2PC | Parallel writes + 2PC + timestamp ordering |

The overhead is in the **timestamp ordering**: ensuring that the commit timestamps of transactions reflect real-time order. This is trivial on a single machine (use a monotonic counter) but requires clock synchronization across machines.

---

## How Spanner Does It

Google Spanner achieves strict serializability (which it calls **external consistency**) using TrueTime — a clock API backed by GPS receivers and atomic clocks that provides bounded uncertainty:

```
TrueTime.now() → [earliest, latest]

The actual time is guaranteed to be within this interval.
Typical uncertainty: ε ≈ 1-7ms
```

Spanner's protocol:

1. A read-write transaction acquires locks (2PL for serializability).
2. At commit time, the coordinator picks a commit timestamp `s` such that `s > TrueTime.now().latest` at all participants.
3. The coordinator **waits** until `TrueTime.now().earliest > s` before releasing locks (the **commit wait**).
4. This guarantees that the commit timestamp is in the past by the time any subsequent transaction can start.

```
T1 commits at timestamp s1
  → Coordinator waits until s1 is definitely in the past
  → Releases locks

T2 starts, gets timestamp s2
  → s2 > current time > s1 (because commit-wait ensured s1 is past)
  → T2 is ordered after T1 ✓
```

**Cost**: The commit-wait adds ε milliseconds (typically 1-7ms) of latency to every read-write transaction. Google considers this acceptable because:
- The GPS/atomic clock infrastructure keeps ε small.
- Read-only transactions don't need commit-wait — they pick a timestamp and read a consistent snapshot, wait-free.
- Most transactions in Spanner are reads.

We'll cover TrueTime in full detail in Chapter 27.

---

## Decision Framework: What Does Your System Need?

### You Need Serializability When:

- Your application has **multi-object invariants** — balances that must sum to zero, seats that can't be double-booked, inventory that can't go negative.
- You use **transactions** — `BEGIN ... COMMIT` blocks that must appear atomic.
- You need protection against **write skew** — two transactions that each read a value and then write a different value, where the combination violates an invariant.

Example: Two doctors on call. Each checks "is the other doctor still on call?" and then takes themselves off call. Without serializable isolation, both see the other on call and both remove themselves — violating the invariant that at least one doctor must always be on call.

### You Need Linearizability When:

- Your application has a **recency requirement** — once a value is written and acknowledged, every subsequent read must see it.
- You're implementing **leader election** — if a node acquires a lock, all other nodes must immediately see that the lock is held.
- You're implementing a **unique constraint** — two concurrent requests to create the same username must not both succeed.
- You need a **compare-and-swap** operation — read a value, check a condition, write a new value, all atomically and with real-time ordering.

### You Need Both (Strict Serializability) When:

- You have multi-object transactions AND recency requirements.
- You're building a **financial system** where transaction isolation and real-time ordering both matter.
- You're building a **coordination service** where multiple clients make decisions based on shared state.

### You Can Live Without Both When:

- You're building a **social media feed** — eventual consistency is fine; a post appearing 500ms late is acceptable.
- You're building a **cache** — stale data has a bounded lifetime.
- You're building a **metrics pipeline** — approximate counts are sufficient.

---

## The Spectrum in Practice

```
Weakest                                                           Strongest
   │                                                                  │
   ▼                                                                  ▼
 Eventual        Causal         Snapshot        Serializable    Strict
 Consistency     Consistency    Isolation       Isolation       Serializability
   │               │              │                │               │
 Cassandra      COPS           PostgreSQL       PostgreSQL      Spanner
 DynamoDB       MongoDB         (default)       (SSI mode)      CockroachDB
 (default)      (causal)                        VoltDB          FaunaDB
                                                                FoundationDB
```

Each step to the right adds a constraint and costs performance:

| Property | What it adds | What it costs |
|----------|-------------|---------------|
| Eventual → Causal | Respects cause-and-effect ordering | Metadata tracking (vector clocks) |
| Causal → Snapshot Isolation | Transactions see consistent snapshots | Multi-version storage, garbage collection |
| SI → Serializable | No write skew anomalies | Conflict detection/blocking, aborts |
| Serializable → Strict Serializable | Real-time transaction ordering | Cross-node clock coordination |

---

## Common Misconceptions

### "Serializability means linearizability"

No. Serializability allows time travel — a transaction can appear to execute at any point, not necessarily when it actually ran. Linearizability enforces real-time ordering.

### "Linearizability means serializability"

No. Linearizability is per-object. It says nothing about cross-object consistency. You can have a linearizable register `x` and a linearizable register `y` and still observe `x=new, y=old` — the combination is not serializable if viewed as a transaction.

### "Strong consistency means both"

"Strong consistency" is an informal term that different systems define differently. Always ask: strong in what sense? Serializable? Linearizable? Both?

### "Eventual consistency is weak, so my application doesn't need serializability"

These are different dimensions. You might have an eventually consistent replicated system that still needs serializable transactions within each replica (e.g., a multi-region setup where each region runs serializable transactions locally, but cross-region replication is asynchronous).

### "If I use Raft, I get strict serializability"

Raft provides linearizable replication of a log. If you apply single-key operations from that log, you get a linearizable key-value store. But you don't automatically get serializability for multi-key transactions — you need additional mechanisms (like SSI or 2PL) on top of Raft.

---

## Summary

| Property | Scope | Time constraint | Prevents | Cost |
|----------|-------|----------------|----------|------|
| **Serializability** | Multi-object transactions | None (any equivalent serial order) | Transaction anomalies (dirty reads, write skew, etc.) | Lock contention or aborts |
| **Linearizability** | Single object | Real-time ordering | Stale reads, split-brain | Consensus/coordination per operation |
| **Strict serializability** | Multi-object transactions | Real-time ordering | Everything above | All costs above + clock synchronization |

The fundamental tension: **serializability is about isolation** (transactions don't interfere with each other), while **linearizability is about recency** (reads reflect the latest writes in real time). Most applications need one or the other. The few that need both — financial systems, coordination services, globally distributed databases — pay for it in latency and complexity.

---

## Key Takeaways

1. **Serializability and linearizability are on different axes.** One is about multi-object transaction isolation; the other is about single-object real-time ordering.
2. **A history can be serializable but not linearizable** (snapshot isolation allows "time travel" reads) **or linearizable but not serializable** (per-key linearizability doesn't prevent cross-key anomalies).
3. **Strict serializability** (the combination) is the strongest guarantee and the most expensive — it requires both transaction coordination and real-time clock ordering.
4. **Most systems choose one axis.** Traditional databases focus on serializability; distributed key-value stores focus on linearizability. Spanner is exceptional in providing both.
5. **The cost is always coordination.** Weaker guarantees allow nodes to act independently; stronger guarantees require them to talk to each other before responding.

---

## References

- Papadimitriou, C. H. "The Serializability of Concurrent Database Updates." *Journal of the ACM*, 1979.
- Herlihy, M. P. and Wing, J. M. "Linearizability: A Correctness Condition for Concurrent Objects." *ACM TOPLAS*, 1990.
- Berenson, H. et al. "A Critique of ANSI SQL Isolation Levels." *SIGMOD*, 1995.
- Cahill, M. J. et al. "Serializable Isolation for Snapshot Databases." *ACM TODS*, 2009. (SSI)
- Corbett, J. C. et al. "Spanner: Google's Globally-Distributed Database." *OSDI*, 2012.
- Bailis, P. et al. "Highly Available Transactions: Virtues and Limitations." *VLDB*, 2014.
- Kleppmann, M. "Please Stop Calling Databases CP or AP." Blog post, 2015.

---

**Next**: [Chapter 26: Two-Phase Commit →](ch26-two-phase-commit.md)
