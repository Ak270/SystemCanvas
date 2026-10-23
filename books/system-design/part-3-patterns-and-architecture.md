# Part 3: Patterns & Architecture — The Playbook

*You know the building blocks from Part 2: databases, caches, queues, load balancers. But knowing what a hammer is doesn't make you an architect. This part teaches you the patterns — the proven ways to wire components together. By the end, you'll design real backends and explain why you chose each pattern.*

---

## Chapter 22: Microservices vs Monolith

**One-liner:** A monolith is one big application that does everything; microservices split it into small, independent services that each do one thing.

**Why you should care:** Your startup has one Rails app handling users, payments, emails, and product search. It works great at 10 engineers. Then you hire to 50. Now every deploy is terrifying — a change to the email template breaks checkout because they share a database. Deployments take 4 hours. Three teams step on each other's code daily. This isn't a hypothetical. This is Amazon in 2001, Twitter in 2012, and Netflix in 2008. Each one made the same decision: break the monolith apart.

**Prerequisites:** Chapters 10 (Load Balancers), 12 (Databases), 18 (Message Queues)

### The Simple Version

A monolith is like a Swiss Army knife — one tool that does everything. It's compact, easy to carry, and works fine when you're alone on a camping trip.

Microservices are like a full toolbox — separate hammer, wrench, screwdriver. Each one does its job well. Different people can use different tools at the same time. But now you need a toolbox to carry them, and you need to know which tool to grab.

Small team, simple product? Swiss Army knife. Large team, complex product? Toolbox.

### How It Actually Works

```
Monolith Architecture
━━━━━━━━━━━━━━━━━━━━
┌──────────────────────────────┐
│        ONE APPLICATION       │
│  ┌──────┐ ┌──────┐ ┌──────┐ │
│  │Users │ │Orders│ │Email │ │
│  └──┬───┘ └──┬───┘ └──┬───┘ │
│     └────────┼────────┘     │
│         ONE DATABASE         │
└──────────────────────────────┘
  Deploy = ship everything


Microservices Architecture
━━━━━━━━━━━━━━━━━━━━━━━━━━
┌────────┐  ┌────────┐  ┌────────┐
│ User   │  │ Order  │  │ Email  │
│Service │  │Service │  │Service │
└───┬────┘  └───┬────┘  └───┬────┘
    │           │           │
┌───┴──┐   ┌───┴──┐   ┌───┴──┐
│UserDB│   │OrderDB│  │EmailDB│
└──────┘   └───────┘  └───────┘
  Deploy = ship one piece at a time
```

**Monolith:** One codebase, one deployment, one database. All modules call each other via function calls (nanoseconds). Simple to develop, test, and debug.

**Microservices:** Each service has its own codebase, deployment, and database. Services communicate over the network via APIs or message queues (milliseconds). Each team owns their service end-to-end.

**The hidden cost of microservices:** You trade code complexity for operational complexity. You now need service discovery (Chapter 31), distributed tracing (Chapter 32), network failure handling (Chapter 26), and data consistency across services (Chapter 36).

### Real-World Examples

**Example 1: Amazon — The Two-Pizza Teams**

In 2001, Amazon was a monolith. Deploying took hours. Teams blocked each other constantly. CEO Jeff Bezos issued the now-famous mandate: every team must communicate through service APIs. No shared databases. No back doors. Amazon broke its monolith into hundreds of services, each owned by a team small enough to feed with two pizzas. By 2022, Amazon runs over 1,000 microservices. Each one deploys independently — some deploy thousands of times per day.

**Example 2: Shopify — The Monolith That Scaled**

While everyone rushed to microservices, Shopify stayed monolith. Their Rails app handles Black Friday traffic (over $3.36 billion in sales in 2022). How? They invested in modular design within the monolith (they call it "componentized monolith"), strong testing, and horizontal scaling. Their reasoning: the operational overhead of microservices wasn't worth it for their team size and deployment patterns. Proof that the right answer depends on your context, not the latest trend.

### When To Use / When NOT To Use

| Use Monolith When | Use Microservices When |
|---|---|
| Small team (< 10 engineers) | Large team (50+ engineers, multiple teams) |
| New product, unclear requirements | Well-understood domain boundaries |
| Need to move fast and iterate | Services need independent scaling |
| Simple domain with few modules | Different services need different tech stacks |
| You value simplicity over flexibility | You need independent deployment per team |

**The migration path:** Almost every successful microservices company started with a monolith. Build the monolith, learn your domain boundaries, then extract services when the pain justifies the complexity. Netflix, Amazon, Uber — all started monolith.

### Q&A

**Q: If microservices are so complex, why does everyone use them?**
A: Not everyone does — Shopify, StackOverflow, and Basecamp run monoliths at scale. Microservices solve organizational problems more than technical ones. When you have 500 engineers, a monolith means everyone steps on each other. Microservices let teams move independently. The technical complexity is the price you pay for team independence.

**Q: What's the biggest mistake teams make with microservices?**
A: Starting with them. If you don't know your domain boundaries yet, you'll draw them wrong. Now you have a distributed monolith — all the complexity of microservices but none of the benefits, because your services are tightly coupled and can't deploy independently. Build the monolith first, find the natural seams, then split.

**Q: How do microservices share data if they each have their own database?**
A: Through APIs or events. The Order Service doesn't query the User database directly. It calls the User Service's API: "Give me user #123's address." Or, the User Service publishes a "UserAddressUpdated" event (Chapter 23), and the Order Service keeps its own copy. This is the hardest part of microservices — data consistency across service boundaries (Chapter 36).

**Q: How small should a microservice be?**
A: "Micro" is misleading. A service should own one business capability (e.g., "payments" or "user authentication"), not one function. Amazon's rule: a service is owned by one team (6-10 people). If it takes two teams to change it, it's too big. If one person can rewrite it in a week, it might be too small — you're just creating network overhead for no benefit.

**Q: You're designing an e-commerce platform for a 20-person startup. Monolith or microservices?**
A: Monolith, almost certainly. Twenty engineers can coordinate on one codebase. You need speed and simplicity to find product-market fit. But design the monolith with clear module boundaries — user, catalog, order, payment. When you hit 50+ engineers and deployments become painful, you have natural extraction points. This is what Shopify did, and it worked.

---

## Chapter 23: Event-Driven Architecture

**One-liner:** Instead of services calling each other directly ("do this now"), they announce what happened ("this just happened") and let other services react.

**Why you should care:** Your e-commerce app has a checkout flow. When someone places an order, you need to: charge their payment, update inventory, send a confirmation email, notify the warehouse, update analytics, and trigger a recommendation refresh. In a synchronous system, the order service calls each one in sequence — if the email service is slow, the user waits. If analytics is down, checkout fails. With event-driven architecture, the order service just says "OrderPlaced!" and every interested service reacts on its own. The user gets their confirmation in 200ms instead of 2 seconds.

**Prerequisites:** Chapter 18 (Message Queues), Chapter 22 (Microservices)

### The Simple Version

Think about a radio station. The DJ doesn't call every listener individually and say "Hey, a new song is playing." They broadcast to everyone at once. Listeners tune in if they're interested. The DJ doesn't know (or care) how many people are listening, and adding new listeners doesn't slow down the broadcast.

Event-driven architecture works the same way. Services broadcast events ("order placed," "payment completed," "user signed up") and other services subscribe to the events they care about. The broadcaster doesn't know who's listening, and you can add new listeners without changing the broadcaster.

### How It Actually Works

```
Synchronous (Request-Driven) — everyone waits
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Order Service ──call──→ Payment Service (500ms)
              ──call──→ Inventory Service (100ms)
              ──call──→ Email Service (300ms)
              ──call──→ Analytics Service (200ms)

Total: 1,100ms. If Email is down, order fails.


Event-Driven (Pub/Sub) — fire and forget
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Order Service ──publish──→ "OrderPlaced" event
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
          Payment Svc   Inventory Svc  Email Svc
          (subscribes)  (subscribes)   (subscribes)

Total for user: ~50ms (just publish the event).
Each subscriber processes independently.
```

**Key concepts:**
1. **Producer/Publisher:** The service that emits events (Order Service says "OrderPlaced")
2. **Event bus/broker:** The infrastructure that delivers events (Kafka, RabbitMQ — Chapter 18)
3. **Consumer/Subscriber:** Services that react to events (Email Service listens for "OrderPlaced")
4. **Loose coupling:** The producer doesn't know who consumes its events. You can add a new analytics consumer without touching the order code.

### Real-World Examples

**Example 1: LinkedIn — Activity Feed at Scale**

