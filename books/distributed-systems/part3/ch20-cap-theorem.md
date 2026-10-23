# Chapter 20: CAP Theorem — The Proof, Not the Slogan

> *Why can't any distributed system simultaneously guarantee perfect consistency, availability, and partition tolerance — and why is partition tolerance not optional?*

**Prerequisites**: Chapter 12 (Consistency Models), Chapter 13 (Linearizability), Chapter 4 (System Models)

---

## The Most Misunderstood Result in Distributed Systems

If you've read about distributed systems, you've encountered this claim:

> "You can only pick two out of three: Consistency, Availability, Partition Tolerance."

This is usually drawn as a triangle:

```
          Consistency (C)
              /\
             /  \
            /    \
           / pick \
          /  two   \
         /          \
        /____________\
Availability (A)    Partition
                    Tolerance (P)
```

And then systems are categorized:
- **CA**: Traditional single-node RDBMS
- **CP**: ZooKeeper, etcd, Spanner
- **AP**: Dynamo, Cassandra, CouchDB

This framing is **not wrong**, but it's **deeply misleading**. It suggests that "partition tolerance" is an option you can decline, like choosing a feature from a menu. It's not. Partitions are a fact of networked systems — you don't get to opt out.

In this chapter, we'll state the theorem precisely, work through the formal proof, understand what it actually says, and then apply it correctly.

---

## Brewer's Original Conjecture

In 2000, Eric Brewer gave a keynote at the ACM Symposium on Principles of Distributed Computing (PODC) where he conjectured:

> It is impossible for a web service to provide all three of the following guarantees simultaneously: **consistency**, **availability**, and **partition tolerance**.

Brewer stated this informally, drawing from his experience building the Inktomi search engine. He didn't provide a proof. The conjecture was evocative and memorable, and it spread rapidly through the industry.

Two years later, Seth Gilbert and Nancy Lynch published a formal proof, turning the conjecture into a theorem.

---

## Precise Definitions

The CAP theorem is only meaningful when we define its three terms precisely. The informal definitions used in most blog posts are too vague to reason about.

### Consistency (C): Linearizability

In the CAP theorem, "consistency" means **linearizability** — the strongest consistency model we defined in Chapter 13.

Informally: every read returns the most recently written value, as if there were a single copy of the data and all operations happened atomically in some sequential order consistent with real-time ordering.

Formally: for every execution of the system, there exists a total order on all completed operations such that:
1. The order is consistent with the real-time ordering of operations (if op A completes before op B starts, A appears before B in the total order).
2. Every read returns the value written by the most recent preceding write in the total order.

This is a very specific definition. It does *not* mean "the replicas agree eventually" or "the system is not buggy." It means the strongest form of consistency defined in the distributed computing literature.

### Availability (A): Every Non-Faulty Node Responds

A system is **available** if every request sent to a non-faulty node in the system eventually receives a response.

Key details:
- "Every request" — not just most requests, not 99.9%, literally every single one
- "Non-faulty node" — we're talking about nodes that haven't crashed
- "Eventually receives a response" — the response may take a long time, but it must come. There is no timeout.
- **The response must be meaningful** — it can't just say "error" or "try later." It must contain a valid result.

This is a very strong definition. It means that even during a network partition, if a client can reach any alive node, that node must respond with a real answer.

### Partition Tolerance (P): The Network Can Lose Messages

A system is **partition tolerant** if it continues to operate correctly despite arbitrary message loss between nodes.

A **network partition** is a situation where the network is divided into two or more groups, and messages between groups are lost:

```
  ┌─────────────┐          ┌─────────────┐
  │  Group 1    │    ✗✗✗   │  Group 2    │
  │  Node A     │──────────│  Node C     │
  │  Node B     │  messages│  Node D     │
  │             │  dropped │             │
  └─────────────┘          └─────────────┘
```

Partition tolerance means: the system's correctness guarantees hold even when the network does this. Messages within each group are delivered normally; messages between groups are lost.

