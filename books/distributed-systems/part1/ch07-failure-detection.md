# Chapter 7: Failure Detection — You Can't Tell Dead from Slow

## The Question This Chapter Answers

**How does a system decide a server is gone when it might just be overloaded?**

You ping a server. No response. Is it dead? Is it just slow? Is the network between you broken? You cannot know. This is not a limitation of your monitoring setup — it is a fundamental property of distributed systems. And yet, every distributed system must make decisions based on whether other nodes are alive. This chapter explains why that decision is inherently uncertain, what the theoretical limits are, and how real systems navigate this impossibility.

---

## 7.1 Why This Problem Is Harder Than It Looks

On a single machine, failure detection is relatively straightforward. If a thread dies, the OS knows. If a process crashes, it returns an exit code. The operating system has a god's-eye view of everything running on that machine.

In a distributed system, there is no god's-eye view. Each node can only observe the *absence* of expected messages. And absence of evidence is not evidence of absence.

Consider this scenario:

```
Node A sends a request to Node B at time T=0.
Node A waits.
At T=5 seconds, no response has arrived.
```

What happened? Any of these could be true:

1. **Node B crashed** — the process died, the machine lost power, the kernel panicked
2. **Node B is alive but slow** — it's doing a garbage collection pause, swapping to disk, or processing a large batch
3. **Node B responded, but the response was lost** — a switch dropped the packet, a buffer overflowed
4. **Node A's request never reached B** — the network is partitioned in the A→B direction
5. **Node B responded, but the response is still in transit** — latency spike on the return path
6. **Node B is alive but has stopped processing** — its event loop is deadlocked, but TCP keepalives still respond

Each of these scenarios requires a different response. In scenario 1, you should fail over to a backup. In scenario 2, you should wait longer. In scenario 3, you should retry. In scenario 6, the node appears alive to heartbeats but is functionally dead.

The terrifying truth: **from Node A's perspective, all six scenarios look identical.** All Node A observes is: "I sent a message and haven't gotten a response yet."

---

## 7.2 The Fundamental Trade-off

Every failure detector must navigate a tension between two properties:

### Speed (Time to Detection)

How quickly do you declare a node dead after it actually crashes? If your timeout is 30 seconds, and the node crashed at T=0, you're running for 30 seconds with a stale view of the cluster. During those 30 seconds:
- Requests routed to the dead node will fail
- Replicated data on that node is unavailable for reads
- A new leader cannot be elected
- Client-visible errors accumulate

### Accuracy (Avoiding False Positives)

How often do you incorrectly declare a living node dead? If your timeout is 500ms and the node is just experiencing a GC pause, you'll declare it dead, trigger a failover, and then the "dead" node comes back online. Now you have:
- Two nodes that both think they're the primary (split brain)
- A rebalancing operation that was unnecessary
- Wasted network bandwidth for data re-replication
- Possible data inconsistency if both nodes accepted writes

```
                    SPEED vs ACCURACY

    Short timeout                    Long timeout
    ┌──────────────────────────────────────────┐
    │                                          │
    │  Fast detection          Slow detection  │
    │  Many false positives    Few false pos.   │
    │  Risk: split brain       Risk: long       │
    │                          unavailability   │
    │                                          │
    └──────────────────────────────────────────┘

    There is no timeout value that is "correct."
    The optimal value depends on your system's
    tolerance for each type of error.
```

This is not a problem you can engineer away with better hardware. Even with fiber optic links and NVMe disks, latency distributions have long tails. A 99th-percentile latency of 200ms means that 1 in 100 requests will look like a failure to a 200ms timeout.

---

## 7.3 Formal Framework: Chandra and Toueg's Failure Detector Classes

In 1996, Tushar Deepak Chandra and Sam Toueg published a foundational paper that formalized exactly what failure detectors can and cannot do. Instead of trying to build a "perfect" failure detector (which is impossible in an asynchronous system — see the FLP result in Chapter 21), they classified failure detectors by two properties:

### Completeness

**Strong Completeness**: Eventually, every process that crashes is permanently suspected by every correct process.

**Weak Completeness**: Eventually, every process that crashes is permanently suspected by *some* correct process.

### Accuracy

**Strong Accuracy**: No correct process is ever suspected.

**Weak Accuracy**: There exists some correct process that is never suspected.

