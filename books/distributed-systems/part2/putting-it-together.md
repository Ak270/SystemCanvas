# Putting It Together: Vector Clock Chat System

> **Exercise**: Build a vector-clock-based event log for a three-node distributed chat system. Use it to reconstruct causal message order even when messages arrive out of order. Extend it to detect concurrent writes and simulate the Dynamo conflict resolution model.

This exercise ties together every concept from Part 2: physical clock limitations (Ch 9), Lamport clocks (Ch 10), vector clocks (Ch 11), consistency models (Ch 12), and linearizability (Ch 13).

---

## The System

Three chat servers (A, B, C) each accept messages from local users. Servers replicate messages to each other asynchronously. There is no leader — any server can accept a write at any time. This is a leaderless, eventually consistent system (like Dynamo).

```
        User 1                  User 2                  User 3
           │                       │                       │
           ▼                       ▼                       ▼
     ┌──────────┐           ┌──────────┐           ┌──────────┐
     │ Server A │◄─────────▶│ Server B │◄─────────▶│ Server C │
     │ VC=[_,_,_]│          │ VC=[_,_,_]│          │ VC=[_,_,_]│
     └──────────┘           └──────────┘           └──────────┘
          ▲                      ▲                      ▲
          └──────────────────────┴──────────────────────┘
                    Asynchronous replication
```

Each server maintains a vector clock `[a, b, c]` where:
- `a` = number of events Server A knows it has processed
- `b` = number of events Server B knows it has processed
- `c` = number of events Server C knows it has processed

---

## Phase 1: Implement the Vector Clock

```python
class VectorClock:
    def __init__(self, num_nodes):
        self.clock = [0] * num_nodes

    def increment(self, node_id):
        """Called when this node generates a local event."""
        self.clock[node_id] += 1

    def merge(self, other_clock):
        """Called when receiving a message from another node."""
        for i in range(len(self.clock)):
            self.clock[i] = max(self.clock[i], other_clock[i])

    def happens_before(self, other):
        """Returns True if self happened before other."""
        return (all(s <= o for s, o in zip(self.clock, other.clock))
                and any(s < o for s, o in zip(self.clock, other.clock)))

    def is_concurrent(self, other):
        """Returns True if self and other are concurrent (neither happened before the other)."""
        return (not self.happens_before(other)
                and not other.happens_before(self)
                and self.clock != other.clock)

    def __repr__(self):
        return f"[{', '.join(str(x) for x in self.clock)}]"
```

---

## Phase 2: Trace a Chat Session

Work through this scenario by hand, updating vector clocks at each step.

### Event Sequence

```
Time ──────────────────────────────────────────────────────────────▶

Server A          Server B          Server C
   │                  │                  │
   │ m1: "Hello"      │                  │
   ├─────────────────▶│                  │    (A replicates m1 to B)
   │                  │ m2: "Hi there"   │
   │                  ├─────────────────▶│    (B replicates m2 to C)
   │                  │                  │ m3: "Welcome!"
   │ m4: "How are you?"                 │
   │                  │                  │
   │◀─────────────────┤                  │    (B replicates m2 to A)
   │                  │◀─────────────────┤    (C replicates m3 to B)
   │                  │                  │
   ├─────────────────────────────────────▶    (A replicates m4 to C)
   │                  │                  │
```

### Step-by-Step Vector Clock Updates

**Step 1**: Server A sends message m1: "Hello"
```
A increments its own counter:
A.vc = [1, 0, 0]
Message m1 carries vc = [1, 0, 0]
```

**Step 2**: Server B receives m1 from A
```
B merges A's clock and increments its own:
B.vc = merge([0, 0, 0], [1, 0, 0]) = [1, 0, 0]
B stores: m1 = {text: "Hello", vc: [1, 0, 0], origin: A}
```

**Step 3**: Server B sends message m2: "Hi there"
```
B increments its own counter:
B.vc = [1, 1, 0]
Message m2 carries vc = [1, 1, 0]
```

**Step 4**: Server C receives m2 from B
```
C merges B's clock and increments its own:
C.vc = merge([0, 0, 0], [1, 1, 0]) = [1, 1, 0]
C stores: m2 = {text: "Hi there", vc: [1, 1, 0], origin: B}
```

**Step 5**: Server C sends message m3: "Welcome!"
```
C increments its own counter:
C.vc = [1, 1, 1]
Message m3 carries vc = [1, 1, 1]
```

**Step 6**: Server A sends message m4: "How are you?" (before receiving m2)
```
A increments its own counter:
A.vc = [2, 0, 0]
Message m4 carries vc = [2, 0, 0]
```

