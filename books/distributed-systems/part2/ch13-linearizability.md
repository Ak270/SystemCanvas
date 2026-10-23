# Chapter 13: Linearizability — Herlihy's Formal Definition

> *What is the strongest correctness guarantee a distributed data store can offer, precisely stated?*

**Prerequisites**: Chapter 10 (Lamport Clocks), Chapter 12 (Consistency Model Hierarchy)

---

## Why You Need a Formal Definition

Every database marketing page claims "strong consistency." But what does that actually mean? Without a precise definition, two engineers arguing about whether a system is "consistent" are often talking about entirely different properties.

In 1990, Maurice Herlihy and Jeannette Wing published a paper titled *Linearizability: A Correctness Condition for Concurrent Objects* that gave us exactly the definition we needed. Linearizability provides a single, unambiguous standard: a system is linearizable if every operation appears to take effect instantaneously at some point between its invocation and its response.

That single sentence is the whole definition. The rest of this chapter is about understanding what it means, how to check it, and what it costs.

---

## The Intuition: Behave Like a Single Machine

Imagine you have a single-threaded server holding a register `x`. Clients send read and write requests over the network. Even though requests arrive concurrently at the server, the server processes them one at a time. Every read returns the value from the most recent write.

A distributed system is linearizable if it behaves *exactly* like that single-threaded server — even though it's running across multiple machines, with replication, network delays, and failures.

This is a powerful promise. It means the application programmer can pretend the distributed database is a single machine. No need to reason about replicas, replication lag, or stale reads. If you wrote a value, every subsequent read sees it. If two clients write at the same time, one goes first and the other goes second — there is a definite order, and everyone agrees on it.

---

## Formal Setup: Histories, Invocations, and Responses

To define linearizability precisely, we need to formalize what "an operation" means in a concurrent system.

### Operations Are Not Instantaneous

In a single-threaded program, an operation happens at one point in time. In a distributed system, every operation has **duration** — it begins when the client sends the request (the **invocation**) and ends when the client receives the answer (the **response**).

```
Client A:   |------ Write(x, 1) ------|
                inv                   resp

Client B:        |---- Read(x) ----|
                  inv              resp

Time ───────────────────────────────────────▶
```

Between the invocation and the response, we don't know exactly *when* the operation "really happened" inside the system. It could have taken effect the moment the server received it, or the moment the server committed it, or anywhere in between.

### Histories

A **history** is a sequence of invocation and response events, ordered by time. Each event records:
- Which client (process) performed it
- Which object it targeted
- Whether it's an invocation or a response
- The operation and arguments (for invocations) or the return value (for responses)

Example history `H`:

```
1. A invokes Write(x, 1)
2. B invokes Read(x)
3. A receives Write OK
4. B receives Read → 1
```

### Complete and Pending Operations

An operation is **complete** if its history contains both the invocation and the matching response. An operation is **pending** if the invocation appears but no matching response does — the client is still waiting.

### Sequential Histories

A history is **sequential** if:
1. Every invocation is immediately followed by its matching response (no interleaving)
2. The operations form a total order

In a sequential history, there's no ambiguity — each operation happens at one precise moment.

```
Sequential history:
  A: Write(x, 1) → OK
  B: Read(x) → 1
  B: Write(x, 2) → OK
  A: Read(x) → 2
```

### Legal Sequential Histories

A sequential history is **legal** if every read returns the value of the most recent preceding write to the same object. The sequential history above is legal: B reads x after A writes 1, and gets 1. A reads x after B writes 2, and gets 2.

---

## The Definition

With this machinery in place, here is Herlihy and Wing's definition:

> A history **H** is **linearizable** if it can be extended (by appending zero or more responses to pending operations, and discarding some pending operations) to a history **H'** such that:
>
> **L1**: There exists a legal sequential history **S** that is equivalent to **H'** (contains the same operations with the same results).
>
> **L2**: If operation `op1` finishes before operation `op2` starts in **H**, then `op1` appears before `op2` in **S**.

Let's unpack this.

**L1** says: you can reorder the operations into a sequential (one-at-a-time) history that is legal (reads return the right values). This sequential history is the "linearization" — it's the order in which operations "appeared to happen."