When you post on LinkedIn, dozens of things happen: your connections' feeds update, notifications fire, search indexes update, analytics record the event, spam filters check the content. LinkedIn processes over 4 trillion events per day through Kafka. The "post" service doesn't call 15 downstream services — it publishes a "PostCreated" event, and each system reacts independently. This is how LinkedIn handles 900+ million members without every action creating a 15-service synchronous chain.

**Example 2: Uber — Ride Lifecycle Events**

A single Uber ride generates a cascade of events: RideRequested → DriverMatched → DriverEnRoute → RideStarted → RideCompleted → PaymentProcessed → RideRated. Each event triggers multiple reactions — RideCompleted triggers payment processing, driver earnings calculation, ETA model updates, and surge price recalculation. Uber's event-driven architecture lets these systems evolve independently. When they added Uber Eats, the delivery events followed the same pattern without rewriting the core ride system.

### When To Use / When NOT To Use

| Use Events When | Don't Use Events When |
|---|---|
| Multiple services need to react to one action | You need an immediate response ("is this username taken?") |
| You want loose coupling between services | The flow has strict ordering requirements |
| Actions can happen asynchronously | You need a simple request/response (just call the API) |
| You need to add new reactions without changing existing code | Debugging is more important than scalability (events are harder to trace) |

**The catch:** Event-driven systems are harder to debug. In a synchronous system, you can follow the call chain. In event-driven, you need distributed tracing (Chapter 32) to see what happened after an event was published. Events can also arrive out of order or be processed twice, so consumers must handle that (Chapter 27 — Idempotency).

### Q&A

**Q: How is event-driven architecture different from just using message queues?**
A: Message queues (Chapter 18) are the plumbing; event-driven architecture is the pattern. A queue moves messages from point A to point B. Event-driven architecture is the design decision to structure your entire system around events — where services communicate by publishing "what happened" instead of telling each other "what to do." You can have message queues without EDA (just for async processing), and you could technically have EDA without queues (using HTTP webhooks), though queues are the standard choice.

**Q: What happens if a subscriber crashes while processing an event?**
A: The event broker retains the event until the subscriber acknowledges it. If the subscriber crashes, the broker redelivers. This is why consumers must be idempotent (Chapter 27) — they might process the same event twice. Kafka goes further: it retains events for a configurable period (days or weeks), so a subscriber that was down for hours can catch up by replaying from where it left off.

**Q: Don't events make the system harder to understand?**
A: Yes. This is the main trade-off. In a synchronous system, you read the code and see: "Order calls Payment, then Email." In an event system, you publish "OrderPlaced" and have to search every service to find who listens. This is why observability (Chapter 32) matters so much in event-driven systems. Tools like distributed tracing let you follow an event through every service it touched.

**Q: Can I mix event-driven and synchronous?**
A: Absolutely, and most systems do. Use synchronous calls when you need an immediate answer ("check if this coupon is valid") and events when you want to fan out work ("order placed — notify everyone"). Stripe processes payments synchronously (the user needs to know if it worked) but publishes events asynchronously for webhooks, fraud analysis, and reporting.

**Q: You're adding a loyalty points feature to an existing e-commerce system. Event-driven or direct API calls?**
A: Events. You want the Order Service to stay untouched — it already publishes "OrderCompleted" events. Create a Loyalty Service that subscribes to "OrderCompleted" and calculates points independently. If the loyalty system is slow or down, orders still work. If you later want to add points for reviews or referrals, those services publish their own events and the Loyalty Service subscribes. Zero changes to existing services.

---

## Chapter 24: CQRS & Event Sourcing

**One-liner:** CQRS splits your system into a write side and a read side because reads and writes often have completely different needs. Event Sourcing stores every change as an immutable event instead of overwriting the current state.

**Why you should care:** Your social media app has 1,000 writes per second (posts, likes, follows) but 100,000 reads per second (loading timelines). Your database schema is optimized for writes — normalized, consistent, relational. But reads need denormalized data: "show me this user's timeline with post text, author name, like count, and top 3 comments." One schema can't serve both well. Your read queries join 5 tables and take 200ms. CQRS says: stop forcing one model to do both jobs.

**Prerequisites:** Chapter 12 (Databases), Chapter 14 (Database Replication), Chapter 23 (Event-Driven Architecture)

### The Simple Version

**CQRS** is like a restaurant with separate ordering and pickup counters. You place your order at one window (write), and pick up your food at another (read). The kitchen (business logic) processes between them. Each counter is optimized for its job — the order window has a menu and register, the pickup counter has bag racks and a display.

**Event Sourcing** is like a bank ledger. Your bank doesn't store "balance = $1,500." It stores every transaction: +$3,000 (paycheck), -$50 (groceries), -$1,400 (rent), -$50 (groceries). Your balance is calculated by replaying the ledger. You can never lose history, and you can always answer "what was my balance on March 15th?"

### How It Actually Works

```
Traditional CRUD
━━━━━━━━━━━━━━━━
  Read ──→ ┌──────────┐ ←── Write
           │  Same DB  │
           │ Same Model│
           └──────────┘
  Problem: reads want denormalized,
  writes want normalized.


CQRS
━━━━
  Write ──→ ┌────────────┐
            │ Write Model │  ← normalized, consistent
            │ (Commands)  │
            └─────┬──────┘
                  │ events
                  ▼
            ┌────────────┐
            │ Read Model  │  ← denormalized, fast
            │ (Queries)   │
            └────────────┘ ←── Read
  Eventual consistency between models.


Event Sourcing
━━━━━━━━━━━━━━
  Instead of: UPDATE account SET balance = 1500

  Store:  Event 1: AccountCreated { id: 42 }
          Event 2: MoneyDeposited { amount: 3000 }
          Event 3: MoneyWithdrawn { amount: 1500 }

  Current state = replay all events
  History is never lost.
```

**CQRS** separates the write path (commands that change state) from the read path (queries that fetch state). The write model is optimized for consistency and validation. The read model is optimized for fast queries — it might be a completely different database (e.g., writes go to PostgreSQL, reads come from Elasticsearch or Redis).

**Event Sourcing** replaces "update current state" with "append an event describing what happened." The current state is derived by replaying events. Combined with CQRS, events from the write side project into the read model.

### Real-World Examples

**Example 1: Financial Systems — Audit by Default**

Banks and trading platforms use event sourcing because regulators require a complete history of every change. When LMAX Exchange built their trading platform, they used event sourcing to process 6 million transactions per second. Every order, trade, and cancellation is an immutable event. They can replay the entire trading day to investigate anomalies, reconstruct any account's state at any point in time, and prove to regulators exactly what happened and when.

**Example 2: GitHub — Separating Reads and Writes**

GitHub's architecture uses CQRS principles. When you push code (write), it goes through validation, authorization, and storage in Git's object store. When you view a repository (read), the data comes from denormalized read models — the file browser, commit history, and contributor graphs are all precomputed read views. Writes are relatively rare; reads are enormous (millions of developers browsing code). By separating the models, GitHub optimizes each path independently.

### When To Use / When NOT To Use

| Use When | Don't Use When |
|---|---|
| Reads vastly outnumber writes (100:1 or more) | Simple CRUD app with balanced reads/writes |
| Read and write models have very different shapes | You need strong consistency (user updates must be visible immediately) |
| You need a complete audit trail (finance, healthcare) | Your team is small and the added complexity isn't justified |
| You need to replay events to rebuild state | Your domain is simple (a blog, a TODO app) |

**Warning:** CQRS and Event Sourcing add significant complexity. The read model is eventually consistent with the write model — a user might write data and not see it immediately on the read side. Most applications don't need this pattern. Use it when the read/write asymmetry or audit requirements demand it, not because it sounds impressive.

### Q&A

**Q: Do CQRS and Event Sourcing always go together?**
A: No. You can use CQRS without Event Sourcing (writes go to a relational DB, a change feed projects into a read-optimized store). You can use Event Sourcing without CQRS (one event store, queries replay events). They complement each other — events naturally feed into projections for read models — but each solves a different problem.

**Q: If the read model is eventually consistent, how long is the delay?**
A: Typically milliseconds to a few seconds. When a write happens, an event is published and the read model updates asynchronously. For most use cases (timelines, dashboards, search results), a 1-second delay is invisible. For cases where the user must see their own write immediately, you can use "read-your-own-writes" — serve the user's recent writes from the write model and everything else from the read model.

**Q: Doesn't event sourcing mean the event store grows forever?**
A: Yes, and that's a real operational concern. The solution is **snapshotting**: periodically save the current derived state so you don't replay from the beginning. To rebuild state, load the latest snapshot and replay only the events after it. Most event-sourced systems snapshot every N events or on a schedule.

