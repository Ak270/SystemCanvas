# System Design — Book Plan

## Who Is This For?

Anyone who wants to understand how large-scale systems work — from a fresh developer who just learned to code, to a senior engineer preparing for system design interviews.

## What You'll Learn

How to design systems that handle millions of users — the concepts, the building blocks, the patterns, and the trade-offs. By the end, you'll be able to design systems like WhatsApp, YouTube, and Uber from scratch.

---

## Chapter Plan

Based on research across DDIA (Kleppmann), System Design Interview (Alex Xu Vol 1 & 2), Grokking (DesignGurus), ByteByteGo, and Stanford/MIT distributed systems courses.

Topics ordered by dependency graph (each layer needs the layers above it).

### Part 1: Foundations — The "Why" Before the "How" (Layer 1-2)

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 1 | What is System Design? | Why can't I just write code and deploy? |
| 2 | Scalability | What happens when 1 user becomes 1 million? |
| 3 | Availability & Reliability | How do I make sure my system never goes down? |
| 4 | Latency vs Throughput | Why is my app fast for me but slow for users in India? |
| 5 | Consistency Models | If two users update the same data, who wins? |
| 6 | CAP & PACELC Theorems | Why can't I have everything? |
| 7 | ACID vs BASE | When do I need strict rules vs speed? |
| 8 | Back-of-Envelope Estimation | How do I calculate if my design can handle the load? |

**Putting It Together**: Design a simple notes app — discuss which trade-offs you'd make for 100 users vs 10 million users.

### Part 2: Building Blocks — The Toolbox (Layer 3)

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 9 | DNS | How does "google.com" become a server? |
| 10 | Load Balancers | How do I handle 10x traffic overnight? |
| 11 | Reverse Proxy & API Gateway | Who guards the front door? |
| 12 | Databases — SQL vs NoSQL | Where should I store my data? |
| 13 | Database Indexing | Why is my query taking 10 seconds? |
| 14 | Database Sharding | My database is too big for one machine. Now what? |
| 15 | Database Replication | What if my database machine dies? |
| 16 | Caching | How do I stop hitting the database for the same data? |
| 17 | CDN | How does Netflix stream fast everywhere? |
| 18 | Message Queues | How do I handle work that takes 5 minutes? |
| 19 | Rate Limiting | How do I stop one user from killing my servers? |
| 20 | Object Storage | Where do I put my images and videos? |
| 21 | Search Infrastructure | How does Google find results in 0.3 seconds? |

**Putting It Together**: Trace a request through an e-commerce system — from typing the URL to seeing the product page. Show every building block in action.

### Part 3: Patterns & Architecture — The Playbook (Layer 4-5)

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 22 | Microservices vs Monolith | Should I split my app into pieces? |
| 23 | Event-Driven Architecture | How do services talk without waiting? |
| 24 | CQRS & Event Sourcing | What if reads and writes need completely different shapes? |
| 25 | Consistent Hashing | How do I add servers without reshuffling everything? |
| 26 | Circuit Breaker & Retry | What happens when a service I depend on dies? |
| 27 | Idempotency | What if the same request hits my server twice? |
| 28 | API Design (REST, gRPC, GraphQL) | How should services communicate? |
| 29 | WebSockets & Real-Time | How do I push live updates to users? |
| 30 | Data Serialization | JSON vs Protobuf — when does format matter? |
| 31 | Service Discovery | How do services find each other? |
| 32 | Observability (Metrics, Logging, Tracing) | How do I know my system is healthy? |

**Putting It Together**: Design the backend of a food delivery app — showing which pattern solves which problem.

### Part 4: Distributed Systems — The Hard Stuff (Layer 6)

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 33 | Consensus (Raft, Paxos) | How do machines agree on one truth? |
| 34 | Leader Election | Who's in charge when there are multiple servers? |
| 35 | Distributed Locking | How do I prevent two servers from doing the same thing? |
| 36 | Distributed Transactions (2PC, Saga) | How do I update data across multiple services safely? |
| 37 | Bloom Filters | How do I check billions of items in milliseconds? |
| 38 | Heartbeats & Health Checks | How do I detect dead servers? |
| 39 | Geo-Routing & Multi-Region | How do I serve users on every continent? |
| 40 | Data Warehousing & Analytics (OLTP vs OLAP) | How do I analyze petabytes of data? |
| 41 | Failure Patterns (Cascading Failures, Thundering Herd, Split Brain) | What are the scariest ways systems break? |

**Putting It Together**: Walk through how a payment system works across regions — consistency, failover, and recovery.

### Part 5: Real System Designs — The Practice (Layer 7, Capstone)

Full worked examples. Each one exercises 5+ concepts from Parts 1-4.

| # | System | Key Concepts Practiced |
|---|--------|----------------------|
| 1 | Design WhatsApp | WebSockets, message queues, presence, E2E encryption, connection management |
| 2 | Design YouTube | Video transcoding, CDN, adaptive bitrate, object storage, recommendation |
| 3 | Design URL Shortener | Hashing, key generation, caching, analytics pipeline, database choice |
| 4 | Design Twitter/News Feed | Fan-out (write vs read), ranking, caching, pub/sub, timeline generation |
| 5 | Design Uber | Geo-hashing, real-time matching, surge pricing, location tracking |
| 6 | Design Google Search | Web crawling, inverted index, PageRank, caching at scale |
| 7 | Design Notification System | Multi-channel delivery, rate limiting, priority queues, retry |
| 8 | Design Payment System | Idempotency, distributed transactions, consistency, audit trails |

**Each design follows this structure:**
1. **Requirements** (functional + non-functional)
2. **Capacity Estimation** (back-of-envelope math with real numbers)
3. **High-Level Architecture** (diagram showing all components)
4. **Key Components** (deep dive into 3-4 critical pieces)
5. **Database & Schema** (what data, where, why — with actual table designs)
6. **Key Trade-offs** (what you sacrifice and why it's worth it)
7. **What Could Go Wrong** (failure scenarios and how to handle them)
8. **Q&A** (5-7 interviewer follow-up questions with answers)

---

## Topics Most Resources Miss

These are woven into relevant chapters, not standalone:

| Topic | Where It Fits |
|-------|--------------|
| Cost-aware design (cloud costs, compute vs storage trade-offs) | Part 2 & 5 (each design mentions cost) |
| Security fundamentals (OAuth, JWT, encryption, DDoS) | Part 3 (API Design chapter) |
| Migration patterns (monolith → microservices, zero-downtime deploy) | Part 3 (Microservices chapter) |
| Failure modes (retry storms, cascading failures, thundering herd) | Part 4 (dedicated chapter) |
| Capacity planning with actual math practice | Part 1 (Estimation chapter) + Part 5 (every design) |