**Eventual Strong Accuracy**: After some unknown finite time, no correct process is suspected.

**Eventual Weak Accuracy**: After some unknown finite time, there exists a correct process that is never suspected.

These combine into named failure detector classes:

```
┌────────────────────┬─────────────────────┬─────────────────────────┐
│                    │ Strong Completeness │ Weak Completeness       │
├────────────────────┼─────────────────────┼─────────────────────────┤
│ Strong Accuracy    │ Perfect (P)         │ —                       │
├────────────────────┼─────────────────────┼─────────────────────────┤
│ Weak Accuracy      │ Strong (S)          │ Weak (W)                │
├────────────────────┼─────────────────────┼─────────────────────────┤
│ Eventual Strong    │ Eventually          │ —                       │
│ Accuracy           │ Perfect (◇P)        │                         │
├────────────────────┼─────────────────────┼─────────────────────────┤
│ Eventual Weak      │ Eventually          │ Eventually Weak (◇W)    │
│ Accuracy           │ Strong (◇S)         │                         │
└────────────────────┴─────────────────────┴─────────────────────────┘
```

### Why This Matters in Practice

The **Perfect** failure detector (P) — every crash is detected, and no correct process is ever falsely suspected — is impossible to build in an asynchronous system. You would need to distinguish "dead" from "slow" with certainty, and as we established, you can't.

The critical result from Chandra and Toueg's work: **the Eventually Strong (◇S) failure detector is the weakest failure detector that can solve consensus.** This means:

1. You need a failure detector at least as strong as ◇S to solve consensus
2. ◇S only requires that *eventually* the failure detector stops making mistakes — it's allowed to be wrong for an arbitrary (but finite) period

This is liberating. It means we don't need perfect failure detection. We need failure detection that *eventually* converges to the truth. In practice, this is achievable: networks do settle, GC pauses do end, and if a node truly crashed, it stays crashed.

---

## 7.4 Heartbeats: The Simplest Failure Detector

The most common failure detection mechanism in production is the heartbeat: a periodic message that says "I'm alive."

### Basic Heartbeat Protocol

```
Node B sends a heartbeat to Node A every Δ milliseconds.
Node A maintains a timer for Node B.
Every time a heartbeat arrives, Node A resets the timer.
If the timer exceeds T milliseconds without a heartbeat, 
  Node A declares Node B "suspected."
```

There are two key parameters:

- **Δ (heartbeat interval)**: How often heartbeats are sent
- **T (timeout threshold)**: How long to wait before suspecting failure

The relationship between these determines the failure detector's behavior:

```python
class HeartbeatFailureDetector:
    def __init__(self, heartbeat_interval_ms, timeout_ms):
        self.interval = heartbeat_interval_ms
        self.timeout = timeout_ms
        self.last_heartbeat = {}  # node_id -> timestamp
    
    def receive_heartbeat(self, node_id):
        self.last_heartbeat[node_id] = current_time_ms()
    
    def is_alive(self, node_id):
        if node_id not in self.last_heartbeat:
            return False
        elapsed = current_time_ms() - self.last_heartbeat[node_id]
        return elapsed < self.timeout
    
    def suspected_nodes(self):
        return [
            node_id for node_id, last_seen 
            in self.last_heartbeat.items()
            if current_time_ms() - last_seen >= self.timeout
        ]
```

### How Do You Choose the Timeout?

If Node B sends heartbeats every 1 second (Δ = 1000ms), what should the timeout T be?

**If T = 1000ms (= Δ):** A single delayed heartbeat triggers a false positive. In any real network, packet delays routinely exceed one heartbeat interval. This will generate constant false alarms.

**If T = 2000ms (= 2Δ):** One heartbeat can be lost or delayed, and the next one still arrives in time. Better, but a GC pause of 1.5 seconds still triggers a false positive.

**If T = 10000ms (= 10Δ):** Very few false positives, but a real crash takes 10 seconds to detect. In a system processing 50,000 requests/second, that's 500,000 requests sent to a dead node.

In practice, most systems set T somewhere between 3Δ and 10Δ, with the exact value tuned by operational experience. Kubernetes, for example, uses a default node heartbeat interval of 10 seconds and a timeout of 40 seconds (4Δ).

### Push vs. Pull Heartbeats

**Push model**: Each node sends heartbeats to all nodes that monitor it. Simple, but generates O(n²) messages in a fully-connected cluster.

