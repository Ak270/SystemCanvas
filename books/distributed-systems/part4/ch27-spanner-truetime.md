# Chapter 27: Spanner's TrueTime and External Consistency

> **Core question**: How does Google commit a read-write transaction across datacenters on different continents with a guarantee stronger than serializable?

## Prerequisites

- Chapter 12 (Consistency Model Hierarchy)
- Chapter 13 (Linearizability)
- Chapter 22 (Raft / Paxos consensus basics)
- Chapter 25 (Serializability vs Linearizability)
- Chapter 26 (Two-Phase Commit)

---

## The Problem: Global Transactions Need a Global Clock

Imagine you run a banking system with data sharded across three continents — a customer table in Virginia, an accounts table in London, and a transactions table in Singapore. A wire transfer must atomically debit one account and credit another, both of which may live on different shards in different datacenters.

You already know from Chapter 26 that two-phase commit (2PC) can coordinate this. But 2PC only gives you *serializability* — the transactions behave as if they executed in some serial order. It does not guarantee that the serial order matches *real time*.

Consider this scenario:

```
Real-time order:
  T1: Transfer $100 from Alice to Bob    (commits at real time 10:00:00.000)
  T2: Read Alice's balance               (starts  at real time 10:00:00.001)

Serializability allows:
  Serial order: T2, T1
  T2 reads Alice's OLD balance (before the transfer)
  This is serializable — but violates real-time expectations
```

A user who sees the transfer confirmation at 10:00:00.000 and immediately reads the balance at 10:00:00.001 expects to see the new balance. Serializability doesn't guarantee this.

What we want is **external consistency** (also called **strict serializability** or **linearizable serializability**): if transaction T1 commits before transaction T2 starts in real time, then T1 must appear before T2 in the serial order. This is serializability *plus* a real-time ordering constraint — the intersection of serializability and linearizability.

The challenge: to enforce a real-time ordering, you need to know real time. And as Chapter 9 established, clocks across machines disagree.

---

## The TrueTime API

Spanner's insight is deceptively simple: **don't pretend clocks are perfect — quantify how wrong they might be**.

Every Google datacenter contains a mix of GPS receivers and atomic clocks (cesium and rubidium oscillators). A daemon called `timeslave` on each machine polls multiple time masters and computes a *confidence interval* for the current time.

The TrueTime API exposes three functions:

| Method | Returns | Meaning |
|--------|---------|---------|
| `TT.now()` | `TTinterval: [earliest, latest]` | The current real time is somewhere in this interval |
| `TT.after(t)` | `bool` | True if `t` is definitely in the past |
| `TT.before(t)` | `bool` | True if `t` is definitely in the future |

The interval `[earliest, latest]` represents clock uncertainty. The width of this interval is called **ε** (epsilon). In Google's production environment:

```
Average ε:  ~4 ms
99th percentile ε:  ~7 ms
Worst case (GPS outage, relying on atomic clock drift only):  ~200 ms (degrades over hours)
```

The critical guarantee: **the real time is always within the interval**. If `TT.now()` returns `[100, 107]`, the actual time is guaranteed to be between 100ms and 107ms. This is not a statistical estimate — it is a hard bound maintained by the combination of GPS synchronization and atomic clock drift rates.

```
Time ──────────────────────────────────────────▶

Machine A's TT.now():    [────────]
                         earliest  latest
                              ▲
                         real time is somewhere in here

Machine B's TT.now():       [────────]
                            earliest  latest
                                 ▲
                            real time is somewhere in here

The intervals may overlap, but real time is inside both.
```

### Why Two Clock Sources?

GPS receivers and atomic clocks have *uncorrelated* failure modes:

- **GPS** can fail from antenna obstruction, jamming, spoofing, or satellite issues. When GPS works, it provides time accurate to ~1μs.
- **Atomic clocks** drift over time (rubidium: ~2 × 10⁻⁸ drift rate, meaning ~1.7ms/day), but they never suddenly jump. They are immune to GPS failures.

