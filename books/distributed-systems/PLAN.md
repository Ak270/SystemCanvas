# Distributed Systems: From First Principles to Production

## Who Is This For?

Software engineers who can write production code and understand databases — but have never built anything that runs across more than one machine and finds that terms like "linearizability," "consensus," or "vector clocks" either never come up in System Design resources or appear only as jargon without explanation. This book assumes you have already read the SystemCanvas System Design book (or equivalent) and want to understand *why* the building blocks work, *what* can go wrong at a protocol level, and *how* researchers proved the fundamental limits of what distributed systems can guarantee.

## What You'll Learn

- How to reason precisely about failure — distinguish crash-stop, omission, and Byzantine faults and know which algorithm tolerates which
- Why wall clocks can never be trusted to order events across machines, and how Lamport and vector clocks solve the problem
- The formal definition of linearizability (Herlihy 1990) and why it's the bedrock correctness guarantee every storage paper builds on
- Why the FLP impossibility result means no consensus algorithm can be both safe and live in an asynchronous system — and why we build consensus systems anyway
- The full Raft algorithm: every message, every edge case, and the safety proof that only one leader can be elected per term
- What "2PC in-doubt state" means and exactly what a participant must do when the coordinator disappears after a vote of YES
- How Google Spanner uses GPS and atomic clocks to commit cross-continental transactions with external consistency
- How to design data structures (CRDTs) that merge automatically across replicas without any coordination
- How MapReduce tolerates stragglers and worker crashes to reliably process petabytes
- How Kafka achieves exactly-once delivery semantics across partitions with idempotent producers and transactional APIs
- How to test distributed systems with fault injection (Jepsen) and chaos engineering (Netflix FIT)
- How to keep a database and a message bus in sync without distributed transactions using the Outbox pattern

## Topics Most Resources Miss

| Topic | Why It Matters | Where It Fits |
|-------|---------------|---------------|
| Failure detection: slow = dead | Practitioners learn the hard way that a timeout is a guess, not a fact — no book explains the formal model | Part 1, Ch 7–8 |
| Phi accrual failure detectors | Cassandra's actual detection mechanism; smarter than a fixed timeout | Part 1, Ch 8 |
| Eventual consistency: concrete examples | Developers assume it means "buggy" instead of a deliberate AP trade-off | Part 2, Ch 12 |
| 2PC in-doubt state | The exact scenario books gloss over: what does a participant do after voting YES when the coordinator vanishes? | Part 4, Ch 26 |
| Dual-write problem & Outbox pattern | The most common data-consistency bug in event-driven systems — not covered in any major DS resource | Part 4, Ch 31 |
| Schema evolution in event-driven systems | Changing an event schema breaks consumers; how to version safely with Avro/Protobuf | Part 4, Ch 30 |
| Testing distributed systems (Jepsen, chaos engineering) | Untested error-handling code causes the majority of catastrophic failures — yet no textbook covers it | Part 3, Ch 23 |
| Debugging with distributed tracing | Reconstructing causality across 10 services from logs requires clock-skew-aware tooling | Part 4, Ch 31 |
| Theory-to-practice synthesis | The "space between" reading a paper and building the thing — Marc Brooker's identified gap | Capstone designs (Part 5) |

## Complete Chapter Plan

### Part 1: The Distributed System Contract (Layer 1)
Every distributed systems concept is a response to the same root problem: machines fail, networks lie, and time is unreliable. This part establishes the vocabulary and failure models that all later theory depends on.

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 1 | Why Distributed Systems Are Fundamentally Hard | What makes code that runs across multiple machines so different from code that runs on one? |
| 2 | Networking Primitives (TCP, UDP, latency, packet loss) | What is actually happening at the wire level when two servers talk? |
| 3 | Failure Taxonomy: Crash-Stop, Crash-Recovery, Omission, Byzantine | Are all failures the same, or do different kinds of failure require completely different solutions? |
| 4 | System Models: Synchrony, Asynchrony, and Partial Synchrony | What timing assumptions can a distributed algorithm safely make? |
| 5 | The Two Generals Problem | Why is it mathematically impossible for two machines to reach perfect agreement over an unreliable link? |
| 6 | RPC and the Eight Fallacies of Distributed Computing | What assumptions will silently destroy a distributed system that seemed fine in testing? |
| 7 | Failure Detection: You Can't Tell Dead from Slow | How does a system decide a server is gone when it might just be overloaded? |
| 8 | Phi Accrual Failure Detectors | Is there a smarter failure detector than a hardcoded timeout — and what does Cassandra actually use? |

**Putting It Together**: Trace a failed payment across five microservices. Given only the logs and timestamps, reconstruct what happened, identify which server caused the timeout, and determine whether the payment was charged. This exercise reveals why failure detection, system models, and RPC semantics all matter in a real incident.