**Q: You're building a healthcare records system. Would you use event sourcing?**
A: Strongly consider it. Healthcare has strict audit requirements — you must know who changed what, when, and why. With traditional CRUD, you'd need a separate audit table that mirrors every change. With event sourcing, the audit trail *is* the data model. Every change to a patient record is an immutable event: "DiagnosisAdded," "MedicationPrescribed," "AllergyRecorded." You can reconstruct the record at any point in time, which is invaluable for malpractice investigations and regulatory compliance.

---

## Chapter 25: Consistent Hashing

**One-liner:** Consistent hashing distributes data across servers so that adding or removing a server only moves a small fraction of data — not everything.

**Why you should care:** You have 4 cache servers and use `server = hash(key) % 4` to decide which server holds each key. It works great — until a server dies. Now it's `hash(key) % 3`. Almost every key maps to a different server. Your entire cache is effectively wiped. Millions of requests slam your database at once (a "thundering herd" — Chapter 41). Consistent hashing was invented to solve exactly this problem: add or remove servers without reshuffling the world.

**Prerequisites:** Chapter 16 (Caching), Chapter 15 (Database Sharding)

### The Simple Version

Imagine a clock face with numbers 0 to 11. You place 3 servers on the clock: Server A at 2, Server B at 6, Server C at 10. To store data, you hash its key to a number on the clock and walk clockwise until you hit a server. Key "user:42" hashes to 4, so it goes to Server B (the next server clockwise at 6).

Now Server B dies. Only the keys between A (2) and B (6) need to move — they now go to C (10). The keys stored on A and C don't move at all. With regular hashing (`% N`), everything reshuffles. With consistent hashing, only the dead server's keys move.

### How It Actually Works

```
The Hash Ring
━━━━━━━━━━━━━
        0
       / \
     11    1
    /        \
   10  [C]    2  [A]
    \        /
     9    3
      \  /
   [B] 6    4
        \  /
         5

Key "user:42" hashes to position 4
→ Walk clockwise → hits Server B at 6
→ Stored on Server B

Server B dies:
→ Keys 3-6 move to Server C (next clockwise)
→ Keys on A and C don't move


Virtual Nodes (solving uneven distribution)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Instead of 1 point per server, place 100-200:

  Server A → A-1, A-2, A-3, ... A-150
  Server B → B-1, B-2, B-3, ... B-150
  Server C → C-1, C-2, C-3, ... C-150

450 evenly distributed points on the ring.
Each server handles ~33% of keys.
```

**Why virtual nodes?** With only 3 points on a ring, one server might get 60% of keys by bad luck. Virtual nodes spread each server's responsibility evenly across the ring. When a server dies, its keys are distributed across all remaining servers (not just the next one), preventing any single server from being overwhelmed.

### Real-World Examples

**Example 1: Amazon DynamoDB — The Paper That Started It All**

Consistent hashing was popularized by Amazon's 2007 Dynamo paper. DynamoDB uses it to distribute data across storage nodes. Each node is responsible for a range of the hash ring. When Amazon adds capacity during Black Friday, new nodes take over portions of the ring from existing nodes — existing keys aren't reshuffled. The system scales without downtime. This paper influenced Cassandra, Riak, and Voldemort.

**Example 2: Akamai CDN — Where Consistent Hashing Was Invented**

Consistent hashing was originally invented at MIT in 1997 for Akamai's CDN. The problem: how do you decide which edge server caches which content? With millions of objects and thousands of servers, you can't reshuffle everything when a server goes down. Consistent hashing lets Akamai add and remove edge servers — which happens constantly — while keeping most cached content in place. Today Akamai serves 15-30% of global web traffic using this approach.

### When To Use / When NOT To Use

| Use When | Don't Use When |
|---|---|
| Distributing data across a dynamic cluster | Fixed number of servers that rarely change |
| Cache clusters where nodes come and go | Small datasets that fit on one machine |
| Distributed databases that need automatic rebalancing | Simple round-robin distribution is good enough |
| You need to minimize data movement during scaling | The overhead of maintaining a ring isn't justified |

### Q&A

**Q: Why not just use `hash(key) % N`?**
A: Because N changes. If you have 4 servers and one dies, `% 3` remaps nearly every key. With consistent hashing, only keys from the dead server move (~25%). The math: with modular hashing, removing one of N servers remaps ~(N-1)/N of keys. With consistent hashing and virtual nodes, it remaps ~1/N. At 100 servers, that's 99% disruption vs. 1%.

**Q: What are virtual nodes, and how many do you need?**
A: Virtual nodes are multiple points on the ring per physical server. Without them, 3 servers might get 20%, 50%, 30% of keys — unbalanced. With 100-200 virtual nodes per server, the distribution becomes nearly uniform. The trade-off: more virtual nodes = better balance but more memory for the ring lookup table. In practice, 150 virtual nodes per server is common.

**Q: How does consistent hashing relate to sharding (Chapter 15)?**
A: Sharding decides *that* you'll split data across machines. Consistent hashing decides *how*. When you shard a database, you need a strategy for assigning keys to shards. Consistent hashing is one such strategy — and it's the best one when shards are added or removed frequently because it minimizes data migration.

**Q: You're building a distributed cache with 20 servers and frequent scaling. How would you use consistent hashing?**
A: Place each server on the hash ring with 150 virtual nodes each (3,000 total points). Hash each cache key and walk clockwise to find its server. When you add server #21 during a traffic spike, it takes ~5% of keys from each existing server — not all at once, spread evenly. When a server fails, its ~5% of keys redistribute across all remaining servers. Store the ring in each client or in a coordination service like ZooKeeper that notifies clients of ring changes.

---

## Chapter 26: Circuit Breaker & Retry Patterns

**One-liner:** A circuit breaker stops calling a failing service before it makes things worse; retries let you recover from temporary glitches — but naive retries can cause a stampede.

**Why you should care:** Your checkout service calls the Payment service. The Payment service is overloaded and responding in 30 seconds instead of 200ms. Without a circuit breaker, every checkout request hangs for 30 seconds, your thread pool fills up, your checkout service stops responding, and now the product page service (which calls checkout for "add to cart") also hangs. One slow service cascades into a site-wide outage. In 2012, this exact pattern took down Netflix — a single slow dependency froze their entire streaming platform. That's when they built Hystrix, the circuit breaker library that changed how the industry handles failure.

**Prerequisites:** Chapter 3 (Availability & Reliability), Chapter 22 (Microservices)

### The Simple Version

A circuit breaker works like the one in your house. When there's an electrical overload, the breaker trips and cuts the circuit — preventing a fire. You don't keep sending electricity into a failing wire. Once the problem is fixed, you flip the breaker back on.

In software: when a service you call starts failing, the circuit breaker "trips" and stops sending requests immediately. Instead of waiting 30 seconds per call, you fail fast (in 1ms) and return a fallback. Periodically, the breaker lets one test request through. If it succeeds, the breaker resets and traffic flows again.

### How It Actually Works

```
Circuit Breaker States
━━━━━━━━━━━━━━━━━━━━━━

  ┌─────────┐  failures > threshold  ┌──────────┐
  │ CLOSED  │ ─────────────────────→ │   OPEN   │
  │(normal) │                        │(fast-fail)│
  └────┬────┘                        └─────┬────┘
       ↑                                   │
       │     success                       │ timeout
       │                                   ▼
       │                            ┌────────────┐
       └─────────────────────────── │ HALF-OPEN  │
                                    │(test 1 req)│
                                    └────────────┘
                                      │
                              failure │
                                      ▼
                                   OPEN again

CLOSED:  Requests flow normally. Track failure rate.
OPEN:    All requests fail immediately (no waiting).
         Return fallback: cached data, default, or error.
HALF-OPEN: After a timeout, let ONE request through.
         If it succeeds → CLOSED. If it fails → OPEN.
```

**Retry with backoff:**

```
Retry pattern (with exponential backoff + jitter)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Attempt 1: fails
  Wait: 100ms + random(0-100ms)
Attempt 2: fails
  Wait: 200ms + random(0-200ms)
Attempt 3: fails
  Wait: 400ms + random(0-400ms)
Attempt 4: give up → circuit breaker opens

Without jitter: 10,000 clients retry at EXACTLY the
same time → "retry storm" → service overloads again
With jitter: retries spread out → service recovers
```

**Why jitter matters:** If 10,000 requests fail at the same time, they'll all retry at the same time — hitting the recovering service with another 10,000 requests simultaneously. Adding random jitter (a random delay) spreads the retries over time so the service isn't overwhelmed again.

