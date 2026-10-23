# Chapter 24: ZooKeeper and Coordination Services

> **Core question**: How do real systems use a consensus service to coordinate distributed elections, locks, and configuration?

> **Prerequisites**: Consistency models (Ch 12), Linearizability (Ch 13), CAP theorem (Ch 20), Raft (Ch 22)

---

## Why Coordination Is a Separate Service

In Part 3 we saw that consensus is hard: the FLP impossibility result (Ch 21) shows no deterministic algorithm can guarantee it in an asynchronous system, and Raft (Ch 22) requires careful implementation of leader election, log replication, and safety invariants. Most application teams should not build their own consensus protocol. Instead, they delegate coordination to a dedicated service.

ZooKeeper, originally developed at Yahoo! and now an Apache project, is the most widely deployed coordination service. It provides a small set of primitives — hierarchical key-value storage, ephemeral nodes, sequential nodes, and watches — from which higher-level coordination patterns (leader election, distributed locks, group membership, barriers) can be built.

Think of ZooKeeper as a "kernel for distributed systems." Just as an OS kernel provides primitives (files, processes, signals) from which applications build complex behavior, ZooKeeper provides coordination primitives from which distributed applications build agreement.

---

## ZooKeeper's Data Model

ZooKeeper stores data in a hierarchical namespace that looks like a filesystem:

```
/
├── /app1
│   ├── /app1/leader        → "server-3"
│   ├── /app1/config         → "{max_connections: 100}"
│   └── /app1/workers
│       ├── /app1/workers/w-0001  → "10.0.0.1:8080"
│       ├── /app1/workers/w-0002  → "10.0.0.2:8080"
│       └── /app1/workers/w-0003  → "10.0.0.3:8080"
├── /app2
│   └── /app2/locks
│       └── /app2/locks/resource-X
│           ├── /app2/locks/resource-X/lock-0001
│           └── /app2/locks/resource-X/lock-0002
└── /zookeeper
    └── /zookeeper/quota
```

Each node in this tree is called a **znode**. A znode can hold data (up to 1MB, though typically much less) and have children. Unlike a filesystem, there is no distinction between files and directories — every znode can both hold data and have children.

### Znode Types

**Persistent znodes**: Created explicitly and remain until explicitly deleted. They survive server restarts and client disconnections. Used for configuration data, lock parent directories, and stable metadata.

**Ephemeral znodes**: Tied to the client session that created them. When the session ends (client disconnects or session times out), the znode is automatically deleted. Used for:
- Group membership: each member creates an ephemeral node; when a member crashes, its node disappears
- Leader election: the leader holds an ephemeral node; if the leader crashes, the node disappears, triggering re-election
- Distributed locks: a lock is an ephemeral node; if the holder crashes, the lock is released

**Sequential znodes**: When created, ZooKeeper appends a monotonically increasing counter to the name. If you create `/locks/lock-`, ZooKeeper creates `/locks/lock-0000000001`. The next creation creates `/locks/lock-0000000002`. The counter is unique within the parent znode and never reused.

Sequential znodes are the building block for fair locks and ordered operations. Combined with ephemeral znodes (creating an ephemeral sequential znode), they enable lock queues that automatically release if the holder crashes.

### Znode Metadata (Stat Structure)

Every znode carries metadata:

```
czxid:    Transaction ID that created this znode
mzxid:    Transaction ID of last modification
pzxid:    Transaction ID of last child modification
ctime:    Creation timestamp
mtime:    Last modification timestamp
version:  Number of data changes (for optimistic concurrency)
cversion: Number of child changes
aversion: Number of ACL changes
ephemeralOwner: Session ID if ephemeral, 0 if persistent
dataLength: Length of data stored
numChildren: Number of children
```

The `version` field enables **optimistic concurrency control**. A client reads data along with its version, makes a decision, and writes back with a conditional update: "set this value, but only if the version is still N." If another client modified the data in between, the version won't match and the write fails. This is the znode equivalent of compare-and-swap.

