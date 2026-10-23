# Chapter 3: Failure Taxonomy — Crash-Stop, Crash-Recovery, Omission, Byzantine

## The Question This Chapter Answers

**Are all failures the same, or do different kinds of failure require completely different solutions?**

When a node in your distributed system fails, the natural instinct is to think of it as a binary condition: the node is either "up" or "down." In practice, failures are far more nuanced — and the kind of failure you're designing for determines which algorithms you can use, how many replicas you need, and what guarantees you can offer.

This chapter builds a formal taxonomy of process failures, from the simplest (a process stops and never restarts) to the most adversarial (a process actively lies). Understanding this hierarchy is the first step toward reasoning about which algorithms tolerate which failures — and why Byzantine fault tolerance costs so much more than crash tolerance.

---

## 3.1 Why a Taxonomy Matters

Consider two scenarios:

**Scenario A**: Your database replica crashes during a write. The process stops. It never sends a corrupted acknowledgment. It never pretends the write succeeded when it didn't. It simply vanishes.

**Scenario B**: Your database replica has a memory corruption bug. It acknowledges writes that were never persisted. It returns stale data while claiming it's fresh. It tells the leader it's up to date when it's three transactions behind.

Both are "failures," but they require fundamentally different defenses. An algorithm designed for Scenario A (like Raft) would be completely broken by Scenario B. An algorithm designed for Scenario B (like PBFT) would work for Scenario A but at enormous cost — 3f+1 replicas instead of 2f+1.

The failure taxonomy gives us a shared vocabulary for specifying exactly what an algorithm tolerates. When a paper says "tolerates f crash failures," that sentence has a precise meaning that excludes omission failures, Byzantine failures, and several other categories.

---

## 3.2 The Failure Hierarchy

Failures form a strict hierarchy. Each level includes all the behaviors of the levels above it, plus additional failure modes:

```
                    ┌─────────────────┐
                    │   No Failure     │  Process behaves correctly
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   Crash-Stop     │  Process halts and never recovers
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Crash-Recovery  │  Process halts, may restart with
                    │                  │  partial state
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │    Omission      │  Process drops messages it should
                    │                  │  send or receive
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │    Byzantine     │  Process behaves arbitrarily:
                    │                  │  lies, delays, corrupts, colludes
                    └─────────────────┘

        ▲ Increasing severity
        │ Increasing cost to tolerate
```

Each level strictly contains the one above it. A crash-stop failure is a special case of a crash-recovery failure (one that never recovers). An omission failure is a special case of a Byzantine failure (one that only omits messages rather than fabricating them). This containment property means any algorithm that tolerates Byzantine faults automatically tolerates all lesser failure types — but it pays for that generality.

---

## 3.3 Crash-Stop Failures

### Definition

A **crash-stop** process executes its algorithm correctly until some point in time, at which it permanently halts. After halting, it sends no messages, processes no requests, and never restarts.

### Formal Properties