### Real-World Examples

**Example 1: Netflix — Hystrix and the Cascade**

Netflix's Hystrix (now succeeded by Resilience4j) was built after a 2012 outage where a single slow API cascaded into a platform-wide failure. Hystrix wraps every external service call in a circuit breaker. If the recommendation service is slow, Netflix shows a generic "popular titles" list instead of personalized recommendations. Users barely notice. Without the breaker, the recommendation delay would freeze the entire homepage. At Netflix's scale (250+ million subscribers), each dependency failure is isolated — the rest of the system keeps working.

**Example 2: AWS — Exponential Backoff as Standard Practice**

AWS SDKs have exponential backoff with jitter built in as a default for all API calls. When a DynamoDB request is throttled, the SDK waits 50ms, then 100ms, then 200ms — each with random jitter. AWS published research showing that without jitter, retry storms during outages amplified load by 10x, turning a partial outage into a complete one. Their "equal jitter" strategy (backoff = random between 0 and exponential cap) reduced retry load by 75% compared to fixed-delay retries.

### When To Use / When NOT To Use

| Use When | Don't Use When |
|---|---|
| Calling external services (payment APIs, third-party services) | Local function calls that can't "partially fail" |
| Any network call that could timeout or fail | Errors that will never succeed on retry (400 Bad Request) |
| You have a reasonable fallback for failures | You have no fallback (might as well wait and retry) |
| You want to prevent cascade failures in microservices | Simple monolith where calls are in-process |

**Critical rule:** Only retry on transient failures (timeouts, 503 Service Unavailable, network errors). Never retry on permanent failures (400 Bad Request, 401 Unauthorized, 404 Not Found). Retrying a "bad password" error 5 times doesn't make the password right — it just wastes resources and might trigger rate limiting.

### Q&A

**Q: What's the difference between a circuit breaker and a timeout?**
A: A timeout says "give up on THIS request after 5 seconds." A circuit breaker says "this service has failed 10 times in the last minute — stop trying AT ALL for 30 seconds." Timeouts handle individual slow requests. Circuit breakers detect a pattern of failure and protect the system by stopping all requests to the failing service. Use both together.

**Q: What should the circuit breaker's fallback return?**
A: Depends on the feature. For Netflix recommendations: return a cached "popular titles" list. For a shopping cart price check: return the last known price. For a payment service: return an error — you can't fake a payment. The fallback should be the best possible degraded experience. "Show stale data" is often better than "show an error page."

**Q: How do I set the circuit breaker thresholds?**
A: Start with: open after 5 failures in 10 seconds, try half-open after 30 seconds. Then tune based on your service's normal error rate and recovery time. Too sensitive → the breaker trips on normal blips. Too lenient → it doesn't protect you. Monitor your circuit breaker state in your dashboards (Chapter 32) and adjust.

**Q: What's a "retry storm" and how do I prevent it?**
A: When thousands of clients all retry at the same moment, the combined load crushes the recovering service. Prevention: (1) Exponential backoff — wait longer between each retry. (2) Jitter — add randomness so retries spread out. (3) Max retry limit — stop after 3-4 attempts. (4) Circuit breaker — if enough retries fail, stop retrying entirely. AWS calls this the "thundering herd" (Chapter 41) and considers jitter mandatory.

---

## Chapter 27: Idempotency

**One-liner:** An idempotent operation produces the same result whether you execute it once or ten times — critical for systems where requests can be duplicated.

**Why you should care:** A user clicks "Pay Now." Their browser sends the request, but the network is slow — no response after 3 seconds. They click again. Now your server received two payment requests. Without idempotency, you charge them twice. This isn't theoretical — Stripe, PayPal, and every payment processor treats idempotency as a core requirement. And it's not just payments: duplicate messages, double order submissions, and retried API calls happen constantly in distributed systems. Networks are unreliable, and the user's finger is always faster than your response.

**Prerequisites:** Chapter 26 (Circuit Breaker & Retry)

### The Simple Version

An elevator call button is idempotent. Press it once, the elevator comes. Press it ten times frantically — the elevator still comes once. Pressing more doesn't summon more elevators.

Contrast that with a vending machine coin slot. Insert a dollar, get one credit. Insert another dollar, get another credit. Each insertion is a NEW operation. It's *not* idempotent.

In APIs: `GET /user/42` is idempotent — calling it 100 times returns the same user. `POST /charge` with the same credit card is NOT idempotent unless you design it to be — each call charges again.

### How It Actually Works

```
Without Idempotency
━━━━━━━━━━━━━━━━━━━
Client ──POST /pay $50──→ Server (processes, charges $50)
Client ──(timeout, no response)──
Client ──POST /pay $50──→ Server (processes again, charges $50)

User charged $100. 💸


With Idempotency Key
━━━━━━━━━━━━━━━━━━━━
Client ──POST /pay $50, Key: "abc-123"──→ Server
  Server: key "abc-123" not seen → process → charge $50
  Server: store result for key "abc-123"

Client ──(timeout, no response)──
Client ──POST /pay $50, Key: "abc-123"──→ Server
  Server: key "abc-123" already processed
  Server: return STORED result (not process again)

User charged $50. ✓
```

**How idempotency keys work:**
1. Client generates a unique key (UUID) for each logical operation
2. Sends the key with the request (e.g., `Idempotency-Key: abc-123` header)
3. Server checks: "Have I seen this key before?"
4. **First time:** Process the request, store the result keyed by the idempotency key
5. **Subsequent times:** Return the stored result without reprocessing

**Storage:** Idempotency keys and their results are typically stored in Redis with a TTL (e.g., 24 hours). After the TTL, the key expires and the same key would be treated as new — but by then, the client has long since moved on.

### Real-World Examples

**Example 1: Stripe — Idempotency as a First-Class Feature**

Stripe's API accepts an `Idempotency-Key` header on every mutating request. If you create a charge with key "order-42-payment" and the network drops the response, you safely retry with the same key. Stripe returns the original result. Internally, Stripe stores the key, request parameters, and response for 24 hours. They process over 250 million API calls per day — without idempotency keys, network retries alone would cause millions in duplicate charges.

**Example 2: Amazon SQS — At-Least-Once Delivery**

SQS guarantees at-least-once delivery, meaning your consumer might receive the same message twice. Amazon's answer: design idempotent consumers. When processing an order from SQS, the consumer checks: "Have I already processed order #12345?" If yes, skip. If no, process and record. DynamoDB's conditional writes make this atomic: `PutItem if order_id does not exist`. This pattern — check-then-process — is the backbone of reliable message processing across all of AWS.

### When To Use / When NOT To Use

| Use When | Don't Use When |
|---|---|
| Any API that changes state (payments, orders, writes) | Pure read operations (already idempotent by nature) |
| Operations that get retried (webhooks, queues, user clicks) | One-off scripts where duplicates are impossible |
| Any financial or money-related operation | Internal function calls within a single process |
| Distributed systems where messages can be delivered twice | When the cost of idempotency storage exceeds the cost of duplicates |

### Q&A

**Q: Which HTTP methods are naturally idempotent?**
A: GET, PUT, and DELETE are idempotent by design. GET doesn't change state. PUT replaces the resource entirely — putting the same data twice gives the same result. DELETE removes a resource — deleting something already deleted is a no-op. POST is NOT idempotent — it typically creates a new resource each time. PATCH is ambiguous (depends on the operation). This is why POST endpoints (creating orders, charging payments) need explicit idempotency keys.

**Q: Where do I store idempotency keys?**
A: Redis is the most common choice — fast lookups, built-in TTL for automatic expiry. Store: `key → {status: "completed", response: {...}}`. The TTL should be long enough that clients have stopped retrying (24 hours is standard) but short enough to not waste storage. For critical operations (payments), also store in your primary database as a backup.

**Q: What if two identical requests arrive at the exact same millisecond?**
A: Use atomic operations. In Redis: `SET key value NX` (set only if key doesn't exist). In a database: unique constraint on the idempotency key column. The first request wins the race and processes; the second sees the key exists and waits for (or returns) the first request's result.

**Q: You're building a webhook delivery system. How does idempotency apply?**
A: Webhooks are retried when the receiver doesn't acknowledge. Your webhook consumer should extract a unique event ID from the webhook payload (most providers include one — Stripe's event has `id: "evt_123"`). Before processing, check if you've already handled that event ID. If yes, return 200 OK without reprocessing. If no, process and store the event ID. This way, even if the webhook fires 5 times for the same event, you only act on it once.

---

## Chapter 28: API Design (REST, gRPC, GraphQL)

