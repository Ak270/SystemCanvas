# Capstone 1: Distributed Key-Value Store

> Design a Redis-like distributed key-value store from first principles, with a focus on the correctness and failure behavior of its replication and consistency protocols.

**Concepts exercised**: Primary-backup replication (Ch 17), quorum reads/writes (Ch 18), failure detection (Ch 7–8), linearizability (Ch 13), split-brain prevention, fencing tokens, write-ahead logs (Ch 15).

---

## 1. Requirements and Constraints

### Functional Requirements
- `PUT(key, value)` — store a key-value pair
- `GET(key)` — retrieve the value for a key
- `DELETE(key)` — remove a key-value pair
- `CAS(key, expected, new)` — compare-and-swap (atomic read-modify-write)

### Non-Functional Requirements
- **Linearizability**: Every operation appears to take effect at a single instant between its invocation and response
- **Durability**: Acknowledged writes survive any single node failure
- **Availability**: The system continues serving requests when fewer than half the nodes fail
- **Consistency over availability**: During a network partition, the system refuses stale reads rather than serving potentially inconsistent data

### Constraints
- Cluster of N nodes (typically 3 or 5)
- Keys and values are opaque byte strings (max 1 MB)
- In-memory data with write-ahead log for durability
- Single-key operations only (no multi-key transactions)

---

## 2. High-Level Architecture

```
                        ┌─────────────────────┐
                        │   Client Library     │
                        │  (leader discovery,  │
                        │   retry logic)       │
                        └──────────┬──────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
               ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
               │ Node 1  │   │ Node 2  │   │ Node 3  │
               │ (Leader) │   │(Follower)│   │(Follower)│
               │         │   │         │   │         │
               │ ┌─────┐ │   │ ┌─────┐ │   │ ┌─────┐ │
               │ │ WAL  │ │   │ │ WAL  │ │   │ │ WAL  │ │
               │ ├─────┤ │   │ ├─────┤ │   │ ├─────┤ │
               │ │State │ │   │ │State │ │   │ │State │ │
               │ │Machine│ │   │ │Machine│ │   │ │Machine│ │
               │ └─────┘ │   │ └─────┘ │   │ └─────┘ │
               └────┬────┘   └────┬────┘   └────┬────┘
                    │              │              │
                    └──────────────┼──────────────┘
                          Raft Consensus
```

The system uses **Raft consensus** (Ch 22) as the replication substrate. Every write is proposed to the Raft leader, replicated to a majority, then applied to the state machine. This gives us linearizability by construction — Raft's log is a totally ordered sequence of operations, and each operation takes effect at a single point (when committed).

### Why Raft Instead of Primary-Backup?

Simple primary-backup replication (Ch 17) requires an external authority to decide who the primary is. If that authority is a single machine, it becomes a single point of failure. If it's a distributed system itself, you need consensus — so you've just pushed the problem down one layer.

Raft solves leader election, log replication, and safety in one integrated protocol. The KV store becomes a **replicated state machine** on top of Raft.

---

## 3. The Replication Protocol

### Write Path

```
Client              Leader (Node 1)         Follower (Node 2)      Follower (Node 3)
  │                      │                       │                       │
  │  PUT(k, v)           │                       │                       │
  ├─────────────────────▶│                       │                       │
  │                      │                       │                       │
  │                      │ 1. Append to local WAL│                       │
  │                      │    (log index = 47)   │                       │
  │                      │                       │                       │
  │                      │ AppendEntries(47)     │                       │
  │                      ├──────────────────────▶│                       │
  │                      │ AppendEntries(47)     │                       │
  │                      ├──────────────────────────────────────────────▶│
  │                      │                       │                       │
  │                      │         ACK(47)       │                       │
  │                      │◀──────────────────────┤                       │
  │                      │                       │                       │
  │                      │ 2. Majority ACK       │                       │
  │                      │    Entry 47 committed │                       │
  │                      │                       │                       │
  │                      │ 3. Apply to state     │                       │
  │                      │    machine            │                       │
  │                      │                       │                       │
  │       OK             │                       │                       │
  │◀─────────────────────┤                       │                       │
  │                      │                       │         ACK(47)       │
  │                      │◀──────────────────────────────────────────────┤
  │                      │                       │                       │
```

