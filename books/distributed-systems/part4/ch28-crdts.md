# Chapter 28: CRDTs — Eventual Consistency Without Coordination

> **Core question**: Can I design a data structure that automatically merges conflicting writes across replicas without any locking or consensus round?

## Prerequisites

- Chapter 11 (Vector Clocks and Causal Ordering)
- Chapter 12 (The Consistency Model Hierarchy — especially eventual consistency)
- Chapter 18 (Leaderless Replication)

---

## The Problem: Concurrent Writes to Replicated Data

In a leaderless replicated system (Chapter 18), multiple replicas can accept writes concurrently. When two replicas receive conflicting writes, someone has to resolve the conflict.

We've seen three approaches:

1. **Last-Writer-Wins (LWW)**: Use timestamps to pick a winner. Simple but loses data silently.
2. **Application-level resolution**: Return conflicting versions to the client and let it merge (Dynamo siblings). Correct but pushes complexity to the application developer.
3. **Consensus**: Use Paxos/Raft to agree on a single value. Correct but requires coordination, which costs latency and availability.

CRDTs are a fourth approach: **design the data structure so that concurrent updates merge automatically, deterministically, and without any coordination**. The data structure's mathematical properties guarantee convergence — all replicas that have seen the same set of updates will have the same state, regardless of the order in which updates arrived.

---

## The Mathematical Foundation

### Join-Semilattice

A CRDT's merge operation is defined by a mathematical structure called a **join-semilattice**. This sounds intimidating, but the idea is simple.

A join-semilattice is a set S with a binary operation ⊔ (called "join" or "merge") that satisfies three properties:

1. **Commutative**: `a ⊔ b = b ⊔ a`
   - Merging A into B gives the same result as merging B into A.
   - This means the order replicas communicate doesn't matter.

2. **Associative**: `(a ⊔ b) ⊔ c = a ⊔ (b ⊔ c)`
   - Grouping doesn't matter. If replica 1 merges with 2, then merges with 3, you get the same result as 1 merging with the result of 2 merged with 3.

3. **Idempotent**: `a ⊔ a = a`
   - Merging a value with itself changes nothing.
   - This means duplicate messages are harmless.

A classic example: `max(a, b)` over integers is a join-semilattice. It's commutative (`max(3, 5) = max(5, 3)`), associative, and idempotent (`max(5, 5) = 5`). So is set union: `{a, b} ∪ {b, c} = {a, b, c}`.

If your data type's merge operation forms a join-semilattice, replicas converge — guaranteed. No coordination needed.

### Monotonic Growth