**One-liner:** REST, gRPC, and GraphQL are three ways for services to talk to each other — each optimized for different communication patterns.

**Why you should care:** Your mobile app makes 15 API calls to load the home screen — user profile, posts, friends, notifications, ads. Each call returns too much data (the friends endpoint returns 50 fields, the app needs 3). On a 3G connection in rural India, the home screen takes 8 seconds. This is the "over-fetching" problem that led Facebook to build GraphQL. But switching everything to GraphQL isn't the answer either — your internal microservices communicating at millions of requests per second need something faster than JSON over HTTP. Choosing the right API style for each situation is a core design decision.

**Prerequisites:** Chapter 22 (Microservices), Chapter 4 (Latency vs Throughput)

### The Simple Version

**REST** is like sending letters. Each letter (request) is self-contained, has an address (URL), and you get a full response back. It's universally understood, simple, and works everywhere. But if you need just one paragraph from a 10-page letter, you still get all 10 pages.

**GraphQL** is like ordering from a buffet menu — you pick exactly what you want. "I want the user's name and their last 3 posts, but only the titles." No more, no less. The server assembles exactly what you asked for.

**gRPC** is like two computers talking in binary shorthand over a phone call. No wasted words, no English translation — just raw, fast data exchange. Perfect for two machines chattering at high speed behind the scenes, but not something a human would read.

### How It Actually Works

```
REST (Resource-based)
━━━━━━━━━━━━━━━━━━━━
GET /users/42         → full user object
GET /users/42/posts   → all posts (even fields you don't need)
GET /users/42/friends → all friends

3 round trips. Each returns everything.
Format: JSON over HTTP/1.1


GraphQL (Query-based)
━━━━━━━━━━━━━━━━━━━━
POST /graphql
{
  user(id: 42) {
    name
    posts(last: 3) { title }
    friends { name, avatar }
  }
}

1 round trip. Only requested fields.
Format: JSON over HTTP


gRPC (Contract-based)
━━━━━━━━━━━━━━━━━━━━
Defined in .proto file:
  service UserService {
    rpc GetUser (UserRequest) returns (User);
  }

Binary encoding (Protobuf). HTTP/2.
Streaming support. Type-safe.
~10x faster serialization than JSON.
```

| Feature | REST | GraphQL | gRPC |
|---|---|---|---|
| Format | JSON (text) | JSON (text) | Protobuf (binary) |
| Protocol | HTTP/1.1 or 2 | HTTP | HTTP/2 |
| Contract | Loose (OpenAPI optional) | Schema (strongly typed) | Proto files (strongly typed) |
| Best for | Public APIs, web apps | Mobile apps, complex UIs | Service-to-service, high throughput |
| Caching | Easy (HTTP caching) | Complex (POST-based) | Requires custom solution |

### Real-World Examples

**Example 1: Stripe — REST as the Gold Standard**

Stripe's API is widely considered the best REST API in the industry. Every resource has a predictable URL (`/v1/charges`, `/v1/customers`). Responses are consistent and well-documented. They chose REST because their API is public-facing — developers need something simple, cacheable, and universally understood. When a developer in any language wants to integrate payments, they know how HTTP and JSON work. Stripe processes billions of API calls per year on this REST interface.

**Example 2: Netflix — gRPC Between Services, GraphQL for Devices**

Netflix uses gRPC for internal communication between microservices — binary serialization keeps latency low at millions of requests per second across 1,000+ services. But for their client devices (TVs, phones, browsers), they built a GraphQL-like federation layer. Each device requests exactly the data it needs — a TV home screen needs large thumbnails and short descriptions, while the mobile app needs small thumbnails and longer text. One endpoint, custom responses per device.

### When To Use / When NOT To Use

| Style | Use When | Don't Use When |
|---|---|---|
| REST | Public APIs, browser clients, simple CRUD, you need HTTP caching | Mobile apps with over-fetching problems, high-throughput internal services |
| GraphQL | Complex UIs needing flexible data, mobile with bandwidth constraints, multiple client types | Simple APIs with 1-2 resources, server-to-server, when caching is critical |
| gRPC | Internal microservices, low-latency service-to-service, streaming (chat, video) | Public APIs (browser support is limited), when simplicity matters more than performance |

### Q&A

**Q: Can I use multiple API styles in one system?**
A: Absolutely, and most large systems do. A common pattern: gRPC between backend microservices (fast, typed, streaming), REST for public-facing APIs (universal, simple, cacheable), and GraphQL as a gateway for frontend clients (flexible queries, reduces over-fetching). Each layer uses the style that fits its needs.

**Q: Why not just use GraphQL for everything?**
A: Three reasons. (1) Caching is hard — REST's URL-based caching is trivial, GraphQL's POST-based queries aren't. (2) Security complexity — a malicious query like `{ user { friends { friends { friends { posts } } } } }` can hammer your database. You need query depth limiting and cost analysis. (3) Overhead — for simple "get one thing" APIs, GraphQL's query parsing adds latency without benefit.

**Q: Is REST "dead"?**
A: Not remotely. REST powers the vast majority of APIs on the internet. It's simple, well-understood, and cacheable. GraphQL and gRPC solve specific problems that REST handles less well, but for most use cases — especially public APIs — REST is still the right choice. Don't switch technologies because of hype; switch because you have the specific problem that technology solves.

**Q: What's the performance difference between JSON and Protobuf?**
A: Protobuf (used by gRPC) is roughly 3-10x smaller on the wire and 5-10x faster to serialize/deserialize than JSON. A JSON payload of 1KB might be 300 bytes in Protobuf. At 100,000 requests/second between microservices, that difference compounds — less bandwidth, less CPU, lower latency. But for a public API serving 100 requests/second, the difference is negligible and JSON's human-readability is worth more.

**Q: You're building a mobile app that shows a social feed. REST or GraphQL?**
A: GraphQL. The feed needs data from multiple sources (posts, authors, comments, likes, media) and each screen needs different fields. With REST, you'd either over-fetch (return full objects) or build custom endpoints for each screen. GraphQL lets the mobile client specify exactly what it needs per screen: `{ feed { post { title, thumbnail, author { name }, likeCount } } }`. One request, no wasted bytes. Facebook built GraphQL specifically for this problem.

---

## Chapter 29: WebSockets & Real-Time Communication

**One-liner:** WebSockets provide a persistent, two-way connection between client and server so either side can send data at any time — no polling required.

**Why you should care:** You're building a chat app. With regular HTTP, the client has to keep asking "any new messages?" every second (polling). With 10 million connected users, that's 10 million requests per second even when nobody is typing. Most responses are empty: "nope, no new messages." WebSockets flip this: the server pushes new messages to clients the instant they arrive. No wasted requests, no delay. This is how WhatsApp delivers 100 billion messages per day in real time.

**Prerequisites:** Chapter 4 (Latency vs Throughput), Chapter 10 (Load Balancers)

### The Simple Version

Regular HTTP is like sending a letter: you write a question, mail it, and wait for a reply. Every time you want to know something, you send another letter. You can't just yell across the room.

WebSockets are like a phone call. Once you dial and connect, both sides can talk at any time. You don't hang up and redial for every sentence. The line stays open, and either person can speak whenever they have something to say.

### How It Actually Works

```
HTTP Polling (wasteful)
━━━━━━━━━━━━━━━━━━━━━━
Client: "Any messages?" → Server: "No"     (wasted)
Client: "Any messages?" → Server: "No"     (wasted)
Client: "Any messages?" → Server: "Yes! 1 msg"
Client: "Any messages?" → Server: "No"     (wasted)

~75% of requests return nothing.


WebSocket (efficient)
━━━━━━━━━━━━━━━━━━━━━
Client ←──persistent connection──→ Server

  Server has message → pushes it immediately
  Client sends message → server gets it immediately
  No polling. No wasted requests.

Connection lifecycle:
1. Client sends HTTP request with "Upgrade: websocket"
2. Server responds "101 Switching Protocols"
3. Both sides now have a persistent TCP connection
4. Either side can send frames at any time
5. Connection stays open until explicitly closed
```

**Scaling challenge:** Each WebSocket connection holds a TCP socket open on the server. A server with 64K ports can handle about 50K-60K WebSocket connections. For 10 million users, you need hundreds of servers — and a way to route messages between them (usually a pub/sub system like Redis Pub/Sub or Kafka).

```
Scaling WebSockets
━━━━━━━━━━━━━━━━━━
  User A ──ws──→ Server 1
  User B ──ws──→ Server 2
  User C ──ws──→ Server 1

  A sends message to B:
  Server 1 → publishes to Redis/Kafka → Server 2 → pushes to B

  The pub/sub layer connects servers that hold
  different users' WebSocket connections.
```

