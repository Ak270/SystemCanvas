# Chapter 18: Leaderless Replication and Quorum Reads/Writes

> **Core question**: What if every replica can accept writes? How does Dynamo-style replication work and what consistency does it actually provide?

**Prerequisites**: Failure Taxonomy (Ch 3), Vector Clocks (Ch 11), Consistency Models (Ch 12), Primary-Backup Replication (Ch 17)

---

## The Problem with Leaders

Primary-backup replication (Chapter 17) has a single point of coordination: the primary. Every write flows through it. If the primary fails, the system goes through a failover process — seconds to minutes of write unavailability.

What if there were no leader at all? What if *any* replica could accept *any* write?

This is **leaderless replication**, pioneered by Amazon's Dynamo paper (2007) and adopted by systems like Apache Cassandra, Riak, and Voldemort. The DynamoDB managed service also traces its lineage here, though Amazon's current implementation diverges from the original paper.

The trade-off is stark: by removing the leader, you gain availability (no failover needed — any node can serve writes) but lose the simple consistency guarantees that a single leader provides. The rest of this chapter is about what you gain, what you lose, and the precise mechanisms that manage the trade-off.

---

## The Architecture

In a leaderless system, there is no distinction between "primary" and "backup." Every node is a peer. A client sends writes and reads to **multiple** nodes simultaneously.

```
         ┌─────────┐
         │ Client  │
         └────┬────┘
              │
     ┌────────┼────────┐
     │        │        │
     ▼        ▼        ▼
┌────────┐ ┌────────┐ ┌────────┐
│ Node 1 │ │ Node 2 │ │ Node 3 │
│  (peer)│ │  (peer)│ │  (peer)│
└────────┘ └────────┘ └────────┘
```

