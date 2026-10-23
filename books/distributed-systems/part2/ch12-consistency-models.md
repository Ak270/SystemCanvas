# Chapter 12: The Consistency Model Hierarchy

> **Core question**: What exactly do engineers mean when they say a system is "consistent"?

> **Prerequisites**: Chapter 10 (Lamport Clocks), Chapter 11 (Vector Clocks)

---

## The Word "Consistent" Is Dangerously Overloaded

In a single conversation about distributed systems, the word "consistent" might mean:

1. **CAP consistency** (linearizability) — every read returns the most recent write
2. **ACID consistency** — a transaction preserves database invariants
3. **Replica consistency** — all replicas hold the same data
4. **Cache consistency** — a cache reflects the latest value in the backing store

These are four fundamentally different concepts that share a name. This chapter is about **consistency models for distributed shared data**: formal specifications of what a system is allowed to return when multiple processes read and write concurrently.

Understanding the hierarchy of these models is critical because every distributed storage system makes a choice on this spectrum, and that choice determines what your application can and cannot assume about the data it reads.

---

## The Hierarchy at a Glance

Consistency models form a hierarchy from strongest (most restrictive, hardest to implement, slowest) to weakest (most permissive, easiest to implement, fastest):

```
Strongest
   │
   ▼
┌─────────────────────┐
│   Linearizability    │  ← "As if there's a single copy"
│   (Herlihy 1990)     │     Spanner, etcd, single-node DB
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Sequential           │  ← "Global order exists, but may not
│ Consistency          │     match real time"
│ (Lamport 1979)       │     ZooKeeper
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Causal               │  ← "Cause and effect are preserved"
│ Consistency          │     MongoDB (with causal sessions)
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ PRAM /               │  ← "Each writer's order is preserved"
│ FIFO Consistency     │     
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Eventual             │  ← "All replicas converge...eventually"
│ Consistency          │     DynamoDB, Cassandra (default)
└─────────────────────┘

Weakest
```

Each level is strictly weaker than the one above it: every execution that satisfies linearizability also satisfies sequential consistency, which also satisfies causal consistency, and so on. But the reverse is not true — there are executions allowed by eventual consistency that violate causal consistency.

---

## Linearizability: The Gold Standard

Linearizability (Herlihy and Wing, 1990) is the strongest single-object consistency model. It means the system behaves **as if there is exactly one copy of the data, and every operation takes effect atomically at some point between its invocation and response**.

### Formal Definition

A history *H* (a sequence of operation invocations and responses across all processes) is **linearizable** if there exists a sequential history *S* such that:

1. *S* is a permutation of the operations in *H*
2. *S* respects the specification of the object (e.g., a register returns the last value written)
3. If operation *op1* completes before operation *op2* starts (in real time), then *op1* appears before *op2* in *S*

Condition 3 is the critical one: the order must respect **real-time precedence**. Operations that overlap in time may be reordered, but operations with a clear before/after relationship must keep that order.

### Visual Example

```
Real time ────────────────────────────────────────────▶

Client A:  |── write(x=1) ──|
Client B:       |── write(x=2) ──|
Client C:            |── read(x) → ? ──|
Client D:                                |── read(x) → ? ──|
```

Operations from A and B overlap in time — they're concurrent. But D's read starts after both writes complete. In a linearizable system:

- C's read can return 1 or 2 (both writes are concurrent with the read, so either could "take effect" before or after the read)
- D's read **must** return 2 if write(x=2) linearized after write(x=1), or 1 if the order was reversed — but once any read returns a value, all subsequent non-concurrent reads must be consistent with that ordering

The key constraint: **once a new value is visible to any reader, it must be visible to all subsequent readers.** No "going back in time."

```
Linearization point (one valid ordering):

   write(x=1)     write(x=2)
       ●               ●
       │               │
───────┼───────────────┼──────────▶ time
              │                │
           read→1           read→2
              ●                ●
```

### Real-World Systems

| System | Linearizable? | How |
|--------|:------------:|-----|
| Single-node database | Yes | Single copy, locks or MVCC |
| Google Spanner | Yes | TrueTime + 2PC + Paxos |
| etcd | Yes | Raft consensus |
| CockroachDB | Yes (per-range) | Raft + hybrid logical clocks |
| ZooKeeper | **No** (reads from followers) | Reads may be stale |

