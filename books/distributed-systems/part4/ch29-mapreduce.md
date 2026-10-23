# Chapter 29: MapReduce — The Fault-Tolerant Batch Execution Model

> **Core Question**: How does Google process 20 petabytes per day reliably even when 10% of machines crash mid-job?

**Prerequisites**: Chapter 16 (GFS Internals), Chapter 3 (Failure Taxonomy), Chapter 7 (Failure Detection)

---

## The Problem That Created MapReduce

By 2003, Google engineers were writing hundreds of ad-hoc programs that processed massive datasets: building the web search index, counting page access logs, computing the graph structure of the web. Each program needed to solve the same hard problems — distributing data across thousands of machines, handling machine failures, and scheduling work efficiently. The computation itself was often simple. The distribution and fault tolerance were not.

Jeff Dean and Sanjay Ghemawat recognized the pattern: if you forced every computation into a rigid two-phase structure — **map** then **reduce** — the framework could handle all the distributed systems complexity, and programmers could focus purely on their application logic.

The result was MapReduce (Dean & Ghemawat, OSDI 2004), which became the engine behind Google's web indexing pipeline and spawned the entire "big data" ecosystem.

---

## The Programming Model

MapReduce borrows from functional programming. The user provides two functions:

### Map

```
map(key, value) → list of (intermediate_key, intermediate_value)
```

The map function takes one input record and produces zero or more intermediate key-value pairs. It processes records independently — no state is shared between map invocations.

### Reduce

```
reduce(intermediate_key, list of intermediate_values) → list of output_values
```

The reduce function takes all intermediate values associated with a single intermediate key and combines them into a (typically smaller) set of output values.

### Example: Word Count

The canonical example — count the frequency of every word across a corpus of documents:

```python
def map(document_name, document_contents):
    for word in document_contents.split():
        emit(word, 1)

def reduce(word, counts):
    emit(word, sum(counts))
```

Input:
```
doc1: "the cat sat on the mat"
doc2: "the dog sat on the log"
```

Map output (from doc1):
```
("the", 1), ("cat", 1), ("sat", 1), ("on", 1), ("the", 1), ("mat", 1)
```

Map output (from doc2):
```
("the", 1), ("dog", 1), ("sat", 1), ("on", 1), ("the", 1), ("log", 1)
```

After shuffle and sort (grouped by key):
```
"cat"  → [1]
"dog"  → [1]
"log"  → [1]
"mat"  → [1]
"on"   → [1, 1]
"sat"  → [1, 1]
"the"  → [1, 1, 1, 1]
```

Reduce output:
```
"cat" → 1, "dog" → 1, "log" → 1, "mat" → 1, "on" → 2, "sat" → 2, "the" → 4
```

### Other Examples

| Task | Map Function | Reduce Function |
|------|-------------|----------------|
| **Distributed grep** | Emit line if it matches pattern | Identity (pass through) |
| **URL access frequency** | Emit (URL, 1) for each log entry | Sum all counts per URL |
| **Reverse web-link graph** | For each link on page `source` to `target`, emit (target, source) | Concatenate all sources per target |
| **Inverted index** | For each word in document, emit (word, document_id) | Sort and emit (word, list of document_ids) |
| **Term frequency per host** | Emit (hostname, term_vector) for each document | Sum term vectors per host |

The key insight: each of these computations requires scanning terabytes of data, but the logic fits in 20 lines. The distribution, scheduling, and fault tolerance — the hard parts — are identical across all of them.

---

## Execution Overview