```
Push heartbeats in a 4-node cluster:

  A ──heartbeat──▶ B
  A ──heartbeat──▶ C
  A ──heartbeat──▶ D
  B ──heartbeat──▶ A
  B ──heartbeat──▶ C
  B ──heartbeat──▶ D
  C ──heartbeat──▶ A
  C ──heartbeat──▶ B
  C ──heartbeat──▶ D
  D ──heartbeat──▶ A
  D ──heartbeat──▶ B
  D ──heartbeat──▶ C

  12 messages per heartbeat round (n × (n-1))
```

**Pull model**: A monitor node periodically pings each target node and waits for a response. The monitor is a single point of failure, so you typically have multiple monitors.

```
Pull heartbeats with a single monitor:

  Monitor ──ping──▶ A ──pong──▶ Monitor
  Monitor ──ping──▶ B ──pong──▶ Monitor
  Monitor ──ping──▶ C ──pong──▶ Monitor
  Monitor ──ping──▶ D ──pong──▶ Monitor

  8 messages per heartbeat round (2n)
  But: what if the Monitor crashes?
```

### Gossip-Based Heartbeats

To avoid O(n²) messages while still having every node participate in detection, gossip protocols propagate heartbeat information indirectly.

Each node maintains a heartbeat counter that it increments every interval. On each gossip round, a node picks a random peer and sends its entire table of known heartbeat counters. The receiver merges the table, keeping the highest counter for each node.

```python
class GossipFailureDetector:
    def __init__(self, node_id, all_nodes, gossip_interval_ms, timeout_ms):
        self.node_id = node_id
        self.all_nodes = all_nodes
        self.interval = gossip_interval_ms
        self.timeout = timeout_ms
        # Each entry: {counter, last_updated_local_time}
        self.heartbeat_table = {
            n: {"counter": 0, "local_time": current_time_ms()} 
            for n in all_nodes
        }
    
    def increment_own_heartbeat(self):
        """Called every heartbeat interval."""
        self.heartbeat_table[self.node_id]["counter"] += 1
        self.heartbeat_table[self.node_id]["local_time"] = current_time_ms()
    
    def gossip(self):
        """Pick a random peer and send our table."""
        peer = random.choice([n for n in self.all_nodes if n != self.node_id])
        send(peer, self.heartbeat_table)
    
    def receive_gossip(self, remote_table):
        """Merge remote table, keeping higher counters."""
        for node_id, remote_entry in remote_table.items():
            local_entry = self.heartbeat_table.get(node_id)
            if local_entry is None or remote_entry["counter"] > local_entry["counter"]:
                self.heartbeat_table[node_id] = {
                    "counter": remote_entry["counter"],
                    "local_time": current_time_ms()  # We just learned about this
                }
    
    def suspected_nodes(self):
        """Nodes whose counter hasn't increased within the timeout."""
        now = current_time_ms()
        return [
            node_id for node_id, entry in self.heartbeat_table.items()
            if node_id != self.node_id and (now - entry["local_time"]) > self.timeout
        ]
```

The gossip approach has several advantages:
- **O(n) messages per round** (each node gossips with one peer)
- **No single point of failure** (every node participates)
- **Probabilistic completeness** — a crashed node's counter stops incrementing, and within O(log n) gossip rounds, every correct node notices

The disadvantage is slower detection: information about a crash propagates through the gossip protocol rather than being detected directly. If Node C crashes, Node A might not learn about it until Node B gossips C's stale counter to A. This adds gossip propagation delay on top of the timeout.

Cassandra uses gossip-based failure detection as the substrate for its Phi Accrual detector (Chapter 8).

---

## 7.5 The Gray Failure Problem

The simple model of "alive or dead" misses an entire category of failures that cause the majority of production outages: **gray failures**, where a node is partially functional.

### What Gray Failure Looks Like

A node experiencing gray failure might:
- Respond to heartbeats (TCP keepalives) but not process application requests
- Process reads but fail all writes (disk full, but read cache still works)
- Process some requests but drop others (intermittent NIC errors)
- Respond extremely slowly (100x normal latency due to memory pressure)
- Work correctly for 90% of callers but be unreachable from 10% (asymmetric network partition)

