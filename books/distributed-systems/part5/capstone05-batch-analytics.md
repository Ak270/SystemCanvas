# Capstone 5: Fault-Tolerant Batch Analytics (MapReduce-like)

> **Design Goal**: Build a distributed batch processing framework that reliably processes petabytes of data across thousands of machines, tolerating arbitrary worker failures and stragglers without losing or duplicating work.

**Key Concepts Practiced**: GFS chunk replication, straggler mitigation, deterministic reducers, task re-execution, data locality, failure detection, distributed file system coordination.

**Prerequisites**: Chapters 3 (failure taxonomy), 7–8 (failure detection), 15 (WAL), 16 (GFS internals), 29 (MapReduce).

---

## 1. Problem Statement

You have 10 PB of web crawl data stored across 5,000 machines. You need to:

1. Parse every page and extract outbound links (Map phase)
2. Group links by destination domain (Shuffle phase)
3. Count and rank domains by inbound link count (Reduce phase)

Any machine can crash at any time. Network links can fail. Some machines are slow (thermal throttling, noisy neighbors, dying disks). The job must complete correctly and within a bounded time.

**Core invariants**:
- Every input record is processed **exactly once** in the final output.
- The output is **deterministic** — same input always produces same output regardless of failures.
- The job completes in **bounded time** even if 10% of machines are slow.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Job Coordinator                        │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Task Tracker │  │ Worker Health │  │ Straggler      │  │
│  │             │  │ Monitor      │  │ Detector       │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
└──────────┬───────────────┬───────────────┬───────────────┘
           │               │               │
    ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
    │  Worker 0   │ │  Worker 1   │ │  Worker 2   │  ...  Worker N
    │             │ │             │ │             │
    │ Map tasks   │ │ Map tasks   │ │ Reduce tasks│
    │ local disk  │ │ local disk  │ │ local disk  │
    └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
           │               │               │
    ═══════╧═══════════════╧═══════════════╧═══════════
                  Distributed File System (GFS)
              Input chunks replicated across workers
```

### Components

| Component | Role |
|-----------|------|
| **Distributed File System (DFS)** | Stores input data as replicated chunks (GFS/HDFS). Each 64MB chunk has 3 replicas on different machines. |
| **Job Coordinator (Master)** | Assigns tasks, tracks progress, detects failures, launches backup tasks for stragglers |
| **Workers** | Execute map or reduce tasks. Workers are commodity machines — any can fail. |

---

## 3. Data Flow in Detail

### 3.1 Input Splitting

The input is a set of files in the distributed file system. Each file is split into **chunks** (typically 64MB). Each chunk is stored as 3 replicas on different machines.

```
Input: crawl_data (10 PB)
  → Split into ~160 million chunks of 64 MB each
  → Each chunk replicated 3x across different racks

File: crawl_data/part-000001 (640 MB)
  Chunk 0 (64 MB): Replicas on Workers {12, 47, 203}
  Chunk 1 (64 MB): Replicas on Workers {8, 91, 155}
  Chunk 2 (64 MB): Replicas on Workers {47, 62, 301}
  ...
```

Each chunk becomes one **map task**. 160 million chunks = 160 million map tasks. But we only have 5,000 workers, so each worker processes ~32,000 map tasks sequentially.

### 3.2 Map Phase

Each map task reads one chunk and applies the user's map function:

```python
def map(key: str, value: str) -> List[Tuple[str, str]]:
    """key = URL, value = page HTML"""
    links = extract_links(value)
    results = []
    for link in links:
        domain = urlparse(link).netloc
        results.append((domain, "1"))
    return results
```

Map output is **partitioned** by the reduce key. If there are R reduce tasks, each map output record goes to partition `hash(key) % R`:

```
Map Task 0 output:
  Partition 0: [(google.com, 1), (amazon.com, 1), ...]
  Partition 1: [(github.com, 1), (wikipedia.org, 1), ...]
  ...
  Partition R-1: [(example.com, 1), ...]
```

Map output is written to the **worker's local disk** (not the distributed file system). This is intermediate data — it doesn't need 3x replication because we can regenerate it by re-running the map task.

```
Worker 12 local disk:
  /mapout/job-001/task-00000/partition-00000.dat
  /mapout/job-001/task-00000/partition-00001.dat
  ...
  /mapout/job-001/task-00000/partition-00999.dat