There is no replication stream from a leader to followers. Instead, the client (or a coordinator node acting on the client's behalf) manages consistency by writing to and reading from multiple nodes.

---

## The Quorum Protocol

The core mechanism is the **quorum**: a minimum number of nodes that must participate in a read or write for the operation to succeed.

Given:
- **N** = total number of replicas for a key
- **W** = number of nodes that must acknowledge a write (write quorum)
- **R** = number of nodes that must respond to a read (read quorum)

The fundamental rule:

```
W + R > N
```

If this inequality holds, every read is guaranteed to see at least one node that has the latest write. The read and write sets must overlap.

### Why This Works

Suppose N=3, W=2, R=2.

When you write a value `v`, at least 2 of the 3 nodes store it. When you read, you contact at least 2 of the 3 nodes. By the pigeonhole principle, at least one node in your read set must also be in the write set — so at least one response will contain `v`.

```
Write v to nodes {1, 2}         Read from nodes {2, 3}
                                
Node 1: has v    ─── ─── ───    Node 1: (not contacted)
Node 2: has v    ─── ─── ───    Node 2: has v  ◀── overlap!
Node 3: (missed) ─── ─── ───    Node 3: old value

The read sees v from Node 2 and picks it as the most recent.
```

But notice: Node 3 still has the old value. The system is not immediately consistent. The client must determine which response is "newest" — this requires a mechanism to compare versions (timestamps, vector clocks, or version numbers).

### Common Quorum Configurations

| N | W | R | W+R | Trade-off |
|---|---|---|-----|-----------|
| 3 | 2 | 2 | 4 > 3 | Balanced. Tolerates 1 node failure for both reads and writes. |
| 3 | 3 | 1 | 4 > 3 | Fast reads (contact 1 node). Writes need all nodes — any failure blocks writes. |
| 3 | 1 | 3 | 4 > 3 | Fast writes (contact 1 node). Reads must contact all nodes. Writes tolerate 2 failures, reads tolerate 0. |
| 5 | 3 | 3 | 6 > 5 | Tolerates 2 node failures. Common for systems needing higher fault tolerance. |

### The Write Path

A client writing a key-value pair `(k, v)`:

```
Client:
  1. Determine which N nodes store key k (via consistent hashing)
  2. Send write(k, v, version) to all N nodes in parallel
  3. Wait for W acknowledgments
  4. If W acks received → return success to caller
  5. If fewer than W acks within timeout → return failure
```

```
Time ──────────────────────────────────────────────────────────▶

Client          Node 1           Node 2           Node 3
  │                │                │                │
  │── write(k,v) ─▶│                │                │
  │── write(k,v) ──────────────────▶│                │
  │── write(k,v) ──────────────────────────────────▶│
  │                │                │                │
  │◀── ACK ────────│                │                │
  │◀── ACK ──────────────────────── │                │
  │                │                │                │
  │ (W=2 acks received, return success)              │
  │                │                │                │
  │                │                │  ◀── ACK (late, but node stores it)
```

Important: the write is sent to all N nodes, not just W. The W threshold determines when the client considers the write successful, not how many nodes receive it. Nodes that respond after the client's timeout still store the value.

### The Read Path

A client reading key `k`:

```
Client:
  1. Send read(k) to all N nodes in parallel
  2. Wait for R responses
  3. Among the R responses, pick the one with the highest version
  4. Return that value to the caller
```

```
Time ──────────────────────────────────────────────────────────▶

Client          Node 1           Node 2           Node 3
  │                │                │                │
  │── read(k) ────▶│                │                │
  │── read(k) ─────────────────────▶│                │
  │── read(k) ─────────────────────────────────────▶│
  │                │                │                │
  │◀── (k, v2) ───│                │                │
  │◀── (k, v1) ──────────────────── │                │
  │                │                │                │
  │ (R=2 responses received)        │                │
  │ v2 > v1, so return v2           │                │
```

The "highest version" comparison needs a version scheme. The simplest is a monotonically increasing counter (each write increments it). More sophisticated systems use vector clocks (Chapter 11) to detect concurrent writes that can't be ordered.

---

## Version Conflict Resolution

When two clients write to the same key on different nodes concurrently, the quorum protocol doesn't prevent both writes from succeeding. Consider:

```
Client A writes k=1 to Nodes {1, 2}     (version 5)
Client B writes k=2 to Nodes {2, 3}     (version 5... or is it 6?)
```

Both writes succeed (W=2 for both). Node 2 received both writes. What value does Node 2 store?

This depends on the conflict resolution strategy:

### Last-Writer-Wins (LWW)

Each write carries a physical timestamp. The write with the later timestamp wins. If Client B's clock is ahead of Client A's, k=2 wins on all nodes.

```python
def handle_write(key, value, timestamp):
    current = store.get(key)
    if current is None or timestamp > current.timestamp:
        store.put(key, value, timestamp)
        return ACK
    else:
        # Ignore: this write is older
        return ACK  # Still ack — the client doesn't need to know
```

**Problem**: LWW silently drops writes. Client A's write (k=1) is gone — no record of it ever existed. If both writes were valid (e.g., two users adding different items to a shopping cart), one user's item disappears.

**Worse problem**: Physical timestamps depend on clock synchronization (Chapter 9). If clocks are skewed, the "later" timestamp might not correspond to the actually-later event. A write from a node with a fast clock always wins, regardless of actual ordering.

Cassandra uses LWW by default. This is why Cassandra's documentation warns: "last-write-wins conflict resolution means that deletes can be 'undone' if a delayed write arrives with a timestamp newer than the delete."

### Siblings (Multi-Value)

Keep all concurrent versions and let the application resolve the conflict. When a read returns multiple versions (called **siblings**), the application must merge them and write the result back.

```
Node 2's storage for key k:
  siblings: [
    {value: 1, vclock: [A:1, B:0]},
    {value: 2, vclock: [A:0, B:1]}
  ]

Client reads k from Node 2:
  → receives both siblings
  → application merges: merged_value = resolve(1, 2)
  → client writes merged_value with a new vclock that dominates both
```

This is what the original Dynamo paper proposed. The famous example: a shopping cart where two concurrent writes add different items. The merge function is set union — the merged cart contains both items.

**Problem**: Application developers must write correct merge functions. If they don't, or if the merge function is wrong, data is lost or corrupted. In practice, most applications treat siblings as an error condition and pick one arbitrarily — which is just LWW with extra steps.

Riak supports siblings natively and provides a rich API for conflict resolution. DynamoDB eliminated client-visible siblings in favor of a conditional write model.

---

## Sloppy Quorums and Hinted Handoff

The strict quorum rule (W + R > N) guarantees read-your-writes consistency... among the designated N nodes. But what happens when some of those N nodes are unreachable?

### The Problem

Suppose key `k` is replicated on Nodes {1, 2, 3} and W=2. If Nodes 2 and 3 are down, the write can only reach Node 1 — that's fewer than W=2. The write fails.

```
Client ── write(k,v) ──▶ Node 1  ✓ ACK
Client ── write(k,v) ──▶ Node 2  ✗ unreachable
Client ── write(k,v) ──▶ Node 3  ✗ unreachable

Only 1 ACK < W=2. Write fails.
```

Strict quorums sacrifice availability for consistency. During a network partition that isolates 2 of 3 nodes, the system cannot accept writes for keys stored on those nodes.

### Sloppy Quorum

A **sloppy quorum** relaxes the rule: if the designated nodes are unavailable, the system can send the write to *other* nodes in the cluster that aren't the normal owners of this key.

```
Client ── write(k,v) ──▶ Node 1  ✓ ACK (normal home)
Client ── write(k,v) ──▶ Node 2  ✗ unreachable
Client ── write(k,v) ──▶ Node 4  ✓ ACK (temporary home, not in k's replica set)

W=2 acks received. Write succeeds.
```

The write succeeds because 2 nodes acknowledged it — even though one of them (Node 4) is not a normal replica for this key.

### Hinted Handoff

Node 4 stores the value with a **hint**: "this value belongs on Node 2. When Node 2 comes back, send it there."

```
Node 4's storage:
  key: k
  value: v
  hint: "intended for Node 2"
  
When Node 2 recovers:
  Node 4 ── "here's a value that belongs to you" ──▶ Node 2
  Node 2 stores the value
  Node 4 deletes the hinted copy
```

**The crucial implication**: Sloppy quorums do **not** guarantee that W + R > N among the *actual* replicas. A read of key `k` contacts Nodes {1, 2, 3} — but the latest write is on Node 4 (which the read doesn't contact). The read returns stale data.

```
After sloppy quorum write:
  Node 1: has v (latest)
  Node 2: down (doesn't have v)
  Node 3: has v_old
  Node 4: has v (hinted, not contacted by reads)

Read with R=2 contacts Nodes {1, 3}:
  Node 1: returns v (latest)
  Node 3: returns v_old
  → Client picks v (correct, but only by luck that Node 1 was in the read set)

Read with R=2 contacts Nodes {2, 3}:
  Node 2: still down
  Node 3: returns v_old
  → If Node 2 is down and we fall back to another node, we might miss v entirely
```

Sloppy quorums provide **higher availability** (writes succeed even when normal replicas are down) at the cost of **weaker consistency** (reads may not see the latest value).

Dynamo and Cassandra both support sloppy quorums. Cassandra calls it "hinted handoff" and enables it by default.

---

## Read Repair and Anti-Entropy

Even with strict quorums, some replicas will have stale data. Two mechanisms bring replicas back in sync:

### Read Repair

When a read returns responses from R nodes and they disagree, the client (or coordinator) sends the latest value to the stale nodes.

```
Read from Nodes {1, 2, 3}:
  Node 1: returns (k, v2, version=2)
  Node 2: returns (k, v1, version=1)  ◀── stale!
  Node 3: returns (k, v2, version=2)

Coordinator:
  1. Return v2 to client (highest version)
  2. Send write(k, v2, version=2) to Node 2  ◀── read repair
```

Read repair is **lazy** — it only fixes staleness when the key is actually read. Keys that are never read stay stale forever.

Read repair works well for frequently-read keys. For rarely-read keys, you need anti-entropy.

### Anti-Entropy (Background Repair)

A background process continuously compares data across replicas and fixes discrepancies.

The most common implementation uses **Merkle trees** (hash trees):

```
Each node maintains a Merkle tree over its key range:

           root_hash
          /          \
     hash_AB        hash_CD
     /    \         /    \
  hash_A  hash_B  hash_C  hash_D
    |       |       |       |
  key_A   key_B   key_C   key_D
```

To compare two nodes:
1. Compare root hashes. If equal, all data matches — done.
2. If different, compare left and right child hashes.
3. Recurse into the subtree that differs.
4. At the leaf level, exchange and reconcile the differing keys.

This is O(log N) comparisons to find the differing keys among N total keys — far more efficient than comparing every key.

Cassandra runs anti-entropy repair as the `nodetool repair` command. It's essential for maintaining consistency but expensive — it reads every key and computes hashes. Most operators run it weekly or daily on a rolling basis.

---

## What Consistency Do Quorums Actually Provide?

A common claim: "Quorum reads/writes with W + R > N provide strong consistency." This is **wrong** in the general case.

Strict quorums guarantee that a read *contacts* at least one node with the latest value. But that is not the same as linearizability (Chapter 13). Here's why:

### Race Condition 1: Concurrent Reads During a Write

```
Time ──────────────────────────────────────────────────────────▶

Writer                Node 1           Node 2           Node 3
  │                      │                │                │
  │── write(k, v2) ─────▶│ (stores v2)    │                │
  │── write(k, v2) ──────────────────────▶│ (stores v2)    │
  │── write(k, v2) ──────────────────────────────────────▶│
  │                      │                │         (hasn't arrived)
  │                      │                │                │

Reader A (contacts Nodes 1, 2):  sees v2 from both  → returns v2
Reader B (contacts Nodes 2, 3):  sees v2 from 2, v1 from 3  → returns v2
Reader C (contacts Nodes 1, 3):  sees v2 from 1, v1 from 3  → returns v2

All readers see v2. So far so good.

But what if the timing is slightly different?

Writer                Node 1           Node 2           Node 3
  │── write(k, v2) ─────▶│ (stores v2)    │                │
  │                      │                │                │

Reader X (contacts Nodes 2, 3):  sees v1 from both  → returns v1
...
Writer's write reaches Node 2    │
  │◀── ACK ──────────────────────│                         │
  │◀── ACK ──────────────────────────────────────────────│

Reader Y (contacts Nodes 1, 2):  sees v2 from both  → returns v2
```

Reader X sees v1 (old), then Reader Y sees v2 (new). That's fine — the write hadn't completed when X read. But now:

```
Reader Z (contacts Nodes 1, 3): sees v2 from 1, v1 from 3 → returns v2

Then ANOTHER reader W (contacts Nodes 2, 3): 
  Node 2 hasn't received write yet (network is slow)
  sees v1 from both → returns v1!
```

Reader Z saw v2, then Reader W (later in real time) sees v1. Time went backward. This is **not linearizable**.

### Race Condition 2: Partial Writes

A write to N=3 with W=2 succeeds when 2 nodes acknowledge. But if the write to the 3rd node fails, that node has stale data. A subsequent read with R=2 might contact that stale node and one other stale node (if, say, the 2nd node also lost the value due to a restart).

### What Quorums Actually Guarantee

With strict quorums (W + R > N) and no concurrent operations:
- **Regular register semantics**: A read that starts after a write completes will return the latest value.

With concurrent operations:
- A read may return either the old or new value — the system doesn't guarantee which.
- Different concurrent readers may see different values.
- Values don't necessarily converge to the same order across readers.

This is weaker than linearizability. It's roughly **eventual consistency** with a bounded staleness window (bounded by the time for reads and writes to complete).

To get linearizability from a quorum system, you need additional mechanisms:
- **Read-before-write** (Raft's approach): Before accepting a write, read from a quorum to ensure no conflicting write is in progress.
- **Conditional writes** (compare-and-swap): Only write if the current version matches what you expect.
- **Consensus protocol**: Use Raft or Paxos to agree on an ordering of writes.

At that point, you've essentially reinvented a consensus-based system — defeating the purpose of leaderless replication.

---

## Dynamo-Style Architecture in Detail

The original Dynamo paper (DeCandia et al., 2007) described the complete architecture that combines these mechanisms. Let's trace a request through the full system.

### Consistent Hashing and Preference Lists

Keys are mapped to nodes using **consistent hashing** (covered in the System Design book — we link, not repeat). Each key's **preference list** is the ordered list of N nodes responsible for it.

```
Hash ring with nodes A, B, C, D, E:

         A
       /   \
      E     B
       \   /
        D-C

Key k hashes to position between A and B.
Preference list for k (N=3): [B, C, D]
  (B is the coordinator, C and D are replicas)
```

### Coordinator Node

The client sends its request to any node. That node becomes the **coordinator** for this request. The coordinator determines the preference list and forwards the request to the appropriate replicas.

```
Client ── write(k, v) ──▶ Node A (any node)

Node A (coordinator):
  1. Hash k → position on ring
  2. Look up preference list: [B, C, D]
  3. Forward write to B, C, D
  4. Wait for W acks
  5. Return result to client
```

If the coordinator itself is in the preference list, it handles one of the replicas locally without a network hop.

### Put (Write) Operation

```python
def put(key, value, context):
    # context contains the vector clock from a previous read
    nodes = get_preference_list(key, N)
    
    # Generate new version
    new_vclock = increment_vclock(context.vclock, self.node_id)
    versioned_value = (value, new_vclock)
    
    # Send to all N nodes
    acks = 0
    for node in nodes:
        try:
            node.store(key, versioned_value)
            acks += 1
        except Timeout:
            # Try next node in ring (sloppy quorum)
            next_node = get_next_healthy_node(nodes)
            next_node.store_with_hint(key, versioned_value, hint=node)
            acks += 1
    
    if acks >= W:
        return SUCCESS
    else:
        return FAILURE
```

### Get (Read) Operation

```python
def get(key):
    nodes = get_preference_list(key, N)
    
    # Send to all N nodes
    responses = []
    for node in nodes:
        try:
            response = node.fetch(key)
            responses.append(response)
        except Timeout:
            pass
        if len(responses) >= R:
            break
    
    if len(responses) < R:
        return FAILURE
    
    # Reconcile versions
    latest = reconcile(responses)
    
    # Read repair: send latest to stale nodes
    for resp in responses:
        if resp.vclock < latest.vclock:
            resp.node.store(key, latest)
    
    return latest
```

The `reconcile` function compares vector clocks:
- If one version dominates another (happens-before), pick the dominating version.
- If versions are concurrent (neither dominates), return both as siblings — the application must resolve the conflict.

---

## Tunable Consistency

The power of the quorum approach is that W and R are **tunable per request**. Different operations can use different consistency levels.

### Cassandra Consistency Levels

Cassandra exposes this directly to the application:

```sql
-- Strong consistency: W + R > N
INSERT INTO users (id, name) VALUES (1, 'Alice')
  USING CONSISTENCY QUORUM;  -- W = ⌊N/2⌋ + 1

SELECT * FROM users WHERE id = 1
  USING CONSISTENCY QUORUM;  -- R = ⌊N/2⌋ + 1

-- High availability, weak consistency
INSERT INTO logs (ts, msg) VALUES (now(), 'event')
  USING CONSISTENCY ONE;     -- W = 1

-- Maximum consistency (but lowest availability)
SELECT * FROM users WHERE id = 1
  USING CONSISTENCY ALL;     -- R = N
```

| Cassandra Level | W or R value | Use case |
|-----------------|-------------|----------|
| `ONE` | 1 | Logs, metrics — availability over consistency |
| `QUORUM` | ⌊N/2⌋ + 1 | Most application data — balanced |
| `LOCAL_QUORUM` | ⌊N_local/2⌋ + 1 | Multi-datacenter — quorum within the local DC |
| `ALL` | N | Critical data — all replicas must respond |
| `ANY` | 1 (including hinted handoff nodes) | Fire-and-forget writes — maximum availability |

### The Danger of `ANY`

Cassandra's `ANY` consistency level accepts a write even if it only reaches a hinted handoff node — not any of the actual replicas. A subsequent `QUORUM` read won't see it until hinted handoff delivers it. This can produce surprising staleness.

---

## The Coordinator Problem

In Dynamo-style systems, the coordinator is a single point of failure for each request. If the coordinator crashes after forwarding the write to some replicas but before all W acks arrive, the client sees a failure — but some replicas may have stored the value.

```
Client ── write(k,v) ──▶ Coordinator
Coordinator ── write ──▶ Node 1  ✓
Coordinator ── write ──▶ Node 2  (in flight)
Coordinator CRASHES

Client: write failed
Node 1: has v
Node 2: might or might not have v
```

The client retries, possibly to a different coordinator. If the value has a unique version (vector clock), the retry is safe — it's either idempotent (if the version already exists) or creates a new concurrent version (if it doesn't).

This is why vector clocks are essential: they make retries safe in the face of partial failures.

---

## Handling Node Failures

### Temporary Failures

For short outages (a node restarts, a brief network glitch):
- **Sloppy quorums** keep writes available during the outage.
- **Hinted handoff** delivers missed writes when the node recovers.
- **Read repair** fixes staleness on the next read.

### Permanent Failures

When a node is permanently removed (disk failure, decommission):
- The system detects the failure (gossip protocol, admin command).
- The node's key ranges are reassigned to other nodes.
- Data is re-replicated to maintain the replication factor.

Cassandra calls this process `removenode` (clean decommission) or `assassinate` (forced removal of an unresponsive node).

### Adding Nodes

When a new node joins:
- It's assigned a position on the hash ring.
- It receives data for its key ranges from existing nodes.
- During the transfer, reads and writes continue — existing nodes handle requests for the transferring ranges until the new node catches up.

Cassandra calls this `bootstrap`. The process can take hours for large datasets, and the cluster operates at reduced capacity during the transfer.

---

## Limitations of Leaderless Replication

### 1. No Global Ordering

Without a leader to serialize writes, there is no total order on operations. Two concurrent writes to the same key produce divergent state that must be reconciled — either by the application (siblings) or by lossy conflict resolution (LWW).

This makes leaderless systems unsuitable for:
- **Counters**: Two concurrent `increment` operations may only count once (both read the same base value and write base+1).
- **Conditional updates**: "Set status to SHIPPED only if current status is PACKED" — two nodes may both see PACKED and both set SHIPPED, even if only one should.
- **Anything requiring linearizable compare-and-swap**.

### 2. Stale Reads During Failures

During a node failure, reads with R < N may miss the latest write (stored on the failed node). The quorum guarantee only holds when all N nodes are reachable.

### 3. Clock Dependence (for LWW)

Last-writer-wins requires accurate clocks across all nodes. Clock skew (Chapter 9) can cause the "wrong" write to win. The Dynamo paper acknowledged this and used vector clocks instead, but many Dynamo-inspired systems (Cassandra) defaulted to LWW for simplicity.

### 4. Tail Latency

Both reads and writes must wait for the Wth or Rth response. The latency is determined by the slowest of the W or R nodes, not the fastest. With W=2, R=2, and N=3, you wait for the 2nd-fastest node — which is typically close to the median. But with N=5, W=3, you wait for the 3rd-fastest, which can be significantly worse.

### 5. Anti-Entropy Overhead

Maintaining consistency across replicas requires continuous background work (Merkle tree computation, data streaming, tombstone management). This consumes CPU, memory, disk I/O, and network bandwidth. In large clusters, anti-entropy can be the dominant operational cost.

---

## Tombstones and Deletes

Deletes are surprisingly hard in leaderless systems. You can't simply remove a key — if you delete it from 2 of 3 nodes, the 3rd node still has it, and the next read repair will *restore* the deleted value.

Instead, deletes use **tombstones**: a special marker that says "this key has been deleted."

```
DELETE k:
  → Write a tombstone: {key: k, value: TOMBSTONE, version: v+1}
  → The tombstone propagates like any other write
  → When a node sees the tombstone, it knows to return "not found"
```

Tombstones must be retained long enough for all replicas to receive them. If a tombstone is garbage-collected before a stale replica sees it, the stale replica's old value will resurface — this is called a **zombie** or **ghost resurrection**.

Cassandra uses a configurable `gc_grace_seconds` (default 10 days) — tombstones are kept for this duration. If a node is down for longer than `gc_grace_seconds`, it must be fully rebuilt from other replicas, or it will resurrect deleted data.

---

## Real-World Systems

### Apache Cassandra

Cassandra is the most widely deployed Dynamo-style database. Key characteristics:
- Consistent hashing with virtual nodes (vnodes)
- Tunable consistency (ONE, QUORUM, ALL, etc.) per query
- LWW conflict resolution by default (vector clocks were considered too complex for application developers)
- Merkle tree anti-entropy via `nodetool repair`
- Lightweight transactions (LWT) via Paxos for linearizable operations (slow — 4 round trips)

### Riak

Riak is the most faithful implementation of the Dynamo paper:
- Vector clocks for conflict detection
- Siblings returned to the application for resolution
- CRDTs built in (counters, sets, maps) for automatic conflict resolution
- Merkle tree anti-entropy (called "active anti-entropy")

Riak was discontinued as a commercial product but remains open source.

### Amazon DynamoDB

Despite the name, DynamoDB is not a Dynamo-style leaderless system internally. It uses a primary-backup model with Paxos-based leader election. The leaderless heritage shows in the API (conditional writes, eventually consistent reads) but the internals are closer to a partitioned, consensus-backed system.

DynamoDB offers two consistency options per read:
- **Eventually consistent read**: May return stale data. Lower latency and cost.
- **Strongly consistent read**: Returns the latest committed value. Higher latency.

---

## When to Use Leaderless Replication

**Good fit**:
- High write throughput across many keys (no single-key bottleneck)
- Availability is more important than strict consistency
- Multi-datacenter deployment where cross-datacenter latency makes synchronous replication impractical
- Append-only or immutable data (no conflicts to resolve)
- Applications that can implement correct merge functions for concurrent writes

**Bad fit**:
- Transactions across multiple keys
- Strict ordering requirements (counters, sequences, queues)
- Applications where losing writes (LWW) is unacceptable and developers can't write merge functions
- Small datasets that fit on one machine (leaderless adds complexity without benefit)

---

## Key Takeaways

1. **Quorums (W + R > N) guarantee overlap, not linearizability.** A read contacts at least one node with the latest value, but concurrent operations can still produce anomalies.

2. **Sloppy quorums trade consistency for availability.** Writes succeed even when normal replicas are down, but reads may not see the latest value until hinted handoff completes.

3. **Conflict resolution is the hard problem.** LWW loses data silently. Siblings push complexity to the application. CRDTs (Chapter 28) automate resolution for certain data structures.

4. **Anti-entropy is not optional.** Without periodic full-cluster repair, replicas drift apart. Read repair only fixes frequently-read keys.

5. **Deletes require tombstones.** A naïve delete causes zombie data resurrection. Tombstones must be retained long enough for all replicas to converge.

6. **Leaderless replication is a tool for high-availability, high-throughput systems** that can tolerate eventual consistency. It is not a general-purpose replacement for primary-backup replication.

---

## References

- DeCandia, G., et al. (2007). "Dynamo: Amazon's Highly Available Key-Value Store." *SOSP*.
- Lakshman, A. & Malik, P. (2010). "Cassandra: A Decentralized Structured Storage System." *LADIS*.
- Shapiro, M., et al. (2011). "Conflict-free Replicated Data Types." *SSS*.
- Kleppmann, M. (2017). *Designing Data-Intensive Applications*, Chapter 5. O'Reilly.
- Bailis, P. & Ghodsi, A. (2013). "Eventual Consistency Today: Limitations, Extensions, and Beyond." *ACM Queue*.
- Attiya, H., Bar-Noy, A., & Dolev, D. (1995). "Sharing Memory Robustly in Message-Passing Systems." *JACM*.

---

**Next**: [Chapter 19: Chain Replication →](ch19-chain-replication.md)