---

### Part 2: Time, Clocks & Storage Engines (Layer 2–3)
Before any data can be replicated or any conflict can be resolved, the system needs a way to order events. This part covers the clock problem formally, builds up to the full consistency model hierarchy, and explains how storage engines actually persist data reliably.

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 9 | Physical Clocks, NTP, and Clock Skew | Can I use a timestamp to decide which of two writes arrived first? |
| 10 | Lamport Clocks and the Happens-Before Relation | If wall clocks are untrustworthy, how do I know which distributed event happened first? |
| 11 | Vector Clocks and Causal Ordering | How does Amazon Dynamo track which version of a shopping cart is newer when two conflicting writes arrive simultaneously? |
| 12 | The Consistency Model Hierarchy (linearizability → sequential → causal → eventual) | What exactly do engineers mean when they say a system is "consistent"? |
| 13 | Linearizability: Herlihy's Formal Definition | What is the strongest correctness guarantee a distributed data store can offer, precisely stated? |
| 14 | Storage Engines: B-trees vs LSM Trees | Why does the database's internal data structure determine whether my app is fast or slow at scale? |
| 15 | Write-Ahead Logs (WAL) and Crash Recovery | How does a database survive a power outage without losing the last 10 seconds of writes? |
| 16 | GFS Internals: Chunk Servers, Leases, and Atomic Record Append | What does a real distributed file system look like under the hood — and how does it tolerate master failures? |

**Putting It Together**: Build a vector-clock-based event log for a three-node distributed chat system. Use it to reconstruct causal message order even when messages arrive out of order. Extend it to detect concurrent writes and simulate the Dynamo conflict resolution model.

---

### Part 3: Replication and Consensus (Layer 3–4)
Replication is how distributed systems survive failures; consensus is how they agree on a single truth. This part goes from the mechanics of primary-backup replication all the way to the full Raft safety proof — and covers the impossibility results that explain why consensus is hard.

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 17 | Primary-Backup Replication: Deep Mechanics | What exactly happens inside a replicated database at the message level when a write arrives? |
| 18 | Leaderless Replication and Quorum Reads/Writes | What if every replica can accept writes? How does Dynamo-style replication work and what consistency does it actually provide? |
| 19 | Chain Replication | Is there a cleaner, more formally verifiable alternative to Paxos for building replicated storage? |
| 20 | CAP Theorem: The Proof, Not the Slogan | Why can't any distributed system simultaneously guarantee perfect consistency, availability, and partition tolerance — and why is partition tolerance not optional? |
| 21 | FLP Impossibility | Why can no deterministic algorithm guarantee consensus in an asynchronous system with even one crash-faulty process? |
| 22 | Raft: Full Algorithm and Safety Proof | How does Raft guarantee that exactly one leader is elected per term, and what prevents two leaders from committing conflicting log entries? |
| 23 | Testing Distributed Systems: Jepsen and Chaos Engineering | How do you test failure paths that never occur in your dev environment — and what does Netflix's Failure Injection Testing actually verify? |
| 24 | ZooKeeper and Coordination Services | How do real systems use a consensus service to coordinate distributed elections, locks, and configuration? |

**Putting It Together**: Walk through a Raft leader election from scratch. Draw every message when a leader crashes mid-replication: the follower timeouts, the vote campaign, the new leader's log reconciliation, and the point at which committed entries are safe. Then simulate a network partition healing and trace what happens to diverged log entries.

---

### Part 4: Transactions, Data Processing, and Production (Layer 5–6)
With replication and consensus in hand, the final layer applies them to distributed transactions, large-scale data processing, and the operational realities of running these systems in production.

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 25 | Serializability vs Linearizability: Why They're Different | What is the difference between database transaction isolation and distributed consistency — and why combining them is expensive? |
| 26 | Two-Phase Commit: The Full Protocol Including In-Doubt State | What exactly must a participant do after voting YES when the coordinator crashes and never recovers? |
| 27 | Spanner's TrueTime and External Consistency | How does Google commit a read-write transaction across datacenters on different continents with a guarantee stronger than serializable? |
| 28 | CRDTs: Eventual Consistency Without Coordination | Can I design a data structure that automatically merges conflicting writes across replicas without any locking or consensus round? |
| 29 | MapReduce: The Fault-Tolerant Batch Execution Model | How does Google process 20 petabytes per day reliably even when 10% of machines crash mid-job? |
| 30 | Stream Processing: Kafka Internals, Exactly-Once, and Schema Evolution | How does Kafka guarantee that every event is processed exactly once — and what happens to consumers when an event schema changes? |
| 31 | The Dual-Write Problem and the Outbox Pattern | How do I keep my relational database and my message bus in sync without using 2PC — and what is the production-grade solution? |
| 32 | Byzantine Fault Tolerance (PBFT) | What if some nodes in my distributed system are actively sending false or malicious information — and how many such nodes can a system tolerate? |

