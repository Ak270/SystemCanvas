# Capstone 3: Real-Time Collaborative Editor

> Design a Google Docs-like collaborative editor, with a focus on the CRDT-based protocol that lets multiple users edit the same document simultaneously without conflicts.

**Concepts exercised**: CRDTs (Ch 28), vector clocks (Ch 11), causal consistency (Ch 12), conflict-free merges, operational transform comparison.

---

## 1. The Problem

Multiple users type into the same document at the same time. Their edits must:

1. **Converge**: All users eventually see the same document, regardless of the order edits arrive.
2. **Preserve intent**: If User A inserts "hello" at position 5 and User B deletes character 3, both edits should apply correctly — neither should be lost or misplaced.
3. **Work offline**: A user can keep editing while disconnected, and when they reconnect, their changes merge cleanly.
4. **Feel instant**: A user's own keystrokes appear immediately — no waiting for a server round trip.

This is the hardest distributed systems problem in consumer software. Every keystroke is a concurrent distributed operation.

---

## 2. Why Position-Based Edits Break

The naive approach: model edits as `insert(position, char)` and `delete(position)`. User A and B start with the document `"ABCD"`:

```
Initial document: A B C D
                  0 1 2 3

User A: insert(1, 'X')  →  A X B C D
User B: delete(2)       →  A B D
```

If both operations are applied locally and then sent to the other user:

**User A applies User B's delete(2):**
```
A's state:  A X B C D
                  ^ position 2 = 'B'
After delete(2): A X C D    ← User A lost 'B'. But User B deleted 'C'!
```

**User B applies User A's insert(1, 'X'):**
```
B's state:  A B D
              ^ position 1
After insert(1, 'X'): A X B D    ← 'X' inserted correctly
```

Final states: A sees `AXCD`, B sees `AXBD`. **They diverged.** The position-based model is broken because positions shift when other users insert or delete characters.

---

## 3. Two Solutions: OT vs CRDT

### Operational Transformation (OT)

OT fixes position-based edits by **transforming** operations against each other. When User A receives User B's operation, OT adjusts the positions to account for A's concurrent edits.

```
transform(insert(1, 'X'), delete(2)):
  Insert is at position 1, delete is at position 2.
  The insert shifts everything at position >= 1 right by 1.
  So the delete must now target position 3 instead of 2.
  Result: delete(3)
```

OT is what Google Docs historically used. It works but has severe complexity problems:

- The transformation function must handle every pair of operation types: insert×insert, insert×delete, delete×delete, format×insert, etc. The number of cases grows quadratically.
- With more than 2 users, you need transformation composition that is provably correct. Multiple papers got this wrong (the TP2 puzzle).
- OT requires a central server to serialize operations and determine the canonical order. True peer-to-peer OT is an unsolved problem in the general case.

### CRDTs (Our Choice)

CRDTs (Ch 28) take a fundamentally different approach: **design the data structure so that concurrent merges are automatic and conflict-free, with no central coordinator.**

Instead of position-based addressing, a CRDT for text assigns each character a **unique, immutable identifier** that determines its position relative to other characters. Insertions and deletions reference these identifiers, not integer positions, so they're immune to the shifting-position problem.

---

## 4. The RGA Algorithm

We use RGA (Replicated Growable Array), a sequence CRDT designed for collaborative text editing. Each character gets an identifier that encodes:

1. **A unique ID**: `(timestamp, node_id)` where timestamp is a Lamport clock value
2. **A reference to the character it was inserted after**: the ID of its left neighbor at insertion time

### Data Structure

```python
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Tuple

# A unique, immutable identifier for every character ever inserted
@dataclass(frozen=True)
class CharID:
    timestamp: int   # Lamport clock value at insertion time
    node_id: str     # Which node created this character

    def __lt__(self, other):
        # Higher timestamp = more recent = should appear later if concurrent
        # Tie-break by node_id for determinism
        if self.timestamp != other.timestamp:
            return self.timestamp < other.timestamp
        return self.node_id < other.node_id

# A character in the document
@dataclass
class Char:
    id: CharID
    value: str              # The actual character (single char)
    after: Optional[CharID] # ID of the character this was inserted after
    deleted: bool = False   # Tombstone flag (soft delete)

# The document is an ordered list of Chars, including tombstones
ROOT_ID = CharID(timestamp=0, node_id="ROOT")
```

