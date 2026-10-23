# Chapter 16: GFS Internals — Chunk Servers, Leases, and Atomic Record Append

> **Core Question**: What does a real distributed file system look like under the hood — and how does it tolerate master failures?

> **Prerequisites**: Chapter 3 (Failure Taxonomy), Chapter 7 (Failure Detection), Chapter 15 (Write-Ahead Logs)

---

## Why Study GFS?

The Google File System, published in 2003 by Ghemawat, Gobioff, and Leung, is one of the most influential systems papers ever written. It changed how the industry thinks about distributed storage by making several radical design choices:

1. **Component failures are the norm, not the exception.** GFS was designed to run on thousands of commodity machines where hardware failures happened daily.
2. **Files are huge.** Most files are multi-GB, so the system optimized for large sequential reads and appends rather than small random operations.
3. **Relaxed consistency is acceptable.** GFS traded strict consistency for throughput and simplicity, a choice that shocked the database community but proved pragmatic for Google's workloads.

GFS directly influenced HDFS (Hadoop Distributed File System), which powered the big-data revolution. Understanding GFS's design teaches you the engineering trade-offs at the heart of every large-scale storage system.

---

## Architecture Overview

GFS has three components: a single **master**, many **chunk servers**, and **clients** (application processes that read and write files).

```
                        ┌──────────────┐
                        │    Master     │
                        │  (metadata)   │
                        │              │
                        │ • namespace   │
                        │ • chunk map   │
                        │ • leases      │
                        └──────┬───────┘
                  control      │      control
                  messages     │      messages
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
       ┌────────────┐  ┌────────────┐  ┌────────────┐
       │ChunkServer1│  │ChunkServer2│  │ChunkServer3│  ... hundreds
       │            │  │            │  │            │      more
       │ chunk A    │  │ chunk A    │  │ chunk B    │
       │ chunk C    │  │ chunk B    │  │ chunk C    │
       │ chunk D    │  │ chunk E    │  │ chunk D    │
       └────────────┘  └────────────┘  └────────────┘
              ▲                ▲                ▲
              │       data     │       data     │
              └───────flows────┴───────────────┘
                        ▲
                        │
                   ┌─────────┐
                   │  Client  │
                   └─────────┘
```

### Separation of Control Flow and Data Flow

This is one of GFS's most important design decisions. The client contacts the master only for metadata operations:

- "Where are the chunks of file `/logs/2024-03-15`?"
- "Which chunk server holds chunk `C42` and has the current lease?"

The master replies with chunk locations, and then **the client communicates directly with chunk servers for all data transfer.** The master never sees file data. This keeps the master's load manageable even with thousands of concurrent clients.

```
Read operation:

  Client ──(1)──▶ Master: "Where is /logs/file.dat, byte offset 70M?"
  Master ──(2)──▶ Client: "Chunk #1, on servers {S3, S7, S12}"
  Client ──(3)──▶ S3: "Give me chunk #1"     ← data flows directly
  S3     ──(4)──▶ Client: [64MB of data]      ← master not involved
```

The client caches the chunk location metadata, so subsequent reads to the same file don't hit the master at all.

---

## Chunks: The Storage Unit

GFS divides every file into fixed-size **chunks** of 64MB. Each chunk is stored as a plain Linux file on the chunk server's local disk.

### Why 64MB?

This is much larger than typical file system block sizes (4KB–64KB). The reasons:

1. **Fewer metadata entries.** A 1TB file has only ~16,000 chunks. With 4KB blocks, it would have ~268 million entries. The master keeps all metadata in memory, so chunk count directly limits scalable file system size.

2. **Fewer master interactions.** A client reading sequentially through a multi-GB file needs to ask the master for chunk locations infrequently. With 64MB chunks, a client streaming data at 100MB/s only contacts the master roughly once per second.

3. **Reduced overhead per chunk.** Each chunk requires a TCP connection for transfers. With large chunks, the time spent setting up connections is negligible compared to the time spent transferring data.

