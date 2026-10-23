# Chapter 4: System Models — Synchrony, Asynchrony, and Partial Synchrony

## The Question This Chapter Answers

**What timing assumptions can a distributed algorithm safely make?**

Chapter 3 defined *what* can go wrong (failure types). This chapter defines *when* things happen — or more precisely, what a distributed algorithm can assume about message delivery times and processing speeds. The answer determines whether consensus is solvable, whether failure detection is reliable, and whether your timeout-based leader election actually works.

A system model is the complete set of assumptions — failure model plus timing model — under which an algorithm is designed and proven correct. Get the model wrong, and your "proven correct" algorithm breaks in production.

---

## 4.1 The Three Timing Models

Distributed systems theory recognizes three timing models, each making progressively weaker assumptions about how long things take.

```
Strongest assumptions                          Weakest assumptions
(easiest to program)                           (hardest to program)

  ┌───────────┐      ┌──────────────────┐      ┌──────────────┐
  │ Synchronous│      │ Partially        │      │ Asynchronous │
  │            │ ───► │ Synchronous      │ ───► │              │
  │            │      │                  │      │              │
  └───────────┘      └──────────────────┘      └──────────────┘

  Messages arrive     Messages eventually       No bound on
  within known Δ.     arrive within Δ,          delivery time.
  Processing takes    but Δ is unknown          No bound on
  bounded time.       or holds only             processing time.
                      eventually.
```

### Why This Matters Immediately

Here's the practical consequence: if you set a heartbeat timeout of 5 seconds in your distributed database, you're implicitly assuming a partially synchronous model where messages take at most 5 seconds. If the network violates that assumption (say, a 30-second GC pause), your system behaves as if a correct node has crashed — potentially electing two leaders and splitting the brain.

Every timeout in every distributed system is a timing assumption. Understanding the formal models tells you exactly when those assumptions break and what the consequences are.

---

## 4.2 The Synchronous Model

### Definition

In the **synchronous model**, there exist known, fixed upper bounds on:

1. **Message delay**: Every message sent between correct processes is delivered within time **Δ** (delta).
2. **Processing time**: Every computation step at a correct process completes within time **Φ** (phi).
3. **Clock drift**: Local clocks at correct processes differ from real time by at most **ρ** (rho).

All three bounds are **known in advance** and **never violated**.

### What This Buys You

With synchronous assumptions, many hard problems become easy:

**Perfect failure detection**: If a process doesn't respond within Δ + Φ (network round trip plus processing time), it has definitely crashed. There are no false positives.

```
Synchronous failure detection:

  Process A                      Process B
     │                              │
     ├── Send heartbeat ───────────►│
     │   (delivered within Δ)       │
     │                              ├── Process (within Φ)
     │◄── Send response ────────────┤
     │   (delivered within Δ)       │
     │                              │
     │   Total round trip ≤ 2Δ + Φ  │
     │                              │
     │   If no response by 2Δ + Φ:  │
     │   B has DEFINITELY crashed.  │
     │   This is not a guess.       │

  Timeout = 2Δ + Φ is PERFECT.
  No false positives. No ambiguity.
```

**Consensus is trivial**: With perfect failure detection, you can solve consensus with a simple round-based protocol. Each round takes a bounded amount of time. After enough rounds, all correct processes agree.

**Total ordering of events**: With bounded clock drift, you can use timestamps to order events across machines (with careful NTP synchronization).

### Why It's Unrealistic

The synchronous model assumes bounds that real networks don't provide:

| Assumption | Reality |
|-----------|---------|
| Messages arrive within Δ | Network congestion, packet loss, and retransmission can delay messages for seconds or minutes |
| Processing completes within Φ | GC pauses, disk I/O stalls, CPU contention, and context switches cause unbounded delays |
| Clock drift is bounded by ρ | NTP can have multi-second errors; VM migration can cause clock jumps |

A single violation of any bound — one message that takes longer than Δ — breaks every guarantee built on the synchronous assumption. And in production, those violations happen constantly.

### When Synchronous Assumptions Hold (Approximately)

Despite being unrealistic in general, synchronous assumptions hold well enough in specific contexts:

