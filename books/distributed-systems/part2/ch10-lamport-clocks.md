# Chapter 10: Lamport Clocks and the Happens-Before Relation

> **Core question**: If wall clocks are untrustworthy, how do I know which distributed event happened first?

> **Prerequisites**: Chapter 9 (physical clocks and why they can't be trusted)

In 1978, Leslie Lamport published "Time, Clocks, and the Ordering of Events in a Distributed System" — one of the most cited papers in computer science. It gave us a way to reason about event ordering without relying on synchronized physical clocks. The insight was deceptively simple: you don't need to know *what time* something happened. You only need to know *what happened before what*.

---

## The Problem: What Does "Before" Mean?

On a single machine, "before" is obvious. If line 10 of your program executes, then line 11 executes, line 10 happened before line 11. The CPU enforces sequential execution, and the operating system provides a total order of events via its monotonic clock.

In a distributed system, there is no shared clock, no shared memory, and no global observer. Consider three processes:

```
Process P1:        a ─────────────── b ─────────────── c
                         │                    ▲
                         │    message m1       │
                         ▼                    │
Process P2:        d ─── e ─────────── f ──── g
                                       │
                              message m2│
                                       ▼
Process P3:        h ────────────────── i ─── j
```

Some orderings are clear:
- `a` happened before `b` (same process, sequential execution)
- `e` happened before `g` (same process)
- `e` happened before `g` and the message from P1 to P2 means `a` happened before `e`... wait, does it?

Actually, we need to be more precise. Let's define what "happened before" means.

---

## The Happens-Before Relation

Lamport defined the **happens-before** relation, written `→`, with three rules:

### Rule 1: Process Order

If `a` and `b` are events in the same process, and `a` comes before `b` in that process's execution, then `a → b`.

This captures the idea that within a single process, events are totally ordered by program execution.

### Rule 2: Message Sending

If `a` is the event of sending a message and `b` is the event of receiving that same message (in a different process), then `a → b`.

This captures the idea that a message cannot be received before it is sent. This is a physical law — information cannot travel backward in time.

### Rule 3: Transitivity

If `a → b` and `b → c`, then `a → c`.

Combining these three rules lets us build a partial order over all events in the system.

### Concurrent Events

Here's the crucial definition: if neither `a → b` nor `b → a`, then `a` and `b` are **concurrent**, written `a ∥ b`.

Concurrent does not mean "happened at the same time." It means "neither could have influenced the other." Two events are concurrent if there is no chain of process-order and message-passing that connects them.

In the diagram above:
- `a → e` (a is send of m1, e is receive — Rule 2)
- `e → g` (same process — Rule 1)
- Therefore `a → g` (transitivity — Rule 3)
- But `a ∥ d` (no message chain connects them)
- And `b ∥ h` (no message chain connects them)
- And `c ∥ j` might or might not be concurrent — we'd need to trace all message paths

Concurrency is the default. In a distributed system, most events are concurrent with most other events. Only events connected by message chains have a definite ordering.

---

## Lamport's Logical Clock Algorithm

Now that we've defined the happens-before relation, Lamport gave a simple algorithm to assign a number to every event such that:

> **Clock Condition**: If `a → b`, then `C(a) < C(b)`.

Where `C(e)` is the "logical clock value" assigned to event `e`.

### The Algorithm

Each process `Pi` maintains a counter `Ci`, initialized to 0.

**Rule LC1 — Local event**: Before executing any event, increment the counter:
```
Ci = Ci + 1
```

**Rule LC2 — Send**: When sending a message, attach the current counter value:
```
Ci = Ci + 1
send(message, Ci)
```

**Rule LC3 — Receive**: When receiving a message with timestamp `ts`:
```
Ci = max(Ci, ts) + 1
```

That's it. Three rules. Let's trace through an example.

### Worked Example

```
Process P1 (C1=0):     Process P2 (C2=0):     Process P3 (C3=0):

a: local event          d: local event          h: local event
  C1 = 0+1 = 1           C2 = 0+1 = 1           C3 = 0+1 = 1

b: send m1 to P2
  C1 = 1+1 = 2
  send(m1, ts=2)
                        e: receive m1(ts=2)
                          C2 = max(1,2)+1 = 3

c: local event
  C1 = 2+1 = 3
                        f: local event
                          C2 = 3+1 = 4

                        g: send m2 to P3
                          C2 = 4+1 = 5
                          send(m2, ts=5)

                                                i: receive m2(ts=5)
                                                  C3 = max(1,5)+1 = 6

                                                j: local event
                                                  C3 = 6+1 = 7
```

Let's draw this as a timeline with Lamport clock values:

```
P1:  a(1) ─── b(2) ──────────────── c(3)
               │
               │ m1(ts=2)
               ▼
P2:  d(1) ─── e(3) ── f(4) ── g(5)
                                │
                                │ m2(ts=5)
                                ▼
P3:  h(1) ──────────────────── i(6) ── j(7)
```

Let's verify the clock condition:
- `a → b`: C(a)=1 < C(b)=2 ✓
- `b → e` (message): C(b)=2 < C(e)=3 ✓
- `a → e` (transitive): C(a)=1 < C(e)=3 ✓
- `a → g` (transitive): C(a)=1 < C(g)=5 ✓
- `g → i` (message): C(g)=5 < C(i)=6 ✓
- `a → j` (transitive): C(a)=1 < C(j)=7 ✓

The clock condition holds everywhere.

---

## What Lamport Clocks Can and Cannot Do

### What They Guarantee

**If `a → b`, then `C(a) < C(b)`.**

This is the clock condition, and it always holds if you follow the algorithm. It means you can use Lamport clock values to rule out orderings: if `C(a) ≥ C(b)`, you know for certain that `a` did NOT happen before `b`.

### What They Do NOT Guarantee

**The converse is NOT true**: `C(a) < C(b)` does NOT imply `a → b`.

Look at our example:
- C(a) = 1 and C(d) = 1 → `a ∥ d` (concurrent, same clock value)
- C(a) = 1 and C(f) = 4 → C(a) < C(f), but is `a → f`?

Let's check: `a → b → e → f` by following the chain: a happens before b (same process), b happens before e (message), e happens before f (same process). So yes, `a → f`. But this is coincidence from the example structure.

Consider a different example:

```
P1:  a(1) ── b(2) ── c(3) ── d(4)

P2:  x(1) ── y(2) ── z(3)
```

No messages between P1 and P2. C(a)=1 < C(z)=3, but `a ∥ z`. The clock values suggest an ordering that doesn't exist.

**Lamport clocks cannot detect concurrency.** If `C(a) < C(b)`, the events might be causally ordered, or they might be concurrent. You can't tell which. This is the fundamental limitation, and it's why vector clocks (Chapter 11) exist.

---

## Total Ordering with Lamport Clocks

Lamport clocks give a partial order. But many algorithms need a **total order** — a way to rank every pair of events, with no ties and no ambiguity.

Lamport proposed a simple extension: break ties using process IDs. Define the total order `⇒` as:

> Event `a` on process `Pi` comes before event `b` on process `Pj` (written `a ⇒ b`) if and only if:
> 1. `C(a) < C(b)`, OR
> 2. `C(a) = C(b)` and `i < j`

This gives a deterministic total order over all events. The process ID tiebreaker is arbitrary (any consistent tiebreaker works), but it must be the same on every process.

### Example: Total Ordering in Practice

Consider a distributed lock. Three processes want to acquire a lock. Each sends a request to all others with its Lamport timestamp:

```
P1 sends REQUEST(C=5, pid=1) to all
P2 sends REQUEST(C=5, pid=2) to all
P3 sends REQUEST(C=3, pid=3) to all
```

Using the total order:
1. P3's request (C=3) goes first
2. P1's request (C=5, pid=1) goes second (lower pid breaks tie)
3. P2's request (C=5, pid=2) goes third

Every process computes the same total order, so they agree on who gets the lock first, without any centralized coordinator.

### Lamport's Mutual Exclusion Algorithm

Lamport used his total order to build a distributed mutual exclusion algorithm — one of the first correct solutions to distributed locking without a centralized server.

The algorithm uses three message types: REQUEST, REPLY, and RELEASE. Each process maintains a local request queue sorted by Lamport timestamp.

```
To request the lock:
  1. Increment clock, send REQUEST(timestamp, pid) to all other processes
  2. Add own request to local queue

On receiving REQUEST(ts, pid) from Pj:
  1. Add Pj's request to local queue
  2. Send REPLY(timestamp) to Pj

To enter critical section:
  1. Own request is at the front of the queue (earliest in total order)
  2. Has received REPLY from every other process with a timestamp
     later than own request's timestamp

To release the lock:
  1. Remove own request from queue
  2. Send RELEASE(timestamp) to all other processes

On receiving RELEASE from Pj:
  1. Remove Pj's request from queue
```

**Why it works**: The REPLY messages serve as acknowledgments that the other processes have seen your request. Since Lamport clocks guarantee that if `a → b` then `C(a) < C(b)`, and every process sees all REQUESTs before sending a REPLY, every process computes the same total order and agrees on who holds the lock.

**Cost**: Each lock acquisition requires `3(N-1)` messages (REQUEST to N-1 processes, REPLY from N-1 processes, RELEASE to N-1 processes). This is expensive but correct.

---

## Implementing Lamport Clocks

Here's a complete implementation:

```python
import threading

class LamportClock:
    def __init__(self, process_id):
        self.time = 0
        self.process_id = process_id
        self._lock = threading.Lock()

    def tick(self):
        """Increment clock for a local event. Returns new timestamp."""
        with self._lock:
            self.time += 1
            return self.time

    def send_timestamp(self):
        """Get timestamp to attach to an outgoing message."""
        with self._lock:
            self.time += 1
            return self.time

    def receive_timestamp(self, msg_timestamp):
        """Update clock on receiving a message. Returns new timestamp."""
        with self._lock:
            self.time = max(self.time, msg_timestamp) + 1
            return self.time

    def current(self):
        """Read current clock value without advancing it."""
        with self._lock:
            return self.time
```

Usage in a message-passing system:

```python
clock = LamportClock(process_id=1)

# Local event
ts = clock.tick()
log(f"Processed request at logical time {ts}")

# Sending a message
ts = clock.send_timestamp()
send_to_peer(Message(data=payload, timestamp=ts, sender=clock.process_id))

# Receiving a message
msg = receive_from_peer()
ts = clock.receive_timestamp(msg.timestamp)
log(f"Received message from {msg.sender}, local time now {ts}")
```

### Implementation in Go

```go
type LamportClock struct {
    mu        sync.Mutex
    time      uint64
    processID int
}

func NewLamportClock(pid int) *LamportClock {
    return &LamportClock{processID: pid}
}

func (c *LamportClock) Tick() uint64 {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.time++
    return c.time
}

func (c *LamportClock) Send() uint64 {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.time++
    return c.time
}

func (c *LamportClock) Receive(msgTime uint64) uint64 {
    c.mu.Lock()
    defer c.mu.Unlock()
    if msgTime > c.time {
        c.time = msgTime
    }
    c.time++
    return c.time
}
```

### Design Decisions

**Integer size**: Lamport clocks grow monotonically. In a system processing 1 million events per second, a 64-bit counter overflows in ~585,000 years. A 32-bit counter overflows in ~72 minutes. Use 64-bit integers.

**Thread safety**: Multiple goroutines/threads handling messages concurrently will race on the clock. The mutex is essential.

**Clock value in wire protocol**: Include the Lamport timestamp in every inter-process message. It's a single integer — negligible overhead. Some systems embed it in RPC headers so application code doesn't need to manage it explicitly.

---

## Lamport Clocks in Real Systems

### Amazon DynamoDB

DynamoDB uses Lamport-style logical timestamps for certain internal ordering decisions, though the public-facing conflict resolution uses vector clocks (Chapter 11) or last-write-wins at the application level.

### Google's Percolator

Google's Percolator (used by the web indexing pipeline) uses a centralized timestamp oracle that issues monotonically increasing timestamps. This is effectively a single-node Lamport clock — every transaction gets a globally ordered timestamp from one server. The tradeoff: the oracle is a single point of failure and a throughput bottleneck, but it provides a trivially correct total order.

### Apache Kafka

Kafka's log offsets are a form of Lamport clock within a single partition. Each message gets a monotonically increasing offset. Cross-partition ordering isn't guaranteed — which is exactly the Lamport clock limitation: events on different processes (partitions) are concurrent unless connected by a message chain.

### etcd / Raft

Raft uses a monotonically increasing term number combined with a log index. The term number functions like a Lamport clock — it increases on every leader election, and followers adopt the leader's term if it's higher than theirs:

```
On receiving a message with term T:
  if T > currentTerm:
    currentTerm = T    // analogous to max(local, received) + 1
    convert to follower
```

This ensures that all nodes agree on the current term, and that terms form a total order. Lamport's idea is embedded in nearly every consensus protocol.

---

## The Causal Consistency Connection

Lamport clocks enable **causal consistency** — the guarantee that if event `a` causally affects event `b`, all processes see `a` before `b`. Causal consistency sits between linearizability and eventual consistency in the consistency hierarchy (Chapter 12).

To implement causal delivery of messages using Lamport clocks:

```
On sending message m:
  ts = clock.send_timestamp()
  attach ts to m
  send m

On receiving message m with timestamp ts:
  // Deliver m only after all messages with smaller timestamps
  // from the same sender have been delivered
  buffer m
  while buffer has a message m' with ts' where:
    - ts' is the smallest in the buffer
    - all messages with ts < ts' from m'.sender have been delivered:
      deliver m'
      clock.receive_timestamp(m'.timestamp)
      remove m' from buffer
```

This ensures that messages are delivered in an order consistent with causality. However, it requires tracking per-sender sequence numbers, which brings us toward vector clocks.

---

## Common Mistakes

### Mistake 1: Using Lamport Clocks to Detect Concurrency

```python
# WRONG: cannot determine concurrency from Lamport timestamps
if event_a.lamport_ts < event_b.lamport_ts:
    print("a happened before b")  # WRONG — might be concurrent
```

Lamport clocks only tell you:
- If `C(a) ≥ C(b)`: definitely NOT `a → b`
- If `C(a) < C(b)`: maybe `a → b`, maybe concurrent — **can't tell**

To detect concurrency, you need vector clocks (Chapter 11).

### Mistake 2: Comparing Timestamps Across Unrelated Systems

Lamport clock values are meaningful only within a system where processes exchange messages carrying timestamps. Two systems that never communicate have unrelated Lamport clocks, and comparing their values is meaningless.

### Mistake 3: Resetting the Clock

If a process restarts and resets its Lamport clock to 0, the clock condition can be violated. Persist the clock value to durable storage, or use a value derived from the wall clock as the initial value (providing the wall clock is at least monotonic between restarts):

```python
def recover_clock(persisted_value, wall_clock_ms):
    # Start from whichever is larger to avoid going backward
    return max(persisted_value, wall_clock_ms)
```

### Mistake 4: Forgetting to Increment on Receive

The most common implementation bug is setting the clock to `max(local, received)` instead of `max(local, received) + 1`. Without the `+1`, the receive event gets the same timestamp as the send event, violating the clock condition (send → receive, so C(send) must be < C(receive)).

---

## Lamport Clocks vs. Physical Clocks: A Comparison

| Property | Physical Clock | Lamport Clock |
|----------|---------------|---------------|
| Requires synchronization hardware | Yes (NTP, GPS, PTP) | No |
| Can go backward | Yes (NTP step corrections) | No (monotonically increasing) |
| Comparable across machines | Approximately (within skew) | Yes (exactly, with total order) |
| Detects concurrency | No | No |
| Preserves causality | No (clock skew can invert ordering) | Yes (by construction) |
| Reflects real time | Yes (approximately) | No (purely logical) |
| Useful for timeouts/TTL | Yes | No |
| Overhead | Hardware + network (NTP) | One integer per message |

Neither clock solves all problems. Physical clocks give approximate real-time correspondence. Lamport clocks give exact causal ordering. Many real systems combine both — a technique called **Hybrid Logical Clocks** (HLC), used by CockroachDB and others:

```
HLC = (physical_component, logical_component)

On local event or send:
  physical = max(local_physical, wall_clock_now())
  if physical == local_physical:
    logical = local_logical + 1
  else:
    logical = 0

On receive with message HLC (msg_phys, msg_log):
  physical = max(local_physical, msg_phys, wall_clock_now())
  if physical == local_physical == msg_phys:
    logical = max(local_logical, msg_log) + 1
  elif physical == local_physical:
    logical = local_logical + 1
  elif physical == msg_phys:
    logical = msg_log + 1
  else:
    logical = 0
```

HLCs provide the best of both worlds: they track causality like Lamport clocks, and their physical component stays close to real time (within NTP skew). When the physical clocks are in sync, the logical component is 0 — the HLC degenerates to a physical timestamp. When clocks skew, the logical component preserves causal ordering.

---

## From Lamport Clocks to Vector Clocks

Lamport clocks have one critical limitation: they can't tell concurrent events apart from causally ordered ones. If `C(a) < C(b)`, you know `a` didn't happen *after* `b`, but you don't know whether `a` happened *before* `b` or is *concurrent* with `b`.

For systems that need to detect concurrency — like Amazon's Dynamo, which must identify conflicting writes to the same key — Lamport clocks are insufficient. The next chapter introduces vector clocks, which track not just a single counter but one counter per process, enabling exact detection of the happens-before relation and, crucially, of concurrency.

---

## Key Takeaways

1. **The happens-before relation** (`→`) is defined by three rules: process order, message passing, and transitivity. It creates a partial order over events.

2. **Concurrent events** (`a ∥ b`) are events where neither happened before the other. This doesn't mean "same time" — it means "no causal connection."

3. **Lamport clocks** assign a monotonically increasing integer to each event such that `a → b` implies `C(a) < C(b)`. The algorithm: increment on local events, attach timestamp to messages, take `max(local, received) + 1` on receive.

4. **The converse does not hold**: `C(a) < C(b)` does NOT mean `a → b`. Lamport clocks cannot detect concurrency.

5. **Total ordering** is achieved by breaking ties with process IDs. This gives a deterministic global order that all processes agree on, enabling distributed mutual exclusion.

6. **Lamport clocks are everywhere**: Raft terms, Kafka offsets, DynamoDB internals, and any protocol that needs a consistent ordering of events.

7. **Hybrid Logical Clocks** combine physical and logical components to get both approximate real-time correspondence and exact causal ordering.

8. **To detect concurrency**, you need vector clocks (next chapter).

---

## References

- Lamport, L. (1978). *Time, Clocks, and the Ordering of Events in a Distributed System*. Communications of the ACM, 21(7), 558–565.
- Lamport, L. (1974). *A New Solution of Dijkstra's Concurrent Programming Problem*. Communications of the ACM, 17(8), 453–455.
- Kulkarni, S. S., Demirbas, M., Madappa, D., Avva, B., & Leone, M. (2014). *Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases*. (HLC paper)
- Mattern, F. (1988). *Virtual Time and Global States of Distributed Systems*. (Parallel formulation of vector clocks)
- Fidge, C. J. (1988). *Timestamps in Message-Passing Systems That Preserve the Partial Ordering*. (Independent formulation of vector clocks)
- Raynal, M. & Singhal, M. (1996). *Logical Time: Capturing Causality in Distributed Systems*. IEEE Computer.

---

**Next**: [Chapter 11 — Vector Clocks and Causal Ordering →](ch11-vector-clocks.md)