```
Client 1:                          Client 2:
  read(/config) → (data, v=5)       read(/config) → (data, v=5)
  modify data                        modify data
  set(/config, new1, v=5) → OK      set(/config, new2, v=5) → FAIL
       (v becomes 6)                  (v is now 6, not 5)
                                      re-read, retry
```

---

## ZAB: ZooKeeper Atomic Broadcast

ZooKeeper's replication protocol is **ZAB** (ZooKeeper Atomic Broadcast). ZAB is conceptually similar to Raft but was developed independently (ZAB predates Raft by several years).

### Architecture

A ZooKeeper ensemble consists of an odd number of servers (typically 3 or 5). One server is the **leader**; the rest are **followers**.

```
                    ┌──────────┐
                    │  Client  │
                    └────┬─────┘
                         │ (connect to any server)
              ┌──────────┼──────────┐
              │          │          │
         ┌────┴────┐ ┌──┴───┐ ┌───┴────┐
         │Follower │ │Leader │ │Follower│
         │  (ZK 1) │ │(ZK 2)│ │ (ZK 3) │
         └────┬────┘ └──┬───┘ └───┬────┘
              │         │         │
              └─────────┼─────────┘
                  Replication
```

**Write path**: All writes go through the leader, regardless of which server the client is connected to.

1. Client sends a write request to any server
2. If the server is a follower, it forwards the request to the leader
3. Leader assigns a **zxid** (ZooKeeper transaction ID) — a 64-bit number where the high 32 bits are the **epoch** (leader generation) and the low 32 bits are a counter
4. Leader broadcasts a **PROPOSAL** to all followers
5. Each follower writes the proposal to its transaction log (disk) and sends an **ACK**
6. When the leader receives ACKs from a majority (including itself), it broadcasts a **COMMIT**
7. The leader applies the transaction and responds to the client

```
Leader              Follower 1          Follower 2
  │                     │                    │
  │── PROPOSAL(zxid) ──▶│                    │
  │── PROPOSAL(zxid) ──────────────────────▶│
  │                     │                    │
  │◀── ACK ────────────│                    │
  │◀── ACK ──────────────────────────────── │
  │                     │                    │
  │── COMMIT(zxid) ────▶│                    │
  │── COMMIT(zxid) ────────────────────────▶│
  │                     │                    │
  │ Apply & respond     │ Apply              │ Apply
```

**Read path**: Reads are served locally by whichever server the client is connected to. This means reads may return stale data — a follower might not have applied the latest committed transaction yet. This is a deliberate trade-off: reads are fast (no network round-trip to the leader) but not linearizable by default.

For linearizable reads, ZooKeeper provides the `sync` operation: the client issues `sync` followed by `read`. The `sync` forces the connected server to catch up with the leader before serving the read.

### ZAB vs Raft

| Aspect | ZAB | Raft |
|--------|-----|------|
| Year | 2008 | 2014 |
| Leader election | Discovery + synchronization phases | RequestVote RPC |
| Log entry ID | zxid (epoch + counter) | (term, index) |
| Epoch/Term | High 32 bits of zxid | Separate term counter |
| Commit rule | Majority ACK | Majority replication |
| Recovery | Leader sends full state to followers | Leader sends missing log entries |
| Read consistency | Eventual (local reads) | Can be linearizable |
| Membership changes | Reconfiguration protocol | Joint consensus / single-server changes |

The key semantic difference: ZAB guarantees that all committed transactions from previous leaders are delivered before any new transactions from the current leader. This is the **primary order** guarantee — it ensures a new leader never reorders committed history.

---

## Session Semantics

A ZooKeeper **session** is a persistent connection between a client and the ensemble. Sessions are the unit of liveness — ephemeral znodes are tied to sessions, not to individual TCP connections.

### Session Lifecycle