- **Dedicated networks in a single datacenter**: When the only source of delay is a well-provisioned switch fabric, message delays are predictable (microseconds to low milliseconds).
- **Real-time operating systems**: RTOS guarantees bounded processing times for critical tasks.
- **Hardware-level protocols**: Protocols between co-located chips (like RDMA or InfiniBand) have extremely predictable timing.
- **Google Spanner's TrueTime**: Uses GPS receivers and atomic clocks to provide a clock with bounded, known uncertainty. This is the synchronous model applied to clocks specifically (Chapter 27).

---

## 4.3 The Asynchronous Model

### Definition

In the **asynchronous model**, there are **no timing assumptions whatsoever**:

1. **Message delay**: A message between correct processes is eventually delivered, but there is no upper bound on how long delivery takes. It could take 1 millisecond or 1 year.
2. **Processing time**: A computation step eventually completes, but there is no upper bound. A process could pause for an arbitrary amount of time (GC, page fault, CPU scheduling) and then resume.
3. **Clock**: Processes may not have clocks at all, or their clocks may run at arbitrary and varying rates.

The only guarantee: if a process is correct (non-faulty), it will eventually process each message and take each step. "Eventually" has no bound.

### What This Costs You

The asynchronous model is devastating for distributed system design:

**Failure detection is impossible**: You cannot distinguish a crashed process from a very slow one. If process B hasn't responded to your heartbeat, is it dead or just delayed?

```
Asynchronous failure detection dilemma:

  Process A                          Process B
     │                                  │
     ├── Send heartbeat ───────────────►│
     │                                  │   (B is either crashed
     │        ...no response...         │    or just very slow.
     │                                  │    There is NO timeout
     │        ...still no response...   │    that can distinguish
     │                                  │    these two cases.)
     │        ...how long do I wait?... │
     │                                  │
     │   If I declare B dead after 5s:  │
     │     → B might respond at 5.001s  │
     │     → False positive!            │
     │                                  │
     │   If I wait forever:             │
     │     → I never detect real crashes│
     │     → System is stuck            │
```

**Consensus is impossible** (with even one crash): This is the FLP impossibility result (Chapter 21). In a purely asynchronous system, no deterministic algorithm can guarantee that all correct processes reach agreement if even one process might crash. The reason: the algorithm can't tell whether the missing process has crashed or is just slow, so it can't safely proceed without it.

**No global ordering by timestamps**: Without reliable clocks, you can't use wall-clock time to order events. Lamport clocks (Chapter 10) provide a partial substitute, but they only capture causal ordering.

### Why Study It?

If the asynchronous model makes everything impossible, why bother? Two reasons:

1. **Lower bounds**: If you can prove something is impossible in the asynchronous model, you know exactly which timing assumptions are needed to make it possible. This is scientifically valuable — it tells you the minimum assumptions your algorithm requires.

2. **Safety in the worst case**: An algorithm that is safe (never produces a wrong result) in the asynchronous model remains safe no matter how badly the network behaves. You can then add timing assumptions for liveness (making progress) without risking safety.

This safety/liveness split is the key insight behind practical algorithms like Raft: **safety holds in the asynchronous model** (Raft never commits conflicting entries, even if the network is arbitrarily slow), but **liveness requires partial synchrony** (a leader must eventually be elected, which requires timeouts that eventually work).

---

## 4.4 The Partially Synchronous Model

### Definition

The **partially synchronous model** sits between synchronous and asynchronous. There are two equivalent formulations, both from Dwork, Lynch, and Stockmeyer (1988):

**Formulation 1 (Unknown bound)**: There exists a bound Δ on message delivery time and a bound Φ on processing time, but their values are **unknown**. The algorithm must work correctly for any values of Δ and Φ.

**Formulation 2 (Eventually synchronous)**: The system is asynchronous, but there exists some unknown **Global Stabilization Time (GST)** after which the system becomes synchronous. Before GST, messages can be delayed arbitrarily. After GST, messages arrive within a bound Δ.

```
Formulation 2 visualized:

  Time ──────────────────────────────────────────────►

  │←── Asynchronous period ──►│←── Synchronous ──────►
  │   Messages may be delayed │   Messages arrive
  │   for arbitrary time.     │   within bound Δ.
  │   No guarantees.          │   Timeouts work.
  │                           │
  │                          GST
  │                    (unknown to the
  │                     algorithm)
```

### Why Partial Synchrony Is the Sweet Spot

