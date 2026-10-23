# Chapter 15: Write-Ahead Logs (WAL) and Crash Recovery

> **Core Question**: How does a database survive a power outage without losing the last 10 seconds of writes?

> **Prerequisites**: Chapter 14 (Storage Engines), Chapter 3 (Failure Taxonomy — crash-recovery model)

---

## The Fundamental Problem: Memory Is Volatile

Every database faces the same engineering dilemma. Disk I/O is slow — a random write to a spinning disk takes 5–10ms, and even an NVMe SSD takes 10–20μs per write. To achieve acceptable throughput, databases buffer writes in memory (the **buffer pool**) and flush dirty pages to disk later, in batches.

This works beautifully — until the power goes out.

```
Normal Operation:
                                                         
  Client ──▶ [Buffer Pool (RAM)]  ──periodic flush──▶  [Data Files (Disk)]
              ├─ Page 42 (dirty)                        ├─ Page 42 (stale)
              ├─ Page 87 (dirty)                        ├─ Page 87 (stale)
              └─ Page 13 (clean)                        └─ Page 13 (current)

Power Failure:
                                                         
  [Buffer Pool (RAM)]  ───── LOST ─────▶  💥
  ├─ Page 42 (dirty)  ← gone forever
  ├─ Page 87 (dirty)  ← gone forever
  └─ Page 13 (clean)  ← doesn't matter, disk copy is fine
```

The dirty pages in the buffer pool — the ones modified in memory but not yet written to disk — vanish. The database restarts and finds data files that are *behind*: they reflect a state from some point in the past, missing all modifications that were only in memory.

This is the **crash-recovery model** from Chapter 3: the process stops and restarts, losing all volatile state. The question is whether the system can recover to a correct state using only what survived on durable storage.

### Why Not Just Write to Disk Immediately?

You could flush every write to the data file synchronously. This is called **force** policy: every transaction forces its dirty pages to disk before committing.

The problem is performance. Consider a transaction that updates 50 different rows scattered across 50 different pages. With force policy, that's 50 random disk writes, each taking 5–10ms on a spinning disk. A single transaction now takes 250–500ms, and your throughput collapses to 2–4 transactions per second.

Even on SSDs, forcing every page to disk on commit is wasteful. Data pages are typically 8KB or 16KB, and updating a single integer in a page still requires writing the entire page. The **write amplification** is enormous.

We need a way to make transactions durable without writing data pages synchronously.

---

## The Write-Ahead Log Protocol

The insight behind WAL is a simple observation: **sequential writes are fast.** A spinning disk can write sequentially at 100–200 MB/s. An SSD is even faster. If we can capture *what changed* as a sequential stream of small records, we can make that stream durable without touching the data files.

### The WAL Rule

The protocol has one inviolable rule:

> **Before a dirty page is written to the data file on disk, all log records describing changes to that page must first be written to the log on stable storage.**

This is the "write-ahead" part. The log is always ahead of the data files. If the system crashes, the data files might be stale, but the log contains everything needed to bring them up to date.

### The Commit Rule

A related rule governs when a transaction is considered committed:

> **A transaction is not reported as committed to the client until all of its log records — including the COMMIT record — have been written to stable storage.**

The combination of these two rules provides the guarantee: if the database told a client "your transaction committed," then after any crash, recovery will reconstruct that transaction's effects.

### What "Stable Storage" Means

"Stable storage" means the data survives a crash. In practice, this means:

1. The log record has been written to the OS page cache (`write()`)
2. **AND** the OS has been told to flush it to the physical device (`fsync()` or `fdatasync()`)

A `write()` alone is not enough. The OS buffers writes in its own page cache, and a power failure will lose them. Only after `fsync()` returns successfully can the database consider the data durable.

```
Application Buffer                 OS Page Cache                    Disk Platter/Flash
┌─────────────┐    write()     ┌─────────────┐    fsync()      ┌─────────────┐
│ log record   │─────────────▶│ log record   │───────────────▶│ log record   │
└─────────────┘               └─────────────┘                 └─────────────┘
                                                                    DURABLE
```

There's a subtlety: even `fsync()` can lie. Some disk controllers have volatile write caches and acknowledge writes before data reaches the physical medium. Enterprise drives disable this (or use battery-backed caches), but consumer hardware may not. PostgreSQL's documentation explicitly warns about this.