### Insert Operation

When a user types a character:

1. Identify the character to the left of the cursor (the "reference" character).
2. Generate a new `CharID` with the current Lamport clock and local node ID.
3. Create a `Char` with the new ID, the typed character, and the reference.
4. Insert it into the local document at the correct position.
5. Broadcast the insert operation to all other nodes.

```python
class RGADocument:
    def __init__(self, node_id: str):
        self.node_id = node_id
        self.lamport_clock = 0
        self.chars: List[Char] = [Char(id=ROOT_ID, value="", after=None)]
        self.index: Dict[CharID, int] = {ROOT_ID: 0}

    def local_insert(self, position: int, value: str) -> 'InsertOp':
        """User typed a character at the given cursor position."""
        self.lamport_clock += 1

        # Find the character at `position` (skipping tombstones)
        ref_char = self._visible_char_at(position - 1) if position > 0 else self.chars[0]

        new_id = CharID(timestamp=self.lamport_clock, node_id=self.node_id)
        new_char = Char(id=new_id, value=value, after=ref_char.id)

        # Insert into the local document
        self._integrate(new_char)

        # Return the operation to broadcast
        return InsertOp(char=new_char)

    def _integrate(self, new_char: Char):
        """Insert a character into the correct position in the list.

        This is the core of RGA. The character goes immediately after
        its reference character, but if multiple characters were
        concurrently inserted after the same reference, we need a
        deterministic tie-breaking rule.
        """
        # Find the reference character's position
        ref_idx = self.index[new_char.after]

        # Scan right from the reference to find the insertion point.
        # Among characters that share the same reference (concurrent inserts),
        # higher IDs go first (to the LEFT). This is the RGA ordering rule.
        insert_idx = ref_idx + 1
        while insert_idx < len(self.chars):
            existing = self.chars[insert_idx]
            if existing.after != new_char.after:
                # This char has a different reference — we've passed
                # all concurrent siblings
                break
            if existing.id < new_char.id:
                # New char has a higher ID, so it goes before this one
                break
            insert_idx += 1

        # Insert at the determined position
        self.chars.insert(insert_idx, new_char)

        # Update the index for all shifted characters
        self._rebuild_index_from(insert_idx)

    def _visible_char_at(self, visible_pos: int) -> Char:
        """Find the Nth non-deleted character."""
        count = -1  # ROOT is at -1
        for char in self.chars:
            if not char.deleted:
                count += 1
                if count == visible_pos:
                    return char
        raise IndexError(f"No visible character at position {visible_pos}")
```

### Delete Operation

Deletion is a **tombstone**: we mark the character as deleted but never remove it from the list. This is essential because other nodes might reference this character as the "after" anchor for their own inserts.

```python
    def local_delete(self, position: int) -> 'DeleteOp':
        """User deleted the character at the given cursor position."""
        self.lamport_clock += 1
        target = self._visible_char_at(position)
        target.deleted = True
        return DeleteOp(target_id=target.id)

    def remote_delete(self, op: 'DeleteOp'):
        """Apply a delete operation received from another node."""
        self.lamport_clock = max(self.lamport_clock, op.timestamp) + 1
        idx = self.index[op.target_id]
        self.chars[idx].deleted = True
```

### Remote Insert

When we receive an insert from another node:

```python
    def remote_insert(self, op: 'InsertOp'):
        """Apply an insert operation received from another node."""
        self.lamport_clock = max(self.lamport_clock, op.char.id.timestamp) + 1

        # If we already have this character (duplicate delivery), skip
        if op.char.id in self.index:
            return

        # Integrate into our document using the same algorithm
        self._integrate(op.char)
```

The `_integrate` function is **deterministic**: given the same set of characters and their IDs, every node produces the same ordering. This is the CRDT convergence guarantee.

---

## 5. Why RGA Converges

The convergence proof rests on two properties:

