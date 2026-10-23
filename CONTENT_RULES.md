# SystemCanvas - Content Creation Rules & Plan

## Vision

A website with "books" on technical subjects (System Design, Distributed Systems, etc.).
Each book teaches the subject from zero to advanced — like a smart friend explaining over coffee.

---

## The 7 Rules of Writing (apply to ALL subjects)

### Rule 1: Explain Like They're 12, Then Like They're 22

Every topic has two layers:
- **First**: A dead-simple analogy anyone can understand (no jargon)
- **Then**: The real technical version, building on that analogy

> **Example**: "A load balancer is like a restaurant host. When customers (requests) walk in, the host doesn't send everyone to one waiter. They spread people across all waiters so nobody gets overwhelmed."
> Then: "A load balancer distributes incoming network traffic across multiple servers using algorithms like round robin, least connections, or consistent hashing."

### Rule 2: Every Concept Gets a Real Company Example

Don't just explain *what* it is. Show *where* it lives in the wild.

Each topic must include:
- **What it is** (1-2 sentences)
- **Why it exists** (what problem does it solve?)
- **How it works** (simple mechanics)
- **Real-world example** (e.g., "Netflix uses CDNs to serve videos from servers close to you — that's why a user in Tokyo and one in London both get fast streaming")
- **When to use / when NOT to use** (trade-offs)

### Rule 3: Less Words, More Clarity

- Max 150 words per concept explanation (before examples/Q&A)
- If a sentence doesn't teach something new, delete it
- Prefer tables and bullet points over paragraphs
- One idea per paragraph, max 3 sentences
- No filler phrases ("It is important to note that...", "As we all know...")

### Rule 4: Build a Mental Map Before Details

Each chapter opens with:
1. **One-line summary**: What this chapter is about
2. **Why you should care**: A real scenario where this matters
3. **Prerequisites**: What you should already know
4. **The big picture**: How this fits into the overall system

This reduces cognitive load — the brain needs a "shelf" to put new information on.

### Rule 5: Q&A That Anticipates Confusion

After each topic, include 3-5 Q&A pairs that answer:
- The dumb question nobody wants to ask ("Wait, so is a cache just... RAM?")
- The follow-up question ("If we cache everything, when does the cache become stale?")
- The interview/practical question ("You're designing Twitter. Where would you put a cache and why?")
- The comparison question ("How is this different from X?")

### Rule 6: Progressive Complexity With Callbacks

Topics are ordered so each one builds on the last. Later topics reference earlier ones:
- Chapter on Caching says "Remember the load balancer from Chapter 3? A cache sits between it and the database."
- Chapter on Sharding says "This is like horizontal scaling (Chapter 1), but for your database specifically."

This creates a connected web of knowledge, not isolated facts.

### Rule 7: Show the System, Not Just the Parts

Every section ends with a "Putting It Together" that shows how 3-4 concepts from that section work together in a real system. This is where the deep understanding happens.

---

## System Design Book — Chapter Plan

### Part 1: Foundations (The "Why" Before the "How")

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 1 | What is System Design? | Why can't I just write code and deploy? |
| 2 | Scalability | What happens when 1 user becomes 1 million? |
| 3 | Availability & Reliability | How do I make sure my system never goes down? |
| 4 | Latency vs Throughput | Why is my app fast for me but slow for users in India? |
| 5 | Consistency Models | If two users update the same data, who wins? |
| 6 | CAP & PACELC Theorems | Why can't I have everything? |
| 7 | ACID vs BASE | When do I need strict rules vs speed? |

**Putting It Together**: Design a simple notes app and discuss which trade-offs you'd make.

### Part 2: Building Blocks (The Toolbox)

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 8 | DNS | How does "google.com" become a server? |
| 9 | Load Balancers | How do I handle 10x traffic overnight? |
| 10 | Reverse Proxy & API Gateway | Who guards the front door? |
| 11 | Databases — SQL vs NoSQL | Where should I store my data? |
| 12 | Database Indexing | Why is my query taking 10 seconds? |
| 13 | Database Sharding | My database is too big for one machine. Now what? |
| 14 | Database Replication | What if my database machine dies? |
| 15 | Caching | How do I stop hitting the database for the same data? |
| 16 | CDN | How does Netflix stream fast everywhere? |
| 17 | Message Queues | How do I handle work that takes 5 minutes? |
| 18 | Rate Limiting | How do I stop one user from killing my servers? |
| 19 | Object Storage | Where do I put my images and videos? |
| 20 | Search Infrastructure | How does Google find results in 0.3 seconds? |

**Putting It Together**: Trace a request through an e-commerce system — from typing the URL to seeing the product page.