4. **Effective use of disk bandwidth.** Large sequential reads and writes amortize disk seek time. A 64MB sequential write saturates the disk's bandwidth.

The downside: **internal fragmentation for small files.** A 1KB file still consumes one chunk, wasting metadata overhead. GFS was designed for Google's workload of multi-GB log files and dataset files; it was never intended for millions of small files.

### Chunk Handles and Versions

Each chunk is identified by a globally unique, immutable 64-bit **chunk handle** assigned by the master at creation time. Chunks also carry a **chunk version number** that increments whenever the master grants a new lease. This version number detects stale replicas — a chunk server that was down during a mutation will have an outdated version number and will be told to garbage-collect its stale copy.

---

## Master Metadata

The master maintains three types of metadata, all in memory:

### 1. The Namespace

The file and directory namespace is a lookup table mapping full pathnames to metadata. It is **not** a traditional hierarchical directory tree — there are no inodes or directory entries. Instead, each path is a key in a flat map with read-write locks for concurrency control.

```
Namespace (in-memory table):
  /logs/2024-03-15/access.log  → {chunks: [C1, C2, C3], owner: "webteam"}
  /data/training/model-v2.bin  → {chunks: [C4, C5, ..., C400], owner: "ml"}
  /tmp/scratch                 → {chunks: [C401], owner: "alice"}
```

This flat namespace with prefix-based locking allows concurrent operations on different files in the same directory without contention. Creating `/home/user/file1` and `/home/user/file2` simultaneously only requires a read lock on `/home/user/` (to prevent its deletion) and a write lock on each file path.

### 2. The Chunk-to-Server Mapping

For each chunk, the master knows which chunk servers currently hold replicas. But crucially, **the master does not persistently store this mapping.** Instead:

- At startup, the master asks each chunk server to report its chunks (a "heartbeat" scan).
- During normal operation, chunk servers send periodic heartbeat messages reporting their chunk inventory.
- The master simply keeps this mapping in memory and rebuilds it from chunk server reports if it restarts.

Why not persist it? Because chunk servers are the ground truth. Disks fail, servers are decommissioned, new servers are added. Persisting the mapping would require keeping it in sync with reality — a distributed consistency problem the GFS designers chose to avoid entirely.

### 3. The Operation Log

The namespace and chunk handle assignments *are* persisted — via a **write-ahead log** (connecting directly to Chapter 15). Every metadata mutation (file creation, deletion, chunk allocation) is recorded in the operation log before the mutation is applied in memory.

```
Operation Log (on master's disk):

  LSN 1001: CREATE /logs/2024-03-15/access.log
  LSN 1002: ALLOCATE chunk C1 for /logs/2024-03-15/access.log offset 0
  LSN 1003: ALLOCATE chunk C2 for /logs/2024-03-15/access.log offset 64MB
  LSN 1004: DELETE /tmp/old-scratch
  ...
```

The operation log is replicated to remote machines for durability. The master responds to a client mutation only after the log record has been flushed to disk locally *and* remotely.

To bound recovery time, the master periodically creates a **checkpoint** — a compact serialized form of the in-memory metadata state (implemented as a B-tree that can be directly memory-mapped). Recovery loads the latest checkpoint and replays only the log records after it.

```
Master recovery:

  1. Load latest checkpoint (B-tree on disk)
     → Namespace and chunk metadata restored to checkpoint time
  2. Replay operation log entries after checkpoint
     → Bring metadata to crash-time state
  3. Wait for chunk server heartbeats
     → Rebuild chunk-to-server mapping from ground truth
  4. Resume serving
```

This is ARIES in miniature: checkpoint + log replay.

---

## The Lease Mechanism

When multiple clients want to write to the same chunk, GFS needs to establish a consistent mutation order. It does this with **leases**.

### How Leases Work

1. When a mutation (write or append) arrives, the master checks whether the target chunk has a current lease.
2. If not, the master picks one of the chunk's replicas as the **primary** and grants it a lease (a time-limited authority to order mutations), typically 60 seconds.
3. The primary assigns a serial number to each mutation it receives, establishing a total order.
4. All replicas apply mutations in this serial-number order.