---

## The Proof: Why You Can't Have All Three

Gilbert and Lynch's proof is elegant and surprisingly simple. It works by contradiction.

### Setup

Consider the simplest possible distributed system:
- Two nodes, **G1** and **G2**
- They replicate a single register `x` (initially `x = v0`)
- Clients can read or write `x` by contacting either node

```
     Client 1                          Client 2
        │                                  │
        ▼                                  ▼
   ┌─────────┐                       ┌─────────┐
   │   G1    │◄──── network link ────▶│   G2    │
   │  x = v0 │                       │  x = v0 │
   └─────────┘                       └─────────┘
```

### Assume for Contradiction

Assume there exists an algorithm that provides all three guarantees:
- **C**: Linearizability
- **A**: Every request to a non-faulty node gets a response
- **P**: Works correctly during network partitions

### The Partition

Now introduce a network partition. G1 and G2 cannot communicate:

```
   ┌─────────┐          ✗          ┌─────────┐
   │   G1    │ ─ ─ ─ ─ ─ ─ ─ ─ ─ │   G2    │
   │  x = v0 │   (all messages    │  x = v0 │
   └─────────┘    dropped)         └─────────┘
```

### The Write

Client 1 sends a write request to G1: `write(x, v1)`.

By our **availability** assumption, G1 must respond to this request. G1 cannot contact G2 (the partition prevents it). So G1 must respond without coordinating with G2.

G1 updates its local copy: `x = v1`. It responds "OK" to Client 1.

```
   Client 1: write(x, v1) ──▶ G1
   G1: x = v1 (updated locally)
   G1: "OK" ──▶ Client 1

   ┌─────────┐          ✗          ┌─────────┐
   │   G1    │ ─ ─ ─ ─ ─ ─ ─ ─ ─ │   G2    │
   │  x = v1 │   (partition)       │  x = v0 │
   └─────────┘                     └─────────┘
```

### The Read

Now Client 2 sends a read request to G2: `read(x)`.

By our **availability** assumption, G2 must respond to this request. G2 cannot contact G1 (the partition prevents it). So G2 must respond based on its local state.

G2's local copy still says `x = v0`. G2 returns `v0` to Client 2.

```
   Client 2: read(x) ──▶ G2
   G2: returns v0 ──▶ Client 2
```

### The Contradiction

Now examine the history of operations:

1. Client 1 wrote `x = v1` and received acknowledgment
2. Client 2 read `x` and got `v0`

For **linearizability**, Client 2's read must return `v1` (or a later value), because:
- The write completed (Client 1 received "OK")
- The read started after the write completed (or, in the general case, the system must permit a linearization where the write precedes the read if they are concurrent)

But G2 returned `v0`, which is the *old* value. This violates linearizability.

**Contradiction.** Our assumption that we can have C, A, and P simultaneously must be false. ∎

### Why This Proof Is Airtight

The proof makes no assumptions about the algorithm. It doesn't matter how clever your replication protocol is. The fundamental issue is:

1. During a partition, G1 and G2 can't communicate.
2. Availability requires both to respond.
3. If both respond without coordinating, they can return inconsistent values.
4. Returning inconsistent values violates linearizability.

No amount of algorithmic cleverness can solve this. It's not a matter of being "smart enough." The impossibility is inherent in the network model.

---

## Why Partition Tolerance Is Not Optional

The "pick two" framing suggests you can choose CA (consistency + availability without partition tolerance). This is misleading for a fundamental reason:

**Network partitions happen in real systems. You don't get to choose.**

Peter Bailis and others have argued this point clearly:

> A CA system is one that says "we'll provide consistency and availability as long as no messages are ever lost." In a networked system, this is an assumption you cannot make.

Consider what a "CA" system would mean:
- It provides linearizability and availability
- But if a network partition occurs, all bets are off — the system may return wrong answers, hang forever, or crash

