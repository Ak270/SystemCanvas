# Chapter 26: Two-Phase Commit — The Full Protocol Including In-Doubt State

> **Core question**: What exactly must a participant do after voting YES when the coordinator crashes and never recovers?

## Prerequisites

- Chapter 3: Failure Taxonomy (crash-stop, crash-recovery models)
- Chapter 5: The Two Generals Problem
- Chapter 25: Serializability vs Linearizability

---

## The Problem: Atomic Commit

You have a transaction that spans two databases — say, a bank transfer:

```
Database 1 (checking): withdraw $500
Database 2 (savings):  deposit $500
```

Both operations must happen, or neither must happen. If Database 1 debits the account and Database 2 crashes before crediting, the customer loses $500.

This is the **atomic commit** problem: given N participants that each independently decide whether they *can* commit a transaction, ensure that either all of them commit or all of them abort. There is no middle ground.

Atomic commit is harder than consensus. In consensus, any proposed value can win. In atomic commit, the decision is constrained: if even one participant says "no," the outcome must be abort. But if all say "yes," the outcome must be commit. And once any participant has been told to commit, it cannot change its mind.

---

## The Protocol: Two-Phase Commit (2PC)

2PC was described by Jim Gray in 1978. It's the oldest and still most widely deployed distributed transaction protocol.

### The Actors

```
┌──────────────┐
│ Coordinator  │    (Transaction manager — often the application server
│    (C)       │     or a dedicated TM like the database proxy)
└──────┬───────┘
       │
  ┌────┴──────────────┐
  │                   │
  ▼                   ▼
┌──────────┐    ┌──────────┐
│Participant│    │Participant│    (Resource managers — databases, message
│   P1     │    │   P2     │     brokers, or any system holding part of
└──────────┘    └──────────┘     the transaction's state)
```

### Phase 1: Prepare (Voting)

The coordinator asks each participant: "Can you commit this transaction?"

```
           C                    P1                   P2
           │                     │                    │
           │── PREPARE ─────────▶│                    │
           │── PREPARE ──────────┼───────────────────▶│
           │                     │                    │
           │                     │ (checks constraints,│
           │                     │  acquires locks,    │
           │                     │  writes WAL)        │
           │                     │                    │ (same)
           │                     │                    │
           │◀── VOTE YES ───────│                    │
           │◀── VOTE YES ────────┼────────────────────│
           │                     │                    │
```

When a participant votes **YES**, it makes a promise:

1. **"I can commit."** All constraints are satisfied, all locks are held, all data is written to the write-ahead log.
2. **"I will not unilaterally abort."** The participant has given up its right to abort on its own. It has handed control of the transaction's fate to the coordinator.
3. **"I will hold these locks until told what to do."** The participant keeps all resources locked — other transactions that need these rows must wait.

When a participant votes **NO**, it aborts its local portion immediately and releases locks. The coordinator will send ABORT to everyone.

### The Prepare Log Record

**Before voting YES, the participant must force-write a prepare log record to stable storage.**

This is critical. If the participant crashes after voting YES but before learning the outcome, it must remember that it voted YES — because it promised to commit if told to. If it forgot its vote and aborted upon recovery, it would violate the atomicity guarantee (the other participant might have already committed).

```python
# Participant's prepare handler (simplified)
def handle_prepare(transaction_id, changes):
    # 1. Verify constraints
    if not validate(changes):
        log.force_write(VOTE_NO, transaction_id)
        return VOTE_NO

    # 2. Acquire all locks (already held during execution)
    # 3. Write all changes to WAL
    wal.write(changes)

    # 4. FORCE write prepare record to disk
    #    This MUST be durable before sending VOTE YES
    log.force_write(VOTE_YES, transaction_id)
    log.flush()  # fsync — blocks until on stable storage

    # 5. Now safe to vote YES
    return VOTE_YES
```

The `force_write` + `flush` is a synchronous disk write. It's expensive (a few milliseconds to tens of milliseconds depending on the storage). But it's mandatory — without it, the protocol is broken.

### Phase 2: Commit (Decision)

The coordinator collects votes and makes a decision:

**If all participants voted YES:**