**Step 7**: Server A receives m2 from B
```
A merges B's clock:
A.vc = merge([2, 0, 0], [1, 1, 0]) = [2, 1, 0]
A stores: m2 = {text: "Hi there", vc: [1, 1, 0], origin: B}
```

**Step 8**: Server B receives m3 from C
```
B merges C's clock:
B.vc = merge([1, 1, 0], [1, 1, 1]) = [1, 1, 1]
B stores: m3 = {text: "Welcome!", vc: [1, 1, 1], origin: C}
```

**Step 9**: Server C receives m4 from A
```
C merges A's clock:
C.vc = merge([1, 1, 1], [2, 0, 0]) = [2, 1, 1]
C stores: m4 = {text: "How are you?", vc: [2, 0, 0], origin: A}
```

### Causal Ordering Analysis

Now determine the causal relationships:

| Message Pair | VC Comparison | Relationship |
|---|---|---|
| m1 [1,0,0] vs m2 [1,1,0] | m1 ≤ m2 in all components, < in at least one | **m1 → m2** (m1 happened before m2) |
| m2 [1,1,0] vs m3 [1,1,1] | m2 ≤ m3 in all components, < in at least one | **m2 → m3** (m2 happened before m3) |
| m1 [1,0,0] vs m3 [1,1,1] | m1 ≤ m3 in all components, < in at least one | **m1 → m3** (transitive: m1 → m2 → m3) |
| m3 [1,1,1] vs m4 [2,0,0] | m3[0]=1 < m4[0]=2, but m3[1]=1 > m4[1]=0 | **m3 ∥ m4** (concurrent!) |
| m2 [1,1,0] vs m4 [2,0,0] | m2[0]=1 < m4[0]=2, but m2[1]=1 > m4[1]=0 | **m2 ∥ m4** (concurrent!) |
| m1 [1,0,0] vs m4 [2,0,0] | m1 ≤ m4 in all components, < in at least one | **m1 → m4** (both from A, sequential) |

The key finding: **m3 and m4 are concurrent**. Server C sent "Welcome!" and Server A sent "How are you?" without knowledge of each other's messages. No causal ordering exists between them. Different servers might display them in different orders — and both orderings are valid under causal consistency.

---

## Phase 3: Conflict Detection (Dynamo-Style)

Now imagine this isn't a chat system but a key-value store. Servers A and C both write to the same key `user_profile` concurrently:

```
Server A writes: user_profile = {name: "Alice", age: 30}  at vc=[2, 0, 0]
Server C writes: user_profile = {name: "Alice", age: 31}  at vc=[1, 1, 1]
```

These vector clocks are concurrent ([2,0,0] ∥ [1,1,1]), so neither write "wins." The system has three options:

### Option 1: Last-Writer-Wins (LWW)
Use a physical timestamp to break the tie. Whichever wall-clock timestamp is later wins. This loses data silently — if C's clock is ahead, the write from A disappears without a trace. Cassandra uses this approach.

### Option 2: Siblings (Dynamo-Style)
Keep both versions and return them to the client on the next read. The client must resolve the conflict:

```python
def read(key):
    versions = store.get_all_versions(key)
    if len(versions) == 1:
        return versions[0]
    else:
        # Multiple concurrent versions — client must merge
        return versions  # [{value: {age: 30}, vc: [2,0,0]},
                         #  {value: {age: 31}, vc: [1,1,1]}]

def write_resolved(key, merged_value, causal_context):
    # Client merges and writes back with a new vector clock
    # that dominates both conflicting versions
    new_vc = merge_all(causal_context) + increment(self_id)
    store.put(key, merged_value, new_vc)
```

This is what Amazon's original Dynamo did. The famous "shopping cart merge" problem: if two concurrent writes add different items, the merged cart should contain both items.

### Option 3: CRDTs
Design the data structure so that concurrent merges are automatic and conflict-free. We cover this in Chapter 28.

---

## Phase 4: Build It

Implement a working three-node chat system with vector clocks. Here's the skeleton:

```python
import threading
import time
import queue
from dataclasses import dataclass, field
from typing import List, Dict

@dataclass
class Message:
    text: str
    origin: int
    vector_clock: List[int]
    msg_id: str

class ChatNode:
    def __init__(self, node_id: int, num_nodes: int):
        self.node_id = node_id
        self.num_nodes = num_nodes
        self.vc = [0] * num_nodes
        self.messages: List[Message] = []
        self.inbox: queue.Queue = queue.Queue()
        self.peers: Dict[int, 'ChatNode'] = {}
        self.lock = threading.Lock()

    def send_message(self, text: str) -> Message:
        with self.lock:
            self.vc[self.node_id] += 1
            msg = Message(
                text=text,
                origin=self.node_id,
                vector_clock=self.vc.copy(),
                msg_id=f"n{self.node_id}_m{self.vc[self.node_id]}"
            )
            self.messages.append(msg)
            # Replicate to all peers
            for peer in self.peers.values():
                peer.inbox.put(msg)
            return msg

    def receive_messages(self):
        """Process all pending messages from peers."""
        while not self.inbox.empty():
            msg = self.inbox.get()
            with self.lock:
                # Check if we already have this message
                if any(m.msg_id == msg.msg_id for m in self.messages):
                    continue
                # Merge vector clocks
                for i in range(self.num_nodes):
                    self.vc[i] = max(self.vc[i], msg.vector_clock[i])
                self.messages.append(msg)

    def get_causal_order(self) -> List[Message]:
        """Return messages in causal order (topological sort)."""
        # Messages where vc1 < vc2 must appear before vc2
        # Concurrent messages can appear in any order
        sorted_msgs = []
        remaining = list(self.messages)

        while remaining:
            # Find messages with no unsorted causal predecessors
            ready = []
            for msg in remaining:
                has_predecessor = False
                for other in remaining:
                    if other is msg:
                        continue
                    if self._happens_before(other.vector_clock, msg.vector_clock):
                        has_predecessor = True
                        break
                if not has_predecessor:
                    ready.append(msg)

            # Among ready messages (all concurrent with each other),
            # break ties by node_id for deterministic ordering
            ready.sort(key=lambda m: (sum(m.vector_clock), m.origin))
            sorted_msgs.extend(ready)
            for msg in ready:
                remaining.remove(msg)

        return sorted_msgs

    @staticmethod
    def _happens_before(vc1: List[int], vc2: List[int]) -> bool:
        return (all(a <= b for a, b in zip(vc1, vc2))
                and any(a < b for a, b in zip(vc1, vc2)))

# --- Simulation ---
def simulate():
    nodes = [ChatNode(i, 3) for i in range(3)]
    for i, node in enumerate(nodes):
        for j, peer in enumerate(nodes):
            if i != j:
                node.peers[j] = peer

    # Simulate the scenario from Phase 2
    m1 = nodes[0].send_message("Hello")
    print(f"A sends m1: vc={m1.vector_clock}")

    nodes[1].receive_messages()
    m2 = nodes[1].send_message("Hi there")
    print(f"B sends m2: vc={m2.vector_clock}")

    nodes[2].receive_messages()
    m3 = nodes[2].send_message("Welcome!")
    print(f"C sends m3: vc={m3.vector_clock}")

    # A sends m4 BEFORE receiving m2 (clear B's message from A's inbox first)
    # Actually, in our simulation send_message already put m2 in A's inbox.
    # To simulate A not yet having processed it, we send m4 before calling receive.
    m4 = nodes[0].send_message("How are you?")
    print(f"A sends m4: vc={m4.vector_clock}")

    # Now everyone receives everything
    for node in nodes:
        node.receive_messages()

    # Display causal ordering from each node's perspective
    for i, node in enumerate(nodes):
        print(f"\nNode {chr(65+i)}'s causal order:")
        for msg in node.get_causal_order():
            print(f"  {msg.msg_id}: \"{msg.text}\" vc={msg.vector_clock}")

if __name__ == "__main__":
    simulate()
```

---

## Exercises

1. **Add network delays**: Modify the simulation so that messages take random time (50–500ms) to arrive. Verify that causal ordering is still correct regardless of delivery order.

2. **Detect conflicts**: Add a `detect_conflicts()` method that identifies all pairs of concurrent messages. In a key-value store scenario, these would be conflicting writes.

3. **Implement LWW**: Add a physical timestamp to each message and implement last-writer-wins conflict resolution. Then create a scenario where LWW produces the wrong result due to clock skew.

4. **Implement Dynamo siblings**: Modify the system to keep concurrent versions of a key and return all siblings to the reader. Implement a merge function for a shopping cart (set union of items).

5. **Compare with Lamport clocks**: Replace vector clocks with Lamport clocks and show a scenario where Lamport clocks cannot detect concurrency that vector clocks can.

6. **Consistency model identification**: For each of these operations on the chat system, identify which consistency model they provide:
   - Reading messages from the local node only
   - Reading messages after syncing with all nodes
   - Reading messages in causal order using vector clocks

---

**Next**: [Part 3 — Replication and Consensus →](../part3/ch17-primary-backup-replication.md)