Step by step:

1. **Client sends PUT to leader.** If the client contacts a follower, the follower redirects to the current leader (or proxies the request).

2. **Leader appends to its local WAL.** The entry contains `{term: 5, index: 47, op: PUT, key: k, value: v}`.

3. **Leader sends AppendEntries RPCs to all followers.** These run in parallel.

4. **Each follower appends to its own WAL and ACKs.** A follower only appends if the entry's term matches or exceeds its current term and the log is consistent up to the previous entry (log matching property).

5. **Leader waits for a majority of ACKs** (including itself). With 3 nodes, that's 2 out of 3. Once a majority has the entry, it is **committed** — it will never be lost or overwritten.

6. **Leader applies the committed entry to its state machine** (the in-memory hash map) and responds to the client.

7. **Followers learn about the commit** on the next AppendEntries (via the `leaderCommit` field) and apply to their own state machines.

### Read Path

Reads are more subtle than writes. A naive approach — "just read from the leader's state machine" — is **not linearizable** because a leader might be deposed without knowing it (network partition). A stale leader could serve reads from an outdated state.

#### Approach 1: Read Through Raft Log (Simple, Slow)

Treat every read as a write. The leader appends a no-op entry to the Raft log, waits for it to commit (majority ACK), then reads from the state machine. This confirms the leader is still the leader as of the committed entry.

```
Cost: 1 round-trip to followers for every read
```

#### Approach 2: ReadIndex (etcd's Approach)

1. Leader records the current commit index (`readIndex = commitIndex`).
2. Leader sends a heartbeat to confirm it is still the leader (majority must respond).
3. Leader waits until its state machine has applied up to `readIndex`.
4. Leader reads from the state machine.

```
Cost: 1 heartbeat round-trip, no log entry written
```

This is cheaper than Approach 1 because it doesn't write to the log or to disk.

#### Approach 3: Lease-Based Reads (Fastest, Requires Clock Assumptions)

The leader holds a **lease** — a time-bounded promise that no other leader can be elected during the lease period. If the leader's lease is valid, it can serve reads locally without contacting followers.

```python
LEASE_DURATION = 5  # seconds

class LeaseBasedLeader:
    def __init__(self):
        self.lease_expiry = 0

    def on_heartbeat_ack(self, follower_count):
        if follower_count >= majority:
            # Renew lease: valid for LEASE_DURATION from now
            self.lease_expiry = monotonic_clock() + LEASE_DURATION

    def can_serve_read(self):
        # Only serve reads if lease is still valid
        return monotonic_clock() < self.lease_expiry
```

**The clock assumption**: This requires that all nodes' clocks advance at roughly the same rate (bounded drift). If the leader's clock runs fast, it might think its lease is valid when followers have already timed out and elected a new leader. This is why etcd uses ReadIndex by default and offers leases as an opt-in performance optimization.

---

## 4. State Machine Design

The state machine is a hash map with a few additions for linearizability:

```python
class KVStateMachine:
    def __init__(self):
        self.data = {}           # key -> value
        self.client_table = {}   # client_id -> {seq_num, response}

    def apply(self, entry):
        """Apply a committed log entry. Must be deterministic."""
        client_id = entry.client_id
        seq_num = entry.seq_num

        # Deduplication: if we've already applied this exact operation,
        # return the cached response (handles client retries)
        if client_id in self.client_table:
            last = self.client_table[client_id]
            if last.seq_num == seq_num:
                return last.response
            if last.seq_num > seq_num:
                return Error("stale request")

        # Apply the operation
        if entry.op == "PUT":
            self.data[entry.key] = entry.value
            response = OK
        elif entry.op == "GET":
            response = self.data.get(entry.key, NOT_FOUND)
        elif entry.op == "DELETE":
            self.data.pop(entry.key, None)
            response = OK
        elif entry.op == "CAS":
            current = self.data.get(entry.key)
            if current == entry.expected:
                self.data[entry.key] = entry.new_value
                response = OK
            else:
                response = CAS_FAILED(current)

        # Cache response for deduplication
        self.client_table[client_id] = {
            "seq_num": seq_num,
            "response": response
        }
        return response
```

