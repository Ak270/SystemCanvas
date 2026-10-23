# System Design: The Complete Book

**From "I just write code" to "I can design systems that serve millions"**

---

## Who Is This For?

- **Software engineers** preparing for system design interviews (L4/L5+ at FAANG, startups, or anywhere that asks "design X")
- **Backend developers** who build features but haven't thought about what happens at 100x scale
- **Self-taught programmers** who skipped the distributed systems class and feel the gap
- **Engineering managers** who need to evaluate architecture decisions without hand-waving

**You should already know**: How to write code in any language. What a database is (you've used one). What an API is (you've called one). That's it.

**You do NOT need**: A CS degree, distributed systems experience, or prior system design knowledge.

---

## What You'll Learn

By the end of this book, you will be able to:

1. **Estimate** whether a design can handle the load — with actual math, not gut feelings
2. **Choose** the right database, cache, queue, or protocol for a given problem — and explain why
3. **Design** complete systems (WhatsApp, YouTube, Uber) from requirements to trade-offs
4. **Anticipate** how systems fail and design around those failures
5. **Communicate** your design decisions clearly in interviews and architecture reviews

---

## How This Book Is Different

| What other resources do | What this book does |
|------------------------|---------------------|
| Open with definitions ("A CDN is a geographically distributed...") | Open with a problem ("Netflix streams to 200M users worldwide. How?") |
| List concepts without connecting them | Build a dependency graph — each chapter builds on the last |
| Show the "what" but skip the "why not" | Every topic has explicit trade-offs and "when NOT to use" |
| Passive reading | Active recall Q&A after every topic (the single most effective study technique) |
| Isolated concepts | "Putting It Together" mini-designs that show parts working as a whole |
| Generic explanations | Minimum 2 real company examples with concrete numbers per topic |

---

## Complete Chapter Plan

### Part 1: Foundations — The "Why" Before the "How"

*Dependency Layer: 1-2. These concepts are the vocabulary. Everything else builds on them.*

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 1 | What Is System Design? | Why can't I just write code and deploy it? |
| 2 | Scalability | What happens when 1 user becomes 1 million? |
| 3 | Availability & Reliability | How do I make sure my system never goes down? |
| 4 | Latency vs Throughput | Why is my app fast for me but slow for users in India? |
| 5 | Consistency Models | If two users update the same data, who wins? |
| 6 | CAP & PACELC Theorems | Why can't I have everything? |
| 7 | ACID vs BASE | When do I need strict rules vs speed? |
| 8 | Back-of-Envelope Estimation | How do I calculate if my design can handle the load? |

**Putting It Together (Part 1):** Design a simple notes app — walk through the trade-offs you'd make for 100 users vs 10 million users. Apply estimation, pick a consistency model, set an availability target.

---

### Part 2: Building Blocks — The Toolbox

*Dependency Layer: 3. These are the components you'll assemble into systems. Each one solves a specific problem.*

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 9 | DNS | How does typing "google.com" find a server? |
| 10 | Load Balancers | How do I handle 10x traffic overnight without crashing? |
| 11 | Reverse Proxy & API Gateway | Who guards the front door and routes requests? |
| 12 | Databases — SQL vs NoSQL | Where should I store my data, and which kind? |
| 13 | Database Indexing | Why is my query taking 10 seconds instead of 10ms? |
| 14 | Database Replication | What if my database machine dies at 3 AM? |
| 15 | Database Sharding | My database is too big for one machine. Now what? |
| 16 | Caching | How do I stop hitting the database a million times for the same data? |
| 17 | CDN (Content Delivery Network) | How does Netflix stream fast to someone in Tokyo and London? |
| 18 | Message Queues | How do I handle work that takes 5 minutes without making the user wait? |
| 19 | Rate Limiting | How do I stop one user (or bot) from killing my servers? |
| 20 | Object Storage | Where do I put 50 TB of images and videos? |
| 21 | Search Infrastructure | How does Google find results in 0.3 seconds across billions of pages? |

**Putting It Together (Part 2):** Trace a request through an e-commerce system — from typing the URL to seeing the product page. Show DNS, load balancer, API gateway, database, cache, CDN, and search all working together.

---

### Part 3: Patterns & Architecture — The Playbook

*Dependency Layer: 4-5. Now you know the parts. These are the patterns for wiring them together.*

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 22 | Microservices vs Monolith | Should I split my app into pieces, or keep it as one? |
| 23 | Event-Driven Architecture | How do services talk to each other without waiting around? |
| 24 | CQRS & Event Sourcing | What if my reads and writes need completely different shapes? |
| 25 | Consistent Hashing | How do I add servers without reshuffling all my data? |
| 26 | Circuit Breaker & Retry Patterns | What happens when a service I depend on goes down? |
| 27 | Idempotency | What if the same request hits my server twice? |
| 28 | API Design (REST, gRPC, GraphQL) | How should my services talk — and what format? |
| 29 | WebSockets & Real-Time Communication | How do I push live updates to users instantly? |
| 30 | Data Serialization (JSON, Protobuf, Avro) | When does the wire format actually matter? |
| 31 | Service Discovery | In a world of 500 microservices, how do they find each other? |
| 32 | Observability (Metrics, Logging, Tracing) | My system is slow. How do I find the problem? |

**Putting It Together (Part 3):** Design the backend of a food delivery app (like DoorDash) — show which pattern solves which problem: microservices for independent teams, event-driven for order flow, circuit breakers for restaurant API failures, real-time tracking via WebSockets.

