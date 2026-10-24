# Part 0: Jargon Buster

*Every term the Distributed Systems book throws at you, in plain English: what it means, an everyday picture, and why it matters. Skim it first, or come back whenever a word feels foreign.*

---

## Jargon 1: Basic Vocabulary

### Node, nodes
One machine (or process) taking part in the system. *One person in a group chat.*

### Cluster
A group of nodes working together as one system.

### Client / server
The client asks, the server answers. In distributed systems a node is often both.

### Process, thread
A process is a running program; threads are parallel tasks inside it.

### Latency, throughput, bandwidth
Latency: time for one request. Throughput: requests per second. Bandwidth: data per second the link can carry. A motorway can be wide (bandwidth) yet still a long drive (latency).

### Tail latency / p99
The slowest requests. p99 is the time 99% of requests beat. A system that calls many services is dragged by its slowest one.

### SLA, SLO, SLI
SLI: a measurement. SLO: your target. SLA: a contractual promise with penalties.

### Stateful, stateless
A stateless server remembers nothing between requests, so any server can serve any request. Stateful ones hold data you can't lose, which is where most of this book's difficulty lives.

### Deterministic
Same inputs always give the same outputs, with no randomness or hidden clock. Crucial for replicated state machines: replicas stay identical only if each step is deterministic.

### Idempotent, idempotency
Doing it twice equals doing it once. *Pressing a lift button twice.* The tool that makes retries safe.

### Exactly-once / at-least-once / at-most-once
Delivery promises. At-most-once: may lose messages, never duplicates. At-least-once: never loses, may duplicate. Exactly-once: the effect happens once, usually built from at-least-once plus idempotency.

---

## Jargon 2: Networks & Failure

### Packet, IP, TCP, UDP
Data travels in packets. IP addresses machines. TCP adds reliability and ordering (resends lost packets). UDP is fire-and-forget: faster, no guarantees.

### TLS, handshake
TLS encrypts a connection. A handshake is the opening exchange of messages that sets up a connection; it costs round trips.

### Socket
One end of a network connection that a program reads from and writes to.

### RPC
Remote Procedure Call: calling a function on another machine as if it were local. Hides the network, which is exactly why it's dangerous (see the fallacies).

### gRPC, Protobuf, Avro, JSON, serialization
Serialization converts data to bytes for sending. JSON is readable text; Protobuf and Avro are compact binary formats. gRPC is Google's RPC framework using Protobuf.

### Fallacies of distributed computing
Eight false beliefs programmers assume: the network is reliable, latency is zero, bandwidth is infinite, and so on. Each one bites in production.

### Congestion
Too much traffic for the network, causing delays and drops.

### Network partition
A network break that splits nodes into groups that can't talk to each other, though each group is still running. *A storm cutting a road between two villages.*

### Timeout
A deadline after which you give up on a reply. You can never know whether the other side is dead or just slow.

### Heartbeat
A regular "I'm alive" message. Silence beyond a threshold makes others suspect failure.

### Failure detector, phi accrual
A failure detector guesses who is dead. The phi accrual detector outputs a suspicion *level* based on how late the heartbeat is compared with its usual pattern, rather than a yes/no after a fixed timeout.

### Crash-stop, crash-recovery, omission, Byzantine
Failure types, from gentlest to worst. Crash-stop: dies and never returns. Crash-recovery: dies, restarts, may remember its disk. Omission: drops messages. Byzantine: behaves arbitrarily or maliciously, even lying.

### Two Generals problem
Two armies must attack together but can only message through an unreliable path; no protocol can make both certain. Shows why guaranteed agreement over an unreliable network is impossible.

### Synchronous / asynchronous / partially synchronous
A system model's timing assumptions. Synchronous: known bounds on delays. Asynchronous: no bounds at all. Partially synchronous: bounds exist but you don't know them, or they hold eventually. Real systems are closest to this last one.

### Fault injection / chaos engineering / Jepsen
Deliberately causing failures to test resilience. Jepsen is a famous test suite that breaks databases with partitions and clock skew and checks whether they keep their promises.

### Failure domain, availability zone, region
A failure domain is a group of things that fail together (a rack, a data centre). An AZ is one data centre inside a region; a region is a geographic area.

### Failover
Switching to a standby when the main node fails.

### Split brain
Two parts of the cluster each believe they're the leader and accept conflicting writes.

---

## Jargon 3: Time & Ordering

### Physical clock, NTP
A machine's wall-clock time. NTP is the protocol that syncs clocks over the network, accurate to milliseconds, never perfectly. Clocks drift and can jump backward.

### Clock skew / drift
Skew: two clocks disagree right now. Drift: a clock gradually runs fast or slow.