**Putting It Together**: Design a flight booking system. Two databases hold seat inventory and payment records on separate services. Implement the Outbox pattern to guarantee that a seat is reserved if and only if the payment succeeds — without 2PC. Write a compensating saga for the failure case where the payment service goes down after the seat is reserved.

---

### Part 5: Capstone System Designs

Each design is a worked example that exercises five or more concepts from Parts 1–4. Unlike the System Design book's capstones (which focus on architecture and scale), these designs focus on the correctness and failure behavior of the distributed protocol at the heart of each system.

| # | System | Key Concepts Practiced |
|---|--------|----------------------|
| 1 | Distributed Key-Value Store (Redis-like) | Primary-backup replication, quorum reads, failure detection, linearizability, split-brain prevention |
| 2 | Distributed Ledger / Payment System | 2PC in-doubt recovery, Outbox pattern, idempotency, saga compensation, exactly-once semantics |
| 3 | Real-Time Collaborative Editor (Google Docs–like) | CRDTs, vector clocks, causal consistency, conflict-free merges, operational transform comparison |
| 4 | Distributed Log Service (Kafka-like) | Append-only replication, consumer group coordination, exactly-once delivery, ISR (in-sync replica) management |
| 5 | Fault-Tolerant Batch Analytics (MapReduce-like) | GFS chunk replication, straggler mitigation, deterministic reducers, task re-execution, data locality |
| 6 | Globally Distributed Transactional Database (Spanner-like) | TrueTime commit wait, Paxos group replication, external consistency, cross-shard transactions, 2PC over Paxos groups |

---

## Topics We Reference (Not Repeat) from System Design Book

The following topics are covered at a working-engineer level in the SystemCanvas System Design book. The Distributed Systems book links to those chapters for context and builds on them without re-explaining the basics.

| Topic | System Design Book Coverage | DS Book's Role |
|-------|----------------------------|---------------|
| DNS | Full chapter: resolution, TTL, record types | Link only |
| Load Balancers (L4/L7) | Full chapter: round robin, least-connections, health checks | Link only |
| CDN | Full chapter: push vs pull, edge caching | Link only |
| Message Queues (Kafka, RabbitMQ patterns) | Full chapter: async work, fan-out, dead-letter queues | Link to surface usage; DS book covers Kafka internals (exactly-once, ISR) |
| Rate Limiting | Full chapter: token bucket, sliding window | Link only |
| Microservices vs Monolith | Full chapter: decomposition, bounded contexts | Link only |
| Service Discovery | Full chapter: client-side vs server-side | Link only |
| Circuit Breaker | Full chapter: half-open state, failure thresholds | Link only |
| WebSockets & Real-Time | Full chapter: long polling, SSE, WebSockets | Link only |
| Idempotency Keys | Covered in Payment System design | DS book covers formal exactly-once semantics in Kafka |
| CQRS / Event Sourcing | Full chapter: read model rebuild, event store | Link only; DS book covers schema evolution in event streams |
| SQL vs NoSQL selection | Full chapter: trade-off table | Link only |
| OLTP vs OLAP | Full chapter: column stores, data warehouses | Link only |
| Geo-routing & Multi-Region | Full chapter: latency-based routing, active-active | Link only; DS book covers external consistency across regions |
| Consistent Hashing | Full chapter: virtual nodes, rehashing math | DS book adds: formal O(K/N) key movement proof, DHT internals (Chord/Kademlia) |
| Replication (surface) | Full chapter: leader-follower, sync vs async | DS book adds: formal consistency models, chain replication, Raft as linearizable replication |
| CAP Theorem (surface) | Full chapter: CA/CP/AP examples | DS book adds: Gilbert-Lynch formal proof, PACELC extension |
| Consensus Raft/Paxos (surface) | Named as building block for leader election | DS book covers the full algorithm, safety proof, liveness conditions |
| Distributed Transactions (surface) | Saga pattern, 2PC named in Payment System | DS book covers 2PC blocking problem, in-doubt state, Spanner's approach |
| Distributed Locking (surface) | Redlock, ZooKeeper mentioned | DS book covers why Redlock is controversial, ZooKeeper's wait-free hierarchy |
| Bloom Filters | Full chapter: false positive rate, use cases | DS book does not repeat; links to System Design chapter |
| Failure Patterns | Full chapter: cascading failures, split-brain, thundering herd | DS book adds: formal failure taxonomy, FLP impossibility, Byzantine faults |