Partial synchrony captures the behavior of real networks:

- **Most of the time**, messages arrive quickly (within milliseconds in a datacenter, within hundreds of milliseconds on the internet).
- **Sometimes**, messages are delayed for unpredictable durations (network congestion, GC pauses, VM migration, transient failures).
- **Eventually**, the disruption ends and the system returns to normal timing.

The critical insight: an algorithm designed for partial synchrony can be **safe always** (even during asynchronous periods) and **live eventually** (once the system stabilizes). This is the design pattern used by every practical consensus algorithm.

### How Raft Uses Partial Synchrony

Raft (Chapter 22) is the canonical example of partial synchrony in practice:

```
Raft's timing assumptions:

  Safety (always holds, even in asynchronous periods):
    - At most one leader per term
    - Committed entries are never lost
    - The state machine order is consistent

    These properties hold REGARDLESS of timing.
    Even if all messages are delayed for hours,
    Raft never commits conflicting entries.

  Liveness (requires partial synchrony):
    - A leader must be elected eventually
    - Clients must get responses eventually

    These require:
    broadcastTime << electionTimeout << MTBF

    Where:
      broadcastTime = time to send RPCs to all servers
      electionTimeout = timeout before starting election
      MTBF = mean time between failures

    If the network is so slow that
    broadcastTime ≥ electionTimeout,
    elections keep failing and the system makes
    no progress (but remains safe!).
```

Here's what this looks like in practice:

```
Normal operation (system is synchronous):
  t=0:   Leader sends heartbeats
  t=5ms: Followers receive heartbeats (within Δ)
  t=10ms: Followers respond
  → Everything works. Timeouts don't fire.

Network instability (asynchronous period):
  t=0:     Leader sends heartbeats
  t=500ms: STILL no response (messages delayed)
  t=1s:    Followers start election (timeout)
  t=1.2s:  Messages from old leader arrive (late)
  t=1.5s:  New election starts
  t=2s:    More messages arrive late
  → Multiple elections fail. No progress. BUT NO SAFETY VIOLATION.

  Raft's safety invariants hold throughout:
  - No two leaders in the same term
  - No committed entry is lost

Network stabilizes (after GST):
  t=3s:    Messages start arriving on time again
  t=3.5s:  Election succeeds (majority of votes received)
  t=4s:    New leader starts accepting writes
  → System resumes normal operation
```

### The Election Timeout: A Partial Synchrony Contract

Every time you configure a heartbeat interval and election timeout in a distributed system, you're making a partial synchrony argument:

```python
# Raft configuration (typical)
HEARTBEAT_INTERVAL = 150   # ms — leader sends heartbeats this often
ELECTION_TIMEOUT_MIN = 300 # ms — follower starts election after this long
ELECTION_TIMEOUT_MAX = 500 # ms — randomized to prevent split votes

# The implicit timing contract:
#
# "I believe that, most of the time, a heartbeat sent by the leader
#  will arrive at followers within 150ms. If it doesn't, the follower
#  will start a new election. If the network is consistently slower
#  than 300ms, the system will livelock on elections but never
#  violate safety."
#
# This is partial synchrony:
#   - Safety holds even if messages take 10 minutes
#   - Liveness requires messages to arrive within ~300ms
```

### Choosing Timeouts Under Partial Synchrony

A common engineering question: how do I set my timeouts? The answer comes from the partial synchrony model:

```
Goal: liveness when the system is synchronous,
      safety when it isn't.

Step 1: Measure your network's actual latency distribution
  p50 = 1ms, p99 = 10ms, p99.9 = 50ms, p99.99 = 200ms

Step 2: Set timeout above the tail latency
  Timeout = 500ms (2.5x the p99.99)

  This means:
  - 99.99% of the time, the timeout doesn't fire (good)
  - 0.01% of the time, a healthy node might be suspected (false positive)
  - A truly crashed node is detected within 500ms (good enough)

Step 3: Accept that false positives will happen
  When the system enters an asynchronous period
  (network congestion, GC pause), timeouts will fire incorrectly.
  The algorithm must remain SAFE in this case.

Step 4: Tune based on production data
  If you see too many false positive leader elections → increase timeout
  If crash detection is too slow → decrease timeout
  There is no perfect value — this is the partial synchrony trade-off
```

---

