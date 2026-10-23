# Chapter 17: Primary-Backup Replication — Deep Mechanics

> **Core question**: What exactly happens inside a replicated database at the message level when a write arrives?

**Prerequisites**: Failure Taxonomy (Ch 3), System Models (Ch 4), Failure Detection (Ch 7), Write-Ahead Logs (Ch 15)

---

## Why Replicate at All?

A single database server stores every byte of your data on one machine. If that machine's disk fails, the data is gone. If the machine reboots, the service is unavailable until it comes back. If the datacenter loses power, your entire application is down.

Replication solves this by maintaining copies of the data on multiple machines. If one machine fails, another can serve requests. But replication introduces a problem far harder than the one it solves: **how do you keep the copies in sync?**

This chapter dissects the most common answer — primary-backup replication (also called leader-follower or master-slave replication) — at the message level. Not "the primary sends writes to replicas." Every message. Every acknowledgment. Every edge case.

---

## The Architecture

In primary-backup replication, one node is designated the **primary** (leader). All writes go to the primary. The primary forwards each write to one or more **backup** (follower) nodes. Reads can go to the primary (for strong consistency) or to any replica (for lower latency, at the cost of potentially stale reads).

```
                    Writes only
                        │
                        ▼
               ┌─────────────────┐
               │     Primary     │
               │   (Leader)      │
               └────┬───────┬────┘
                    │       │
            Replication   Replication
            stream        stream
                    │       │
                    ▼       ▼
         ┌──────────┐   ┌──────────┐
         │ Backup 1  │   │ Backup 2  │
         │(Follower) │   │(Follower) │
         └──────────┘   └──────────┘
              ▲               ▲
              │               │
         Reads (stale)   Reads (stale)
```

This looks simple. It is not.

---

## The Write Path: Message by Message

Let's trace a single write — `UPDATE accounts SET balance = 500 WHERE id = 42` — through every step of the protocol. We'll start with the simplest version (fully synchronous) and then show why it's impractical.

### Step 1: Client Sends Write to Primary

```
Client ──── UPDATE accounts SET balance=500 WHERE id=42 ────▶ Primary
```

The client sends the write to the primary. In most systems, a connection pool or a routing layer directs write traffic to the primary automatically. The client blocks, waiting for a response.

### Step 2: Primary Writes to Its WAL

Before modifying any data pages, the primary writes a log record to its **write-ahead log** (Chapter 15). This ensures that if the primary crashes after this point, it can recover the write on restart.

```
Primary:
  1. Acquire row lock on accounts WHERE id = 42
  2. Read current value: balance = 300
  3. Write WAL record: {LSN: 1047, txn: T1, table: accounts, 
                        row: 42, before: {balance: 300}, 
                        after: {balance: 500}}
  4. fsync WAL to disk
  5. Apply change to in-memory buffer pool (data page)
```

The `fsync` in step 4 is critical. Without it, the WAL record might sit in the OS page cache and be lost on a power failure. The `fsync` call forces the kernel to flush the data to the physical storage device. It's also the single most expensive operation in this entire sequence — a single `fsync` to a rotational disk takes 5–10ms; to an SSD, 0.1–1ms.

### Step 3: Primary Sends WAL Records to Backups

Now the primary must propagate this write to its backups. How it does this — and when it waits for acknowledgment — is the defining design decision of the replication protocol.

```
Primary ──── WAL record {LSN: 1047, ...} ────▶ Backup 1
Primary ──── WAL record {LSN: 1047, ...} ────▶ Backup 2
```

The primary sends the WAL record (or a logical representation of it) to each backup. This is the **replication stream** — a continuous, ordered flow of changes from primary to backups.

There are two ways to encode the replication stream:

**Physical replication** sends the raw WAL bytes. The backup applies them to its own data files identically. This is what PostgreSQL's streaming replication uses. It's fast and simple, but the backup must run the exact same database version on the same platform.

**Logical replication** sends a higher-level representation: "set row 42 in table accounts to balance=500." This is more flexible (backups can run different versions, different schemas, even different database engines) but more complex to implement correctly.

### Step 4: Backups Apply the Write

Each backup receives the WAL record and applies it:

```
Backup 1:
  1. Receive WAL record {LSN: 1047, ...}
  2. Write to local WAL
  3. fsync local WAL
  4. Apply to buffer pool
  5. Send ACK {LSN: 1047} ────▶ Primary
```

The backup's local WAL ensures that *it* can also survive a crash without losing the replicated write.

### Step 5: Primary Acknowledges the Client

When does the primary tell the client "your write succeeded"? This is where it gets interesting.

---

## Synchronous vs. Asynchronous Replication

The choice of when the primary acknowledges the client relative to when the backups acknowledge the primary defines the replication mode. This is the most consequential trade-off in the entire system.

### Fully Synchronous Replication

The primary waits for **every** backup to acknowledge before responding to the client.

```
Time ──────────────────────────────────────────────────────────▶

Client          Primary          Backup 1         Backup 2
  │                │                │                │
  │── Write ──────▶│                │                │
  │                │── WAL rec ────▶│                │
  │                │── WAL rec ───────────────────▶ │
  │                │                │                │
  │                │◀── ACK ────────│                │
  │                │                │    (waiting)   │
  │                │◀── ACK ───────────────────────│
  │                │                │                │
  │◀── OK ─────────│                │                │
  │                │                │                │
```

**Guarantee**: If the primary responds with "OK," the write is durable on all replicas. Any single machine can fail without data loss.

**Problem**: Latency. The client waits for the slowest backup. If Backup 2 is across the Atlantic (80ms round trip), every write takes at least 80ms, even if the primary and Backup 1 are in the same rack. Worse: if *any* backup is down, the primary cannot acknowledge *any* writes. One slow or dead backup blocks the entire system.

This is why fully synchronous replication is almost never used in production. The availability cost is too high.

### Fully Asynchronous Replication

The primary acknowledges the client **immediately** after writing to its own WAL, without waiting for any backup.

```
Time ──────────────────────────────────────────────────────────▶

Client          Primary          Backup 1         Backup 2
  │                │                │                │
  │── Write ──────▶│                │                │
  │                │ (write WAL)    │                │
  │◀── OK ─────────│                │                │
  │                │                │                │
  │                │── WAL rec ────▶│                │  (later)
  │                │── WAL rec ───────────────────▶ │  (later)
  │                │                │                │
```

**Guarantee**: Low latency. The client gets a response as soon as the primary's local disk confirms the write.

**Problem**: If the primary crashes *after* acknowledging the client but *before* the backup receives the WAL record, the write is lost. The client was told the write succeeded, but it's gone. This is called **durability loss** or **acknowledged write loss**.

How much data can be lost? That depends on the **replication lag** — the delay between the primary writing to its WAL and the backups receiving and applying that record. Under normal conditions, replication lag is typically 1–100ms. Under load or network congestion, it can be seconds or even minutes.

MySQL's default replication mode is fully asynchronous. This is why MySQL replication can lose transactions on primary failure.

### Semi-Synchronous Replication

The practical middle ground: the primary waits for **at least one** backup to acknowledge, then responds to the client. The remaining backups replicate asynchronously.

```
Time ──────────────────────────────────────────────────────────▶

Client          Primary          Backup 1         Backup 2
  │                │                │                │
  │── Write ──────▶│                │                │
  │                │── WAL rec ────▶│                │
  │                │── WAL rec ───────────────────▶ │
  │                │                │                │
  │                │◀── ACK ────────│                │
  │◀── OK ─────────│                │                │
  │                │                │                │
  │                │                │    (still      │
  │                │                │     replicating │
  │                │◀── ACK ───────────────────────│
  │                │                │                │
```

**Guarantee**: The write is durable on at least two machines (the primary and one backup) before the client is told it succeeded. One machine can fail without data loss.

**Problem**: If the one synchronous backup goes down, the primary must either:
- **Block all writes** until the backup recovers (acts like fully synchronous for the remaining backup)
- **Switch to asynchronous** for the remaining backup and accept the risk of durability loss
- **Promote another backup** to be the new synchronous target

PostgreSQL calls this mode `synchronous_commit = on` with one `synchronous_standby_names`. MySQL calls it "semi-synchronous replication" via the `rpl_semi_sync_master` plugin.

### The Spectrum

