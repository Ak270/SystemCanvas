# Capstone 6: Globally Distributed Transactional Database (Spanner-like)

> **Design Goal**: Build a globally distributed, strongly consistent, transactional database that commits read-write transactions across datacenters on different continents with a guarantee stronger than serializable — **external consistency** (equivalent to strict serializability).

**Key Concepts Practiced**: TrueTime commit wait, Paxos group replication, external consistency, cross-shard transactions, 2PC over Paxos groups, linearizability, clock uncertainty.

**Prerequisites**: Chapters 9 (physical clocks), 12–13 (consistency models, linearizability), 20 (CAP theorem), 22 (Raft/consensus), 25 (serializability vs linearizability), 26 (2PC), 27 (Spanner's TrueTime).

---

## 1. Problem Statement

You need a database where:

1. Data is **sharded** across regions (US-East, Europe, Asia) for locality.
2. Each shard is **replicated** across multiple datacenters for fault tolerance.
3. Transactions can span shards — a transfer from account A (US-East shard) to account B (Europe shard) is atomic.
4. The consistency guarantee is **external consistency**: if transaction T1 commits before transaction T2 starts (in real wall-clock time), then T2 sees T1's writes. This is stronger than serializable — it respects real-time ordering.
5. Read-only transactions are **lock-free** — they don't block writes.

**The fundamental challenge**: External consistency requires a global ordering of transactions that respects real time. But machines across continents have clock skew. How do you assign timestamps that respect real-time order without a globally synchronized clock?

---

## 2. Architecture Overview

```
                    ┌────────────────────────────────────────────┐
                    │              Global Metadata               │
                    │    (Paxos group for schema, shard map)     │
                    └─────────────────┬──────────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         │                            │                            │
    US-East Region              Europe Region               Asia Region
    ┌─────────────┐            ┌─────────────┐            ┌─────────────┐
    │  DC-East-1  │            │  DC-EU-1    │            │  DC-Asia-1  │
    │ ┌─────────┐ │            │ ┌─────────┐ │            │ ┌─────────┐ │
    │ │Shard A  │ │            │ │Shard A  │ │            │ │Shard A  │ │
    │ │(replica)│ │            │ │(replica)│ │            │ │(replica)│ │
    │ ├─────────┤ │            │ ├─────────┤ │            │ ├─────────┤ │
    │ │Shard B  │ │            │ │Shard B  │ │            │ │Shard B  │ │
    │ │(leader) │ │            │ │(replica)│ │            │ │(replica)│ │
    │ ├─────────┤ │            │ ├─────────┤ │            │ ├─────────┤ │
    │ │TrueTime │ │            │ │TrueTime │ │            │ │TrueTime │ │
    │ │ Server  │ │            │ │ Server  │ │            │ │ Server  │ │
    │ └─────────┘ │            │ └─────────┘ │            │ └─────────┘ │
    └─────────────┘            └─────────────┘            └─────────────┘
    
    Each shard is a Paxos group with replicas in multiple DCs.
    Each DC has GPS receivers and atomic clocks for TrueTime.
```

### Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Replication | Paxos per shard | Strong consistency within each shard |
| Cross-shard transactions | 2PC over Paxos groups | Atomic commits across shards |
| Timestamp assignment | TrueTime (GPS + atomic clocks) | Global ordering without perfect clocks |
| Read-only transactions | Snapshot reads at a timestamp | Lock-free reads, no write blocking |

---

## 3. Data Model and Sharding

### 3.1 Hierarchical Key Space

Data is organized in tables with a primary key. Related tables can be **interleaved** — physically co-located on the same shard:

```sql
CREATE TABLE Accounts (
  account_id INT64 PRIMARY KEY,
  owner STRING,
  balance DECIMAL
);

CREATE TABLE Transactions (
  account_id INT64,
  txn_id INT64,
  amount DECIMAL,
  timestamp TIMESTAMP,
  PRIMARY KEY (account_id, txn_id)
) INTERLEAVE IN PARENT Accounts;
```

Interleaving means Transactions rows are stored alongside their parent Account row. A transaction that reads an Account and its Transactions touches only one shard — no cross-shard coordination needed.

### 3.2 Shard Assignment

The key space is split into ranges:

```
Shard A: account_id [0, 1000000)         Leader in US-East
Shard B: account_id [1000000, 2000000)   Leader in Europe
Shard C: account_id [2000000, 3000000)   Leader in Asia
```

Each shard is a Paxos group with replicas across datacenters. The **leader** of each Paxos group handles reads and writes for that shard.

---

## 4. TrueTime: The Clock That Admits Uncertainty

### 4.1 The API

```
TT.now() → TTinterval {earliest: Timestamp, latest: Timestamp}

  |------- uncertainty interval -------|
  earliest                            latest
  "real time is definitely            "real time is definitely
   not before this"                    not after this"

TT.after(t)  → bool   "Is t definitely in the past?"
TT.before(t) → bool   "Is t definitely in the future?"
```

The uncertainty interval is typically **1–7 milliseconds**, determined by:
- GPS receiver accuracy (~1μs)
- Atomic clock drift between GPS syncs (~200μs/sec × sync interval)
- Network delay to the TrueTime server

### 4.2 Hardware

Each datacenter has:
- **GPS receivers** (multiple, for redundancy) that receive time from satellites
- **Atomic clocks** (rubidium or cesium) that free-run between GPS syncs
- **TrueTime servers** (time masters) that combine GPS and atomic clock readings

```
GPS Satellite ──radio──▶ GPS Receiver 1 ──┐
GPS Satellite ──radio──▶ GPS Receiver 2 ──┼──▶ TrueTime Server ──▶ TT.now()
Atomic Clock ─────────────────────────────┘
```

The TrueTime server cross-checks GPS against the atomic clock. If they disagree by more than a threshold, one is likely faulty — the server uses Marzullo's algorithm to compute a conservative interval that is guaranteed to contain the true time.

### 4.3 Why Intervals, Not Points

A regular clock says "the time is 14:22:03.005." TrueTime says "the time is between 14:22:03.002 and 14:22:03.008."

The interval is the key to correctness. With a point-in-time clock, two machines might assign timestamps in the wrong order due to clock skew. With an interval, we can **wait out the uncertainty** to guarantee ordering.

---

## 5. Transaction Protocols

### 5.1 Single-Shard Read-Write Transaction

The simple case: all reads and writes touch keys within one shard.

```
Client                    Shard Leader (Paxos Group A)
  │                             │
  │── BeginTxn ────────────────▶│
  │                             │── Acquire read/write locks on keys
  │                             │
  │── Read(account_42) ────────▶│
  │◀── {balance: 1000} ─────────│
  │                             │
  │── Write(account_42, 900) ──▶│
  │                             │── Buffer write
  │                             │
  │── Commit ──────────────────▶│
  │                             │── Choose commit timestamp s
  │                             │   s = TT.now().latest
  │                             │
  │                             │── COMMIT WAIT:
  │                             │   Wait until TT.after(s) == true
  │                             │   (wait until s is definitely in the past)
  │                             │
  │                             │── Replicate via Paxos (write commit record)
  │                             │── Release locks
  │                             │
  │◀── CommitResponse(s) ───────│
```

**The commit wait**: After choosing timestamp `s`, the leader waits until `TT.after(s)` returns true. This means: "I'm sure real time has passed `s`." The wait is at most the TrueTime uncertainty interval (~7ms).

**Why commit wait matters**: It guarantees that any transaction that starts after this commit (in real time) will see a timestamp greater than `s`. This is the mechanism that provides external consistency.

### 5.2 Cross-Shard Read-Write Transaction (2PC over Paxos)

A transfer from Account 42 (Shard A, US-East) to Account 1500000 (Shard B, Europe):

```
Client           Coordinator         Shard A Leader       Shard B Leader
                 (Shard A leader     (US-East)            (Europe)
                  in this case)
  │                  │                    │                     │
  │── BeginTxn ─────▶│                    │                     │
  │                  │── Lock & Read ────▶│                     │
  │                  │── Lock & Read ─────┼────────────────────▶│
  │                  │                    │                     │
  │                  │◀── balance=1000 ───│                     │
  │                  │◀── balance=500 ────┼─────────────────────│
  │                  │                    │                     │
  │── Transfer $100 ▶│                    │                     │
  │                  │                    │                     │
  │── Commit ───────▶│                    │                     │
  │                  │                    │                     │
  │                  │──── PREPARE ──────▶│                     │
  │                  │──── PREPARE ───────┼────────────────────▶│
  │                  │                    │                     │
  │                  │                    │── Paxos-replicate   │
  │                  │                    │   prepare record    │
  │                  │                    │── Choose prepare    │
  │                  │                    │   timestamp s_A     │
  │                  │                    │                     │
  │                  │                    │                     │── Paxos-replicate
  │                  │                    │                     │   prepare record
  │                  │                    │                     │── Choose prepare
  │                  │                    │                     │   timestamp s_B
  │                  │                    │                     │
  │                  │◀── PREPARED(s_A) ──│                     │
  │                  │◀── PREPARED(s_B) ──┼─────────────────────│
  │                  │                    │                     │
  │                  │── Choose commit timestamp:               │
  │                  │   s = max(s_A, s_B)                      │
  │                  │                    │                     │
  │                  │── COMMIT WAIT:     │                     │
  │                  │   Wait until       │                     │
  │                  │   TT.after(s)      │                     │
  │                  │                    │                     │
  │                  │──── COMMIT(s) ────▶│                     │
  │                  │──── COMMIT(s) ─────┼────────────────────▶│
  │                  │                    │                     │
  │                  │                    │── Paxos-replicate   │── Paxos-replicate
  │                  │                    │   commit @ s        │   commit @ s
  │                  │                    │── Release locks     │── Release locks
  │                  │                    │                     │
  │◀── Committed(s) ─│                    │                     │
```

**Why 2PC over Paxos, not just 2PC?**

Standard 2PC has a blocking problem (Chapter 26): if the coordinator crashes after PREPARE, participants are stuck. By running the coordinator as a Paxos group, the coordinator's state is replicated. If the coordinator leader fails, a new Paxos leader takes over and completes the protocol.

```
Standard 2PC:
  Coordinator crashes → participants BLOCKED (in-doubt state)
  
2PC over Paxos:
  Coordinator leader crashes → 
    Paxos elects new leader →
    New leader reads transaction state from Paxos log →
    Completes COMMIT or ABORT
```

Each participant is also a Paxos group. A participant's PREPARED vote is replicated via Paxos before responding. If a participant leader crashes after voting PREPARED, the new participant leader can recover the vote from its Paxos log.

### 5.3 Read-Only Transactions (Lock-Free!)

Read-only transactions are the crown jewel of this design. They don't acquire locks, don't block writes, and don't need 2PC.

```
Client                    Shard A Leader       Shard B Leader
  │                            │                     │
  │── BeginReadOnlyTxn ───────▶│                     │
  │                            │                     │
  │   Choose read timestamp:   │                     │
  │   s_read = TT.now().latest │                     │
  │                            │                     │
  │── Read(account_42, s_read)▶│                     │
  │                            │── Return latest     │
  │                            │   version ≤ s_read  │
  │◀── {balance: 1000} ────────│                     │
  │                            │                     │
  │── Read(account_1500000, s_read)─────────────────▶│
  │                            │                     │── Return latest
  │                            │                     │   version ≤ s_read
  │◀── {balance: 500} ─────────┼─────────────────────│
  │                            │                     │
  │   (no commit needed)       │                     │
```

**How it works**:

1. Choose `s_read = TT.now().latest` (the upper bound of current time).
2. At each shard, read the latest version of each key with commit timestamp ≤ `s_read`.
3. If any shard's leader has a pending write with prepare timestamp ≤ `s_read`, **wait** for that transaction to commit or abort (the read might depend on it).
4. No locks acquired. No writes blocked.

**Why this is consistent**: Every committed transaction that happened before `s_read` (in real time) has a commit timestamp < `s_read` (guaranteed by commit-wait). So reading at `s_read` sees all transactions that committed before the read started.

**Why this is powerful**: Read-only transactions dominate most workloads (often 90%+). Making them lock-free means writes are never blocked by reads, and reads across multiple shards get a consistent snapshot without coordination between shards.

---

## 6. Timestamp Ordering: Why It's Correct

The central correctness claim: **external consistency** — if T1 commits before T2 starts (in real time), then T1's commit timestamp < T2's commit timestamp.

### Proof

Let:
- `s1` = T1's commit timestamp (chosen as `TT.now().latest` at commit time)
- `e1` = the real time when T1's commit-wait finishes (the real time when T1 is visible)
- `s2` = T2's commit timestamp

**T1 commits before T2 starts** means `e1 < real_start(T2)`.

By the commit-wait rule: the leader waits until `TT.after(s1) == true`, which means the real time has passed `s1`. So:
```
s1 < e1    (s1 is in the past when commit-wait finishes)
```

T2's commit timestamp is:
```
s2 = TT.now().latest ≥ real_time ≥ real_start(T2) > e1 > s1
```

Therefore: `s1 < s2`. T1's timestamp is less than T2's timestamp. External consistency holds.

```
Real time: ──────────────────────────────────────────────────▶

T1:  [─── execute ───][commit-wait]
                       s1         e1
                                     T2:  [── execute ──][commit-wait]
                                          start(T2)      s2

     s1 < e1 < start(T2) ≤ s2
     ∴ s1 < s2  ✓
```

**The cost**: The commit-wait adds latency equal to the TrueTime uncertainty (1–7ms). This is the price of external consistency without perfectly synchronized clocks.

---

## 7. Multi-Version Concurrency Control (MVCC)

Each write creates a new version of the row, tagged with the transaction's commit timestamp:

```
Key: account_42

Versions:
  timestamp=100: {balance: 500}
  timestamp=200: {balance: 1000}   ← write from txn at t=200
  timestamp=350: {balance: 900}    ← write from txn at t=350

Read at timestamp 250:
  → Returns {balance: 1000}  (latest version ≤ 250)

Read at timestamp 400:
  → Returns {balance: 900}   (latest version ≤ 400)
```

Old versions are garbage-collected after a configurable retention period (e.g., 1 hour). This enables:
- **Snapshot reads**: Read at any past timestamp (within retention)
- **Time-travel queries**: "What was the balance at 3pm yesterday?"
- **Consistent backups**: Take a backup at a timestamp, guaranteed consistent

---

## 8. Failure Scenarios

### Scenario 1: Paxos Leader Failure During Single-Shard Transaction

```
Client ── Commit ──▶ Shard A Leader (DC-East-1)
                      │
                      │── Chooses commit timestamp s=100
                      │── Starts commit-wait
                      │── CRASHES during commit-wait
                      │
                      Shard A Paxos Group:
                        DC-East-1 (old leader): DEAD
                        DC-EU-1 (replica): has prepare record
                        DC-Asia-1 (replica): has prepare record
                      
                      Paxos elects DC-EU-1 as new leader
                      New leader:
                        1. Reads prepare record from Paxos log
                        2. Timestamp s=100 was chosen before crash
                        3. Performs commit-wait: wait until TT.after(100)
                        4. Commits and releases locks
```

**Result**: Transaction commits with the same timestamp. Client retries and discovers the transaction succeeded (via the transaction ID).

### Scenario 2: Coordinator Failure During Cross-Shard 2PC

```
State at crash:
  Coordinator: Received PREPARED from both Shard A and Shard B
               Chose commit timestamp s=250
               Wrote COMMIT decision to own Paxos log
               Sent COMMIT to Shard A ✓
               CRASHED before sending COMMIT to Shard B

Recovery:
  New coordinator leader (from same Paxos group):
    1. Reads Paxos log: COMMIT decision for txn T1 at s=250
    2. Checks Shard A: committed ✓
    3. Sends COMMIT(s=250) to Shard B
    4. Shard B commits

  Shard B was in PREPARED (in-doubt) state:
    - Locks held on affected rows
    - Other transactions blocked on those rows
    - Duration of block = time for Paxos leader election + recovery
    - Typically < 10 seconds
```

**Comparison with standard 2PC**: In standard 2PC, if the coordinator's disk fails, participants might be blocked indefinitely (Chapter 26). With 2PC over Paxos, the coordinator's decision is replicated — the block lasts only as long as Paxos leader election.

### Scenario 3: Network Partition Between Regions

```
┌─────────────────┐    PARTITION    ┌─────────────────┐
│  US-East Region │ ──── ✕ ✕ ──── │  Europe Region  │
│  Shard A leader │                 │  Shard B leader │
│  Shard A replica│                 │  Shard B replica│
└─────────────────┘                 └─────────────────┘
                          │
                   ┌──────┴──────┐
                   │ Asia Region │
                   │ Shard A rep │
                   │ Shard B rep │
                   └─────────────┘
```

**Effect on single-shard transactions**:
- Shard A (leader in US-East): Can still commit if US-East + Asia form a Paxos majority (2 out of 3 replicas). **Available**.
- Shard B (leader in Europe): Can still commit if Europe + Asia form a majority. **Available**.

**Effect on cross-shard transactions (Shard A + Shard B)**:
- The coordinator (say, Shard A's leader) can't reach Shard B's leader.
- The transaction **blocks** until the partition heals.
- This is the CAP theorem in action: we chose consistency (C) over availability (A) during partition (P).

**Minimizing impact**: Place shard leaders close to the data they serve. A transfer between two US accounts uses Shard A (leader in US) — no cross-region coordination needed if both accounts are in the same shard.

### Scenario 4: TrueTime Uncertainty Spike

```
Normal:   TT.now() = {earliest: 100.001, latest: 100.005}  (4ms uncertainty)
Spike:    TT.now() = {earliest: 100.001, latest: 100.201}  (200ms uncertainty!)

Cause: GPS receivers lost satellite lock (solar storm, antenna failure)
       Atomic clocks are free-running with higher drift
```

**Effect**: Commit-wait takes 200ms instead of 4ms. Every write transaction is 50x slower.

**The system remains correct** — the uncertainty interval is conservative, so timestamps still respect real-time ordering. But performance degrades.

**Mitigation**: Multiple GPS receivers and atomic clocks per datacenter. If one GPS receiver loses lock, others compensate. The TrueTime server uses Marzullo's algorithm to detect and exclude faulty time sources.

---

## 9. Schema Changes

Global schema changes are particularly challenging in a distributed database. This system uses an **asynchronous schema change** protocol:

```
1. Coordinator publishes schema change with future timestamp T
2. All shard leaders learn about the change via Paxos
3. At time T, all shards atomically switch to the new schema
4. Between announcement and T, both old and new schemas are accepted

Timeline:
  t=0:     Schema change announced (add column "email" to Accounts)
  t=0..T:  Shards prepare (backfill, index build, etc.)
  t=T:     All shards switch simultaneously
           (TrueTime ensures "simultaneously" is well-defined)
```

TrueTime makes the cutover timestamp globally meaningful — every shard knows exactly when to switch, without a synchronous coordination round.

---

## 10. Performance Characteristics

### Latency Breakdown (Single-Shard Write)

```
Client → Shard Leader:           ~1ms   (same region)
Acquire locks:                   ~0.1ms
Execute reads/writes:            ~1ms
Choose commit timestamp:         ~0.01ms
Commit-wait (TrueTime):         ~4ms   (average uncertainty)
Paxos replication (2 replicas):  ~5ms   (cross-DC within region)
Release locks, respond:          ~0.1ms
                                 ──────
Total:                           ~11ms
```

### Latency Breakdown (Cross-Shard Write, US-East ↔ Europe)

```
Client → Coordinator:            ~1ms
Coordinator → both shard leaders: ~80ms  (transatlantic RTT)
PREPARE responses:               ~80ms  (transatlantic RTT back)
Choose commit timestamp:         ~0.01ms
Commit-wait:                     ~4ms
COMMIT to both shards:           ~80ms  (transatlantic)
Paxos replication at each shard: ~5ms
                                 ──────
Total:                           ~250ms
```

Cross-region transactions are dominated by network latency, not commit-wait. This is why data placement matters — co-locate related data in the same region.

### Read-Only Transaction Latency

```
Choose s_read:     ~0.01ms
Read from Shard A: ~1ms    (same region)
Read from Shard B: ~80ms   (cross-region if needed)
No commit:         0ms
                   ──────
Total:             ~80ms   (dominated by the farthest shard)
```

No locks, no commit-wait, no 2PC. Read-only transactions are fast and never block writes.

---

## 11. Design Decisions and Trade-offs

### Why Not CockroachDB's Approach (No Atomic Clocks)?

CockroachDB uses **hybrid logical clocks (HLC)** instead of TrueTime:
- No special hardware needed (no GPS, no atomic clocks)
- Clock uncertainty is larger (~250ms default, based on NTP)
- Commit-wait would be 250ms instead of 4ms — too expensive
- Instead, CockroachDB uses **uncertainty restarts**: if a read encounters a value with a timestamp in the uncertainty window, the transaction restarts at a higher timestamp

**Trade-off**: CockroachDB avoids expensive hardware but pays with occasional transaction restarts and higher read latency during contention. Spanner pays for hardware but gets lower write latency and no restarts.

### Why Paxos Instead of Raft?

In this design, either works. Spanner uses Paxos (it predates Raft). Modern implementations might prefer Raft for its simplicity. The key requirement is a replicated state machine for each shard — the specific consensus algorithm is an implementation choice.

### Why Not Just Use 2PC Without Paxos?

Standard 2PC blocks when the coordinator crashes (Chapter 26). In a global database, the coordinator might be in a datacenter that loses network connectivity for hours. With 2PC over Paxos:
- Coordinator failure → Paxos elects a new leader in seconds
- Participant failure → Paxos ensures the vote is durable
- The blocking window shrinks from "until coordinator recovers" to "until Paxos elects a new leader" (~seconds)

---

## 12. Exercises

1. **Trace a read-only transaction during a write**: Transaction T1 (read-write) is committing at timestamp s=100 on Shard A. Transaction T2 (read-only) starts with s_read=95. T2 reads from Shard A. What happens? What if s_read=105?

2. **Design shard splitting**: Shard A has grown too large (a hot key range). Design a protocol to split it into Shard A1 and Shard A2 without downtime. What happens to in-flight transactions that span the split boundary? How do you update the global metadata atomically?

3. **Handle a TrueTime outage**: All GPS receivers in US-East lose satellite lock. Atomic clocks continue running but with increasing drift. How does the system detect this? What should it do — continue operating with larger uncertainty intervals, or stop accepting writes? What's the trade-off?

4. **Compare with Calvin**: Calvin (Thomson et al., 2012) takes a fundamentally different approach — it pre-orders all transactions through a sequencer layer, achieving deterministic execution without 2PC. Compare the two approaches: when does Calvin's approach win (low contention, predetermined read/write sets)? When does the Spanner approach win (ad-hoc queries, high contention)?

5. **Design a global secondary index**: Accounts have a `name` column. You want to query `SELECT * FROM Accounts WHERE name = 'Alice'` efficiently. The data is sharded by `account_id`, not `name`. Design a global secondary index that maintains external consistency. Where is the index stored? How is it kept in sync with the base table? Can you make index lookups lock-free?

6. **Trace coordinator failure during 2PC**: The coordinator has received PREPARED(s_A=100) from Shard A and PREPARED(s_B=150) from Shard B. It computes s_commit = max(100, 150) = 150 and writes the COMMIT decision to its Paxos log. Then it crashes. Trace the recovery: what does the new coordinator leader do? How long are Shard A and Shard B blocked? What if the coordinator crashes *before* writing the COMMIT decision?

---

**This concludes the Distributed Systems book.** From the fundamental impossibility of agreement (Two Generals, FLP) through the practical protocols that work around those limits (Raft, 2PC, TrueTime), to the production systems that combine them (this Spanner-like database), you now have the tools to reason about correctness and failure in any distributed system you encounter.

The gap between reading a paper and building the thing is real — but the protocol-level understanding in these chapters is the bridge. When you see a distributed system bug in production, you'll know which invariant was violated, which failure model was assumed, and where the protocol's safety proof breaks down.

---

**Back to**: [Table of Contents →](../README.md)