```

### 3.3 Shuffle Phase

Each reduce task needs to fetch its partition from **every** map task's output. This is the shuffle — an all-to-all data transfer.

```
Reduce Task 0 fetches:
  Worker 12: /mapout/job-001/task-00000/partition-00000.dat
  Worker 8:  /mapout/job-001/task-00001/partition-00000.dat
  Worker 47: /mapout/job-001/task-00002/partition-00000.dat
  ...
  (one file from each of 160 million map tasks)
```

In practice, map tasks on the same worker merge their partitions, so the reduce task fetches one file per worker, not per map task.

The shuffle phase **sorts** all fetched records by key within the partition:

```
After sort:
  (amazon.com, [1, 1, 1, 1, ...])
  (example.com, [1, 1, ...])
  (github.com, [1, 1, 1, ...])
  (google.com, [1, 1, 1, 1, 1, ...])
  ...
```

### 3.4 Reduce Phase

Each reduce task processes all values for each key:

```python
def reduce(key: str, values: Iterator[str]) -> Tuple[str, str]:
    """key = domain, values = list of "1"s"""
    count = sum(int(v) for v in values)
    return (key, str(count))
```

Reduce output is written to the **distributed file system** (durable, replicated):

```
DFS: /output/job-001/part-00000  (from Reduce Task 0)
DFS: /output/job-001/part-00001  (from Reduce Task 1)
...
```

---

## 4. Task Scheduling with Data Locality

The coordinator assigns map tasks to workers that hold a local replica of the input chunk.

```python
class Coordinator:
    def assign_map_task(self, worker_id):
        # Priority 1: Task whose input chunk is on this worker's local disk
        for task in self.pending_map_tasks:
            if worker_id in task.chunk_replicas:
                return task  # Data-local: zero network transfer
        
        # Priority 2: Task whose input chunk is on a machine in the same rack
        for task in self.pending_map_tasks:
            if self.same_rack(worker_id, task.chunk_replicas):
                return task  # Rack-local: one switch hop
        
        # Priority 3: Any unassigned task (remote read)
        return self.pending_map_tasks.pop()
```

**Why this matters**: Reading 64 MB over the network takes ~500ms at 1 Gbps. Reading from local disk takes ~200ms. With 160 million map tasks, data locality saves thousands of hours of aggregate network transfer.

Google's MapReduce paper reports that in a typical run:
- ~80% of map tasks are data-local (read from local disk)
- ~15% are rack-local
- ~5% are remote

---

## 5. Fault Tolerance

### 5.1 Worker Failure Detection

The coordinator sends periodic heartbeats (or workers send them to the coordinator). If a worker doesn't respond within a timeout:

```python
class HealthMonitor:
    def __init__(self, heartbeat_timeout_ms=60000):
        self.last_heartbeat = {}
        self.timeout = heartbeat_timeout_ms
    
    def check_workers(self):
        now = current_time_ms()
        for worker_id, last_seen in self.last_heartbeat.items():
            if now - last_seen > self.timeout:
                self.declare_failed(worker_id)
    
    def declare_failed(self, worker_id):
        # Re-execute all map tasks that were assigned to this worker
        # (even completed ones — their output is on the failed worker's local disk)
        for task in self.get_tasks_on_worker(worker_id):
            if task.phase == MAP:
                task.status = PENDING  # Must re-execute
            elif task.phase == REDUCE:
                if task.status == IN_PROGRESS:
                    task.status = PENDING  # Re-execute in-progress reduce tasks
                # Completed reduce tasks are safe — output is on DFS
```

**Key distinction**:
- **Completed map tasks**: Must be re-executed because their output is on the failed worker's local disk (which is now gone).
- **Completed reduce tasks**: Safe — their output is on the distributed file system (replicated).
- **In-progress tasks of either type**: Re-assigned to another worker.

### 5.2 Map Task Re-Execution

When a map task is re-executed (because the worker failed or the task was too slow), the map function must be **deterministic** — same input always produces same output.

```
Scenario:
  Worker 12 completes Map Task 7
  Reduce Task 0 starts fetching partition 0 from Worker 12
  Worker 12 crashes
  Reduce Task 0's fetch fails