```
Client                              ZooKeeper Ensemble
  │                                        │
  │── Connect(servers, timeout=30s) ──────▶│
  │◀── Session(id=0x38a7f1, timeout=30s) ──│
  │                                        │
  │── Heartbeat ──────────────────────────▶│  (every timeout/3 = 10s)
  │◀── Heartbeat response ────────────────│
  │                                        │
  │── Heartbeat ──────────────────────────▶│
  │◀── Heartbeat response ────────────────│
  │                                        │
  │    [Network disruption]                │
  │                                        │
  │── Heartbeat ──✕  (lost)               │
  │                                        │  (server starts session timer)
  │── Reconnect to different server ──────▶│
  │◀── Session still valid ────────────────│
  │                                        │
  │    [Timeout expires without any        │
  │     successful heartbeat]              │
  │                                        │  Session EXPIRED
  │                                        │  All ephemeral znodes deleted
```

Key points:

1. **Session timeout** is negotiated between client and server. The server may adjust it within bounds (typically 2x to 20x the tick time).
2. **Heartbeats** are sent every `timeout/3`. If the server doesn't hear from the client within the timeout period, the session expires.
3. **Transparent failover**: If the client's current server dies, the client library automatically reconnects to another server in the ensemble. The session continues on the new server — ephemeral nodes survive individual server failures.
4. **Session expiry is global**: When a session expires, all servers agree (via ZAB) that it's expired. This ensures ephemeral node deletion is consistent across the ensemble.

### The Session Gap Problem

When a client reconnects after a brief disconnection, there's a window where:
- The client believes its session is still active
- The server may have already expired the session

During this window, another client might have acquired a lock that the first client still thinks it holds. This is why ZooKeeper clients must check for session events and handle `SESSION_EXPIRED` as a critical error — any ephemeral nodes (including locks) the client created are now gone.

```python
def session_watcher(event):
    if event.state == KazooState.LOST:
        # Session expired — all ephemeral nodes are gone
        # MUST re-acquire locks, re-register group membership, etc.
        logger.critical("ZooKeeper session lost!")
        reacquire_all_coordination()
    elif event.state == KazooState.SUSPENDED:
        # Connection lost but session may still be valid
        # Stop doing work that depends on locks/leadership
        logger.warning("ZooKeeper connection suspended")
        pause_coordinated_work()
    elif event.state == KazooState.CONNECTED:
        # (Re)connected
        logger.info("ZooKeeper connected")
        resume_coordinated_work()
```

---

## Watches

A **watch** is a one-time notification that fires when a znode changes. Instead of polling ZooKeeper to detect changes, clients register watches and receive callbacks.

### Watch Types

- **Data watch**: Fires when a znode's data changes (triggered by `setData`)
- **Child watch**: Fires when a znode's children change (triggered by `create` or `delete` of a child)
- **Existence watch**: Fires when a znode is created or deleted (triggered by `create` or `delete`)

### Watch Semantics

1. **One-shot**: A watch fires exactly once. To continue watching, the client must re-register the watch after receiving the notification. This is by design — it prevents a slow client from accumulating an unbounded queue of notifications.

2. **Ordered**: Watch notifications are delivered in the order the events occurred. If a client sees notification for event A before event B, then A happened before B in ZooKeeper's total order.

3. **Guaranteed delivery**: Between the moment a client registers a watch and the moment it receives the notification, the client will not miss any changes. The notification may be delayed, but it will arrive before any subsequent reads return the new value.

```
Client                              ZooKeeper
  │                                    │
  │── getData(/config, watch=true) ──▶│
  │◀── data="v1", version=5 ──────── │
  │                                    │
  │        [another client updates     │
  │         /config to "v2"]           │
  │                                    │
  │◀── WATCH NOTIFICATION ────────── │
  │    (type=NodeDataChanged,          │
  │     path=/config)                  │
  │                                    │
  │── getData(/config, watch=true) ──▶│  (re-register watch)
  │◀── data="v2", version=6 ──────── │
```

### Watch Limitations

Watches are **one-shot notifications**, not streams. Between the watch firing and the client re-registering, changes can be missed. If the data changes from "v1" to "v2" to "v3" between the notification and re-registration, the client sees "v1" then "v3" — it never sees "v2."