### Why the Client Table?

Consider this scenario:

1. Client sends `PUT(x, 42)` to the leader.
2. Leader commits the entry and applies it.
3. The response packet is lost in the network.
4. Client retries `PUT(x, 42)`.

Without the client table, the operation would be applied twice. For a simple PUT, this is idempotent and harmless. But for a CAS or an increment operation, double-application would be incorrect.

The client table maps each `(client_id, seq_num)` to its response, so retries return the cached result without re-executing.

---

## 5. Split-Brain Prevention

The most dangerous failure mode in a replicated system is **split brain**: two nodes both believe they are the leader and accept writes independently. Their states diverge, and reconciliation is impossible without data loss.

### How Raft Prevents Split Brain

Raft's term-based voting prevents two leaders in the same term:

1. **Election requires a majority.** With N nodes, a candidate needs ⌊N/2⌋ + 1 votes. Two candidates cannot both receive a majority (their vote sets must overlap — at least one node would have voted for both, which Raft forbids within a term).

2. **Term numbers are monotonically increasing.** If a node receives a message with a higher term, it immediately steps down. A stale leader that was partitioned will discover it's behind when the partition heals.

3. **Only the leader with the highest committed term can have committed entries.** The Leader Completeness Property (Ch 22) guarantees that any newly elected leader has all previously committed entries.

### Fencing Tokens for External Resources

What if the KV store coordinates access to an external resource (a file, a database row, a lock)? Even with Raft, a deposed leader might still think it's the leader for a brief window. If it issues a command to an external system during that window, the external system could execute a stale command.

**Solution: Fencing tokens.** Every time a new leader is elected, it gets a monotonically increasing fencing token (the Raft term number works). The external resource rejects any operation with a fencing token lower than the highest it has seen:

```
Leader A (term 5)      External DB          Leader B (term 6)
     │                      │                      │
     │  WRITE(token=5)      │                      │
     ├─────────────────────▶│                      │
     │                      │ max_token = 5        │
     │       OK             │                      │
     │◀─────────────────────┤                      │
     │                      │                      │
     │   (A partitioned, B elected with term 6)    │
     │                      │                      │
     │                      │  WRITE(token=6)      │
     │                      │◀─────────────────────┤
     │                      │ max_token = 6        │
     │                      │        OK            │
     │                      ├─────────────────────▶│
     │                      │                      │
     │  WRITE(token=5)      │                      │
     ├─────────────────────▶│                      │
     │    REJECTED(5 < 6)   │                      │
     │◀─────────────────────┤                      │
     │                      │                      │
```

The external resource acts as the final arbiter. Even if Leader A doesn't know it's been deposed, its operations are rejected because its token is stale.

---

## 6. Failure Scenarios

### Scenario 1: Leader Crashes After Committing

```
Timeline:
1. Leader commits PUT(x, 42) at log index 47 (majority ACK received)
2. Leader applies to state machine, responds OK to client
3. Leader crashes

What happens:
- Followers already have entry 47 in their logs
- New leader is elected; entry 47 is already committed
- New leader applies entry 47 to its state machine (if not already applied)
- No data loss. Client received OK, and the write is durable.
```

**Verdict**: Correct. The write is durable because it was committed to a majority before the leader crashed.

### Scenario 2: Leader Crashes Before Committing

```
Timeline:
1. Leader receives PUT(x, 42), appends to its own log (index 47)
2. Leader sends AppendEntries to followers
3. Leader crashes before receiving any ACKs

What happens:
- Follower Node 2 received entry 47, Follower Node 3 did not
- New election: Node 3 wins (Node 3 has a shorter log but higher term)
- Node 3 does NOT have entry 47 in its log
- Node 3 overwrites Node 2's entry 47 with its own entries
- PUT(x, 42) is lost

Client behavior:
- Client never received OK (leader crashed before responding)
- Client retries with the same (client_id, seq_num)
- New leader handles it as a fresh operation
```