### The Cost

Linearizability requires **coordination**. In the simplest case, every read must contact a majority of replicas (quorum read) or go through a single leader. This means:

- **Latency**: Every operation incurs at least one network round trip to a quorum
- **Availability**: During a network partition, at least one side of the partition cannot make progress (this is the CAP theorem, Chapter 20)
- **Throughput**: The single-leader bottleneck or quorum overhead limits operations per second

These costs are why most systems do not provide linearizability by default.

---

## Sequential Consistency: Global Order Without Real-Time Guarantees

Sequential consistency (Lamport, 1979) relaxes linearizability's real-time constraint. The system must behave as if all operations are executed in **some** sequential order, and that order must be consistent with the **program order** of each individual process. But operations from different processes may be reordered relative to their real-time occurrence.

### Formal Definition

A history *H* is **sequentially consistent** if there exists a sequential history *S* such that:

1. *S* is a permutation of the operations in *H*
2. *S* respects the specification of the object
3. For each process *p*, the operations of *p* appear in *S* in the same order they appear in *H*

Notice what's missing: condition 3 from linearizability (real-time ordering across processes) is gone. Only per-process order is preserved.

### What This Allows

```
Real time ────────────────────────────────────────────▶

Client A:  |── write(x=1) ──|
Client B:                          |── write(x=2) ──|
Client C:                                                |── read(x) → 1 ──|
```

In a linearizable system, C's read **must** return 2, because write(x=2) completed before the read started.

In a sequentially consistent system, C's read **may** return 1. The system can order the writes as `write(x=2)` then `write(x=1)`, as long as this reordering doesn't violate either A's or B's individual program order. Since A and B are different processes, their operations can be reordered relative to each other.

### ZooKeeper's Model

ZooKeeper provides sequential consistency for reads from followers, plus a stronger guarantee called **linearizable writes** (writes go through the leader and are applied in Zab total order). This means:

- All clients see writes in the same order
- A client reading from a follower might see stale data
- A client can call `sync()` to force its next read to be fresh

This is a deliberate trade-off: by serving reads from followers without consulting the leader, ZooKeeper achieves much higher read throughput than a fully linearizable system.

### The Gap Between Sequential and Linearizable

The critical difference: in a sequentially consistent system, a write that completed five minutes ago might still not be visible to a reader on a different process. In a linearizable system, a write is visible to everyone the instant it completes.

This matters when you're using a distributed store for coordination. If Process A writes a lock value and then tells Process B "I've released the lock" (through an out-of-band channel like a message queue), Process B might read the store and still see the lock held — because sequential consistency doesn't guarantee that B sees A's most recent write.

---

## Causal Consistency: Preserving Cause and Effect

Causal consistency preserves the happens-before relation (Chapter 10). If operation *a* could have influenced operation *b* (because *b* happened after *a* on the same process, or *b* read a value written by *a*, or by transitivity), then every process sees *a* before *b*. But concurrent operations — those with no causal relationship — may be seen in different orders by different processes.

### Formal Definition

A history *H* is **causally consistent** if there exists, for each process *p*, a sequential history *S_p* such that:

1. *S_p* contains all operations in *H*
2. *S_p* respects the specification of the object
3. If operation *a* causally precedes operation *b* (written *a* →  *b*), then *a* appears before *b* in every *S_p*

Note: different processes may have different sequential histories (*S_p* vs *S_q*), as long as they all agree on causal order.

### What This Allows

```
Process A:  write(x=1)  ──────────────────  write(x=3)
                    \                          
Process B:           read(x)→1   write(x=2)   
                                      
Process C:  reads:   x=2, x=1, x=3     ← ALLOWED under causal consistency
Process D:  reads:   x=1, x=2, x=3     ← ALSO ALLOWED
```

Process B read x=1 (written by A), then wrote x=2. So there's a causal chain: `write(x=1) → read(x=1) → write(x=2)`. Both C and D must see write(x=1) before write(x=2).

But write(x=3) by A is concurrent with write(x=2) by B (no causal connection). So C could see x=2 then x=3, while D sees x=3 then x=2.