This isn't a useful guarantee. Real systems experience network partitions — switches fail, cables are cut, cloud regions lose connectivity. A system that only works when the network is perfect is like a bridge that only supports weight on days without wind.

What "CA" actually means in practice:
- **Single-node databases** (PostgreSQL on one machine): These are trivially CA because there's no network between replicas. But they're also not distributed, so the CAP theorem doesn't apply.
- **Systems that sacrifice liveness during partitions**: They stop accepting requests (becoming unavailable) rather than risking inconsistency. These are actually **CP** systems, not CA.

The real choice is: **During a network partition, do you sacrifice consistency or availability?**

```
                    Network partition occurs
                            │
                   ┌────────┴────────┐
                   │                 │
            Sacrifice C         Sacrifice A
            (stay available      (stop responding
             but return           until partition
             stale data)          heals)
                   │                 │
                   ▼                 ▼
              AP system          CP system
           (Dynamo, Cassandra)  (ZooKeeper, etcd, Spanner)
```

---

## The Theorem Applied to Real Systems

### CP Systems: Sacrifice Availability During Partitions

**ZooKeeper/etcd**: During a partition, nodes on the minority side of the partition stop serving requests. A ZooKeeper cluster of 5 nodes, partitioned 3-2, will have the group of 3 continue operating (majority quorum) while the group of 2 rejects all reads and writes.

```
Partition:
  ┌──────────────┐          ┌──────────────┐
  │  Group of 3  │    ✗     │  Group of 2  │
  │  (majority)  │──────────│  (minority)  │
  │  AVAILABLE   │          │  UNAVAILABLE │
  │  CONSISTENT  │          │  rejects all │
  └──────────────┘          └──────────────┘
```

Clients connected to the minority side see the system as unavailable. This is the consistency-over-availability trade-off.

**Spanner**: Google Spanner provides linearizability across globally distributed data. During a partition, Spanner will make partitioned Paxos groups unavailable rather than serve stale reads. Spanner bets that its private network (with redundant fiber paths, controlled switches, and hardware-level monitoring) will experience partitions rarely enough that the availability sacrifice is acceptable.

### AP Systems: Sacrifice Consistency During Partitions

**Dynamo/Cassandra**: During a partition, every node continues serving reads and writes. If a write goes to one side of the partition and a read to the other, the read may return stale data. Dynamo uses vector clocks and read-repair to eventually reconcile divergent replicas, but during the partition, consistency is not guaranteed.

```
Partition:
  ┌──────────────┐          ┌──────────────┐
  │  Group 1     │    ✗     │  Group 2     │
  │  write(x=1)  │──────────│  read(x)=0   │
  │  AVAILABLE   │          │  AVAILABLE   │
  │  INCONSISTENT│          │  INCONSISTENT│
  └──────────────┘          └──────────────┘
```

Both sides serve requests, but they may disagree. After the partition heals, anti-entropy and read-repair will synchronize the replicas.

**DNS**: The Domain Name System is one of the most successful AP systems ever built. DNS caches have TTLs, and during a partition, resolvers serve cached (possibly stale) records rather than failing. Almost all internet systems prefer a possibly-stale DNS answer to no answer at all.

### Neither Purely CP Nor AP

Many real systems don't fit neatly into CP or AP:

**MongoDB**: With default settings (majority read concern, majority write concern), MongoDB is CP — writes require a majority and reads from the primary. But with weaker read/write concerns, it can behave like an AP system. The CAP classification depends on the configuration.

**CockroachDB**: Provides serializable transactions (CP) but allows stale reads with `AS OF SYSTEM TIME`, trading consistency for availability on a per-query basis.

The lesson: **CAP is not a permanent system classification. It's a per-operation trade-off.**

---

## Beyond CAP: The PACELC Framework

In 2012, Daniel Abadi argued that CAP focuses only on the partition case, missing an equally important trade-off that systems make during normal operation.

### The PACELC Model

```
if (Partition) {
    choose between Availability and Consistency  → "PA" or "PC"
} else {
    choose between Latency and Consistency       → "EL" or "EC"
}
```