**Verdict**: Correct. The client never received an acknowledgment, so from the client's perspective the operation may or may not have happened. The client retries, and the system handles it correctly.

### Scenario 3: Network Partition (Minority Partition Contains Leader)

```
┌─────────────────┐         ┌─────────────────────────┐
│   Partition A   │         │     Partition B          │
│                 │  ╳╳╳╳╳  │                         │
│  Node 1        │         │  Node 2    Node 3       │
│  (Old Leader)  │         │  (New Leader)            │
│                 │         │                         │
└─────────────────┘         └─────────────────────────┘
```

1. Network partition isolates Node 1 from Nodes 2 and 3.
2. Node 1 still thinks it's the leader (its lease hasn't expired yet, if using leases).
3. Nodes 2 and 3 time out on heartbeats and elect Node 2 as leader (term 6).
4. Node 2 accepts new writes from clients.
5. Node 1 cannot commit any writes (can't reach a majority of 2 out of 3).

**If a client sends a write to Node 1:**
- Node 1 appends to its log but cannot commit (no majority ACK).
- Client times out waiting for a response.
- Client discovers Node 2 is the new leader (via redirect or service discovery).
- Client retries with Node 2.

**If a client sends a read to Node 1 (with leases):**
- If Node 1's lease is still valid, it serves the read from stale state. **This violates linearizability.**
- Once the lease expires, Node 1 cannot serve reads either.

**This is why lease-based reads are dangerous.** The lease duration must be shorter than the election timeout to prevent stale reads during a partition. In practice, this means:

```
lease_duration < election_timeout_min - max_clock_drift
```

**When the partition heals:**
- Node 1 receives AppendEntries from Node 2 with term 6.
- Node 1 sees term 6 > its current term 5, so it steps down to follower.
- Node 1's uncommitted entries are overwritten by Node 2's log.
- Node 1 catches up to the current state.

### Scenario 4: Slow Follower

```
Timeline:
1. Leader commits entries 47, 48, 49, 50 (majority of Node 1 + Node 2)
2. Node 3 is slow (GC pause, disk IO, network congestion)
3. Node 3 has only applied up to entry 45
```

This is fine — the system continues functioning because a majority (Nodes 1 and 2) are keeping up. When Node 3 recovers, it catches up:

1. Leader's next AppendEntries to Node 3 includes entries 46, 47, 48, 49, 50.
2. Node 3 appends them and ACKs.
3. Node 3 applies committed entries to its state machine.

But there's a risk: if Node 2 now crashes, the cluster has only Node 1 (the leader) and Node 3 (behind). Node 1 cannot commit new entries because Node 3 hasn't ACK'd recent entries, and Node 1 + Node 3 isn't a majority that has the latest entries.

Actually, that's incorrect — Node 1 alone is 1 out of 3, which is not a majority. The cluster is now unavailable until either Node 2 recovers or Node 3 catches up and ACKs enough entries.

### Scenario 5: Client Receives Timeout — What Actually Happened?

```
Timeline:
1. Client sends CAS(balance, 100, 50) to leader
2. Client's RPC timeout fires after 3 seconds
3. Client receives a timeout error

Did the CAS succeed or not?
```

The client cannot know. The CAS might have been:
- Never received by the leader (network dropped the request)
- Received but not yet committed (leader is still replicating)
- Committed and applied (response was lost or arrived late)

**This is the Two Generals Problem (Ch 5).** The client must retry — and the system must handle retries correctly via the client table (deduplication).

```python
class Client:
    def __init__(self, client_id):
        self.client_id = client_id
        self.seq_num = 0

    def cas(self, key, expected, new_value):
        self.seq_num += 1
        request = {
            "client_id": self.client_id,
            "seq_num": self.seq_num,
            "op": "CAS",
            "key": key,
            "expected": expected,
            "new_value": new_value,
        }

        while True:
            leader = self.discover_leader()
            try:
                response = leader.send(request, timeout=3)
                return response
            except Timeout:
                # Retry with SAME seq_num — server deduplicates
                continue
            except NotLeader as e:
                # Follower told us who the leader is
                self.update_leader_hint(e.leader_id)
                continue
```

The key insight: the `seq_num` does not increment on retry. This ensures that if the original request was committed, the retry returns the cached result from the client table instead of re-executing the CAS.

---

## 7. Snapshotting and Log Compaction

The Raft log grows without bound. After millions of operations, replaying the entire log on restart would take too long. The solution is **snapshotting**:

1. Periodically (e.g., every 10,000 entries), serialize the state machine to disk.
2. Record the last applied log index and term in the snapshot.
3. Discard all log entries up to that index.

```
Before compaction:
  WAL: [entry 1] [entry 2] ... [entry 50000] [entry 50001] ... [entry 52341]
  State machine: result of applying entries 1–52341

After compaction (snapshot at entry 50000):
  Snapshot: {data: {...}, last_index: 50000, last_term: 8}
  WAL: [entry 50001] ... [entry 52341]
```

On restart, the node loads the snapshot, then replays the remaining WAL entries.

For slow followers that are too far behind (their next needed entry was compacted), the leader sends the snapshot via `InstallSnapshot` RPC.

---

## 8. Performance Considerations

### Write Latency Breakdown

```
Client → Leader:           ~0.5ms (same datacenter)
Leader WAL fsync:          ~0.1ms (NVMe SSD)
Leader → Followers (parallel): ~0.5ms (same datacenter)
Follower WAL fsync:        ~0.1ms
Followers → Leader ACK:    ~0.5ms
Leader apply + respond:    ~0.1ms
Leader → Client:           ~0.5ms
────────────────────────────────────
Total:                     ~2.3ms (same datacenter, 3 nodes)
```

The critical path is: `client → leader → WAL → follower → WAL → ACK → apply → client`.

### Batching

The leader can batch multiple client requests into a single AppendEntries RPC:

```python
class BatchingLeader:
    def __init__(self):
        self.pending = []
        self.batch_interval = 0.001  # 1ms

    def handle_request(self, request):
        self.pending.append(request)
        if len(self.pending) >= MAX_BATCH_SIZE:
            self.flush()

    def flush(self):
        entries = self.pending
        self.pending = []

        # Write all entries to WAL in one fsync
        self.wal.append_batch(entries)

        # Send one AppendEntries with all entries
        for follower in self.followers:
            follower.send_append_entries(entries)
```

Batching amortizes the fsync cost across many operations, dramatically improving throughput at the cost of slightly higher per-operation latency.

### Read Optimization: Follower Reads

For workloads that tolerate slightly stale reads (not linearizable, but bounded staleness), followers can serve reads directly. The client specifies a staleness bound:

```python
def follower_read(self, key, max_staleness_ms):
    if self.last_applied_time > now() - max_staleness_ms:
        return self.state_machine.get(key)
    else:
        redirect_to_leader()
```

---

## 9. Summary: Correctness Argument

The distributed KV store is linearizable because:

1. **Total order**: All operations go through the Raft log, which imposes a total order on all operations across all keys.

2. **Real-time ordering**: If operation A completes before operation B starts (in real time), then A appears before B in the log. This is because:
   - A was committed before B was proposed.
   - Raft's log is append-only and committed entries are never overwritten.
   - The leader processes proposals in order.

3. **Atomicity**: Each operation takes effect at a single point — the moment the leader applies the committed entry to the state machine. Before that point, the operation hasn't happened. After it, the result is visible to all subsequent reads.

4. **Durability**: A committed entry exists on a majority of nodes. Any future leader must have all committed entries (Leader Completeness Property). Therefore, committed writes are never lost.

The one caveat is reads: they are linearizable only if the leader confirms its leadership before serving a read (via ReadIndex or heartbeat). Lease-based reads are linearizable only under the assumption of bounded clock drift.

---

**Next**: [Capstone 2 — Distributed Ledger / Payment System →](capstone02-distributed-ledger.md)