## 4.5 Comparing the Three Models

### Side-by-Side

| Property | Synchronous | Partially Synchronous | Asynchronous |
|----------|-------------|----------------------|--------------|
| Message delay bound | Known Δ | Exists but unknown (or holds only after GST) | No bound |
| Processing time bound | Known Φ | Exists but unknown (or holds only after GST) | No bound |
| Failure detection | Perfect (no false positives) | Eventually perfect (false positives possible) | Impossible |
| Consensus | Easy (round-based) | Possible (FLP circumvented via eventual synchrony) | Impossible (FLP) |
| Safety | Can depend on timing | Must NOT depend on timing | Must NOT depend on timing |
| Liveness | Guaranteed | Guaranteed after GST | Cannot guarantee |
| Real-world match | Dedicated real-time networks | Internet, datacenter networks | Theoretical worst case |

### The Key Insight

The partially synchronous model gives you the best of both worlds by splitting guarantees into two categories:

- **Safety** (never do the wrong thing): Must hold under asynchronous conditions. No timing assumptions.
- **Liveness** (eventually do the right thing): May assume partial synchrony. Can use timeouts.

This split appears everywhere in distributed systems:

```
System          Safety (always)              Liveness (needs timing)
─────────────────────────────────────────────────────────────────
Raft            One leader per term,         Leader eventually elected,
                committed entries durable     clients get responses

Paxos           At most one value chosen     A value is eventually chosen
                per instance

2PC             If commit, all commit;       Coordinator eventually
                if abort, none commit        recovers (or use timeout)

ZooKeeper       Linearizable reads/writes    Session eventually
                                             detected as dead

Kafka           Messages in partition        Consumer eventually
                order preserved              assigned partitions
```

---

## 4.6 System Models: Combining Timing and Failure Assumptions

A **system model** is the complete specification of both timing and failure assumptions. Every distributed algorithm is designed and proven correct within a specific system model.

### Common System Models in Practice

**Crash-stop + Asynchronous**:
- The most restrictive practical model
- Used to prove safety properties
- FLP impossibility applies here
- Example: proving Raft's safety (but not its liveness)

**Crash-stop + Partially Synchronous**:
- The standard model for practical consensus algorithms
- Used by: Raft, Paxos, ZAB, Viewstamped Replication
- Safety holds always; liveness after GST
- Requires 2f + 1 processes for f faults

**Crash-recovery + Partially Synchronous**:
- Same as above but processes can restart
- Requires stable storage (WAL)
- Used by: Raft in practice (all implementations use WAL)
- Same 2f + 1 requirement, with the constraint that recovered processes must restore their pre-crash state from stable storage

**Byzantine + Partially Synchronous**:
- The model for BFT protocols
- Used by: PBFT, HotStuff, Tendermint
- Requires 3f + 1 processes for f faults
- Safety holds always; liveness after GST and with < f+1 Byzantine faults

**Byzantine + Synchronous**:
- Enables simpler BFT protocols (like the original BGP solution)
- Requires only 3f + 1 (same as partial synchrony for Byzantine)
- Stronger liveness: guaranteed as long as timing assumptions hold
- Impractical for Internet-scale systems

### Specifying Your System Model

When you design a distributed algorithm, you should explicitly state your system model. Here's what a complete specification looks like:

```
System Model for "MyConsensusProtocol":

  Timing:
    Partially synchronous.
    There exists an unknown Global Stabilization Time (GST)
    after which all messages between correct processes are
    delivered within bound Δ.

  Failures:
    Crash-recovery with stable storage.
    At most f out of N = 2f + 1 processes may crash.
    A crashed process may recover with its stable storage intact
    but volatile memory lost.

  Network:
    Reliable point-to-point channels.
    Messages may be reordered but not duplicated or corrupted.
    (In practice: TCP connections between all pairs of processes.)

  Cryptography:
    Not required (no Byzantine processes).
    Message authentication via TCP (no spoofing within datacenter).

  Safety guarantee:
    Holds in all executions (even fully asynchronous).
    At most one value is decided per instance.

  Liveness guarantee:
    Holds in all executions after GST where fewer than f+1
    processes are simultaneously crashed.
    A value is eventually decided.
```

---

## 4.7 Why Getting the Model Wrong Breaks Your System

### Case Study: The Split-Brain Database