Under sequential consistency, this would be forbidden — there must be a single global order. Under causal consistency, concurrent events can be perceived in different orders.

### Why Causal Consistency Matters

Causal consistency captures what users expect from social media, chat, and collaborative apps:

- If Alice posts "I got the job!" and Bob replies "Congrats!", no one should see Bob's reply without seeing Alice's post
- If a user changes their privacy settings and then posts a photo, no one should see the photo under the old settings
- In a code review, if someone comments on a specific line, readers should see the code diff before the comment

These are all causal dependencies. As long as they're preserved, users don't notice (or care about) the ordering of unrelated events.

### Real-World Systems

MongoDB with causal sessions provides causal consistency. The client library tracks a **cluster time** and an **operation time** that ensures reads within a causal session see all prior causally dependent writes.

COPS (Lloyd et al., 2011) was a research system designed specifically for causal+ consistency (causal consistency plus convergence) across wide-area replicated data stores.

---

## PRAM / FIFO Consistency

**PRAM** (Pipelined RAM, Lipton and Sandberg, 1988) consistency, also called **FIFO consistency**, guarantees only that writes from a single process are seen by all other processes in the order they were issued. Writes from different processes may be seen in any order.

### Formal Definition

A history is **PRAM consistent** if, for each process *p*, there exists a sequential history *S_p* such that:

1. *S_p* contains all operations in *H*
2. *S_p* respects the specification of the object
3. For each process *q*, the writes by *q* appear in *S_p* in the same order *q* issued them

This is strictly weaker than causal consistency: PRAM preserves write order per process, but not the transitive causal chain through reads.

### Example Where PRAM Differs from Causal

```
Process A:  write(x=1)
Process B:  read(x) → 1    write(y=2)
Process C:  read(y) → 2    read(x) → 0    ← ALLOWED under PRAM, FORBIDDEN under causal
```

Under causal consistency: B read x=1, then wrote y=2. C read y=2, so C must have seen B's write, which causally depends on A's write(x=1). Therefore C must also see x=1.

Under PRAM: C only needs to see B's writes in order. B wrote y=2, and C saw it. But PRAM doesn't track that B's write was influenced by A's write, so C can legally see x=0.

PRAM is mainly of theoretical interest today. It illustrates the boundary between preserving per-writer order (which is cheap) and preserving causal chains (which requires tracking dependencies).

---

## Eventual Consistency: The Floor

Eventual consistency is the weakest useful consistency model. It guarantees only that **if no new updates are made to a data item, all replicas will eventually converge to the same value.**

### Formal Definition (Informal)

A system provides eventual consistency if:
1. If no new updates are submitted, all replicas will **eventually** return the same value
2. There is no bound on how long "eventually" takes

That's it. No ordering guarantees. No visibility guarantees. A read can return any previous value, even one that has been overwritten, as long as the system eventually converges.

### What Eventual Consistency Actually Means in Practice

"Eventually consistent" is not a synonym for "broken" or "unreliable." It's a specific engineering trade-off:

**What you give up**: At any point in time, different readers may see different values. A reader might see an old value even after a newer one has been written.

**What you get**: 
- **High availability**: Every non-faulty node can handle reads and writes, even during network partitions
- **Low latency**: Writes return immediately without waiting for replication
- **Simple operations**: No leader election, no quorum, no coordination for the common path

### The Misconceptions

**Misconception 1: "Eventually consistent means data loss."** 

No. The system guarantees convergence. All replicas will eventually hold the same data. The question is what the data looks like during the convergence window.

**Misconception 2: "Eventual consistency means reads return random values."**

In practice, most reads return recent values. The "eventually" window is typically milliseconds to low seconds, not hours. And systems usually provide additional guarantees beyond bare eventual consistency (see Session Guarantees below).

**Misconception 3: "Eventual consistency is only for unimportant data."**

Amazon's shopping cart (Dynamo) uses eventual consistency. DNS uses eventual consistency. These are not unimportant. The trade-off is appropriate when availability and latency matter more than reading the absolutely latest value, and when conflicts can be resolved at the application level.

### Real-World Systems