Recovery:
  Coordinator reassigns Map Task 7 to Worker 155
  Worker 155 re-executes Map Task 7 (reads chunk from DFS replica)
  Worker 155 produces identical output (deterministic)
  Coordinator notifies Reduce Task 0: "Map 7 output now on Worker 155"
  Reduce Task 0 fetches partition 0 from Worker 155
```

Determinism is critical: if re-execution produced different output, reduce tasks that already fetched some partitions from the original execution would see inconsistent data.

### 5.3 Reduce Task Re-Execution

Reduce tasks write output to DFS atomically (rename from temp file to final path):

```python
def execute_reduce_task(task):
    # Write to a temporary file
    temp_path = f"/tmp/reduce-{task.id}-{attempt_id}"
    output = open(temp_path, 'w')
    
    for key, values in sorted_input:
        result = user_reduce(key, values)
        output.write(result)
    
    output.close()
    
    # Atomic rename to final output path
    # If another attempt already wrote the output, this is a no-op
    dfs.rename(temp_path, f"/output/job-001/part-{task.id}")
```

The atomic rename ensures that only one reduce attempt's output is visible, even if the task was executed multiple times (due to speculative execution or failure recovery).

### 5.4 Handling Failures During Shuffle

The shuffle is the most vulnerable phase — it's an all-to-all transfer that can be disrupted by any worker failure.

```
Reduce Task 0 needs data from 5,000 workers:
  Fetched from Workers 0–3,499: ✓ (stored locally)
  Fetching from Worker 3,500: connection reset (worker crashed)
  Not yet fetched from Workers 3,501–4,999

Recovery:
  1. Map tasks that were on Worker 3,500 are re-executed on other workers
  2. Reduce Task 0 retries fetching from the new worker locations
  3. Already-fetched data is retained — no need to re-fetch
```

The reduce task doesn't start over. It retries only the failed fetches. This is why map output locations are tracked by the coordinator — reduce tasks query "where is Map Task X's output now?"

---

## 6. Straggler Mitigation

### 6.1 The Problem

In a cluster of 5,000 machines, some are always slow:
- Disk with bad sectors (slow reads)
- CPU thermal throttling
- Memory pressure from co-located jobs
- Network congestion from rack neighbors

A single straggler can delay the entire job. If 99% of map tasks finish in 2 minutes but one task takes 30 minutes, the job takes 30 minutes.

### 6.2 Speculative Execution (Backup Tasks)

When the job is nearly complete (e.g., 95% of tasks done), the coordinator launches **backup copies** of remaining in-progress tasks on different workers:

```python
class StragglerDetector:
    def __init__(self):
        self.task_start_times = {}
        self.completed_durations = []
    
    def check_stragglers(self):
        if self.percent_complete() < 0.95:
            return  # Too early to speculate
        
        median_duration = median(self.completed_durations)
        
        for task_id, start_time in self.task_start_times.items():
            elapsed = now() - start_time
            if elapsed > median_duration * 1.5:
                # This task is taking 50% longer than typical
                self.launch_backup(task_id)
    
    def launch_backup(self, task_id):
        # Run the same task on a different worker
        backup_worker = self.find_idle_worker()
        backup_worker.execute(task_id)
        # Whichever copy finishes first wins; the other is killed
```

**The race**: Both the original and backup run simultaneously. The coordinator takes the output from whichever finishes first and kills the other.

```
Task 42:
  Original: Worker 88 (started at t=0, still running at t=300s)
  Backup:   Worker 201 (started at t=300s, finishes at t=340s)
  
  Worker 201 finishes first.
  Coordinator: "Task 42 complete (backup won). Kill original on Worker 88."
  
  Total time: 340s instead of potentially 1800s
