# Chapter 23: Testing Distributed Systems — Jepsen and Chaos Engineering

> **Core question**: How do you test failure paths that never occur in your dev environment — and what does Netflix's Failure Injection Testing actually verify?

> **Prerequisites**: Failure taxonomy (Ch 3), System models (Ch 4), Consistency models (Ch 12), Linearizability (Ch 13), Raft (Ch 22)

---

## Why Distributed Testing Is Hard

A single-node program has one failure mode: the process crashes. A distributed system with *n* nodes, each of which can crash, slow down, partition, or corrupt data at any point during any operation, has an exponential number of failure modes. If you have 5 nodes and 10 operations in flight, and each node can be in one of 4 states (healthy, slow, partitioned, crashed) at each step, the state space is astronomically large.

The fundamental challenge:

```
Single-node test:
  Input → Function → Output
  Check: output matches expected value

Distributed test:
  Input → [Node 1, Node 2, ..., Node n] → Output
                ↑           ↑
            Network may delay, drop, reorder, or duplicate messages
            Any node may crash at any point
            Clocks may drift
  Check: output is consistent with SOME valid sequential execution
```

Most distributed system bugs are not in the "happy path." They lurk in the interaction between:
- A network partition that heals at exactly the wrong moment
- A leader election that races with an in-flight write
- A clock that jumps backward during a lease renewal
- A node that crashes after persisting half of a transaction

Yuan et al.'s 2014 study of 198 catastrophic failures in distributed systems found that **92% of them could have been prevented by better testing of error-handling code**. The error-handling code itself was wrong — not the normal path. The failures were triggered by a sequence of events that was unlikely but not impossible, and the system's response to those events made things worse.

### The Combinatorial Explosion

Consider a simple three-node replicated database processing two concurrent writes. Here's a partial list of things that could happen:

1. Both writes reach the leader normally → straightforward replication
2. Write A reaches the leader, leader crashes before replicating → write A is lost
3. Write A is replicated to one follower, leader crashes → new leader may or may not have write A
4. Write A is replicated to both followers, leader crashes, network partitions before new election → split-brain
5. Write A is committed, write B arrives, leader crashes mid-replication of B → A is durable, B may not be
6. Network partition during election, two leaders elected in different partitions → both accept writes
7. Partition heals, logs diverge → log reconciliation must discard uncommitted entries

And this is just two writes on three nodes. Real systems handle thousands of operations per second across dozens of nodes. Testing every interleaving is impossible.

### What Traditional Testing Misses

**Unit tests** verify individual components in isolation. They can't test the interaction between components over an unreliable network.