```
Lease grant:

  Master ──▶ ChunkServer S3: "You are primary for chunk C42, lease expires in 60s"
  S3 acknowledges

  Client asks Master: "Who is the primary for C42?"
  Master ──▶ Client: "S3 is primary, secondaries are S7 and S12"
```

### Lease Renewal and Expiration

- The primary can request lease extensions via heartbeat messages. As long as it's alive and communicating, the master typically extends the lease indefinitely.
- If the primary crashes or becomes unreachable, the master waits for the lease to expire (60 seconds) before granting a new lease to a different replica.
- This guarantees that **at most one primary exists per chunk at any time** — the lease expiration acts as a distributed mutex with a known timeout.

This connects to Chapter 7's discussion of failure detection: the master can't tell if the primary is dead or just slow, but the lease timeout provides an upper bound on how long an unresponsive primary can still act as primary.

### Split-Brain Prevention

The lease mechanism prevents split-brain without requiring a consensus protocol:

- Old primary's lease expires → it stops accepting mutations.
- Master grants a new lease to a different server.
- There's no window where two primaries can accept mutations for the same chunk.

The safety guarantee relies on **clock synchronization**: if the primary's clock runs faster than the master's, its lease might not have expired (by its own clock) when the master grants a new lease. GFS handles this by having primaries use conservative lease durations and masters waiting a bit longer than the granted timeout.

---

## Mutation Protocol: Writes and Appends

### The Write Path

A client write to a specific file offset proceeds as follows:

```
Step 1: Client → Master
  "I want to write to file F at offset X"
  Master returns: primary = S3, secondaries = {S7, S12}, chunk = C42

Step 2: Client → nearest replica (data push)
  Client pushes data to S7 (closest by network topology)
  S7 forwards to S12 (chain replication of data)
  S12 forwards to S3
  Each server stores the data in a local buffer (LRU cache), NOT yet applied

  ┌────────┐ data  ┌────┐ data  ┌─────┐ data  ┌────┐
  │ Client │──────▶│ S7 │──────▶│ S12 │──────▶│ S3 │
  └────────┘       └────┘       └─────┘       └────┘

Step 3: Client → Primary (write request)
  Client sends write request to S3 (primary)
  S3 assigns serial number 42 to this mutation
  S3 applies the mutation to its own local chunk file

Step 4: Primary → Secondaries (apply order)
  S3 tells S7: "Apply buffered data with serial number 42"
  S3 tells S12: "Apply buffered data with serial number 42"

Step 5: Secondaries → Primary (acknowledgment)
  S7 → S3: "Applied #42 successfully"
  S12 → S3: "Applied #42 successfully"

Step 6: Primary → Client
  S3 → Client: "Write succeeded"
  (If any secondary failed, S3 → Client: "Write failed, please retry")
```

**Key insight: data flow and control flow are separated.** In step 2, data flows through a chain of servers chosen by network proximity (to minimize bandwidth usage). In steps 3–5, control messages flow between the primary and secondaries. The data is already at every replica before the primary orders the mutation.

### Atomic Record Append

Record append is GFS's most distinctive operation. Unlike a write (which goes to a specific offset), an append says: "Add this data to the end of the file; GFS chooses the offset."

This was designed for Google's predominant write pattern: hundreds of producers concurrently appending to a shared log file. Record append guarantees:

- **Atomicity**: Each record is appended as a complete unit (no interleaving of different records).
- **At-least-once semantics**: The record will appear at least once in the file, but may appear more than once in case of retries.
- **GFS chooses the offset**: The client doesn't specify where the data goes; GFS picks the offset and returns it.

The protocol is similar to writes, with one key difference in error handling:

```
Record append to chunk C42 (primary = S3):

  1. Client pushes record data to S7, S12, S3 (same chain as writes)
  
  2. Client sends "append" to S3 (primary)
     S3 checks: does the record fit in the current chunk?
     
     If yes:
       S3 assigns offset (e.g., byte 41943040)
       S3 tells S7, S12: "append at offset 41943040"
       All succeed → S3 replies success to client
     
     If no (record would exceed chunk boundary):
       S3 pads the remainder of C42
       S3 tells S7, S12 to pad C42 as well
       S3 tells client: "Retry on next chunk"
       (Client re-contacts master for the next chunk's primary)
     
     If a secondary fails:
       S3 replies failure to client
       Client retries the append
       → The record may now appear on the replicas that succeeded
          AND appear again when the retry succeeds
       → This is why "at-least-once" rather than "exactly-once"
```

### Consistency After Appends

The relaxed consistency model is GFS's most controversial design choice. After record appends, the file regions can be in one of three states:

| State | Meaning |
|-------|---------|
| **Defined** | All replicas have the same data, and it reflects the client's mutation |
| **Consistent but undefined** | All replicas have the same data, but it might be a mix of fragments from different mutations |
| **Inconsistent** | Different replicas have different data for the same offset range |

After a successful record append, the region is **defined**: all replicas have the record at the same offset. But after a failed-then-retried append, the file might have:

```
Chunk on S3:     [record A][record B][record A][record C]
Chunk on S7:     [record A][padding ][record A][record C]  
Chunk on S12:    [record A][record B][record A][record C]

S7 missed record B (failure) but got the retry of A and the subsequent C.
S7's version is inconsistent with S3 and S12 for the region where B should be.
```

GFS applications (like MapReduce) handle this by:
1. Including checksums in each record to detect corruption.
2. Including unique record IDs to deduplicate repeated records.
3. Treating the file as a stream of records, skipping invalid or duplicate entries.

This "push complexity to the application" approach was a deliberate trade-off: simpler infrastructure, faster appends, at the cost of application-level deduplication.

---

## Snapshot

GFS supports nearly instantaneous snapshots of files or directory trees using **copy-on-write**.

```
Snapshot of /data/training/:

  1. Master revokes all outstanding leases on chunks in /data/training/
     (This ensures no in-flight mutations)
  
  2. Master logs the snapshot operation to the operation log
  
  3. Master duplicates the metadata:
     /data/training/model.bin → chunks [C1, C2, C3]
     /snapshots/training-v1/model.bin → chunks [C1, C2, C3]  ← same chunks!
  
  4. Master increments the reference count on chunks C1, C2, C3
  
  No data is copied. Both the original and snapshot point to the same chunks.
```

Copy-on-write happens when a client later tries to *mutate* a chunk with reference count > 1:

```
Client writes to /data/training/model.bin (chunk C1):

  1. Master notices C1 has refcount > 1
  2. Master tells chunk servers holding C1 to make a local copy → C1'
  3. Master updates /data/training/model.bin to point to C1'
  4. Master decrements C1's refcount
  5. New lease is granted for C1'
  6. Write proceeds on C1' (the snapshot still points to the original C1)
```