```
Fully           Semi-            Fully
Synchronous     Synchronous      Asynchronous
    │               │                │
    │  More durable │                │  Lower latency
    │  Less available│               │  Less durable
    │               │                │
    ◀───────────────┼────────────────▶
```

Most production systems use semi-synchronous replication or a variant of it. The exceptions are:
- **Single-datacenter with fast local network**: Fully synchronous is feasible when replicas are in the same rack (sub-millisecond latency).
- **Read-heavy workloads tolerant of stale reads**: Fully asynchronous is fine when losing the last few writes on primary failure is acceptable.

---

## What the Primary Sends: Statement vs. Row vs. WAL

The replication stream can encode changes at three levels of abstraction:

### Statement-Based Replication

The primary sends the SQL statement itself: `UPDATE accounts SET balance = 500 WHERE id = 42`.

The backup re-executes the statement against its own copy of the data.

**Problems**:
- **Non-determinism**: `UPDATE users SET updated_at = NOW()` produces a different timestamp on the backup (different clock). `DELETE FROM logs ORDER BY id LIMIT 1000` might delete different rows if the backup's index order differs.
- **Side effects**: A statement that calls `RAND()` or reads from a sequence produces different values on the backup.
- **Triggers and stored procedures**: These execute independently on the backup and may produce different results.

MySQL used statement-based replication by default until version 5.7. The non-determinism bugs were legendary.

### Row-Based (Logical) Replication

The primary sends the *result* of the statement: "row 42 in table accounts changed from `{balance: 300}` to `{balance: 500}`."

The backup applies the row change directly without re-executing any SQL.

**Advantages**:
- Deterministic: the backup gets the exact same data regardless of `NOW()`, `RAND()`, or execution order.
- Decoupled from SQL: the backup doesn't need to parse or optimize queries.
- Can replicate to different database engines, versions, or schemas.

**Disadvantages**:
- More data: a statement like `UPDATE accounts SET balance = balance + 1` touches every row, and row-based replication sends one change per row (potentially millions).
- Harder to debug: the replication stream doesn't show *why* a change happened.

MySQL's `binlog_format = ROW` and PostgreSQL's logical replication use this approach.

### WAL-Based (Physical) Replication

The primary sends its raw write-ahead log bytes. The backup applies them directly to its data files.

**Advantages**:
- Simplest to implement: no parsing, no re-execution, just byte copying.
- Byte-identical replicas: useful for point-in-time recovery and backup verification.

**Disadvantages**:
- Version-locked: primary and backup must run the same database version, OS, and architecture.
- Cannot filter: you replicate everything, including temporary tables and internal operations.

PostgreSQL's streaming replication (`pg_basebackup` + WAL shipping) uses this approach.

---

## The Split-Brain Problem

The single most dangerous failure mode in primary-backup replication is **split-brain**: two nodes both believe they are the primary.

### How Split-Brain Happens

```
Time ──────────────────────────────────────────────────────────▶

                    Network partition
                          │
Primary (A)  ─────────────┼──────────────── Backup (B)
"I am the primary"        │         "Primary is dead, I'll
"Still accepting writes"  │          take over as primary"
                          │
      Writes: x=1         │         Writes: x=2
                          │
                    Partition heals
                          │
Primary (A)  ─────────────┼──────────────── Primary (B)
     x=1                  │                    x=2
                          │
              WHO IS RIGHT? DATA DIVERGED.
```

Both A and B accepted writes while partitioned. When the partition heals, the data has diverged. Neither copy is "wrong" — they're just different. But the system promised clients a single, consistent view.

Split-brain can cause:
- **Data loss**: If we pick one primary, the other's writes are discarded.
- **Data corruption**: If both versions are partially merged, invariants may be violated (e.g., a bank account with two different balances).
- **Application errors**: Clients that wrote to different primaries got "success" responses for writes that will be rolled back.

### Fencing Tokens: The Solution

A **fencing token** (also called an **epoch number** or **term number**) is a monotonically increasing integer assigned to each primary.

The protocol:
1. When a new primary is elected, it gets a fencing token `T` that is strictly greater than any previous primary's token.
2. Every write from the primary includes the fencing token.
3. Backups reject writes with a fencing token lower than the highest they've seen.
4. External resources (locks, storage) also reject operations with stale fencing tokens.