For most coordination uses (leader election, configuration), this is fine — the client only cares about the latest state. For use cases that need every change, ZooKeeper watches are insufficient (etcd's watch streams solve this — see comparison below).

---

## Coordination Recipes

ZooKeeper's primitives are intentionally low-level. Higher-level coordination patterns are built as "recipes" on top of them. The official ZooKeeper documentation and the Curator library (now part of Apache Curator) provide battle-tested implementations.

### Recipe 1: Leader Election

The most common coordination pattern. One node in a group becomes the leader; if it fails, another takes over.

**Algorithm (using ephemeral sequential nodes)**:

```
1. Each candidate creates an ephemeral sequential node:
   create("/election/candidate-", data=my_id, EPHEMERAL_SEQUENTIAL)
   → "/election/candidate-0000000001"
   → "/election/candidate-0000000002"
   → "/election/candidate-0000000003"

2. Get all children of /election, sorted by sequence number

3. If MY node has the smallest sequence number → I am the leader

4. If not → watch the node with the NEXT SMALLER sequence number
   (NOT the smallest — this avoids the herd effect)

5. If the watched node disappears (owner crashed):
   → re-read children, go to step 3
```

```
/election
├── candidate-0000000001  (Server A) ← LEADER
├── candidate-0000000002  (Server B) ← watches candidate-0001
└── candidate-0000000003  (Server C) ← watches candidate-0002

Server A crashes:
/election
├── candidate-0000000002  (Server B) ← NEW LEADER (smallest)
└── candidate-0000000003  (Server C) ← watches candidate-0002
```

Why watch only the predecessor, not the leader? This is the **herd effect** optimization (see below).

```python
class LeaderElection:
    def __init__(self, zk_client, election_path, my_id):
        self.zk = zk_client
        self.path = election_path
        self.my_id = my_id
        self.my_node = None
        self.is_leader = False

    def run(self):
        # Create ephemeral sequential node
        self.my_node = self.zk.create(
            f"{self.path}/candidate-",
            value=self.my_id.encode(),
            ephemeral=True,
            sequence=True
        )
        self._check_leadership()

    def _check_leadership(self):
        children = sorted(self.zk.get_children(self.path))
        my_name = self.my_node.split("/")[-1]

        if children[0] == my_name:
            self.is_leader = True
            self._on_elected()
        else:
            # Watch predecessor
            my_index = children.index(my_name)
            predecessor = children[my_index - 1]
            if not self.zk.exists(
                f"{self.path}/{predecessor}",
                watch=self._predecessor_watcher
            ):
                # Predecessor already gone — recheck
                self._check_leadership()

    def _predecessor_watcher(self, event):
        if event.type == EventType.DELETED:
            self._check_leadership()

    def _on_elected(self):
        print(f"{self.my_id} is now the leader!")
```

### Recipe 2: Distributed Lock

A distributed lock ensures only one client can access a shared resource at a time. The lock must be released if the holder crashes.

**Algorithm**:

```
Acquire lock:
1. Create ephemeral sequential node under /locks/resource-X:
   create("/locks/resource-X/lock-", EPHEMERAL_SEQUENTIAL)
   → "/locks/resource-X/lock-0000000005"

2. Get children of /locks/resource-X, sorted

3. If my node is the smallest → lock acquired

4. If not → set watch on predecessor node, wait

Release lock:
1. Delete my node

Crash recovery:
- Node is ephemeral → auto-deleted on session expiry → lock released
```

This is essentially the same algorithm as leader election. The lock holder is the "leader" of the lock group.

**Read-write lock extension**: Create two types of sequential nodes — `read-lock-` and `write-lock-`. A read lock succeeds if there are no write locks with smaller sequence numbers. A write lock succeeds only if it has the smallest sequence number overall.

### Recipe 3: Group Membership

Track which servers are alive and part of a group.

```
/groups/my-service
├── member-0001  → "10.0.0.1:8080"  (ephemeral)
├── member-0002  → "10.0.0.2:8080"  (ephemeral)
└── member-0003  → "10.0.0.3:8080"  (ephemeral)
```

Each server creates an ephemeral node when it joins. Other servers watch the parent node's children to detect membership changes.

```python
class GroupMembership:
    def __init__(self, zk, group_path, my_address):
        self.zk = zk
        self.group_path = group_path
        self.my_address = my_address

    def join(self):
        self.zk.ensure_path(self.group_path)
        self.zk.create(
            f"{self.group_path}/member-",
            value=self.my_address.encode(),
            ephemeral=True,
            sequence=True
        )

    def get_members(self, watch=None):
        children = self.zk.get_children(self.group_path, watch=watch)
        members = []
        for child in children:
            data, stat = self.zk.get(f"{self.group_path}/{child}")
            members.append(data.decode())
        return members

    def watch_membership(self, callback):
        def watcher(event):
            members = self.get_members(watch=watcher)  # re-register
            callback(members)
        self.get_members(watch=watcher)
```

When a server crashes, its ephemeral node disappears, and the child watch fires on all other servers, updating their membership view.

### Recipe 4: Barrier

A barrier blocks all participants until a specified number have arrived, then releases all of them simultaneously.

```
/barrier/my-barrier
├── ready-0001  (ephemeral)     ← Process 1 arrived
├── ready-0002  (ephemeral)     ← Process 2 arrived
└── ready-0003  (ephemeral)     ← Process 3 arrived
                                    All 3 arrived → barrier lifts
```

```python
class Barrier:
    def __init__(self, zk, path, num_participants):
        self.zk = zk
        self.path = path
        self.num_participants = num_participants
        self.event = threading.Event()

    def wait(self):
        self.zk.ensure_path(self.path)
        self.zk.create(
            f"{self.path}/ready-",
            ephemeral=True,
            sequence=True
        )
        self._check_barrier()
        self.event.wait()

    def _check_barrier(self):
        children = self.zk.get_children(self.path, watch=self._watcher)
        if len(children) >= self.num_participants:
            self.event.set()

    def _watcher(self, event):
        self._check_barrier()
```

### Recipe 5: Configuration Management

Store configuration in a znode and watch for changes.

```python
class DynamicConfig:
    def __init__(self, zk, config_path):
        self.zk = zk
        self.config_path = config_path
        self.config = {}

    def load(self):
        data, stat = self.zk.get(self.config_path, watch=self._on_change)
        self.config = json.loads(data.decode())
        return self.config

    def _on_change(self, event):
        if event.type == EventType.CHANGED:
            self.load()  # re-read and re-watch
            self._notify_listeners()

    def update(self, new_config):
        self.zk.set(
            self.config_path,
            json.dumps(new_config).encode()
        )
```

This provides a "push" configuration model: when an operator updates the config znode, all connected services receive a watch notification and reload their configuration without restarting.

---

## Ordering Guarantees

ZooKeeper provides two important ordering guarantees:

### 1. FIFO Client Order

All requests from a single client are executed in the order the client issued them. If client C issues write(A) then write(B), ZooKeeper guarantees A is applied before B, even if they are processed by different servers due to reconnection.

This matters for patterns like:
```
1. write(/config/new, new_value)       ← Create new config
2. write(/config/active, "new")         ← Atomically switch to new config
```

FIFO ordering guarantees that step 1 completes before step 2. Any reader that sees `/config/active = "new"` can read `/config/new` and find the value there.

### 2. Linearizable Writes

All writes (state-changing operations) are linearizable — they appear to take effect at a single point in time, and that point is between the client's request and response. If two clients issue conflicting writes, one will complete before the other, and the final state reflects this order.

### What ZooKeeper Does Not Guarantee

**Reads are not linearizable by default.** A client connected to a follower may read stale data. If client A writes to the leader and client B reads from a follower before it has applied the write, B reads stale data.

```
Client A              Leader              Follower           Client B
   │                    │                    │                   │
   │── write(x=1) ────▶│                    │                   │
   │◀── OK ─────────── │                    │                   │
   │                    │── replicate ──────▶│                   │
   │                    │                    │  (not yet applied)│
   │                    │                    │◀── read(x) ──────│
   │                    │                    │── x=0 (stale!) ─▶│
   │                    │                    │                   │
   │                    │                    │ (applies write)   │
```

To get a linearizable read, use `sync` first:
```
Client B:
  sync()          → forces connected server to catch up with leader
  read(x)         → now guaranteed to return x=1
```

---

## The Herd Effect

The **herd effect** (also called the **thundering herd**) occurs when many clients all watch the same znode. When that znode changes, ZooKeeper must notify all watchers simultaneously, causing a spike in notifications and subsequent re-reads.

### The Problem

Naive leader election: all candidates watch the leader node.

```
/election
├── candidate-0001  (Server A) ← LEADER
├── candidate-0002  (Server B) ← watches candidate-0001
├── candidate-0003  (Server C) ← watches candidate-0001
├── candidate-0004  (Server D) ← watches candidate-0001
└── candidate-0005  (Server E) ← watches candidate-0001
```

When Server A crashes:
1. ZooKeeper sends 4 notifications (to B, C, D, E)
2. All 4 clients issue `getChildren` simultaneously
3. Only B becomes the leader; C, D, E all re-watch candidate-0001... but now it's B
4. Result: O(n) notifications and O(n) getChildren calls, but only one client changed state

With 1,000 candidates, this is 1,000 notifications and 1,000 getChildren calls for every leader change.

### The Solution: Watch Only Your Predecessor

```
/election
├── candidate-0001  (Server A) ← LEADER
├── candidate-0002  (Server B) ← watches candidate-0001
├── candidate-0003  (Server C) ← watches candidate-0002
├── candidate-0004  (Server D) ← watches candidate-0003
└── candidate-0005  (Server E) ← watches candidate-0004
```

When Server A crashes:
1. Only Server B receives a notification (1 notification, not 4)
2. Server B checks children, sees it's now the smallest → becomes leader
3. Servers C, D, E are unaffected

This reduces the notification complexity from O(n) to O(1) per leader change.

The same pattern applies to distributed locks. Each lock waiter watches only its predecessor in the queue, not the current lock holder.

---

## Comparison: ZooKeeper vs etcd

etcd, created for CoreOS and now the backbone of Kubernetes, is the primary alternative to ZooKeeper. The two systems serve the same role but differ significantly in design.

### Architecture

| Aspect | ZooKeeper | etcd |
|--------|-----------|------|
| Consensus protocol | ZAB | Raft |
| Data model | Hierarchical (tree) | Flat key-value (with prefix ranges) |
| Language | Java | Go |
| API | Custom binary protocol | gRPC + HTTP/JSON |
| Watch model | One-shot callbacks | Persistent watch streams |
| Read consistency | Eventual (local reads), linearizable with sync | Serializable (default), linearizable option |
| Lease model | Sessions with ephemeral nodes | Explicit leases attached to keys |
| Authentication | SASL, ACLs per znode | TLS client certs, RBAC |
| Maximum data per key | 1 MB (practical limit) | 1.5 MB |
| Total data limit | Limited by memory | Default 2 GB, configurable to 8 GB |

### Watch Streams vs One-Shot Watches

ZooKeeper's one-shot watches require clients to re-register after each notification. Between the notification and re-registration, changes can be missed.

etcd's watch streams deliver a continuous, ordered stream of events starting from a specified **revision** (etcd's equivalent of zxid):

