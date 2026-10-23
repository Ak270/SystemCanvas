# Chapter 19: Chain Replication

> *Is there a cleaner, more formally verifiable alternative to Paxos for building replicated storage?*

**Prerequisites**: Chapter 17 (Primary-Backup Replication), Chapter 12 (Consistency Models), Chapter 13 (Linearizability)

---

## The Problem with Primary-Backup

In Chapter 17, we studied primary-backup replication. A single primary accepts all writes, replicates them to backups, and serves reads. It works, but it has a structural tension:

1. **The primary is a bottleneck.** It handles all writes *and* all reads. If you want strong consistency, the primary must serialize everything.
2. **Failover is complex.** When the primary dies, a backup must take over. Determining which backup has the most up-to-date state — and ensuring no committed writes are lost — requires careful protocol design.
3. **The protocol is hard to verify formally.** The interaction between writes, acknowledgments, and failover creates many edge cases.

In 2004, Robbert van Renesse and Fred Schneider proposed a remarkably elegant alternative: **chain replication**. Instead of one node doing everything, arrange replicas in a chain and split responsibilities between the head and the tail.

---

## The Core Idea

Arrange all replicas of an object in a linear chain:

```
  Writes enter here                              Reads served here
       │                                               │
       ▼                                               ▼
  ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
  │  HEAD    │────▶│  Node 2 │────▶│  Node 3 │────▶│  TAIL   │
  │ (write)  │     │         │     │         │     │ (read)  │
  └─────────┘     └─────────┘     └─────────┘     └─────────┘
```

The rules are:
- **Writes** go to the **head** of the chain
- The head applies the write locally, then forwards it to the next node
- Each node applies the write locally, then forwards it to the next node
- When the write reaches the **tail**, the tail applies it and sends an **acknowledgment** back to the client
- **Reads** go to the **tail** and are served immediately

That's it. The entire protocol.

---

## Why This Works: Strong Consistency for Free

The tail has a crucial property: **it has seen every write that has been acknowledged to any client, and no write that hasn't been acknowledged yet.**

Think about what this means:

1. A write isn't acknowledged until it reaches the tail. So any acknowledged write is in the tail's state.
2. Writes propagate in order along the chain. The tail sees them in the same order the head does.
3. Reads are served only by the tail. So every read sees every previously acknowledged write.

This gives you **linearizability** — the strongest consistency guarantee — without any special coordination protocol between the read path and the write path. The chain topology itself enforces it.

Compare this to primary-backup, where the primary must carefully track which writes have been acknowledged to which backups, and reads must be routed to a node that has all acknowledged writes. Chain replication separates concerns more cleanly.

---

## The Write Protocol in Detail

Let's trace a write operation step by step through a 4-node chain.

### Step 1: Client Sends Write to Head

```
Client ──write(k, v)──▶ HEAD
```