---

### Part 4: Distributed Systems — The Hard Stuff

*Dependency Layer: 6. This is where things get genuinely difficult. These topics separate "I read about system design" from "I understand distributed systems."*

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 33 | Consensus Algorithms (Raft, Paxos) | How do multiple machines agree on one truth? |
| 34 | Leader Election | Who's in charge when there are multiple servers? |
| 35 | Distributed Locking | How do I prevent two servers from processing the same payment? |
| 36 | Distributed Transactions (2PC, Saga) | How do I update data across multiple services without losing money? |
| 37 | Bloom Filters & Probabilistic Data Structures | How do I check billions of items in milliseconds? |
| 38 | Heartbeats & Failure Detection | How do I know when a server is dead vs just slow? |
| 39 | Geo-Routing & Multi-Region Architecture | How do I serve users on every continent fast? |
| 40 | Data Warehousing & Analytics (OLTP vs OLAP) | How do I analyze petabytes of data without killing my production database? |
| 41 | Failure Patterns (Cascading Failures, Thundering Herd, Split Brain) | What are the scariest ways systems break — and how do I prevent them? |

**Putting It Together (Part 4):** Walk through how a payment system (like Stripe) works across regions — consistency guarantees, distributed transactions, failover, and what happens when an entire data center goes dark.

---

### Part 5: Real System Designs — The Practice

*Dependency Layer: 7 (Capstone). Each design exercises 5+ concepts from Parts 1-4. This is where everything clicks.*

| # | System | Key Concepts Practiced |
|---|--------|----------------------|
| 1 | Design WhatsApp | WebSockets, message queues, presence, E2E encryption, connection management, sharding by userId |
| 2 | Design YouTube | Video transcoding pipeline, CDN, adaptive bitrate streaming, object storage, recommendation engine |
| 3 | Design a URL Shortener | Hashing, key generation service, caching, analytics pipeline, database choice (SQL vs KV) |
| 4 | Design Twitter / News Feed | Fan-out on write vs read, ranking algorithms, caching layers, pub/sub, timeline generation |
| 5 | Design Uber | Geo-hashing (QuadTree), real-time matching, surge pricing, location tracking, ETA computation |
| 6 | Design Google Search | Web crawling, inverted index, PageRank, distributed caching, query auto-complete |
| 7 | Design a Notification System | Multi-channel delivery, priority queues, rate limiting, retry with backoff, user preferences |
| 8 | Design a Payment System | Idempotency keys, distributed transactions (Saga), double-entry ledger, audit trails, reconciliation |

**Each design follows this structure:**
1. **Requirements** — functional + non-functional, clarified like a real interview
2. **Capacity Estimation** — back-of-envelope math with real numbers
3. **High-Level Architecture** — diagram showing all components and data flow
4. **Deep Dive** — 3-4 most critical components explained in detail
5. **Database & Schema** — what data, where, why — with actual table/collection designs
6. **Key Trade-offs** — what you sacrifice, why it's worth it, and what changes if requirements change
7. **What Could Go Wrong** — failure scenarios and how to handle each
8. **Q&A** — 5-7 follow-up questions an interviewer would ask, with answers

---

## Topics Most Resources Miss

These are woven into the relevant chapters, not standalone sections:

| Topic | Where It Lives | Why It Matters |
|-------|---------------|---------------|
| Cost-aware design (cloud costs, compute vs storage trade-offs) | Part 2 + every Part 5 design | Real engineers have budgets. "Just add more servers" isn't a design. |
| Security fundamentals (OAuth, JWT, encryption basics, DDoS) | Part 3 — API Design chapter | Every system touches auth. Ignoring it in designs looks junior. |
| Migration patterns (monolith → microservices, zero-downtime deploys) | Part 3 — Microservices chapter | Nobody starts from scratch. The hard part is getting there from here. |
| The interview framework (RESHADED) | Part 1 — What Is System Design? + Part 5 intro | How to structure your 45-minute answer so you don't ramble. |
| Capacity planning with real math practice | Part 1 — Estimation + every Part 5 design | Numbers are the skeleton of every design. Most books wave hands here. |
| When NOT to use each tool | Every single chapter | Knowing when a cache hurts you is more valuable than knowing what a cache is. |

---

## Research Sources

This plan is validated against:

- **Books**: Designing Data-Intensive Applications (Kleppmann), System Design Interview Vol 1 & 2 (Alex Xu), Understanding Distributed Systems (Vitillo), Software Architecture: The Hard Parts (Richards & Ford)
- **Courses**: ByteByteGo, Grokking System Design (DesignGurus/Educative), System Design Primer (donnemartin), Exponent, Algoroq
- **University curricula**: MIT 6.5840, Stanford CS244B, CMU 15-440/640
- **Reader feedback**: Common complaints from HN and Reddit — books skip trade-off reasoning, go definition-first, lack depth on "why this choice over alternatives", miss API gateways and real tool comparisons (Kafka vs RabbitMQ)
- **Learning science**: Cognitive Load Theory, Dunlosky meta-analysis, dual coding, spaced repetition, SUCCESs framework

---

## Writing Order

Parts will be written and delivered one at a time:

1. `books/system-design/part-1-foundations.md`
2. `books/system-design/part-2-building-blocks.md`
3. `books/system-design/part-3-patterns-and-architecture.md`
4. `books/system-design/part-4-distributed-systems.md`
5. `books/system-design/part-5-real-system-designs.md`

Each part is reviewed and approved before the next begins.