```go
// etcd: watch all keys with prefix "/config/" starting from revision 42
watcher := clientv3.NewWatcher(client)
watchChan := watcher.Watch(
    context.Background(),
    "/config/",
    clientv3.WithPrefix(),
    clientv3.WithRev(42),
)

for response := range watchChan {
    for _, event := range response.Events {
        fmt.Printf("Type: %s, Key: %s, Value: %s\n",
            event.Type, event.Kv.Key, event.Kv.Value)
    }
}
```

Because watches are revision-based and persistent, a disconnected client can resume its watch from the last seen revision without missing events (as long as the history hasn't been compacted past that revision).

### Leases vs Ephemeral Nodes

ZooKeeper ties ephemeral nodes to sessions — an invisible, session-scoped mechanism. etcd makes leases explicit and reusable:

```go
// etcd: create a lease, attach keys to it
lease, _ := client.Grant(context.Background(), 10) // 10-second TTL

// Attach a key to the lease
client.Put(context.Background(), "/services/my-service/instance-1",
    "10.0.0.1:8080",
    clientv3.WithLease(lease.ID))

// Keep the lease alive (heartbeat)
keepAliveChan, _ := client.KeepAlive(context.Background(), lease.ID)

// Multiple keys can share one lease
client.Put(context.Background(), "/services/my-service/health",
    "ok",
    clientv3.WithLease(lease.ID))

// When the lease expires (or is revoked), ALL attached keys are deleted
```

This is more flexible than ZooKeeper's session model because:
- A client can have multiple leases with different TTLs
- Leases are first-class resources, not tied to the connection
- A key can be detached from a lease without deleting it

### Which to Use?

**Use ZooKeeper when**:
- You're running Kafka (before KRaft), HBase, Hadoop, or other systems that require it
- Your team has operational experience with it
- You need the hierarchical data model for complex coordination patterns

**Use etcd when**:
- You're running Kubernetes (etcd is the backing store)
- You prefer gRPC APIs and Go client libraries
- You need persistent watch streams (e.g., for event-driven configuration)
- You're starting a new project with no ZooKeeper dependency

**Consider Consul when**:
- You need combined service discovery + key-value + health checking
- You want a web UI out of the box
- Your primary use case is service mesh / multi-datacenter service discovery

---

## Real-World Usage

### Kafka (Before KRaft)

Kafka historically depended on ZooKeeper for:
- **Broker registration**: Each broker creates an ephemeral node. If a broker crashes, its node disappears and the controller detects the failure.
- **Controller election**: One broker is elected controller using ZooKeeper leader election. The controller manages partition leadership assignments.
- **Topic metadata**: Topic configurations, partition assignments, and ISR (in-sync replica) lists are stored in ZooKeeper.
- **Consumer group coordination** (old consumer): Consumer offsets and group membership were tracked in ZooKeeper.

Kafka's **KRaft mode** (Kafka Raft, GA since Kafka 3.3) eliminates ZooKeeper by implementing a Raft-based metadata quorum inside Kafka itself. The motivation: ZooKeeper was a separate operational burden, and the metadata stored there was tightly coupled to Kafka internals.

### HBase

HBase uses ZooKeeper for:
- **Region Server registration**: Each region server registers as an ephemeral node. The master detects failures via watch notifications.
- **Master election**: Active/standby master selection via ZooKeeper leader election.
- **Root table location**: The location of the META table (the root of HBase's region lookup hierarchy) is stored in ZooKeeper.

### Hadoop YARN

YARN (Yet Another Resource Negotiator) uses ZooKeeper for:
- **ResourceManager HA**: Active/standby ResourceManager election.
- **Fencing**: Preventing split-brain when the old ResourceManager hasn't realized it's been replaced.

### Kubernetes

Kubernetes uses etcd (not ZooKeeper) as its backing store for all cluster state:
- Pod definitions, service endpoints, config maps, secrets
- Controller state (deployment rollout progress, replica counts)
- Lease-based leader election for controllers and schedulers

The Kubernetes API server is the only component that talks to etcd directly. All other components interact through the API server, which handles watch translation and caching.

---

## Operational Considerations

### Cluster Sizing

ZooKeeper requires an odd number of servers: 3, 5, or 7. The ensemble can tolerate `(n-1)/2` failures:
- 3 servers: tolerates 1 failure (majority = 2)
- 5 servers: tolerates 2 failures (majority = 3)
- 7 servers: tolerates 3 failures (majority = 4)

More servers increase fault tolerance but slow down writes (more ACKs needed). Five servers is the most common production configuration — it handles two simultaneous failures while keeping write latency reasonable.

### What Not to Store in ZooKeeper

ZooKeeper is designed for coordination metadata, not application data:
- **Small data**: Each znode should hold kilobytes, not megabytes.
- **Low write rate**: Hundreds of writes per second, not thousands.
- **Few znodes**: Tens of thousands, not millions.

Violations of these guidelines cause:
- Memory pressure (entire dataset is in RAM)
- Session timeouts (leader overwhelmed by write load)
- Slow snapshots and recovery

### The GC Pause Problem

ZooKeeper is written in Java. A long garbage collection (GC) pause on the leader can cause:

1. Leader stops sending heartbeats to followers
2. Followers declare the leader dead
3. New election begins
4. GC completes, old leader resumes, discovers it's been deposed
5. All clients connected to the old leader see session disconnection

Mitigation:
- Use G1GC or ZGC with tuned pause targets
- Set ZooKeeper's `tickTime` and session timeouts higher than the worst-case GC pause
- Monitor GC pause times as a critical operational metric
- Run ZooKeeper on dedicated machines, not shared with application workloads

### Observers

For read-heavy workloads, ZooKeeper supports **observers** — servers that receive replicated state but don't participate in voting. They serve reads but don't slow down write quorums:

```
┌──────────┐  ┌──────────┐  ┌──────────┐
│ Voter 1  │  │ Voter 2  │  │ Voter 3  │
│ (Leader) │  │(Follower)│  │(Follower)│
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │
     ├─────────────┼─────────────┤
     │         Replication       │
     │             │             │
┌────┴─────┐  ┌───┴──────┐  ┌──┴────────┐
│Observer 1│  │Observer 2 │  │Observer 3 │
│(read only│  │(read only)│  │(read only)│
└──────────┘  └──────────┘  └───────────┘
```

Observers can be placed in remote datacenters to serve local reads without adding cross-datacenter latency to write quorums.

---

## Key Takeaways

1. **Don't build your own consensus.** Use ZooKeeper, etcd, or Consul. The coordination service handles the hard parts (leader election, session management, consistent replication) so your application doesn't have to.

2. **Ephemeral nodes are the key primitive.** They automatically clean up when a client fails, which is the foundation for leader election, locks, and group membership.

3. **Watch only your predecessor**, not the leader or the lock holder. This avoids the herd effect and scales coordination to many participants.

4. **Reads are stale by default** in ZooKeeper. Use `sync` + `read` for linearizable reads. etcd offers a linearizable read mode as a flag.

5. **Sessions, not connections, define liveness.** A client can survive a momentary network disruption and reconnect to a different server. But session expiry means all ephemeral state is gone.

6. **ZooKeeper is for metadata, not data.** Store coordination state (who is the leader, what's the config, who's alive) — not application records, not blobs, not logs.

7. **etcd is the modern alternative** with persistent watch streams, explicit leases, and gRPC APIs. Kubernetes's adoption makes it the default for new systems.

---

## References

- Hunt, P., et al. "ZooKeeper: Wait-free Coordination for Internet-scale Systems." USENIX ATC 2010.
- Junqueira, F., et al. "ZAB: High-performance broadcast for primary-backup systems." DSN 2011.
- Apache ZooKeeper documentation. "ZooKeeper Recipes and Solutions."
- Apache Curator documentation. curator.apache.org
- etcd documentation. etcd.io/docs
- Ongaro, D., Ousterhout, J. "In Search of an Understandable Consensus Algorithm (Extended Version)." USENIX ATC 2014.
- "Kafka Improvement Proposal KIP-500: Replace ZooKeeper with a Self-Managed Metadata Quorum."

---

**Next**: [Putting It Together — Raft Leader Election Trace →](putting-it-together.md)