### Happens-before
A rule for ordering events without clocks: A happens-before B if A came first in the same process, or A sent a message that B received (or chained through such links). Events with no chain between them are *concurrent*.

### Lamport clock
A simple counter on each node, bumped on every event and sent on messages, that makes the order consistent with cause-and-effect. Cheap, but can't tell you whether two events were concurrent.

### Vector clock
A list of counters, one per node, that captures exactly which events caused which, so you can detect concurrent writes. Used to find conflicts rather than silently overwriting.

### TrueTime
Google Spanner's clock API: it returns a time *interval* with guaranteed bounds on the error. Spanner waits out the uncertainty so timestamps are trustworthy.

### Epoch / term
A numbered "reign" of a leader. A message from an older epoch is stale and rejected. Raft calls it a term.

### Lease
A time-limited right (to be leader, to hold a lock). Expires by itself if the holder crashes, but depends on clocks behaving.

### Fencing token
An increasing number issued with each lock or lease. Storage rejects any request with an older number, defeating a paused-then-resumed old leader.

### Causal consistency / causality
If action B was caused by A, every observer sees A before B. Weaker than linearizability, but cheap and intuitive.

---

## Jargon 4: Consistency & Replication

### Replication, replica, replicas, replicate
Copies of data on several nodes for durability and read scaling.

### Primary-backup, leader-follower, primary, backup
One node (primary/leader) takes writes and copies them to backups (followers). Simple; the hard parts are failover and lag.

### Leaderless replication
Any replica accepts writes; reads and writes go to several replicas, and quorums plus repair reconcile differences. Used by Dynamo-style systems like Cassandra.

### Chain replication
Replicas form a chain: writes enter at the head and flow to the tail; reads are served by the tail. Strong consistency with high throughput.

### Quorum, quorums
A majority (e.g. 2 of 3). If reads and writes each touch a majority, they must overlap, so a read sees the latest write.

### Replication lag
How far a follower is behind the leader.

### Synchronous vs asynchronous replication
Synchronous: leader waits for followers' acknowledgement; safe, slower. Asynchronous: leader replies first; fast, but a crash can lose acknowledged data.

### Read repair, hinted handoff, anti-entropy, Merkle tree
Leaderless repair tools. Read repair: fix stale replicas when a read notices them. Hinted handoff: a stand-in node holds writes for a down replica and hands them over later. Anti-entropy: background comparison to sync replicas. A Merkle tree is a tree of hashes that lets two replicas find differing data by comparing a few hashes instead of everything.

### Gossip
Nodes periodically swap information with random peers so news spreads like a rumour. No central coordinator needed.

### Eventual consistency
If writes stop, all replicas eventually converge. In the meantime, reads can be stale.

### Strong consistency
Reads always see the latest write, as if there were one copy.

### Linearizability, linearizable
The strongest single-object guarantee: every operation appears to take effect instantly at some moment between its start and end, and all clients agree on that order. *There's exactly one copy and everyone watches the same scoreboard.* Also called strong or atomic consistency.

### Serializability, serializable
For transactions: the result equals running them one after another in some order. It says nothing about real-time order. Strict serializability = serializable and in real-time order (a.k.a. external consistency in Spanner).

### Isolation level, MVCC
Isolation levels set how much concurrent transactions can see of each other. MVCC (multi-version concurrency control) keeps multiple versions of each row so readers don't block writers.

### CAP theorem, PACELC
CAP: when a partition happens you must choose consistency or availability. PACELC adds that, even without a partition, there's a latency-vs-consistency trade.

### CRDT
Conflict-free Replicated Data Type: a data structure designed so that concurrent updates always merge to the same result, regardless of order. Powers collaborative editing.

### Tombstone
A marker that says "this was deleted". Needed so a delete spreads to replicas; the data is only purged later.

---

## Jargon 5: Consensus & Coordination

### Consensus
Getting several nodes to agree on one value even when some fail. The foundation for leader election and replicated logs.

### Paxos, Raft
The two famous consensus algorithms. Paxos is notoriously hard to understand. Raft was designed to be understandable: elect a leader, replicate a log, commit when a majority has it.

### Leader election
Choosing exactly one node to coordinate. Must survive failures without producing two leaders.

### Log replication, state machine
Replicated state machine: every node applies the same ordered log of commands to the same deterministic program, so all end in the same state. Consensus decides the log order.

### Commit
The point at which an entry is safe and will never be undone, usually once a majority has stored it.

### FLP impossibility
A proof that in a fully asynchronous system, no algorithm can guarantee consensus if even one node may crash. Real algorithms sidestep it with timeouts and randomness.

### Safety vs liveness
Safety: nothing bad ever happens (never two leaders). Liveness: something good eventually happens (a leader is eventually elected). Consensus keeps safety always and liveness when the network is calm.