```
Gray failure: the node is a "zombie"

                ┌──────────────┐
                │   Node B     │
                │              │
  Heartbeat ────▶  ✓ responds  │
                │              │
  App Request ──▶  ✗ hangs     │
                │              │
  TCP probe ────▶  ✓ alive     │
                │              │
  Write op ─────▶  ✗ disk full │
                └──────────────┘

  Heartbeat says: ALIVE
  Reality: PARTIALLY DEAD
```

### Real-World Gray Failure Incidents

**GitHub (2012)**: A file server experienced memory corruption that caused it to serve stale file data. Heartbeats continued to succeed because the kernel and network stack were fine. The corruption was in the application's memory-mapped file cache. Users saw repository data from hours earlier, and the monitoring system reported no errors.

**Amazon (2011)**: During the famous US-East-1 outage, EBS volumes entered a "stuck" state where they responded to control plane operations but couldn't process I/O. Instances appeared healthy to the load balancer (health checks hit the application layer, which responded from cache) but couldn't write to disk.

**Cloudflare (2020)**: A router partially failed — it forwarded some traffic correctly but dropped packets above a certain size due to a hardware defect. Small heartbeat packets passed fine. Large application payloads were silently dropped. The router appeared fully healthy to all monitoring systems.

### Detecting Gray Failures

Simple heartbeats cannot detect gray failures because they only test one code path (can the network stack send a small response?). More sophisticated approaches include:

**Application-level health checks**: Instead of a simple "are you alive?" ping, the health check exercises the actual application:

```python
# Bad: basic health check
@app.route("/health")
def health():
    return "OK", 200

# Better: checks that the application can actually do work
@app.route("/health")
def health():
    try:
        # Can we read from the database?
        db.execute("SELECT 1")
        # Can we write to disk?
        tmp = tempfile.NamedTemporaryFile(dir="/data", delete=True)
        tmp.write(b"health check")
        tmp.close()
        # Can we reach our dependency?
        resp = requests.get("http://auth-service/health", timeout=2)
        resp.raise_for_status()
        return "OK", 200
    except Exception as e:
        return f"UNHEALTHY: {e}", 503
```

**Differential observation**: Rather than trusting a single observer, compare multiple observers' views of the same node. If Node A thinks Node B is healthy but Node C thinks Node B is dead, that's a signal worth investigating. This is the approach used by Microsoft's Falcon gray failure detector.

**End-to-end checks**: Rather than checking individual components, send synthetic transactions through the entire pipeline and verify the result. If the synthetic transaction succeeds end-to-end, the system is working regardless of what individual health checks say.

---

## 7.6 Timeout Selection in Practice

Given that no timeout is "correct," how do real systems choose?

### Static Timeouts

The simplest approach: pick a number and hardcode it.

```yaml
# Kubernetes kubelet configuration
nodeStatusUpdateFrequency: 10s   # heartbeat interval
nodeMonitorPeriod: 5s            # how often controller checks
nodeMonitorGracePeriod: 40s      # timeout before marking NotReady
```

Kubernetes uses a 40-second timeout. This means a crashed node takes 40 seconds to detect. For stateless web servers behind a load balancer, this is acceptable — the load balancer's own health checks (typically 10-30 seconds) will stop routing traffic sooner. For stateful workloads (like a database primary), 40 seconds of unavailability is an eternity.

### Why Static Timeouts Are Fragile

A fixed timeout implicitly encodes an assumption about network behavior. If you set a 5-second timeout, you're assuming that a healthy node will always respond within 5 seconds. But network latency is not a fixed value — it's a distribution:

```
Typical datacenter latency distribution:

Percentile │ Latency
───────────┼─────────
    p50     │  0.5 ms
    p90     │  1.2 ms
    p95     │  3.0 ms
    p99     │  12 ms
    p99.9   │  85 ms
    p99.99  │  300 ms

A 5ms timeout would false-positive on 5% of requests.
A 100ms timeout would false-positive on 0.01% of requests.
A 500ms timeout would almost never false-positive,
  but adds 500ms to crash detection time.
```

Worse, this distribution *changes over time*. During normal operation, p99 might be 12ms. During a GC pause, it might be 2000ms. During a network congestion event, it might be 500ms. A static timeout that works today will cause false positives during the next traffic spike.

### Dynamic Timeouts

Instead of a fixed value, compute the timeout from observed behavior.

The basic idea: maintain a running estimate of the expected response time, plus some safety margin.