This is the same copy-on-write technique used by `fork()` in Unix and by database snapshots (like PostgreSQL's `pg_start_backup`). The key advantage: snapshot creation is O(metadata), not O(data).

---

## Fault Tolerance

### Chunk Server Failures

Chunk servers fail regularly — with thousands of machines, multiple failures per day were normal at Google.

**Detection**: The master sends periodic heartbeats to every chunk server. If a chunk server doesn't respond after several attempts, the master marks it as dead.

**Recovery**: The master identifies all chunks that now have fewer replicas than the target (default: 3). It prioritizes re-replication based on:
1. How far below the target the chunk is (a chunk with 1 replica is urgent; 2 replicas is less so).
2. Whether the chunk belongs to a live file (dead files' chunks can wait).
3. Whether the chunk is blocking a client operation.

```
Chunk server failure and re-replication:

  Before: Chunk C42 → {S3, S7, S12}
  
  S7 dies.
  
  Master detects: C42 now has 2 replicas (below target of 3)
  Master selects S15 as the new home (considering disk space, load, rack diversity)
  Master instructs S3: "Copy C42 to S15"
  S3 → S15: [64MB of chunk data]
  
  After: Chunk C42 → {S3, S12, S15}
```

**Rack-aware placement**: GFS distributes chunk replicas across multiple server racks. This way, an entire rack losing power (or its top-of-rack switch failing) doesn't lose all copies of any chunk.

```
Rack 1          Rack 2          Rack 3
┌───────┐      ┌───────┐      ┌───────┐
│  S1   │      │  S5   │      │  S9   │
│  S2   │      │  S6   │      │  S10  │
│  S3   │      │  S7   │      │  S11  │
│  S4   │      │  S8   │      │  S12  │
└───┬───┘      └───┬───┘      └───┬───┘
    │              │              │
    └──── Rack switch ────────────┘

Chunk C42 replicas: S3 (Rack 1), S7 (Rack 2), S11 (Rack 3)
→ Survives any single rack failure
```

### Stale Replica Detection

When a chunk server is down during a mutation, its copy of the chunk becomes stale. GFS detects this using the **chunk version number**:

1. Before granting a new lease, the master increments the chunk version number.
2. The master and all current replicas record the new version number.
3. A chunk server that was down during this lease grant still has the old version.
4. When the stale server comes back and reports its chunks, the master sees the outdated version and tells the server to garbage-collect the stale copy.

```
Before: Chunk C42 version 5, replicas on {S3, S7, S12}

S12 goes down.
Master grants new lease on C42, increments version to 6.
S3 and S7 update to version 6. Mutations proceed.

S12 comes back up.
S12 reports: "I have C42 version 5"
Master: "Version 5 is stale, current is 6. Delete it."
Master schedules re-replication of C42 to another server.
```

### Data Integrity

Each chunk server independently verifies data integrity using **checksums**. Every 64KB block within a chunk has a 32-bit checksum stored separately.

```
Chunk C42 on disk:
┌─────────┬─────────┬─────────┬───────────────┬─────────┐
│ Block 0  │ Block 1  │ Block 2  │ ...           │Block 1023│
│  64KB    │  64KB    │  64KB    │               │  64KB    │
└─────────┴─────────┴─────────┴───────────────┴─────────┘

Checksum file for C42:
┌──────┬──────┬──────┬─────┬────────┐
│ CK 0  │ CK 1  │ CK 2  │ ... │ CK 1023 │
│ 4B    │ 4B    │ 4B    │     │ 4B       │
└──────┴──────┴──────┴─────┴────────┘
```

On reads, the chunk server verifies the checksum before returning data to the client. If a mismatch is detected:
1. The chunk server returns an error to the client.
2. The client reads from a different replica.
3. The chunk server reports the corruption to the master.
4. The master triggers re-replication from a valid replica and tells the corrupt server to delete its copy.

During idle periods, chunk servers scan their chunks and verify checksums proactively, catching bit rot before a client encounters it.

---

## Master Fault Tolerance and Its Limitations

### The Single Master Problem

GFS's most significant architectural limitation is its single master. The master is a single point of failure and a potential bottleneck:

**Single point of failure**: If the master crashes, no new metadata operations can proceed. Clients can still read data from chunk servers using cached metadata, but no new files can be created, no chunks can be allocated, and no re-replication can be triggered.

**Recovery**: The master's operation log and checkpoints are replicated to multiple machines. A monitoring system detects master failure and starts a new master process on a different machine, which loads the latest checkpoint, replays the log, and waits for chunk server heartbeats. This typically takes seconds to tens of seconds.

**Shadow masters**: GFS runs read-only shadow masters that replay the operation log slightly behind the primary. They can serve (slightly stale) read metadata requests, providing some availability during master failover. They cannot serve write requests.

```
Master failover:

  Time 0:    Master on M1 crashes
  Time 5s:   Monitoring detects failure
  Time 10s:  New master started on M2
  Time 12s:  M2 loads checkpoint from replicated storage
  Time 15s:  M2 finishes replaying operation log
  Time 15-60s: M2 collects heartbeats from chunk servers
  Time 60s:  M2 is fully operational
  
  During this window:
  - Reads from cached metadata still work
  - New file creation/deletion is blocked
  - Re-replication of under-replicated chunks is blocked
```

### Scalability Limits

Because all metadata lives in the master's memory, the total number of files and chunks in the system is bounded by the master's RAM:

- Each chunk requires ~64 bytes of metadata.
- Each file requires ~100+ bytes for the namespace entry.
- With 64GB of RAM, the master can track about 1 billion chunks (= ~67 petabytes of file data with 64MB chunks, assuming 3x replication).

In practice, the number of *files* (not chunks) became the bottleneck. Millions of small files each consume a namespace entry, and workloads with many small files pushed the master's memory.

Google eventually replaced GFS with **Colossus**, which:
- Uses a distributed metadata service (multiple masters, sharded by namespace region).
- Reduces chunk size to ~1MB and uses Reed-Solomon erasure coding instead of 3x replication.
- Separates the metadata layer into a scalable distributed system (built on top of Bigtable/Spanner).

---

## Data Flow Optimization

GFS carefully separates data flow from control flow to maximize network utilization:

### Pipelining

When data is pushed to multiple replicas, GFS uses a **linear chain** rather than a tree:

```
Tree topology (NOT used):          Chain topology (used by GFS):
     Client                             Client
    /   |   \                              │
  S3   S7   S12                           S7 ──▶ S12 ──▶ S3
  
  Client sends 64MB × 3 = 192MB          Client sends 64MB × 1 = 64MB
  (3 parallel uploads from client)         Each server forwards as it receives
```

The chain topology has two advantages:

1. **Client bandwidth**: The client only uploads the data once. Each intermediate server forwards data to the next server as it receives it (pipelining), so the total transfer time approaches the time to send the data once, not three times.

2. **Network topology awareness**: GFS picks the chain order based on network distance. The client sends to the closest server; that server forwards to the next closest, and so on. This minimizes cross-rack transfers.

### Pipelining Detail

The forwarding is pipelined at the TCP level — a chunk server starts forwarding bytes as soon as it receives them, without waiting for the full 64MB:

```
Timeline (simplified):

  Client ──────[data streaming]──────▶ S7
                S7 ──────[data streaming]──────▶ S12
                          S12 ──────[data streaming]──────▶ S3

  Total time ≈ (64MB / client_bandwidth) + (2 × network_latency)
  Rather than: 3 × (64MB / bandwidth)
```

With a full-duplex network and pipelining, sending 64MB to 3 replicas takes barely longer than sending it to 1.

---

## Garbage Collection

GFS uses **lazy garbage collection** rather than immediate deletion:

1. When a client deletes a file, the master doesn't immediately reclaim the chunks. Instead, it renames the file to a hidden name with a deletion timestamp.
2. A background garbage collection process periodically scans the namespace, finds hidden files older than a configurable threshold (default: 3 days), and removes their metadata.
3. During heartbeat exchanges, the master tells chunk servers about orphaned chunks (chunks with no file pointing to them), and the chunk servers delete the local data.

This design has several benefits:

- **Simple and reliable**: No complex distributed deletion protocol. If a deletion message to a chunk server is lost, the next heartbeat will carry it again.
- **Accidental deletion recovery**: A deleted file can be "undeleted" within the grace period by renaming it back to a normal path.
- **Background processing**: Reclamation happens during idle periods, not on the critical path of client operations.

The downside: disk space isn't freed immediately. For applications that rapidly create and delete large temporary files, GFS provides an option to bypass lazy deletion for specific directories.

---

## Lessons and Legacy

### What GFS Got Right

1. **Designing for failure.** GFS assumed hardware fails constantly and built failure handling into the core architecture. Checksums, re-replication, and operation log replication are not bolted-on features — they're fundamental design elements.

2. **Separating control and data paths.** Keeping the master out of the data path was the single most important scalability decision. A metadata-only master can coordinate thousands of chunk servers without becoming a bottleneck.

3. **Simplifying with a single master.** While it created a scaling ceiling, the single master dramatically simplified the design. There's no distributed consensus for metadata, no split-brain risk for the master, and recovery is straightforward.

4. **Relaxed consistency for throughput.** For Google's append-heavy workloads, "at least once" delivery with application-level deduplication was the right trade-off. Strict consistency would have required expensive synchronization between replicas.

### What GFS Got Wrong (or Outgrew)

1. **Single master doesn't scale.** As Google's storage needs grew, the master's memory and CPU became bottlenecks. Colossus fixed this with a distributed metadata layer.

2. **64MB chunks waste space for small files.** Workloads evolved to include many small files, making the chunk size a liability.

3. **3x replication is expensive.** Storing 3 copies of everything means 200% storage overhead. Colossus uses erasure coding (e.g., Reed-Solomon 6+3) to achieve similar durability with ~50% overhead.

4. **Relaxed consistency pushes complexity to applications.** Every application using GFS had to handle duplicate records and inconsistent regions. This created a tax on every team building on GFS, which compounded across Google's thousands of internal applications.

5. **Lease timeout = recovery delay.** When a primary crashes, the system waits for the lease to expire (up to 60 seconds) before a new primary can be appointed. This creates a window of unavailability for writes to that chunk.

### GFS → HDFS

Apache HDFS, the open-source implementation inspired by GFS, preserved most of GFS's architecture:

| GFS Concept | HDFS Equivalent |
|------------|-----------------|
| Master | NameNode |
| Chunk server | DataNode |
| Chunk (64MB) | Block (128MB default) |
| Operation log | Edit log |
| Checkpoint | FSImage |
| Shadow master | Secondary NameNode / Standby NameNode |

HDFS later addressed some of GFS's limitations:
- **HDFS Federation** (Hadoop 2.0): Multiple NameNodes, each managing a portion of the namespace, increasing metadata capacity.
- **HDFS High Availability** (Hadoop 2.0): Active/Standby NameNode pair with shared edit log (via a quorum of JournalNodes), eliminating the single-point-of-failure.
- **Erasure Coding** (Hadoop 3.0): Reed-Solomon encoding as an alternative to 3x replication, reducing storage overhead.

---

## Key Takeaways

1. **Separate control from data.** The master handles metadata; chunk servers handle data. This pattern recurs in every large-scale storage system (HDFS NameNode/DataNode, Kafka controller/broker, Ceph monitor/OSD).

2. **Leases provide distributed mutual exclusion without consensus.** A time-limited grant plus clock-bounded expiration ensures at most one primary per chunk. The safety depends on clocks being approximately synchronized — connecting to Chapter 9's discussion of clock skew.

3. **Relaxed consistency is a legitimate design choice** when the workload tolerates it and applications can handle deduplication. But the application-level complexity compounds, and later systems (Spanner, Colossus) chose stronger consistency.

4. **WAL + checkpoints are universal.** The master's operation log and checkpoint are the same recovery mechanism from Chapter 15, applied to metadata rather than table data.

5. **Design for the common case.** GFS optimized for large sequential reads and appends because that was 99% of Google's I/O pattern. The small-file case was deliberately left as a known limitation.

6. **Single master is a valid starting point.** It simplifies the design enormously and works until it doesn't. The lesson is not "never use a single master" but "know when you'll outgrow it and have a migration path."

---

## References

- Ghemawat, Sanjay, Howard Gobioff, and Shun-Tak Leung. "The Google File System." *SOSP '03*, 2003.
- McKusick, Marshall Kirk, and Sean Quinlan. "GFS: Evolution on Fast-Forward." *ACM Queue*, 2009. (Discusses GFS's evolution and Colossus.)
- Shvachko, Konstantin, et al. "The Hadoop Distributed File System." *IEEE MSST '10*, 2010.
- Apache HDFS Architecture Guide. https://hadoop.apache.org/docs/current/hadoop-project-dist/hadoop-hdfs/HdfsDesign.html

---

**Next**: [Part 2 Putting It Together — Vector Clock Chat →](putting-it-together.md)
