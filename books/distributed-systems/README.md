# Distributed Systems: From First Principles to Production

## Who Is This For?

Software engineers who can write production code and understand databases — but have never built anything that runs across more than one machine and find that terms like "linearizability," "consensus," or "vector clocks" either never come up in System Design resources or appear only as jargon without explanation.

This book assumes you have already read the [SystemCanvas System Design book](../system-design/) (or equivalent) and want to understand *why* the building blocks work, *what* can go wrong at a protocol level, and *how* researchers proved the fundamental limits of what distributed systems can guarantee.

---

## Table of Contents

### Part 1: The Distributed System Contract
*Every distributed systems concept is a response to the same root problem: machines fail, networks lie, and time is unreliable.*

| # | Chapter | Core Question |
|---|---------|--------------|
| 1 | [Why Distributed Systems Are Fundamentally Hard](part1/ch01-why-distributed-systems-are-hard.md) | What makes code that runs across multiple machines so different from code on one? |
| 2 | [Networking Primitives](part1/ch02-networking-primitives.md) | What is actually happening at the wire level when two servers talk? |
| 3 | [Failure Taxonomy](part1/ch03-failure-taxonomy.md) | Are all failures the same, or do different kinds require different solutions? |
| 4 | [System Models](part1/ch04-system-models.md) | What timing assumptions can a distributed algorithm safely make? |
| 5 | [The Two Generals Problem](part1/ch05-two-generals-problem.md) | Why is perfect agreement over an unreliable link mathematically impossible? |
| 6 | [RPC and the Eight Fallacies](part1/ch06-rpc-and-fallacies.md) | What assumptions will silently destroy a distributed system? |
| 7 | [Failure Detection](part1/ch07-failure-detection.md) | How does a system decide a server is gone when it might just be slow? |
| 8 | [Phi Accrual Failure Detectors](part1/ch08-phi-accrual-failure-detectors.md) | Is there a smarter failure detector than a hardcoded timeout? |
| | [Putting It Together: The Failed Payment](part1/putting-it-together.md) | Trace a failed payment across five microservices |

### Part 2: Time, Clocks & Storage Engines
*Before any data can be replicated or any conflict resolved, the system needs a way to order events.*