A common failure occurs when a system is designed for the synchronous model but deployed in a partially synchronous environment:

```
Design assumption: "Messages arrive within 5ms in our datacenter"

Reality:
  t=0:     Primary sends heartbeat to replica
  t=0-50ms: JVM Full GC pause on replica
  t=50ms:  Heartbeat arrives at replica, but replica is frozen
  t=100ms: GC finishes, replica processes heartbeat (100ms late)
  t=100ms: Meanwhile, primary's 10ms timeout already fired
  t=100ms: Primary declared replica dead
  t=100ms: New primary elected
  t=101ms: Old replica wakes up, still thinks it's the primary

  RESULT: Two primaries. Split brain. Data loss.
```

The fix isn't a longer timeout (that just makes the window less likely, not impossible). The fix is to design the algorithm so safety holds even when the timing assumption is violated:

```
Correct design (partial synchrony):

  - Use fencing tokens: new primary gets token T+1
  - Storage layer rejects writes with token ≤ T
  - Even if old primary "wakes up" and tries to write,
    its writes are rejected because its token is stale

  Safety holds regardless of timing:
    The fencing token mechanism doesn't depend on timeouts.
    It works even if the old primary wakes up 10 days later.

  Liveness depends on timing:
    If timeouts are too short → too many false elections → low throughput
    If timeouts are too long → slow failure detection → high latency
    But safety is never compromised.
```

### Case Study: The Redlock Debate

Martin Kleppmann's critique of the Redlock distributed lock (2016) is fundamentally about system model mismatch.

Redlock's implicit assumption: the system is approximately synchronous. Specifically, that process pauses and clock drift are small relative to the lock's TTL (time to live).

Kleppmann's attack:

```
Process A acquires lock with TTL = 10 seconds
Process A begins work
Process A enters long GC pause (15 seconds)
Lock expires (TTL elapsed)
Process B acquires the lock
Process B begins work
Process A wakes up from GC, thinks it still holds the lock
Process A and B both do the "protected" work simultaneously

The lock is violated — not because of a bug in Redlock,
but because the system model (approximate synchrony)
was violated (GC pause > TTL).
```

The solution (fencing tokens, as Kleppmann proposes) works in the partially synchronous model because it doesn't depend on timing for safety.

---

## 4.8 Logical Time: Working Without Clocks

In the asynchronous model, you have no clocks. In the partially synchronous model, you can't trust clocks during asynchronous periods. How do you reason about "before" and "after" without clocks?

The answer is **logical time** — a way to order events based on causality rather than wall-clock time. We'll cover this in full detail in Chapters 10 (Lamport clocks) and 11 (vector clocks), but here's the preview:

### The Happens-Before Relation

Lamport (1978) defined the **happens-before** relation (→) without any reference to physical time:

```
Event a happens-before event b (written a → b) if:

  1. a and b are events at the same process, and a comes before b
     in that process's execution order
     (local ordering)

  2. a is the sending of a message and b is the receipt of that
     same message
     (message causality)

  3. There exists an event c such that a → c and c → b
     (transitivity)

If neither a → b nor b → a, then a and b are CONCURRENT.
```

This relation is defined purely by message patterns — no clocks needed:

```
Process P1        Process P2        Process P3
   │                 │                 │
   a                 │                 │
   │                 │                 │
   ├── msg ─────────►b                 │
   │                 │                 │
   c                 ├── msg ─────────►d
   │                 │                 │
   │                 e                 │

  Ordering we can establish:
    a → b (message)
    b → d (message)
    a → d (transitivity: a → b → d)

  Events that are CONCURRENT:
    c ∥ d  (no causal path between them)
    c ∥ b  (c happened at P1 after a, but no message path to b)
    a ∥ e  (no causal path)

  Note: we said NOTHING about wall-clock time.
  a might have happened at 3:00pm and d at 2:59pm (wall clock).
  But causally, a happened before d.
```

Logical time is the foundation for reasoning about distributed systems in the asynchronous and partially synchronous models. It will be a central topic in Part 2.

---

## 4.9 Relating Models to Real Infrastructure

### Datacenter Networks

Modern datacenter networks (leaf-spine topology with redundant paths) are approximately partially synchronous with very short asynchronous periods:

```
Typical datacenter network characteristics:
  Intra-rack latency:     ~0.1ms (nearly synchronous)
  Intra-datacenter:       ~0.5ms (nearly synchronous)
  Cross-datacenter (same region): ~1-5ms
  Cross-region:           ~50-200ms

  Asynchronous events:
  - Network congestion:    adds 1-100ms (brief)
  - Switch failure/failover: 10-500ms (infrequent)
  - GC pause (JVM):        50ms - 10s (application-dependent)
  - Disk I/O stall:        100ms - 30s (rare with SSDs)
  - VM live migration:     100ms - 5s
```

For intra-datacenter systems, the partially synchronous model is a good fit. The system is synchronous most of the time, with brief asynchronous periods during failures and maintenance.

### The Internet

The Internet is strongly partially synchronous — it's synchronous most of the time but has more frequent and longer asynchronous periods:

```
Typical Internet characteristics:
  P50 latency:   50-100ms
  P99 latency:   200-500ms
  P99.9 latency: 1-5 seconds
  Packet loss:   0.1-1%

  Asynchronous events:
  - BGP convergence:      30s - 5 minutes
  - Submarine cable cut:  hours (failover: minutes)
  - DNS propagation:      seconds to hours
  - CDN cache miss:       variable
```

Cross-region systems (like global databases) must be designed for longer and more frequent asynchronous periods.

### Embedded and Real-Time Systems

Hard real-time systems (automotive, aerospace, industrial control) come closest to the synchronous model:

```
Real-time system characteristics:
  Message delivery:  Guaranteed within Δ (by hardware/protocol)
  Processing time:   Bounded by RTOS scheduling guarantees
  Clock accuracy:    Hardware clock, minimal drift

  Examples:
  - CAN bus (automotive):  Δ = microseconds, deterministic
  - ARINC 429 (avionics):  Δ = microseconds, deterministic
  - Time-Sensitive Networking (TSN): Δ = microseconds
```

These systems can use algorithms designed for the synchronous model — but at the cost of specialized hardware and software that most web-scale systems don't use.

---

## 4.10 The FLP Impossibility: A Preview

The most important result in distributed computing — the FLP impossibility theorem (Fischer, Lynch, and Paterson, 1985) — lives at the intersection of the asynchronous model and crash faults:

> **No deterministic algorithm can solve consensus in the asynchronous model if even one process can crash.**

We'll prove this in Chapter 21. For now, here's the intuition:

In the asynchronous model, you can't tell a crashed process from a slow one. So any consensus algorithm faces a dilemma:

```
Dilemma for consensus in the asynchronous model:

  Option A: Wait for ALL processes to respond
    Pro: If all respond, you know the answer
    Con: If one has crashed, you wait forever
    → Not live (may never terminate)

  Option B: Proceed after hearing from a majority
    Pro: Makes progress even if one crashes
    Con: The "crashed" process might just be slow
         It might wake up and disagree
    → To prevent disagreement, the majority must
      be large enough... but how large?
      There's always a timing-dependent edge case.

  FLP proves: no matter how clever your protocol,
  there's always an execution (a specific timing of
  messages and failures) that prevents agreement.
```

The practical escape hatches from FLP:

1. **Partial synchrony**: Assume the system eventually becomes synchronous (Raft, Paxos)
2. **Randomization**: Use coin flips to break symmetry (Ben-Or, 1983)
3. **Failure detectors**: Assume an eventually reliable failure detector (Chandra-Toueg, 1996)

All three approaches are mathematically equivalent — they all circumvent FLP by adding some timing or randomness assumption that the pure asynchronous model lacks.

---

## 4.11 Practical Guidelines for Engineers

### Choosing Your System Model

```
Decision tree:

  Q: Are all nodes in the same datacenter?
  ├── Yes: Partially synchronous, crash-recovery
  │        (Raft, etcd, ZooKeeper)
  │
  └── No: Are nodes on the Internet?
      ├── Yes: Are node operators mutually trusting?
      │   ├── Yes: Partially synchronous, crash-recovery
      │   │        (with longer timeouts)
      │   │
      │   └── No: Partially synchronous, Byzantine
      │            (PBFT, blockchain consensus)
      │
      └── No (dedicated WAN): Partially synchronous, crash-recovery
                               (Spanner, CockroachDB)
```

### Timeout Guidelines