**Integration tests** run multiple components together but typically on a single machine with reliable networking. They miss:
- Network partitions
- Message reordering
- Clock skew
- Partial failures (one replica receives a write, another doesn't)
- Slow nodes that appear dead to failure detectors

**Load tests** stress the system but don't inject failures. A system that handles 10,000 requests per second may completely break when one of five nodes goes down under that same load.

The gap between what traditional testing covers and what production will throw at you is enormous. This chapter covers the tools and techniques designed to close that gap.

---

## Deterministic Simulation Testing

The most rigorous approach to testing distributed systems is **deterministic simulation**: replace all sources of nondeterminism (network, disk, clocks, thread scheduling) with simulated versions that the test harness controls. This lets you explore the state space systematically and reproduce any failure exactly.

### FoundationDB's Approach

FoundationDB (acquired by Apple in 2015) is the gold standard for deterministic simulation testing. Their approach:

1. **Single-threaded execution**: The entire distributed system runs in a single thread. "Nodes" are simulated actors, not separate processes.
2. **Simulated network**: All network communication goes through a simulated network layer that can inject arbitrary delays, drops, reordering, and partitions.
3. **Simulated disk**: All disk I/O goes through a simulated disk that can inject corruption, delays, and failures.
4. **Simulated clock**: Time is a variable the test harness controls. It can advance time instantly or create arbitrary clock skew between nodes.
5. **Deterministic scheduling**: Given the same random seed, the exact same sequence of events occurs every time.

```
┌─────────────────────────────────────────────────┐
│              Test Harness (single thread)        │
│                                                  │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐         │
│  │ Node A  │  │ Node B  │  │ Node C  │         │
│  │(actor)  │  │(actor)  │  │(actor)  │         │
│  └────┬────┘  └────┬────┘  └────┬────┘         │
│       │            │            │               │
│  ┌────┴────────────┴────────────┴────┐          │
│  │       Simulated Network           │          │
│  │  (delays, drops, partitions)      │          │
│  └───────────────────────────────────┘          │
│                                                  │
│  ┌───────────────────────────────────┐          │
│  │       Simulated Disk              │          │
│  │  (latency, corruption, failure)   │          │
│  └───────────────────────────────────┘          │
│                                                  │
│  ┌───────────────────────────────────┐          │
│  │       Simulated Clock             │          │
│  │  (skew, jumps, monotonicity)      │          │
│  └───────────────────────────────────┘          │
│                                                  │
│  Random seed: 42 → Deterministic replay         │
└─────────────────────────────────────────────────┘
```

The power of this approach:

- **Reproducibility**: Found a bug? The random seed reproduces it exactly, every time.
- **Speed**: Without real network or disk latency, millions of simulated operations run in seconds.
- **Coverage**: The harness can systematically explore failure schedules that would take years to encounter in production.

FoundationDB reportedly ran over **one million simulated hours per day** of testing. Will Wilson's 2014 Strange Loop talk described finding bugs that would only manifest once every few weeks of continuous operation — bugs that deterministic simulation found in minutes.

### The Cost

Deterministic simulation requires your entire system to be written against an abstraction layer. Every I/O call — network send, disk write, clock read — must go through an interface that the test harness can replace. This is a significant architectural commitment that must be made from the start. Retrofitting it onto an existing system is impractical.

### Antithesis and the Simulation Renaissance

Antithesis (founded by former FoundationDB engineers) commercialized this approach as a service. Their platform runs your actual compiled binaries inside a deterministic virtual machine. Instead of requiring your code to use simulated I/O, they intercept all system calls at the hypervisor level.

This "deterministic simulation for any code" approach is gaining traction. TigerBeetle, a financial transactions database, uses a similar approach built in-house with their Zig-based simulation framework.

---

## Jepsen: The Distributed Systems Audit

Jepsen, created by Kyle Kingsbury (Aphyr), is the most influential distributed systems testing framework. It has found critical bugs in nearly every major distributed database, including MongoDB, Elasticsearch, CockroachDB, YugabyteDB, Redis, Cassandra, RabbitMQ, etcd, and many more.

### Architecture

Jepsen is a Clojure framework that orchestrates real distributed system deployments and tests their correctness under fault injection.

```
┌──────────────────────────────────────┐
│           Jepsen Control Node        │
│                                      │
│  ┌────────────┐  ┌────────────────┐  │
│  │  Client     │  │  Nemesis       │  │
│  │  (workload) │  │  (fault injector)│ │
│  └──────┬─────┘  └───────┬────────┘  │
│         │                │            │
└─────────┼────────────────┼────────────┘
          │                │
     ┌────┴────┐     ┌────┴────┐
     │         │     │         │
  ┌──┴──┐  ┌──┴──┐  │  Faults │
  │DB n1│  │DB n2│  │(partition│
  │     │  │     │  │ kill,    │
  └─────┘  └─────┘  │ clock)  │
  ┌─────┐  ┌─────┐  └─────────┘
  │DB n3│  │DB n4│
  │     │  │     │
  └─────┘  └─────┘
        ┌─────┐
        │DB n5│
        └─────┘
```

A Jepsen test has four components:

**1. Database Setup**: Deploy the system under test on a cluster of nodes (typically 5 LXC containers or VMs).

**2. Client (Workload)**: Generate operations (reads, writes, compare-and-swap) and record their invocation and completion times with the values involved.

**3. Nemesis (Fault Injector)**: Inject faults according to a schedule:
- Network partitions (iptables rules)
- Node crashes (kill -9, then restart)
- Clock skew (ntpd manipulation)
- Disk pauses (SIGSTOP the process)
- Combination of the above

**4. Checker (Consistency Verifier)**: After the test, analyze the recorded history of operations and verify that it satisfies the claimed consistency model.

### The History and the Checker

The core of Jepsen's power is in the checker. During a test, every client operation is recorded as a pair:

```clojure
;; Invocation: client asked the database to do something
{:type :invoke, :f :write, :value 42, :process 3, :time 1234567890}

;; Completion: database responded
{:type :ok, :f :write, :value 42, :process 3, :time 1234567950}

;; Or, the operation might fail
{:type :fail, :f :read, :value nil, :process 5, :time 1234568000}

;; Or, we might not know (timeout, crash)
{:type :info, :f :write, :value 42, :process 3, :time 1234568100}
```

After the test, the checker takes this history and asks: **Is there any legal sequential ordering of these operations that is consistent with the claimed consistency model?**

For linearizability checking, Jepsen uses the **Knossos** algorithm (and later, the faster **Elle** checker). The algorithm:

1. Consider all completed operations (`:ok` responses)
2. For operations with unknown outcomes (`:info`), consider both "it happened" and "it didn't happen"
3. Try to find a total order of these operations such that:
   - The order is consistent with real-time (if operation A completed before operation B started, A must come before B)
   - Every read returns the value of the most recent preceding write in the order

If no such ordering exists, the history is **not linearizable**, and the system has a bug.

```
Example non-linearizable history:

Process 1: |--- write(x=1) ---|
Process 2:          |--- write(x=2) ---|
Process 3:                      |--- read(x=1) ---|

Timeline:  ────────────────────────────────────────────▶

Process 3's read of x=1 starts AFTER process 2's write of x=2 completes.
Under linearizability, the read must return 2 (or a later value).
Returning 1 means the write of 2 was "lost" — a linearizability violation.
```

### Famous Jepsen Findings

Jepsen has exposed bugs in nearly every distributed system it has tested. Some notable findings:

**MongoDB (2013, 2015, 2017)**:
- Writes acknowledged as "committed" were lost during replica set failover
- The `w: "majority"` write concern, which should guarantee durability, could lose writes when combined with read concern `local`
- MongoDB's documentation claimed stronger consistency guarantees than the system actually provided

**Elasticsearch (2014)**:
- Split-brain scenarios allowed two primaries to accept conflicting writes
- After the partition healed, one set of writes was silently lost
- Elasticsearch acknowledged this and added the `minimum_master_nodes` setting (later replaced by a new cluster coordination mechanism)

**CockroachDB (2017-2021)**:
- Multiple serializable isolation violations found across several rounds of testing
- Each round found new issues despite fixes from previous rounds, demonstrating the depth of the problem
- CockroachDB consistently engaged with findings and shipped fixes

**Redis/RedLock (2016)**:
- Jepsen analysis (combined with Martin Kleppmann's critique) showed that RedLock, Redis's distributed lock algorithm, could grant the same lock to two clients simultaneously
- The fundamental issue: RedLock depends on synchronized clocks, but clock skew can cause lock safety violations
- This analysis led to widespread recognition that Redis is not suitable for strong consistency guarantees

**etcd (2014, 2020)**:
- Early versions had linearizability violations during leader elections
- Later versions showed issues with watch delivery ordering
- etcd team worked closely with Jepsen to resolve findings

### Writing a Jepsen Test

A simplified Jepsen test structure:

```clojure
(defn register-test
  "Tests linearizability of a single register."
  [opts]
  (merge tests/noop-test
         opts
         {:name      "register"
          :client    (register-client nil)    ; Reads and writes a single register
          :nemesis   (nemesis/partition-random-halves)  ; Random network partitions
          :generator (gen/mix
                       [(gen/clients
                          (gen/mix [r w cas]))  ; Mix of reads, writes, CAS
                        (gen/nemesis
                          (gen/seq
                            [(gen/sleep 5)
                             {:type :info, :f :start}   ; Start partition
                             (gen/sleep 5)
                             {:type :info, :f :stop}    ; Heal partition
                             (gen/sleep 5)]))])
          :checker   (checker/linearizable
                       {:model (model/register)
                        :algorithm :linear})}))
```

The test:
1. Deploys the database on 5 nodes
2. Runs a mix of reads, writes, and compare-and-swap operations from multiple concurrent clients
3. Periodically partitions the network into two halves and heals it
4. Records every operation's invocation and response
5. After the test, checks whether the recorded history is linearizable

### Elle: Transactional Consistency Checking

For databases that support transactions, Jepsen uses **Elle**, a checker that can verify transactional isolation levels (serializable, snapshot isolation, read committed, etc.).

Elle works by constructing a **dependency graph** from the observed transaction history:

```
Transaction T1: write(x=1), write(y=1)
Transaction T2: read(x=1), write(y=2)
Transaction T3: read(y=2), read(x=?)

Dependency graph:
T1 ──wr──▶ T2    (T2 read x=1 written by T1)
T2 ──wr──▶ T3    (T3 read y=2 written by T2)

If T3 reads x=0 (the initial value), that means T3 saw T2's write
to y but NOT T1's write to x. But T2 depends on T1 (read T1's write
to x). This is a cycle in the dependency graph:
T1 → T2 → T3 → T1 (T3 must come before T1 since it read x=0)

A cycle means the history is NOT serializable.
```

Elle detects these cycles automatically and generates visualizations showing exactly which transactions violated the claimed isolation level.

---

## Chaos Engineering

While Jepsen is a correctness-focused testing tool, **chaos engineering** is a discipline for testing resilience in production or production-like environments. The focus shifts from "is the system correct?" to "does the system degrade gracefully?"

### Principles of Chaos Engineering

The Principles of Chaos Engineering (principlesofchaos.org) define the practice:

1. **Start by defining "steady state"**: Identify measurable outputs that indicate normal system behavior (request rate, error rate, latency percentiles).

2. **Hypothesize that steady state will continue**: Form a hypothesis like "if we kill one of three database replicas, latency will increase by at most 50ms and error rate will stay below 0.1%."

3. **Introduce real-world events**: Inject the failure.

4. **Try to disprove the hypothesis**: Look for deviations from steady state.

The key insight: chaos engineering is an experiment, not a test. You're not checking pass/fail — you're learning about your system's behavior under conditions you haven't seen before.

### Netflix: Where Chaos Engineering Started

Netflix pioneered chaos engineering out of necessity. After migrating to AWS in 2010, they needed confidence that their system could handle the inevitable failures of cloud infrastructure.

**Chaos Monkey (2011)**: Randomly kills EC2 instances in production during business hours. The hypothesis: if any single instance dies, users should not notice. Chaos Monkey forced Netflix engineers to build redundancy into every service from day one.

**Chaos Kong (2015)**: Simulates the failure of an entire AWS region. Netflix routes traffic away from a region and verifies that the remaining regions absorb the load. This exercise exposed cascading failures that no amount of single-instance testing would find.

**Failure Injection Testing (FIT)**: Netflix's framework for controlled fault injection at the service level:

```
┌─────────────────────────────────────────────────┐
│                FIT Framework                     │
│                                                  │
│  Injection Points:                               │
│  ┌─────────────────┐  ┌─────────────────┐       │
│  │ Network latency  │  │ Service errors   │       │
│  │ (add 500ms to   │  │ (return 500 for  │       │
│  │  calls to svc X)│  │  10% of requests)│       │
│  └─────────────────┘  └─────────────────┘       │
│  ┌─────────────────┐  ┌─────────────────┐       │
│  │ Resource exhaust │  │ Dependency      │       │
│  │ (fill disk, OOM)│  │ unavailability   │       │
│  └─────────────────┘  └─────────────────┘       │
│                                                  │
│  Scope Control:                                  │
│  • By service / endpoint                         │
│  • By percentage of traffic                      │
│  • By user segment (internal users first)        │
│  • By region / availability zone                 │
│  • Automatic abort on impact threshold           │
└─────────────────────────────────────────────────┘
```

FIT answers specific questions:
- What happens to the recommendation service if the user profile service returns errors for 30 seconds?
- What happens to checkout if the fraud detection service is slow (adds 2 seconds)?
- What happens to the entire system if US-East-1 becomes unreachable?

### The Blast Radius Problem

Chaos engineering in production is powerful but dangerous. Netflix manages blast radius with:

1. **Canary scope**: Run experiments on a small percentage of traffic first.
2. **Automatic abort**: If error rates exceed a threshold, automatically stop the experiment.
3. **Business hours only**: Run experiments when engineers are available to respond.
4. **Gradual escalation**: Start with single-instance failures, then multi-instance, then availability zone, then region.

### ChaosBlade and LitmusChaos

Open-source chaos engineering tools have matured significantly:

**ChaosBlade** (Alibaba, open-sourced 2019): Injects faults at multiple levels — process, network, JVM, container, Kubernetes pod. Supports injection into Java applications at the bytecode level (delay a specific method, throw exceptions from specific code paths).

**LitmusChaos** (CNCF project): Kubernetes-native chaos engineering. Defines chaos experiments as Kubernetes custom resources:

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: pod-kill-experiment
spec:
  appinfo:
    appns: 'default'
    applabel: 'app=payment-service'
  chaosServiceAccount: litmus-admin
  experiments:
    - name: pod-delete
      spec:
        components:
          env:
            - name: TOTAL_CHAOS_DURATION
              value: '30'
            - name: CHAOS_INTERVAL
              value: '10'
            - name: FORCE
              value: 'true'
```

---

## Fault Injection Categories

Effective distributed testing requires injecting faults at every layer. Here's a taxonomy of injectable faults and the tools that inject them:

### Network Faults

**Partition**: Completely sever communication between groups of nodes.
```bash
# Using iptables to partition node 1 from nodes 2 and 3
iptables -A INPUT -s 10.0.0.2 -j DROP
iptables -A INPUT -s 10.0.0.3 -j DROP
iptables -A OUTPUT -d 10.0.0.2 -j DROP
iptables -A OUTPUT -d 10.0.0.3 -j DROP
```

**Asymmetric partition**: Node A can send to B but not receive from B.
```bash
# A can send to B, but drops everything from B
iptables -A INPUT -s 10.0.0.2 -j DROP
# (no OUTPUT rule — A's outbound packets to B still go through)
```

Asymmetric partitions are particularly nasty because many protocols assume symmetric communication. A leader might believe it's still communicating with followers (its messages arrive) while followers believe the leader is dead (they receive nothing).

**Latency**: Add delay to network communication.
```bash
# Add 200ms latency with 50ms jitter using tc (traffic control)
tc qdisc add dev eth0 root netem delay 200ms 50ms distribution normal
```

**Packet loss**: Drop a percentage of packets.
```bash
# Drop 10% of packets
tc qdisc add dev eth0 root netem loss 10%
```

**Packet reordering**: Deliver packets out of order.
```bash
# Reorder 25% of packets with a 50ms delay
tc qdisc add dev eth0 root netem delay 50ms reorder 25%
```

**Packet corruption**: Flip bits in packets (tests TCP checksum handling and application-level integrity checks).
```bash
# Corrupt 1% of packets
tc qdisc add dev eth0 root netem corrupt 1%
```

### Toxiproxy: Application-Level Network Fault Injection

Toxiproxy (from Shopify) sits between your application and its dependencies as a TCP proxy. It's cleaner than iptables for testing because it operates at the application level:

```
Normal:
  App ──────────────▶ Database:5432

With Toxiproxy:
  App ──▶ Toxiproxy:15432 ──▶ Database:5432
                │
                ├── Add 500ms latency
                ├── Drop 10% of data
                ├── Sever connection after 5 seconds
                └── Limit bandwidth to 1KB/s
```

```bash
# Create a proxy
toxiproxy-cli create postgres -l localhost:15432 -u postgres:5432

# Add latency
toxiproxy-cli toxic add postgres -t latency -a latency=500 -a jitter=100

# Simulate connection reset
toxiproxy-cli toxic add postgres -t reset_peer -a timeout=5000

# Simulate slow reads (1KB/s)
toxiproxy-cli toxic add postgres -t bandwidth -a rate=1
```

### Clock Faults

Clock faults test whether the system depends on synchronized time (which it shouldn't, per Chapter 9):

```bash
# Jump clock forward by 1 hour
date -s "+1 hour"

# Set clock back by 5 minutes (dangerous — may break TLS certificates)
date -s "-5 minutes"

# Introduce gradual drift by adjusting NTP
# Set NTP offset to 500ms
ntpdate -B -o 500 time.example.com

# Or use faketime for per-process clock manipulation
LD_PRELOAD=/usr/lib/faketime/libfaketime.so.1 \
FAKETIME="+2h" \
./my-database-server
```

Jepsen's clock skew nemesis uses `ntpdate` to manipulate NTP on individual nodes, creating scenarios where nodes disagree on the current time by hundreds of milliseconds.

### Process Faults

**Crash (kill -9)**: Immediate termination. No cleanup, no graceful shutdown. Tests crash-recovery behavior.

**Suspend (kill -STOP / kill -CONT)**: Freeze the process without killing it. The process appears dead to peers (no heartbeats) but resumes exactly where it left off when continued. This simulates a long GC pause — a common cause of false failure detection in Java-based systems.

```bash
# Freeze the process (simulates GC pause)
kill -STOP $(pidof my-database)

# After 30 seconds, resume it
sleep 30 && kill -CONT $(pidof my-database)
```

**OOM kill**: Simulate the Linux OOM killer selecting the database process.

**Slow process**: Reduce CPU priority to simulate a heavily loaded machine.
```bash
# Set lowest CPU priority
renice -n 19 -p $(pidof my-database)

# Or use cgroups to limit CPU
echo 10000 > /sys/fs/cgroup/cpu/mydb/cpu.cfs_quota_us
```

### Disk Faults

**Disk full**: Fill the disk and observe whether the system handles write failures gracefully.
```bash
# Fill disk with zeros
dd if=/dev/zero of=/mnt/data/fillfile bs=1M count=10000
```

**Slow disk**: Inject latency into I/O operations using `dm-delay` (device-mapper delay target) or `fuse` filesystem wrappers.

**Disk corruption**: Use `dm-flakey` to simulate a disk that occasionally returns garbage data.
```bash
# Create a flakey device that drops writes for 1 second every 60 seconds
dmsetup create flakey-disk --table \
  "0 $(blockdev --getsz /dev/sdb) flakey /dev/sdb 0 60 1"
```

**fsync failure**: Use `libeatmydata` or error injection to simulate fsync returning success without actually flushing to disk. This tests whether the system survives a power failure after an fsync that the OS "confirmed."

---

## Property-Based Testing for Distributed Systems

Property-based testing generates random inputs and checks that invariants hold. For distributed systems, the "inputs" include the timing of operations and failures.

### The Approach

Instead of writing specific test cases, define properties that must always be true:

```python
# Property: linearizability of a register
# For any sequence of reads and writes with any failure injection,
# the observed results must be consistent with some sequential execution.

@given(
    operations=st.lists(
        st.one_of(
            st.tuples(st.just("write"), st.integers()),
            st.tuples(st.just("read"), st.just(None))
        ),
        min_size=10, max_size=100
    ),
    faults=st.lists(
        st.one_of(
            st.just("partition"),
            st.just("kill_leader"),
            st.just("slow_follower"),
            st.just("clock_skew")
        ),
        min_size=0, max_size=5
    )
)
def test_register_linearizable(operations, faults):
    history = run_test(operations, faults)
    assert is_linearizable(history)
```

### Hypothesis for Distributed Systems

Python's Hypothesis library can generate test cases for distributed system properties. The `stateful testing` module is particularly useful — it models the system as a state machine and generates sequences of operations:

```python
class DistributedRegisterMachine(RuleBasedStateMachine):
    def __init__(self):
        super().__init__()
        self.cluster = start_cluster(3)
        self.expected_value = 0

    @rule(value=st.integers(0, 1000))
    def write(self, value):
        self.cluster.write("key", value)
        self.expected_value = value

    @rule()
    def read(self):
        result = self.cluster.read("key")
        # Under linearizability, a read must return
        # the most recently written value
        assert result == self.expected_value

    @rule()
    def partition_random(self):
        self.cluster.inject_partition()

    @rule()
    def heal_partition(self):
        self.cluster.heal_partition()

    @rule()
    def kill_random_node(self):
        self.cluster.kill_random_node()

    @rule()
    def restart_killed_nodes(self):
        self.cluster.restart_all()
```

### Molly: Lineage-Driven Fault Injection

Molly (Alvaro et al., 2015) takes a fundamentally different approach. Instead of randomly injecting faults and hoping to hit a bug, Molly works backward from the desired outcome:

1. Run the system without faults and record the "lineage" of each successful outcome — which messages and computations led to it
2. Identify which messages are critical (removing them would prevent the outcome)
3. Inject faults that drop exactly those critical messages
4. Check whether the system still produces the correct outcome

```
Normal execution:
  A ─── m1 ───▶ B ─── m2 ───▶ C
       (write)      (replicate)

Lineage of "write is durable on C":
  m1 (A→B), m2 (B→C)

Molly asks: "What if m2 is dropped?"
  A ─── m1 ───▶ B ─── m2 ──✕  C
                    (dropped)

Does the system recover? (e.g., via anti-entropy, read-repair)
If not → BUG: single message loss causes data loss
```

This approach is much more efficient than random fault injection because it targets exactly the faults most likely to cause problems. The paper demonstrated that Molly found bugs in distributed protocols with orders of magnitude fewer test executions than random testing.

---

## Real War Stories

These incidents illustrate why testing distributed systems is not optional.

### GitHub's MySQL Raft Incident (2023)

GitHub migrated their MySQL infrastructure to use Raft-based replication. During a routine failover, a bug in log reconciliation caused a newly elected leader to truncate committed entries. The result: data that had been confirmed as written was silently lost.

The root cause: an edge case in Raft log compaction where a snapshot and a log entry had the same index but different terms. The code assumed this couldn't happen, but under a specific sequence of leader elections, it could.

This is exactly the kind of bug Jepsen is designed to find — a linearizability violation during leader election under specific timing.

### Cloudflare's Leap Second Bug (2017)

Cloudflare's RRDNS software used Go's `time.Now()` to calculate time differences. On January 1, 2017, a leap second caused `time.Now()` to return a value slightly in the past relative to a previous call. The code computed a negative time difference, which was interpreted as a very large positive number (unsigned integer underflow), causing DNS responses to be dropped.

The fix was trivial (use monotonic clocks), but the failure was catastrophic (worldwide DNS resolution failures for Cloudflare customers). No amount of functional testing would have caught this — it required specifically testing with clock jumps.

### Amazon DynamoDB's 2015 Outage

A metadata partition's leader node experienced a memory leak that gradually slowed its heartbeats. The failure detector eventually declared it dead and triggered an election. But the election itself depended on the same metadata service, creating a circular dependency. The new leader couldn't complete initialization without reading metadata, but the metadata was unavailable during the election.

This cascading failure — slow node → election → election depends on the slow service — is the kind of failure that only emerges under specific timing conditions that chaos engineering is designed to discover.

### CockroachDB's "Lost Update" Bug (2019)

Jepsen found that CockroachDB could lose updates under a specific interleaving of transactions:

1. Transaction T1 reads key X
2. Transaction T2 writes key X and commits
3. Transaction T1 writes key X based on its earlier read (the stale value) and commits
4. T2's write is silently overwritten by T1

Under serializable isolation, this should be impossible — T1 should have been aborted when T2 committed a conflicting write. The bug was in the timestamp management during transaction restarts.

---

## Building a Testing Strategy

No single tool covers everything. A comprehensive testing strategy layers multiple approaches:

```
┌─────────────────────────────────────────────┐
│  Level 5: Production chaos engineering       │
│  (Chaos Monkey, FIT, controlled experiments)│
├─────────────────────────────────────────────┤
│  Level 4: Jepsen-style integration tests    │
│  (Real deployment, fault injection,         │
│   consistency checking)                      │
├─────────────────────────────────────────────┤
│  Level 3: Property-based / simulation tests │
│  (Deterministic simulation,                  │
│   Hypothesis stateful testing)               │
├─────────────────────────────────────────────┤
│  Level 2: Single-node fault injection       │
│  (Toxiproxy, disk faults, clock manipulation)│
├─────────────────────────────────────────────┤
│  Level 1: Unit tests with mocked network    │
│  (Verify protocol logic in isolation)        │
└─────────────────────────────────────────────┘
```

### What to Test

For any distributed system, verify these properties:

**Durability**: A write acknowledged as committed is never lost, even if nodes crash immediately after.

**Consistency**: The system provides its claimed consistency level (linearizable, serializable, etc.) — verify with a checker, not by eyeballing results.

**Availability**: The system continues serving requests (possibly at degraded performance) during expected failure modes (one node down, network partition between minority and majority).

**Convergence**: After a partition heals or a failed node recovers, all replicas eventually agree on the same state.

**Liveness**: The system makes progress. Operations eventually complete (or return an error). No deadlocks, no infinite election loops, no split-brain that never resolves.

### When to Test

- **Before every release**: Run Jepsen-style tests as part of CI. CockroachDB runs Jepsen tests nightly.
- **After configuration changes**: A system that's correct with 3 replicas might have bugs with 5.
- **Continuously in production**: Chaos engineering experiments should run regularly, not just once.
- **After incidents**: Reproduce the incident as a test case and verify the fix prevents it.

---

## Key Takeaways

1. **Traditional testing is necessary but insufficient.** Unit tests and integration tests verify the happy path. Distributed system bugs live in the failure paths.

2. **Deterministic simulation is the gold standard** for correctness testing. If you're building a new distributed system, design for it from the start.

3. **Jepsen is the industry standard** for auditing existing distributed systems. Its consistency checkers (Knossos, Elle) can prove whether a system meets its claimed guarantees.

4. **Chaos engineering complements correctness testing.** Jepsen asks "is it correct?" Chaos engineering asks "is it resilient?" You need both.

5. **Fault injection must cover every layer**: network (partitions, latency, loss), clock (skew, jumps), process (crash, pause, slow), and disk (full, slow, corrupt).

6. **Bugs in error-handling code cause most catastrophic failures.** The code that runs during the rare failure scenario is the least tested and most likely to be wrong.

7. **Testing is not a one-time event.** Every code change, configuration change, and version upgrade can introduce new failure modes. Automated, continuous testing is the only approach that scales.

---

## References

- Yuan, D., et al. "Simple Testing Can Prevent Most Critical Failures." OSDI 2014.
- Kingsbury, K. "Jepsen: Distributed Systems Safety Research." jepsen.io
- Alvaro, P., et al. "Lineage-driven Fault Injection." SIGMOD 2015.
- Basiri, A., et al. "Chaos Engineering." IEEE Software, 2016.
- Wilson, W. "Testing Distributed Systems w/ Deterministic Simulation." Strange Loop 2014.
- Rosenthal, C., Jones, N. "Chaos Engineering: System Resiliency in Practice." O'Reilly, 2020.
- Kleppmann, M. "How to do distributed locking." martin.kleppmann.com, 2016.

---

**Next**: [Chapter 24 — ZooKeeper and Coordination Services →](ch24-zookeeper.md)