---

## Log Record Structure

A WAL log record captures the minimum information needed to redo or undo a single modification. Different systems use slightly different formats, but the essential fields are:

```
┌──────────────────────────────────────────────────────────────┐
│                        WAL Log Record                         │
├──────────────┬───────────────────────────────────────────────┤
│ LSN          │ Log Sequence Number — monotonically increasing │
│              │ unique identifier for this record               │
├──────────────┼───────────────────────────────────────────────┤
│ Transaction  │ Which transaction generated this change         │
│ ID           │                                                 │
├──────────────┼───────────────────────────────────────────────┤
│ Prev LSN     │ LSN of the previous record for this same        │
│              │ transaction (forms a per-txn linked list)        │
├──────────────┼───────────────────────────────────────────────┤
│ Type         │ UPDATE, INSERT, DELETE, COMMIT, ABORT,          │
│              │ CHECKPOINT, CLR (Compensation Log Record)        │
├──────────────┼───────────────────────────────────────────────┤
│ Page ID      │ Which data page was modified                    │
├──────────────┼───────────────────────────────────────────────┤
│ Offset       │ Position within the page                        │
├──────────────┼───────────────────────────────────────────────┤
│ Before Image │ The old value (needed for undo)                 │
├──────────────┼───────────────────────────────────────────────┤
│ After Image  │ The new value (needed for redo)                 │
└──────────────┴───────────────────────────────────────────────┘
```

### Log Sequence Numbers (LSN)

The LSN is the most important field. It serves as both an identifier and a clock:

- It's monotonically increasing, so it provides a total order on all modifications.
- Each data page stores the LSN of the most recent log record applied to it (the **page LSN**).
- During recovery, comparing a page's stored LSN against the log's LSN tells us whether that page is behind and needs redo.

In PostgreSQL, the LSN is a 64-bit integer representing the byte offset in the WAL stream. In MySQL/InnoDB, it's a similar byte offset in the redo log.

### Before and After Images

The **before image** captures what the data looked like before the modification. The **after image** captures the result. Together, they make the log record both *redoable* (apply the after image to produce the new state) and *undoable* (apply the before image to revert to the old state).

Some systems use **physiological logging**: instead of storing literal before/after byte values, they store the operation itself (e.g., "increment counter at offset 42 by 1"). This is more compact but requires that the operation be deterministic and the page be in a consistent physical state.

### A Concrete Example

Consider a bank transfer: move $100 from account A (page 7) to account B (page 13).

```
LSN  TxnID  Type     Page  Before  After   Description
───  ─────  ──────   ────  ──────  ─────   ───────────
101  T1     UPDATE   7     500     400     Debit A: $500 → $400
102  T1     UPDATE   13    300     400     Credit B: $300 → $400
103  T1     COMMIT   -     -       -       T1 commits
```

After LSN 103 is written to stable storage and `fsync()`'d, the database can tell the client the transfer succeeded. At this point:

- Pages 7 and 13 in the buffer pool reflect the new balances (400 and 400).
- Pages 7 and 13 on disk might still show the *old* balances (500 and 300).
- The WAL on disk contains records 101–103, which is everything needed to reconstruct the new state.

If the system crashes before pages 7 and 13 are flushed, recovery will replay records 101 and 102, bringing the pages up to date.

---

## The ARIES Recovery Algorithm

ARIES (**A**lgorithms for **R**ecovery and **I**solation **E**xploiting **S**emantics) is the gold-standard recovery algorithm, published by Mohan et al. at IBM Research in 1992. Nearly every major relational database uses some variant of ARIES.

ARIES operates on three principles:

1. **Write-Ahead Logging**: Log before data page, as described above.
2. **Repeating History During Redo**: During recovery, retrace every action the database performed before the crash, including actions of uncommitted transactions. This restores the database to the exact state it was in at the moment of the crash.
3. **Logging Changes During Undo**: When undoing an uncommitted transaction's changes during recovery, write **Compensation Log Records** (CLRs) to the log so that if we crash *again* during recovery, we don't redo already-undone work.

### The Three Phases

Recovery proceeds in three phases:

```
WAL on disk (after crash):
┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┐
│ ... │ CKP │ ... │ UPD │ UPD │ CMT │ UPD │ UPD │ UPD │ ... │
└─────┴──┬──┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┘
         │
    Last Checkpoint
         │
         ▼
   ┌─────────────┐      ┌──────────┐      ┌──────────┐
   │  1. ANALYSIS │─────▶│  2. REDO  │─────▶│  3. UNDO  │
   │  (scan fwd)  │      │ (scan fwd)│      │ (scan bwd)│
   └─────────────┘      └──────────┘      └──────────┘
```

#### Phase 1: Analysis

Starting from the most recent checkpoint, scan the log forward to the end. The goal is to determine:

1. **Which transactions were active at the time of the crash** (the "loser" transactions that need to be undone).
2. **Which pages might be dirty** (the "dirty page table" — pages that might need redo).

The analysis phase reconstructs two in-memory data structures:

- **Transaction Table**: Maps each transaction ID to its status (in-progress, committed, aborted) and the LSN of its most recent log record.
- **Dirty Page Table**: Maps each potentially dirty page ID to the LSN of the earliest log record that might have dirtied it (the **recovery LSN**).

```python
def analysis_phase(log, checkpoint):
    txn_table = checkpoint.txn_table.copy()
    dirty_page_table = checkpoint.dirty_page_table.copy()
    
    for record in log.scan_forward_from(checkpoint.lsn):
        if record.type == COMMIT:
            txn_table.remove(record.txn_id)
        elif record.type == ABORT:
            txn_table.remove(record.txn_id)
        else:
            # Transaction is active (or becomes active)
            txn_table[record.txn_id] = record.lsn
            
            if record.page_id not in dirty_page_table:
                dirty_page_table[record.page_id] = record.lsn
    
    return txn_table, dirty_page_table
    # txn_table now contains "loser" transactions
    # dirty_page_table now contains pages that may need redo
```

#### Phase 2: Redo

Scan the log forward again, starting from the *smallest recovery LSN* in the dirty page table. For each log record:

1. If the record's page is not in the dirty page table, skip it (page is clean).
2. If the record's LSN is less than the dirty page table's recovery LSN for that page, skip it (page was already up to date past this point).
3. Otherwise, read the page from disk. If the page's on-disk LSN is less than the record's LSN, apply the record's after image (redo the change). If the page's LSN is already >= the record's LSN, skip it (the change was already flushed to disk before the crash).

```python
def redo_phase(log, dirty_page_table):
    start_lsn = min(dirty_page_table.values())
    
    for record in log.scan_forward_from(start_lsn):
        if record.page_id not in dirty_page_table:
            continue
        if record.lsn < dirty_page_table[record.page_id]:
            continue
        
        page = read_page_from_disk(record.page_id)
        if page.lsn < record.lsn:
            apply_after_image(page, record)
            page.lsn = record.lsn
            # Don't need to flush immediately; the WAL rule still holds
```

A critical property of redo: **it replays everything, including changes from uncommitted transactions.** This is "repeating history." An uncommitted transaction's partial changes get written back to the data pages. The next phase (undo) will clean them up.

Why repeat history for uncommitted changes? Because ARIES needs the database in the exact pre-crash state before it can correctly undo loser transactions. The undo operations use the before images, which only make sense when applied to the state the page was in right before the crash.

#### Phase 3: Undo

Process the "loser" transactions identified in the analysis phase. Starting from the end of the log, scan backward, undoing each loser's changes in reverse order.

For each undo operation, ARIES writes a **Compensation Log Record** (CLR). The CLR records the undo action and includes a pointer (the **undo-next LSN**) to the next record that needs to be undone for this transaction.

```python
def undo_phase(log, txn_table):
    # Collect the last LSN of each loser transaction
    to_undo = [(txn_table[txn_id], txn_id) for txn_id in txn_table]
    # Process in reverse LSN order (most recent first)
    to_undo.sort(reverse=True)
    
    while to_undo:
        lsn, txn_id = to_undo.pop(0)
        record = log.read(lsn)
        
        if record.type == CLR:
            # This is a compensation record from a previous failed recovery
            # Follow its undo-next pointer
            if record.undo_next_lsn is not None:
                to_undo.append((record.undo_next_lsn, txn_id))
                to_undo.sort(reverse=True)
        else:
            # Undo this record: apply the before image
            page = read_page_from_disk(record.page_id)
            apply_before_image(page, record)
            
            # Write a CLR so we don't redo this undo if we crash again
            clr = CLR(
                txn_id=txn_id,
                page_id=record.page_id,
                undo_next_lsn=record.prev_lsn  # next record to undo
            )
            log.append(clr)
            
            if record.prev_lsn is not None:
                to_undo.append((record.prev_lsn, txn_id))
                to_undo.sort(reverse=True)
    
    # Write ABORT records for all losers
    for txn_id in txn_table:
        log.append(AbortRecord(txn_id))
```