| System | Default Consistency | Can Be Strengthened? |
|--------|-------------------|---------------------|
| DynamoDB | Eventual | Yes — strongly consistent reads (at 2x cost) |
| Cassandra | Eventual (ONE/ONE) | Yes — QUORUM reads/writes ≈ linearizable |
| DNS | Eventual (TTL-based) | No — by design |
| Amazon S3 | Strong (since Dec 2020) | N/A — upgraded from eventual |
| Memcached | Eventual | No — it's a cache |

---

## Session Guarantees: Strengthening Eventual Consistency

Bare eventual consistency is often too weak for application correctness. **Session guarantees** (Terry et al., 1994) add per-client ordering constraints on top of an eventually consistent base:

### Read Your Writes

A process that writes a value *v* will always see *v* (or a later value) on subsequent reads within the same session.

```
Without read-your-writes:
  Client: write(x=5)
  Client: read(x) → 3    ← stale! The write hasn't propagated yet

With read-your-writes:
  Client: write(x=5)
  Client: read(x) → 5    ← guaranteed
```

**Implementation**: Track the version vector of the client's last write. On read, only contact replicas whose version is at least as recent.

**Why it matters**: Without this, a user submits a form, refreshes the page, and doesn't see their change. The system looks broken even though it's working correctly per its consistency model.

### Monotonic Reads

If a process reads value *v*, all subsequent reads by that process will return *v* or a later value. Never an earlier one.

```
Without monotonic reads:
  Client: read(x) → 5
  Client: read(x) → 3    ← went backwards in time!

With monotonic reads:
  Client: read(x) → 5
  Client: read(x) → 5 or later
```

**Implementation**: Track the version vector of the client's last read. On the next read, only contact replicas at least as recent.

**Why it matters**: Without this, a user sees a comment appear and then disappear on page refresh, then reappear again. It looks like a bug.

### Monotonic Writes

If a process performs write *w1* before write *w2*, then *w1* is applied before *w2* at every replica.

**Why it matters**: Without this, updating a user's password and then updating their email might be applied in reverse order at some replica, potentially causing the email update to be associated with the old password.

### Writes Follow Reads

If a process reads value *v* (written by write *w1*) and then performs write *w2*, then *w2* is applied after *w1* at every replica.

**Why it matters**: If a user reads a forum post and then writes a reply, the reply must be seen after the post at every replica. Without this guarantee, some readers might see the reply without the original post.

### Combining Session Guarantees

A system providing all four session guarantees on top of eventual consistency gives a developer experience that is much closer to sequential consistency for single-client interactions, while still allowing the performance and availability benefits of eventual replication for cross-client visibility.

DynamoDB's "strongly consistent reads" and MongoDB's causal sessions are practical embodiments of these guarantees.

---

## The Performance–Consistency Spectrum

Why would anyone choose a weaker consistency model? Because stronger consistency has a direct cost in latency, availability, or throughput:

```
Model                  Minimum latency            Availability during
                       per operation              network partition
──────────────────────────────────────────────────────────────────────
Linearizable           1 RTT to quorum            One side blocked
                       (or leader)                (CAP theorem)

Sequential             1 RTT to leader (writes)   Reads may continue
                       Local (stale reads)        from followers

Causal                 Local or 1 RTT             Both sides can
                       (track dependencies)       operate (with care)

Eventual               Local                      Both sides fully
                       (no coordination)          operational
```

The Abadi-Brewer PACELC framework (Chapter 20) makes this explicit: even when there is no partition, there is a trade-off between **latency** and **consistency**. Stronger consistency requires more coordination, which means more network round trips, which means higher latency.

### Quantifying the Cost

A study by Bailis et al. (2014) measured the latency overhead of different consistency models:

- **Eventual consistency**: 1–2ms (local read/write, async replication)
- **Causal consistency**: 2–5ms (track and verify causal dependencies)
- **Linearizability**: 10–200ms+ (quorum round trip, depends on geographic distribution)

For a system with replicas across continents (US East, EU, Asia-Pacific), the round trip time between regions is ~100-300ms. Linearizable operations in such a system have a floor latency of ~100ms. Eventually consistent operations can return in <1ms.

---