```python
class DynamicTimeoutDetector:
    def __init__(self, safety_multiplier=4.0):
        self.safety_multiplier = safety_multiplier
        self.samples = []  # recent heartbeat intervals
        self.window_size = 100
    
    def record_heartbeat(self, interval_ms):
        self.samples.append(interval_ms)
        if len(self.samples) > self.window_size:
            self.samples.pop(0)
    
    def current_timeout(self):
        if len(self.samples) < 2:
            return 10000  # default until we have enough data
        
        mean = sum(self.samples) / len(self.samples)
        variance = sum((x - mean) ** 2 for x in self.samples) / len(self.samples)
        std_dev = variance ** 0.5
        
        # Timeout = mean + (safety_multiplier * standard_deviation)
        return mean + (self.safety_multiplier * std_dev)
```

This approach adapts to the actual network conditions:
- When the network is fast, the timeout shrinks → faster failure detection
- When the network is congested, the timeout grows → fewer false positives
- The safety multiplier controls the speed/accuracy trade-off

This is the direction that leads to the Phi Accrual failure detector (Chapter 8), which takes this idea much further with a principled statistical framework.

---

## 7.7 Indirect Failure Detection: Let Others Tell You

Not all failure detection needs to be direct. Sometimes you learn about a node's status from other nodes.

### SWIM: Scalable Weakly-consistent Infection-style Membership

The SWIM protocol (Das, Gupta, Maniatis, 2002) is a membership and failure detection protocol used by systems like HashiCorp's Memberlist (which underlies Consul and Nomad).

The key insight: instead of having every node monitor every other node, use *indirect probes* to improve accuracy.

```
SWIM Protocol - Direct and Indirect Probing:

Step 1: Node A picks a random target, Node D, and sends a direct ping.

  A ──ping──▶ D
  
  If D responds: D is alive. Done.

Step 2: If D doesn't respond within a timeout, A doesn't immediately
  suspect D. Instead, A asks k random nodes to probe D on its behalf.

  A ──"please ping D"──▶ B
  A ──"please ping D"──▶ C
  
  B ──ping──▶ D ──pong──▶ B ──"D is alive"──▶ A
  C ──ping──▶ D ──(no response)──▶ C ──"D didn't respond"──▶ A

Step 3: If none of the indirect probes succeed either, A declares D
  suspect. D is only declared dead after a configurable suspicion timeout.
```

The indirect probe step is crucial: if A can't reach D, but B can reach D, then the problem is the link between A and D, not Node D itself. Without indirect probes, A would falsely declare D dead.

### Suspicion Mechanism

SWIM adds a "suspect" state between "alive" and "dead":

```
State machine for each node's view of another node:

  ┌───────┐     no response to      ┌──────────┐     suspicion     ┌──────┐
  │ ALIVE │ ──direct + indirect──▶   │ SUSPECT  │ ───timeout───▶   │ DEAD │
  │       │     probes               │          │    expires        │      │
  └───────┘                          └──────────┘                   └──────┘
      ▲                                   │
      │          heartbeat or             │
      └──────── alive message ◀───────────┘
                 received
```

A suspected node can "refute" its suspicion by sending an alive message with a higher incarnation number. This handles the case where a node was temporarily slow (GC pause, network congestion) and recovers.