### Property 1: Unique IDs
Every character has a globally unique ID `(timestamp, node_id)`. The Lamport clock ensures timestamps increase monotonically on each node, and node IDs are distinct. No two characters can ever share an ID.

### Property 2: Deterministic Ordering
The `_integrate` function places each character based solely on:
- Its reference character (the `after` field)
- Its ID compared to sibling characters (those sharing the same reference)

Both of these are immutable properties of the character itself. They don't depend on the order operations were received, the current state of the document, or any mutable state. So regardless of the order in which a node receives operations, the final document is the same.

### Formal Argument

Let S be the set of all insert/delete operations ever generated. For any two nodes that have received S in any order:

1. Both have the same set of `Char` objects in their list (same IDs, same values, same `after` references, same tombstone flags).
2. The `_integrate` function sorts these objects into the same order (because sorting depends only on immutable properties of each `Char`).
3. Therefore both nodes produce the same visible document.

This is the **strong eventual consistency** guarantee of CRDTs (Ch 28): if two replicas have received the same set of updates (in any order), their states are identical.

---

## 6. Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     User's Browser                        │
│                                                          │
│  ┌──────────┐    ┌───────────┐    ┌────────────────┐    │
│  │  Editor  │───▶│  Local    │───▶│  Sync Engine   │    │
│  │  UI      │◀───│  RGA Doc  │◀───│  (WebSocket)   │    │
│  └──────────┘    └───────────┘    └───────┬────────┘    │
│                                           │              │
└───────────────────────────────────────────┼──────────────┘
                                            │ WebSocket
                                            ▼
                                  ┌──────────────────┐
                                  │   Sync Server    │
                                  │                  │
                                  │  - Fan-out ops   │
                                  │  - Persist ops   │
                                  │  - Causal order  │
                                  │  - Auth/sessions │
                                  └────────┬─────────┘
                                           │
                                  ┌────────▼─────────┐
                                  │  Operation Log   │
                                  │  (append-only)   │
                                  └──────────────────┘
```

### Key Design Decisions

1. **Local-first**: Every keystroke applies instantly to the local RGA document. The user never waits for the server.
2. **Server as relay**: The server fans out operations to all connected clients. It also persists the operation log for offline users to catch up.
3. **No leader, no locking**: Any client can generate operations at any time. The CRDT guarantees convergence.

### Operation Flow

```
User A types 'H'          Server              User B (sees 'H' appear)
     │                       │                       │
     │ 1. Apply locally      │                       │
     │    (instant)          │                       │
     │                       │                       │
     │ 2. Send InsertOp      │                       │
     ├──────────────────────▶│                       │
     │                       │ 3. Persist to log     │
     │                       │                       │
     │                       │ 4. Fan out to B       │
     │                       ├──────────────────────▶│
     │                       │                       │ 5. Apply remotely
     │                       │                       │    (RGA integrate)
     │                       │                       │
     │                       │     ACK               │
     │◀──────────────────────┤                       │
     │ 6. Mark as synced     │                       │
```

Latency: User A sees their character in <1ms (local). User B sees it after a network round trip (~50-200ms same region).

---

## 7. Causal Ordering with Vector Clocks

Operations must be applied in **causal order** (Ch 12). If User A inserts character X after character Y, every node must process Y's insertion before X's insertion (because X references Y as its `after` anchor).

We use **vector clocks** (Ch 11) to track causal dependencies:

```python
@dataclass
class Operation:
    op_type: str          # "insert" or "delete"
    data: dict            # The InsertOp or DeleteOp payload
    vector_clock: Dict[str, int]  # Sender's vector clock at send time
    node_id: str