```
Time ──────────────────────────────────────────────────────────▶

Primary A (token=5)           Backup B
       │                         │
       │ (network partition)     │
       │                         │ "A is dead, I'm primary now"
       │                         │ (token=6)
       │                         │
       │ "I'm still primary"     │ Writes with token=6 ──▶ Storage
       │ Write with token=5 ──▶  │
       │                         │
   Storage rejects token=5       │
   (has seen token=6)            │
       │                         │
   A realizes it's been fenced   │
   A steps down                  │
```

The key insight: the fencing token creates a **total order** on primaries. Even if two nodes both believe they're the primary, the one with the lower token will be rejected by any component that has seen the higher token.

Raft uses "term numbers" as fencing tokens (Chapter 22). ZooKeeper uses sequential znodes (Chapter 24). Any consensus-based leader election produces fencing tokens naturally.

### STONITH: Shoot The Other Node In The Head

An alternative to fencing tokens is **STONITH** (Shoot The Other Node In The Head): when a new primary is elected, it forcibly power-cycles the old primary via a hardware management interface (IPMI, iLO, DRAC).

This guarantees the old primary cannot accept writes — because it's literally turned off.

```
New primary B:
  1. Detect that A is unresponsive
  2. Send IPMI power-off command to A's hardware
  3. Wait for confirmation that A is powered off
  4. Begin accepting writes
```

STONITH is used in traditional HA clusters (Pacemaker/Corosync) but not in cloud environments where hardware management interfaces aren't available. In the cloud, fencing tokens are the standard approach.

---

## Failover: Promoting a Backup

When the primary fails, a backup must take over. This process — **failover** — is where most production outages happen. Not because the primary failed, but because the failover went wrong.

### The Failover Sequence

```
1. DETECT    ──▶  2. ELECT    ──▶  3. RECONFIGURE  ──▶  4. CATCH UP
   "Primary          "Which           "Tell clients       "New primary
    is dead"          backup           the new             applies any
                      becomes          primary's           unapplied
                      primary?"        address"            WAL entries"
```

Let's examine each step.

### Step 1: Detecting Primary Failure

How does the system know the primary is dead? It can't — it can only guess (Chapter 7). The standard mechanism is a **heartbeat timeout**: the primary sends periodic heartbeats, and if a backup doesn't receive one within a timeout period, it suspects the primary has failed.

```
Primary ──heartbeat──▶ Backup 1
Primary ──heartbeat──▶ Backup 2
Primary ──heartbeat──▶ Monitor

If no heartbeat received within timeout T:
  → Suspect primary failure
  → Begin election
```

The timeout is a trade-off:
- **Too short** (e.g., 1 second): False positives during GC pauses or network blips. The system failovers unnecessarily, causing downtime.
- **Too long** (e.g., 60 seconds): Real failures take a minute to detect. The system is unavailable for a minute.

Most production systems use 10–30 second timeouts. Chapter 8's phi accrual failure detector offers a more nuanced approach.

### Step 2: Electing a New Primary

Which backup becomes the new primary? The most common strategies:

**Most up-to-date replica**: Pick the backup whose WAL is closest to the old primary's. This minimizes data loss.

```python
def choose_new_primary(backups):
    # Pick the backup with the highest LSN (most recent WAL position)
    return max(backups, key=lambda b: b.last_applied_lsn)
```

**Consensus-based election**: Use a consensus protocol (Raft, ZooKeeper) to elect the new primary. This guarantees that all nodes agree on who the primary is, preventing split-brain.

**External orchestrator**: A separate monitoring system (Patroni for PostgreSQL, orchestrator for MySQL) decides which backup to promote.

### Step 3: Reconfiguring Clients

Clients need to send their writes to the new primary. This requires updating whatever routing mechanism directs write traffic:

- **DNS update**: Change the DNS record for `primary.db.internal` to point to the new primary. Slow — DNS TTLs mean some clients will still send writes to the old primary for minutes.
- **Virtual IP (VIP)**: Move a floating IP address from the old primary to the new one. Faster — ARP updates propagate in seconds.
- **Proxy/load balancer**: Update the proxy's routing table. The proxy's health checks detect the old primary's failure and route to the new one. This is what most cloud-native systems use.
- **Client-side discovery**: Clients query a service registry (ZooKeeper, etcd, Consul) for the current primary. On failover, the registry is updated and clients reconnect.