```

### 6.3 Why This Works

Google's MapReduce paper reports that speculative execution reduces job completion time by ~44% for large jobs. The resource cost is small — backup tasks are only launched near the end of the job (when most workers are idle anyway), and they increase total computation by only 2–3%.

The key insight: **it's cheaper to run a task twice on two machines than to wait for one slow machine.** This only works because:
1. Tasks are **deterministic** (same input → same output)
2. Tasks are **idempotent** (running twice doesn't corrupt state)
3. Output commit is **atomic** (only one copy's output is used)

---

## 7. Coordinator Fault Tolerance

The coordinator is a single point of failure. Three approaches:

### 7.1 Checkpointing (Simple)

The coordinator periodically writes its state to the distributed file system:

```python
class CoordinatorCheckpoint:
    def save(self):
        state = {
            'map_tasks': {t.id: t.status for t in self.map_tasks},
            'reduce_tasks': {t.id: t.status for t in self.reduce_tasks},
            'map_output_locations': self.map_locations,
            'worker_assignments': self.assignments,
        }
        dfs.write('/jobs/job-001/coordinator-checkpoint', serialize(state))
    
    def restore(self):
        state = deserialize(dfs.read('/jobs/job-001/coordinator-checkpoint'))
        # Restore task state
        # In-progress tasks at checkpoint time must be re-checked:
        # - If the worker is still alive and reports the task complete, mark complete
        # - Otherwise, mark pending for re-execution
```

On coordinator failure, a new coordinator reads the checkpoint and resumes. Tasks that were in-progress at checkpoint time are verified with their assigned workers.

### 7.2 Replicated Coordinator (Production-Grade)

Run the coordinator as a Raft group (Chapter 22). The Raft log contains every state transition (task assigned, task completed, worker failed). On leader failure, a follower takes over with complete state.

```
Coordinator Raft Group:
  Leader:    Coordinator-0  ← assigns tasks, detects failures
  Follower:  Coordinator-1  ← ready to take over
  Follower:  Coordinator-2  ← ready to take over

State machine transitions in Raft log:
  [1] MAP_TASK_ASSIGNED(task=7, worker=12)
  [2] MAP_TASK_COMPLETED(task=7, worker=12, output_locations={...})
  [3] WORKER_FAILED(worker=88)
  [4] MAP_TASK_REASSIGNED(task=42, worker=155)
  ...
```

### 7.3 Client-Driven Restart (Google's Original Approach)

The original MapReduce paper describes a simpler approach: if the coordinator dies, the entire job is aborted and the client restarts it. This works because:
- Coordinator failure is rare (one machine, high reliability)
- Restarting a job is wasteful but correct
- The simpler design avoids bugs in coordinator recovery logic

---

## 8. End-to-End Example: Link Count Job

Let's trace the complete execution of our link-counting job.

### Setup

```
Input: 10 PB of crawl data
  → 160,000,000 map tasks (64 MB chunks)
  → 10,000 reduce tasks
  → 5,000 workers

Configuration:
  Replication factor: 3
  Heartbeat timeout: 60s
  Speculative execution threshold: 95% complete, 1.5x median duration
```

### Phase 1: Map (estimated 2 hours)

```
t=0:     Coordinator assigns map tasks with data locality
         80% data-local, 15% rack-local, 5% remote
         
t=30m:   50% of map tasks complete
         3 workers failed → 96 map tasks re-assigned
         (32 tasks per worker × 3 workers)
         
t=90m:   95% of map tasks complete
         Straggler detection kicks in
         47 backup tasks launched for slow map tasks
         
t=110m:  99.9% complete. 12 original tasks still running.
         9 backup tasks won their races.
         
t=115m:  All map tasks complete.
         Reduce tasks begin shuffle.
```

### Phase 2: Shuffle (estimated 30 minutes)

```
t=115m:  Each reduce task fetches from ~5,000 workers
         Total shuffle data: ~2 PB (map output after filtering)
         
t=120m:  Worker 2,891 crashes during shuffle
         14 reduce tasks lose partial fetches
         Coordinator re-executes affected map tasks on other workers
         Reduce tasks retry failed fetches from new locations
         
t=145m:  All reduce tasks have fetched and sorted their input
```

### Phase 3: Reduce (estimated 20 minutes)

```
t=145m:  10,000 reduce tasks execute in parallel
         Each processes ~200 GB of sorted input
         
t=155m:  95% of reduce tasks complete
         3 backup tasks launched for stragglers
         
t=165m:  All reduce tasks complete
         Output: 10,000 files on DFS
         