**PACELC** stands for: **P**artition → **A**vailability/**C**onsistency, **E**lse → **L**atency/**C**onsistency.

The key insight: even when the network is healthy (no partition), there's a trade-off between latency and consistency. Coordinating replicas takes time. A system can be:
- **Fast but weakly consistent** (serve reads from any replica without checking)
- **Slow but strongly consistent** (coordinate across replicas before responding)

### System Classifications Under PACELC

| System | During Partition (PA/PC) | Normal Operation (EL/EC) | Full Classification |
|--------|-------------------------|--------------------------|---------------------|
| Dynamo/Cassandra | PA (stay available) | EL (low latency, eventual consistency) | PA/EL |
| Spanner | PC (sacrifice availability) | EC (coordinate for consistency) | PC/EC |
| PNUTS (Yahoo!) | PC (sacrifice availability) | EL (low latency reads from local replica) | PC/EL |
| MongoDB (default) | PC (sacrifice availability) | EC (read from primary) | PC/EC |

The most interesting quadrant is **PC/EL**: systems that sacrifice availability during partitions (they want consistency) but sacrifice consistency during normal operation (they want low latency). This seems contradictory — why care about consistency during partitions but not during normal operation? The answer is often that the system provides weaker-than-linearizable consistency (like read-your-writes or causal consistency) during normal operation, which is "good enough" for most use cases, and only needs to make the hard choice during actual partitions.

---

## What CAP Does NOT Say

The theorem is precise, but it's often invoked to justify claims it doesn't support.

### Misconception 1: "We Chose AP, So Our System Is Always Inconsistent"

CAP says you can't have *linearizability* during a *partition*. Outside of partitions, an AP system can be perfectly consistent. Cassandra with quorum reads and writes (R + W > N) provides strong consistency when no partition exists. The AP label describes behavior during the exceptional case (partition), not the normal case.

### Misconception 2: "CAP Means You Only Get Two"

CAP says you can't have all three *simultaneously during a partition*. In practice:
- Partitions are rare (seconds to minutes per year in well-operated systems)
- During normal operation, you can have consistency, availability, AND low latency
- The trade-off only matters during the partition window

### Misconception 3: "Consistency Means All Replicas Are Identical"

In CAP, consistency means **linearizability** — a specific property about how operations appear to clients. It does not mean "all replicas have the same data at the same time" (that's an implementation detail, not a correctness guarantee).

### Misconception 4: "Eventual Consistency Is Essentially Broken"

Eventual consistency is a deliberate, well-defined guarantee: if no new writes occur, all replicas will eventually converge to the same value. Many enormously successful systems (DNS, CDNs, Dynamo-style databases) provide eventual consistency. It's not a bug — it's a trade-off that enables availability and low latency.

For many workloads, eventual consistency is the right choice. A social media feed doesn't need linearizability. A shopping cart doesn't need it either (Amazon's Dynamo paper proved this). Consistency requirements should be driven by the application, not by theoretical aesthetics.

### Misconception 5: "Partition Tolerance Means Surviving Network Failures"

Partition tolerance in CAP has a specific meaning: the system continues to satisfy its other guarantees (C or A) during a partition. A CP system is partition-tolerant — it handles partitions by becoming unavailable. An AP system is partition-tolerant — it handles partitions by becoming inconsistent. Both are "surviving" the partition, just in different ways.

---

## The Formal Model: Asynchronous Networks

Gilbert and Lynch's proof operates in the **asynchronous network model** (Chapter 4): there is no upper bound on message delivery time. A message may take 1ms or 1 year.

This matters because in an asynchronous model, you can't distinguish a dead node from a slow one (Chapter 7). A node that hasn't responded might be:
1. Crashed (and will never respond)
2. Slow (and will respond eventually)
3. On the other side of a partition (and messages are being dropped)

The proof exploits this ambiguity. When G1 can't reach G2, it doesn't know whether G2 is crashed or partitioned. If it waits indefinitely, it violates availability. If it responds without G2, it risks violating consistency.

### What About Synchronous Systems?

In a **synchronous system** with a known upper bound on message delay, you can implement a perfect failure detector (Chapter 7). You can tell the difference between "dead" and "slow" by waiting the maximum delay. This makes it possible to provide both C and A — as long as the timing assumptions hold.

But real networks are not synchronous. Message delays have no hard upper bound. TCP retransmit timers, congestion, routing changes, and queue buildup all introduce unpredictable delays. The asynchronous model is the correct abstraction for real networks.

---

## The Harvest-Yield Model

In 1999 (before the formal CAP proof), Brewer and Fox proposed an alternative framing: **harvest** and **yield**.

- **Harvest**: the fraction of data reflected in the response (completeness)
- **Yield**: the fraction of requests that get a response (availability)

Instead of a binary C/A trade-off, harvest and yield allow continuous degradation:

```
                    High Harvest
                    (complete data)
                         │
                         │
    "Give me all data    │    "Give me all data
     and I'll always     │     but I might be
     respond"            │     slow or offline"
                         │
        AP systems       │       CP systems
                         │
   ──────────────────────┼────────────────────── 
                         │
     "I'll respond       │    "I'll respond with
      but maybe with     │     complete data or
      partial data"      │     not at all"
                         │
     High Yield ─────────┘
     (always responds)
```

Example: a search engine during a partition might return results from only 90% of its index (reduced harvest) rather than failing entirely (reduced yield). This is neither pure CP nor pure AP — it's a nuanced degradation.

Google Search does exactly this. If a cluster of index servers is unreachable, Google returns results from the available servers (with slightly lower quality) rather than showing an error page. The user gets *some* results — just not all of them.

---

## Practical Decision Framework

When designing a distributed system, use this framework instead of blindly picking "CP" or "AP":

### Step 1: Identify the Actual Consistency Requirement

Ask: "What bad thing happens if a client reads stale data?"

- **Bank balance**: Customer might overdraw. Strong consistency required.
- **Social media feed**: User sees a post 2 seconds late. Eventual consistency is fine.
- **Shopping cart**: Items might appear/disappear during a partition. Eventual consistency with merge is fine (Dynamo proved this).
- **Leader election**: Two leaders could issue conflicting commands. Strong consistency required.

### Step 2: Identify the Availability Requirement

Ask: "What bad thing happens if a node can't respond?"

- **Payment processing**: Revenue stops. High availability required.
- **Config service for 1000 microservices**: Everything stops. High availability required.
- **Analytics pipeline**: Results are delayed by minutes. Brief unavailability is acceptable.
- **Audit log**: Better to queue writes and retry. Brief unavailability is acceptable.

### Step 3: Design for the Partition

Ask: "When a partition happens, which is worse: stale data or downtime?"

- If stale data is unacceptable → CP (sacrifice availability during partition)
- If downtime is unacceptable → AP (sacrifice consistency during partition)
- If both are bad → CP with aggressive timeout and fast failover, minimizing the unavailability window

### Step 4: Consider the Normal Case (PACELC)

Ask: "During normal operation, do I want the lowest latency or the strongest consistency?"

- Low latency → Read from any replica (eventual/causal consistency)
- Strong consistency → Read from leader or quorum (higher latency)

---

## A Worked Example: Two Designs for a Shopping Cart

### Design 1: CP Shopping Cart

```
                    ┌─────────────┐
  Client ──write───▶│   Leader    │──replicate──▶ Follower 1
                    │  (Region A) │──replicate──▶ Follower 2
  Client ──read────▶│             │
                    └─────────────┘
```

- Writes go to the leader; leader replicates to a majority before acknowledging
- Reads go to the leader for linearizable reads
- During a partition between regions: clients in the minority partition can't reach the leader → **unavailable**
- Pro: Cart always shows correct items
- Con: During partition, users can't modify their cart

### Design 2: AP Shopping Cart (Dynamo-Style)

```
  ┌──────────┐     ┌──────────┐     ┌──────────┐
  │  Node A  │◄───▶│  Node B  │◄───▶│  Node C  │
  │ (Region) │     │ (Region) │     │ (Region) │
  └──────────┘     └──────────┘     └──────────┘
       ▲                                  ▲
       │                                  │
    Client 1                          Client 2
```

- Any node accepts reads and writes
- During a partition: both sides continue operating → **available**
- But: Client 1 adds item X on Node A, Client 2 adds item Y on Node C → conflict
- Resolution: On read, merge both versions (set union) → cart has both X and Y
- Pro: Cart always works, even during partitions
- Con: During partition, cart might show slightly stale state

Amazon chose Design 2 for their actual shopping cart. Their reasoning: a customer who can't modify their cart might leave the site (lost revenue). A customer who sees a slightly stale cart will simply refresh. The business cost of unavailability exceeds the business cost of temporary inconsistency.

---

## Relationship to Other Impossibility Results

CAP is one of several impossibility results in distributed computing:

| Result | Says You Can't Have | Key Trade-off |
|--------|-------------------|----------------|
| CAP (Gilbert & Lynch, 2002) | Consistency + Availability + Partition Tolerance | C vs A during partitions |
| FLP (Fischer, Lynch, Paterson, 1985) | Consensus + Asynchrony + One Failure | Safety vs liveness (Ch 21) |
| Two Generals (1975) | Perfect agreement over unreliable channel | No finite protocol achieves certainty (Ch 5) |

These results are related but distinct:
- **CAP** is about *data storage* (read/write registers)
- **FLP** is about *agreement* (consensus)
- **Two Generals** is about *coordination* (a specific form of consensus)

All three stem from the same root cause: in an asynchronous network, you can't tell dead from slow, and you can't force two nodes to agree without communication.

---

## Key Takeaways

1. **CAP is a theorem about trade-offs during network partitions.** During normal operation, you can have consistency, availability, and low latency simultaneously.

2. **Partition tolerance is not a choice.** Partitions happen in real networks. The real question is: during a partition, do you sacrifice consistency or availability?

3. **"Consistency" in CAP means linearizability** — the strongest form. Weaker consistency models (causal, eventual) can coexist with availability during partitions.

4. **PACELC extends CAP** to cover the normal case: even without partitions, there's a trade-off between latency and consistency.

5. **The decision is per-operation, not per-system.** A single system can provide strong consistency for some operations (e.g., payment) and eventual consistency for others (e.g., user profile reads).

6. **The correct choice depends on the business problem.** There is no universally "right" answer. Amazon chose availability for shopping carts. Banks choose consistency for account balances. Both are correct for their context.

---

## References

- Brewer, E. (2000). *Towards Robust Distributed Systems.* PODC Keynote.
- Gilbert, S., & Lynch, N. (2002). *Brewer's Conjecture and the Feasibility of Consistent, Available, Partition-Tolerant Web Services.* ACM SIGACT News.
- Gilbert, S., & Lynch, N. (2012). *Perspectives on the CAP Theorem.* IEEE Computer.
- Abadi, D. (2012). *Consistency Tradeoffs in Modern Distributed Database System Design.* IEEE Computer. (PACELC)
- Brewer, E. (2012). *CAP Twelve Years Later: How the "Rules" Have Changed.* IEEE Computer.
- Bailis, P., & Ghodsi, A. (2013). *Eventual Consistency Today: Limitations, Extensions, and Beyond.* ACM Queue.
- Fox, A., & Brewer, E. (1999). *Harvest, Yield, and Scalable Tolerant Systems.* HotOS.
- DeCandia, G., et al. (2007). *Dynamo: Amazon's Highly Available Key-Value Store.* SOSP. (AP design rationale)

---

**Next**: [Chapter 21 — FLP Impossibility →](ch21-flp-impossibility.md)