```
           C                    P1                   P2
           │                     │                    │
           │ (all votes = YES)   │                    │
           │                     │                    │
           │ (force-write        │                    │
           │  COMMIT to log)     │                    │
           │                     │                    │
           │── COMMIT ──────────▶│                    │
           │── COMMIT ───────────┼───────────────────▶│
           │                     │                    │
           │                     │ (apply changes,    │
           │                     │  release locks,    │
           │                     │  write COMMIT      │
           │                     │  to log)           │
           │                     │                    │ (same)
           │                     │                    │
           │◀── ACK ────────────│                    │
           │◀── ACK ─────────────┼────────────────────│
           │                     │                    │
           │ (write COMPLETE     │                    │
           │  to log, forget     │                    │
           │  transaction)       │                    │
```

**If any participant voted NO (or timed out):**

```
           C                    P1                   P2
           │                     │                    │
           │ (P2 voted NO or     │                    │
           │  timed out)         │                    │
           │                     │                    │
           │── ABORT ───────────▶│                    │
           │── ABORT ────────────┼───────────────────▶│
           │                     │                    │
           │                     │ (rollback changes, │
           │                     │  release locks)    │
           │                     │                    │
```

### The Coordinator's Commit Log Record

**Before sending COMMIT messages, the coordinator must force-write a commit record to stable storage.**

This is the **point of no return**. Once this record is on disk, the transaction is committed, even if the coordinator crashes before telling anyone. Upon recovery, the coordinator reads the log and resends COMMIT to all participants.

```python
# Coordinator's decision logic (simplified)
def decide(transaction_id, votes):
    if all(v == YES for v in votes):
        # Point of no return: force-write COMMIT decision
        log.force_write(COMMIT, transaction_id)
        log.flush()  # fsync

        # Now tell participants
        for participant in participants:
            send(participant, COMMIT, transaction_id)
    else:
        log.force_write(ABORT, transaction_id)
        log.flush()

        for participant in participants:
            send(participant, ABORT, transaction_id)
```

---

## The Blocking Problem: 2PC's Fatal Flaw

Here is the scenario every distributed systems textbook describes but few explain completely.

### The Setup

```
           C                    P1                   P2
           │                     │                    │
           │── PREPARE ─────────▶│                    │
           │── PREPARE ──────────┼───────────────────▶│
           │                     │                    │
           │◀── VOTE YES ───────│                    │
           │◀── VOTE YES ────────┼────────────────────│
           │                     │                    │
           │ (C decides COMMIT)  │                    │
           │ (force-writes       │                    │
           │  COMMIT to log)     │                    │
           │                     │                    │
           │── COMMIT ──────────▶│                    │
           │                     │                    │
           ╳ (C crashes before   │                    │
              sending COMMIT     │                    │
              to P2)             │                    │
                                 │                    │
                                 │ (P1 commits,      │
                                 │  releases locks)  │
                                 │                    │
                                 │                    │ (P2 is waiting.
                                 │                    │  It voted YES.
                                 │                    │  It has heard
                                 │                    │  nothing.)
```

### P2's Dilemma

P2 voted YES. It promised it could commit. Now the coordinator is gone. What should P2 do?

**Can P2 abort?**

No. P1 might have received the COMMIT message and already committed. If P2 aborts, the transaction is split: P1 committed, P2 aborted. Atomicity is violated.

**Can P2 commit?**