1. **Correct until failure**: Every message sent before the crash is correct.
2. **Silent failure**: The process stops sending and receiving — it doesn't send garbage.
3. **Permanent**: The process never comes back. Other processes can eventually detect its absence (through timeouts, as we'll see in Chapters 7–8).
4. **No partial messages**: A crash either happens before a message is sent or after. It doesn't corrupt a message mid-transmission (the network layer handles framing).

### Why This Model Is Useful

Crash-stop is the simplest failure model, and many foundational distributed systems algorithms are designed and proven correct under this model first. It's useful because:

- It's the **most common failure mode** in practice. Servers lose power, processes are killed by the OOM killer, VMs get preempted.
- It's **easy to reason about**. You only need to consider two states: the process is either executing correctly or it has stopped forever.
- Algorithms designed for crash-stop are **simpler and cheaper**. You need only 2f+1 replicas to tolerate f crash-stop failures (as we'll prove in Part 3 with Raft).

### Real-World Examples

| Failure | Why It's Crash-Stop |
|---------|-------------------|
| Server power loss | Process stops instantly, never restarts on same hardware |
| `kill -9` on a process | OS terminates process immediately |
| VM preemption (spot instances) | Cloud provider reclaims VM with no restart |
| Hardware failure (dead motherboard) | Machine is permanently gone |

### What Crash-Stop Does NOT Cover

A crash-stop process never:
- Sends a message after crashing
- Sends a corrupted message before crashing
- Appears to restart as a different process
- Pretends to crash (goes silent) while still executing

### Algorithm Example: Simple Majority Voting

Under crash-stop, a simple majority vote works for reaching agreement:

```
Process p wants to decide value v:
  1. Send (PROPOSE, v) to all N processes
  2. Wait for N/2 + 1 responses (majority)
  3. If majority agrees on v, decide v

Why this works with crash-stop:
  - A crashed process sends NO response (not a false one)
  - If f < N/2 processes crash, a majority still responds
  - No process will send a contradictory vote

Why this BREAKS with Byzantine faults:
  - A Byzantine process could send AGREE to p1 and REJECT to p2
  - Two processes might both believe they have a majority — for different values
```

### The Replication Cost

To tolerate **f** crash-stop failures, you need **2f + 1** total processes. This is because:
- f processes might crash (silent)
- You need a majority of the remaining f+1 processes to agree
- 2f + 1 guarantees that any two majorities overlap by at least one process

For example:
- Tolerate 1 failure: 3 replicas (majority = 2)
- Tolerate 2 failures: 5 replicas (majority = 3)
- Tolerate 3 failures: 7 replicas (majority = 4)

---

## 3.4 Crash-Recovery Failures

### Definition

A **crash-recovery** process executes correctly, may crash at any time, and may later **restart** — but upon restarting, it may have lost some or all of its in-memory state. Only data written to **stable storage** (disk) before the crash survives.

### Formal Properties

1. **Correct until failure**: Same as crash-stop — all pre-crash behavior is correct.
2. **Silent during failure**: While crashed, the process sends and receives nothing.
3. **May recover**: Unlike crash-stop, the process can restart.
4. **Amnesia risk**: Upon recovery, the process remembers only what it explicitly persisted to stable storage. Anything in RAM, in-flight messages, or partial computations is lost.

### The Stable Storage Contract

The critical concept in crash-recovery is **stable storage** — storage that survives crashes. In practice:

```
Stable storage (survives crash):
  ├── fsync'd files on local disk
  ├── Write-ahead log (WAL) entries
  ├── Data written to replicated storage
  └── State in battery-backed NVRAM

Volatile storage (lost on crash):
  ├── Process heap memory
  ├── Kernel page cache (unflushed)
  ├── TCP connection state
  ├── In-progress computation results
  └── Pending outbound messages in send buffers
```

### Why Crash-Recovery Is Harder Than Crash-Stop

With crash-stop, a failed process is gone forever. Other processes eventually stop waiting for it and move on. With crash-recovery, a process can come back — and it might come back in a confusing state:

**The Amnesia Problem**:
```
Timeline:
  t=1: Process P receives PREPARE message, votes YES
  t=2: P crashes BEFORE writing vote to disk
  t=3: P restarts
  t=4: P has no memory of voting YES

  If P voted YES and the coordinator committed,
  but P doesn't remember its vote...
  P might vote differently in a new round — violating safety.
```

This is exactly why Two-Phase Commit (Chapter 26) requires participants to write their vote to a **write-ahead log before** responding. The vote must survive a crash.

### Real-World Examples

| Failure | Why It's Crash-Recovery |
|---------|----------------------|
| Process restart after OOM kill | Process comes back but loses all heap state |
| Server reboot after kernel panic | OS restarts, processes restart, in-memory state gone |
| Database restart after crash | WAL entries survive; uncommitted transactions do not |
| Container restart in Kubernetes | New container has fresh memory; volumes may persist |

### The Write-Ahead Log Pattern

Almost every crash-recovery-tolerant system uses the **write-ahead log** (WAL) pattern. The rule is simple: **before performing any action whose effect must survive a crash, write a log record describing that action to stable storage first.**

```python
class CrashRecoveryNode:
    def __init__(self, wal_path):
        self.wal = WriteAheadLog(wal_path)
        self.state = {}  # volatile — lost on crash

    def handle_prepare(self, tx_id, value):
        # FIRST: persist the vote to stable storage
        self.wal.append({
            "type": "VOTE",
            "tx_id": tx_id,
            "vote": "YES",
            "value": value
        })
        self.wal.fsync()  # ensure it hits disk

        # THEN: send the vote
        self.state[tx_id] = "voted_yes"
        send(coordinator, ("VOTE_YES", tx_id))

    def recover(self):
        # On restart, replay the WAL to reconstruct state
        for record in self.wal.read_all():
            if record["type"] == "VOTE":
                self.state[record["tx_id"]] = "voted_yes"
            elif record["type"] == "COMMIT":
                self.apply_commit(record["tx_id"])
        # Now state is consistent with pre-crash state
```

### The Replication Cost

Crash-recovery makes quorum calculations more subtle. In the crash-stop model, a crashed process is permanently gone, so you only need a majority of **surviving** processes. In crash-recovery, a process might crash and rejoin — potentially with stale state.

The key insight: you need quorums that overlap **even accounting for processes that crash and recover with amnesia**. This is why protocols like Raft require processes to persist their `currentTerm` and `votedFor` to stable storage before responding — so that a recovered process cannot violate the one-vote-per-term invariant.

If all processes can crash and recover (no process is permanently dead), you need to ensure that:
- The WAL captures enough state that recovery produces a consistent participant
- A recovering process can distinguish "I never voted" from "I voted but forgot"

In practice, many systems treat crash-recovery as crash-stop with replacement: if a process crashes, a new process with fresh state joins the cluster. This simplifies reasoning but requires a **state transfer** mechanism (snapshotting and log replay in Raft terms).

---

## 3.5 Omission Failures

### Definition

An **omission-faulty** process continues to execute but **fails to send or receive some messages**. Unlike crash failures, the process itself keeps running — it just silently drops messages.

### Two Sub-Types

**Send omission**: The process executes its algorithm and decides to send a message, but the message never actually leaves the process. Other processes never receive it.

**Receive omission**: A message arrives at the process's network interface, but the process never processes it. The message is silently dropped.

```
Send Omission:
  Process P                    Process Q
     │                            │
     ├── Computes response        │
     ├── Calls send(Q, msg)       │
     ├── Message never leaves P   │
     │                            │
     │    (Q never receives msg)  │

Receive Omission:
  Process P                    Process Q
     │                            │
     ├── Sends msg to Q ─────────►│
     │                            ├── msg arrives at Q's NIC
     │                            ├── Q's process never reads it
     │                            │   (dropped in kernel buffer,
     │                            │    or app never calls recv)
```

### Why Omission Is Strictly Worse Than Crash-Recovery

A crash-recovery failure is a special case of omission failure: a crashed process omits **all** messages (both send and receive) during the crash period. But omission failures are more general — a process can selectively drop messages while continuing to process others.

This selectivity makes omission failures insidious:

```
Scenario: Omission-faulty process P in a 3-node cluster

  Leader → P: "Commit transaction 42"    [P receives this]
  Leader → P: "Commit transaction 43"    [DROPPED — receive omission]
  Leader → P: "Commit transaction 44"    [P receives this]

  P has transactions 42 and 44 but is missing 43.
  P doesn't know it's missing 43.
  P appears healthy to monitoring.
  Data on P is silently inconsistent.
```

### Real-World Causes

| Cause | Omission Type | Mechanism |
|-------|--------------|-----------|
| Full network send buffer | Send omission | OS drops outbound packet when buffer overflows |
| Full receive buffer | Receive omission | Kernel drops inbound packet before app reads it |
| GC pause + TCP timeout | Receive omission | Messages arrive during pause; TCP retransmits time out; sender gives up |
| Flaky NIC | Both | Network card intermittently drops packets |
| iptables misconfiguration | Both | Firewall rules selectively drop certain traffic |
| Overloaded process | Receive omission | Process is too slow to drain its socket buffer |

### The GC Pause: Crash or Omission?

One of the most practically relevant failure modes in JVM-based systems (Cassandra, Kafka, ZooKeeper, Elasticsearch) is the garbage collection pause. During a long GC pause:

1. The process is alive but frozen — it processes nothing
2. Incoming messages pile up in kernel buffers
3. Outgoing messages are not sent
4. If the pause exceeds TCP timeout windows, connections reset
5. If the pause exceeds the heartbeat timeout, the cluster declares the process dead

Is this a crash or an omission? It depends on the duration:

```
Short GC pause (< heartbeat timeout):
  → Receive omission: messages may be dropped from full buffers
  → Process resumes and appears healthy
  → Missed messages are silently lost

Long GC pause (> heartbeat timeout):
  → Looks like a crash-stop to the rest of the cluster
  → Cluster elects new leader, reassigns partitions
  → Process "wakes up" from GC, still thinks it's the leader
  → TWO leaders active simultaneously (split-brain)
```

This is why the "process pause" problem is so dangerous: the paused process doesn't know it was paused. From its perspective, no time passed. It has no way to detect that the cluster moved on without it.

### Detecting Omission Failures

Omission failures are harder to detect than crash failures because the process is still running and still sending *some* messages:

```python
# Naive heartbeat — detects crashes but not omission
def is_alive(node, timeout):
    send_heartbeat_request(node)
    response = wait_for_response(node, timeout)
    return response is not None

# This passes even if node is dropping 90% of real traffic

# Better: application-level sequence numbers
class OmissionDetector:
    def __init__(self):
        self.expected_seq = {}

    def on_message(self, sender, seq_num, payload):
        expected = self.expected_seq.get(sender, 0)
        if seq_num > expected:
            gap = seq_num - expected
            log.warn(f"Omission detected: {gap} messages "
                     f"missing from {sender}")
            # Request retransmission or flag the node
        self.expected_seq[sender] = seq_num + 1
```

### The Replication Cost

Omission faults are harder to tolerate than crash faults because a faulty process can remain part of the quorum while silently corrupting results. In the crash model, a failed process simply doesn't participate. In the omission model, it partially participates — which can violate quorum intersection guarantees.

In general, tolerating f omission faults in an N-process system requires N ≥ 2f + 1 (same as crash-stop for consensus), but the protocols become more complex because you can't simply "wait for a majority" — you need to account for partial participation.

---

## 3.6 Byzantine Failures

### Definition

A **Byzantine-faulty** process can exhibit **arbitrary behavior**. It can:
- Send different values to different processes
- Lie about its state
- Selectively delay messages
- Collude with other Byzantine processes
- Act correctly for months and then suddenly misbehave
- Even behave in ways designed to maximally confuse the correct processes

The name comes from Lamport, Shostak, and Pease's 1982 paper "The Byzantine Generals Problem," which frames the problem as a group of generals who must coordinate an attack but some of whom are traitors.

### Formal Properties

A Byzantine process has **no constraints** on its behavior. This is what makes Byzantine fault tolerance (BFT) the hardest — and most expensive — failure model to handle. Any behavior you can imagine (and many you can't) must be tolerated.

```
What a Byzantine process might do:

  ┌──────────────────────────────────────────────────┐
  │  Correct behavior (mimics non-faulty process)     │  ← Hardest to detect
  │  Crash-stop (halts permanently)                   │
  │  Crash-recovery (halts, restarts, forgets)        │
  │  Send omission (drops outbound messages)          │
  │  Receive omission (drops inbound messages)        │
  │  Send wrong value to all peers                    │
  │  Send different values to different peers          │  ← "Equivocation"
  │  Delay messages strategically                     │
  │  Replay old messages                              │
  │  Forge messages from other processes              │  ← Prevented by crypto
  │  Collude with other Byzantine processes           │
  │  Appear correct until the worst possible moment   │
  └──────────────────────────────────────────────────┘
```

### The Byzantine Generals Problem

The original paper frames this as a military coordination problem:

```
Three generals must agree whether to ATTACK or RETREAT.
One general (the Commander) sends orders. Two are Lieutenants.
One of the three is a traitor.

Scenario 1: Commander is loyal, Lieutenant 2 is a traitor

  Commander (loyal)
    ├── Sends ATTACK to Lieutenant 1
    └── Sends ATTACK to Lieutenant 2 (traitor)

  Lieutenant 2 (traitor) tells Lieutenant 1: "Commander said RETREAT"

  Lieutenant 1 received:
    - ATTACK from Commander
    - "Commander said RETREAT" from Lieutenant 2
  Lieutenant 1 must decide: who is lying?

Scenario 2: Commander is the traitor

  Commander (traitor)
    ├── Sends ATTACK to Lieutenant 1
    └── Sends RETREAT to Lieutenant 2

  Lieutenants exchange messages:
    Lieutenant 1 tells 2: "Commander said ATTACK"
    Lieutenant 2 tells 1: "Commander said RETREAT"

  From Lieutenant 1's perspective:
    Scenario 1 and Scenario 2 look IDENTICAL.
    Lieutenant 1 cannot tell whether the Commander
    or Lieutenant 2 is the traitor.
```

### The 3f + 1 Bound

Lamport, Shostak, and Pease proved that to tolerate **f** Byzantine faults, you need at least **3f + 1** total processes. This is a fundamental lower bound — no algorithm can do better.

**Why 3f + 1?**

The intuition: with f Byzantine processes, you need the remaining 2f + 1 correct processes to form a majority — even in the worst case where the f Byzantine processes send conflicting information to different correct processes.

| Faults to Tolerate | Crash-Stop (2f+1) | Byzantine (3f+1) |
|--------------------|-------------------|-------------------|
| 1 | 3 replicas | 4 replicas |
| 2 | 5 replicas | 7 replicas |
| 3 | 7 replicas | 10 replicas |
| 10 | 21 replicas | 31 replicas |

This is why Byzantine fault tolerance is expensive: tolerating 1 Byzantine fault requires 4 replicas, while tolerating 1 crash fault requires only 3.

### Equivocation: The Uniquely Byzantine Problem

The defining behavior that separates Byzantine faults from all lesser fault types is **equivocation** — sending different values to different recipients:

```
Correct process:
  "The value is 42" → Process A
  "The value is 42" → Process B
  "The value is 42" → Process C
  (Sends the same value to everyone)

Omission-faulty process:
  "The value is 42" → Process A
  (nothing)         → Process B    (dropped)
  "The value is 42" → Process C
  (Sends correct values or nothing)

Byzantine process:
  "The value is 42" → Process A
  "The value is 99" → Process B
  "The value is 0"  → Process C
  (Sends different values to different recipients)
```

Equivocation is what makes Byzantine faults so destructive. With crash or omission faults, you can be sure that any message you *do* receive is correct. With Byzantine faults, you can't trust any individual message.

### Preventing Equivocation with Cryptography

Digital signatures can prevent a key Byzantine behavior — forgery. If all messages are signed:

```
Process P signs message m with its private key:
  signed_msg = (m, Sign(P_private_key, m))

Any process can verify the signature:
  Verify(P_public_key, m, signature) → true/false

A Byzantine process CANNOT:
  ✗ Forge a message that appears to come from honest Process Q
  ✗ Modify a signed message without detection

A Byzantine process CAN still:
  ✓ Refuse to send messages (omission)
  ✓ Send different signed messages to different recipients
  ✓ Delay messages
  ✓ Replay its own old messages
```

With digital signatures, the number of required replicas can sometimes be reduced from 3f+1 to 2f+1 for certain types of agreement — because you can prove to a third party what a Byzantine node actually said. This is the basis for algorithms like PBFT (Chapter 32).

### Real-World Byzantine Failures

Byzantine failures are not just theoretical. In traditional distributed systems (not blockchains), they occur as:

| Cause | Byzantine Behavior | Real Incident |
|-------|-------------------|---------------|
| Memory corruption (bit flip) | Process computes wrong result | Amazon's 2008 S3 outage: bit flip in metadata corrupted placement info |
| Software bug in specific version | One replica returns wrong data | MySQL replication bugs where replica diverges from primary |
| Firmware bug | Disk reports write succeeded but data is corrupted | Silent data corruption on certain SSD models |
| Configuration drift | One node operates under different rules | Replica running old schema returns structurally wrong responses |
| Network equipment bug | Switch corrupts packets (beyond what checksums catch) | Documented cases of Ethernet CRC passing but data corrupted |
| Malicious insider | Operator modifies data on one replica | Any system where operators have direct access |

### When To (and Not To) Use BFT

**Use BFT when:**
- Nodes are controlled by different, mutually distrusting organizations (blockchains)
- The system must tolerate software bugs in the replication layer itself
- Regulatory requirements demand it (some financial systems)
- Data integrity is life-critical (aerospace, medical)

**Don't use BFT when:**
- All nodes are in your datacenter running your code (use crash fault tolerance)
- You can use checksums and authentication to catch the common Byzantine cases
- Performance matters more than tolerating adversarial nodes
- You trust your operators and your hardware

Most production distributed systems (databases, message queues, coordination services) use crash fault-tolerant algorithms (Raft, ZAB, Paxos) and handle the rare Byzantine-like failures (bit flips, bugs) with checksums, testing, and operational procedures rather than full BFT.

---

## 3.7 The Hierarchy in Practice: Choosing Your Failure Model

### The Design Decision

When designing a distributed system, the failure model is one of the first decisions you make. It determines:

1. **How many replicas you need**: 2f+1 for crash faults, 3f+1 for Byzantine
2. **Which algorithms you can use**: Raft (crash), PBFT (Byzantine), etc.
3. **How complex your implementation will be**: BFT protocols have 5-10x more message complexity
4. **What performance you can achieve**: BFT has higher latency and lower throughput

### Mapping Failures to Algorithms

```
┌─────────────────┬─────────────────────────┬──────────────────┐
│  Failure Model   │  Example Algorithms      │  Replicas for f  │
├─────────────────┼─────────────────────────┼──────────────────┤
│  Crash-Stop      │  Raft, ZAB, Viewstamped │  2f + 1          │
│                  │  Replication, Paxos      │                  │
├─────────────────┼─────────────────────────┼──────────────────┤
│  Crash-Recovery  │  Raft (with WAL),        │  2f + 1          │
│                  │  Paxos (with stable      │  (with stable    │
│                  │  storage)                │   storage)       │
├─────────────────┼─────────────────────────┼──────────────────┤
│  Omission        │  Reliable broadcast      │  2f + 1          │
│                  │  protocols               │  (more complex)  │
├─────────────────┼─────────────────────────┼──────────────────┤
│  Byzantine       │  PBFT, HotStuff,         │  3f + 1          │
│                  │  Tendermint              │                  │
└─────────────────┴─────────────────────────┴──────────────────┘
```

### What Production Systems Actually Do

In practice, most production systems use a layered approach:

```
Layer 1: Crash fault tolerance (Raft/Paxos)
  - Handles the 99.9% case: servers crashing, networks partitioning
  - 3 or 5 replicas, simple majority quorums

Layer 2: Checksums and authentication
  - Catches most Byzantine-like failures (bit flips, corruption)
  - CRC32 on network packets, SHA-256 on stored data
  - TLS for authentication, preventing impersonation

Layer 3: Application-level validation
  - Schema validation on incoming data
  - Invariant checks on state transitions
  - Read-your-writes verification after replication

Layer 4: Operational safeguards
  - Monitoring and alerting for consistency divergence
  - Automated repair (anti-entropy, read repair)
  - Manual intervention for detected anomalies
```

This layered approach provides practical Byzantine resilience without the cost of full BFT. The reasoning: full BFT handles arbitrary failures including software bugs, but if your BFT implementation itself has a bug, it's just as broken. Better to use simpler crash-tolerant algorithms and invest the complexity budget in testing and monitoring.

---

## 3.8 Link Failures vs. Process Failures

So far we've discussed process failures — a node misbehaving. But communication links can also fail, and their failure model matters too.

### Link Failure Types

**Fair-loss link**: Messages may be lost, duplicated, or reordered, but if you keep retransmitting, the message eventually gets through. TCP over the internet approximates this.

**Stubborn link**: A link that retransmits messages forever until they're delivered. Built on top of fair-loss links by adding a retransmission layer.

**Perfect link** (reliable link): Messages are delivered exactly once, in order, with no corruption. Built on top of stubborn links by adding deduplication and ordering. TCP approximates this (though it's not perfect — connections can reset).

```
Building reliable links from unreliable ones:

  Fair-Loss Link
    + Retransmission → Stubborn Link
      + Deduplication → Perfect Link

  In practice:
    UDP ≈ Fair-Loss Link
    TCP ≈ Perfect Link (with caveats)
```

### Network Partitions: A Link Failure

A **network partition** occurs when the link between two groups of processes fails, but processes within each group can still communicate:

```
Before partition:
  A ←→ B ←→ C ←→ D ←→ E
  (all nodes can reach all other nodes)

After partition:
  A ←→ B ←→ C    D ←→ E
  (Group 1)       (Group 2)

  C cannot reach D.
  A cannot reach E.
  But A can still reach B and C.
  And D can still reach E.
```

Network partitions are the "P" in the CAP theorem (Chapter 20). They're unavoidable in any real distributed system — network equipment fails, cables are cut, switches misconfigure.

The critical question: when a partition occurs, should the system:
- **Stop serving** requests that require cross-partition coordination (choose Consistency)?
- **Continue serving** with the risk of inconsistency (choose Availability)?

This is the fundamental CAP trade-off, which we'll formalize in Chapter 20.

### Asymmetric Partitions

Partitions are not always symmetric:

```
Symmetric partition:
  A cannot reach B AND B cannot reach A

Asymmetric partition:
  A can send to B, but B's responses never reach A

  This happens with:
  - Unidirectional link failures
  - Firewall rules that block one direction
  - NAT traversal issues
```

Asymmetric partitions are particularly nasty because process A thinks it's communicating with B (it's sending messages that B receives), but A never gets B's responses. From A's perspective, B appears crashed. From B's perspective, A is sending messages but ignoring responses.

---

## 3.9 Composed Failures: The Real World

Real systems don't experience failures in isolation. A production incident typically involves multiple failure types interacting:

### Example: The Cascading Failure

```
Timeline of a real-world failure cascade:

t=0:   Network switch partially fails
       → Asymmetric partition: Node C can receive but not send
       (Link failure)

t=1:   Node C misses heartbeats because its responses are dropped
       → Cluster thinks C has crash-stopped
       (Misclassified as crash-stop)

t=2:   Cluster elects new leader (Node A), begins serving writes
       → But C is still alive and still thinks it's the leader
       (Actually: omission failure, not crash)

t=5:   C's network recovers
       → C tries to commit writes it accepted while "partitioned"
       → C and A have divergent state
       (Byzantine-like behavior from the application's perspective)

t=6:   C's writes conflict with A's writes
       → Data inconsistency detected by read repair
       → Manual intervention required
```

No single failure model captures this scenario. The initial problem is a link failure. It's perceived as a crash. It's actually an omission. And the consequence looks Byzantine (two nodes with conflicting committed state).

### Defense in Depth

Good distributed system design accounts for composed failures through defense in depth:

```python
class RobustReplicationProtocol:
    def __init__(self):
        self.wal = WriteAheadLog()         # Survive crash-recovery
        self.heartbeat = PhiAccrualDetector() # Detect crashes/omissions
        self.checksums = {}                  # Detect corruption (Byzantine-like)
        self.fencing_token = 0               # Prevent stale leaders

    def handle_write(self, key, value, client_fencing_token):
        # Defense 1: Fencing (prevents split-brain from omission/partition)
        if client_fencing_token < self.fencing_token:
            raise StaleLeaderError("Your fencing token is outdated")

        # Defense 2: WAL (survives crash-recovery)
        self.wal.append({"key": key, "value": value})
        self.wal.fsync()

        # Defense 3: Checksum (detects corruption)
        checksum = sha256(value)
        self.checksums[key] = checksum

        # Defense 4: Quorum write (tolerates crash-stop)
        acks = self.replicate_to_quorum(key, value, checksum)

        # Defense 5: Verify quorum responses (detects omission)
        for ack in acks:
            if ack.checksum != checksum:
                raise ConsistencyError(
                    f"Replica {ack.node} stored different data"
                )
```

---

## 3.10 Failure Detectors: Bridging Theory and Practice

The failure model you *assume* determines which algorithms you can use. But in practice, you can't always know which failure model you're actually in. This is where **failure detectors** come in (covered in depth in Chapters 7–8).

A failure detector is an oracle that tells each process which other processes have failed. The key insight from Chandra and Toueg (1996) is that failure detectors can be characterized by two properties:

1. **Completeness**: Every actually-failed process is eventually suspected by every correct process.
2. **Accuracy**: Correct processes are not suspected (or not suspected forever).

Different failure detector strengths enable different algorithms:

```
┌────────────────────┬──────────────┬─────────────────────┐
│ Failure Detector    │ Completeness │ Accuracy            │
├────────────────────┼──────────────┼─────────────────────┤
│ Perfect (P)         │ Strong       │ Strong              │
│ Eventually Perfect  │ Strong       │ Eventually Strong   │
│ (◇P)               │              │                     │
│ Strong (S)          │ Strong       │ Weak                │
│ Eventually Strong   │ Strong       │ Eventually Weak     │
│ (◇S)               │              │                     │
└────────────────────┴──────────────┴─────────────────────┘

  - Perfect: never makes a mistake (only possible in synchronous systems)
  - Eventually Perfect: may make mistakes but eventually stops
    (possible in partially synchronous systems — the practical model)
  - Eventually Strong: sufficient to solve consensus!
    (This is the result from Chandra-Toueg 1996)
```

We'll return to failure detectors in detail in Chapters 7–8, where we'll see how Cassandra's Phi Accrual Failure Detector works and why it's better than a fixed timeout.

---

## 3.11 Key Takeaways

1. **Failures form a strict hierarchy**: crash-stop ⊂ crash-recovery ⊂ omission ⊂ Byzantine. Each level includes all behaviors of the level above it.

2. **The failure model determines the algorithm**: Raft handles crash failures. PBFT handles Byzantine failures. You can't use a crash-tolerant algorithm and hope it handles Byzantine faults.

3. **Replication costs differ dramatically**: 2f+1 for crash faults, 3f+1 for Byzantine. This makes BFT impractical for most non-blockchain systems.

4. **Crash-recovery requires stable storage**: Any state that must survive a crash must be written to disk (and fsync'd!) before the process acts on it. This is the foundation of the Write-Ahead Log.

5. **Omission failures are the hidden danger**: A process that drops messages but stays alive can corrupt quorum-based protocols. GC pauses are the most common real-world cause.

6. **Equivocation is uniquely Byzantine**: Only a Byzantine process can send different values to different recipients. Cryptographic signatures can limit (but not eliminate) this behavior.

7. **Production systems use a layered defense**: Crash-tolerant algorithms at the core, checksums for corruption, fencing for stale leaders, monitoring for everything else.

8. **Real failures are composed**: A production incident usually involves multiple failure types interacting in ways that no single failure model captures.

---

## 3.12 Further Reading

- **Lamport, Shostak, Pease (1982)**: "The Byzantine Generals Problem" — the foundational paper that defined Byzantine faults and proved the 3f+1 lower bound.
- **Chandra, Toueg (1996)**: "Unreliable Failure Detectors for Reliable Distributed Systems" — proved that an eventually strong failure detector is sufficient to solve consensus.
- **Cristian (1991)**: "Understanding Fault-Tolerant Distributed Systems" — one of the earliest formal failure taxonomies.
- **Cachin, Guerraoui, Rodrigues (2011)**: *Introduction to Reliable and Secure Distributed Programming* — the textbook treatment of failure models and their relationship to algorithms.
- **Kleppmann (2017)**: *Designing Data-Intensive Applications*, Chapter 8 — accessible treatment of the "unreliable clocks and process pauses" problem from a practitioner's perspective.

---

*Next: Chapter 4 takes the failure models from this chapter and combines them with timing assumptions to define system models — the complete formal framework that every distributed algorithm is designed and proven within.*