There is one more requirement: the state must grow *monotonically* under the join. Formally, for any update `u` applied to state `s`, the new state `s'` must satisfy `s ⊑ s'` (s is a "sub-state" of s'). In practical terms:

- A counter can only go up (in a G-Counter).
- A set can only add elements (in a G-Set).
- A value's logical timestamp can only increase.

This monotonicity is why "remove" operations are surprisingly hard in CRDTs — removing an element would move the state backward, violating the lattice. Handling removal requires tombstones or more sophisticated structures.

---

## State-Based vs Operation-Based CRDTs

There are two equivalent ways to build a CRDT:

### State-Based CRDTs (CvRDTs — Convergent)

Each replica stores the full state. Replicas periodically exchange their entire state. The receiving replica merges the incoming state with its own using the join operation.

```
Replica A: state_A
Replica B: state_B

A sends state_A to B
B.state = merge(state_B, state_A)

Later, B sends state_B to A
A.state = merge(state_A, state_B)

After exchange: A.state == B.state (convergence)
```

**Pros**: Simple model; tolerates message duplication, reordering, and loss (just resend state).
**Cons**: Sending entire state can be expensive for large data structures.

### Operation-Based CRDTs (CmRDTs — Commutative)

Replicas broadcast *operations* rather than full state. Each operation is applied locally at each replica.

```
Replica A: increment()
A broadcasts: {op: "increment"}

Replica B receives {op: "increment"} and applies it locally
Replica C receives {op: "increment"} and applies it locally
```

**Requirement**: The delivery layer must guarantee that:
1. All operations are delivered to all replicas (reliable broadcast).
2. If two operations are causally related, they are delivered in causal order.

If these delivery guarantees hold, operations can arrive in different orders at different replicas and the result is the same — because the operations commute.

**Pros**: Only transmits the operation, not the full state (smaller messages).
**Cons**: Requires reliable, causally-ordered broadcast infrastructure.

In practice, state-based CRDTs are more common because their requirements are weaker (you can use any gossip protocol to exchange states).

---

## Concrete CRDT Types

### G-Counter (Grow-Only Counter)

The simplest useful CRDT. Each replica maintains its own count; the total is the sum of all replicas' counts.

```python
class GCounter:
    def __init__(self, num_replicas, replica_id):
        self.counts = [0] * num_replicas
        self.id = replica_id

    def increment(self):
        self.counts[self.id] += 1

    def value(self):
        return sum(self.counts)

    def merge(self, other):
        for i in range(len(self.counts)):
            self.counts[i] = max(self.counts[i], other.counts[i])
```

**Example with 3 replicas**:

```
Initial state:
  A.counts = [0, 0, 0]    B.counts = [0, 0, 0]    C.counts = [0, 0, 0]

A increments twice:
  A.counts = [2, 0, 0]    value = 2

B increments once:
  B.counts = [0, 1, 0]    value = 1

A merges with B:
  A.counts = [max(2,0), max(0,1), max(0,0)] = [2, 1, 0]    value = 3

B merges with A:
  B.counts = [max(0,2), max(1,0), max(0,0)] = [2, 1, 0]    value = 3

Converged! Both see 3.
```

**Why not just a single integer?** If A has `count=2` and B has `count=1`, what's `merge(2, 1)`? Is it `max(2, 1) = 2` (lost B's increment) or `2 + 1 = 3` (correct only if we haven't merged before — idempotent merge of `3` with `2` would give `5`)? By giving each replica its own slot, we avoid this ambiguity entirely.

### PN-Counter (Positive-Negative Counter)

A counter that supports both increment and decrement. It uses two G-Counters: one for increments (P) and one for decrements (N).

```python
class PNCounter:
    def __init__(self, num_replicas, replica_id):
        self.P = GCounter(num_replicas, replica_id)
        self.N = GCounter(num_replicas, replica_id)

    def increment(self):
        self.P.increment()

    def decrement(self):
        self.N.increment()

    def value(self):
        return self.P.value() - self.N.value()

    def merge(self, other):
        self.P.merge(other.P)
        self.N.merge(other.N)
```

The value can go negative, and it can go to zero — but neither P nor N ever shrinks, preserving monotonicity.

### G-Set (Grow-Only Set)

A set that supports only additions. The merge operation is set union.

```python
class GSet:
    def __init__(self):
        self.elements = set()

    def add(self, element):
        self.elements.add(element)

    def lookup(self, element):
        return element in self.elements

    def merge(self, other):
        self.elements = self.elements | other.elements
```

Set union is commutative, associative, and idempotent — a perfect join-semilattice. The limitation is obvious: you can never remove an element.

### 2P-Set (Two-Phase Set)

A set that supports both add and remove, using tombstones. It maintains two G-Sets: one for additions (A) and one for removals (R, the "tombstone set").

```python
class TwoPSet:
    def __init__(self):
        self.A = GSet()  # Added elements
        self.R = GSet()  # Removed elements (tombstones)

    def add(self, element):
        self.A.add(element)

    def remove(self, element):
        if self.lookup(element):
            self.R.add(element)

    def lookup(self, element):
        return element in self.A.elements and element not in self.R.elements

    def merge(self, other):
        self.A.merge(other.A)
        self.R.merge(other.R)
```

**Limitation**: once an element is removed, it can never be re-added (it's permanently in the tombstone set). This is the "two-phase" nature — an element transitions from "not present" → "present" → "removed" and can never go back.

### OR-Set (Observed-Remove Set)

The practical solution to the re-add problem. Each addition is tagged with a unique ID. Removal only removes the specific tags that the removing replica has *observed*.

```python
import uuid

class ORSet:
    def __init__(self):
        self.elements = {}  # element -> set of unique tags

    def add(self, element):
        tag = str(uuid.uuid4())
        if element not in self.elements:
            self.elements[element] = set()
        self.elements[element].add(tag)

    def remove(self, element):
        # Remove only the tags we've observed
        if element in self.elements:
            self.elements[element] = set()

    def lookup(self, element):
        return element in self.elements and len(self.elements[element]) > 0

    def value(self):
        return {e for e, tags in self.elements.items() if len(tags) > 0}

    def merge(self, other):
        all_elements = set(self.elements.keys()) | set(other.elements.keys())
        for element in all_elements:
            my_tags = self.elements.get(element, set())
            their_tags = other.elements.get(element, set())
            self.elements[element] = my_tags | their_tags
```

**How concurrent add/remove works**:

```
Replica A has: {"milk": {tag1}}
Replica B has: {"milk": {tag1}}

Concurrently:
  A removes "milk":  A has {"milk": {}}       (removed tag1)
  B adds "milk":     B has {"milk": {tag1, tag2}}  (added tag2)

After merge:
  tags = {} ∪ {tag1, tag2} = {tag1, tag2}
  "milk" is present!
```

The add "wins" over the concurrent remove because B's new tag (tag2) was not observed by A when A performed the removal. This is the intuitive behavior: if someone is adding milk to the shopping cart while someone else is removing it, the add should win (they clearly still want milk).

**Note**: The simple implementation above doesn't handle the full semantics correctly under all merge scenarios. A production OR-Set uses a more careful merge that tracks which tags each replica has seen and removed. The Optimized OR-Set variant reduces metadata overhead.

### LWW-Register (Last-Writer-Wins Register)

A single value with a timestamp. On conflict, the higher timestamp wins.

```python
class LWWRegister:
    def __init__(self):
        self.value = None
        self.timestamp = 0

    def set(self, value, timestamp):
        if timestamp > self.timestamp:
            self.value = value
            self.timestamp = timestamp

    def get(self):
        return self.value

    def merge(self, other):
        if other.timestamp > self.timestamp:
            self.value = other.value
            self.timestamp = other.timestamp
```

This is a CRDT (max-timestamp is a semilattice), but it has the same data-loss problem as LWW conflict resolution in general. If two replicas set different values at nearly the same time, one value is silently lost. Use it only when losing a concurrent write is acceptable (e.g., "last user to update their profile picture wins").

### MV-Register (Multi-Value Register)

Like an LWW-Register, but instead of picking a winner, it keeps all concurrent values (siblings) using vector clocks.

```python
class MVRegister:
    def __init__(self, num_replicas, replica_id):
        self.entries = []  # list of (value, vector_clock)
        self.num_replicas = num_replicas
        self.id = replica_id

    def set(self, value, vc):
        # Remove entries dominated by the new vector clock
        new_entries = [(v, c) for v, c in self.entries
                       if not self._dominates(vc, c)]
        new_entries.append((value, vc))
        self.entries = new_entries

    def get(self):
        # Returns all concurrent values
        return [v for v, _ in self.entries]

    def merge(self, other):
        combined = self.entries + other.entries
        # Keep only entries not dominated by any other
        result = []
        for v1, c1 in combined:
            dominated = False
            for v2, c2 in combined:
                if (v1, c1) != (v2, c2) and self._dominates(c2, c1):
                    dominated = True
                    break
            if not dominated:
                # Deduplicate
                if (v1, c1) not in result:
                    result.append((v1, c1))
        self.entries = result

    @staticmethod
    def _dominates(vc1, vc2):
        return (all(a >= b for a, b in zip(vc1, vc2))
                and any(a > b for a, b in zip(vc1, vc2)))
```

This is what Dynamo uses for shopping cart conflict resolution. When `get()` returns multiple values, the application must merge them (e.g., union of shopping cart items).

### RGA (Replicated Growable Array)

RGA is a CRDT for ordered sequences — the foundation for collaborative text editing. Each element has a unique ID (a combination of the inserting replica's ID and a logical timestamp) and a reference to the element it was inserted after.

```python
from dataclasses import dataclass
from typing import Optional

@dataclass
class RGANode:
    id: tuple          # (replica_id, logical_clock)
    value: str         # The character
    after: tuple       # ID of the node this was inserted after
    tombstone: bool    # True if deleted (but kept for ordering)

class RGA:
    def __init__(self, replica_id):
        self.replica_id = replica_id
        self.clock = 0
        # Sentinel root node
        self.root_id = (0, 0)
        self.nodes = {self.root_id: RGANode(self.root_id, '', None, False)}
        self.order = [self.root_id]  # Ordered list of node IDs

    def insert(self, position, char):
        """Insert char after the element at position."""
        self.clock += 1
        after_id = self.order[position]
        node_id = (self.replica_id, self.clock)
        node = RGANode(node_id, char, after_id, False)
        self._integrate(node)
        return node

    def delete(self, position):
        """Mark element at position as tombstoned."""
        node_id = self.order[position]
        self.nodes[node_id].tombstone = True

    def _integrate(self, new_node):
        """Insert new_node into the correct position."""
        self.nodes[new_node.id] = new_node
        # Find where to insert: after the reference node,
        # but before any node with a smaller ID that also
        # references the same parent
        ref_idx = self.order.index(new_node.after)
        insert_idx = ref_idx + 1

        while insert_idx < len(self.order):
            existing_id = self.order[insert_idx]
            existing = self.nodes[existing_id]
            if existing.after != new_node.after:
                break
            # Same parent — higher ID goes first (left)
            if existing_id > new_node.id:
                insert_idx += 1
            else:
                break

        self.order.insert(insert_idx, new_node.id)

    def text(self):
        """Return the visible text (excluding tombstones and root)."""
        return ''.join(
            self.nodes[nid].value
            for nid in self.order
            if not self.nodes[nid].tombstone and nid != self.root_id
        )

    def merge_remote(self, node):
        """Integrate a remotely-created node."""
        if node.id not in self.nodes:
            self._integrate(node)
```

**How concurrent inserts are resolved**:

```
Document state: "AC"
  root → A → C

Replica 1 inserts 'B' after 'A':   node_id = (1, 5)
Replica 2 inserts 'X' after 'A':   node_id = (2, 3)

Both reference the same parent ('A'). Tie-breaking by ID:
  (2, 3) < (1, 5), so (1, 5) goes first (left)

Result: "ABXC"

Both replicas converge to the same ordering, regardless of
which insert they receive first.
```

RGA is the basis for collaborative editing in tools like Automerge.

---

## Real-World CRDT Implementations

### Automerge

Automerge is a JavaScript/Rust library that provides a JSON-like CRDT. It supports:
- Nested objects and arrays (using a map CRDT and a list CRDT)
- Text editing (using an RGA variant)
- Automatic conflict detection and resolution
- Compact binary encoding for network transport
- Change history and time travel

```javascript
import * as Automerge from 'automerge'

// Replica 1
let doc1 = Automerge.init()
doc1 = Automerge.change(doc1, 'Add item', doc => {
  doc.items = ['milk', 'eggs']
})

// Replica 2 (forked from doc1)
let doc2 = Automerge.clone(doc1)

// Concurrent edits
doc1 = Automerge.change(doc1, 'Add bread', doc => {
  doc.items.push('bread')
})

doc2 = Automerge.change(doc2, 'Add butter', doc => {
  doc.items.push('butter')
})

// Merge — both items appear, no conflict
let merged = Automerge.merge(doc1, doc2)
// merged.items = ['milk', 'eggs', 'bread', 'butter']
// (or ['milk', 'eggs', 'butter', 'bread'] — both orderings are valid)
```

### Yjs

Yjs is a high-performance CRDT framework optimized for real-time collaborative editing. It's used by multiple production editors including Tiptap and BlockSuite. Key differences from Automerge:

- Uses a YATA (Yet Another Transformation Approach) algorithm instead of RGA
- Optimized for text editing performance (sub-millisecond operations)
- Built-in awareness protocol for cursor positions
- Network-agnostic (works over WebSocket, WebRTC, or any transport)

### Riak

Riak (now Riak KV) was one of the first production databases to offer built-in CRDTs as a first-class data type. It supports:
- Counters (PN-Counter)
- Sets (OR-Set variant)
- Maps (nested CRDTs)
- Registers (LWW-Register)
- Flags (enable/disable boolean)

### Redis CRDB

Redis Enterprise's Active-Active Geo-Distribution uses CRDTs internally to replicate data across datacenters without conflict:
- Strings use an LWW-Register
- Counters use a PN-Counter variant
- Sets use an OR-Set variant
- Sorted sets use a custom CRDT combining OR-Set and LWW-Register

---

## Limitations of CRDTs

### 1. Metadata Overhead

Most CRDTs require per-element metadata:
- OR-Set: unique tag per add operation (can grow unbounded)
- Vector clocks: one entry per replica (or per element, in some designs)
- RGA: unique ID per character plus parent reference

For a collaborative text document with 100,000 characters edited by 50 users, the metadata can exceed the document content by 10x or more. Compaction strategies (pruning old vector clock entries, garbage collecting observed tombstones) are essential but add complexity.

### 2. No Invariant Enforcement

CRDTs cannot enforce global invariants. Consider a counter that should never go below zero (e.g., inventory count):

```
Replica A: counter = 3, decrement() → counter = 2
Replica B: counter = 3, decrement() → counter = 2

After merge:
  P = [0, 0]  (no increments)
  N = [1, 1]  (each decremented once)
  value = 0 - 2 = -2    ← invariant violated!
```

Both replicas saw `counter = 3` and legitimately decremented. But the merged result is -2. To enforce the invariant `counter ≥ 0`, you would need coordination — which defeats the purpose of CRDTs.

This is fundamental: **CRDTs trade coordination for convergence, and invariant enforcement requires coordination.** If your application has invariants (account balance ≥ 0, only one winner in an auction, seat not double-booked), CRDTs alone are insufficient.

### 3. Delete Semantics Are Tricky

As we saw, deleting elements requires tombstones. Tombstones accumulate and must eventually be garbage collected, but GC requires coordination (all replicas must agree that a tombstone is no longer needed before it can be deleted).

Different CRDTs make different trade-offs:
- 2P-Set: elements can never be re-added (too restrictive for most uses)
- OR-Set: concurrent add beats remove (surprising if you wanted the remove to stick)
- LWW-Element-Set: timestamps break ties (data loss, like all LWW approaches)

### 4. Intent Preservation

CRDTs preserve *structure*, not *intent*. Example with a collaborative text editor:

```
Document: "Hello World"

User A: Change "Hello" to "Hi"       (delete positions 2-4, result: "Hi World")
User B: Change "World" to "World!"   (insert '!' at position 11)

CRDT merge: "Hi World!"              ← correct!

But what about:
User A: Change "Hello World" to "Goodbye World"  (replace "Hello" with "Goodbye")
User B: Change "Hello World" to "Hello Earth"     (replace "World" with "Earth")

CRDT merge: "Goodbye Earth"          ← is this what either user intended?
```

The merge is structurally valid, but neither user intended "Goodbye Earth." CRDTs cannot know that User A's intent was "change the greeting, keep the noun" or that User B's intent was "keep the greeting, change the noun." They only see character-level operations.

---

## When to Use CRDTs vs Consensus

| Requirement | CRDT | Consensus (Raft/Paxos) |
|-------------|------|----------------------|
| Always writable (high availability) | Yes | No (leader required) |
| Tolerates network partitions | Yes (each side makes progress) | No (minority side is unavailable) |
| Strong consistency | No (eventual) | Yes (linearizable) |
| Invariant enforcement | No | Yes |
| Low latency writes | Yes (local only) | No (quorum round-trip) |
| Conflict-free by design | Yes | N/A (no conflicts with single leader) |

**Use CRDTs when**:
- Availability matters more than immediate consistency
- The data type has a natural merge (counters, sets, text)
- You can tolerate temporary divergence between replicas
- Users expect "offline-first" capability (mobile apps, collaborative editors)

**Use consensus when**:
- Correctness invariants must hold at all times
- You need linearizable reads
- The cost of a wrong merge exceeds the cost of unavailability
- Examples: bank balances, seat reservations, leader elections

**Hybrid approaches** are common: use CRDTs for data that merges naturally (document text, shopping carts, presence indicators) and consensus for data that requires strict ordering (transaction logs, configuration changes, membership).

---

## The CALM Theorem

The theoretical foundation for understanding when CRDTs suffice comes from the **CALM theorem** (Consistency As Logical Monotonicity), proved by Ameloot et al. (2011) and Hellerstein (2010):

> A program has a consistent, coordination-free distributed implementation if and only if it is monotonic.

In practical terms: if your computation only adds information and never retracts it (monotonic), you can implement it without coordination. If it needs to retract or negate (non-monotonic), coordination is unavoidable somewhere.

CRDTs are the data structure embodiment of this principle: their states grow monotonically (in the lattice), so they converge without coordination. A bank balance that must never go negative requires a non-monotonic check, so it cannot be a pure CRDT.

---

## Summary

| CRDT | Supports | Merge Strategy | Limitation |
|------|----------|---------------|------------|
| G-Counter | Increment only | Per-replica max | No decrement |
| PN-Counter | Increment + decrement | Two G-Counters | Can go negative; no floor constraint |
| G-Set | Add only | Set union | No remove |
| 2P-Set | Add + remove | Two G-Sets | No re-add after remove |
| OR-Set | Add + remove + re-add | Tagged elements | Metadata overhead |
| LWW-Register | Overwrite | Max timestamp | Loses concurrent writes |
| MV-Register | Overwrite (keep conflicts) | Vector clock dominance | Returns multiple values |
| RGA | Ordered insert + delete | Unique IDs + parent refs | Tombstone accumulation |

**Key takeaway**: CRDTs let you trade consistency for availability and partition tolerance. They converge automatically because their merge operations form a mathematical structure (join-semilattice) that guarantees the same result regardless of message ordering. But they cannot enforce invariants — if your application requires "this value must never exceed X" or "these two operations must be atomic," you need coordination on top of or instead of CRDTs.

---

## References

- Shapiro, M., Preguiça, N., Baquero, C., & Zawirski, M. (2011). "Conflict-free Replicated Data Types." *SSS '11*.
- Shapiro, M., Preguiça, N., Baquero, C., & Zawirski, M. (2011). "A comprehensive study of Convergent and Commutative Replicated Data Types." INRIA Technical Report 7506.
- Roh, H. G., Jeon, M., Kim, J. S., & Lee, J. (2011). "Replicated abstract data types: Building blocks for collaborative applications." *Journal of Parallel and Distributed Computing*.
- Kleppmann, M., & Beresford, A. R. (2017). "A Conflict-Free Replicated JSON Datatype." *IEEE TPDS*.
- Attiya, H., Burckhardt, S., Gotsman, A., Morrison, A., Yang, H., & Zawirski, M. (2016). "Specification and Complexity of Collaborative Text Editing." *PODC '16*.
- Hellerstein, J. M. (2010). "The Declarative Imperative: Experiences and Conjectures in Distributed Logic." *SIGMOD Record*.
- Ameloot, T. J., Neven, F., & Van den Bussche, J. (2011). "Relational transducers for declarative networking." *PODS '11*.

---

**Next**: [Chapter 29: MapReduce — The Fault-Tolerant Batch Execution Model →](ch29-mapreduce.md)