## How to Choose a Consistency Model

### The Decision Framework

```
START
  │
  ▼
Does your application require that
all readers see the latest write immediately?
  │
  ├── YES → Linearizability
  │         (Spanner, etcd, single-leader with sync replication)
  │
  ▼
Does your application require a global
total order of operations?
  │
  ├── YES → Sequential Consistency
  │         (ZooKeeper, single-leader with async read)
  │
  ▼
Does your application require that
cause-and-effect ordering is preserved?
  │
  ├── YES → Causal Consistency
  │         (MongoDB causal sessions, COPS)
  │
  ▼
Can your application tolerate
temporarily stale or out-of-order reads?
  │
  ├── YES → Eventual Consistency + Session Guarantees
  │         (DynamoDB, Cassandra with tunable consistency)
  │
  ▼
Does your application only need
convergence with no ordering at all?
  │
  └── YES → Bare Eventual Consistency
            (DNS, caches)
```

### Common Patterns by Application Type

| Application | Typical Model | Why |
|------------|---------------|-----|
| Bank account balance | Linearizable | Must not show stale balance after transfer |
| Distributed lock | Linearizable | Lock must be globally visible the instant it's acquired |
| Configuration store | Sequential or Linearizable | Config changes must be seen in order |
| Social media feed | Causal | Replies must follow posts; concurrent posts can reorder |
| Product catalog | Eventual + session guarantees | Slight staleness is acceptable; availability is critical |
| Analytics counters | Eventual | Approximate counts are fine; high write throughput needed |
| DNS | Eventual | TTL-based propagation by design |

---

## Mixing Consistency Models

Real systems often provide different consistency levels for different operations or data types:

**Spanner**: Linearizable for read-write transactions, but offers **bounded staleness** reads (eventually consistent with a time bound) for lower-latency reads that can tolerate slightly stale data.

**Cassandra**: Tunable per-query. `CONSISTENCY ONE` for eventual, `CONSISTENCY QUORUM` for something close to linearizable, `CONSISTENCY ALL` for strong but fragile (any single node failure blocks the operation).

**DynamoDB**: Eventually consistent reads by default, strongly consistent reads as an option (at 2x the cost in read capacity units).

This mixing is not a hack — it's a principled design choice. Most applications have a mix of data access patterns, and applying the strongest model to everything wastes latency and availability on operations that don't need it.

### The Danger of Mixing

The risk of mixing models is that developers must reason about which guarantee applies to each code path. A common bug:

```python
# Write with strong consistency
dynamodb.put_item(TableName='users', Item={'id': '123', 'name': 'Alice'})

# Read with eventual consistency (the default!)
response = dynamodb.get_item(TableName='users', Key={'id': '123'})
# response might not contain Alice yet!
```

The fix is to either use consistent reads for this code path:

```python
response = dynamodb.get_item(
    TableName='users', 
    Key={'id': '123'},
    ConsistentRead=True
)
```

Or to design the application to handle staleness gracefully.

---

## Consistency vs. Consensus

A common confusion: consistency models and consensus algorithms are related but different concepts.

**Consistency model**: A *specification* — what behaviors the system promises to its clients. It's a contract. ("Every read returns the most recent write.")

**Consensus algorithm**: An *implementation mechanism* — how replicas agree on the order of operations. It's a protocol. ("Raft elects a leader who sequences writes.")

The relationship:

```
┌──────────────────────┐         ┌──────────────────────┐
│ Linearizability      │         │  Raft, Paxos,        │
│ (Consistency Model)  │◄────────│  ZAB                 │
│ "What we promise"    │ enables │  (Consensus Protocols)│
│                      │         │  "How we deliver it"  │
└──────────────────────┘         └──────────────────────┘
```

You can implement linearizability using Raft (Chapter 22). But linearizability is the *goal*, and Raft is one way to achieve it. Other approaches (single leader with synchronous replication, chain replication) also achieve linearizability without a formal consensus protocol.

Conversely, consensus is used for more than just consistency: leader election, atomic broadcast, and configuration management all use consensus but serve different purposes than the consistency-model hierarchy discussed here.

---

## A Note on Jepsen's Consistency Diagram