| # | Chapter | Core Question |
|---|---------|--------------|
| 9 | [Physical Clocks, NTP, and Clock Skew](part2/ch09-physical-clocks.md) | Can I use a timestamp to decide which write arrived first? |
| 10 | [Lamport Clocks and Happens-Before](part2/ch10-lamport-clocks.md) | If wall clocks are untrustworthy, how do I order distributed events? |
| 11 | [Vector Clocks and Causal Ordering](part2/ch11-vector-clocks.md) | How does Dynamo track which version of a shopping cart is newer? |
| 12 | [The Consistency Model Hierarchy](part2/ch12-consistency-models.md) | What exactly do engineers mean when they say "consistent"? |
| 13 | [Linearizability: Herlihy's Formal Definition](part2/ch13-linearizability.md) | What is the strongest correctness guarantee, precisely stated? |
| 14 | [Storage Engines: B-trees vs LSM Trees](part2/ch14-storage-engines.md) | Why does internal data structure determine app performance at scale? |
| 15 | [Write-Ahead Logs and Crash Recovery](part2/ch15-write-ahead-logs.md) | How does a database survive a power outage? |
| 16 | [GFS Internals](part2/ch16-gfs-internals.md) | What does a real distributed file system look like under the hood? |
| | [Putting It Together: Vector Clock Chat](part2/putting-it-together.md) | Build a vector-clock-based event log for a three-node chat system |

### Part 3: Replication and Consensus
*Replication is how distributed systems survive failures; consensus is how they agree on a single truth.*

| # | Chapter | Core Question |
|---|---------|--------------|
| 17 | [Primary-Backup Replication](part3/ch17-primary-backup-replication.md) | What happens inside a replicated database at the message level? |
| 18 | [Leaderless Replication and Quorums](part3/ch18-leaderless-replication.md) | What if every replica can accept writes? |
| 19 | [Chain Replication](part3/ch19-chain-replication.md) | Is there a cleaner alternative to Paxos for replicated storage? |
| 20 | [CAP Theorem: The Proof](part3/ch20-cap-theorem.md) | Why can't any system guarantee C, A, and P simultaneously? |
| 21 | [FLP Impossibility](part3/ch21-flp-impossibility.md) | Why can no deterministic algorithm guarantee consensus with one crash? |
| 22 | [Raft: Full Algorithm and Safety Proof](part3/ch22-raft.md) | How does Raft guarantee exactly one leader per term? |
| 23 | [Testing: Jepsen and Chaos Engineering](part3/ch23-testing-distributed-systems.md) | How do you test failure paths that never occur in dev? |
| 24 | [ZooKeeper and Coordination Services](part3/ch24-zookeeper.md) | How do real systems use consensus for elections, locks, and config? |
| | [Putting It Together: Raft Leader Election](part3/putting-it-together.md) | Walk through a Raft leader election from scratch |

### Part 4: Transactions, Data Processing, and Production
*Applying replication and consensus to distributed transactions, large-scale data processing, and production operations.*

| # | Chapter | Core Question |
|---|---------|--------------|
| 25 | [Serializability vs Linearizability](part4/ch25-serializability-vs-linearizability.md) | What's the difference between transaction isolation and distributed consistency? |
| 26 | [Two-Phase Commit](part4/ch26-two-phase-commit.md) | What must a participant do after voting YES when the coordinator crashes? |
| 27 | [Spanner's TrueTime](part4/ch27-spanner-truetime.md) | How does Google commit cross-continental transactions with external consistency? |
| 28 | [CRDTs](part4/ch28-crdts.md) | Can a data structure merge conflicting writes without coordination? |
| 29 | [MapReduce](part4/ch29-mapreduce.md) | How does Google process petabytes reliably when machines crash mid-job? |
| 30 | [Stream Processing: Kafka Internals](part4/ch30-kafka-internals.md) | How does Kafka guarantee exactly-once delivery? |
| 31 | [The Dual-Write Problem and Outbox Pattern](part4/ch31-dual-write-outbox.md) | How to keep a database and message bus in sync without 2PC? |
| 32 | [Byzantine Fault Tolerance](part4/ch32-byzantine-fault-tolerance.md) | What if nodes are actively sending false information? |
| | [Putting It Together: Flight Booking](part4/putting-it-together.md) | Design a flight booking system with the Outbox pattern |

### Part 5: Capstone System Designs
*Worked examples exercising five or more concepts from Parts 1–4, focused on correctness and failure behavior.*

| # | System | Key Concepts |
|---|--------|-------------|
| 1 | [Distributed Key-Value Store](part5/capstone01-distributed-kv-store.md) | Replication, quorums, failure detection, linearizability, split-brain |
| 2 | [Distributed Ledger / Payment System](part5/capstone02-distributed-ledger.md) | 2PC recovery, Outbox, idempotency, saga compensation, exactly-once |
| 3 | [Real-Time Collaborative Editor](part5/capstone03-collaborative-editor.md) | CRDTs, vector clocks, causal consistency, conflict-free merges |
| 4 | [Distributed Log Service](part5/capstone04-distributed-log.md) | Append-only replication, consumer groups, exactly-once, ISR |
| 5 | [Fault-Tolerant Batch Analytics](part5/capstone05-batch-analytics.md) | GFS chunks, straggler mitigation, deterministic reducers, data locality |
| 6 | [Globally Distributed Database](part5/capstone06-global-database.md) | TrueTime, Paxos groups, external consistency, cross-shard transactions |

---

## How to Read This Book

**Linear path**: Read Parts 1 → 2 → 3 → 4 → 5 in order. Each part builds on the one before it.

**Reference path**: Jump to any chapter that answers a question you have right now. Each chapter lists its prerequisites at the top.

**Interview prep path**: Read Chapters 1, 5, 12–13, 20–22, 26, and the capstone designs.

## Prerequisites

- Comfort with at least one programming language (examples use Python, Go, and pseudocode)
- Understanding of databases (SQL, indexes, transactions at a user level)
- The [SystemCanvas System Design book](../system-design/) or equivalent knowledge of load balancers, caches, message queues, and microservice architecture
