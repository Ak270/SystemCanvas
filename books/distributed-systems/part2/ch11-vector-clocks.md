# Chapter 11: Vector Clocks and Causal Ordering

> **Core question**: How does Amazon Dynamo track which version of a shopping cart is newer when two conflicting writes arrive simultaneously?

> **Prerequisites**: Chapter 10 (Lamport Clocks and the Happens-Before Relation)

---

## The Problem Lamport Clocks Can't Solve

In Chapter 10 we learned that Lamport clocks give every event a number such that if event *a* happens before event *b*, then `L(a) < L(b)`. This is powerful, but the implication runs in only one direction:

```
a → b   implies   L(a) < L(b)
```

The converse is **not** true:

```
L(a) < L(b)   does NOT imply   a → b
```

Two events can have `L(a) < L(b)` and yet be **concurrent** — neither caused the other. Lamport clocks cannot distinguish "a happened before b" from "a and b happened independently and a just got a lower number."

### Why This Matters in Practice

Imagine an e-commerce shopping cart stored on three replicas. A customer adds a book on replica 1 (Lamport timestamp 5), and simultaneously, a different client-side session removes a shirt on replica 2 (Lamport timestamp 7). Later the replicas synchronize.

With Lamport clocks alone, the system sees timestamps 5 and 7. It might conclude the removal "happened after" the addition and apply them in that order. But these events were **concurrent** — neither one knew about the other. The system needs to detect this concurrency so it can present both versions to a conflict resolver (or merge them automatically).

This is the exact problem Amazon's Dynamo (2007) needed to solve at scale, and the tool they used was **vector clocks**.

---

## Vector Clocks: Definition

A **vector clock** is an array of counters, one per process (or node) in the system. For a system with *N* processes, each process *i* maintains a vector `V_i` of size *N*.

```
Process P1 maintains: V1 = [c1, c2, c3]
Process P2 maintains: V2 = [c1, c2, c3]
Process P3 maintains: V3 = [c1, c2, c3]
```

Each entry `V_i[j]` represents process *i*'s knowledge of how many events process *j* has executed.

### The Algorithm

Three rules govern vector clock updates:

**Rule 1 — Local event**: Before process *i* executes a local event, it increments its own entry:

```
V_i[i] = V_i[i] + 1
```

**Rule 2 — Send**: When process *i* sends a message, it first increments its own entry (Rule 1), then attaches its entire vector `V_i` to the message.

**Rule 3 — Receive**: When process *i* receives a message carrying vector `V_msg`:

```
V_i[i] = V_i[i] + 1                          // increment own counter
for each j ≠ i:
    V_i[j] = max(V_i[j], V_msg[j])           // merge knowledge
```

### Pseudocode

```python
class VectorClock:
    def __init__(self, process_id, num_processes):
        self.id = process_id
        self.clock = [0] * num_processes
    
    def local_event(self):
        self.clock[self.id] += 1
        return self.clock.copy()
    
    def send(self):
        self.clock[self.id] += 1
        return self.clock.copy()  # attach to message
    
    def receive(self, incoming_clock):
        self.clock[self.id] += 1
        for j in range(len(self.clock)):
            if j != self.id:
                self.clock[j] = max(self.clock[j], incoming_clock[j])
        return self.clock.copy()
```

---

## Comparing Vector Clocks: The Key Insight

Given two vector clocks `A` and `B`, there are exactly three possible relationships:

**A < B (A happened before B)**: Every entry in A is less than or equal to the corresponding entry in B, and at least one is strictly less.

```
A < B  iff  ∀k: A[k] ≤ B[k]  AND  ∃k: A[k] < B[k]
```

**A = B**: Every entry is identical.

**A ∥ B (A and B are concurrent)**: Neither A ≤ B nor B ≤ A. Some entries in A are greater, and some entries in B are greater.

```
A ∥ B  iff  ∃j: A[j] > B[j]  AND  ∃k: A[k] < B[k]
```