Job total: ~2 hours 45 minutes
Workers failed during job: 8
Tasks re-executed due to failures: ~280
Backup tasks launched: 50
```

### Correctness Verification

Every input chunk was processed by exactly one successful map execution. Every reduce partition was written by exactly one successful reduce execution. The atomic rename ensures no partial outputs are visible. The deterministic map and reduce functions ensure re-execution produces identical results.

---

## 9. Design Decisions and Trade-offs

### Why Local Disk for Map Output?

Map output is intermediate — it's consumed by reduce tasks and then discarded. Replicating it to DFS would triple the disk writes and network traffic for data that can be regenerated by re-running the map task.

**Trade-off**: When a worker fails, its completed map tasks must be re-executed (their output is lost). But worker failure is rare enough that the savings from not replicating outweigh the re-execution cost.

### Why Not Stream Map Output Directly to Reducers?

Streaming (pipelining) map output directly to reduce tasks would reduce latency. But:

1. **Fault tolerance is harder**: If a map task fails mid-stream, the reduce task has partial, potentially corrupted data.
2. **Sorting is harder**: The reduce task needs all data sorted by key. With streaming, it must do an external sort on an unbounded stream.
3. **Barrier simplifies reasoning**: The "all maps complete before any reduce starts" barrier (a simplification — reduce shuffle can overlap with map execution) makes the correctness argument straightforward.

Modern systems (Spark, Flink) do pipeline where possible, accepting the added complexity for lower latency.

### Why Deterministic Functions?

If a map function uses random numbers or current timestamps, re-execution produces different output. This breaks the correctness invariant — a reduce task might fetch some partitions from the original execution and others from the re-execution, getting an inconsistent mix.

```
NON-DETERMINISTIC (BROKEN):
  Map Task 7, Execution 1: emits (google.com, timestamp=1000)
  Map Task 7, Execution 2: emits (google.com, timestamp=1005)
  
  Reduce Task 0 fetched partition from Execution 1
  Reduce Task 1 fetched partition from Execution 2
  → Different executions of the same input produce different outputs
  → Final result depends on which execution each reduce task happened to read from
  → Non-deterministic output
```

**Rule**: Map and reduce functions must be pure functions of their input. If randomness is needed, seed it from the input (e.g., hash of the input record).

---

## 10. Comparison with Modern Systems

| Feature | MapReduce | Spark | Flink |
|---------|-----------|-------|-------|
| Execution model | Batch only | Batch + micro-batch | True streaming + batch |
| Intermediate data | Disk (local) | Memory (RDD) + disk spillover | Memory + checkpointing |
| Fault tolerance | Re-execute from DFS | Recompute lineage (RDD graph) | Checkpoint + replay |
| Straggler handling | Speculative execution | Speculative execution | - |
| Iteration | Multiple jobs (disk I/O each) | In-memory iteration | Iterative processing |
| Latency | Minutes–hours | Seconds–minutes | Milliseconds–seconds |

Spark's key innovation: keeping intermediate data in memory (RDDs) and tracking lineage instead of writing to disk. A failed partition is recomputed from its parent RDDs, not from the original DFS input. This makes iterative algorithms (machine learning, graph processing) orders of magnitude faster.

---

## 11. Exercises

1. **Design the combiner optimization**: A combiner runs a partial reduce on each map worker's output before the shuffle. For our link-counting job, the combiner sums counts per domain locally. How much does this reduce shuffle data? What constraints must a reduce function satisfy for a combiner to be correct? (Hint: associativity and commutativity.)

2. **Handle coordinator failure mid-job**: The coordinator crashes after 80% of map tasks are complete. A new coordinator starts from a checkpoint taken at 60%. What tasks must be re-verified? What's the worst case for wasted work? Design a protocol that minimizes re-execution.

3. **Skewed reduce tasks**: One reduce task processes the key "google.com" which has 10 billion inbound links, while other reduce tasks have 10 million. This one reduce task takes 10x longer. How do you redistribute the work? (Hint: secondary partitioning.)

4. **Design a distributed sort**: Using the MapReduce framework, sort 1 PB of data. The output must be a single sorted sequence across all output files (file 0 contains the smallest keys, file R-1 the largest). How do you choose partition boundaries to ensure even distribution? (Hint: sampling.)

5. **Trace a cascading failure**: Worker 100 is slow (disk dying). Speculative execution launches a backup on Worker 200. Worker 200 is in the same rack as Worker 100. The rack's top-of-rack switch fails. Now both copies are unreachable. Trace the recovery protocol and determine total delay.

---

**Next**: [Capstone 6 — Globally Distributed Transactional Database →](capstone06-global-database.md)