### Real-World Examples

**Example 1: Slack — Persistent Connections for Workspaces**

Slack keeps a WebSocket connection open for every active user. When someone posts a message, the server pushes it to all members of that channel instantly. Slack handles millions of concurrent connections. They use a connection gateway layer that manages WebSocket lifecycle (connect, disconnect, reconnect) separately from the message routing logic. When your laptop sleeps and reconnects, the gateway replays missed messages from the last known position.

**Example 2: Coinbase — Real-Time Price Feeds**

Cryptocurrency prices change hundreds of times per second. Coinbase's WebSocket feed pushes price ticks to traders in real time — polling would add unacceptable latency and waste enormous bandwidth. Their WebSocket API sends only the data that changed (a price update is ~100 bytes), not the entire orderbook. At peak, they push millions of price updates per second to connected clients. The difference between seeing a price 1 second late vs. 50ms late can mean thousands of dollars in trading.

### When To Use / When NOT To Use

| Use WebSockets When | Don't Use WebSockets When |
|---|---|
| Real-time chat or messaging | Request-response APIs (use REST) |
| Live data feeds (stocks, sports scores, gaming) | Data that changes infrequently (use polling every 30s) |
| Collaborative editing (Google Docs) | One-directional updates (consider Server-Sent Events) |
| You need sub-second delivery | Stateless interactions where connection overhead isn't worth it |

**Alternatives:**
- **Server-Sent Events (SSE):** One-way push from server to client over HTTP. Simpler than WebSockets. Good for live feeds where the client only receives (stock tickers, notifications). No bidirectional communication.
- **Long polling:** Client sends a request that the server holds open until there's data. Simpler to implement, works through all proxies, but less efficient than WebSockets for high-frequency updates.

### Q&A

**Q: How many WebSocket connections can one server handle?**
A: Modern servers can handle 100K-1M concurrent WebSocket connections with proper tuning (epoll/kqueue, connection pooling, minimal per-connection memory). Each idle WebSocket uses only ~1-2KB of RAM. The bottleneck is usually message fan-out, not connections. A chat app where each message goes to 1 user is easier to scale than a stock ticker where each update goes to 100K subscribers.

**Q: What happens when the WebSocket connection drops?**
A: The client must reconnect and catch up on missed messages. Standard approach: (1) Client auto-reconnects with exponential backoff. (2) Client sends its "last received message ID" on reconnect. (3) Server replays everything after that ID. This is why chat apps need a message store (database) even though delivery is real-time — the store handles reconnection gaps.

**Q: How do WebSockets work with load balancers?**
A: WebSocket connections are "sticky" — once a client connects to a server, it stays on that server. Load balancers must support WebSocket upgrade and sticky sessions. For new connections, the load balancer routes normally. The challenge: if a server goes down, all its WebSocket connections drop. Clients reconnect to a different server and replay missed messages. This is why the message bus (Redis/Kafka) must be separate from WebSocket servers.