Kyle Kingsbury (aphyr) maintains a well-known diagram showing the consistency guarantees that various databases actually provide (as opposed to what they claim). Key findings:

- Several databases that claim "strong consistency" actually provide only eventual or causal consistency under partition
- Some databases that claim "serializable isolation" actually provide only snapshot isolation
- The gap between marketing and reality is significant

The Jepsen project (Chapter 23) systematically tests these claims by injecting network partitions, clock skew, and process crashes, then checking whether the system's behavior matches its documented consistency model.

This is not academic pedantry. In 2015, Jepsen testing revealed that MongoDB could lose acknowledged writes during a network partition — a violation of its documented durability guarantees. The finding led to protocol changes in MongoDB 3.4+.

---

## Strict Serializability: The Strongest of All

There is one model stronger than linearizability alone: **strict serializability** (also called **external consistency** or **linearizable + serializable**). It combines:

- **Serializability**: Transactions appear to execute in some serial order
- **Linearizability**: That serial order respects real-time precedence

This is what Google Spanner provides and what Chapter 25 (Serializability vs. Linearizability) and Chapter 27 (Spanner's TrueTime) explore in detail. It's the most expensive model to implement, requiring synchronized clocks (or clock uncertainty tracking) and distributed commit protocols.

For single-object operations, strict serializability and linearizability are equivalent. The distinction matters only for multi-object transactions.

---

## Key Takeaways

1. **"Consistent" means nothing without specifying the model.** Always ask: linearizable? Sequentially consistent? Causally consistent? Eventually consistent?

2. **The hierarchy is strict**: linearizable ⊂ sequential ⊂ causal ⊂ PRAM ⊂ eventual. Each level permits everything the level above permits, plus more behaviors.

3. **Linearizability is the strongest single-object model** — it guarantees the system behaves as if there's one copy and operations take effect atomically in real-time order.

4. **Sequential consistency drops the real-time constraint** — operations from different processes can appear reordered relative to their real-time occurrence.

5. **Causal consistency preserves cause-and-effect** — if event A could have influenced event B, everyone sees A before B. Concurrent events can appear in any order.

6. **Eventual consistency guarantees convergence** — not correctness at any point in time, but eventual agreement. Session guarantees make it usable.

7. **Stronger consistency costs latency and availability.** Linearizability requires coordination (quorum or leader); eventual consistency is local. This is a fundamental trade-off, not an implementation limitation.

8. **Most real systems mix consistency levels.** Use the strongest model only where correctness demands it, and weaker models where performance and availability matter more.

9. **Eventual consistency is not "buggy."** It's a deliberate choice that enables high availability and low latency. The engineering challenge is in the conflict resolution strategy, not in the consistency model itself.

10. **Test your actual consistency guarantees.** Jepsen has shown repeatedly that databases don't always deliver the consistency they promise. Verify with fault injection, not documentation.

---

## References

- Herlihy, M. and Wing, J. (1990). "Linearizability: A Correctness Condition for Concurrent Objects." *ACM TOPLAS*.
- Lamport, L. (1979). "How to Make a Multiprocessor Computer That Correctly Executes Multiprocess Programs." *IEEE Transactions on Computers*.
- Ahamad, M., et al. (1995). "Causal Memory: Definitions, Implementation, and Programming." *Distributed Computing*.
- Terry, D. B., et al. (1994). "Session Guarantees for Weakly Consistent Replicated Data." *PDIS*.
- Bailis, P., et al. (2014). "Quantifying Eventual Consistency with PBS." *VLDB Journal*.
- Lloyd, W., et al. (2011). "Don't Settle for Eventual: Scalable Causal Consistency for Wide-Area Storage with COPS." *SOSP*.
- Viotti, P. and Vukolic, M. (2016). "Consistency in Non-Transactional Distributed Storage Systems." *ACM Computing Surveys*.
- Kingsbury, K. (2013–present). "Jepsen: Distributed Systems Safety Analysis." https://jepsen.io
- Abadi, D. (2012). "Consistency Tradeoffs in Modern Distributed Database System Design." *IEEE Computer*.

---

**Next**: [Chapter 13 — Linearizability: Herlihy's Formal Definition →](ch13-linearizability.md)