class CausalBuffer:
    """Buffers operations that arrive out of causal order."""

    def __init__(self, node_id: str, num_nodes: int):
        self.node_id = node_id
        self.vc = {}  # Our vector clock: {node_id: count}
        self.buffer = []

    def receive(self, op: Operation) -> List[Operation]:
        """Receive an operation. Return all operations that are now
        ready to be applied (in causal order)."""
        self.buffer.append(op)
        return self._flush_ready()

    def _is_ready(self, op: Operation) -> bool:
        """An operation is ready if all operations that causally
        precede it have already been applied."""
        for node, count in op.vector_clock.items():
            if node == op.node_id:
                # The sender's own component should be exactly one more
                # than what we've seen from them
                if count != self.vc.get(node, 0) + 1:
                    return False
            else:
                # For other nodes, we must have seen at least as many
                if count > self.vc.get(node, 0):
                    return False
        return True

    def _flush_ready(self) -> List[Operation]:
        """Return all buffered operations that are now causally ready,
        in the order they become ready."""
        ready = []
        changed = True
        while changed:
            changed = False
            for op in list(self.buffer):
                if self._is_ready(op):
                    self.buffer.remove(op)
                    self.vc[op.node_id] = self.vc.get(op.node_id, 0) + 1
                    ready.append(op)
                    changed = True
        return ready
```

### Why Causal Ordering Matters

Without causal ordering, a node might receive an insert that references a character it hasn't seen yet:

```
User A inserts 'H' → char_id = (1, A), after = ROOT
User A inserts 'i' → char_id = (2, A), after = (1, A)

If Node B receives 'i' before 'H':
  - 'i' references char (1, A) as its anchor
  - Node B doesn't have (1, A) yet!
  - Node B must buffer 'i' until 'H' arrives
```

The causal buffer handles this automatically. The vector clock on the 'i' operation says `{A: 2}`, meaning "A has performed 2 operations." If Node B has only seen 0 operations from A, the 'i' operation is not ready yet.

---

## 8. Offline Editing and Reconnection

When a user goes offline:

1. They continue editing locally. Each operation increments their Lamport clock and is buffered.
2. The local RGA document reflects their edits immediately.

When they reconnect:

1. They send all buffered operations to the server, each tagged with their vector clock at the time of creation.
2. They receive all operations from other users that happened while they were offline.
3. The causal buffer ensures these are applied in the correct order.
4. The RGA integrate function ensures the merged document is correct.

```
User A (offline for 5 min)            Server
     │                                   │
     │ (reconnects)                      │
     │                                   │
     │ "I have vc={A:15, B:8, C:3}"     │
     ├──────────────────────────────────▶│
     │                                   │
     │ "Here are 47 ops you missed"      │
     │◀──────────────────────────────────┤
     │                                   │
     │ "Here are my 12 offline ops"      │
     ├──────────────────────────────────▶│
     │                                   │
     │ (apply all ops through RGA)       │
     │ (document converges)              │
     │                                   │
```

The server needs to store the complete operation log (or at least a snapshot plus recent ops) to support arbitrarily long offline periods.

---

## 9. Cursor and Selection Management

Cursor positions are tricky in a collaborative editor because other users' edits shift positions. The solution: represent cursors relative to character IDs, not integer positions.

```python
@dataclass
class Cursor:
    char_id: CharID      # Cursor is positioned after this character
    node_id: str         # Which user's cursor this is

    def to_position(self, doc: RGADocument) -> int:
        """Convert to a visible character position for rendering."""
        pos = 0
        for char in doc.chars:
            if char.id == self.char_id:
                return pos
            if not char.deleted:
                pos += 1
        return pos
```

When User B inserts a character before User A's cursor position:
- A's cursor is anchored to a CharID, not a position
- The CharID doesn't move — it's immutable
- A's cursor automatically adjusts to the correct visual position

Cursor positions are broadcast to other users for presence awareness (showing colored cursors), but they're not part of the CRDT — they're ephemeral state sent over the WebSocket.

---

## 10. Tombstone Garbage Collection

Deleted characters leave tombstones in the RGA. Over time, a heavily edited document accumulates thousands of tombstones that waste memory and slow down traversal.

Garbage collection is possible but requires coordination: a tombstone can only be removed if **every node** has processed the delete operation. Otherwise, a node that hasn't seen the delete might send an insert referencing the garbage-collected character.

```python
class TombstoneGC:
    def __init__(self, num_nodes):
        self.num_nodes = num_nodes

    def collect(self, doc: RGADocument, min_vc: Dict[str, int]):
        """Remove tombstones that all nodes have seen.

        min_vc is the component-wise minimum of all nodes' vector clocks.
        A tombstone from node X at timestamp T can be collected if
        min_vc[X] >= T (all nodes have processed operations up to T from X).
        """
        doc.chars = [
            char for char in doc.chars
            if not char.deleted
            or min_vc.get(char.id.node_id, 0) < char.id.timestamp
        ]