This is the crucial capability Lamport clocks lack. Vector clocks give us a **partial order** that exactly captures causality, while Lamport clocks give a total order that obscures concurrency.

### Comparison Function

```python
def compare(vc_a, vc_b):
    """
    Returns:
      'before'     if vc_a < vc_b  (a happened before b)
      'after'      if vc_a > vc_b  (a happened after b)
      'concurrent' if vc_a ∥ vc_b  (neither caused the other)
      'equal'      if vc_a == vc_b
    """
    less = False
    greater = False
    for a_val, b_val in zip(vc_a, vc_b):
        if a_val < b_val:
            less = True
        elif a_val > b_val:
            greater = True
    
    if less and greater:
        return 'concurrent'
    elif less:
        return 'before'
    elif greater:
        return 'after'
    else:
        return 'equal'
```

---

## Worked Example: Three-Node System

Let's trace vector clocks through a concrete scenario with three processes: P0, P1, P2.

```
Time ──────────────────────────────────────────────────────►

P0:  [1,0,0]──send──▶─────────────────────[2,2,0]──local──▶[3,2,0]
              ╲                            ▲
               ╲                          ╱
                ╲    ┌─────────msg──────╱
                 ╲   │
P1:  [0,1,0]─────▶[1,2,0]──send──▶──────────────────[1,3,2]
                                  ╲                  ▲
                                   ╲                ╱
                                    ╲   ┌──msg────╱
                                     ╲  │
P2:  [0,0,1]──local──▶[0,0,2]────────▶[1,2,3]──send──▶
```

Step by step:

1. **P0 does a local event**: `[0,0,0]` → `[1,0,0]`
2. **P1 does a local event**: `[0,0,0]` → `[0,1,0]`
3. **P2 does a local event**: `[0,0,0]` → `[0,0,1]`
4. **P0 sends to P1** (carrying `[1,0,0]`): P0 becomes `[1,0,0]` (already incremented)
5. **P1 receives from P0**: P1 increments own counter: `0+1=2`, merges: `max([0,_,0], [1,_,0])` → `[1,2,0]`
6. **P2 does another local event**: `[0,0,1]` → `[0,0,2]`
7. **P1 sends to P2** (carrying `[1,2,0]`): P1 is at `[1,2,0]`
8. **P2 receives from P1**: P2 increments own: `2+1=3`, merges: `max([0,0,_], [1,2,_])` → `[1,2,3]`
9. **P2 sends to P0** (carrying `[1,2,3]`): P2 stays at `[1,2,3]`
10. **P0 receives from P2**: P0 increments own: `1+1=2`, merges: `max([_,0,0], [_,2,3])` → `[2,2,3]`

Wait — let me re-check step 10. P0 was at `[1,0,0]`. It receives `[1,2,3]`. Increment own: `[2,0,0]`. Merge others: `max(0,2)=2`, `max(0,3)=3` → `[2,2,3]`.

11. **P0 does a local event**: `[2,2,3]` → `[3,2,3]`

Now let's compare some events:

