# Chapter 14: Storage Engines — B-Trees vs LSM Trees

> *Why does the database's internal data structure determine whether my app is fast or slow at scale?*

**Prerequisites**: Basic understanding of databases and indexes (the System Design book's SQL chapter)

---

## Why Storage Engine Internals Matter for Distributed Systems

You might wonder what a data structure chapter is doing in a distributed systems book. The answer: every replicated state machine, every consensus log, every distributed key-value store is backed by a storage engine on each node. The performance characteristics of that engine — read latency, write throughput, space usage, crash recovery time — directly determine the system's behavior under load and during recovery.

When etcd's Raft leader commits an entry, it writes to boltdb (B-tree). When Cassandra accepts a write, it appends to a memtable and eventually flushes to SSTables (LSM tree). When RocksDB backs a Kafka state store, its compaction strategy determines your stream processing latency. Understanding these engines means understanding why your distributed system behaves the way it does.

---

## The Fundamental Problem

A storage engine must solve one problem: **durably store key-value pairs and retrieve them efficiently.** This sounds simple, but the physical constraints of storage hardware force a fundamental trade-off:

- **Sequential I/O is fast.** Writing to the end of a file (append) is the fastest write pattern on both HDDs and SSDs.
- **Random I/O is slow.** Jumping to an arbitrary position to read or write a small piece of data is expensive — catastrophically so on spinning disks, and still significantly slower on SSDs.
- **Reads and writes compete.** Optimizing for fast writes (append-only, sequential) makes reads slow (you have to scan everything). Optimizing for fast reads (sorted, indexed) makes writes slow (you have to maintain the sort order on every insert).

B-trees and LSM trees represent two fundamentally different answers to this trade-off.

---

## B-Trees

B-trees were introduced by Rudolf Bayer and Edward McCreight in 1972 and have been the dominant data structure for databases for over 50 years. PostgreSQL, MySQL (InnoDB), Oracle, SQL Server, and boltdb all use B-tree variants.

### Structure

A B-tree is a balanced tree where:
- Each node is a fixed-size **page** (typically 4 KB–16 KB, matching the OS page size)
- Internal nodes contain **keys and pointers** to child pages
- Leaf nodes contain **keys and values** (or pointers to values)
- All leaves are at the same depth (the tree is balanced)

The **branching factor** is the number of children per internal node. A typical B-tree with 4 KB pages and 256-byte keys has a branching factor of about 500.

```
                        ┌─────────────────┐
                        │  [30]  [60]  [90]│         Root (depth 0)
                        └──┬──────┬─────┬──┘
                   ┌───────┘      │     └────────┐
                   ▼              ▼               ▼
          ┌────────────┐  ┌────────────┐  ┌────────────┐
          │[10][20]    │  │[40][50]    │  │[70][80]    │   Internal (depth 1)
          └─┬───┬───┬──┘  └─┬───┬───┬──┘  └─┬───┬───┬──┘
            ▼   ▼   ▼       ▼   ▼   ▼       ▼   ▼   ▼
           ┌─┐ ┌─┐ ┌─┐    ┌─┐ ┌─┐ ┌─┐    ┌─┐ ┌─┐ ┌─┐   Leaf pages
           │ │ │ │ │ │    │ │ │ │ │ │    │ │ │ │ │ │   (depth 2)
           └─┘ └─┘ └─┘    └─┘ └─┘ └─┘    └─┘ └─┘ └─┘

  Keys ≤10  10<k≤20  20<k≤30  ...
```

### How Many Levels?

With a branching factor of 500:
- Depth 1: 500 keys
- Depth 2: 250,000 keys
- Depth 3: 125,000,000 keys (125 million)
- Depth 4: 62,500,000,000 keys (62.5 billion)

Most B-trees in practice have depth 3 or 4. Since the root and first-level pages are almost always cached in memory, a lookup requires only **1–2 disk reads** — even for billions of keys.

### Lookup (Point Query)

```
function btree_lookup(root, key):
    node = root
    while node is not a leaf:
        i = binary_search(node.keys, key)
        node = read_page(node.children[i])
    i = binary_search(node.keys, key)
    if node.keys[i] == key:
        return node.values[i]
    return NOT_FOUND
```

At each level, a binary search within the page finds the right child pointer. The page is 4–16 KB, so the binary search is fast (it's in memory after the page read). The bottleneck is the disk reads to load each page.

**Cost**: O(log_B(N)) disk reads, where B is the branching factor and N is the number of keys. For B=500, N=100M, that's log_500(100,000,000) ≈ 3 disk reads.

### Insertion

```
function btree_insert(root, key, value):
    leaf = find_leaf_page(root, key)
    if leaf has space:
        insert (key, value) into leaf in sorted order
        write_page(leaf)
    else:
        split leaf into two pages: left, right
        median_key = middle key of the combined entries
        insert median_key into parent, pointing to left and right
        if parent overflows:
            recursively split parent
```

The split operation is what keeps the tree balanced. When a leaf page is full (no room for the new key), it splits into two half-full pages, and the median key is promoted to the parent. If the parent is also full, it splits too, potentially propagating all the way to the root.

### Page Splits Visualized

```
Before insert(25):

  Parent: [20] [40]
            │
    ┌───────┘
    ▼
  Leaf: [21][22][23][24]  ← FULL

After insert(25):

  Parent: [20] [23] [40]     ← 23 promoted
            │    │
    ┌───────┘    └──────┐
    ▼                    ▼
  Leaf: [21][22]    Leaf: [23][24][25]
```

### Write Amplification in B-Trees

Write amplification measures how much physical I/O a single logical write generates.

For a B-tree insert:
1. **Read** the leaf page from disk (1 read)
2. **Modify** the page in memory (add the key)
3. **Write** the modified page back to disk (1 write)
4. **Write** the WAL entry for crash recovery (1 write)

If a split occurs: read and write the leaf (2 I/O), read and write the parent (2 I/O), write the WAL entry. That's 5 I/O operations for a single insert.

The typical write amplification for a B-tree is **10–30x**, meaning each byte of user data results in 10–30 bytes of actual disk I/O. This comes from:
- WAL writes (every modification)
- Page rewrites (the whole 4–16 KB page is rewritten even if only one key changed)
- Page splits (cascading rewrites)
- Background tasks (vacuuming, defragmentation)

### Page-Level Locking

Concurrent access to B-trees requires locking. The standard approach is **latch crabbing** (also called latch coupling):

```
function concurrent_lookup(root, key):
    latch_shared(root)
    node = root
    while node is not a leaf:
        child = find_child(node, key)
        latch_shared(child)
        unlatch(node)          // release parent after acquiring child
        node = child
    result = search_in_leaf(node, key)
    unlatch(node)
    return result
```

For writes, shared latches become exclusive latches, and the protocol is more conservative — you hold the parent's latch until you're sure the child won't split.

This locking strategy means writes to nearby keys in the B-tree can contend on the same leaf page. High-concurrency workloads with hot key ranges can bottleneck on latch contention.

### B-Tree Variants

**B+ Tree**: The standard variant used by most databases. Values are stored only in leaf pages; internal pages contain only keys and child pointers. Leaf pages are linked in a doubly-linked list for efficient range scans. PostgreSQL, MySQL InnoDB, and virtually all relational databases use B+ trees.

```
Internal:  [30]──────[60]──────[90]
            │          │         │
Leaves:   [10,20,30]→[40,50,60]→[70,80,90]→ ...
           ↑──────────↑──────────↑
           Linked list for range scans
```

**B* Tree**: A variant that delays splits by redistributing keys to siblings first. This keeps pages more full (2/3 full instead of 1/2), reducing tree height.

**Copy-on-Write B-Tree (CoW)**: Instead of modifying pages in place, a new version of the page is written to a new location. Used by LMDB and btrfs. This avoids the need for a WAL (the old version is the recovery point) and enables efficient snapshots, but increases write amplification.

---

## LSM Trees

The Log-Structured Merge-tree was introduced by Patrick O'Neil, Edward Cheng, Dieter Gawlick, and Elizabeth O'Neil in 1996. It's the foundation of LevelDB, RocksDB, Cassandra, HBase, ScyllaDB, and many modern distributed databases.

### The Core Idea

Instead of modifying data in place (like B-trees), an LSM tree **buffers writes in memory and periodically flushes them to disk as sorted, immutable files.** Multiple files are then merged together in the background.

This converts random writes into sequential writes — the fastest I/O pattern.

### Structure

An LSM tree has multiple components:

```
  ┌─────────────────────────────┐
  │        Memtable             │   ← In-memory (sorted, e.g., red-black tree)
  │  (active, receives writes)  │
  └─────────────┬───────────────┘
                │ flush (when full)
                ▼
  ┌─────────────────────────────┐
  │     Immutable Memtable      │   ← In-memory, being flushed to disk
  └─────────────┬───────────────┘
                │ write to disk
                ▼
  ┌─────────────────────────────┐
  │        Level 0 (L0)         │   ← SSTables, may overlap in key range
  │  [SST1] [SST2] [SST3]      │
  └─────────────┬───────────────┘
                │ compaction
                ▼
  ┌─────────────────────────────┐
  │        Level 1 (L1)         │   ← SSTables, non-overlapping key ranges
  │  [SST4] [SST5] [SST6]      │
  └─────────────┬───────────────┘
                │ compaction
                ▼
  ┌─────────────────────────────┐
  │        Level 2 (L2)         │   ← Larger, non-overlapping SSTables
  │  [SST7] [SST8] ... [SST15] │
  └─────────────────────────────┘
                │
               ...
```

### The Memtable

The memtable is an in-memory sorted data structure (typically a skip list or red-black tree) that buffers incoming writes. Writes go to the memtable and to the **write-ahead log** (WAL) on disk for durability.

```
function lsm_write(key, value):
    wal.append(key, value)           // durable, sequential write
    memtable.insert(key, value)      // fast, in-memory
    if memtable.size > threshold:
        freeze(memtable)             // make it immutable
        create new empty memtable
        schedule flush of frozen memtable to L0
```

### SSTables (Sorted String Tables)

When the memtable reaches a size threshold (typically 64 MB), it's **flushed** to disk as an **SSTable** — a sorted, immutable file.

An SSTable contains:
1. **Data blocks**: Key-value pairs, sorted by key, grouped into blocks (~4 KB each)
2. **Index block**: Maps key ranges to data block offsets (sparse index)
3. **Bloom filter**: A probabilistic data structure for fast "is this key present?" checks
4. **Metadata**: Compression info, statistics, key range

```
SSTable File Layout:
┌──────────────────────────────────────────┐
│ Data Block 0: [key1:val1, key2:val2, ...] │
├──────────────────────────────────────────┤
│ Data Block 1: [key5:val5, key6:val6, ...] │
├──────────────────────────────────────────┤
│ ...                                      │
├──────────────────────────────────────────┤
│ Index Block: [key1→block0, key5→block1]  │
├──────────────────────────────────────────┤
│ Bloom Filter                             │
├──────────────────────────────────────────┤
│ Footer: offsets to index, filter, meta   │
└──────────────────────────────────────────┘
```

SSTables are immutable — once written, they're never modified. This is a crucial property:
- No locking needed for reads (readers and writers never conflict)
- Simple crash recovery (partially written SSTables are just discarded)
- Efficient caching (an SSTable's contents never change)

### Reading from an LSM Tree

A read must check multiple locations because the data might be in any of them:

```
function lsm_read(key):
    // Check memtable first (most recent writes)
    value = memtable.get(key)
    if value found: return value

    // Check immutable memtable (being flushed)
    value = immutable_memtable.get(key)
    if value found: return value

    // Check SSTables from newest to oldest
    for level in [L0, L1, L2, ...]:
        for sstable in level (newest first):
            // Fast rejection with Bloom filter
            if not sstable.bloom_filter.maybe_contains(key):
                continue
            // Binary search the index, then read the data block
            value = sstable.lookup(key)
            if value found: return value

    return NOT_FOUND
```

**Key insight**: The search order matters. We check newest data first (memtable → L0 → L1 → ...) because a newer write to the same key supersedes older ones. The first match we find is the correct current value.

### The Bloom Filter Optimization

Without Bloom filters, a point lookup in an LSM tree would need to check every SSTable at every level — potentially dozens of disk reads.

A **Bloom filter** is a probabilistic data structure that answers "is this key in this SSTable?" with:
- **Definitely not** (key is absent — skip this SSTable)
- **Probably yes** (key might be present — read the SSTable to find out)

The false positive rate is configurable, typically 1%. With 10 SSTables and a 1% false positive rate, a lookup for a non-existent key reads **0.1 SSTables on average** instead of 10. This transforms a disastrous read path into a manageable one.

```
Bloom Filter Size vs False Positive Rate:
  10 bits per key → ~1% false positive rate
  15 bits per key → ~0.1% false positive rate
  20 bits per key → ~0.01% false positive rate
```

RocksDB defaults to 10 bits per key. For a 100 GB database with 1 billion keys, the Bloom filters consume about 1.2 GB of memory — a worthwhile trade.

### Compaction

Over time, SSTables accumulate. Without cleanup, reads get slower (more SSTables to check) and disk space grows (old versions of keys aren't reclaimed). **Compaction** merges multiple SSTables into fewer, larger ones, discarding old versions of overwritten or deleted keys.

#### Size-Tiered Compaction (STCS)

Used by Cassandra (default), HBase, and ScyllaDB.

Strategy: When several SSTables of similar size accumulate at a level, merge them into one larger SSTable and place it in the next level.

```
Before compaction:
  L0: [SST1 (64MB)] [SST2 (64MB)] [SST3 (64MB)] [SST4 (64MB)]

After compaction:
  L0: (empty)
  L1: [SST_merged (256MB)]
```

Pros:
- High write throughput (fewer compaction operations)
- Simple to implement

Cons:
- **Space amplification**: During compaction, both old and new SSTables exist temporarily. Worst case: 2x the data size. Even steady-state, multiple versions of keys coexist.
- **Read amplification**: SSTables at the same level can overlap in key range, so a read might need to check multiple SSTables.

#### Leveled Compaction (LCS)

Used by LevelDB, RocksDB (default), and Cassandra (optional).

Strategy: Each level has a size limit (typically 10x the previous level). SSTables within a level have **non-overlapping key ranges**. When a level exceeds its limit, one SSTable is picked and merged with the overlapping SSTables in the next level.

```
Level sizes (10x ratio):
  L0:   64 MB (4 files × 16 MB, may overlap)
  L1:  640 MB (non-overlapping)
  L2:  6.4 GB (non-overlapping)
  L3: 64.0 GB (non-overlapping)
```

```
Leveled compaction step:

L1: [a-d][e-h][i-l][m-p][q-t][u-z]   ← pick [e-h], exceeds budget
                │
                ▼ merge with overlapping L2 files
L2: ...[d-f][f-i][i-k]...

Result:
L1: [a-d]     [i-l][m-p][q-t][u-z]    ← [e-h] removed
L2: ...[d-g][g-i][i-k]...              ← new merged files replace old
```

Pros:
- **Low space amplification**: ~10% overhead (compared to STCS's ~100%)
- **Bounded read amplification**: At most one SSTable per level needs to be checked (non-overlapping ranges)
- Predictable read performance

Cons:
- **High write amplification**: A key might be rewritten at every level as it moves from L0 → L1 → L2 → L3. With a 10x size ratio and 4 levels, write amplification can be 40–50x.
- More compaction CPU and I/O overhead

### Write Amplification in LSM Trees

For leveled compaction with a size ratio R (typically 10) and L levels:

```
Write amplification ≈ R × L

Example: R=10, L=4
  Write amplification = 10 × 4 = 40x
```

Each byte of data written by the user is written to disk ~40 times as it gets compacted through the levels. This sounds terrible, but the writes are **sequential** — and sequential I/O can be 100x faster than random I/O on HDDs and 10x faster on SSDs.

For size-tiered compaction, write amplification is lower (typically 4–10x) but space amplification is higher.

### Deletes: Tombstones

Since SSTables are immutable, you can't remove a key by modifying the file. Instead, a **tombstone** — a special marker meaning "this key is deleted" — is written. During compaction, when the tombstone meets the original key-value pair, both are discarded.

```
function lsm_delete(key):
    lsm_write(key, TOMBSTONE)    // write a tombstone marker
```

Until the tombstone is compacted, the deleted key still consumes disk space. In systems with high delete rates, tombstones can accumulate and cause "tombstone bloat." Cassandra operators are particularly familiar with this problem.

---

## Head-to-Head Comparison

### Write Performance

```
B-Tree Write:
  1. Read page from disk (random read)
  2. Modify page in memory
  3. Write page to disk (random write)
  4. Write WAL (sequential write)

LSM Write:
  1. Append to WAL (sequential write)
  2. Insert into memtable (in-memory)
```

**LSM wins for writes.** The write path is one sequential disk write (WAL) and one memory operation. No random I/O. This makes LSM trees 5–10x faster for write-heavy workloads on spinning disks and 2–4x faster on SSDs.

Benchmark data from RocksDB vs boltdb (a B-tree):

```
Sequential writes (100-byte values):
  RocksDB (LSM):  ~400,000 ops/sec
  BoltDB (B-tree): ~50,000 ops/sec

Random writes (100-byte values):
  RocksDB (LSM):  ~300,000 ops/sec
  BoltDB (B-tree): ~15,000 ops/sec
```

### Read Performance

```
B-Tree Read:
  1. Traverse tree: 1-2 disk reads (upper levels cached)
  2. Read leaf page: 1 disk read
  Total: 1-3 disk reads

LSM Read (worst case):
  1. Check memtable: 0 disk reads
  2. Check L0 (4 overlapping SSTables): up to 4 disk reads
  3. Check L1: 1 disk read
  4. Check L2: 1 disk read
  5. Check L3: 1 disk read
  Total: up to 7 disk reads (mitigated by Bloom filters and caching)
```

**B-trees win for point reads** — especially for keys that exist. For non-existent keys, Bloom filters close the gap. For range scans, it depends: B+ trees have the linked leaf list, but LSM trees with leveled compaction have sorted, non-overlapping SSTables that can be scanned efficiently.

### Space Amplification

```
B-Tree:
  Pages are typically 50-70% full (due to splits)
  Space amplification: ~1.5x
  Plus: fragmentation from updates and deletes

LSM (Leveled):
  Old versions exist until compaction removes them
  Space amplification: ~1.1x (10% overhead)

LSM (Size-Tiered):
  Multiple versions coexist across tiers
  Space amplification: ~2x (can spike higher during compaction)
```

### Write Amplification Summary

```
B-Tree:       10-30x (page rewrites, splits, WAL)
LSM (Leveled): 30-50x (rewritten at each level)
LSM (STCS):    4-10x  (fewer compaction passes)
```

Surprisingly, B-trees and leveled LSM trees have comparable write amplification. The difference is that B-tree writes are **random** while LSM writes are **sequential**, so LSM trees still win on raw write throughput despite similar amplification factors.

### The Trade-off Space

```
                    Read Optimized ──────────────▶ Write Optimized
                    
   B-Tree           ████████████░░░░░░░░░░░░░░░░
   LSM (Leveled)    ██████████░░░░░░░░░░░░░░░░░░
   LSM (Size-Tiered)████░░░░░░░░░░░░░░░░░░░░░░░

   ████ = this workload type is fast
   ░░░░ = this workload type is slower
```

---

## Real-World Systems

### PostgreSQL (B-Tree)

PostgreSQL uses B+ trees for all indexes (including the primary key index). The heap (table data) is stored separately as an unordered collection of pages; the B-tree index points to heap tuple locations.

```
B-tree index → (page_number, offset) → heap tuple
```

MVCC (Multi-Version Concurrency Control) means each update creates a new version of the row. Old versions are reclaimed by VACUUM, which is PostgreSQL's equivalent of compaction. An un-vacuumed table accumulates dead tuples, causing "bloat" — analogous to tombstone accumulation in LSM trees.

Write amplification in PostgreSQL:
1. WAL write for the index modification
2. WAL write for the heap modification
3. Actual index page write (when checkpointed)
4. Actual heap page write (when checkpointed)
5. TOAST writes for oversized values

This makes PostgreSQL's effective write amplification quite high (20–50x), which is why write-heavy workloads on PostgreSQL benefit from tuning checkpoint intervals and WAL settings.

### RocksDB / LevelDB (LSM)

RocksDB (Facebook's fork of Google's LevelDB) is the canonical LSM tree implementation. It's used as the storage engine for:
- **CockroachDB** (distributed SQL)
- **TiKV** (distributed key-value, used by TiDB)
- **Apache Flink** (stream processing state backend)
- **Kafka Streams** (state stores)
- **MyRocks** (MySQL with RocksDB backend)

Key RocksDB tuning parameters:

```
// Memtable size (default 64 MB)
write_buffer_size = 128 * 1024 * 1024;

// Number of memtables before stalling writes
max_write_buffer_number = 4;

// L0 file count trigger for compaction
level0_file_num_compaction_trigger = 4;

// L0 file count at which writes start slowing
level0_slowdown_writes_trigger = 20;

// L0 file count at which writes stop entirely
level0_stop_writes_trigger = 36;

// Size ratio between levels (default 10)
max_bytes_for_level_multiplier = 10;

// Bloom filter bits per key
bloom_bits_per_key = 10;

// Compaction style
compaction_style = kCompactionStyleLevel;  // or kCompactionStyleUniversal (STCS)
```

### Cassandra (LSM with Size-Tiered Default)

Cassandra uses an LSM tree storage engine on each node. It defaults to size-tiered compaction but supports leveled compaction for read-heavy workloads.

```sql
-- Size-tiered compaction (write-optimized)
CREATE TABLE events (
    id UUID PRIMARY KEY,
    data TEXT
) WITH compaction = {
    'class': 'SizeTieredCompactionStrategy',
    'min_threshold': 4,
    'max_threshold': 32
};

-- Leveled compaction (read-optimized)
CREATE TABLE users (
    id UUID PRIMARY KEY,
    name TEXT
) WITH compaction = {
    'class': 'LeveledCompactionStrategy',
    'sstable_size_in_mb': 160
};
```

Choosing between them:
- **STCS** for write-heavy tables (event logs, time series, sensor data)
- **LCS** for read-heavy tables with updates (user profiles, session data)

### etcd / boltdb (B-Tree)

etcd uses boltdb, a pure-Go B+ tree implementation. The choice is deliberate: etcd is a coordination service where reads (configuration lookups, watch notifications) vastly outnumber writes (configuration changes). B-trees' superior read performance makes them the right choice for this workload.

boltdb uses copy-on-write (CoW) semantics: writes create new pages rather than modifying existing ones, enabling MVCC-style concurrent readers without locking.

---

## Write Stalls and Compaction Pressure

One of the nastiest operational issues with LSM trees is **write stalls** — periods where the database stops accepting writes because compaction can't keep up.

The chain of events:

```
1. Application writes faster than compaction runs
2. L0 accumulates SSTables (L0 allows overlapping ranges)
3. L0 hits level0_slowdown_writes_trigger → writes are throttled
4. L0 hits level0_stop_writes_trigger → writes are BLOCKED
5. Application sees timeouts and errors
```

This is compaction debt. The database accepted writes faster than it could organize them, and now it needs to pause and catch up. In a distributed system, a write stall on one node can cascade: the node stops responding, failure detection kicks in, the leader assumes it's dead, and failover begins — all because of a storage engine bottleneck.

Mitigation strategies:
- **Rate limiting** writes at the application level
- **Provisioning faster disks** (NVMe SSDs reduce compaction time)
- **Tuning compaction concurrency** (more background threads for compaction)
- **Monitoring compaction pending bytes** and alerting before stalls occur

---

## Hybrid Approaches

### WiscKey: Separating Keys from Values

WiscKey (2016, University of Wisconsin) observed that LSM write amplification comes from rewriting key-value pairs at every compaction level. If values are large, most of the I/O is wasted rewriting values that haven't changed.

Solution: store keys in the LSM tree but store values separately in a log (value log). The LSM tree entries contain only keys and pointers to the value log.

```
LSM Tree:  key → (value_log_offset, value_size)
Value Log: sequential file of values, append-only
```

This reduces write amplification dramatically for large values (since only the small key+pointer is compacted) at the cost of slightly higher read amplification (two reads: one for the key, one for the value).

Used by: Badger (a Go key-value store), TITAN (a RocksDB plugin).

### RocksDB's BlobDB

RocksDB's BlobDB feature (enabled via `enable_blob_files`) implements a similar key-value separation: values above a configurable threshold are stored in separate "blob files" rather than inline in SSTables.

---

## Choosing the Right Engine

| Workload | Best Choice | Why |
|----------|------------|-----|
| Read-heavy, point lookups | B-tree | 1-2 disk reads per lookup, no compaction overhead |
| Write-heavy, append-mostly | LSM (STCS) | Sequential writes, minimal write amplification |
| Mixed read/write | LSM (Leveled) | Good read performance, high write throughput |
| Range scans | B+ tree or LSM (Leveled) | Both have sorted data; B+ tree's leaf list is slightly faster |
| Large values | LSM with KV separation | Avoids rewriting large values during compaction |
| Coordination / metadata | B-tree | Read-dominated, low-latency requirements |
| Time-series / event logs | LSM (STCS) | Append-heavy, rarely updated, sequential time keys |

In a distributed system, the node-level storage engine choice compounds. A Raft-based system with 3 replicas and RocksDB writes data 3× (once per replica) × 40× (compaction amplification) = 120× the original data volume. Understanding these multiplication factors is essential for capacity planning.

---

## Summary

- **B-trees** organize data in a balanced tree of fixed-size pages. They excel at reads (1-3 disk reads per lookup) but pay for random write I/O and page-level locking.
- **LSM trees** buffer writes in memory and flush sorted, immutable files to disk. They excel at writes (sequential I/O) but pay for read amplification (multiple files to check) and compaction overhead.
- **Write amplification** is a key metric: B-trees ~10-30x, LSM leveled ~30-50x, LSM size-tiered ~4-10x. But LSM amplification is sequential I/O, which is much faster.
- **Bloom filters** are essential for LSM read performance — they turn "check every SSTable" into "check only SSTables that probably have the key."
- **Compaction strategy** (size-tiered vs. leveled) is the biggest tuning knob for LSM trees: write-optimized vs. read-optimized.
- **Write stalls** from compaction debt are the most dangerous operational issue with LSM trees in distributed systems.
- The choice of storage engine propagates through the distributed system: replication multiplies every node-level I/O decision.

---

## References

- Bayer, R., & McCreight, E. (1972). *Organization and Maintenance of Large Ordered Indices.* Acta Informatica, 1(3), 173–189.
- O'Neil, P., Cheng, E., Gawlick, D., & O'Neil, E. (1996). *The Log-Structured Merge-Tree (LSM-Tree).* Acta Informatica, 33(4), 351–385.
- Lu, L., Pillai, T. S., Gopalakrishnan, H., Arpaci-Dusseau, A. C., & Arpaci-Dusseau, R. H. (2016). *WiscKey: Separating Keys from Values in SSD-Conscious Storage.* USENIX FAST '16.
- Dong, S., Callaghan, M., Galanis, L., et al. (2017). *Optimizing Space Amplification in RocksDB.* CIDR '17.
- RocksDB Wiki. *Leveled Compaction.* https://github.com/facebook/rocksdb/wiki/Leveled-Compaction
- Athanassoulis, M., et al. (2016). *Designing Access Methods: The RUM Conjecture.* EDBT '16.

---

**Next**: [Chapter 15 — Write-Ahead Logs and Crash Recovery →](ch15-write-ahead-logs.md)

**Previous**: [Chapter 13 — Linearizability →](ch13-linearizability.md)