```
Environment          Heartbeat    Election Timeout    Failure Detection
─────────────────────────────────────────────────────────────────────
Same rack            50ms         150-300ms           <1 second
Same datacenter      100ms        300-500ms           1-2 seconds
Cross-datacenter     500ms        1-3 seconds         5-10 seconds
Cross-region         1-5s         5-15 seconds        15-30 seconds
Internet (clients)   5-30s        N/A                 30-120 seconds
```

These are starting points. Always measure your actual latency distribution and adjust.

### The Cardinal Rule

> **Never let safety depend on timing. Only let liveness depend on timing.**

This means:
- Your data structure invariants hold even if a message takes 10 minutes
- Your fencing/sequencing mechanism works even after arbitrary pauses
- Your conflict resolution is correct even with clock skew
- But your system may stop making progress during network instability (that's OK)

### When You Violate the Model

Every production system occasionally violates its timing model. Know what happens when it does:

```python
class PartialSynchronyAwareSystem:
    """
    Safety: invariant holds regardless of timing
    Liveness: requires partial synchrony assumptions
    """

    def handle_timeout(self, node_id):
        # WRONG: assume node is dead
        # self.remove_node(node_id)  # UNSAFE — might just be slow

        # RIGHT: suspect node, use protocol mechanism
        self.suspect_node(node_id)

        # The protocol (e.g. Raft) handles suspected nodes
        # safely: it starts an election but doesn't
        # discard the suspected node's state.

    def handle_late_message(self, message):
        # WRONG: process normally (might be from a deposed leader)
        # self.apply(message)  # UNSAFE

        # RIGHT: check epoch/term/fencing token
        if message.term < self.current_term:
            self.reject(message, "stale term")
        else:
            self.apply(message)
```

---

## 4.12 Key Takeaways

1. **Three timing models**: Synchronous (known bounds), asynchronous (no bounds), partially synchronous (bounds exist but are unknown or hold only eventually). Real systems are partially synchronous.

2. **Partial synchrony splits safety from liveness**: Safety must hold without timing assumptions. Liveness may assume eventual synchrony. This is the design pattern behind Raft, Paxos, and every practical consensus algorithm.

3. **Every timeout is a timing assumption**: When you set `heartbeat_timeout = 5s`, you're betting that the system is synchronous with Δ < 5s. Know what happens when you lose that bet.

4. **FLP impossibility**: No deterministic algorithm solves consensus asynchronously with even one crash fault. Partial synchrony, randomization, or failure detectors are needed to circumvent this — we'll see all three in later chapters.

5. **A system model is timing + failures**: Always specify both. "Crash-recovery + partially synchronous" is the most common model for practical distributed systems.

6. **Real networks match partial synchrony well**: Synchronous most of the time with brief asynchronous periods. Design for the asynchronous case (safety) and optimize for the synchronous case (performance).

7. **Never let safety depend on timing**: The most important engineering principle in distributed systems. Fencing tokens, epoch numbers, and term counters are your tools for timing-independent safety.

---

## 4.13 Further Reading

- **Dwork, Lynch, Stockmeyer (1988)**: "Consensus in the Presence of Partial Synchrony" — the foundational paper that defined the partially synchronous model and showed consensus is solvable in it.
- **Fischer, Lynch, Paterson (1985)**: "Impossibility of Distributed Consensus with One Faulty Process" — the FLP impossibility result, proven in the asynchronous model.
- **Lamport (1978)**: "Time, Clocks, and the Ordering of Events in a Distributed System" — the paper that introduced logical clocks as an alternative to physical time.
- **Kleppmann (2016)**: "How to do distributed locking" — the Redlock critique that illustrates what happens when a system designed for approximate synchrony encounters asynchronous behavior.
- **Aguilera (2010)**: "Stumbling over Consensus Research: Misunderstandings and Issues" — a clear explanation of system models and their relationship to consensus algorithms.
- **Cachin, Guerraoui, Rodrigues (2011)**: *Introduction to Reliable and Secure Distributed Programming* — Chapters 2-3 provide the most rigorous textbook treatment of system models.

---

*Next: Chapter 5 introduces the Two Generals Problem — the simplest formal proof that perfect agreement over an unreliable link is impossible, setting the stage for the impossibility results and consensus algorithms that follow.*