### Part 3: Patterns & Architecture (The Playbook)

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 21 | Microservices vs Monolith | Should I split my app into pieces? |
| 22 | Event-Driven Architecture | How do services talk without waiting? |
| 23 | CQRS & Event Sourcing | What if reads and writes need different shapes? |
| 24 | Consistent Hashing | How do I add servers without reshuffling everything? |
| 25 | Circuit Breaker & Retry | What happens when a service I depend on dies? |
| 26 | Idempotency | What if the same request hits twice? |
| 27 | API Design (REST, gRPC, GraphQL) | How should services communicate? |
| 28 | WebSockets & Real-Time | How do I push live updates to users? |
| 29 | Data Serialization | JSON vs Protobuf — when does format matter? |
| 30 | Observability | How do I know my system is healthy? |

**Putting It Together**: Design the backend of a food delivery app showing which patterns solve which problems.

### Part 4: Distributed Systems Deep Dive (The Hard Stuff)

| # | Topic | Core Question It Answers |
|---|-------|------------------------|
| 31 | Consensus (Raft, Paxos) | How do machines agree on one truth? |
| 32 | Leader Election | Who's in charge when there are multiple servers? |
| 33 | Distributed Locking | How do I prevent two servers from doing the same thing? |
| 34 | Bloom Filters | How do I check billions of items in milliseconds? |
| 35 | Heartbeats & Health Checks | How do I detect dead servers? |
| 36 | Geo-Routing & Multi-Region | How do I serve users on every continent? |
| 37 | Data Warehousing & Analytics | How do I analyze petabytes of data? |
| 38 | Fault Tolerance Patterns | How do I build systems that survive disasters? |

**Putting It Together**: Walk through how a payment system works across regions — consistency, failover, and recovery.

### Part 5: Real System Designs (The Practice)

Full worked examples using the RESHADED framework:

| # | System | Key Concepts Tested |
|---|--------|-------------------|
| 1 | Design WhatsApp | WebSockets, message queues, presence, E2E encryption |
| 2 | Design YouTube | Video transcoding, CDN, adaptive streaming, metadata |
| 3 | Design URL Shortener | Hashing, key generation, caching, analytics pipeline |
| 4 | Design Twitter/Feed | Fan-out, ranking, caching, pub/sub |
| 5 | Design Uber | Geo-hashing, matching, real-time tracking, surge pricing |
| 6 | Design Google Search | Web crawling, inverted index, PageRank, caching |

Each design follows:
1. **Requirements** (functional + non-functional)
2. **Capacity Estimation** (back-of-envelope math)
3. **High-Level Architecture** (the big picture)
4. **Key Components** (deep dive into 3-4 critical pieces)
5. **Database & Schema** (what data, where, why)
6. **Key Trade-offs** (what you sacrifice and why it's worth it)
7. **Q&A** (interviewer follow-ups)

---

## Content Quality Checklist (Before Publishing Any Topic)

- [ ] Can a non-engineer understand the first explanation?
- [ ] Is there at least one real company example?
- [ ] Is the core explanation under 150 words?
- [ ] Are there 3-5 Q&A pairs?
- [ ] Does it reference a previous topic (callback)?
- [ ] Is there a "when NOT to use this" section?
- [ ] Would a diagram help? If yes, is there one?
- [ ] Zero filler sentences?

---

## Principles for Future Subjects

When adding a new book (Distributed Systems, Databases, etc.):

1. **Reuse the 7 Rules above** — they apply to every subject
2. **Don't repeat content** — if System Design covers caching, the Databases book links to it instead of re-explaining
3. **Each book has its own "Putting It Together" examples** relevant to that domain
4. **Start from the PDF/outline** if one exists, then restructure using these rules
5. **Max 40 topics per book** — if you have more, split into two books
6. **Every book starts with "Who is this for?" and "What you'll learn"**

---

## How Humans Learn (The Science Behind These Rules)

These rules aren't arbitrary. They're based on how the brain works:

- **Chunking**: The brain processes 4±1 items at once. That's why each section groups 7-10 related topics, and each topic has a clear structure.
- **Analogy-first**: New knowledge anchors to existing knowledge. The restaurant-host analogy for load balancers works because everyone has been to a restaurant.
- **Spaced callbacks**: Referencing earlier topics strengthens memory connections. Each mention of a previous concept is a mini-review.
- **Active recall via Q&A**: Reading feels like learning but isn't. Questions force the brain to retrieve and connect information.
- **Concrete before abstract**: Real company examples (Netflix, WhatsApp) give the brain something tangible before introducing the abstract concept.
- **Cognitive load management**: "Prerequisites" and "Big Picture" at the start of each chapter tell the brain where to file new information.