```

The server periodically collects the minimum vector clock from all connected clients and broadcasts it. Clients then garbage collect locally. Disconnected clients must catch up on operations before participating in GC.

---

## 11. Failure Scenarios

### Scenario 1: Message Reordering

User A's operations arrive at User B in the wrong order (op 3 arrives before op 2). The causal buffer holds op 3 until op 2 arrives, then delivers both in order. RGA produces the correct result.

### Scenario 2: Server Crashes

Operations in transit are lost. Clients detect the disconnection and buffer operations locally. When the server recovers (or fails over), clients resend buffered operations. Idempotency (each operation has a unique ID) prevents double-application.

### Scenario 3: Three-Way Concurrent Insert at Same Position

Users A, B, and C all type a character at the same cursor position simultaneously:

```
All three insert after character X:
  A inserts 'a' → id=(5, A), after=X
  B inserts 'b' → id=(5, B), after=X
  C inserts 'c' → id=(3, C), after=X
```

RGA's tie-breaking rule: among characters sharing the same `after` reference, higher IDs go first (leftmost). Sorting by `(timestamp desc, node_id desc)`:

```
(5, B) > (5, A) > (3, C)

Result: X b a c [rest of document]
```

Every node applies the same tie-breaking rule, so every node produces `Xbac`. The order is deterministic and consistent.

### Scenario 4: User Deletes a Character Another User Inserted After

```
User A: insert 'Y' after 'X'     → document: ...X Y...
User B: delete 'X'               → document: ...Y...  (X becomes tombstone)
```

User A's 'Y' has `after=X`. Even though X is now a tombstone, Y's position is still determined by X's position in the list. The tombstone remains in the list as an invisible anchor. The visible document shows 'Y' in the correct position relative to its non-deleted neighbors.

This is precisely why tombstones cannot be eagerly removed.

---

## 12. Comparison: OT vs CRDT for This System

| Dimension | OT (Google Docs Legacy) | CRDT (Our Design) |
|-----------|------------------------|-------------------|
| Coordination | Requires central server to serialize ops | No coordination needed |
| Offline editing | Complex — must transform against many missed ops | Natural — just merge op sets |
| Correctness proof | Notoriously hard (TP2 puzzle) | Straightforward (join-semilattice) |
| Metadata overhead | None (operations are position-based) | Each character carries a unique ID and tombstones accumulate |
| Memory usage | Lower (no tombstones) | Higher (tombstones until GC) |
| Peer-to-peer | Impractical (no central serializer) | Works naturally |
| Implementation complexity | High (transformation functions for every op pair) | Moderate (one integrate function) |

Modern collaborative editors increasingly choose CRDTs. Figma uses a CRDT for multiplayer. Apple Notes uses CRDTs. Automerge and Yjs are popular CRDT libraries for collaborative apps.

---

## 13. Summary

| Component | Technique | Chapter Reference |
|-----------|-----------|-------------------|
| Text representation | RGA (sequence CRDT) | Ch 28 |
| Character identity | Unique IDs (Lamport clock + node ID) | Ch 10 |
| Conflict resolution | Deterministic merge in `_integrate` | Ch 28 |
| Causal delivery | Vector clocks + causal buffer | Ch 11, Ch 12 |
| Offline support | Local-first with buffered ops | Ch 12 (eventual consistency) |
| Cursor tracking | Anchor to CharID, not position | — |
| Garbage collection | Tombstone removal when all nodes have caught up | Ch 11 (vector clock minimum) |
| Consistency model | Strong eventual consistency (causal+) | Ch 12 |

The collaborative editor achieves something remarkable: it provides a responsive, real-time editing experience with no coordination, no locking, and no central authority for conflict resolution. The CRDT does all the work — and the mathematical proof guarantees that it always works correctly, regardless of network conditions, concurrency patterns, or failure scenarios.

---

**Next**: [Capstone 4 — Distributed Log Service →](capstone04-distributed-log.md)