```python
class SWIMDetector:
    ALIVE = "alive"
    SUSPECT = "suspect" 
    DEAD = "dead"
    
    def __init__(self, node_id, all_nodes, k=3, 
                 probe_timeout_ms=500, suspicion_timeout_ms=5000):
        self.node_id = node_id
        self.all_nodes = all_nodes
        self.k = k  # number of indirect probers
        self.probe_timeout = probe_timeout_ms
        self.suspicion_timeout = suspicion_timeout_ms
        self.membership = {n: self.ALIVE for n in all_nodes}
        self.incarnation = {n: 0 for n in all_nodes}
        self.suspect_timers = {}
    
    def probe_round(self):
        """Called every protocol period."""
        target = random.choice([
            n for n in self.all_nodes 
            if n != self.node_id and self.membership[n] != self.DEAD
        ])
        
        # Step 1: Direct probe
        response = send_ping(target, timeout=self.probe_timeout)
        if response:
            self.mark_alive(target, response.incarnation)
            return
        
        # Step 2: Indirect probes
        indirect_probers = random.sample(
            [n for n in self.all_nodes 
             if n != self.node_id and n != target],
            min(self.k, len(self.all_nodes) - 2)
        )
        
        any_success = False
        for prober in indirect_probers:
            result = send_indirect_ping(prober, target, timeout=self.probe_timeout)
            if result and result.target_responded:
                any_success = True
                break
        
        if any_success:
            self.mark_alive(target, self.incarnation[target])
        else:
            self.mark_suspect(target)
    
    def mark_suspect(self, node_id):
        if self.membership[node_id] == self.ALIVE:
            self.membership[node_id] = self.SUSPECT
            self.suspect_timers[node_id] = current_time_ms()
            # Disseminate suspicion via gossip
            gossip_broadcast({"type": "suspect", "node": node_id, 
                            "incarnation": self.incarnation[node_id]})
    
    def check_suspicion_timeouts(self):
        now = current_time_ms()
        for node_id, suspect_time in list(self.suspect_timers.items()):
            if now - suspect_time > self.suspicion_timeout:
                self.membership[node_id] = self.DEAD
                del self.suspect_timers[node_id]
                gossip_broadcast({"type": "dead", "node": node_id})
    
    def mark_alive(self, node_id, incarnation):
        if incarnation >= self.incarnation[node_id]:
            self.incarnation[node_id] = incarnation
            self.membership[node_id] = self.ALIVE
            if node_id in self.suspect_timers:
                del self.suspect_timers[node_id]
```

SWIM achieves:
- **O(n) messages per detection period** (each node probes one random target)
- **Low false positive rate** thanks to indirect probes
- **Bounded detection time** — a crashed node is detected within O(log n) protocol periods with high probability

---

## 7.8 Failure Detection in Real Systems

Let's look at how several production systems implement failure detection.

### etcd / Raft

etcd uses Raft's built-in heartbeat mechanism. The leader sends heartbeats to all followers at a fixed interval.

```
Leader heartbeat in Raft:

  Leader ──AppendEntries(empty)──▶ Follower A
  Leader ──AppendEntries(empty)──▶ Follower B
  Leader ──AppendEntries(empty)──▶ Follower C

  If a follower doesn't hear from the leader within 
  the election timeout, it starts an election.
```

Key configuration:
- `heartbeat-interval`: How often the leader sends heartbeats (default: 100ms)
- `election-timeout`: How long a follower waits before starting an election (default: 1000ms, randomized between 1x and 2x)

The etcd documentation recommends: *"The election timeout should be at least 10 times the round-trip time between members."* If your round-trip time is 10ms, set the election timeout to at least 100ms. This gives the system enough margin to tolerate transient network delays without triggering unnecessary leader elections.

### Redis Sentinel

Redis Sentinel uses a more nuanced failure detection model with two states:

**Subjectively Down (SDOWN)**: A single Sentinel instance thinks a Redis node is down (didn't respond to PING within `down-after-milliseconds`).

**Objectively Down (ODOWN)**: A quorum of Sentinel instances agree that a Redis node is down.

```
Redis Sentinel failure detection:

  Sentinel 1 ──PING──▶ Redis Primary (no response) → SDOWN
  Sentinel 2 ──PING──▶ Redis Primary (no response) → SDOWN
  Sentinel 3 ──PING──▶ Redis Primary (response OK)  → UP

  Sentinel 1 asks Sentinels 2, 3: "Is Primary down?"
    Sentinel 2: "Yes, I think so"
    Sentinel 3: "No, it responded to me"
  
  With quorum=2: 2 out of 3 say SDOWN → ODOWN declared
  Failover begins.
```

The quorum requirement prevents a single Sentinel with a bad network link from triggering unnecessary failovers. But notice: Sentinel 3 could still reach the primary. This could be a case where the primary is alive but partitioned from the majority. Redis Sentinel handles this by configuring the primary to stop accepting writes when it can't reach a minimum number of replicas (`min-replicas-to-write`).

### MongoDB

MongoDB uses a heartbeat protocol between replica set members, with a default heartbeat interval of 2 seconds and a default election timeout of 10 seconds.

MongoDB's failure detection has an interesting wrinkle: each node not only monitors others via heartbeats but also considers its **own** ability to reach a majority when deciding whether to step down as primary:

```python
# Simplified MongoDB primary step-down logic
def should_step_down(self):
    """Primary checks: can I still reach a majority?"""
    reachable = 1  # count myself
    for member in self.replica_set:
        if member.last_heartbeat_response_time < self.election_timeout:
            reachable += 1
    
    if reachable < self.majority_count():
        # I can't reach a majority, so I might be on the 
        # minority side of a partition. Step down to prevent
        # accepting writes that the majority won't see.
        self.step_down()
```

This self-check is important: without it, a primary on the minority side of a partition would keep accepting writes that are invisible to the majority side, which may have already elected a new primary.

### ZooKeeper

ZooKeeper uses a session-based failure detection model. Clients maintain a session with the ZooKeeper ensemble by sending heartbeats. If the client's session times out, ZooKeeper treats it as dead and releases all its ephemeral nodes and watches.

The session timeout is negotiated between client and server:
- Client requests a timeout (e.g., 30 seconds)
- Server may adjust it to within its configured min/max session timeout
- The client must send a heartbeat within 1/3 of the session timeout to keep the session alive

```
ZooKeeper session lifecycle:

  Client ──CreateSession(timeout=30s)──▶ ZK
  ZK ──SessionCreated(timeout=30s)──▶ Client
  
  Every 10s (timeout/3):
  Client ──Heartbeat──▶ ZK
  ZK ──Heartbeat──▶ Client
  
  If no heartbeat for 30s:
  ZK: Session expired → delete ephemeral nodes
  
  If ZK leader crashes:
  Client reconnects to another ZK server
  Client ──ReconnectSession(session_id)──▶ New ZK
  If session hasn't timed out: session continues
  If session has timed out: SESSION_EXPIRED error
```

The critical subtlety: when a client is partitioned from ZooKeeper, it doesn't know whether its session has expired until it reconnects. During this partition, ephemeral nodes (used for leader election, distributed locks) may have been deleted, and another client may have acquired the lock. The partitioned client must assume its session is invalid and stop doing protected work immediately.

---

## 7.9 The Impossibility of Reliable Failure Detection

We've been discussing practical techniques, but there's a fundamental theoretical result that constrains all of them.

In a purely **asynchronous** system model (where messages can be delayed arbitrarily — see Chapter 4), reliable failure detection is impossible. Specifically:

**Theorem**: There is no algorithm that can distinguish a crashed process from a very slow process in an asynchronous system.

**Proof sketch**: Suppose such an algorithm exists. It declares Node B dead after some timeout T. But in an asynchronous system, messages can be delayed by any finite amount. Node B could still be alive, with its heartbeat delayed by T+1 time units. The algorithm was wrong.

You might say: "But in practice, we're not in a purely asynchronous system — networks do deliver messages in bounded time most of the time." You're right, and this is why the **partial synchrony** model (Chapter 4) is important. In partial synchrony, there exists some unknown bound on message delivery time, and after some unknown global stabilization time (GST), the system behaves synchronously. This is close enough to reality that we can build useful failure detectors.

After GST, an Eventually Perfect failure detector (◇P) behaves correctly: it eventually stops suspecting alive nodes and permanently suspects crashed ones. Before GST, all bets are off — the failure detector may make arbitrary mistakes. The engineering challenge is making the system tolerate the mistakes that happen before GST.

---

## 7.10 Failure Detection and Leader Election

Failure detection is not just an academic exercise — it's the foundation of leader election, which in turn is the foundation of consensus. The connection is direct:

1. The current leader crashes
2. The failure detector notices (eventually)
3. Followers start an election to choose a new leader
4. The new leader resumes processing

If the failure detector is too slow (step 2 takes 30 seconds), the system is unavailable for 30 seconds. If the failure detector is too aggressive (step 2 happens while the leader is still alive), you get a spurious election that may cause a brief disruption and, in pathological cases, split brain.

Raft addresses this with **randomized election timeouts**: even if multiple followers detect the leader's failure simultaneously, they wait a random additional time before starting an election, reducing the probability of vote splits.

```
Raft election timeout with randomization:

  base_election_timeout = 1000ms
  
  Follower A: election_timeout = 1000 + random(0, 1000) = 1437ms
  Follower B: election_timeout = 1000 + random(0, 1000) = 1892ms
  Follower C: election_timeout = 1000 + random(0, 1000) = 1203ms

  If leader crashes at T=0:
    T=1203ms: Follower C starts election first (wins likely)
    T=1437ms: Follower A would start, but C already sent vote requests
    T=1892ms: Follower B would start, but C is already leader
```

The randomization doesn't change the failure detection delay — it reduces the probability of contention *after* detection. This is a pragmatic solution to a problem that's hard to solve optimally in theory.

---

## 7.11 Failure Detection Across Datacenters

All the techniques above become much harder when nodes are spread across datacenters or cloud regions.

**Intra-datacenter**: Round-trip time is typically 0.1–2ms. You can use aggressive timeouts (hundreds of milliseconds) with low false positive rates.

**Cross-datacenter (same region)**: Round-trip time is typically 1–10ms. Timeouts of a few seconds work well.

**Cross-region**: Round-trip time can be 30–300ms (US East to US West: ~70ms, US to Europe: ~100ms, US to Asia: ~200ms). Timeouts must be measured in seconds, which means cross-region failure detection is inherently slow.

```
Cross-region latency reality:

  US-East ◄──── 70ms ────► US-West
  US-East ◄──── 100ms ───► EU-West
  US-East ◄──── 200ms ───► Asia-East

  With heartbeat interval = 1s and timeout = 5s:
  - Intra-DC: 5s to detect crash (overkill, ~5000x RTT)
  - Cross-region to Asia: 5s to detect crash (~25x RTT, reasonable)

  The same timeout can't be optimal for both.
```

Production systems handle this by:

1. **Separate failure detection for local and remote nodes**: Use aggressive timeouts for nodes in the same datacenter and conservative timeouts for remote nodes
2. **Regional failure detectors with global aggregation**: Each datacenter detects failures locally, and a higher-level protocol aggregates regional reports
3. **Accepting asymmetric detection times**: It's okay to detect a local failure in 500ms but a remote failure in 10 seconds, because the response to each is different (local failover vs. regional traffic rerouting)

---

## 7.12 Key Takeaways

1. **You cannot distinguish dead from slow.** This is not a bug — it's a fundamental property of distributed systems. Every failure detector is a heuristic that trades off speed against accuracy.

2. **Timeouts are guesses.** A timeout encodes an assumption about network behavior. When the assumption is violated (and it will be), the failure detector makes mistakes.

3. **The theoretical minimum is ◇S (Eventually Strong).** Chandra and Toueg proved this is the weakest failure detector that can solve consensus. It's allowed to make mistakes, as long as it eventually converges to the truth.

4. **Gray failures are harder to detect than total crashes.** A node that's partially broken — responds to heartbeats but can't process requests — is invisible to simple failure detectors. Application-level health checks and differential observation are necessary.

5. **Gossip-based detection scales better than direct heartbeats.** SWIM and similar protocols achieve O(n) message complexity per detection round while maintaining reliable failure detection.

6. **Cross-datacenter detection is inherently slower.** The speed of light imposes a floor on round-trip time, which translates directly into a floor on detection latency.

7. **Failure detection is the foundation of leader election.** Every consensus protocol relies on failure detection to trigger leadership changes. The quality of your failure detector directly determines the availability of your consensus-based system.

---

## References

- Chandra, T. D., & Toueg, S. (1996). "Unreliable Failure Detectors for Reliable Distributed Systems." *Journal of the ACM*, 43(2), 225–267.
- Das, A., Gupta, I., & Motivala, A. (2002). "SWIM: Scalable Weakly-consistent Infection-style Process Group Membership Protocol." *International Conference on Dependable Systems and Networks*.
- Huang, P., Guo, C., Zhou, L., Lorch, J. R., Dang, Y., Chintalapati, M., & Yao, R. (2017). "Gray Failure: The Achilles' Heel of Cloud-Scale Systems." *HotOS*.
- Hayashibara, N., Défago, X., Yared, R., & Katayama, T. (2004). "The φ Accrual Failure Detector." *International Symposium on Reliable Distributed Systems*.
- Fischer, M. J., Lynch, N. A., & Paterson, M. S. (1985). "Impossibility of Distributed Consensus with One Faulty Process." *Journal of the ACM*, 32(2), 374–382.

---

*Next: Chapter 8 explores Phi Accrual Failure Detectors — a mathematically principled approach that replaces the binary alive/dead decision with a continuous suspicion level, and is the failure detection mechanism Cassandra actually uses in production.*