**L2** says: the reordering must respect real-time ordering. If one operation completed before another started, the linearization must put the first one first. You can't reorder operations that don't overlap in time.

The key insight: **only overlapping operations can be reordered.** If two operations overlap in time (one started before the other finished), the linearization can put them in either order. But if they don't overlap, their real-time order is fixed.

### The Linearization Point

For each operation in a linearizable history, there exists a single point in time between the invocation and the response at which the operation "takes effect." This is the **linearization point**.

```
Client A:   |-------- Write(x, 1) --------|
                          ↑ linearization point

Client B:        |---- Read(x) ----|
                       ↑ linearization point

Time ───────────────────────────────────────▶
```

If you project every operation down to its linearization point, you get the sequential history S. The linearization point must fall within the operation's duration, and the resulting sequential history must be legal.

---

## Worked Examples

### Example 1: A Linearizable History

```
Client A:   |-------- Write(x, 1) --------|
Client B:            |------ Read(x) → 1 ------|
Client C:                         |--- Read(x) → 1 ---|

Time ──────────────────────────────────────────────────▶
         t0    t1    t2    t3    t4    t5    t6    t7
```

Is this linearizable?

**Step 1**: Identify real-time ordering constraints.
- A's Write overlaps with B's Read — no constraint between them
- A's Write finishes before C's Read starts — A must come before C in S
- B's Read overlaps with C's Read — no constraint between them

**Step 2**: Find a legal sequential history that respects these constraints.

One possibility:
```
S: Write(x, 1) → OK,  Read(x) → 1,  Read(x) → 1
         A                  B               C
```

This is legal (both reads return 1, which is the value of the most recent write) and respects real-time order (A before C). 

**This history is linearizable.** ✓

### Example 2: A Non-Linearizable History

```
Client A:   |-------- Write(x, 1) --------|
Client B:            |------ Read(x) → 1 ------|
Client C:                         |--- Read(x) → 0 ---|

Time ──────────────────────────────────────────────────▶
```

x starts at 0. C reads 0 even though A's Write(x, 1) finished before C's Read started.

**Step 1**: Real-time constraints.
- A finishes before C starts → A must precede C in S

**Step 2**: Try to find a legal sequential history.

If A (Write 1) comes before C (Read → 0), then C should read 1, not 0. There's no legal sequential history where a Write(x, 1) precedes a Read(x) → 0 with no intervening write.

**This history is NOT linearizable.** ✗

The problem: C observed a stale value. A's write completed before C's read started, so C must see the effect of A's write. This is exactly the kind of anomaly linearizability forbids.

### Example 3: The Tricky Overlapping Case

```
Client A:   |----------- Write(x, 1) -----------|
Client B:       |----------- Write(x, 2) -----------|
Client C:               |-- Read(x) → 2 --|
Client D:                              |-- Read(x) → 1 --|

Time ──────────────────────────────────────────────────────▶
```

Is this linearizable?

Both writes overlap with both reads. C reads 2, D reads 1. The question is: can we find a legal linearization?

**Try S1**: Write(x,1), Write(x,2), Read(x)→2, Read(x)→1
- D reads 1 but the last write was 2. **Illegal.**

**Try S2**: Write(x,2), Write(x,1), Read(x)→2, Read(x)→1
- C reads 2 but the last write at that point was 2... wait: C reads before D in real time? Actually C and D overlap, so we can reorder them.

**Try S3**: Write(x,2), Read(x)→2, Write(x,1), Read(x)→1
- C reads 2 after Write(x,2). Legal. ✓
- D reads 1 after Write(x,1). Legal. ✓
- Real-time constraints: A and B overlap (OK), C and D overlap (OK), C finishes before D starts... does C finish before D starts? Let's check the diagram: C's response is before D's invocation. So C must come before D in S. In S3, C comes before D. ✓

**This history IS linearizable.** ✓ The linearization is: B writes 2, C reads 2, A writes 1, D reads 1.

### Example 4: New-Old Inversion

```
Client A:   |------- Write(x, 1) -------|
Client B:            |--- Read(x) → 1 ---|
Client C:                 |--- Read(x) → 0 ---|
Client D:                       |--- Read(x) → 1 ---|

Time ──────────────────────────────────────────────────▶
```