**Q: You're building a multiplayer game with 10,000 concurrent players. What's your WebSocket architecture?**
A: Multiple WebSocket servers behind a load balancer, connected by a Redis Pub/Sub or Kafka backbone. Each player connects to one WebSocket server. Game events (player moves, shots, item pickups) are published to a game room topic. Every WebSocket server subscribed to that room pushes the event to its local players. For latency-critical games, use UDP instead of WebSockets (TCP's head-of-line blocking adds jitter). For browser-based games, WebSockets over TCP is your only option — target <50ms round-trip between client and nearest server.

---

## Chapter 30: Data Serialization (JSON, Protobuf, Avro)

**One-liner:** Serialization converts in-memory objects into bytes for storage or transmission — and the format you choose affects speed, size, and flexibility.

**Why you should care:** Your microservice sends 500,000 messages per second to another service. Each message is a 2KB JSON object. That's 1 GB/sec of bandwidth — just for one service pair. Switch to Protobuf, and the same data is 400 bytes: 200 MB/sec. At scale, the wire format isn't a footnote — it's a multiplier on your infrastructure cost. LinkedIn moved from JSON to Protobuf for internal services and saw a 30% reduction in latency and significant bandwidth savings.

**Prerequisites:** Chapter 28 (API Design), Chapter 18 (Message Queues)

### The Simple Version

When you want to mail a package, you choose how to pack it. You could write a detailed letter describing every item (human-readable, but bulky), or you could use a coded inventory list where "A1" means "red shirt, medium" (compact, but you need the codebook to decode it).

JSON is the letter — anyone can read it, but it's verbose. Protobuf and Avro are the coded inventory — smaller and faster to read by machine, but you need the schema (codebook) to make sense of it.

### How It Actually Works

```
The same data in three formats:

JSON (text, human-readable)
━━━━━━━━━━━━━━━━━━━━━━━━━━
{"userId":42,"name":"Alice","email":"alice@example.com","age":30}
Size: 64 bytes. Field names repeated in every message.

Protobuf (binary, schema-required)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Defined in .proto:
  message User {
    int32 user_id = 1;
    string name = 2;
    string email = 3;
    int32 age = 4;
  }
Wire: 08 2A 12 05 41 6C 69 63 65 1A 11 ... (binary)
Size: ~30 bytes. Field NUMBERS, not names.

Avro (binary, schema in header)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Schema stored once (in header or registry).
Data = just values in order: [42, "Alice", "alice@example.com", 30]
Size: ~28 bytes. No field identifiers at all.
```

| Feature | JSON | Protobuf | Avro |
|---|---|---|---|
| Readability | Human-readable | Binary | Binary |
| Size | Large (~1x) | Small (~0.3-0.5x) | Smallest (~0.2-0.4x) |
| Speed | Slow parse | Fast parse | Fast parse |
| Schema required? | No | Yes (.proto file) | Yes (JSON schema) |
| Schema evolution | Add fields freely | Add fields (with field numbers) | Add/remove fields (with defaults) |
| Best for | Public APIs, debugging | gRPC, service-to-service | Kafka, data pipelines, analytics |

### Real-World Examples

**Example 1: Google — Protobuf Powers Internal Communication**

Google created Protocol Buffers in 2001, and it's used for virtually all internal RPC communication. Every Google service — Search, Gmail, YouTube, Maps — uses Protobuf. At Google's scale (trillions of RPCs per day), the size and speed difference between JSON and Protobuf saves millions in bandwidth and compute costs. Protobuf's schema also provides type safety — a service can't accidentally send a string where a number is expected.

**Example 2: LinkedIn — Avro for Kafka Pipelines**

LinkedIn created both Kafka and Avro. Their data pipeline processes trillions of events per day through Kafka, all serialized in Avro. Why Avro over Protobuf? Avro stores the schema separately in a Schema Registry — producers register their schema, and consumers look it up. This means the data on the wire is just values, no field markers. At LinkedIn's volume, those extra bytes per message (field numbers in Protobuf) add up to terabytes per day. Avro also handles schema evolution gracefully — producers and consumers can use different schema versions simultaneously.

### When To Use / When NOT To Use

| Format | Use When | Don't Use When |
|---|---|---|
| JSON | Public APIs, config files, debugging, small scale | High-throughput service-to-service, bandwidth-constrained |
| Protobuf | gRPC services, high-throughput internal APIs, mobile apps | You need human readability, quick prototyping |
| Avro | Kafka/streaming pipelines, data warehousing, Hadoop/Spark | Request-response APIs (Protobuf fits better), small projects |

### Q&A

**Q: If Protobuf is faster and smaller, why does anyone use JSON?**
A: Because JSON is universal. Every language can parse it. Every developer can read it. Every browser understands it. You can `curl` an API and see the response immediately. Protobuf requires a .proto file, code generation, and binary tooling. For public APIs, config files, and small-scale services, JSON's simplicity and debuggability outweigh Protobuf's performance.

**Q: What happens when you add a field to a Protobuf message?**
A: Old consumers ignore the new field (forward compatibility). New consumers see a default value for missing fields (backward compatibility). This works because Protobuf uses field numbers, not names — field 5 is always field 5 regardless of what you named it. The rules: never reuse a field number, never change a field's type, always make new fields optional with defaults.

**Q: How does a Schema Registry work?**
A: It's a central service (like Confluent Schema Registry for Kafka) that stores and versions schemas. Producers register their schema, get a schema ID, and include it in messages. Consumers read the schema ID from the message and fetch the schema from the registry. The registry enforces compatibility rules — it can reject a new schema version that would break existing consumers.

**Q: You're sending 1 million events/sec through Kafka. Which format?**
A: Avro with a Schema Registry. At 1M events/sec, every byte matters — Avro's schema-free wire format is the smallest. The Schema Registry gives you compatibility checks on deploy (will the new version break consumers?) and lets producers and consumers evolve independently. This is exactly LinkedIn's architecture, and it's the industry standard for Kafka-based data pipelines.

---

## Chapter 31: Service Discovery

**One-liner:** Service discovery is how services find each other's network addresses in a dynamic environment where instances are constantly starting, stopping, and moving.

**Why you should care:** You have 200 microservices, each running 10 instances. That's 2,000 instances, each with a different IP address. When the Order Service needs to call the Payment Service, which of Payment's 10 instances should it call? Hardcoding IP addresses? They change every time an instance restarts. A config file? Stale within minutes. In a cloud environment where instances are auto-scaled, deployed, and replaced constantly, you need a way for services to find each other automatically. Without service discovery, your microservices architecture is a pile of disconnected parts.

**Prerequisites:** Chapter 9 (DNS), Chapter 10 (Load Balancers), Chapter 22 (Microservices)

### The Simple Version

Service discovery is like a hotel front desk. Guests (services) check in and say "I'm in room 305" (register their address). When someone wants to find a guest, they don't wander the hallways — they ask the front desk. If a guest checks out (instance dies), the front desk removes them from the list. New guests check in constantly, and the desk always has the current directory.

### How It Actually Works

```
Service Registry Pattern
━━━━━━━━━━━━━━━━━━━━━━━━

  ┌──────────────┐
  │   Registry   │  (Consul, etcd, ZooKeeper)
  │              │
  │ payment-svc: │
  │  10.0.1.5    │
  │  10.0.1.6    │
  │  10.0.1.7    │
  │              │
  │ order-svc:   │
  │  10.0.2.1    │
  │  10.0.2.2    │
  └──────┬───────┘
         │
    1. Register │ 2. Discover
         │          │
  ┌──────┴──┐  ┌────┴─────┐
  │Payment  │  │ Order    │
  │Service  │  │ Service  │
  │(startup)│  │("where   │
  │"I'm at  │  │ is       │
  │10.0.1.5"│  │ Payment?")│
  └─────────┘  └──────────┘


Two approaches:

Client-Side Discovery
━━━━━━━━━━━━━━━━━━━━━
  Order Service → queries Registry → gets [10.0.1.5, .6, .7]
  → picks one (round robin, least connections)
  → calls directly

Server-Side Discovery
━━━━━━━━━━━━━━━━━━━━━
  Order Service → calls load balancer → LB queries Registry
  → LB picks instance → forwards request
  (Client doesn't know about instances)
```

**Health checks:** The registry must know when instances die. Two approaches: (1) instances send heartbeats every 10 seconds — miss 3, get deregistered. (2) The registry actively checks each instance's `/health` endpoint. Both prevent routing traffic to dead instances.

### Real-World Examples

**Example 1: Netflix — Eureka for Service Discovery**

Netflix built Eureka, an open-source service registry. Every Netflix microservice registers itself with Eureka on startup and sends heartbeats every 30 seconds. When a service needs to call another, it asks Eureka for the list of healthy instances and load-balances across them (client-side discovery using Ribbon). At Netflix's scale (1,000+ services), Eureka handles millions of registrations and lookups. Netflix chose client-side discovery for performance — no extra hop through a load balancer for every internal call.

**Example 2: Kubernetes — Built-in Service Discovery**

Kubernetes made service discovery invisible. You create a "Service" object, and Kubernetes gives it a stable DNS name (`payment-service.default.svc.cluster.local`). Behind that DNS name, Kubernetes automatically routes to healthy pods. When pods scale up or down, the routing updates automatically. No external registry needed — it's built into the platform. This is why Kubernetes largely replaced standalone tools like Eureka and Consul for many teams: service discovery "just works."

### When To Use / When NOT To Use

| Use When | Don't Use When |
|---|---|
| Microservices with dynamic scaling (instances come and go) | Monolith (no services to discover) |
| Cloud/container deployments where IPs change | Fixed infrastructure where IPs are static |
| You have 10+ services that call each other | 2-3 services with known, stable addresses |
| Auto-scaling based on load | Manual deployments where you control everything |

### Q&A

**Q: Why can't I just use DNS for service discovery?**
A: DNS caching. When an instance dies, DNS might still return its IP for minutes (TTL). In a dynamic environment, stale DNS entries mean requests go to dead instances. Service registries update in seconds with health checks. That said, Kubernetes solves this by controlling the DNS layer itself — its internal DNS updates instantly when pods change, so DNS works if you control the DNS server.

**Q: Client-side vs server-side discovery — which is better?**
A: Client-side (Netflix Eureka) is faster — no extra hop. But every client needs a discovery library. Server-side (Kubernetes, AWS ALB) is simpler — clients just call a DNS name, and the infrastructure handles routing. Server-side wins when you don't control client code (external APIs) or want simpler clients. Client-side wins when you need custom load balancing logic (e.g., route to the closest instance).

**Q: What happens during deployment when old and new instances coexist?**
A: The registry has both versions registered. New instances register as they start; old instances deregister as they shut down. Graceful shutdown is critical: the old instance should (1) deregister from the registry, (2) finish in-flight requests, (3) then shut down. If it shuts down without deregistering, traffic hits a dead instance until the health check catches up.

**Q: You're deploying 50 microservices on Kubernetes. Do you need Consul or Eureka?**
A: Probably not. Kubernetes' built-in service discovery (kube-dns + Services) handles most use cases. Each service gets a stable DNS name, and Kubernetes routes to healthy pods automatically. You'd add Consul or Eureka if you need service discovery *across* Kubernetes clusters, if some services run outside Kubernetes, or if you need advanced features like service mesh with mTLS.

---

## Chapter 32: Observability (Metrics, Logging, Tracing)

**One-liner:** Observability is the ability to understand what's happening inside your system by looking at what it outputs — metrics, logs, and traces are the three pillars.

**Why you should care:** It's 2 AM. Your on-call phone buzzes: "Checkout is slow." You check the server: CPU is fine, memory is fine, disk is fine. The checkout service is healthy. But users are experiencing 5-second response times. Without observability, you're blind — you'd guess, restart things, and hope. With observability, you pull up a trace for a slow request and see: the checkout service called the inventory service, which called the database, which waited 4.8 seconds for a lock because a batch job is running. Problem found in 3 minutes instead of 3 hours. This is the difference between operating a system and understanding it.

**Prerequisites:** Chapter 22 (Microservices), Chapter 10 (Load Balancers)

### The Simple Version

Imagine you're a doctor. You can't see inside the patient's body directly. But you have three types of information:

- **Vital signs** (metrics): Heart rate is 120 bpm, blood pressure is 150/90. Numbers over time that show trends and alert you to problems.
- **Patient diary** (logs): "At 3 PM, felt chest pain. At 3:15, took aspirin." Timestamped events with details about what happened.
- **X-ray/MRI** (traces): A picture showing exactly where the blockage is and which artery is affected. A complete path through the body.

Together, these three views let you diagnose almost any problem. Separately, each tells only part of the story.

### How It Actually Works

```
The Three Pillars of Observability
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

METRICS (what's happening now?)
  request_count: 1,523/sec
  error_rate: 2.3%
  p99_latency: 450ms
  cpu_usage: 72%
  → Dashboards, alerts, trends
  → Tools: Prometheus, Datadog, CloudWatch

LOGS (what happened?)
  [2024-01-15 02:13:45] ERROR checkout-svc
    "Payment timeout for order #12345,
     user_id=42, amount=$99.50,
     payment_provider=stripe, timeout=5000ms"
  → Debugging, audit trails
  → Tools: ELK Stack, Splunk, Loki

TRACES (where did it go?)
  Request: GET /checkout
  ├── checkout-svc      [12ms]
  │   ├── auth-svc      [3ms]
  │   ├── cart-svc       [8ms]
  │   ├── inventory-svc  [4,800ms] ← THE PROBLEM
  │   │   └── database   [4,795ms] ← lock wait
  │   └── payment-svc    [skipped — timeout]
  └── Total: 4,823ms
  → Root cause analysis
  → Tools: Jaeger, Zipkin, Datadog APM
```

**How they work together:**
1. **Alert** fires: p99 latency > 2 seconds (metric)
2. **Dashboard** shows: inventory-svc latency spiked at 2:10 AM (metric)
3. **Trace** shows: requests through inventory-svc wait 4+ seconds on database (trace)
4. **Log** shows: "Lock wait timeout on products table, batch_job_id=789" (log)
5. **Root cause**: The nightly batch job is locking the products table while checkout queries run

### Real-World Examples

**Example 1: Google — Dapper and the Birth of Distributed Tracing**

Google built Dapper in 2010 because their engineers couldn't debug problems in systems with hundreds of services. A single web search touches 10+ services, and a slowdown anywhere is invisible without tracing. Dapper assigns a unique trace ID to each request and propagates it through every service call. Engineers search by trace ID and see the complete call tree — which service was slow, which RPC failed, where the bottleneck is. Dapper's design inspired Zipkin (Twitter), Jaeger (Uber), and the OpenTelemetry standard used industrywide today.

**Example 2: Uber — Observability at 5 Billion Trips**

Uber processes thousands of trips per second across microservices for matching, pricing, routing, payments, and notifications. They built M3, an internal metrics platform, and adopted Jaeger (which they open-sourced) for distributed tracing. When riders reported slow ETA updates, Uber traced the request path and found that a DNS lookup was timing out for 2% of requests to the maps service. Without tracing, this would have looked like random slowness across multiple services. The fix: a DNS cache change, deployed in hours.

### When To Use / When NOT To Use

| Use When | Don't Use When |
|---|---|
| You have more than a few services | Single-server monolith (a debugger and server logs are enough) |
| You need to find the root cause of latency across services | You only need basic uptime monitoring |
| You're running in production with real users | Local development (use a debugger) |
| You need to prove SLA compliance | The cost of tooling exceeds the cost of downtime |

**The cost:** Observability infrastructure (Prometheus, ELK, Jaeger or their SaaS equivalents) takes effort to set up and costs real money. Datadog bills by host and log volume — at scale, observability can be one of the top 3 infrastructure costs. Start with metrics and basic logging. Add tracing when you have enough services that cross-service debugging becomes painful.

### Q&A

**Q: What's the difference between monitoring and observability?**
A: Monitoring answers known questions: "Is the server up? Is CPU over 80%?" You define the checks in advance. Observability lets you answer unknown questions: "Why are 3% of requests to the checkout service slow only when the user is in Europe?" You didn't predict this question — but metrics, logs, and traces together let you investigate it. Monitoring tells you THAT something is wrong. Observability tells you WHY.

**Q: Do I really need all three pillars?**
A: At scale, yes. Metrics alone tell you something is wrong but not where. Logs alone give detail but no cross-service view. Traces alone show the path but not historical trends. The combination is what makes debugging fast: metrics alert you, traces show you the path, logs give you the details. Start with metrics (cheapest, most actionable), add logging, then add tracing as your service count grows.

**Q: How does a trace propagate across services?**
A: Through context propagation. The first service generates a trace ID (e.g., `trace-abc-123`) and passes it in an HTTP header (`X-Trace-ID: trace-abc-123`). Every downstream service reads this header, logs it, and passes it along. When you search for `trace-abc-123`, you see every service's span — how long it took, what it called, and where it waited. OpenTelemetry standardizes this propagation format.

**Q: You're on call and the dashboard shows checkout p99 latency jumped from 200ms to 3 seconds. Walk through your debugging process.**
A: (1) Check the metrics dashboard: when did it start? Is it all traffic or a specific region? (2) Look at the service dependency graph: which downstream service shows elevated latency? Suppose it's the payment service. (3) Pull a trace for a slow checkout request: see that the payment-service call takes 2.8 seconds. (4) Look at payment-service metrics: is it all instances or one? (5) Check payment-service logs around the timestamp: "Connection pool exhausted, waiting for available connection." Root cause: the payment service's database connection pool is too small for the current traffic. Fix: increase the pool size, add a connection pooling proxy, or scale out the service.

---

## Putting It Together: Design a Food Delivery App Backend

*Let's see how the patterns from Part 3 solve real problems by designing the backend for a food delivery app like DoorDash or Uber Eats.*

### The Setup

Your app handles: customers ordering food, restaurants receiving and preparing orders, and drivers picking up and delivering them. At peak dinner time (6-9 PM), you serve 50,000 orders per hour across 100 cities.

### Architecture Decisions — Pattern by Pattern

**1. Microservices (Chapter 22) — Team Independence**

You have separate teams for customer experience, restaurant tools, driver logistics, and payments. A monolith would have them all stepping on each other. You split into services:

```
Services and Ownership
━━━━━━━━━━━━━━━━━━━━━━
┌─────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐
│ Customer │ │Restaurant│ │  Driver  │ │ Payment │
│ Service  │ │ Service  │ │ Service  │ │ Service │
└────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬────┘
     │            │            │             │
┌────┴─────┐ ┌───┴──────┐ ┌───┴──────┐ ┌────┴────┐
│CustomerDB│ │RestaurantDB│ │DriverDB │ │PaymentDB│
└──────────┘ └──────────┘  └─────────┘ └─────────┘
```

Each team deploys independently. The payment team can upgrade their service without touching driver logistics.

**2. Event-Driven Architecture (Chapter 23) — Order Flow**

An order triggers a cascade of actions. You don't chain synchronous calls — you publish events:

```
Order Lifecycle Events
━━━━━━━━━━━━━━━━━━━━━━
OrderPlaced → Payment Service (charge card)
           → Restaurant Service (notify kitchen)
           → Analytics (track conversion)

PaymentConfirmed → Order Service (update status)
                 → Driver Service (find driver)

OrderReady → Driver Service (notify for pickup)
           → Customer Service (push notification: "food is ready!")

OrderDelivered → Payment Service (pay restaurant + driver)
              → Rating Service (prompt for review)
              → Analytics (track delivery time)
```

Adding a promotion engine? Subscribe to "OrderPlaced." Adding fraud detection? Subscribe to "PaymentConfirmed." Zero changes to existing services.

**3. API Design (Chapter 28) — Different Clients, Different Needs**

- **Customer mobile app:** GraphQL gateway — the home screen needs restaurants, menus, prices, and estimated delivery times from multiple services in one call.
- **Between microservices:** gRPC — low latency, type-safe, binary encoding for high-throughput internal communication.
- **Restaurant tablet app:** REST — simpler client, CRUD operations (update menu, mark order ready). Restaurants care about reliability, not cutting-edge API tech.

**4. WebSockets (Chapter 29) — Live Tracking**

Once an order is placed, the customer needs real-time updates:

```
Live Order Tracking
━━━━━━━━━━━━━━━━━━
Customer App ←──WebSocket──→ Tracking Service

  "Driver accepted your order"
  "Driver picked up your food"
  "Driver is 5 minutes away"    ← GPS updates every 3 seconds
  "Driver arrived"
```

The driver's GPS location updates push through the WebSocket to the customer's map. No polling — the map updates smoothly.

**5. Circuit Breaker (Chapter 26) — Restaurant API Failures**

Restaurants often use third-party POS systems. When Acme POS goes down, you don't want all orders to those restaurants to hang:

```
Circuit Breaker on POS Integration
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Order Service → Circuit Breaker → Acme POS API

CLOSED: Orders route to POS normally
OPEN:   POS is down → fallback: queue orders internally,
        alert restaurant via SMS, process when POS recovers
```

**6. Idempotency (Chapter 27) — No Double Charges**

A customer's app sends the payment request, the network hiccups, and the app retries. Without idempotency, they're charged twice. Every payment request includes an idempotency key tied to the order ID. The Payment Service processes only the first request and returns the cached result for retries.

**7. Observability (Chapter 32) — Finding Dinner Rush Bottlenecks**

At 7 PM, delivery times spike to 90 minutes. Metrics show the Driver Service latency is normal — but the matching algorithm takes 200ms per order. Tracing reveals: the algorithm queries the Driver DB for available drivers within 5 miles, and the geo-query is scanning the full table. The log shows: "Index not used, falling back to sequential scan." Fix: add a geo-spatial index (PostGIS). Delivery times drop back to 45 minutes.

### Key Takeaway

No single pattern built this system. Microservices gave teams independence. Events kept services loosely coupled. GraphQL optimized the mobile experience. WebSockets enabled real-time tracking. Circuit breakers isolated third-party failures. Idempotency prevented double charges. Observability found the dinner rush bottleneck. Each pattern from Part 3 solved a specific problem — and together, they form a production system that serves millions of meals.

---

*Part 3 complete. You now know the patterns: microservices vs monolith, event-driven architecture, CQRS, consistent hashing, circuit breakers, idempotency, API design, WebSockets, data serialization, service discovery, and observability. Next up: Part 4 — Distributed Systems. The hard stuff: consensus, distributed locking, transactions across services, and the scariest failure modes.*