### Why CLRs Matter

CLRs solve the **crash during recovery** problem. Suppose the system crashes mid-undo. Without CLRs, the next recovery attempt would redo the changes (phase 2 repeats history), then try to undo them again — but some were already undone, and undoing an undo produces the wrong result.

With CLRs, the redo phase replays the CLR (which redoes the undo), and the undo phase sees the CLR's undo-next pointer, skipping past the already-undone record.

```
Original log:
  LSN 100: T1 UPDATE page 7 (A: 500 → 400)
  LSN 101: T1 UPDATE page 13 (B: 300 → 400)
  *** CRASH ***

Recovery attempt 1:
  Redo: replay 100, 101
  Undo: undo 101 → write CLR at LSN 200 (B: 400 → 300, undo-next=100)
  *** CRASH DURING UNDO ***

Recovery attempt 2:
  Redo: replay 100, 101, 200 (the CLR is redone like any other record)
  Undo: T1 still a loser. Last record is CLR at 200. 
         CLR's undo-next = 100, so skip 101 (already undone).
         Undo 100 → write CLR at LSN 201 (A: 400 → 500, undo-next=null)
         Done. Write ABORT for T1.
```

ARIES guarantees that recovery is **idempotent**: you can crash and restart recovery any number of times, and the result is always the same correct state.

---

## Checkpointing

Without checkpointing, recovery must scan the *entire* log from the very beginning. After running for months, the log could be terabytes long. Checkpointing bounds the recovery window.

### Fuzzy Checkpointing

A **fuzzy checkpoint** is the standard approach in modern systems. It does *not* require flushing all dirty pages to disk (that would stall the entire database). Instead, it:

1. Writes a `BEGIN_CHECKPOINT` record to the log.
2. Captures a snapshot of the transaction table and dirty page table.
3. Writes an `END_CHECKPOINT` record containing those snapshots.
4. Updates a special "master record" on disk pointing to this checkpoint's LSN.

```
Timeline:
  ... normal operations ...
  │
  ├── BEGIN_CHECKPOINT (LSN 5000)
  │     ongoing transactions continue writing
  ├── END_CHECKPOINT (LSN 5050)
  │     contains: txn_table snapshot, dirty_page_table snapshot
  │
  ... normal operations continue ...
```

During recovery, the analysis phase starts at the checkpoint rather than the beginning of the log. The dirty page table from the checkpoint tells the redo phase where to start scanning. This typically reduces recovery time from "scan the entire log" to "scan the last few minutes of log."

### How Often to Checkpoint

Checkpointing has a trade-off:
- **More frequent checkpoints** → shorter recovery time, but more overhead during normal operation.
- **Less frequent checkpoints** → longer recovery time, but less overhead.

PostgreSQL triggers a checkpoint when a configurable amount of WAL has been written (default: 1GB via `max_wal_size`). MySQL/InnoDB checkpoints when the redo log is 75% full.

---

## Group Commit

`fsync()` is expensive — even on SSDs, it takes 100μs–1ms because the drive must ensure data reaches non-volatile storage. If every transaction individually calls `fsync()`, throughput is limited to 1000–10000 transactions per second.

**Group commit** batches multiple transactions' log records into a single `fsync()`:

```
Without group commit:
  T1 writes log → fsync() → T1 commits
  T2 writes log → fsync() → T2 commits
  T3 writes log → fsync() → T3 commits
  Total: 3 fsync() calls

With group commit:
  T1 writes log ─┐
  T2 writes log ──┼─▶ single fsync() → T1, T2, T3 all commit
  T3 writes log ─┘
  Total: 1 fsync() call
```

The implementation:

1. Transactions write their log records to a shared log buffer in memory.
2. When a transaction wants to commit, it marks itself as "waiting for sync."
3. A dedicated background thread (or one of the waiting transactions) periodically calls `fsync()` on the log.
4. After `fsync()` completes, all transactions whose COMMIT records were included in the flush are notified that they can report success to their clients.