### Step 4: Catching Up

The new primary may be behind the old primary — it might not have received the last few WAL records before the old primary died. This creates a gap:

```
Old primary's WAL:  [..., LSN 1044, LSN 1045, LSN 1046, LSN 1047]
New primary's WAL:  [..., LSN 1044, LSN 1045]

Gap: LSN 1046 and LSN 1047 are LOST
```

The fate of these lost writes depends on the replication mode:

| Mode | Were LSN 1046–1047 acknowledged to clients? | Impact |
|------|----------------------------------------------|--------|
| Synchronous | No — primary was waiting for backup ACK | No data loss. Clients will retry. |
| Semi-synchronous | Only if this backup was the sync target | Data loss if this backup wasn't the sync replica |
| Asynchronous | Yes — primary ACKed immediately | **Data loss.** Clients were told these writes succeeded, but they're gone. |

When the old primary comes back online, it has WAL entries (1046, 1047) that the new primary doesn't have. These entries must be discarded — the old primary must "roll back" to the new primary's state. This is called **timeline divergence**, and it's the source of many production incidents.

PostgreSQL handles this with **timeline IDs**: when a new primary is promoted, it starts a new timeline. The old primary, on recovery, recognizes it's on an old timeline and discards divergent WAL entries.

---

## Replication Lag and Its Consequences

In asynchronous or semi-synchronous replication, backups are always slightly behind the primary. This delay is **replication lag**.

```
Primary's state at time T:    balance = 500  (written at T-1ms)
Backup's state at time T:     balance = 300  (hasn't received the update yet)

Replication lag = 1ms
```

Replication lag causes several observable anomalies:

### Reading Your Own Writes

A client writes to the primary, then reads from a backup. The backup hasn't received the write yet.

```
Client ── WRITE balance=500 ──▶ Primary        ✓ Acknowledged
Client ── READ balance ──────▶ Backup          Returns 300!
```

The client just set the balance to 500 and immediately reads 300. From the client's perspective, their write disappeared.

**Solution: read-after-write consistency.** After a write, route the client's subsequent reads to the primary (or to a backup that has caught up to the write's LSN).

```python
def read(client, key):
    last_write_lsn = client.session.last_write_lsn
    
    if last_write_lsn is not None:
        # Route to a replica that's caught up past the client's last write
        for backup in backups:
            if backup.applied_lsn >= last_write_lsn:
                return backup.read(key)
        # No backup is caught up — read from primary
        return primary.read(key)
    else:
        # No recent write — any backup is fine
        return random.choice(backups).read(key)
```

### Monotonic Reads Violation