x starts at 0. B reads 1, then C reads 0, then D reads 1.

B's Read finishes before C's Read starts? No — B and C overlap, and C and D overlap. But here's the critical constraint: if B and C don't overlap (B ends before C starts), then B must precede C in any linearization. If B sees 1, then C must also see 1 (or a later value). C seeing 0 would be a violation.

But looking at the diagram, B and C actually overlap. So their order in S is flexible. Can we find a legal linearization?

**Try**: Read(x)→0, Write(x,1), Read(x)→1, Read(x)→1

Assign: C reads 0 first, then A writes 1, then B reads 1, then D reads 1.

Check real-time constraints:
- A's Write overlaps with B, C, and D — no hard constraints with any of them
- B overlaps with C — flexible ✓
- C overlaps with D — flexible ✓

This is legal. **Linearizable.** ✓

But if B finishes before C starts (i.e., they don't overlap), this would NOT be linearizable — that's the "new-old inversion" anomaly where a value appears to go backwards in time.

---

## Checking Linearizability Is Hard

Determining whether a given history is linearizable is, in general, an NP-complete problem. The proof was given by Gibbons and Korach (1997). For a history with `n` operations, you might need to try all `n!` possible orderings.

In practice, linearizability checkers like Knossos (used by Jepsen) and the Wing-Gong algorithm use pruning and heuristics to make this tractable for real histories. But the theoretical hardness explains why linearizability testing is computationally expensive.

### The Wing-Gong Algorithm (Simplified)

The basic approach to checking linearizability:

```
function is_linearizable(history H):
    pending = all incomplete operations in H
    for each subset P of pending to complete/discard:
        H' = extend H by completing ops in P, discarding the rest
        for each permutation S of operations in H':
            if S is a legal sequential history AND
               S respects real-time order of H':
                return true
    return false
```

This brute-force approach is exponential. Practical tools like Knossos convert the problem into a graph search: build a graph where nodes are possible states of the object, edges are operations, and search for a path that matches the observed history.

---

## Linearizability vs. Serializability

These two words sound similar and are often confused. They are different properties that operate on different axes.

| Property | Applies To | Guarantees |
|----------|-----------|------------|
| **Linearizability** | Single operations on single objects | Each operation appears to happen atomically at one point in real time |
| **Serializability** | Transactions (groups of operations) | Transactions appear to execute in some serial order |

### The Key Difference

**Linearizability** is a **real-time** guarantee about **individual operations**. It says: the system behaves as if operations execute one at a time, in an order consistent with real time.

**Serializability** is an **ordering** guarantee about **transactions**. It says: the result of executing transactions concurrently is equivalent to some serial execution — but that serial execution doesn't have to respect real time.

### An Example

Consider two transactions:

```
T1: Write(x, 1); Write(y, 1)
T2: Read(x) → ?; Read(y) → ?
```

Under **serializability**, the valid outcomes for T2 are:
- Read(x)→0, Read(y)→0 (T2 runs before T1)
- Read(x)→1, Read(y)→1 (T2 runs after T1)

T2 cannot read x=1, y=0 because that would mean T2 observed a partial transaction.

Under **linearizability** (applied to individual operations), T2 could read x=1, y=0 — because linearizability applies to each operation independently, not to groups of operations. If the Write(x,1) linearized before Read(x) but Write(y,1) hasn't linearized yet when Read(y) executes, this is a valid linearizable history.

### Strict Serializability

The combination of both properties — serializability + linearizability — is called **strict serializability** (or sometimes **linearizable serializability** or **external consistency**, as Google calls it for Spanner). It guarantees:
1. Transactions appear to execute serially
2. The serial order respects real time

This is the strongest isolation level any database can offer, and it's extremely expensive. Spanner achieves it using GPS-synchronized atomic clocks (Chapter 27).

---

## What Linearizability Costs

Linearizability is expensive. Here's why.

### Coordination Is Required

The CALM theorem and Attiya-Welch lower bound establish that linearizability requires **coordination** — nodes must communicate with each other to ensure they agree on the order of operations. You cannot implement a linearizable register in a purely asynchronous system without message exchange.

Specifically, Attiya and Welch (1994) proved that any linearizable implementation of a read/write register in a message-passing system requires at least one round-trip of communication for either reads or writes (or both).

### Latency Impact

For a system with replicas spread across datacenters:

```
Linearizable Write:
  Client → Leader → Replicate to majority → Ack to Client
  
  Minimum latency: RTT(client, leader) + RTT(leader, farthest quorum member)

Non-linearizable Write (e.g., eventual consistency):
  Client → Nearest replica → Ack to Client
  
  Minimum latency: RTT(client, nearest replica)
```

If your leader is in us-east-1 and your client is in eu-west-1 (80ms RTT), and the quorum requires a replica in ap-southeast-1 (another 150ms from the leader), a linearizable write costs at least 80 + 150 = 230ms. An eventually consistent write to the nearest replica might cost 5ms.

### The CAP Trade-off

As we proved in Chapter 20, during a network partition you must choose between:
- **Linearizability** (CP): Refuse operations on the minority side of the partition
- **Availability** (AP): Accept operations on both sides, but lose linearizability

This is not a theoretical concern. Every multi-region deployment that has ever experienced a network partition has faced this choice.

### Throughput Impact

Linearizability limits throughput because:
1. **Writes must be serialized** through a leader (or equivalent coordination mechanism)
2. **Reads must contact the leader** (or use a lease mechanism) to ensure they see the latest write
3. **Cross-datacenter coordination** adds latency, and latency limits throughput under load

A DynamoDB table configured for eventual consistency can serve reads from any replica, scaling horizontally. The same table configured for strong consistency routes reads through the leader, creating a bottleneck.

---

## Systems That Provide Linearizability

### etcd (Raft-based)

etcd uses Raft consensus. All writes go through the Raft leader, which replicates them to a majority of nodes before responding. Reads default to linearizable: they go through the leader, which confirms it's still the leader before responding (the ReadIndex optimization).

```
Linearizable read in etcd:
  1. Client sends Read(key) to leader
  2. Leader sends heartbeat to confirm majority still recognizes it
  3. Leader waits for its state machine to apply up to its committed index
  4. Leader reads from state machine and responds
```

The heartbeat step (2) is essential — without it, a deposed leader might serve stale reads from its local state.

### ZooKeeper (ZAB-based)

ZooKeeper provides linearizable writes: all writes go through the leader, which broadcasts them via the ZAB protocol. However, reads are NOT linearizable by default — they're served from the local replica, which may be stale.

To get linearizable reads, you must use the `sync()` command before the read, which forces the replica to catch up with the leader.

```java
// NOT linearizable — may return stale data
byte[] data = zk.getData("/config", false, null);

// Linearizable — sync forces catch-up
zk.sync("/config");
byte[] data = zk.getData("/config", false, null);
```

This is a common source of bugs. Teams use ZooKeeper for coordination, assume reads are consistent, and get bitten by stale reads from followers.

### Google Spanner

Spanner provides **external consistency** (strict serializability) for all transactions. It achieves linearizable reads without contacting the leader by using TrueTime — GPS and atomic clock–derived timestamps with bounded uncertainty.

A Spanner read at timestamp T is linearizable if the system waits until it's certain that T is in the past (the "commit wait"). See Chapter 27 for the full mechanism.

### CockroachDB

CockroachDB provides serializable isolation with real-time ordering (strict serializability) using a hybrid logical clock scheme inspired by Spanner. It doesn't have GPS clocks, so it uses a different mechanism involving clock uncertainty intervals and read restarts.

---

## Systems That Do NOT Provide Linearizability (by Default)

### Amazon DynamoDB

DynamoDB defaults to **eventually consistent reads**. A read might return stale data if the nearest replica hasn't received the latest write yet. You can request **strongly consistent reads**, which route through the leader, but this doubles the cost (in DynamoDB pricing) and increases latency.

```python
# Eventually consistent (default) — NOT linearizable
response = table.get_item(Key={'id': '123'})

# Strongly consistent — linearizable for single-item reads
response = table.get_item(Key={'id': '123'}, ConsistentRead=True)
```

Even with `ConsistentRead=True`, DynamoDB only provides linearizability for single-item operations. Multi-item transactions use a different protocol.

### Apache Cassandra

Cassandra defaults to eventual consistency. You can tune consistency per query using consistency levels:

```
QUORUM write + QUORUM read → linearizable for single-key operations
  (if W + R > N, where N is the replication factor)

ONE write + ONE read → NOT linearizable
  (you might read from a replica that missed the write)
```

Even with QUORUM, Cassandra doesn't guarantee linearizability in the presence of certain failure modes (e.g., replica disagreements during repair). For true linearizability, Cassandra offers **lightweight transactions** (LWT) using Paxos, but they're 4-10x slower than regular writes.

```sql
-- NOT linearizable (even with QUORUM)
INSERT INTO users (id, name) VALUES (123, 'Alice');

-- Linearizable (uses Paxos internally)
INSERT INTO users (id, name) VALUES (123, 'Alice') IF NOT EXISTS;
```

### PostgreSQL (Single-Node)

A single PostgreSQL instance is trivially linearizable for single operations — there's one machine, one copy of the data, and operations are serialized through the buffer pool. But PostgreSQL streaming replication followers serve stale reads, so a replicated PostgreSQL cluster is not linearizable unless you read from the primary.

### Redis

Single-node Redis is linearizable (it's single-threaded). But Redis Cluster and Redis Sentinel-based replication use asynchronous replication, so reads from replicas are not linearizable. Even reads from the master can be non-linearizable during failover — a new master might be elected before the old master realizes it's been deposed, leading to a brief window where two nodes think they're the master (split-brain).

---

## Linearizability as a Building Block

Linearizability matters not just as a user-facing guarantee but as a primitive for building higher-level abstractions:

### Leader Election

A linearizable compare-and-swap (CAS) register is sufficient to implement leader election:

```
function try_become_leader(node_id):
    success = CAS(leader_key, expected=NONE, new=node_id)
    return success
```

If the CAS is linearizable, at most one node can succeed — because the CAS operations are totally ordered and only the first one finds the register empty.

Without linearizability, two nodes could both read NONE, both attempt the CAS, and both think they won. This is the split-brain problem.

### Distributed Locking

A linearizable register with fencing tokens provides safe distributed locking:

```
function acquire_lock(client_id):
    token = linearizable_increment(fence_counter)
    linearizable_write(lock_register, {holder: client_id, token: token})
    return token

function do_work(token, resource):
    if resource.last_token < token:
        resource.last_token = token
        // proceed with work
    else:
        // someone with a newer token already wrote; abort
```

The fencing token ensures that even if a lock holder is partitioned and a new holder takes the lock, the old holder's writes are rejected by the resource.

### Uniqueness Constraints

Enforcing "no two users can have the same email" across a distributed database requires linearizability on the email index. Without it, two concurrent registrations with the same email could both check "is this email taken?" see "no," and both succeed.

---

## Composability: A Key Property

Linearizability has an important theoretical property: it is **compositional** (also called **local**). If each individual object in a system is linearizable, then the entire system (all objects together) is also linearizable.

This means you can reason about each data item independently. If your linearizable key-value store guarantees linearizability for each key, you automatically get linearizability for the entire store (with respect to single-key operations).

This composability is rare among consistency models. Serializability, for example, is NOT compositional — a system where each partition is independently serializable is not necessarily serializable as a whole.

---

## Common Misconceptions

### "Linearizability means reads always return the latest write"

Close, but imprecise. Linearizability means reads return a value consistent with some total ordering of operations that respects real time. During the duration of a write (between invocation and response), a concurrent read may or may not see the new value — both are valid. The constraint is that once any read sees the new value, all subsequent reads must also see it (or a later value).

### "My system is linearizable because it uses consensus"

Not necessarily. Consensus (Raft, Paxos) provides linearizable writes through the leader. But reads are linearizable only if they go through the leader (or use read leases, ReadIndex, etc.). A common mistake is to direct reads to followers for load balancing, which breaks linearizability.

### "Linearizability and strong consistency are the same thing"

"Strong consistency" is an informal term with no universally agreed-upon definition. Some systems use it to mean linearizability, others use it to mean sequential consistency, and others use it to mean "not eventual consistency." When precision matters, use the formal term.

### "Linearizability is too expensive; nobody uses it"

Every system that uses etcd, ZooKeeper, or Consul for coordination is relying on linearizability. Every SQL database with a single primary provides linearizability for single-row operations. The question is not whether to use linearizability, but where in your architecture to pay for it and where to use weaker models.

---

## Verifying Linearizability in Practice: Jepsen

Kyle Kingsbury's Jepsen framework tests distributed systems for linearizability violations. It works by:

1. **Generating** a random history of operations (reads, writes, CAS)
2. **Executing** those operations against the system under test while injecting faults (network partitions, process kills, clock skew)
3. **Recording** the actual invocations and responses
4. **Checking** whether the recorded history is linearizable using the Knossos checker

Jepsen has found linearizability violations in production systems including:
- **Redis Sentinel** (stale reads during failover)
- **MongoDB** (dirty reads during primary elections with certain write concerns)
- **Cassandra LWT** (violations under specific network partition patterns)
- **RethinkDB** (stale reads from followers)
- **etcd** (historical issues with read-after-write when reading from followers)

The recurring theme: systems that claim linearizability often provide it only under normal conditions and violate it during failures — which is precisely when correctness matters most.

---

## The Spectrum in Practice

Choosing whether to pay for linearizability depends on what you're doing:

| Use Case | Need Linearizability? | Why |
|----------|----------------------|-----|
| Leader election | **Yes** | Two leaders = split brain = data corruption |
| Distributed lock | **Yes** | Two lock holders = concurrent writes to protected resource |
| Unique constraint (e.g., username) | **Yes** | Duplicates may be unrecoverable |
| Bank account balance | **Yes** | Stale read → overdraft |
| Social media feed | **No** | A few seconds of stale posts is acceptable |
| Analytics counters | **No** | Approximate counts are fine |
| Shopping cart | **Depends** | Amazon chose AP (eventual consistency) and merges conflicts |
| User profile page | **Usually no** | Stale profile data for a few seconds is fine |

The engineering judgment is: **use linearizability for coordination and correctness-critical paths; use weaker models for everything else.** Most read traffic in most systems can tolerate eventual consistency. The small fraction that can't — leader election, locks, unique constraints — should use a linearizable store like etcd or ZooKeeper.

---

## Summary

- **Linearizability** means every operation appears to happen atomically at some point between its invocation and response
- Formally: a history is linearizable if it can be mapped to a legal sequential history that preserves real-time ordering
- **Linearization points** mark the "instant" each operation takes effect
- Checking linearizability is **NP-complete** in general (Gibbons & Korach 1997)
- Linearizability ≠ serializability: different axes (single ops vs. transactions, real-time vs. no real-time)
- **Strict serializability** = serializability + linearizability = the strongest possible guarantee
- Linearizability requires coordination → higher latency, lower throughput, unavailability during partitions
- Linearizability is **compositional**: individually linearizable objects compose into a linearizable system
- Use linearizability for **coordination** (locks, elections, unique constraints); use weaker models for read-heavy, latency-sensitive paths
- **Jepsen** verifies linearizability by recording histories under fault injection and checking them algorithmically

---

## References

- Herlihy, M. P., & Wing, J. M. (1990). *Linearizability: A Correctness Condition for Concurrent Objects.* ACM Transactions on Programming Languages and Systems, 12(3), 463–492.
- Attiya, H., & Welch, J. L. (1994). *Sequential Consistency versus Linearizability.* ACM Transactions on Computer Systems, 12(2), 91–122.
- Gibbons, P. B., & Korach, E. (1997). *Testing Shared Memories.* SIAM Journal on Computing, 26(4), 1208–1244.
- Kingsbury, K. (2013–present). *Jepsen: Distributed Systems Safety Analysis.* https://jepsen.io
- Corbett, J. C., et al. (2013). *Spanner: Google's Globally-Distributed Database.* ACM Transactions on Computer Systems, 31(3).

---

**Next**: [Chapter 14 — Storage Engines: B-trees vs LSM Trees →](ch14-storage-engines.md)

**Previous**: [Chapter 12 — The Consistency Model Hierarchy →](ch12-consistency-models.md)