### ZooKeeper, etcd
Small, strongly consistent coordination services storing configuration, locks, and leader identity. Built on consensus; other systems rely on them rather than implementing consensus themselves.

### Byzantine fault tolerance (BFT)
Reaching agreement even if some nodes lie or are hacked. Needs 3f+1 nodes to tolerate f liars. Used in blockchains.

### Coordinator
The node that drives a multi-node operation, such as a transaction.

### Two-phase commit (2PC)
Phase 1: the coordinator asks all participants "can you commit?". Phase 2: if all say yes it orders "commit", else "abort". Gives atomicity across nodes but blocks if the coordinator dies mid-way.

### Saga
A long transaction as a sequence of local steps, each with a compensating "undo" action. Trades strict atomicity for availability.

---

## Jargon 6: Storage Engines & Data Infrastructure

### Write-ahead log (WAL)
Append the intended change to a durable log before applying it. After a crash, replay the log. The same idea underlies databases and Raft.

### fsync
The system call that forces buffered data out of memory onto the physical disk. Without it, "written" data can vanish in a power cut. Expensive, so it's the heart of durability trade-offs.

### Checkpoint / snapshot
A saved copy of state at a point in time so recovery needn't replay the whole log.

### B-tree
A sorted tree with wide nodes used for database indexes; updates data in place. Good for reads.

### LSM tree, memtable, SSTable, compaction
Log-structured merge tree: writes go to an in-memory memtable, flushed in bulk as sorted immutable files (SSTables); background compaction merges them. Very fast writes. Used by Cassandra, RocksDB.

### Write amplification / read amplification
How many extra disk writes (or reads) happen per logical write (or read), e.g. from compaction. A key cost measure for storage engines.

### Bloom filter
A tiny structure that says "definitely not here" or "maybe here", letting you skip disk reads.

### SSD / HDD
Solid-state vs spinning-disk drives. SSDs are much faster at random access.

### GFS, chunkserver
Google File System: a distributed file system that splits files into big chunks stored on many chunkservers, with a single master tracking where chunks live.

### Sharding, partitioning, rebalancing
Splitting data across nodes, and moving it when nodes join or leave. (A "partition" can also mean a network break; context tells you which.)

### Consistent hashing
Placing nodes and keys on a ring so that adding or removing a node only moves a small share of keys.

### Cache, TTL
A fast copy of data; TTL is how long it stays valid.

### S3 / object storage
Cheap, durable storage of large files by name, with no in-place updates.

### Cassandra, DynamoDB, MongoDB, PostgreSQL, MySQL, Redis, Spanner, CockroachDB
Cassandra and DynamoDB: leaderless, highly available key-value-style stores. MongoDB: document database. PostgreSQL and MySQL: relational databases. Redis: in-memory store. Spanner and CockroachDB: globally distributed SQL databases with strong consistency.

---

## Jargon 7: Data Pipelines & Messaging

### Message queue, pub/sub
A queue buffers jobs between services. Pub/sub broadcasts each message to all subscribers.

### Kafka
A distributed, replicated, append-only log. Producers append; consumers read at their own offset and can replay. Topics are split into partitions for scale.

### Producer, consumer, consumer group, offset
Producer writes messages, consumer reads. A consumer group shares a topic's partitions among its members. The offset is a consumer's position in the log.

### Backpressure
A slow consumer pushing back so the producer slows down.

### Dual write
Writing to two systems (database and queue) in separate steps; a crash between them leaves them inconsistent. The classic bug.

### Transactional outbox
Fix for dual write: write the event into an "outbox" table in the same database transaction as the data, then a separate process publishes it to the queue.

### Change data capture (CDC), Debezium
Streaming every database change out of its log to other systems. Debezium is a common CDC tool.

### MapReduce, shuffle
A model for processing huge data: map (process pieces in parallel), shuffle (regroup by key across the network), reduce (combine). Spark is a modern descendant.

### Batch vs stream processing
Batch: process a big pile at once, later. Stream: process each event as it arrives.

### Microservices, container, Kubernetes
Many small services, packaged in containers, orchestrated by Kubernetes. Each network hop is a new failure point.

### API gateway, load balancer, service mesh
Gateway: front door for APIs. Load balancer: spreads requests over servers. Service mesh: a layer of sidecar proxies that handle retries, encryption, and tracing between services.

### Retry, exponential backoff, jitter, circuit breaker, thundering herd
Retry safely with growing, randomised delays; trip a circuit breaker to stop calling a failing service; avoid a thundering herd of simultaneous retries.

### Observability, tracing, telemetry
Logs, metrics, and traces that show what the system is doing; tracing follows one request across services.