A client reads from Backup 1 (which has caught up), then reads from Backup 2 (which hasn't).

```
Client ── READ balance ──▶ Backup 1 (lag=0ms)   Returns 500
Client ── READ balance ──▶ Backup 2 (lag=50ms)  Returns 300!
```

The client sees the balance go from 500 back to 300 — time went backward.

**Solution: sticky sessions.** Pin each client to a single backup for the duration of their session. They might read stale data, but at least it won't go backward.

### Causal Ordering Violation

Two clients coordinate through the database:

```
Client A:  WRITE x = 1             (to primary)
Client A:  WRITE y = "depends_on_x" (to primary)

Client B:  READ y ──▶ Backup      Returns "depends_on_x"
Client B:  READ x ──▶ Backup      Returns NULL!  (x hasn't replicated yet)
```

Client B sees the effect (y) before the cause (x). The backup applied the writes out of order, or different backups have different lag.

**Solution**: Track causal dependencies. A backup must not make write N visible until it has also applied all writes that N depends on. This is expensive and most systems don't do it — they accept causal anomalies as the price of asynchronous replication.

---

## Replication Topologies

The simple "primary sends to all backups" topology is the most common, but not the only option.

### Star (Single Primary)

```
         Backup 1
           ▲
           │
Primary ──┼──▶ Backup 2
           │
           ▼
         Backup 3
```

The primary sends to every backup directly. Simple, but the primary bears all the replication load.

### Chain (Cascading)

```
Primary ──▶ Backup 1 ──▶ Backup 2 ──▶ Backup 3
```

Each node replicates to the next. Reduces the primary's load, but increases latency to downstream replicas. Backup 3's lag is the sum of the lag at each hop.

PostgreSQL supports cascading replication. It's useful for cross-datacenter setups: the primary replicates synchronously to a local backup, which then replicates asynchronously to remote backups.

### Multi-Primary (Active-Active)

```
Primary A ◀──────▶ Primary B
    │                  │
    ▼                  ▼
Backup A1          Backup B1
```

Both nodes accept writes and replicate to each other. This is **not** primary-backup replication — it's a different model entirely, with all the concurrent write and conflict problems that entails. We cover it in Chapter 18 (leaderless replication).

---

## PostgreSQL Streaming Replication: A Real-World Example

Let's trace how PostgreSQL implements primary-backup replication.

### Setup

```
Primary (port 5432):
  postgresql.conf:
    wal_level = replica
    max_wal_senders = 10
    synchronous_standby_names = 'backup1'
    synchronous_commit = on

Backup (port 5433):
  recovery.conf (or standby.signal in v12+):
    primary_conninfo = 'host=primary port=5432'
    primary_slot_name = 'backup1_slot'
```

### The Replication Protocol

1. **Connection**: The backup opens a streaming replication connection to the primary using the PostgreSQL replication protocol (not a normal SQL connection).

2. **WAL streaming**: The primary sends WAL records as they're generated. The protocol is essentially: "here are bytes from position X to position Y in the WAL."

3. **Backup applies WAL**: The backup writes the WAL records to its own WAL files and replays them against its data files. During this time, the backup is in **recovery mode** — it can serve read-only queries but cannot accept writes.

4. **Feedback**: The backup periodically sends status messages to the primary:
   ```
   {
     write_lsn:   "0/1A4B5C0"    // WAL position written to backup's disk
     flush_lsn:   "0/1A4B590"    // WAL position fsynced to backup's disk  
     apply_lsn:   "0/1A4B560"    // WAL position applied to data files
   }
   ```

5. **Synchronous commit**: When `synchronous_commit = on` and the backup is named in `synchronous_standby_names`, the primary waits for the backup's `flush_lsn` to advance past the transaction's commit WAL record before acknowledging the client.

### Replication Slots

A **replication slot** is a bookmark on the primary that tracks how much WAL a backup has consumed. Without it, the primary might delete old WAL segments that the backup hasn't read yet (if the backup is slow or disconnected). With it, the primary retains WAL until the backup catches up.

The danger: if a backup goes offline permanently, the primary accumulates WAL files forever, eventually filling the disk. Production systems set `max_slot_wal_keep_size` to cap retention.

### Failover with pg_promote

When the primary fails, you promote a backup:

```bash
# On the backup:
pg_ctl promote -D /var/lib/postgresql/data

# Or via SQL (PostgreSQL 12+):
SELECT pg_promote();
```

The backup:
1. Finishes replaying any remaining WAL
2. Starts a new WAL timeline (increments timeline ID)
3. Exits recovery mode
4. Begins accepting writes

Clients must be reconfigured to connect to the new primary. Tools like **Patroni** automate this by using etcd/ZooKeeper for leader election and updating the connection endpoint automatically.

---

## Common Failover Bugs

Failover is where replication systems fail in production. Here are the most common ways it goes wrong.

### Bug 1: Autoincrement ID Collision

The old primary committed a write with `id = 1000`. The backup didn't receive it. After promotion, the new primary generates `id = 1000` for a different row. When the old primary comes back and tries to replicate, the IDs collide.

**Fix**: Use globally unique IDs (UUIDs) instead of autoincrement, or include the server ID in the autoincrement sequence.

### Bug 2: Delayed Writes Resurface

The old primary comes back online with writes the new primary never received. If the old primary is naively added as a backup, it will try to replicate its extra writes to the new primary, creating duplicates or conflicts.

**Fix**: The old primary must resync from the new primary. In PostgreSQL, `pg_rewind` reads the new primary's WAL to identify and roll back divergent changes.

### Bug 3: Cascading Failover Failures

The failover system itself requires a functioning network and orchestrator. If the network partition that killed the primary also isolates the orchestrator, no failover occurs.

**Fix**: Ensure the failover orchestrator runs in a different failure domain than the database. Use a consensus-based system (ZooKeeper, etcd) so that a majority of orchestrator nodes can still coordinate.

### Bug 4: The "Ghost Primary" Race

The old primary isn't dead — it was just slow. It recovers and starts accepting writes again, not knowing it's been replaced. Now there are two primaries.

**Fix**: Fencing tokens (described above). The old primary's writes are rejected by any component that has seen the new primary's higher token. Additionally, the old primary should check its epoch/timeline before accepting any write.

---

## Monitoring Replication Health

In production, you must continuously monitor:

### Replication Lag

```sql
-- PostgreSQL: check lag on primary
SELECT 
    client_addr,
    state,
    pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn) AS send_lag_bytes,
    pg_wal_lsn_diff(sent_lsn, flush_lsn) AS flush_lag_bytes,
    pg_wal_lsn_diff(flush_lsn, replay_lsn) AS replay_lag_bytes
FROM pg_stat_replication;
```

Alert if lag exceeds a threshold. Persistent lag means the backup can't keep up with the primary's write rate — either the backup's disk is slower, the network is saturated, or the backup is doing too many read queries.

### WAL Accumulation

```sql
-- PostgreSQL: check how much WAL is retained
SELECT 
    slot_name,
    pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes
FROM pg_replication_slots;
```

If a replication slot is retaining gigabytes of WAL, the backup is far behind or disconnected. The disk may fill.

### Failover Readiness

Periodically test that failover actually works:
- Can the backup be promoted?
- How long does failover take?
- Do clients reconnect to the new primary?
- Is the new primary's data consistent?

Netflix's Chaos Engineering team regularly kills primary databases in production to verify that failover works. If you haven't tested failover, you don't have failover — you have a hope.

---

## When Primary-Backup Replication Is Not Enough

Primary-backup replication has fundamental limits:

1. **Single point of write bottleneck**: All writes go through one node. If write throughput exceeds what one machine can handle, you need sharding (multiple primaries, each owning a subset of the data) — not more replicas.

2. **Failover is not instant**: There's always a window (seconds to minutes) where writes are unavailable during failover. If your SLA requires zero downtime, you need a multi-primary or consensus-based system.

3. **Cross-region latency**: If the primary is in US-East and a backup is in EU-West, synchronous replication adds ~80ms to every write. Asynchronous replication risks losing EU-West data. Spanner (Chapter 27) solves this differently.

4. **Conflict-free concurrent writes**: If you need multiple nodes to accept writes to the *same* data simultaneously, primary-backup can't help. You need leaderless replication (Chapter 18) or CRDTs (Chapter 28).

---

## Key Takeaways

1. **Replication mode is a durability-vs-latency trade-off**. Synchronous replication guarantees no data loss but blocks on the slowest replica. Asynchronous replication is fast but can lose acknowledged writes.

2. **Semi-synchronous is the practical default**. One synchronous replica prevents data loss on primary failure; the rest replicate asynchronously for throughput.

3. **Split-brain is the worst failure mode**. Two primaries accepting writes create divergent state that's expensive or impossible to reconcile. Fencing tokens prevent it.

4. **Failover is where outages happen**. The primary failing is the easy part. Promoting a backup, reconfiguring clients, and handling divergent WAL entries is where things go wrong.

5. **Replication lag is not a bug — it's a feature trade-off**. Every anomaly (stale reads, missing-your-own-writes, causal violations) is the price of not waiting for backups on every write.

6. **Test failover in production**, or you don't have failover.

---

## References

- PostgreSQL Documentation: [Streaming Replication](https://www.postgresql.org/docs/current/warm-standby.html)
- MySQL Documentation: [Replication](https://dev.mysql.com/doc/refman/8.0/en/replication.html)
- Kleppmann, M. (2017). *Designing Data-Intensive Applications*, Chapter 5: Replication. O'Reilly.
- Chandra, T., Griesemer, R., & Redstone, J. (2007). "Paxos Made Live." *PODC*.
- Ongaro, D. & Ousterhout, J. (2014). "In Search of an Understandable Consensus Algorithm (Raft)." *USENIX ATC*.

---

**Next**: [Chapter 18: Leaderless Replication and Quorum Reads/Writes →](ch18-leaderless-replication.md)