No. The coordinator might have decided to ABORT (perhaps it received a NO vote from a third participant that P2 doesn't know about). If P2 commits and the decision was ABORT, atomicity is violated.

**Can P2 ask P1?**

P2 can try. If P1 received COMMIT and already committed, P2 knows the decision is COMMIT and can proceed. But what if P1 also hasn't heard anything? Then both P1 and P2 are stuck.

And what if P1 is also unreachable? Then P2 is completely alone.

**P2 must wait.** It has no safe action. It must hold its locks, keeping resources blocked, until the coordinator recovers and tells it the decision. This could be seconds, minutes, hours, or (if the coordinator's disk is destroyed) effectively forever.

### The In-Doubt State

A participant is **in-doubt** (also called **in-doubt** or **prepared**) when:

1. It has voted YES.
2. It has not received the final decision (COMMIT or ABORT).

```
                    Transaction State Machine (Participant)
                    ─────────────────────────────────────

                          ┌─────────┐
                          │ INITIAL │
                          └────┬────┘
                               │ receive PREPARE
                               ▼
                    ┌──── Can commit? ────┐
                    │                     │
                   YES                   NO
                    │                     │
                    ▼                     ▼
              ┌──────────┐         ┌──────────┐
              │ PREPARED │         │ ABORTED  │
              │(IN-DOUBT)│         │          │
              └────┬─────┘         └──────────┘
                   │
           ┌───────┴────────┐
           │                │
     receive COMMIT    receive ABORT
           │                │
           ▼                ▼
     ┌──────────┐    ┌──────────┐
     │COMMITTED │    │ ABORTED  │
     └──────────┘    └──────────┘
```

The PREPARED state is the dangerous one. The participant:
- **Cannot make a unilateral decision** — it gave that up when it voted YES.
- **Must hold all locks** — other transactions touching these rows are blocked.
- **Must survive crashes** — the prepare log record ensures the participant remembers its promise after recovery.
- **Must retry indefinitely** — it periodically contacts the coordinator asking for the decision.

### How Long Can In-Doubt Last?

In theory: forever. In practice: until the coordinator recovers.

Real-world horror stories:

- **Oracle Database**: If a coordinator crashes with an in-doubt transaction, the affected rows are locked until a DBA manually resolves the transaction using `COMMIT FORCE` or `ROLLBACK FORCE`. Oracle's documentation explicitly warns: "In-doubt transactions hold locks on data and prevent other transactions from modifying that data."

- **PostgreSQL prepared transactions**: `PREPARE TRANSACTION` puts a transaction in the prepared state. If the coordinator never sends `COMMIT PREPARED` or `ROLLBACK PREPARED`, those rows stay locked. PostgreSQL will not clean them up automatically — they survive server restarts. A DBA must manually resolve them.

- **XA transactions in Java**: JTA (Java Transaction API) coordinators maintain a transaction log. If the log is lost (disk failure, misconfigured log directory), in-doubt transactions on participants must be resolved manually.

---

## The Protocol in Detail: Every Log Record

Understanding 2PC requires tracking exactly what each party writes to stable storage and when. Here is the complete protocol with all log records:

### Normal Commit Path

```
Step  Coordinator                          Participant (each)
────  ──────────────────────────────────   ──────────────────────────────────
 1    Write BEGIN to log
      Send PREPARE to all participants

 2                                         Receive PREPARE
                                           Validate constraints
                                           Acquire all locks
                                           Write all redo/undo records to WAL
                                           Force-write VOTE_YES to log ← CRITICAL
                                           Send VOTE YES to coordinator

 3    Receive all votes
      All YES?
      Force-write COMMIT to log    ← POINT OF NO RETURN
      Send COMMIT to all participants

 4                                         Receive COMMIT
                                           Apply changes (make permanent)
                                           Write COMMIT to log
                                           Release all locks
                                           Send ACK to coordinator

 5    Receive all ACKs
      Write COMPLETE to log
      Forget transaction (garbage collect)
```

### The Five Log Records

| Log Record | Written by | When | Purpose |
|-----------|-----------|------|---------|
| **BEGIN** | Coordinator | Before PREPARE | Marks transaction start |
| **VOTE_YES** | Participant | Before sending YES | Participant remembers its promise |
| **COMMIT** | Coordinator | Before sending COMMIT | The authoritative decision — survives crashes |
| **COMMIT** | Participant | After receiving COMMIT | Participant records that it committed |
| **COMPLETE** | Coordinator | After all ACKs | Safe to garbage-collect the transaction |

The two **force-writes** (VOTE_YES by participant, COMMIT by coordinator) are the ones that must be synchronous (fsync). All others can be buffered.

### Abort Path

If any participant votes NO or the coordinator times out waiting for a vote:

```
Step  Coordinator                          Participant (each)
────  ──────────────────────────────────   ──────────────────────────────────
 1    Write BEGIN to log
      Send PREPARE to all participants

 2a                                        (P1) Force-write VOTE_YES, send YES
 2b                                        (P2) Write VOTE_NO, send NO

 3    Receive at least one NO (or timeout)
      Write ABORT to log
      Send ABORT to all participants

 4a                                        (P1) Receive ABORT
                                                Rollback changes
                                                Release locks
                                                Write ABORT to log
                                                Send ACK

 4b                                        (P2) Receive ABORT (already aborted)
                                                Send ACK
```

---

## Recovery Procedures

### Coordinator Recovery

When the coordinator restarts, it scans its log:

```python
def coordinator_recover():
    for txn in log.scan_active_transactions():
        if txn.has_record(COMPLETE):
            # Fully done. Clean up.
            pass
        elif txn.has_record(COMMIT):
            # Decision was COMMIT, but some participants
            # may not have received it yet.
            for p in txn.participants:
                send(p, COMMIT, txn.id)  # Resend
        elif txn.has_record(ABORT):
            # Decision was ABORT. Resend to be safe.
            for p in txn.participants:
                send(p, ABORT, txn.id)
        else:
            # No decision was made (crashed before deciding).
            # Safe to abort — no participant has committed.
            log.force_write(ABORT, txn.id)
            for p in txn.participants:
                send(p, ABORT, txn.id)
```

Key insight: if the coordinator has no COMMIT record for a transaction, no participant can have committed it. The coordinator is the only entity that sends COMMIT messages, and it writes the log record before sending. So aborting is always safe.

### Participant Recovery

When a participant restarts, it scans its log:

```python
def participant_recover():
    for txn in log.scan_active_transactions():
        if txn.has_record(COMMIT):
            # Already committed. Nothing to do.
            pass
        elif txn.has_record(ABORT):
            # Already aborted. Nothing to do.
            pass
        elif txn.has_record(VOTE_YES):
            # IN-DOUBT! We voted YES but never heard the decision.
            # Must ask the coordinator.
            reacquire_locks(txn)  # Re-lock the affected rows
            ask_coordinator(txn.id)  # Keep asking until we get an answer
        else:
            # Never voted. Safe to abort unilaterally.
            rollback(txn)
```

The terrifying line is `reacquire_locks(txn)`. Upon recovery, the participant must **re-lock all the rows involved in the in-doubt transaction** and hold them until it learns the outcome. Those rows are frozen.

---

## Why 2PC Blocks: A Formal Argument

2PC is a **blocking protocol**. We can prove that no participant can safely make a unilateral decision while in-doubt:

**Theorem**: If participant P is in the PREPARED state and cannot communicate with any other process, P cannot safely commit or abort.

**Proof**:

Case 1: P aborts unilaterally.
- It is possible that the coordinator decided COMMIT and another participant Q received COMMIT and committed.
- Now P has aborted and Q has committed. Atomicity violated. ∎

Case 2: P commits unilaterally.
- It is possible that the coordinator crashed before deciding and, upon recovery, decided ABORT (it's allowed to abort if it hasn't force-written COMMIT).
- Or another participant voted NO, and the coordinator decided ABORT.
- Now P has committed and everyone else has aborted. Atomicity violated. ∎

Case 3: P contacts another participant Q.
- If Q received COMMIT → P can safely commit.
- If Q received ABORT → P can safely abort.
- If Q has also voted YES but heard nothing → neither Q nor P can decide. Both are in-doubt.
- If Q never voted (crashed before PREPARE) → Q will abort upon recovery, so the coordinator will decide ABORT. P can safely abort... but P can't be sure Q will abort, since Q might not have crashed — it might just be slow. ∎

In the general case where the coordinator and some participants are unreachable, no safe decision exists. P must wait.

---

## Three-Phase Commit (3PC): The Non-Blocking Attempt

Dale Skeen proposed 3PC in 1981 to eliminate the blocking problem. It adds a PRE-COMMIT phase:

```
Phase 1: PREPARE → participants vote YES/NO
Phase 2: PRE-COMMIT → coordinator tells participants "everyone voted YES,
         prepare to commit" (but don't commit yet)
Phase 3: COMMIT → coordinator tells participants to commit
```

The key idea: if a participant is in PRE-COMMIT state and the coordinator fails, the participant knows that all other participants voted YES. It can safely elect a new coordinator from among the remaining participants and complete the protocol.

```
           C                    P1                   P2
           │                     │                    │
           │── PREPARE ─────────▶│                    │
           │── PREPARE ──────────┼───────────────────▶│
           │◀── YES ────────────│                    │
           │◀── YES ─────────────┼────────────────────│
           │                     │                    │
           │── PRE-COMMIT ──────▶│                    │
           │── PRE-COMMIT ───────┼───────────────────▶│
           │◀── ACK ────────────│                    │
           │◀── ACK ─────────────┼────────────────────│
           │                     │                    │
           │── DO-COMMIT ───────▶│                    │
           │── DO-COMMIT ────────┼───────────────────▶│
```

### Why 3PC Doesn't Work with Network Partitions

3PC assumes a **synchronous** system model (bounded message delays). In an asynchronous network — the real world — it breaks:

```
           C                    P1                   P2
           │                     │                    │
           │── PRE-COMMIT ──────▶│                    │
           │                     │     ╳ network      │
           │                     │     partition      │
           │                     │                    │
           │ (C and P1 are on    │                    │
           │  one side of the    │                    │
           │  partition)         │                    │
           │                     │                    │ (P2 is on the other
           │                     │                    │  side. It voted YES
           │                     │                    │  but never received
           │                     │                    │  PRE-COMMIT.)
           │                     │                    │
           │── DO-COMMIT ───────▶│                    │ (P2 times out.
           │                     │ (P1 commits)       │  Elects itself
           │                     │                    │  coordinator.
           │                     │                    │  No PRE-COMMIT
           │                     │                    │  received, so
           │                     │                    │  it aborts.)
           │                     │                    │
           COMMIT                                   ABORT
                    ← Atomicity violated →
```

P1 committed (it received PRE-COMMIT and DO-COMMIT). P2 aborted (it never received PRE-COMMIT and elected a new coordinator that decided to abort). The network partition caused a split decision.

This is why 3PC is rarely used in practice. The real world has network partitions, and 3PC provides no benefit over 2PC when partitions occur. Modern systems either:
1. Use 2PC and accept the blocking risk.
2. Avoid distributed transactions entirely (sagas, eventual consistency).
3. Use consensus-based commit protocols (Paxos Commit, which combines 2PC with Paxos to tolerate coordinator failure without blocking).

---

## 2PC + Paxos: The Non-Blocking Alternative

Gray and Lamport described **Paxos Commit** (2006): replace the single coordinator with a Paxos group.

```
Instead of:
  Coordinator (single point of failure)
      │
  ┌───┴───┐
  P1      P2

Use:
  Paxos Group (fault-tolerant coordinator)
  ┌────┬────┬────┐
  │ R1 │ R2 │ R3 │    ← Replicated coordinator state
  └────┴────┴────┘
      │
  ┌───┴───┐
  P1      P2
```

Each participant sends its vote to the Paxos group instead of a single coordinator. The Paxos group reaches consensus on the decision (commit or abort). Even if some replicas fail, the decision is available from a majority.

This is what **Spanner** uses: each participant's shard runs a Paxos group. The coordinator runs 2PC across these Paxos groups. If the coordinator fails, a new coordinator can learn the decision from the Paxos groups.

Cost: instead of 1 coordinator writing 1 log record, you have a Paxos round (at least 2 message delays) for the commit decision. But you never block.

---

## Performance Analysis

### Latency

In the best case (no failures, all participants say YES):

```
Client → Coordinator: begin transaction (1 RTT to each shard for operations)
Coordinator → Participants: PREPARE (1 message, parallel)
Participants: force-write VOTE_YES (1 disk sync each)
Participants → Coordinator: VOTE YES (1 message)
Coordinator: force-write COMMIT (1 disk sync)
Coordinator → Participants: COMMIT (1 message)
Participants: apply + release locks (1 disk sync each)
Participants → Coordinator: ACK (1 message)
```

Total additional latency beyond a single-node transaction:
- 2 network round trips (PREPARE/YES and COMMIT/ACK)
- 2 synchronous disk writes (participant's VOTE_YES and coordinator's COMMIT)

With typical numbers:
- Network RTT within a datacenter: ~0.5ms
- fsync to SSD: ~0.5ms (single write), ~2ms (HDD)

**Overhead: ~2-5ms** for 2PC within a datacenter. This is why Spanner's cross-region 2PC (where RTTs are 50-150ms) is expensive: the two extra round trips add 100-300ms.

### Throughput Impact

The bigger cost is **lock holding time**. During 2PC, participants hold locks from when they acquire them (during transaction execution) until Phase 2 completes:

```
Lock held: ├── execution ── PREPARE ── vote ── decision ── COMMIT ── release ──┤
                                                                      ▲
                                                                   Lock released
                                                                   here, not
                                                                   at local
                                                                   commit time
```

Every other transaction that needs these rows waits. In a high-contention workload, this serialization destroys throughput.

### Comparison: One-Phase vs Two-Phase

| Metric | Single-node commit | 2PC commit |
|--------|--------------------|------------|
| Disk syncs | 1 (commit record) | 2 (prepare + commit) per participant + 1 coordinator |
| Network round trips | 0 | 2 (prepare/vote + commit/ack) |
| Lock hold duration | Until local commit | Until 2PC completes |
| Blocking risk | None | Coordinator crash blocks participants |
| Abort complexity | Local rollback | Must abort all participants |

---

## Real Implementations

### XA Protocol (X/Open Distributed Transaction Processing)

XA is the industry standard for 2PC. It defines an interface between a **Transaction Manager** (coordinator) and **Resource Managers** (participants):

```c
// Transaction Manager API (simplified)
xa_start(xid, flags)      // Begin a transaction branch
xa_end(xid, flags)        // End a transaction branch
xa_prepare(xid)           // Phase 1: ask RM to prepare
xa_commit(xid, one_phase) // Phase 2: tell RM to commit
xa_rollback(xid)          // Phase 2: tell RM to abort
xa_recover()              // After crash: list in-doubt transactions
```

XA is supported by PostgreSQL, MySQL, Oracle, SQL Server, ActiveMQ, and many other systems. In Java, it's exposed through JTA (Java Transaction API).

**The xa_recover problem**: After a crash, the coordinator calls `xa_recover()` on each participant to list in-doubt transactions. But if the coordinator's log is lost, it doesn't know which participants to ask, or what transactions existed. This is why coordinator log durability is critical — lose the log, and you must manually resolve in-doubt transactions on every participant.

### PostgreSQL Prepared Transactions

PostgreSQL implements the participant side of 2PC:

```sql
-- Phase 1: Prepare
BEGIN;
UPDATE accounts SET balance = balance - 500 WHERE id = 1;
PREPARE TRANSACTION 'transfer_123';
-- Transaction is now in-doubt. Locks are held. Connection can close.

-- Phase 2 (later, possibly from a different connection):
COMMIT PREPARED 'transfer_123';
-- Or: ROLLBACK PREPARED 'transfer_123';
```

Prepared transactions survive server restarts. They hold locks indefinitely. Check for orphaned prepared transactions:

```sql
SELECT * FROM pg_prepared_xacts;
-- If this returns rows and no coordinator is managing them, trouble.
```

### MySQL XA Transactions

```sql
XA START 'transfer_123';
UPDATE checking SET balance = balance - 500 WHERE account_id = 1;
XA END 'transfer_123';
XA PREPARE 'transfer_123';
-- In-doubt state. Locks held.

XA COMMIT 'transfer_123';
-- Or: XA ROLLBACK 'transfer_123';
```

MySQL's XA has historically been buggy. Before MySQL 5.7.7, XA prepared transactions were not properly recovered after a crash, potentially losing committed data.

---

## Why Microservices Avoid 2PC

In a microservice architecture, 2PC has severe practical problems:

### 1. Heterogeneous Participants

Microservices use different databases: one might use PostgreSQL, another MongoDB, another Redis. Not all of them support XA. And those that do have different implementations with different edge cases.

### 2. Lock Duration Across Networks

In a monolith, 2PC happens within a datacenter. In microservices, participants might be in different regions. Lock hold time spans network latencies:

```
Service A (us-east):    lock acquired ──────────── released
                                      ↕ 80ms RTT to coordinator
Service B (eu-west):    lock acquired ──────────── released
                                      ↕ 150ms RTT to coordinator

Total lock time: execution + 2 * max(RTT) ≈ execution + 300ms
```

### 3. Coordinator Is a Single Point of Failure

The coordinator is typically the application server that initiated the transaction. Application servers are stateless and ephemeral — they're designed to be killed and replaced. Making them responsible for durable transaction coordination (with log files that must survive restarts) is architecturally awkward.

### 4. Availability Reduction

2PC requires all participants to be available during the commit phase. If one service is down, the transaction can't complete. In a microservice architecture with dozens of services, the probability that at least one is unavailable at any given moment is significant.

### The Alternatives

Instead of 2PC, microservices typically use:

1. **Sagas** (Chapter 31): Break the distributed transaction into a sequence of local transactions, each with a compensating action that undoes it if a later step fails.

2. **The Outbox Pattern** (Chapter 31): Write events and state changes to the same local database in a single local transaction, then publish events asynchronously.

3. **Eventual consistency**: Accept that the system will be temporarily inconsistent and design the business logic to handle it.

---

## The Impossibility Connection

2PC's blocking problem is directly related to the impossibility results from Chapter 21 (FLP):

- **FLP** says: No deterministic algorithm can guarantee consensus in an asynchronous system with even one crash fault.
- **2PC** says: All participants must agree on the same decision.
- **Result**: 2PC must block (sacrifice liveness) to maintain safety (all participants commit or all abort).

2PC chooses **safety over liveness**. It will never violate atomicity (no split decisions), but it may block indefinitely. This is the correct trade-off for transactions — a split decision (some committed, some aborted) is far worse than a temporary block.

3PC attempts to recover liveness but sacrifices safety under network partitions. Paxos Commit recovers liveness (the Paxos group tolerates coordinator failure) but at the cost of additional message rounds.

---

## Summary: The Complete 2PC State Machine

### Coordinator States

```
                    ┌─────────┐
                    │  INIT   │
                    └────┬────┘
                         │ send PREPARE to all
                         ▼
                    ┌─────────┐
                    │ WAITING │──── any NO or timeout ──▶ write ABORT
                    └────┬────┘                           send ABORT ──▶ ABORTED
                         │ all YES
                         ▼
                  force-write COMMIT   ← point of no return
                    ┌──────────┐
                    │COMMITTED │
                    └────┬─────┘
                         │ send COMMIT, receive all ACKs
                         ▼
                    ┌──────────┐
                    │ COMPLETE │
                    └──────────┘
```

### Participant States

```
                    ┌─────────┐
                    │  INIT   │
                    └────┬────┘
                         │ receive PREPARE
                    ┌────┴────┐
                   YES       NO ──▶ ABORTED
                    │
              force-write VOTE_YES
                    │
                    ▼
              ┌──────────┐
              │ PREPARED  │ ← IN-DOUBT (dangerous state)
              │           │   Locks held, waiting for decision
              └────┬──────┘
                   │
           ┌───────┴────────┐
     receive COMMIT    receive ABORT
           │                │
           ▼                ▼
     ┌──────────┐    ┌──────────┐
     │COMMITTED │    │ ABORTED  │
     └──────────┘    └──────────┘
```

---

## Key Takeaways

1. **2PC is a blocking protocol.** If the coordinator crashes after participants vote YES, participants are stuck holding locks until the coordinator recovers. This is not a bug — it's an inherent consequence of the FLP impossibility result.

2. **The PREPARED (in-doubt) state is the dangerous state.** A participant that has voted YES cannot unilaterally commit or abort. It must wait, holding locks, potentially forever.

3. **Two force-writes are critical.** The participant must force-write VOTE_YES before voting, and the coordinator must force-write COMMIT before sending commit messages. Skip either one, and crash recovery breaks the protocol.

4. **3PC solves blocking only in synchronous systems.** In the real world (asynchronous networks with partitions), 3PC can produce split decisions, which is worse than blocking.

5. **Paxos Commit (2PC over consensus groups) is the modern solution.** It avoids blocking by replicating the coordinator's state. Spanner uses this approach.

6. **Microservices avoid 2PC** because of lock duration across networks, heterogeneous participants, and availability requirements. They use sagas, the outbox pattern, or eventual consistency instead.

7. **2PC adds ~2-5ms of latency** within a datacenter (2 network round trips + 2 synchronous disk writes). Cross-region, it adds hundreds of milliseconds.

---

## References

- Gray, J. "Notes on Data Base Operating Systems." *Operating Systems: An Advanced Course*, 1978.
- Skeen, D. "Nonblocking Commit Protocols." *SIGMOD*, 1981.
- Bernstein, P., Hadzilacos, V., and Goodman, N. *Concurrency Control and Recovery in Database Systems*. Addison-Wesley, 1987. (Chapter 7: Distributed Commit)
- Gray, J. and Lamport, L. "Consensus on Transaction Commit." *ACM TODS*, 2006. (Paxos Commit)
- Bailis, P. et al. "Coordination Avoidance in Database Systems." *VLDB*, 2015.

---

**Next**: [Chapter 27: Spanner's TrueTime and External Consistency →](ch27-spanner-truetime.md)