A MapReduce job runs on a cluster of commodity machines (Google's production cluster in 2004 had ~1,800 machines with 4GB RAM each). Here is how a single job executes:

```
                         ┌─────────────┐
                         │   Master    │
                         │ (Coordinator)│
                         └──────┬──────┘
                    Assigns tasks│Monitors health
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
     ┌────────────┐    ┌────────────┐     ┌────────────┐
     │ Map Worker  │    │ Map Worker  │     │ Map Worker  │
     │   (M=0)     │    │   (M=1)     │     │   (M=2)     │
     └──────┬─────┘    └──────┬─────┘     └──────┬─────┘
            │                 │                   │
       Read input        Read input          Read input
       split 0           split 1             split 2
       from GFS          from GFS            from GFS
            │                 │                   │
            ▼                 ▼                   ▼
     Write intermediate  Write intermediate  Write intermediate
     to local disk       to local disk       to local disk
     (R partitions)      (R partitions)      (R partitions)
            │                 │                   │
            └─────────────────┼───────────────────┘
                              │ Shuffle (pull)
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │Reduce Worker│  │Reduce Worker│  │Reduce Worker│
     │   (R=0)     │  │   (R=1)     │  │   (R=2)     │
     └──────┬─────┘  └──────┬─────┘  └──────┬─────┘
            │               │               │
            ▼               ▼               ▼
     Write output     Write output     Write output
     file 0 to GFS   file 1 to GFS   file 2 to GFS
```

### Step-by-Step Execution

**Step 1: Input Splitting**

The MapReduce library splits the input files into M pieces, typically 16–64 MB each (matching the GFS chunk size from Chapter 16). The number of splits M determines the number of map tasks.

**Step 2: Master Assignment**

One copy of the program is designated the **master**; the rest are **workers**. The master assigns M map tasks and R reduce tasks to idle workers. A single master maintains the state of every task (idle, in-progress, completed).

**Step 3: Map Phase**

A map worker reads the contents of its input split, parses key-value pairs, and passes each to the user-defined map function. The intermediate key-value pairs are buffered in memory.

**Step 4: Partitioning and Local Write**

Periodically, the buffered intermediate pairs are written to **local disk**, partitioned into R regions by a partitioning function. The default is:

```
partition(key) = hash(key) mod R
```

This ensures all occurrences of a given key land in the same reduce partition. The locations of these partitions on the local disk are reported back to the master, who forwards them to reduce workers.

**Step 5: Shuffle (Remote Read)**

When a reduce worker is notified of partition locations, it uses **remote procedure calls** to read its partition from every map worker's local disk. This is the most network-intensive phase. Once a reduce worker has read all intermediate data for its partition, it sorts it by intermediate key so that all occurrences of the same key are grouped together.

**Step 6: Reduce Phase**

The reduce worker iterates over the sorted intermediate data. For each unique key, it passes the key and the corresponding set of values to the user's reduce function. The output is appended to a final output file on GFS.

**Step 7: Completion**

When all map and reduce tasks have completed, the master wakes up the user program. The R output files (one per reduce partition) are available on GFS.

### Why Local Disk for Intermediate Data?

Map output is written to the map worker's **local disk**, not GFS. This is a deliberate design choice:

1. **Intermediate data is transient** — it's only needed until the reduce phase finishes
2. **GFS replication would triple the network traffic** for data that will be read exactly once
3. **Local writes are fast** — no network round trips

The cost: if a map worker crashes after writing intermediate data, that data is lost and the map task must be re-executed. MapReduce accepts this trade-off because map tasks are deterministic and re-executable.

---

## The Master Coordinator

The master is the single point of coordination (not a single point of failure — more on that below). It maintains:

```
For each map task:
  - state: {idle, in-progress, completed}
  - worker identity (for in-progress tasks)
  - locations of R intermediate file regions (for completed tasks)

For each reduce task:
  - state: {idle, in-progress, completed}
  - worker identity (for in-progress tasks)
```

The master is the conduit through which intermediate file locations flow from map workers to reduce workers. When a map task completes, the worker reports the locations of its R intermediate files to the master, which pushes this information to reduce workers that have in-progress reduce tasks (or stores it for future assignment).

### Master Failure

In the original Google implementation, the master was a single process. If it crashed, the entire MapReduce job aborted. The user was expected to retry the job.

This seems fragile, but in practice:
- The master holds only metadata (task states and file locations), not the actual data
- Master state can be checkpointed periodically
- Master crashes are rare (one machine vs. thousands of workers)
- The entire job is idempotent — restarting produces the same output

Later implementations (Hadoop YARN, Google's internal successor) added master high-availability.

---

## Fault Tolerance: The Core Innovation

Fault tolerance is what makes MapReduce a distributed systems contribution, not just a programming model. In a cluster of 1,800 machines running jobs that take hours, machine failures are not exceptional — they are continuous.

### Worker Failure Detection

The master **pings** every worker periodically. If no response is received within a timeout (the timeout-based failure detection from Chapter 7), the master marks the worker as failed.

### Map Worker Failure

When a map worker fails:

1. **All completed map tasks on that worker are reset to idle** and become eligible for re-scheduling on other workers. Why? Because the output of a map task lives on the failed worker's local disk — it's now inaccessible.

2. **Any in-progress map task on that worker is also reset to idle.**

3. Reduce workers that were reading intermediate data from the failed worker are notified of the new map worker locations when the re-executed map tasks complete.

```
Timeline of map worker failure:

Time ──────────────────────────────────────────────▶

Worker W1:  [Map T1: complete] [Map T5: in-progress]
                                       │
                                       ✗ W1 crashes
                                       │
Master:     Detects W1 failure via ping timeout
            Reset T1: completed → idle  (output on W1's disk is lost)
            Reset T5: in-progress → idle
            
Worker W3:  Assigned T1 → executes → completes (new output on W3's disk)
Worker W4:  Assigned T5 → executes → completes (new output on W4's disk)
            
Reduce workers: Notified to read T1's output from W3 instead of W1
```

This works because **map functions are deterministic**. Re-executing a map task on different input split data produces identical output. The intermediate key-value pairs from the re-execution are byte-for-byte identical to the originals.

### Reduce Worker Failure

When a reduce worker fails:

1. **In-progress reduce tasks are reset to idle** for re-execution on another worker.
2. **Completed reduce tasks do NOT need re-execution** — their output was written to GFS, which replicates it across multiple chunk servers. The output survives the worker failure.

This asymmetry is important:
- Map output → local disk → lost on failure → must re-execute
- Reduce output → GFS → survives failure → no re-execution needed

### The Correctness Guarantee

MapReduce provides **exactly-once execution semantics** for the reduce function, even in the presence of failures:

- Each map task produces output deterministically to named temporary files
- Each reduce task writes to a named temporary output file
- On task completion, the worker sends a "task complete" message to the master with the output file names
- The master records the completion **atomically** — if the master receives a completion message for an already-completed task (because the worker was slow and the task was re-assigned), it ignores the duplicate

For the reduce phase, GFS's **atomic rename** operation ensures that the final output file appears atomically. A reduce task writes to a temporary file, then renames it to the final output name on completion. If two workers both execute the same reduce task (because of a false failure detection), only one rename succeeds — GFS guarantees this.

---

## Stragglers and Backup Tasks

In a large cluster, **stragglers** — machines that take unusually long to complete a task — are the dominant source of total job latency. A single slow machine can delay the entire job.

Causes of stragglers:
- A machine with a bad disk that slows read throughput from 100 MB/s to 1 MB/s
- The cluster scheduler places other tasks on the machine, competing for CPU and memory
- A bug in machine initialization code that disables the processor cache
- Network congestion on the rack switch

### The Solution: Backup Tasks

When a MapReduce operation is close to completion, the master schedules **backup executions** of the remaining in-progress tasks. The task is marked complete when **either** the primary or the backup execution finishes.

```
Normal execution without backup tasks:

Task T1: ████████████████████████░░░░░░░░░░░░ (straggler — 2x slower)
Task T2: ████████████████████ (done)
Task T3: ██████████████████████ (done)
Task T4: █████████████████████ (done)
                                              │
                                    Job completes here (waiting for T1)

With backup tasks:

Task T1 (primary):   ████████████████████████░░░░░░░░░░ (still slow)
Task T1 (backup):    ████████████████████ (done — task marked complete)
Task T2: ████████████████████ (done)
Task T3: ██████████████████████ (done)
Task T4: █████████████████████ (done)
                               │
                     Job completes here (backup beat the straggler)
```

The paper reports that disabling backup tasks increased job completion time by **44%** for a large sort benchmark. The resource cost is modest — backup tasks increase computational resource usage by only a few percent, because they are only launched near the end when most machines are idle.

This is a powerful general technique: **speculative execution**. Rather than trying to predict which machines will be slow (which is hard), run duplicate copies and take whichever finishes first. The only requirement is that the computation is **deterministic** and **idempotent**.

---

## Data Locality Optimization

Moving computation to the data is cheaper than moving data to the computation. MapReduce exploits GFS's knowledge of data placement.

The master tries to schedule map tasks on machines that **already have a copy** of the input split on their local disk (recall from Chapter 16 that GFS stores three replicas of each chunk). If the exact machine isn't available, it falls back to a machine on the **same network switch** (same rack), which minimizes cross-rack network traffic.

```
Scheduling priority for map task reading GFS chunk C:

Priority 1: Machine that stores a replica of chunk C
             (zero network read — read from local disk)

Priority 2: Machine on the same rack as a replica of chunk C
             (intra-rack read — fast, doesn't cross backbone)

Priority 3: Any machine in the cluster
             (cross-rack read — slower, consumes backbone bandwidth)
```

In practice, most map tasks achieve Priority 1 scheduling. This is why Google ran MapReduce on the same cluster as GFS — physical co-location of compute and storage was the entire point.

---

## The Combiner Optimization

When intermediate values are highly repetitive, a **combiner** function can reduce network traffic during the shuffle phase. The combiner runs on the map worker after the map function but before the data is sent to reduce workers.

Example: In word count, the map function emits ("the", 1) thousands of times per document. Instead of sending all of those across the network:

```
Without combiner:
  Map output:     ("the", 1), ("the", 1), ("the", 1), ..., ("the", 1)  ← 10,000 pairs
  Shuffle:        Send all 10,000 pairs over network to reduce worker
  
With combiner:
  Map output:     ("the", 1), ("the", 1), ("the", 1), ..., ("the", 1)  ← 10,000 pairs
  After combiner: ("the", 10000)                                        ← 1 pair
  Shuffle:        Send 1 pair over network to reduce worker
```

The combiner function is typically the same as the reduce function. It works correctly whenever the reduce function is **commutative and associative** — the order and grouping of partial reductions doesn't matter.

```python
# Combiner for word count (same as reduce):
def combine(word, counts):
    emit(word, sum(counts))

# This works because addition is commutative and associative:
# sum([1,1,1]) + sum([1,1]) == sum([1,1,1,1,1])
```

Not all reduce functions are valid combiners. For example, computing the **average** of a set of numbers is not associative:

```
avg(avg(1, 2), avg(3, 4)) = avg(1.5, 3.5) = 2.5
avg(1, 2, 3, 4) = 2.5  ← happens to match here, but:
avg(avg(1, 2, 3), avg(4)) = avg(2, 4) = 3.0  ← wrong!
```

To compute averages in MapReduce, emit (sum, count) pairs and divide in the reduce step.

---

## The Partitioning Function

The partitioning function determines which reduce task receives each intermediate key. The default is hash-based:

```python
def partition(key, num_reduce_tasks):
    return hash(key) % num_reduce_tasks
```

Users can provide custom partitioning functions. A common use case: when keys are URLs, partition by hostname so that all URLs from the same site end up in the same output file:

```python
def partition(key, num_reduce_tasks):
    hostname = urlparse(key).hostname
    return hash(hostname) % num_reduce_tasks
```

The choice of R (number of reduce tasks) directly affects:
- **Parallelism**: More reduce tasks = more parallel reduce work
- **Output files**: Exactly R output files are produced
- **Shuffle cost**: Each map task writes R separate partitions

Google's guideline: set R to a small multiple of the number of worker machines.

---

## Handling Machine Failures During Shuffle

The shuffle phase — where reduce workers pull intermediate data from map workers — is particularly vulnerable to failures. Consider what happens when a map worker crashes after completing its map tasks but before all reduce workers have finished pulling data:

```
Timeline:

1. Map worker W1 completes map tasks T1, T2, T3
   Output written to W1's local disk

2. Reduce workers begin pulling data from W1
   - R0 successfully reads T1 partition 0 from W1
   - R1 is midway through reading T1 partition 1 from W1

3. W1 crashes

4. R1's read fails — connection reset
   R2 hasn't started reading from W1 yet

5. Master detects W1 failure
   Re-schedules T1, T2, T3 on new workers

6. New workers re-execute map tasks, write output to their local disks

7. Master notifies reduce workers of new locations
   - R0 already has T1 partition 0 — but from the OLD execution on W1
   - R1 and R2 need to pull from the NEW locations
```

What about R0? It has data from the old execution of T1. Is it safe to use?

**Yes** — because map functions are **deterministic**. The re-execution of T1 produces byte-identical output. R0's locally cached copy from the old execution is identical to what the new execution would produce. R0 can keep its cached data and only needs to pull from new workers for tasks it hasn't read yet.

In practice, the MapReduce framework doesn't verify this — it simply has R0 re-read from the new worker. The additional network cost is minor compared to the complexity of tracking which reduce workers have cached which data.

---

## Concrete Numbers from the Paper

Dean and Ghemawat reported performance on Google's production cluster (circa 2004):

### The Cluster
- ~1,800 machines
- Two 2 GHz Intel Xeon processors per machine
- 4 GB memory per machine
- 160 GB IDE disk per machine (two disks)
- Gigabit Ethernet
- Bisection bandwidth: ~100 Gbps (estimated from the paper's network topology)

### Grep Benchmark
- Input: 10^10 100-byte records (~1 TB)
- Task: Scan for a rare three-character pattern (occurs in 92,337 records)
- Configuration: M=15,000 map tasks, R=1 reduce task
- **Completion time: ~150 seconds**
- Peak scanning rate: ~30 GB/s across the cluster

```
Rate (GB/s)
30 ┤                    ╭──────╮
   │                   ╱        ╲
20 ┤                  ╱          ╲
   │                ╱              ╲
10 ┤              ╱                  ╲
   │           ╱                       ╲
 0 ┤─────────╱                           ╲──────
   └──┬──────┬──────┬──────┬──────┬──────┬──────
      0     30     60     90    120    150   180
                    Time (seconds)
```

The ramp-up period reflects the time for the master to propagate tasks to workers, and the ramp-down reflects the straggler tail.

### Sort Benchmark
- Input: 10^10 100-byte records (~1 TB)
- Task: Sort the records (as in the TeraSort benchmark)
- Configuration: M=15,000 map tasks, R=4,000 reduce tasks
- Map phase: ~200 seconds
- Shuffle phase: starts during the map phase, overlapping
- Reduce phase: ~300 seconds after shuffle completes
- **Total: ~891 seconds** (~14.9 minutes)

With backup tasks disabled: ~1,283 seconds (44% slower).

With 200 workers killed mid-job (simulated failure): ~933 seconds. Only 5% slower than normal — the re-execution of failed map tasks added minimal overhead because:
1. Only the killed workers' tasks needed re-execution
2. Backup tasks handled the re-scheduled work alongside normal processing
3. The re-executed map tasks completed quickly (the input data was still on GFS)

---

## The Full Execution Protocol in Detail

Here's the complete protocol, including all the message flows:

```
Phase 0: Initialization
─────────────────────────
  User program → Fork master process
  User program → Fork worker processes (or use existing cluster daemon)
  Master: Initialize task table (M map tasks, R reduce tasks, all idle)

Phase 1: Map
─────────────
  For each idle map task Ti:
    Master → Worker Wj: "Execute map task Ti on input split Si"
    Wj: Read input split Si from GFS (local if possible)
    Wj: For each record in Si:
          Apply user map function
          Buffer intermediate (key, value) pairs in memory
    Wj: Periodically flush buffer to local disk, partitioned into R files
    Wj → Master: "Map task Ti complete. Intermediate files at locations L0..LR-1"
    Master: Record locations, mark Ti as completed

Phase 2: Shuffle (overlaps with late map tasks)
─────────────────────────────────────────────────
  For each reduce task Ri assigned to worker Wk:
    Master → Wk: "Intermediate file locations for partition i: {W1:L1i, W2:L2i, ...}"
    Wk: For each map worker's partition:
          RPC read intermediate data from map worker's local disk
    Wk: Sort all intermediate data by key (external merge sort if necessary)

Phase 3: Reduce
────────────────
  Wk: For each unique key K in sorted intermediate data:
        Collect all values for K
        Apply user reduce function
        Append output to temporary file
  Wk: Atomic rename temporary file → final output file on GFS
  Wk → Master: "Reduce task Ri complete."
  Master: Mark Ri as completed

Phase 4: Completion
────────────────────
  When all M map tasks and R reduce tasks are completed:
    Master → User program: "Job complete. Output in R files on GFS."
```

---

## Hadoop MapReduce: The Open-Source Implementation

Doug Cutting and Mike Cafarella created Hadoop as an open-source implementation of MapReduce (and GFS, as HDFS). While the core model is identical, there are notable differences:

### Architecture Differences

| Aspect | Google MapReduce | Hadoop MapReduce (v1) | Hadoop YARN (v2) |
|--------|-----------------|----------------------|-------------------|
| Master | Single process per job | JobTracker (single daemon for all jobs) | ResourceManager + per-job ApplicationMaster |
| Worker | Worker processes | TaskTracker daemons | NodeManager + Containers |
| Failure handling | Master crash → job restart | JobTracker crash → all jobs restart | ResourceManager HA via ZooKeeper; ApplicationMaster can checkpoint |
| Storage | GFS | HDFS | HDFS |
| Scheduling | Greedy + locality | FIFO, Fair Scheduler, or Capacity Scheduler | Pluggable schedulers |

### YARN's Key Improvement

Hadoop v1's JobTracker was a bottleneck — it managed both cluster resources and job coordination for every running job. YARN split these concerns:

```
Hadoop v1:                          Hadoop v2 (YARN):

┌───────────────┐                   ┌───────────────┐
│  JobTracker    │                   │ResourceManager │ (cluster resources only)
│ (everything)  │                   └───────┬───────┘
└───────┬───────┘                           │
        │                          ┌────────┼────────┐
   ┌────┼────┐                     ▼        ▼        ▼
   ▼    ▼    ▼               ┌──────┐ ┌──────┐ ┌──────┐
┌────┐┌────┐┌────┐          │AM Job1│ │AM Job2│ │AM Job3│ (per-job masters)
│ TT ││ TT ││ TT │          └───┬──┘ └───┬──┘ └───┬──┘
└────┘└────┘└────┘              │        │        │
                           ┌────┼────┐   │   ┌────┼────┐
                           ▼    ▼    ▼   ▼   ▼    ▼    ▼
                         Containers on NodeManagers
```

This also allowed YARN to support computation frameworks beyond MapReduce (Spark, Tez, Flink), making Hadoop a general-purpose cluster resource manager.

---

## Limitations of MapReduce

Despite its success, MapReduce has fundamental limitations that drove the development of successors:

### 1. Rigid Two-Phase Model

Many real computations don't naturally decompose into a single map-then-reduce step. Iterative algorithms (PageRank, K-means clustering, gradient descent) require multiple passes over the data. In MapReduce, each iteration is a separate job:

```
PageRank iteration:

Job 1: MapReduce (read graph + initial ranks → compute new ranks)
  ↓ Write intermediate results to GFS
Job 2: MapReduce (read graph + updated ranks → compute new ranks)
  ↓ Write intermediate results to GFS
Job 3: MapReduce (read graph + updated ranks → compute new ranks)
  ↓ Write intermediate results to GFS
  ... repeat until convergence ...
```

Each job reads from and writes to GFS. The I/O cost of materializing intermediate results between iterations dominates the actual computation.

### 2. No In-Memory Caching

MapReduce always writes intermediate results to disk (local for map output, GFS for reduce output). For iterative algorithms where the same data is read repeatedly, this creates enormous I/O overhead. There's no way to say "keep this dataset in memory for the next iteration."

### 3. High Latency

The overhead of job startup, task scheduling, and GFS I/O makes MapReduce unsuitable for interactive queries or low-latency processing. A simple word count on a small dataset still takes minutes due to framework overhead.

### 4. Shuffle Is All-to-All

The shuffle phase requires every reduce worker to read from every map worker. For M map tasks and R reduce tasks, this is M × R network connections. At Google's scale, this generated massive cross-rack traffic.

### 5. No Native Support for Joins

SQL-style joins between two datasets require awkward workarounds — typically, both datasets are fed as input to the map phase, which emits tagged records, and the reduce phase performs the actual join. Multi-way joins are even more painful.

---

## Why Spark Replaced MapReduce

Apache Spark (Zaharia et al., NSDI 2012) addressed MapReduce's core limitations with a single abstraction: the **Resilient Distributed Dataset (RDD)**.

### The RDD Model

An RDD is an immutable, partitioned collection of records that can be operated on in parallel. Unlike MapReduce's rigid map-then-reduce structure, Spark supports a rich set of transformations:

```python
# Spark equivalent of MapReduce word count
text_file = spark.textFile("hdfs://input/")
counts = (text_file
    .flatMap(lambda line: line.split())     # map
    .map(lambda word: (word, 1))            # map
    .reduceByKey(lambda a, b: a + b))       # reduce
counts.saveAsTextFile("hdfs://output/")
```

### Key Differences from MapReduce

| Feature | MapReduce | Spark |
|---------|-----------|-------|
| **Intermediate data** | Always written to disk | Kept in memory (spills to disk if necessary) |
| **Iterations** | Separate jobs, full I/O each | In-memory across iterations |
| **Computation model** | Map → Shuffle → Reduce | Arbitrary DAG of transformations |
| **Fault tolerance** | Re-execute failed tasks | Re-compute lost partitions from lineage |
| **Latency** | Minutes (job startup overhead) | Seconds (for cached data) |
| **API** | Low-level (map/reduce functions) | High-level (filter, join, groupBy, etc.) |

### Spark's Fault Tolerance: Lineage

Instead of replicating intermediate data (expensive), Spark records the **lineage** of each RDD — the sequence of transformations used to compute it from the input data:

```
Input RDD (HDFS)
  ↓ flatMap(split)
Words RDD
  ↓ map(word → (word, 1))
Pairs RDD
  ↓ reduceByKey(+)
Counts RDD
```

If a partition of the Counts RDD is lost (because a machine fails), Spark can recompute it by replaying the transformations on the corresponding partition of the input. This is cheaper than replication because:

1. Lineage metadata is tiny (a few KB per RDD)
2. Only the lost partition is recomputed, not the entire dataset
3. If the input RDD is on HDFS, it's already replicated

For long lineage chains (many transformations), users can **checkpoint** an RDD to HDFS, truncating the lineage and providing a faster recovery point.

### Performance Comparison

The Spark paper reported:
- **Logistic regression**: 10× faster than Hadoop MapReduce (iterative algorithm benefits from in-memory caching)
- **PageRank**: 3× faster (benefits from caching the graph structure)
- **Interactive queries**: 40× faster (data cached in memory from previous queries)

### What Spark Kept from MapReduce

Despite the differences, Spark preserved MapReduce's fundamental distributed systems design:

1. **Deterministic, re-executable tasks** — enabling fault recovery via re-execution
2. **Data locality awareness** — scheduling computation near the data
3. **Speculative execution** — running backup copies of slow tasks
4. **Bulk-synchronous processing** — stages with shuffle boundaries (called "stages" in Spark, analogous to map/reduce phases)

---

## Google's Own Evolution: FlumeJava and Cloud Dataflow

Google also moved beyond MapReduce internally. FlumeJava (Chambers et al., PLDI 2010) provided a high-level Java API that compiled pipelines of map, reduce, join, and group operations into an optimized graph of MapReduce jobs. This evolved into Cloud Dataflow (later Apache Beam), which supports both batch and stream processing with the same API.

The progression:

```
MapReduce (2004)
  ↓ Rigid, low-level
FlumeJava (2010)
  ↓ High-level API, auto-optimized to MapReduce jobs
MillWheel (2013)
  ↓ Low-latency stream processing
Cloud Dataflow / Apache Beam (2015)
  ↓ Unified batch + stream, portable across runners
```

The key insight from this evolution: MapReduce's **programming model** was too restrictive, but its **fault tolerance model** (deterministic tasks, re-execution on failure, speculative execution for stragglers) remains the foundation of every large-scale data processing system.

---

## Summary

MapReduce is the proof that massive-scale data processing can be made reliable through a simple contract: give us a deterministic map function and a deterministic reduce function, and we'll handle the rest. "The rest" includes:

- **Scheduling** thousands of tasks across thousands of machines
- **Detecting failures** via heartbeat timeouts
- **Recovering from failures** by re-executing deterministic tasks
- **Optimizing performance** via data locality and speculative execution
- **Ensuring correctness** via atomic file operations and the GFS replication layer

The specific MapReduce API is largely obsolete — Spark, Flink, and Dataflow offer richer models. But the distributed systems principles are universal:

1. **Determinism enables re-execution**, which enables fault tolerance without replication
2. **Speculative execution** is cheaper than predicting failures
3. **Moving computation to data** is cheaper than moving data to computation
4. **Simple, rigid interfaces** (map/reduce) enable powerful optimizations that flexible interfaces (arbitrary message passing) cannot

---

## Key Takeaways

- MapReduce splits every computation into two deterministic phases (map and reduce), enabling automatic parallelization and fault recovery
- The master coordinator tracks task state and reassigns failed tasks; worker failures are recovered by re-executing deterministic map/reduce functions
- Map output goes to local disk (not GFS) — a deliberate trade-off that reduces network I/O at the cost of requiring re-execution on map worker failure
- Backup tasks (speculative execution) reduced job completion time by 44% by eliminating straggler delays
- Data locality scheduling — placing map tasks on machines that hold the input data — minimizes network traffic
- MapReduce's rigid two-phase model limits iterative algorithms and interactive queries; Spark's RDD model addresses this with in-memory caching and lineage-based fault recovery
- The fault tolerance principles (deterministic re-execution, speculative execution, data locality) survive in every successor framework

## References

- Dean, J. & Ghemawat, S. (2004). "MapReduce: Simplified Data Processing on Large Clusters." OSDI.
- Zaharia, M. et al. (2012). "Resilient Distributed Datasets: A Fault-Tolerant Abstraction for In-Memory Cluster Computing." NSDI.
- Chambers, C. et al. (2010). "FlumeJava: Easy, Efficient Data-Parallel Pipelines." PLDI.
- Akidau, T. et al. (2015). "The Dataflow Model: A Practical Approach to Balancing Correctness, Latency, and Cost in Massive-Scale, Unbounded, Out-of-Order Data Processing." VLDB.

---

**Next**: [Chapter 30 — Stream Processing: Kafka Internals →](ch30-kafka-internals.md)