- P0's initial event `[1,0,0]` vs P2's event `[0,0,2]`: P0 has a 1 where P2 has 0, and P2 has a 2 where P0 has 0. **Concurrent**.
- P0's initial event `[1,0,0]` vs P1's event `[1,2,0]`: Every entry in `[1,0,0]` ≤ `[1,2,0]`. **P0's event happened before P1's event**. Correct — P0 sent a message to P1.
- P1's event `[1,2,0]` vs P2's event `[1,2,3]`: Every entry in `[1,2,0]` ≤ `[1,2,3]`. **P1's event happened before P2's event**. Correct — P1 sent a message to P2 (transitively carrying P0's knowledge too).

---

## The Dynamo Shopping Cart Problem

Amazon's Dynamo paper (DeCandia et al., 2007) used vector clocks to manage conflicts in a leaderless, eventually consistent key-value store. Here's the classic example.

### Setup

A shopping cart is stored with key `cart:alice` across three replicas: `S_x`, `S_y`, `S_z`.

### Scenario

```
Step 1: Alice adds a book. Write goes to Sx.
        Sx stores: value={book}, clock=[(Sx,1)]

Step 2: Alice adds a pen. Write goes to Sx again.
        Sx stores: value={book,pen}, clock=[(Sx,2)]

Step 3: Replicas synchronize. Sy and Sz get [(Sx,2)] → {book,pen}

Step 4: Network partition! Sx is isolated from Sy and Sz.

Step 5: Alice (routed to Sy) removes the pen.
        Sy stores: value={book}, clock=[(Sx,2),(Sy,1)]

Step 6: Alice's friend Bob (routed to Sx) adds a hat.
        Sx stores: value={book,pen,hat}, clock=[(Sx,3)]

Step 7: Partition heals. Sy and Sx sync.
```

Now we compare the two versions:

```
Version A (from Sx):  value={book,pen,hat}   clock=[(Sx,3)]
Version B (from Sy):  value={book}           clock=[(Sx,2),(Sy,1)]
```

Compare the clocks:
- A has `Sx=3`, B has `Sx=2`. A > B on the Sx dimension.
- A has `Sy=0` (absent), B has `Sy=1`. B > A on the Sy dimension.

Since one dimension is greater in A and another is greater in B, the clocks are **concurrent**. The system cannot automatically pick a winner.

### Resolution Options

Dynamo offers two strategies:

**1. Client-side resolution**: Return both versions to the client. The application merges them. For a shopping cart, the merge strategy is typically a set union: `{book, pen, hat} ∪ {book}` = `{book, pen, hat}`. The pen removal is lost — this is a known trade-off that Dynamo makes in favor of availability ("add to cart" never fails).

**2. Last-writer-wins (LWW)**: Attach a physical timestamp and pick the latest. This is simpler but loses data — one of the two writes is silently discarded. Cassandra uses this strategy by default.

### Why Not Just Use Physical Timestamps?

Because clock skew (Chapter 9). If Sx's clock is 50ms ahead of Sy's, then Sx's write will always "win" even if it happened earlier in real time. Vector clocks detect concurrency precisely, without relying on synchronized clocks.

---

## Version Vectors: A Refinement

In practice, Dynamo-style systems don't use classical vector clocks exactly as described. They use **version vectors**, which track the version history of a specific data item rather than the entire event history of a process.

The difference is subtle but important:

- **Vector clock**: One per process, tracks every event that process has seen.
- **Version vector**: One per data item (key), tracks which replicas have written to that key and how many times.

```
Key: "cart:alice"
Version vector: {Sx: 3, Sy: 1}

This means:
  - Sx has written to this key 3 times
  - Sy has written to this key 1 time
  - Sz has never written to this key
```

Version vectors are more efficient because they grow with the number of replicas that have written to a specific key, not with the total number of processes in the system.

### Comparison Rules

The comparison rules are identical to vector clocks:

```python
def is_ancestor(vv_a, vv_b):
    """Returns True if vv_a is an ancestor of (happened before) vv_b."""
    # Every entry in A must be ≤ corresponding entry in B
    for node in set(list(vv_a.keys()) + list(vv_b.keys())):
        if vv_a.get(node, 0) > vv_b.get(node, 0):
            return False
    return vv_a != vv_b

def are_concurrent(vv_a, vv_b):
    """Returns True if neither is an ancestor of the other."""
    return not is_ancestor(vv_a, vv_b) and not is_ancestor(vv_b, vv_a) and vv_a != vv_b
```

---

## Dotted Version Vectors

Classical version vectors have a subtle bug known as the **sibling explosion** problem. It occurs when a coordinator writes on behalf of a client without itself being one of the tracked replicas.

### The Problem

Consider a system with replicas A, B, C and a coordinator node that routes requests.

```
1. Client writes x=1 via coordinator → stored at A with vv={A:1}
2. Replicated to B, C
3. Client reads from B: gets x=1, vv={A:1}
4. Client writes x=2 via coordinator → stored at B with vv={A:1, B:1}
5. Meanwhile, another client writes x=3 via coordinator → stored at A with vv={A:2}
```

Now A has `{A:2}` and B has `{A:1, B:1}`. These are concurrent (A:2 > A:1, but B:1 > B:0). That's correct — two independent writes happened.

But consider what happens during anti-entropy (replica synchronization): A receives B's version and must store both as siblings. Then B receives A's version and must also store both as siblings. Each sync round can multiply the number of siblings if the coordinator isn't consistently routing writes to the same replica.

### The Solution: Dotted Version Vectors

Dotted version vectors (Preguiça et al., 2012) add a **dot** — a single (replica, counter) pair — that precisely identifies the event that created a specific version. This allows the system to determine that a new write *supersedes* a specific sibling rather than being concurrent with all of them.

```
Version: x=2
  Base version vector: {A:1}        (causal context)
  Dot: (B, 1)                       (the specific write event)
  Combined: {A:1, B:1}
```

When a new write arrives, the system can check whether the dot of an existing sibling is dominated by the incoming version vector. If it is, that sibling is causally superseded and can be discarded.

Riak (the database that evolved from Dynamo's design) adopted dotted version vectors to solve sibling explosion in production.

---

## Detecting Causality vs Concurrency: A Complete Example

Let's walk through a more realistic scenario: a collaborative document edited on three nodes.

```
Initial state: doc = "Hello" at all nodes
               All version vectors: {}

Step 1: Node A writes doc = "Hello World"
        A's version: vv = {A:1}

Step 2: Node A syncs with Node B
        B receives {A:1} → B now has doc = "Hello World", vv = {A:1}

Step 3: Node B writes doc = "Hello World!"
        B's version: vv = {A:1, B:1}

Step 4: Concurrently, Node C (which never synced) writes doc = "Goodbye"
        C's version: vv = {C:1}

Step 5: Node B syncs with Node C
```

At step 5, B compares its version vector `{A:1, B:1}` with C's `{C:1}`:

```
B's perspective:
  {A:1, B:1}  vs  {C:1}
  
  B has A:1, C has A:0 → B > C on dimension A
  B has B:1, C has B:0 → B > C on dimension B  
  B has C:0, C has C:1 → C > B on dimension C

  Result: CONCURRENT (some dimensions greater, some less)
```

B must store both versions as siblings:

```
Sibling 1: doc = "Hello World!",  vv = {A:1, B:1}
Sibling 2: doc = "Goodbye",       vv = {C:1}
```

The next read returns both siblings. The application (or the user) must decide how to merge them.

### After Resolution

Suppose the application merges them into `"Hello World! Goodbye"`. It writes this as a new version that causally succeeds both siblings:

```
Merged: doc = "Hello World! Goodbye"
  vv = {A:1, B:2, C:1}    // B increments because B is writing the merge
```

This new version vector dominates both `{A:1, B:1}` and `{C:1}`, so any replica receiving it can safely discard the old siblings.

---

## Space Overhead and Clock Pruning

The practical challenge with vector clocks is **space**. Each vector clock has one entry per node that has ever written to that key. In a large cluster, this means:

- **100 nodes, 1 billion keys**: Each key's version vector could have up to 100 entries. At 16 bytes per entry (8-byte node ID + 8-byte counter), that's 1.6 KB per key, or 1.6 TB of vector clock overhead alone.

- **Node churn**: If nodes join and leave frequently, the vector clock accumulates entries for nodes that no longer exist.

### Pruning Strategies

**1. Timestamp-based pruning (Dynamo's approach)**

Dynamo stores a physical timestamp alongside each (node, counter) pair. When the vector clock exceeds a threshold (e.g., 10 entries), the oldest entry is removed:

```
Before pruning (>10 entries):
  {A:5, B:3, C:7, D:2, E:1, F:4, G:6, H:1, I:3, J:2, K:1}
  timestamps: A=t9, B=t8, C=t10, ..., K=t1

After pruning (remove oldest timestamp):
  {A:5, B:3, C:7, D:2, E:1, F:4, G:6, H:1, I:3, J:2}
  (K removed — oldest write)
```

**The risk**: Pruning can cause false concurrency detection. If K's entry is pruned and K later syncs, the system may incorrectly detect a conflict where none exists. Dynamo accepted this trade-off: occasional false conflicts → client-side merge, which the application is already designed to handle.

**2. Node ID reuse avoidance**

When a node leaves and a new node joins, never reuse the old node's ID. This prevents a new node's counter from being confused with the old node's counter.

**3. Bounded version vectors**

Some systems limit the vector to only the *N* most recent writers. Since most keys have a small number of active writers (often 1–3 in practice), this keeps the overhead small for the common case.

**4. Server-side coordination**

Riak's approach: route writes for a key to a fixed set of "preference list" replicas. Since only 3–5 replicas ever write to a given key, the version vector stays small naturally. This is more practical than pruning in many cases.

---

## Vector Clocks vs Other Conflict Detection Mechanisms

| Mechanism | Detects Concurrency? | Space Cost | Clock Sync Needed? |
|-----------|---------------------|------------|-------------------|
| Physical timestamps (LWW) | No — arbitrarily picks "last" writer | O(1) per version | Yes (and skew causes data loss) |
| Lamport timestamps | No — total order hides concurrency | O(1) per version | No |
| Vector clocks | **Yes** | O(N) per version | No |
| Version vectors | **Yes** | O(W) per version, W = # writers for this key | No |
| Dotted version vectors | **Yes** (no sibling explosion) | O(W) per version + O(1) dot | No |
| Hash histories (Merkle trees) | Detects divergence, not ordering | O(log N) per tree | No |

---

## Formal Properties of Vector Clocks

Mattern (1989) and Fidge (1988) independently proved the fundamental theorem of vector clocks:

**Theorem**: For any two events *a* and *b* in a distributed computation:

```
a → b   if and only if   V(a) < V(b)
```

This is a **biconditional** — an if-and-only-if. Compare this to Lamport clocks, which only give the forward direction:

```
Lamport:  a → b  implies  L(a) < L(b)     (but not the reverse)
Vector:   a → b  iff      V(a) < V(b)     (both directions)
```

This means:
- If `V(a) < V(b)`: a causally precedes b. We can be **certain** that some chain of messages connects a to b.
- If `V(a) ∥ V(b)`: a and b are concurrent. We can be **certain** that neither event could have influenced the other.

Vector clocks provide an **exact** representation of the causal history. No information is lost.

### Proof Sketch

**Forward direction** (`a → b` implies `V(a) < V(b)`):

By induction on the length of the causal chain from a to b. Each step in the chain — whether a local event, a send, or a receive — increases at least one component of the vector clock. The merge-on-receive (taking the component-wise max) ensures that the recipient's clock dominates the sender's clock.

**Reverse direction** (`V(a) < V(b)` implies `a → b`):

The key insight is that `V_i[j]` represents i's knowledge of j's event count. If `V(a)[j] ≤ V(b)[j]` for all j and strictly less for some j, then b must have received (directly or transitively) information about events from that process that post-date a. This chain of information transfer is exactly the happens-before relation.

---

## Practical Considerations

### When to Use Vector Clocks

Use vector clocks (or version vectors) when:
- You need to detect concurrent writes to the same data
- You have a leaderless or multi-leader replication scheme
- You want conflict detection without depending on synchronized physical clocks
- Your application can handle conflict resolution (either automatically or by presenting choices to the user)

### When NOT to Use Vector Clocks

Don't use vector clocks when:
- You have a single leader per partition — the leader's log position already provides a total order
- You can tolerate data loss from last-writer-wins — LWW is simpler and cheaper
- Your system has thousands of nodes writing to the same key — the vector overhead becomes prohibitive
- You need a total order of events (vector clocks give a partial order; use Lamport clocks + tie-breaking for a total order)

### Real-World Implementations

| System | Mechanism | Notes |
|--------|-----------|-------|
| Amazon Dynamo | Vector clocks (original paper) | Pruned after 10 entries by timestamp |
| Riak | Dotted version vectors | Fixed sibling explosion from Dynamo's design |
| Cassandra | **Not** vector clocks — uses LWW | Chose simplicity over conflict detection |
| CockroachDB | Hybrid logical clocks (HLC) | Combines physical timestamps with logical counters |
| Voldemort | Vector clocks | LinkedIn's Dynamo-inspired store |

---

## The Limits of Vector Clocks

Vector clocks solve the concurrency detection problem, but they have inherent limitations:

**1. They don't resolve conflicts — they only detect them.** The system must have a separate mechanism (application logic, CRDTs, or user intervention) to merge concurrent versions.

**2. They scale linearly with the number of writers.** For a key written by 1,000 different nodes, the version vector has 1,000 entries. This is why systems like Cassandra chose LWW instead.

**3. They require metadata to travel with every version.** Every read must return the version vector so the client can include it in the next write. This increases message sizes and complicates the client protocol.

**4. Pruning sacrifices correctness.** Any pruning strategy can cause false conflict detection. The system must be designed to handle spurious conflicts gracefully.

These limitations lead directly to the design of **CRDTs** (Chapter 28), which resolve conflicts automatically by constraining the data structure itself, and **hybrid logical clocks** (Chapter 27 sidebar), which provide a compact alternative for systems that already have loosely synchronized physical clocks.

---

## Key Takeaways

1. **Lamport clocks give a total order but can't detect concurrency.** If `L(a) < L(b)`, you don't know whether a caused b or they happened independently.

2. **Vector clocks give a partial order that exactly captures causality.** `V(a) < V(b)` if and only if a happened before b. If neither dominates, the events are concurrent.

3. **Concurrent events represent a conflict** that the system must resolve — either by merging, by asking the client, or by arbitrarily picking a winner (LWW).

4. **Version vectors are the practical incarnation** of vector clocks for key-value stores. They track per-key write history rather than per-process event history.

5. **Dotted version vectors fix sibling explosion** by precisely identifying which sibling a new write supersedes.

6. **Space overhead is the main drawback.** Pruning helps but sacrifices precision. Systems with many writers per key often choose simpler mechanisms like LWW.

7. **Vector clocks detect conflicts; they don't resolve them.** Conflict resolution is an application-level concern (or a data-structure-level concern, as CRDTs show in Chapter 28).

---

## References

- Fidge, C. J. (1988). "Timestamps in Message-Passing Systems That Preserve the Partial Ordering." *Proceedings of the 11th Australian Computer Science Conference*.
- Mattern, F. (1989). "Virtual Time and Global States of Distributed Systems." *Parallel and Distributed Algorithms*.
- DeCandia, G., et al. (2007). "Dynamo: Amazon's Highly Available Key-Value Store." *SOSP '07*.
- Preguiça, N., et al. (2012). "Dotted Version Vectors: Logical Clocks for Optimistic Replication." *arXiv:1011.5808*.
- Shapiro, M., et al. (2011). "Conflict-Free Replicated Data Types." *SSS 2011*.
- Parker, D. S., et al. (1983). "Detection of Mutual Inconsistency in Distributed Systems." *IEEE Transactions on Software Engineering*.

---

**Next**: [Chapter 12 — The Consistency Model Hierarchy →](ch12-consistency-models.md)