Each datacenter has multiple time masters. Some are GPS-based ("GPS masters"), others are atomic-clock-based ("Armageddon masters" — named because they're the fallback for a GPS apocalypse). A machine's `timeslave` daemon polls several of each and uses Marzullo's algorithm to compute the tightest interval consistent with the majority of sources. A reference that disagrees with the majority is treated as a liar and discarded.

```
┌─────────────────────────────────────────────┐
│              Datacenter                      │
│                                              │
│  ┌────────┐  ┌────────┐  ┌─────────────┐   │
│  │  GPS   │  │  GPS   │  │   Atomic    │   │
│  │ Master │  │ Master │  │Clock Master │   │
│  └───┬────┘  └───┬────┘  └──────┬──────┘   │
│      │           │               │          │
│      └───────────┴───────┬───────┘          │
│                          │                  │
│                    ┌─────┴─────┐            │
│                    │ timeslave │            │
│                    │ (on each  │            │
│                    │  machine) │            │
│                    └─────┬─────┘            │
│                          │                  │
│                    TT.now() API             │
└─────────────────────────────────────────────┘
```

---

## Spanner's Architecture

Before diving into the commit protocol, let's understand how Spanner organizes data.

### Spanservers and Paxos Groups

Data is divided into **tablets** — contiguous ranges of rows keyed by `(table, primary_key)`. Each tablet is replicated across datacenters using a **Paxos group** (Spanner uses Multi-Paxos, which is similar to Raft in its leader-based steady state).

```
┌─────────────────────────────────────────────────────────┐
│                     Spanner Universe                     │
│                                                          │
│  Zone (Virginia)     Zone (London)      Zone (Singapore) │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐ │
│  │ Spanserver   │   │ Spanserver   │   │ Spanserver   │ │
│  │  Tablet A    │   │  Tablet A    │   │  Tablet A    │ │
│  │  (leader)    │◄──┤  (replica)   │──▶│  (replica)   │ │
│  │              │   │              │   │              │ │
│  │  Tablet B    │   │  Tablet B    │   │  Tablet B    │ │
│  │  (replica)   │──▶│  (leader)    │◄──│  (replica)   │ │
│  └──────────────┘   └──────────────┘   └──────────────┘ │
│                                                          │
│  Each tablet is replicated by a Paxos group              │
│  Leaders are spread across zones for load balancing      │
└─────────────────────────────────────────────────────────┘
```

Each Paxos group has a **leader** with a **leader lease** (typically 10 seconds). The leader is the only replica that can serve reads and coordinate writes. Leaders for different tablets are spread across zones to balance load.

### Transaction Types

Spanner supports three types:

| Type | Locks | 2PC | Use Case |
|------|-------|-----|----------|
| Read-write transaction | Yes | Yes (if multi-shard) | Transfers, updates |
| Read-only transaction | No | No | Dashboards, reports |
| Snapshot read | No | No | Time-travel queries |

The magic of Spanner is that read-only transactions — which are the vast majority of traffic in many workloads — require *no locks and no 2PC*.

---

## The Commit Protocol for Read-Write Transactions

### Single-Shard Transactions

When a read-write transaction touches only one Paxos group:

1. The client acquires read and write locks at the leader.
2. The client performs reads and buffers writes.
3. On commit, the leader:
   a. Chooses a commit timestamp `s` such that `s ≥ TT.now().latest` (the latest possible current time).
   b. Replicates the write through Paxos (majority of replicas must acknowledge).
   c. **Waits until `TT.after(s)` returns true** — this is the **commit wait**.
   d. Releases locks and replies to the client.

The commit wait is the key step. Let's see why.

### Why Commit Wait Guarantees External Consistency

The commit wait ensures that the commit timestamp `s` is in the past (in real time) before the transaction becomes visible. Here's the formal argument:

**Claim**: If T1 commits before T2 starts (in real time), then T1's commit timestamp s1 < T2's commit timestamp s2.

**Proof**:

```
Let s1 = T1's commit timestamp
Let s2 = T2's commit timestamp

By the commit-wait rule:
  T1's commit is visible only after TT.after(s1) = true
  This means: real time at T1 visibility > s1

By the timestamp assignment rule:
  s2 ≥ TT.now().latest at T2's commit
  TT.now().latest ≥ real time at T2's commit (by TrueTime guarantee)
  T2's commit ≥ T2's start ≥ T1's visibility (by "T1 commits before T2 starts")

Chaining the inequalities:
  s2 ≥ real time at T2's commit ≥ real time at T2's start
     ≥ real time at T1's visibility > s1

Therefore s1 < s2.  ∎
```

```
Timeline (real time):

T1:  [====== execute ======]──commit──[wait]──visible
                                  s1         ▲
                                             │
                                    TT.after(s1) = true
                                             │
T2:                                          └──[start]──[====]──commit──[wait]──visible
                                                                    s2

Since T2 starts after T1 is visible, and s2 ≥ real time at T2's commit:
  s2 > s1    (guaranteed)
```

The commit wait adds latency equal to the uncertainty interval ε (typically 7ms at the 99th percentile). This is Google's fundamental trade-off: **real-time ordering at the cost of a few milliseconds of latency per write**.

### Multi-Shard Transactions (2PC Over Paxos)

When a transaction spans multiple Paxos groups (e.g., debiting an account on Tablet A and crediting one on Tablet B), Spanner runs 2PC where each participant is a Paxos group:

```
                    ┌───────────────────┐
                    │  Coordinator      │
                    │  (Paxos Leader    │
                    │   of one shard)   │
                    └────────┬──────────┘
                             │
                    ┌────────┴──────────┐
                    │                   │
              ┌─────┴─────┐      ┌─────┴─────┐
              │Participant│      │Participant│
              │ Paxos     │      │ Paxos     │
              │ Group A   │      │ Group B   │
              └───────────┘      └───────────┘
```

The protocol proceeds as follows:

**Phase 1: Prepare**

1. Client sends buffered writes to each participant leader.
2. Each participant leader:
   - Acquires write locks.
   - Chooses a **prepare timestamp** (the latest time it can guarantee the data hasn't changed): `prepare_ts = TT.now().latest`.
   - Logs the prepare record via Paxos (this makes the prepare durable).
   - Returns `prepare_ts` to the coordinator.

**Phase 2: Commit**

3. The coordinator:
   - Receives all prepare timestamps.
   - Chooses a commit timestamp: `s = max(all prepare_ts values, TT.now().latest)`.
   - **Waits until `TT.after(s)` returns true** (commit wait).
   - Logs the commit decision via its own Paxos group.
   - Sends the commit timestamp to all participants.

4. Each participant:
   - Applies the write at timestamp `s`.
   - Logs the commit via Paxos.
   - Releases locks.

### Fault Tolerance of 2PC Over Paxos

Traditional 2PC has the blocking problem (Chapter 26): if the coordinator crashes after participants vote YES, participants are stuck. Spanner eliminates this by replicating the coordinator through Paxos:

- If the coordinator leader crashes, a new leader is elected from the Paxos group. The new leader reads the commit/abort decision from the Paxos log and continues the protocol.
- If a participant leader crashes, its Paxos group elects a new leader that can read the prepare record from the log.

The prepare and commit decisions are replicated *before* they take effect. There is no in-doubt state because the Paxos log is always available (as long as a majority of replicas survive).

```
Traditional 2PC:
  Coordinator crash after prepare → participants BLOCKED (Ch 26)

Spanner's 2PC over Paxos:
  Coordinator leader crash → Paxos elects new leader
  New leader reads decision from replicated log → continues protocol
  No blocking (availability of Paxos group, not a single node)
```

---

## Read-Only Transactions: The Performance Win

The majority of database traffic is reads. Spanner's greatest trick is making read-only transactions cheap:

1. **No locks** — a read-only transaction never acquires any locks, so it never blocks or is blocked by writes.
2. **No 2PC** — even if the read spans multiple shards, there is no coordination.
3. **Any replica can serve reads** — not just the leader.

How? By reading at a timestamp.

### The Snapshot Read Protocol

Every Spanner write is tagged with a commit timestamp. Every replica maintains a **multi-version** store — it keeps all versions of each row, indexed by timestamp.

A read-only transaction proceeds:

1. **Choose a read timestamp** `t_read`:
   - If the client wants the freshest data: `t_read = TT.now().latest`.
   - If the client is OK with slightly stale data: `t_read` can be any past timestamp.

2. **At each shard**, read the version of each row with the largest timestamp ≤ `t_read`.

3. **Wait for safe time**: each replica maintains a `safe_time` — the timestamp below which all writes are complete. If `t_read > safe_time` for a replica, the read must wait until writes at timestamps ≤ `t_read` have been applied. (For Paxos leaders, `safe_time` is updated as writes are committed. For replicas, it is communicated via Paxos heartbeats.)

```
Multi-version store at a replica:

Key: "Alice_balance"
  ts=100 → $1000
  ts=150 → $900     ← write from T1 (transfer out $100)
  ts=200 → $950     ← write from T3 (deposit $50)

Read-only transaction at t_read=175:
  Reads version at ts=150 → $900
  (Sees T1's write, does not see T3's write)
  Consistent snapshot at a point in time!
```

Since every transaction's commit timestamp respects external consistency (guaranteed by commit wait), the snapshot read sees a *consistent* view of the database at `t_read`. Transactions committed before `t_read` are visible; those committed after are not.

This is extraordinarily powerful: a read-only transaction scanning petabytes across hundreds of shards and datacenters reads a consistent snapshot *without any locking or coordination*.

### Why Replicas Can Serve Reads

In most replicated databases, only the leader can serve reads (to guarantee linearizability). In Spanner, any sufficiently up-to-date replica can serve a snapshot read because:

1. The commit timestamp is assigned by the leader and replicated via Paxos.
2. The replica knows that once its Paxos state includes all entries up to timestamp `t`, it has all writes with timestamps ≤ `t`.
3. The `safe_time` mechanism ensures the replica waits if it hasn't caught up.

This means read-heavy workloads can be served by replicas geographically close to the reader, even if the leader is on another continent.

---

## Timestamp Ordering: The Full Picture

Spanner maintains several invariants around timestamps:

### Invariant 1: Disjointness

Leader leases are organized so that for any Paxos group, leader lease intervals do not overlap across different leaders. This prevents two leaders from assigning timestamps in the same interval.

### Invariant 2: Monotonicity

A Paxos leader assigns monotonically increasing timestamps. If the leader assigns timestamp `s1` to T1 and later assigns `s2` to T2, then `s1 < s2`.

### Invariant 3: External Consistency (Start-Commit Ordering)

For any two transactions T1 and T2, if T1's commit is visible before T2 starts (in real time), then `s1 < s2`. This is the commit-wait guarantee.

### Invariant 4: Read Freshness

A read at timestamp `t_read` sees all transactions committed with timestamps ≤ `t_read` and none committed with timestamps > `t_read`.

Together, these invariants mean Spanner provides **external consistency** — the strongest consistency guarantee a distributed database can offer. It combines linearizability (real-time ordering) with serializability (transaction isolation) into a single guarantee.

---

## Schema Design and Interleaved Tables

Spanner's data model is relational (SQL), but with a twist: **interleaved tables**. You can declare that a child table's rows are physically co-located with their parent row:

```sql
CREATE TABLE Users (
  UserId   INT64 NOT NULL,
  Name     STRING(100),
) PRIMARY KEY (UserId);

CREATE TABLE Orders (
  UserId   INT64 NOT NULL,
  OrderId  INT64 NOT NULL,
  Total    FLOAT64,
) PRIMARY KEY (UserId, OrderId),
  INTERLEAVE IN PARENT Users ON DELETE CASCADE;
```

Rows for `Orders` with `UserId=42` are stored in the same split (and therefore the same Paxos group) as the `Users` row with `UserId=42`. This means a transaction that reads a user and their orders touches only *one* Paxos group — making it a single-shard transaction with no 2PC overhead.

This is a physical optimization, not a logical one. The data model is still fully relational, but the storage layout is tuned for access patterns.

---

## Practical Considerations

### What Does Commit Wait Actually Cost?

The commit wait adds ε (the uncertainty interval) to every write transaction's latency. In practice:

| Scenario | ε (typical) | Impact |
|----------|-------------|--------|
| Same datacenter, GPS healthy | 1–4 ms | Negligible |
| Cross-datacenter write | 4–7 ms | Dominated by network RTT (~50–300ms) |
| GPS outage, atomic clock only | 10–200 ms (grows over hours) | Noticeable; Spanner keeps running |

Since cross-datacenter transactions already have 50ms+ network latency, the 4–7ms commit wait is a small addition. The uncertainty is more meaningful for same-datacenter workloads.

### Paxos Replication Latency

Each write is replicated through Paxos, which requires a majority of replicas to acknowledge. For a 5-replica group spanning 3 continents:

```
Virginia ──── 80ms ──── London ──── 120ms ──── Singapore
    │                                              │
    └──────────── 150ms ───────────────────────────┘

5 replicas: 2 in Virginia, 2 in London, 1 in Singapore
Majority = 3

Best case: leader in Virginia, 2 local replicas + 1 London replica
Paxos latency = max(local, London RTT) = ~80ms

Commit = Paxos latency + commit wait = ~80ms + ~4ms = ~84ms
```

### Garbage Collection of Old Versions

Since snapshot reads can read at any past timestamp, Spanner must keep old versions. In practice, a configurable GC threshold (default: 1 hour) defines how far back snapshot reads can go. Versions older than this are garbage collected.

---

## Comparison: CockroachDB's Approach Without Atomic Clocks

CockroachDB provides a Spanner-like experience (serializable, geo-distributed SQL) without GPS receivers and atomic clocks. Instead, it uses **hybrid logical clocks (HLC)** — a combination of NTP-synchronized physical clocks and logical counters (Chapter 10).

The key difference: without hardware clocks, CockroachDB cannot bound clock uncertainty as tightly as Spanner.

| Property | Spanner | CockroachDB |
|----------|---------|-------------|
| Clock source | GPS + atomic clocks | NTP |
| Uncertainty (ε) | 1–7 ms | 250–500 ms (configurable) |
| Commit wait | ε (~4ms avg) | Not used — different protocol |
| Stale read risk | None (commit wait eliminates it) | Possible; mitigated by read restarts |
| External consistency | Guaranteed | Best-effort (clock skew can violate) |

CockroachDB's approach to clock uncertainty:

1. **Read timestamps are checked against the uncertainty interval**: when a read encounters a value with a timestamp within the uncertainty window, CockroachDB *restarts* the read at a higher timestamp. This is correct but adds latency for affected reads.

2. **Causality tokens**: CockroachDB piggybacks clock information on RPCs between nodes, similar to hybrid logical clocks. If node A sends a request to node B, and B's clock is behind A's, B advances its clock. This prevents causal violations on the critical path.

3. **The "max clock offset" setting**: administrators configure the maximum expected NTP drift. If a node's clock drifts beyond this, it is removed from the cluster.

The trade-off is clear:
- Spanner: pays for GPS/atomic clock hardware, gets *guaranteed* external consistency with low commit wait.
- CockroachDB: runs on commodity hardware, gets *almost always correct* ordering with occasional read restarts.

For most applications, CockroachDB's approach is sufficient. For applications where even a single causal ordering violation is unacceptable (financial trading, certain regulatory requirements), Spanner's hardware investment pays off.

---

## The Broader Significance

Spanner demonstrated something that many distributed systems researchers considered impractical: a globally distributed database with the strongest consistency guarantees and acceptable performance.

### What Spanner Proved

1. **You don't have to choose between consistency and global distribution** — if you're willing to invest in clock infrastructure.
2. **The real bottleneck of strong consistency is clock uncertainty, not consensus** — Paxos and 2PC are well-understood; the hard part was ordering events across continents.
3. **Multi-version concurrency control + TrueTime = lock-free reads** — the most expensive operations (reads) become the cheapest.

### The Design Pattern

Spanner established a pattern now followed by multiple systems:

```
Strong consistency in a geo-distributed database:

1. Replicate each shard via consensus (Paxos/Raft)
2. Coordinate across shards via 2PC
3. Use a global clock mechanism to assign timestamps
4. Commit-wait (or equivalent) to ensure real-time ordering
5. Multi-version store to enable lock-free snapshot reads
```

YugabyteDB, TiDB, and CockroachDB all follow variations of this pattern, differing primarily in their clock mechanism (step 3).

---

## Summary

| Concept | What It Means |
|---------|---------------|
| TrueTime | A clock API that returns a confidence interval, not a point in time |
| Commit wait | After choosing a commit timestamp, wait until it's definitely in the past |
| External consistency | If T1 finishes before T2 starts in real time, T1 is ordered before T2 |
| 2PC over Paxos | Distributed transactions without the single-coordinator blocking problem |
| Snapshot reads | Read a consistent view at a timestamp, no locks, any replica |
| ε (epsilon) | Clock uncertainty interval; ~4ms average at Google, the direct cost of commit wait |

**Key takeaway**: Spanner's core insight is that you don't need *perfect* clocks — you need clocks that *know how wrong they might be*. By quantifying uncertainty and waiting it out, Spanner turns imperfect clocks into a tool for global ordering.

---

## References

- Corbett, J. C., et al. (2012). "Spanner: Google's Globally-Distributed Database." *OSDI '12*.
- Brewer, E. (2017). "Spanner, TrueTime and the CAP Theorem." Google Research Blog.
- Lamport, L. (1998). "The Part-Time Parliament." *ACM TOCS* 16(2).
- Demirbas, M. (2013). "Spanner: Google's Globally-Distributed Database — Summary." Blog post.
- Taft, R., et al. (2020). "CockroachDB: The Resilient Geo-Distributed SQL Database." *SIGMOD '20*.
- Kulkarni, S., et al. (2014). "Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases." *OPODIS '14*.

---

**Next**: [Chapter 28: CRDTs — Eventual Consistency Without Coordination →](ch28-crdts.md)