The client knows the identity of the head (we'll discuss how shortly). It sends the write request directly to the head.

### Step 2: Head Applies and Forwards

```
HEAD                    Node 2         Node 3         TAIL
  │                       │              │              │
  │ apply(k, v)           │              │              │
  │ locally               │              │              │
  │                       │              │              │
  ├──forward(k, v)───────▶│              │              │
  │                       │              │              │
```

The head applies the write to its local storage, then sends the update to the next node in the chain. The head does *not* acknowledge the write to the client — that's the tail's job.

### Step 3: Propagation Down the Chain

```
HEAD                    Node 2         Node 3         TAIL
  │                       │              │              │
  │                       │ apply(k, v)  │              │
  │                       │ locally      │              │
  │                       │              │              │
  │                       ├──forward────▶│              │
  │                       │              │              │
  │                       │              │ apply(k, v)  │
  │                       │              │ locally      │
  │                       │              │              │
  │                       │              ├──forward────▶│
  │                       │              │              │
```

Each intermediate node applies the write locally and forwards it to the next node. This is a simple, mechanical process — no voting, no quorum logic, no two-phase protocol.

### Step 4: Tail Acknowledges

```
HEAD                    Node 2         Node 3         TAIL
  │                       │              │              │
  │                       │              │              │ apply(k, v)
  │                       │              │              │ locally
  │                       │              │              │
  │                       │              │              ├──ack──▶ Client
  │                       │              │              │
```

The tail applies the write and sends the acknowledgment directly to the client. The write is now committed.

### The State Invariant

At any point in time, every node in the chain has a state that is a **prefix** of the head's state. The head has applied the most writes, the tail has applied the fewest (only those that have propagated all the way through). Every intermediate node is somewhere in between.

```
HEAD state:   [w1, w2, w3, w4, w5, w6]     ← has applied everything
Node 2 state: [w1, w2, w3, w4, w5]         ← one behind
Node 3 state: [w1, w2, w3, w4]             ← two behind
TAIL state:   [w1, w2, w3]                 ← only committed writes

Committed (acknowledged to client): w1, w2, w3
Pending (in-flight):                w4, w5, w6
```

This prefix property is what makes the protocol so clean. There's no ambiguity about which writes have been committed — it's exactly the set of writes the tail has applied.

---

## The Read Protocol

Reads are sent to the tail and served immediately:

```
Client ──read(k)──▶ TAIL
                      │
                      │  look up k in local state
                      │
TAIL ──value(v)──────▶ Client
```

Because the tail's state contains exactly the committed writes (and nothing else), every read returns a value consistent with all previously acknowledged writes. The read never needs to contact any other node.

This is a profound simplification. In primary-backup, reads either go to the primary (which creates a bottleneck) or go to backups (which may serve stale data). In chain replication, reads go to the tail and are always consistent — by construction.

---

## Formal Consistency Argument

Let's be precise about why chain replication provides linearizability.

**Definition reminder** (from Chapter 13): A history is linearizable if every operation can be assigned a **linearization point** within its real-time interval such that the sequential history defined by those points is legal (i.e., every read returns the value of the most recent write).

For chain replication:
- **Write operations**: The linearization point is when the tail applies the write. This is within the operation's real-time interval (after the client sent it, before the client received the ack).
- **Read operations**: The linearization point is when the tail serves the read. Since the tail's state reflects exactly the committed writes in order, the read returns the value of the most recent committed write.

Because both linearization points occur at the tail, and the tail processes operations in a sequential order, the resulting history is trivially a legal sequential history.

This is why chain replication's correctness proof is so much simpler than Paxos's. The linearization point for every operation is at the same node (the tail), whereas in Paxos, different operations may be decided by different leaders across different terms.

---

## Failure Handling

The elegance of chain replication's normal-case protocol comes at a cost: failure handling requires an external **configuration manager** — sometimes called the **master** or **control plane**. This component monitors the health of chain nodes and reconfigures the chain when nodes fail.

The configuration manager itself must be fault-tolerant (typically implemented using Paxos or Raft), but the key insight is that the *data path* (reads and writes) is simple, and only the *control path* (reconfiguration) is complex.

### Head Failure

When the head fails, the configuration manager removes it from the chain and promotes the next node to head:

```
Before:
  HEAD ──▶ Node 2 ──▶ Node 3 ──▶ TAIL
   ✗ (crashed)

After:
           HEAD    ──▶ Node 3 ──▶ TAIL
          (was Node 2)
```

**What about in-flight writes?** Remember the prefix property. Node 2 has applied every write that the head applied *except possibly the last one or few*. Any write that hasn't reached Node 2 yet was never committed (the tail never saw it), so the client will time out and retry.

More precisely:
- Writes that the head forwarded to Node 2 before crashing: These will continue propagating down the chain. If they reach the tail, they'll be committed normally.
- Writes that the head applied locally but hadn't forwarded yet: These are lost. But they were never committed, so no client was told they succeeded. The client's timeout will trigger a retry.

**No committed writes are lost.** Any write the tail acknowledged was already at every node in the chain (including the new head).

### Tail Failure

When the tail fails, the configuration manager removes it and makes the predecessor the new tail:

```
Before:
  HEAD ──▶ Node 2 ──▶ Node 3 ──▶ TAIL
                                    ✗ (crashed)

After:
  HEAD ──▶ Node 2 ──▶ TAIL
                     (was Node 3)
```

The new tail's state is a superset of the old tail's committed state (because the new tail received writes before the old tail did, and the old tail had to have acknowledged everything the new tail has). So the new tail may have some writes that the old tail hadn't acknowledged yet. Those writes are now committed (they're in the new tail's state), which is safe — the clients were still waiting for acknowledgment and will now receive it.

**Reads remain consistent.** The new tail has all committed writes plus possibly a few extra ones. Reads from the new tail might see slightly "more recent" state than the old tail would have served, but this is consistent with linearizability (the writes' linearization points just moved slightly earlier).

### Middle Node Failure

When an intermediate node fails, the configuration manager splices it out:

```
Before:
  HEAD ──▶ Node 2 ──▶ Node 3 ──▶ TAIL
              ✗ (crashed)

After:
  HEAD ──────────────▶ Node 3 ──▶ TAIL
```

This is the trickiest case. The problem: Node 2 may have applied some writes that it hadn't yet forwarded to Node 3. Those writes are now "stuck" — they're in the head's state but not in Node 3's state.

The solution: the configuration manager tells the head to resend all writes that Node 3 hasn't acknowledged. In practice, each node keeps track of which writes it has forwarded, so the head can determine the gap and fill it.

More specifically, each node `i` in the chain maintains:

- **Hist_i**: the list of updates applied at node `i`
- **Sent_i**: the list of updates that node `i` has forwarded to its successor

When node `j` (the failed node's successor) is linked to node `i` (the failed node's predecessor), node `i` sends all updates in `Hist_i` that are not in `Sent_j-1` (i.e., not yet received by `j`).

### The Configuration Manager

The configuration manager must:
1. **Detect failures** — typically using heartbeats and a failure detector (Ch 7–8)
2. **Reconfigure the chain** — update the chain membership and notify relevant nodes
3. **Be fault-tolerant itself** — if the configuration manager dies, the chain can still serve reads and writes (it just can't handle further failures until the manager recovers)

The configuration manager is typically a Paxos or Raft group (3 or 5 nodes). This seems like it brings us back to the complexity of consensus. But there's a crucial difference: **the consensus protocol runs on the control plane only, not the data plane.** The configuration manager handles rare events (node failures), not every read and write. The data path remains simple.

```
                    ┌────────────────────────┐
                    │  Configuration Manager │
                    │   (Paxos/Raft group)   │
                    └───┬────────┬───────┬───┘
                        │        │       │
                   monitors  monitors  monitors
                        │        │       │
                        ▼        ▼       ▼
                      HEAD ──▶ Node ──▶ TAIL
                        │                 │
                   writes enter      reads served
                        │            acks sent
                        ▼                │
                      Client ◀───────────┘
```

---

## Performance Characteristics

### Write Latency

A write must traverse the entire chain before being acknowledged. With a chain of length `N` and network round-trip time `d` between consecutive nodes:

```
Write latency = N × d + processing time at each node
```

For a 3-node chain with 1ms network hops: write latency ≈ 3ms.

This is **higher** than primary-backup with synchronous replication to one backup (which is about 2 × d), because the write must visit every node sequentially rather than being sent in parallel.

### Read Latency

A read is served by the tail with a single network round trip:

```
Read latency = 1 × RTT to tail + processing time
```

This is the same as reading from a single server. Reads are fast.

### Throughput

Here's where chain replication shines. In primary-backup, the primary handles **both reads and writes**, making it the bottleneck:

```
Primary-Backup:
  Primary: handles R reads/sec + W writes/sec
  Backup:  handles W writes/sec (receiving replicated writes)
  Throughput limited by: primary (R + W)

Chain Replication:
  Head:    handles W writes/sec (receiving + forwarding)
  Middle:  handles W writes/sec (receiving + forwarding)
  Tail:    handles R reads/sec + W writes/sec (receiving + serving reads)
  Throughput limited by: max(W at head, R + W at tail)
```

For read-heavy workloads (common in practice), chain replication achieves better throughput because reads and writes are handled by different nodes. The head handles only writes; the tail handles only reads. The load is split.

### Comparison Table

| Metric | Primary-Backup | Chain Replication |
|--------|---------------|-------------------|
| Write latency | Lower (parallel replication) | Higher (sequential propagation) |
| Read latency | Same (single node) | Same (single node) |
| Read throughput | Limited by primary | Distributed (tail handles reads) |
| Consistency | Needs careful protocol | Linearizable by construction |
| Failover complexity | Moderate | Managed by external service |
| Proof complexity | High | Low |

---

## CRAQ: Chain Replication with Apportioned Queries

The original chain replication design has a limitation: all reads go to the tail. For read-heavy workloads, the tail becomes a bottleneck. In 2009, Jeff Terrace and Michael Freedman proposed **CRAQ** (Chain Replication with Apportioned Queries), which allows reads from any node in the chain while preserving strong consistency.

### The Key Insight

In basic chain replication, intermediate nodes can't serve reads because they might have "pending" writes that the tail hasn't committed yet. CRAQ solves this by having each node track which writes are **clean** (committed) vs **dirty** (pending).

### How It Works

Each node stores multiple versions of each object, tagged as clean or dirty:

```
Node state for key "x":
  version 3: value="c", status=CLEAN      ← committed
  version 4: value="d", status=DIRTY      ← propagated but not yet committed
```

When a node receives a write from its predecessor, it stores the new version as `DIRTY`. When the tail commits a write and sends an acknowledgment back up the chain, each node marks that version as `CLEAN` and garbage-collects older versions.

### Read Protocol

When a client reads from an intermediate node:

1. **If the latest version is CLEAN**: return it immediately. This value has been committed by the tail, so it's safe.
2. **If the latest version is DIRTY**: ask the tail what the latest committed version number is, then return the local copy of that version.

```
Client ──read(k)──▶ Node 2
                      │
                      │  latest version of k is DIRTY
                      │
Node 2 ──version_query(k)──▶ TAIL
                               │
TAIL ──committed_version=3────▶ Node 2
                                 │
                                 │  return local version 3 (CLEAN)
                                 │
Node 2 ──value("c")────────────▶ Client
```

### Why This Is Still Linearizable

The version query to the tail acts as a **synchronization point**. The tail's response tells the node exactly which version is committed, and the node returns that version. The effect is the same as if the read had gone to the tail — the tail determines the answer.

For clean reads (the common case in practice), no extra communication is needed. The node serves the read locally. Only dirty reads require the version query, and the number of dirty reads depends on the write rate and chain propagation latency.

### Performance

```
CRAQ read throughput ≈ N × single-node throughput (for read-heavy, mostly-clean workloads)
```

With a 5-node chain and a workload that is 95% reads, CRAQ distributes reads across all 5 nodes, achieving roughly 5× the read throughput of basic chain replication. The write path is unchanged.

---

## Pseudocode: Chain Replication Protocol

```python
class ChainNode:
    def __init__(self, node_id, predecessor, successor, is_head, is_tail):
        self.node_id = node_id
        self.predecessor = predecessor
        self.successor = successor
        self.is_head = is_head
        self.is_tail = is_tail
        self.store = {}           # key -> value
        self.pending = {}         # request_id -> client_address
        self.hist = []            # ordered list of applied updates

    # ── Write path ──

    def handle_client_write(self, key, value, request_id, client_addr):
        """Only called on the HEAD node."""
        assert self.is_head
        self.apply_update(key, value, request_id)
        self.pending[request_id] = client_addr
        self.forward_to_successor(key, value, request_id)

    def handle_forwarded_write(self, key, value, request_id):
        """Called on non-head nodes when receiving a write from predecessor."""
        self.apply_update(key, value, request_id)
        if self.is_tail:
            self.send_ack_to_client(request_id)
            self.send_commit_up_chain(request_id)
        else:
            self.forward_to_successor(key, value, request_id)

    def apply_update(self, key, value, request_id):
        self.store[key] = value
        self.hist.append((request_id, key, value))

    def forward_to_successor(self, key, value, request_id):
        send(self.successor, ForwardWrite(key, value, request_id))

    # ── Read path ──

    def handle_client_read(self, key, client_addr):
        """Only called on the TAIL node."""
        assert self.is_tail
        value = self.store.get(key)
        send(client_addr, ReadResponse(key, value))

    # ── Acknowledgment path ──

    def send_ack_to_client(self, request_id):
        """Tail sends ack directly to the client."""
        client_addr = self.pending.pop(request_id, None)
        if client_addr:
            send(client_addr, WriteAck(request_id))

    def send_commit_up_chain(self, request_id):
        """Tail notifies predecessor that the write is committed.
           (Used in CRAQ; optional in basic chain replication.)"""
        if self.predecessor:
            send(self.predecessor, CommitNotification(request_id))

    def handle_commit_notification(self, request_id):
        """CRAQ: mark version as clean. Propagate up."""
        # Mark the version as CLEAN in CRAQ
        if self.predecessor:
            send(self.predecessor, CommitNotification(request_id))


class ConfigurationManager:
    """Runs on a Paxos/Raft group. Manages chain membership."""

    def __init__(self):
        self.chain = []         # ordered list of node IDs
        self.heartbeats = {}    # node_id -> last_heartbeat_time

    def handle_node_failure(self, failed_node):
        position = self.chain.index(failed_node)

        if position == 0:
            # Head failure: promote next node
            self.chain.pop(0)
            new_head = self.chain[0]
            notify(new_head, YouAreHead())

        elif position == len(self.chain) - 1:
            # Tail failure: promote predecessor
            self.chain.pop(-1)
            new_tail = self.chain[-1]
            notify(new_tail, YouAreTail())

        else:
            # Middle node failure: splice out
            predecessor = self.chain[position - 1]
            successor = self.chain[position + 1]
            self.chain.pop(position)
            notify(predecessor, NewSuccessor(successor))
            notify(successor, NewPredecessor(predecessor))
            # Predecessor resends any pending updates to successor
            notify(predecessor, ResendPendingTo(successor))

    def add_node(self, new_node):
        """Add a new node to the tail of the chain."""
        # The new node syncs state from the current tail
        current_tail = self.chain[-1]
        notify(current_tail, SyncStateTo(new_node))
        # Once sync is complete, the new node becomes the tail
        self.chain.append(new_node)
        notify(new_node, YouAreTail())
        notify(current_tail, YouAreNoLongerTail(new_successor=new_node))
```

---

## Adding a New Node

When a new node is added to the chain (for expansion or to replace a failed node), it typically joins at the **tail**:

```
Before:
  HEAD ──▶ Node 2 ──▶ TAIL

Adding Node 4:
  1. Current TAIL syncs its full state to Node 4
  2. During sync, new writes still propagate through the old chain
  3. After sync, TAIL forwards any writes that arrived during sync
  4. Node 4 becomes the new TAIL

After:
  HEAD ──▶ Node 2 ──▶ Node 3 ──▶ TAIL
                                (was Node 4)
```

Adding at the tail is natural because:
- The new node doesn't affect the write path until it's fully synchronized
- Reads continue from the old tail until the switch
- The transition is atomic from the client's perspective (the configuration manager updates the tail pointer)

---

## Chain Replication vs. Paxos/Raft

Chain replication and Paxos/Raft solve overlapping but different problems. Understanding the distinction is important:

### What Paxos/Raft Provides
- **Consensus on a sequence of commands** among a set of replicas
- Tolerates `f` failures with `2f + 1` nodes
- No external configuration manager needed (it *is* the configuration manager)
- Every node can potentially be a leader

### What Chain Replication Provides
- **Linearizable reads and writes** using a fixed chain topology
- Tolerates `f` failures with `f + 1` nodes (more efficient!)
- Requires an external configuration manager (which typically runs Paxos/Raft)
- Clean separation of data plane and control plane

### When to Use Which

| Scenario | Better Choice | Why |
|----------|--------------|-----|
| General-purpose replicated state machine | Paxos/Raft | Self-contained, no external dependency |
| High-throughput storage with read-heavy workload | Chain replication | Better read/write load distribution |
| System where formal verification matters | Chain replication | Much simpler correctness proof |
| Small cluster (3–5 nodes) | Paxos/Raft | The overhead of a configuration manager isn't justified |
| Large storage system with hundreds of chains | Chain replication | The configuration manager is amortized across all chains |

In practice, large storage systems often use **both**: chain replication for the data path and Paxos/Raft for the configuration manager.

---

## Real-World Systems Using Chain Replication

### HDFS (Hadoop Distributed File System)

HDFS uses a variant of chain replication for its data pipeline. When a client writes a block, the data flows through a chain of DataNodes:

```
Client ──▶ DataNode 1 ──▶ DataNode 2 ──▶ DataNode 3
                                              │
                                              ▼
Client ◀──────────────── ack ◀──────────── ack
```

The NameNode acts as the configuration manager, deciding which DataNodes form the chain for each block.

### Azure Storage

Microsoft's Azure Storage uses chain replication extensively. The storage system partitions data into "extents" and replicates each extent using a 3-node chain. The configuration is managed by a Paxos-based service called the "Partition Layer."

Azure's implementation adds several production refinements:
- **Parallel writes within a node**: A node can forward the write to its successor before finishing its own disk write, overlapping network and I/O
- **Sealed extents**: Once an extent reaches its size limit, it's sealed (made immutable), which simplifies subsequent reads and garbage collection

### Microsoft FaRM

FaRM (Fast Remote Memory) uses a variant of chain replication for in-memory distributed transactions. FaRM achieves extraordinary performance (millions of transactions per second) by:
- Using RDMA (Remote Direct Memory Access) instead of TCP for inter-node communication
- Keeping all data in RAM
- Using chain replication for durability with a short chain (typically 3 nodes)

### Corfu and Virtual Log

The Corfu system (from Microsoft Research and VMware) uses chain replication to implement a shared, distributed log. Each position in the log is replicated across a chain of nodes, and the log provides a total ordering that other systems build on.

---

## Design Considerations

### Chain Length

Longer chains provide more replicas (higher durability) but increase write latency. In practice, chains of **3 nodes** are most common — the same replication factor used by most systems (HDFS, Cassandra, etc.).

```
Chain length 3:
  Write latency = 3 hops
  Tolerates 2 failures
  Read throughput = 1 node (basic) or 3 nodes (CRAQ)
```

### Handling Slow Nodes

A slow middle node delays all writes (they must traverse it). This is the "weakest link" problem — the chain's throughput is limited by its slowest node.

Mitigation strategies:
1. **Monitor node performance** and proactively replace slow nodes
2. **Short chains** (3 nodes) limit the impact
3. **Parallel I/O overlap** (Azure's approach): forward before finishing local I/O

### Network Topology Awareness

Place chain nodes across failure domains (different racks, availability zones) to maximize fault tolerance. But be aware that this increases per-hop latency:

```
Same-rack chain:   write latency ≈ 3 × 0.1ms = 0.3ms
Cross-rack chain:  write latency ≈ 3 × 0.5ms = 1.5ms
Cross-AZ chain:    write latency ≈ 3 × 2ms   = 6ms
```

### Split-Brain Prevention

The configuration manager must ensure that at most one chain configuration is active at any time. If two clients see different chain configurations (e.g., during a network partition), they might send writes to different heads, violating linearizability.

This is why the configuration manager uses consensus (Paxos/Raft) and why clients must verify the chain configuration before sending requests.

---

## A Complete Example: Handling a Middle-Node Crash

Let's walk through a detailed failure scenario.

### Initial State

```
Chain: HEAD(A) ──▶ B ──▶ C ──▶ TAIL(D)

Applied writes:
  A: [w1, w2, w3, w4, w5]
  B: [w1, w2, w3, w4]
  C: [w1, w2, w3]
  D: [w1, w2, w3]       ← committed: w1, w2, w3

Pending: w4 (at B, not yet at C), w5 (at A, not yet at B)
```

### Node B Crashes

```
Chain: HEAD(A) ──▶ B ──▶ C ──▶ TAIL(D)
                    ✗

Configuration manager detects B's failure via missed heartbeats.
```

### Reconfiguration

```
New chain: HEAD(A) ──▶ C ──▶ TAIL(D)

Configuration manager:
  1. Tells A: your new successor is C
  2. Tells C: your new predecessor is A
  3. Tells A: resend any writes C hasn't received
```

### Reconciliation

A knows it has applied [w1, w2, w3, w4, w5]. C has [w1, w2, w3]. A resends w4 and w5 to C:

```
A ──forward(w4)──▶ C
A ──forward(w5)──▶ C

C applies w4, forwards to D:
C ──forward(w4)──▶ D (TAIL)
D applies w4, sends ack to client for w4

C applies w5, forwards to D:
C ──forward(w5)──▶ D (TAIL)
D applies w5, sends ack to client for w5
```

### Final State

```
Chain: HEAD(A) ──▶ C ──▶ TAIL(D)

Applied writes:
  A: [w1, w2, w3, w4, w5]
  C: [w1, w2, w3, w4, w5]
  D: [w1, w2, w3, w4, w5]   ← committed: w1–w5

All pending writes are now committed. No data was lost.
```

---

## Comparison with Other Replication Strategies

| Property | Primary-Backup | Chain Replication | Raft | Quorum (Dynamo) |
|----------|---------------|-------------------|------|-----------------|
| Consistency | Depends on protocol | Linearizable | Linearizable | Eventual / tunable |
| Write path | Primary → all backups (parallel) | Head → ... → Tail (sequential) | Leader → majority | Client → W nodes |
| Read path | Primary (or stale backup) | Tail only (or any in CRAQ) | Leader (or stale follower) | Client → R nodes |
| Write latency | 1 RTT (parallel fan-out) | N hops (sequential) | 1 RTT to majority | 1 RTT to W nodes |
| Read load distribution | Primary bottleneck | Tail (or distributed in CRAQ) | Leader bottleneck | Any R nodes |
| Nodes needed for f failures | f + 1 | f + 1 | 2f + 1 | W + R > N |
| External coordinator needed | Optional | Yes | No | Optional |
| Correctness proof complexity | Moderate | Low | High | Varies |

---

## Key Takeaways

1. **Chain replication separates reads and writes** onto different nodes (tail and head), naturally distributing load for read-heavy workloads.

2. **Linearizability comes from the topology**, not from a complex protocol. Every operation's linearization point is at the tail, making the correctness proof trivial compared to Paxos.

3. **The trade-off is write latency**: writes must traverse the entire chain sequentially, while primary-backup can replicate in parallel.

4. **An external configuration manager is required** to handle failures. This typically uses Paxos/Raft, so chain replication doesn't eliminate consensus — it moves it to the control plane.

5. **CRAQ extends the design** to distribute reads across all nodes while preserving strong consistency, addressing the tail bottleneck for read-heavy workloads.

6. **In practice, large storage systems combine both approaches**: chain replication for the data path (simple, efficient) and Paxos/Raft for the control plane (handles rare reconfiguration events).

---

## References

- van Renesse, R., & Schneider, F. B. (2004). *Chain Replication for Supporting High Throughput and Availability.* OSDI.
- Terrace, J., & Freedman, M. J. (2009). *Object Storage on CRAQ: High-throughput chain replication for read-mostly workloads.* USENIX ATC.
- Ghemawat, S., Gobioff, H., & Leung, S.-T. (2003). *The Google File System.* SOSP. (Uses chain-like data pipeline)
- Dragojević, A., et al. (2014). *FaRM: Fast Remote Memory.* NSDI. (Chain replication with RDMA)
- Balakrishnan, M., et al. (2012). *CORFU: A Shared Log Design for Flash Clusters.* NSDI.

---

**Next**: [Chapter 20 — CAP Theorem: The Proof, Not the Slogan →](ch20-cap-theorem.md)