PostgreSQL implements this with the `commit_delay` and `commit_siblings` settings. If there are multiple transactions ready to commit, PostgreSQL delays the `fsync()` briefly to batch more records together.

```
Timeline with group commit (PostgreSQL):

  T1 COMMIT record written to WAL buffer ──┐
  T2 COMMIT record written to WAL buffer ──┤
      (commit_delay: wait up to 10μs)       │
  T3 COMMIT record written to WAL buffer ──┤
                                            ▼
                                    Single fsync()
                                            │
                        ┌───────────────────┼───────────────────┐
                        ▼                   ▼                   ▼
                  T1 "committed"      T2 "committed"      T3 "committed"
```

Group commit can increase throughput by 10x or more on workloads with many small transactions.

---

## fsync and the Durability Contract

The entire WAL protocol rests on one assumption: that `fsync()` actually makes data durable. In practice, this is more nuanced than it sounds.

### The fsync Hierarchy

```
Durability level:            Survives:
──────────────────────────────────────────────────────
write()                      Process crash (not OS crash)
fdatasync()                  OS crash (not power failure on some HW)
fsync()                      OS crash (not power failure on some HW)
fsync() + disk cache off     Power failure
fsync() + battery-backed     Power failure (with battery lifetime)
```

- `write()` copies data to the OS page cache. Survives a process crash (the kernel still has it) but not an OS crash or power failure.
- `fdatasync()` flushes data to the device, but not the file's metadata (size, timestamps). Slightly cheaper than `fsync()`.
- `fsync()` flushes both data and metadata to the device. But if the disk has a volatile write cache, the data might be in that cache, not yet on the platter/flash.
- **Disabling the disk write cache** (via `hdparm -W 0` on Linux, or using enterprise drives that don't cache) ensures `fsync()` truly means "on stable storage."

### The PostgreSQL fsync Bug (2018)

In 2018, PostgreSQL developers discovered a subtle bug in how Linux handles `fsync()` errors. If `fsync()` fails (e.g., due to an I/O error), Linux marks the page as clean anyway. A subsequent `fsync()` call won't retry writing the failed page because the kernel no longer considers it dirty.

This means: if an I/O error occurs, the database might believe data is durable when it's not. PostgreSQL's response was to add explicit error checking and, in some cases, to panic (crash intentionally) when `fsync()` fails, because continuing with potentially lost data is worse than crashing.

This is a real example of the crash-recovery model from Chapter 3: sometimes the safest response to an ambiguous failure is to crash and let recovery handle it.

---

## Steal and No-Force: The WAL Policy Space

Database buffer management policies are described along two axes:

|            | **Force** (flush dirty pages on commit) | **No-Force** (don't flush on commit) |
|------------|----------------------------------------|--------------------------------------|
| **Steal** (can evict dirty uncommitted pages) | Steal/Force | **Steal/No-Force** (ARIES) |
| **No-Steal** (never evict dirty uncommitted pages) | No-Steal/Force | No-Steal/No-Force |

- **Steal**: The buffer pool can write ("steal") a dirty page from an uncommitted transaction to disk, to free up memory. This requires *undo* capability (before images in the log).
- **No-Force**: Dirty pages from committed transactions don't have to be flushed immediately. This requires *redo* capability (after images in the log).

ARIES uses **Steal/No-Force**, which gives maximum flexibility:
- *Steal* means the buffer pool never runs out of space waiting for transactions to commit.
- *No-Force* means commits are fast (only a log write + fsync, no data page writes).
- The cost: recovery needs both redo and undo, making the recovery algorithm more complex.

The simpler **No-Steal/Force** approach needs neither redo nor undo (committed changes are always on disk, uncommitted changes are never on disk), but it severely limits concurrency and buffer pool efficiency.

---

## WAL in Real Systems

### PostgreSQL WAL

PostgreSQL stores its WAL as a sequence of 16MB segment files in the `pg_wal/` directory (named like `000000010000000000000001`).

Key implementation details:
- Log records use physiological logging: they describe operations on pages rather than byte-level before/after images.
- WAL records are identified by their byte offset (the LSN), which PostgreSQL exposes as a `pg_lsn` type.
- `pg_current_wal_lsn()` returns the current write position.
- Streaming replication works by shipping WAL segments to replicas, which replay them — the same recovery mechanism used after a crash.

```sql
-- Check current WAL position
SELECT pg_current_wal_lsn();
-- Result: 0/1A3B4C8

-- Check how much WAL a transaction generated
SELECT pg_current_wal_lsn() AS before;
-- ... run transaction ...
SELECT pg_current_wal_lsn() AS after;
-- Difference shows bytes of WAL generated
```

### SQLite WAL Mode

SQLite's WAL mode (enabled with `PRAGMA journal_mode=WAL`) takes a different approach than traditional databases:

- Instead of a circular log that's replayed into the main database, SQLite's WAL is a separate file that *readers consult alongside the main database*.
- Readers check the WAL for the most recent committed version of each page. If a page is in the WAL, they use that version; otherwise, they read from the main database file.
- A background process (**checkpointing**) periodically transfers WAL pages back to the main database file.

This gives SQLite concurrent readers and a single writer without reader-writer locks — readers never block writers and writers never block readers.

```
┌──────────────────┐     ┌─────────────────┐
│   Main DB File    │     │    WAL File      │
│                   │     │                  │
│  Page 1 (v1)      │     │  Page 1 (v3)     │  ← reader sees v3
│  Page 2 (v1)      │     │  Page 3 (v2)     │  ← reader sees v2
│  Page 3 (v1)      │     │  Page 1 (v4)     │  ← reader sees v4
│  Page 4 (v1)      │     │                  │
└──────────────────┘     └─────────────────┘
                                │
                    Checkpoint: move committed
                    pages back to main DB file
```

### etcd WAL

etcd, the distributed key-value store used by Kubernetes, uses a WAL for local durability of its Raft log entries:

1. A Raft leader receives a write request.
2. The leader appends the entry to its local WAL and `fsync()`s.
3. The leader sends the entry to followers.
4. Each follower appends to its own local WAL and `fsync()`s before acknowledging.
5. Once a majority have acknowledged, the entry is committed.

The WAL here serves double duty: it provides crash recovery *and* it's the physical representation of the Raft log. If an etcd node crashes and restarts, it reads its WAL to reconstruct its Raft log state, then contacts the leader to catch up on any entries it missed.

```
etcd node crash recovery:

  1. Read WAL from disk
     → Reconstruct: last applied index, last committed index, current term
  2. Read snapshot (periodic checkpoint of the key-value state)
     → Restore key-value store to snapshot state
  3. Replay WAL entries after the snapshot
     → Bring key-value store to the state at the time of crash
  4. Contact Raft leader
     → Receive any entries committed after the crash
  5. Resume normal operation
```

---

## WAL as the Foundation of Distributed Replication

The connection between WAL and distributed systems is profound: **the Raft log is a distributed WAL.**

In a single-node database:
- The WAL provides durability: surviving crashes.
- Recovery replays the WAL to restore state.

In a Raft-based replicated state machine:
- The Raft log provides both durability *and* consistency across replicas.
- A new or recovering replica replays the log from the leader to reach the current state.
- The log is the single source of truth, and all replicas must agree on its contents.

```
Single-node WAL:                    Raft distributed log:

  Client ──▶ WAL ──▶ State          Client ──▶ Leader's WAL ──▶ Leader's State
                                                    │
                                                    ├──▶ Follower 1's WAL ──▶ F1's State
                                                    └──▶ Follower 2's WAL ──▶ F2's State
```

The key difference: in a single-node system, `fsync()` on one machine makes an entry durable. In Raft, an entry is durable when a *majority* of nodes have `fsync()`'d it. This survives not just power failures but entire machine losses.

PostgreSQL's streaming replication makes this connection explicit: it ships the WAL stream to replicas, which apply it locally. Synchronous replication waits for the replica to acknowledge receipt (and optionally `fsync()`) before reporting the transaction as committed — achieving a durability guarantee that spans machines.

---

## The WAL Performance Equation

Putting the pieces together, here's how WAL transforms the performance characteristics of a database:

### Without WAL (Force/No-Steal)

```
Commit latency = N × random_write_latency
                 where N = number of dirty pages

Example: 50 dirty pages × 5ms random write = 250ms per transaction
Throughput: ~4 TPS (transactions per second)
```

### With WAL (No-Force/Steal + Group Commit)

```
Commit latency = log_write_latency + fsync_latency (amortized via group commit)
               ≈ sequential_write(few KB) + fsync() / batch_size
               ≈ 10μs + 200μs / 10
               ≈ 30μs per transaction

Throughput: ~33,000 TPS
```

That's a roughly **8000x improvement** in throughput. This is why every serious database uses WAL.

The trade-off: recovery after a crash is slower (must replay the log) and the system is more complex. But crashes are rare, and recovery typically completes in seconds to minutes even for large databases.

---

## Common Pitfalls

### 1. Forgetting to fsync the Directory

On Linux, creating a new WAL segment file requires `fsync()` on the *directory* that contains it, not just the file itself. Without this, the directory entry might not be durable — after a crash, the file could exist with its data intact, but the directory might not have an entry pointing to it.

PostgreSQL explicitly `fsync()`s the directory after creating each new WAL segment.

### 2. WAL Disk Runs Out of Space

If the WAL disk fills up, the database cannot write new log records, which means it cannot process any writes. This effectively halts the system. Worse, if the system crashes in this state, recovery might fail because it can't write CLRs during undo.

Best practice: put the WAL on a dedicated disk (or volume) separate from the data files, and monitor its free space aggressively.

### 3. Torn Writes

A power failure during a write can result in a partially written page — the first 4KB is new data, the second 4KB is old data. This is a **torn write**.

WAL records are protected against torn writes by including checksums. During recovery, a partially written record at the end of the log is detected and discarded. But torn writes to *data pages* are trickier. InnoDB solves this with the **doublewrite buffer**: it writes each dirty page to a sequential buffer first, `fsync()`s, then writes to the actual location. If a torn write corrupts the data file, the intact copy in the doublewrite buffer can restore it.

PostgreSQL uses **full-page writes**: the first time a page is modified after a checkpoint, the entire page (not just the changed bytes) is logged. During recovery, the full-page image guarantees a consistent starting point even if the on-disk page has a torn write.

### 4. WAL Archival and Point-in-Time Recovery

WAL isn't just for crash recovery. By archiving old WAL segments (instead of recycling them), you can perform **point-in-time recovery**: restore a base backup, then replay WAL up to any arbitrary point in time.

```
Full backup (Sunday) + archived WAL segments → restore to any moment this week

  Sunday backup ──▶ replay Mon WAL ──▶ replay Tue WAL ──▶ ... ──▶ stop at target
```

This is how PostgreSQL's `pg_basebackup` and continuous archiving work, and it's the mechanism behind AWS RDS's "restore to any point in time within 35 days" feature.

---

## Key Takeaways

1. **WAL exists because random I/O is slow and memory is volatile.** By converting random data page writes into sequential log writes, WAL makes transactions durable without sacrificing throughput.

2. **The WAL rule — log before data — is the single invariant** that makes everything work. Every other optimization (group commit, fuzzy checkpoints, steal/no-force) builds on this rule.

3. **ARIES recovery has three phases**: analysis (what's dirty?), redo (repeat history), undo (roll back losers). CLRs make recovery idempotent and safe even if the system crashes mid-recovery.

4. **fsync() is the durability boundary.** Everything above fsync is optimistic caching; everything below is durable. Understanding where this boundary lies is essential for reasoning about data loss.

5. **WAL is the conceptual ancestor of the Raft log.** The jump from single-node crash recovery to distributed consensus is smaller than it appears: both are about maintaining a durable, ordered log of state changes and replaying it to recover.

---

## References

- Mohan, C., et al. "ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using Write-Ahead Logging." *ACM Transactions on Database Systems*, 1992.
- PostgreSQL Documentation: "Reliability and the Write-Ahead Log." https://www.postgresql.org/docs/current/wal.html
- Zheng, Mai, et al. "Understanding the Robustness of SSDs under Power Fault." *FAST '13*.
- Pillai, Thanumalayan S., et al. "All File Systems Are Not Created Equal: On the Complexity of Crafting Crash-Consistent Applications." *OSDI '14*.
- Alagappan, Ramnatthan, et al. "Correlated Crash Vulnerabilities." *OSDI '16*.

---

**Next**: [Chapter 16 — GFS Internals: Chunk Servers, Leases, and Atomic Record Append →](ch16-gfs-internals.md)
