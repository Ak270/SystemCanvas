# Part 1: Foundations — The "Why" Before the "How"

*These 8 concepts are the vocabulary of system design. Every chapter in this book builds on them. Skip this part and everything later will feel like memorizing — not understanding.*

---

## Chapter 1: What Is System Design?

**One-liner:** System design is deciding how to organize your software so it works when real people actually use it.

**Why you should care:** You build a todo app. It works on your laptop. You deploy it. 50,000 people sign up on launch day. The database melts. The server crashes. Users see blank screens. You didn't write bad code — you made no design decisions at all. System design is the difference between "it works on my machine" and "it works for a million people."

**Prerequisites:** None. This is where we start.

### The Simple Version

Imagine you're opening a coffee shop. Writing code is like learning to make great coffee. System design is everything else: How many baristas do you hire? What happens when a line of 200 people forms? Where do you put the pickup counter so it doesn't block the entrance? What if the espresso machine breaks — do you close the whole shop?

Nobody opens a coffee shop by only learning to brew. But that's exactly what most developers do with software — they learn to code but never think about what happens when the real world shows up.

### How It Actually Works

System design answers four questions about your software:

1. **How does it handle growth?** (Scalability) — 10 users today, 10 million tomorrow
2. **What happens when things break?** (Reliability) — servers crash, networks fail, disks die
3. **How fast does it respond?** (Performance) — users leave after 3 seconds of waiting
4. **How do the pieces fit together?** (Architecture) — databases, servers, caches, queues, and the wires between them

```
What System Design Actually Decides
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  "Just code"          vs.          System Design
  ─────────                         ─────────────
  One server                        How many servers? How do they share work?
  One database                      Which database? How is data organized?
  Hope it works                     What breaks? What's the backup plan?
  Works for me                      Works for users on 3G in Mumbai
```

Every chapter in this book teaches you one piece of this puzzle. By the end, you'll assemble them into complete systems.

### Real-World Examples

**Example 1: Twitter's Fail Whale (2008-2013)**

Twitter started as a simple Ruby on Rails app. One server, one database. When it got popular, the site crashed so often that users saw a "fail whale" error page more than their actual timeline. Twitter had to completely redesign its architecture — splitting into dozens of services, adding caches everywhere, moving from MySQL to a custom storage system. The rewrite took years. If they'd thought about design earlier, they wouldn't have needed to rebuild the plane mid-flight.

**Example 2: WhatsApp — 50 Engineers, 900 Million Users (2014)**

When Facebook acquired WhatsApp for $19 billion, it had 900 million users and just ~50 engineers. How? They made deliberate design choices from day one: Erlang for concurrency (one server handling 2 million connections), minimal features (no stories, no ads, no algorithmic feed), and a simple architecture optimized for message delivery. Good system design doesn't mean complex design — it means the right design.

### When To Use System Design Thinking

| Think About Design When | Don't Overthink Design When |
|------------------------|---------------------------|
| Multiple users will use it concurrently | It's a personal script or tool |
| Data matters (you can't lose it) | It's a prototype or hackathon project |
| Downtime costs money or trust | You have < 100 users and no growth plans |
| You're deploying to production | You're learning or experimenting |

### The Interview Framework: RESHADED

In a system design interview, you have ~45 minutes. Don't just start drawing boxes. Use this structure:

| Step | What To Do | Time |
|------|-----------|------|
| **R** — Requirements | Ask: what does this system do? How many users? What's critical? | 5 min |
| **E** — Estimation | Back-of-envelope math: storage, bandwidth, QPS | 5 min |
| **S** — Storage schema | Data model and database choice | 5 min |
| **H** — High-level design | Draw the main components and data flow | 10 min |
| **A** — API design | Core endpoints, request/response format | 5 min |
| **D** — Detailed design | Deep-dive into 2-3 critical components | 10 min |
| **E** — Evaluate | Trade-offs, bottlenecks, failure handling | 3 min |
| **D** — Distinguish | What makes your design unique? Monitoring, security, cost | 2 min |

### Q&A

**Q: Wait, so system design is basically just... deciding how to organize your app?**
A: Yes, but "organize" is doing a lot of work. It's deciding how many servers you need, which database to use, what happens when a server dies, how to handle 100x traffic, where to put caches, how services talk to each other, and dozens of other decisions. Each one has trade-offs, and the combination determines whether your system works at scale or collapses under pressure.

**Q: When should I start thinking about system design — before I write code or after?**
A: Before. Not a 6-month architecture phase — 30 minutes of thinking about "what are my requirements, how much traffic will this get, and what's my data model" saves weeks of rewriting later. Twitter spent years rebuilding because they didn't think about it early. WhatsApp spent 30 minutes on architecture and it lasted to 900 million users.

**Q: What's the difference between system design and software architecture?**
A: Software architecture is how you structure your code (classes, modules, layers). System design is how you structure your infrastructure (servers, databases, networks, caches). Architecture asks "how should I organize this codebase?" System design asks "how do I make this work for a million users across the world?" They overlap, but system design operates at a higher altitude.

**Q: You're building an internal dashboard for 50 employees. It shows sales data from a database. How much system design do you need?**
A: Almost none. One server, one database, maybe a cache if queries are slow. No load balancer, no sharding, no message queues. System design thinking means knowing when NOT to over-engineer. The trap is applying Netflix-scale solutions to 50-user problems.

**Q: Your simple dashboard suddenly gets adopted company-wide — 10,000 employees hitting it during Monday morning meetings. What breaks first?**
A: The database. 10,000 users running the same heavy analytics queries simultaneously will overwhelm it. First fix: add a cache (Redis) so the same report isn't regenerated 10,000 times. Second: if queries are complex, precompute the reports overnight and serve static results. You don't need microservices — you need one cache and one background job.

---

## Chapter 2: Scalability

**One-liner:** Scalability is your system's ability to handle growth — more users, more data, more requests — without falling over.

**Why you should care:** Your app gets featured on Product Hunt. Traffic goes from 100 requests per minute to 50,000. Your single server maxes out its CPU, the database queue backs up to 10,000 pending queries, and users see timeout errors. You just got the best marketing of your life, and your system turned it into a disaster. Scalability is the difference between "we're growing!" and "we're down."

**Prerequisites:** Chapter 1 (What Is System Design?)

### The Simple Version

Imagine your coffee shop gets a line out the door. You have two options:

**Option 1: Get a bigger coffee machine.** It makes coffee faster, handles more orders. But there's a limit — the biggest machine in the world still can't make 10,000 coffees per hour. This is **scaling up** (vertical scaling).

**Option 2: Open more coffee shops.** Each shop handles a portion of customers. You can keep opening shops almost forever. But now you need to figure out which shop each customer goes to, and how to keep the menu consistent across all locations. This is **scaling out** (horizontal scaling).

Most real systems use both: scale up until you hit the ceiling, then scale out.

### How It Actually Works

**Vertical scaling (scale up):** Add more CPU, RAM, or storage to your existing server. Simple — your code doesn't change. But there's a hard ceiling: the biggest AWS instance (u-24tb1.metal) has 448 vCPUs and 24 TB of RAM. After that, you're stuck.

**Horizontal scaling (scale out):** Add more servers and distribute work across them. No ceiling — add servers forever. But your code must change: you need load balancers, stateless services, and strategies for splitting data.

```
Vertical vs Horizontal Scaling
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Vertical (Scale Up)              Horizontal (Scale Out)
  ┌─────────────────┐              ┌────────┐ ┌────────┐ ┌────────┐
  │                 │              │Server 1│ │Server 2│ │Server 3│
  │  BIGGER SERVER  │              └───┬────┘ └───┬────┘ └───┬────┘
  │  More CPU       │                  │          │          │
  │  More RAM       │              ┌───┴──────────┴──────────┴───┐
  │  More Disk      │              │       Load Balancer          │
  │                 │              └──────────────────────────────┘
  └─────────────────┘
  Simple, but has a ceiling         Complex, but no ceiling
```

| | Vertical Scaling | Horizontal Scaling |
|---|---|---|
| How | Bigger machine | More machines |
| Code changes | None | Significant (stateless design, data partitioning) |
| Ceiling | Hardware limits | Virtually none |
| Downtime risk | Single point of failure | One server dies, others continue |
| Cost curve | Exponential (2x CPU ≠ 2x price) | Linear (2x servers ≈ 2x price) |
| Used by | Small-medium apps, databases | Large-scale web apps, microservices |

### Real-World Examples

**Example 1: Stack Overflow — Vertical Scaling Done Right**

Stack Overflow serves 1.3 billion page views per month with just 9 web servers. They scale vertically: powerful machines with lots of RAM, aggressive caching (SQL Server's in-memory features + Redis), and highly optimized code. Their total infrastructure cost is a fraction of what most companies spend. Lesson: vertical scaling works longer than you think if you optimize well. Don't jump to microservices and Kubernetes at 1,000 users.

**Example 2: Instagram — Horizontal Scaling Under Pressure**

When Instagram launched in October 2010, they had 25,000 signups on day one — on a single Django server and a single PostgreSQL database. Within a week they had to horizontally scale: multiple app servers behind a load balancer, read replicas for the database, and Redis for caching. By the time Facebook acquired them (2012, 30 million users), they had dozens of servers. The key move was making their app servers stateless — any server could handle any request because sessions lived in Redis, not on the server.

### When To Use / When NOT To Use

| Scale Up When | Scale Out When |
|--------------|---------------|
| You have < 10,000 users and a single server isn't struggling | Single server can't keep up regardless of hardware |
| Your database is the bottleneck (bigger instance is faster than sharding) | You need fault tolerance (one server dying can't kill the system) |
| You want simplicity — no distributed systems complexity | Traffic is spiky and you want to add/remove capacity dynamically |
| You can afford the premium for big machines | Cost efficiency matters — many small machines beat one giant one |

### Q&A

**Q: Can't I just scale up forever? Why bother with horizontal scaling?**
A: Physics. The biggest server you can buy today has ~448 CPU cores and ~24 TB RAM. If your app needs more than that, you're done. More practically, costs grow exponentially — a server with 2x the CPU costs 3-4x the price. And you have a single point of failure: if that one beefy server dies, everything is down.

**Q: If horizontal scaling is so great, why doesn't everyone just start with it?**
A: Because it's hard. The moment you have two servers, you face questions you never had before: How do you split traffic? Where do sessions live? How do you keep data consistent across machines? What if Server 1 writes something and Server 2 doesn't know about it yet? These are real distributed systems problems. For most apps, you won't hit vertical scaling limits for years.

**Q: What's the difference between scalability and performance?**
A: Performance is how fast your system handles one request. Scalability is how well it handles a growing number of requests. A system can be fast but not scalable (one server that replies in 2ms but crashes at 1,000 concurrent users). Or scalable but not fast (100 servers that handle 10 million users but each request takes 3 seconds). You need both.

**Q: You're designing a social media app. You expect 1,000 users in month one and 1 million by year one. How do you plan for scaling?**
A: Start simple: one or two app servers behind a load balancer, one database with read replicas, Redis for caching sessions and hot data. Make app servers stateless from day one — this is free and makes horizontal scaling trivial later. Don't shard the database yet (you probably won't need it until 10+ million users). Monitor your bottlenecks. Scale vertically first (bigger database instance), then horizontally (add app servers, then eventually shard). The key is making the right decisions early (stateless servers, caching) so you CAN scale later without a rewrite.

**Q: Your e-commerce site works fine normally but crashes every Black Friday. What's the cheapest fix?**
A: Auto-scaling. Cloud providers (AWS, GCP) can automatically spin up more servers when CPU or request count crosses a threshold, and spin them down after. You pay for the extra capacity only during the spike. This only works if your servers are stateless (they should be). For the database layer, add read replicas and put a cache in front of heavy queries. Precompute anything you can — product pages that don't change every second should be cached, not regenerated per request.

---

## Chapter 3: Availability & Reliability

**One-liner:** Availability is how often your system is up and usable; reliability is how correctly it behaves — even when things break.

**Why you should care:** Your payment service goes down for 2 hours on a Saturday afternoon. 50,000 transactions fail. Customers can't pay. Merchants lose sales. Your support team drowns in tickets. Your CEO gets an angry email from the VP of Sales. Monday morning meeting becomes a post-mortem. Two hours of downtime just cost the company $500,000 in lost revenue and months of customer trust. This happens to real companies every month.

**Prerequisites:** Chapters 1-2 (What Is System Design?, Scalability)

### The Simple Version

Think about electricity in your house. **Availability** is: does the power work when you flip the switch? You expect it to work 99.99% of the time. When there's a blackout, you're annoyed — and if you run a hospital, people could die.

**Reliability** is: does the power give you a clean 120V signal? If the voltage fluctuates wildly, your lights might be "on" but your computer fries.

Your system can be available but unreliable (it responds, but gives wrong answers). Or reliable but unavailable (when it's up it's perfect, but it's down half the time). You need both.

### How It Actually Works

Availability is measured in "nines":

| Availability | Downtime / Year | Downtime / Month | Common Name |
|---|---|---|---|
| 99% | 3.65 days | 7.3 hours | Two nines |
| 99.9% | 8.77 hours | 43.8 minutes | Three nines |
| 99.99% | 52.6 minutes | 4.38 minutes | Four nines |
| 99.999% | 5.26 minutes | 26.3 seconds | Five nines |

Going from 99.9% to 99.99% sounds like a tiny improvement. It's actually 10x harder and 10x more expensive. Each "nine" requires fundamentally different engineering.

**The four techniques that make systems available:**

1. **Redundancy** — No single point of failure. Two of everything that matters: servers, databases, network paths
2. **Failover** — When something dies, traffic automatically moves to the backup (active-passive or active-active)
3. **Health checks** — Constantly test "is this server alive?" and remove dead ones from rotation
4. **Multi-region** — Deploy in multiple data centers so a whole region can fail without taking you down

```
Single Point of Failure vs. Redundancy
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  FRAGILE                           RESILIENT
  ┌──────┐                          ┌──────┐  ┌──────┐
  │Server│ ← if this dies,          │Server│  │Server│ ← if one dies,
  └──┬───┘   everything dies        │  A   │  │  B   │   the other
     │                              └──┬───┘  └──┬───┘   takes over
  ┌──┴───┐                          ┌──┴─────────┴───┐
  │  DB  │                          │ Load Balancer   │
  └──────┘                          └───┬─────────┬───┘
                                    ┌───┴──┐  ┌───┴──┐
                                    │ DB   │  │  DB  │
                                    │Primary│ │Replica│
                                    └──────┘  └──────┘
```

### Real-World Examples

**Example 1: AWS S3 — Eleven Nines of Durability**

Amazon S3 promises 99.999999999% durability (eleven nines). That means if you store 10 million objects, you'd statistically lose one every 10,000 years. How? Every object is replicated across at least 3 physical facilities within a region, each in a different building with independent power and networking. They continuously verify data integrity with checksums and automatically repair corrupted copies. But note: S3's *availability* is only 99.99% (four nines) — the data is safe, but the service might be temporarily unreachable.

**Example 2: GitHub's 2018 Outage — 24 Hours of Degraded Service**

In October 2018, GitHub experienced 24 hours and 11 minutes of degraded service. A routine maintenance operation (replacing a failing network device) caused a 43-second loss of connectivity between a primary database and its replicas. This triggered a split-brain: the primary and replicas diverged, accepting conflicting writes. GitHub chose data integrity over availability — they took the site into a degraded state rather than serve inconsistent data. Recovery took 24 hours because they had to reconcile the diverged data. Lesson: availability and data integrity can conflict, and sometimes choosing downtime is the right call.

### When To Use / When NOT To Use

| Invest Heavily in Availability When | Don't Over-Engineer Availability When |
|---|---|
| Downtime directly loses money (e-commerce, payments, ads) | It's an internal tool used during business hours |
| People's health or safety depends on it (medical, infrastructure) | Users can tolerate minutes of downtime (dev tools, analytics dashboards) |
| SLA contracts penalize you for downtime | You're a startup with 100 users — spend time on features instead |
| You serve a global audience across time zones (there's no "off-hours") | The cost of five-nines exceeds the revenue the system generates |

### Q&A

**Q: If 99.9% uptime sounds like it means "almost never down," why do big companies aim for 99.99% or higher?**
A: Because 99.9% means 8 hours and 46 minutes of downtime per year. Spread that across a year, and it's a 40-minute outage every month. For a payment system processing $10 million/day, that's $280,000 in lost transactions per outage. At 99.99%, downtime drops to 4 minutes per month — annoying but survivable. The math changes based on what your system does.

**Q: What's the relationship between availability and redundancy? If I have 2 servers, what's my availability?**
A: If each server has 99% availability (independently), and you need only one to be up, your combined availability is: 1 - (0.01 × 0.01) = 99.99%. Two mediocre servers give you much better availability than one great server. But this assumes failures are independent — if both servers share the same power supply or network switch, they'll fail together, and your actual availability is back to 99%.

**Q: What's the difference between availability and reliability?**
A: Availability answers: "Can I reach the system right now?" Reliability answers: "Does it give correct results?" A database that's up 99.99% of the time but occasionally returns stale data is highly available but not reliable. A calculator that's offline half the time but always gives exact answers when up is reliable but not available. Payment systems need both. A social media "likes" counter can sacrifice some reliability (off by a few) for availability.

**Q: You're designing a ride-sharing app. Your SLA promises 99.95% availability. A whole AWS region goes down (this has happened). How do you survive?**
A: Multi-region deployment. Run your critical services (matching riders with drivers, payment processing) in at least two AWS regions. Use DNS-based routing (Route 53) to send users to the nearest healthy region. The hard part is the database: you need cross-region replication, and you must choose between strong consistency (slower, risk of unavailability if replication lags) and eventual consistency (faster, but a rider might see stale driver locations for a few seconds). For ride-sharing, eventual consistency on driver locations is acceptable — the matching algorithm re-queries in real-time anyway.

**Q: Your API returns 200 OK but the response body contains wrong data. Is the system "available"?**
A: Technically yes — the service is reachable and responding. But it's unreliable. This is actually worse than being down: users trust the response, make decisions on wrong data, and you might not even know there's a problem. This is why monitoring isn't just "is the server up?" — you need to check response correctness too. Health checks that only verify "can I connect?" miss this entirely.

---

## Chapter 4: Latency vs Throughput

**One-liner:** Latency is how long one request takes; throughput is how many requests your system handles per second.

**Why you should care:** Your user in São Paulo clicks "Add to Cart." They wait. And wait. 4 seconds later, the page responds. By then, 53% of mobile users have already left (Google's data). Your server handled the request correctly — it just took too long. Meanwhile, Black Friday hits, and your server can handle 100 requests per second, but 5,000 are coming in. Throughput problem. Latency and throughput are the two numbers that determine whether your system feels fast and handles the crowd.

**Prerequisites:** Chapters 1-2 (What Is System Design?, Scalability)

### The Simple Version

You're at a fast food counter.

**Latency** is how long it takes to get YOUR burger — from ordering to holding it. If the cook is slow, your latency is high even if the restaurant is empty.

**Throughput** is how many burgers the restaurant serves per hour. If there's only one cook, throughput is low even if each burger is made fast — because only one gets made at a time.

The twist: these two are often at odds. A restaurant can increase throughput by batching (cook 20 patties at once) — but YOUR burger now waits until 19 others are ready. Throughput went up. Your latency went up too.

### How It Actually Works

**Latency** is measured in milliseconds (ms). Here's what "fast" looks like:

| Operation | Typical Latency |
|-----------|----------------|
| L1 cache read | 0.5 ns |
| RAM read | 100 ns |
| SSD read | 150 μs |
| Network round-trip (same data center) | 0.5 ms |
| Network round-trip (US → Europe) | 75 ms |
| Network round-trip (US → Australia) | 150 ms |
| Database query (indexed) | 1-10 ms |
| Database query (full table scan) | 100-1,000 ms |

Key insight: **the network is the bottleneck**. Reading from RAM is 150,000x faster than a round-trip across the Atlantic. This is why CDNs and caching exist — they bring data closer to the user.

**Throughput** is measured in requests per second (RPS) or queries per second (QPS).

```
Latency vs Throughput — The Trade-off
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Low Latency, Low Throughput:     High Throughput, Higher Latency:
  Process one at a time            Batch process

  Request → [Process] → Response   Request ─┐
  Request → [Process] → Response   Request ─┤→ [Batch Process] → All Responses
  Request → [Process] → Response   Request ─┘

  Each request: 10ms               Each request: 30ms
  Throughput: 100/sec              Throughput: 300/sec
```

**P99 latency matters more than average.** If your average latency is 50ms but P99 is 3 seconds, that means 1 in 100 users waits 3 seconds. At 1 million requests/day, that's 10,000 frustrated users daily.

### Real-World Examples

**Example 1: Amazon — 100ms of Latency Costs 1% of Sales**

Amazon found that every 100 milliseconds of added latency cost them 1% in sales. At Amazon's scale ($500+ billion/year), 1% is $5 billion. This is why Amazon invested heavily in CDNs (CloudFront), caching (ElastiCache), and edge computing. They precompute recommendations, cache product pages, and route users to the nearest data center. The "Add to Cart" button responds in under 200ms.

**Example 2: Discord — 15 Million Concurrent Users, Sub-100ms Latency**

Discord delivers messages to 15+ million concurrent users with median latency under 100ms. Their secret: they use Elixir/Erlang for message routing (built for telecom-scale concurrency), keep hot data in memory (not disk), and use a custom data service built on Rust for heavy reads. When a user sends a message in a server with 500,000 members, Discord doesn't send it to all 500,000 — it sends only to users who are currently viewing that channel, using a presence system. Smart throughput optimization through filtering.

### When To Use / When NOT To Use

| Optimize for Low Latency When | Optimize for High Throughput When |
|---|---|
| User is waiting for a response (web page, API call, game action) | Processing large volumes in the background (log analysis, ETL) |
| Real-time interaction matters (chat, live updates, trading) | Batch jobs where individual speed doesn't matter (report generation) |
| Latency directly affects revenue (e-commerce, ads) | Cost efficiency matters more than speed (data pipelines) |
| Interactive queries (search, autocomplete) | Write-heavy systems (logging, metrics collection) |

### Q&A

**Q: If latency is how long one request takes, can't I just get a faster server to fix it?**
A: Only if the server is the bottleneck. Often it's not — the network is. A request from New York to a server in Singapore takes ~200ms just for the round trip, no matter how fast the server is. That's physics (speed of light through fiber). The fix isn't a faster server — it's putting a server (or cache) closer to the user. This is exactly what CDNs do.

**Q: Why do we care about P99 latency instead of average latency?**
A: Because the average hides the pain. If 99 requests take 10ms and 1 takes 5 seconds, the average is 60ms — looks fine! But that one slow request might be a paying customer whose checkout just timed out. P99 tells you "99% of users experience latency at or below this number." For Amazon, that 1% of slow requests represents millions of daily transactions.

**Q: What's the difference between latency and response time?**
A: Response time = latency + processing time. Latency is the network travel time (request going there + response coming back). Processing time is how long the server spends actually doing work. In practice, people use "latency" to mean the whole thing (from user click to user seeing the result), and that's fine for system design discussions.

**Q: You're designing a search engine. Users type a query and expect results in under 300ms. How do you achieve this?**
A: Work backwards from 300ms. Budget: ~50ms network (user → nearest data center via CDN), ~200ms for search, ~50ms to render. For the search: precompute an inverted index (word → list of documents) so you're not scanning billions of pages per query. Cache the top 1,000 most popular queries (covers ~30% of all searches). Shard the index across hundreds of servers and search them in parallel — each shard searches its portion and results are merged. The total search time is the slowest shard, not the sum of all shards. That's how Google returns results in 0.3 seconds across 100+ billion pages.

**Q: Your analytics dashboard takes 15 seconds to load. Users complain, but the queries are genuinely complex — they scan millions of rows. What do you do?**
A: Don't run the complex query when the user clicks. Precompute. Run the heavy query once per hour (or when data changes) using a background job, store the results in a fast read store (Redis or a materialized view), and serve the precomputed result when users load the dashboard. Latency drops from 15 seconds to 50ms. The data is at most one hour stale — for an analytics dashboard, that's usually fine. This is the OLTP vs OLAP split we'll cover in Chapter 40.

---

## Chapter 5: Consistency Models

**One-liner:** A consistency model defines what data users see and when — especially when multiple copies of the data exist.

**Why you should care:** Two users open the same Google Doc. Alice types "Hello" on line 1. Bob types "World" on line 1, at the same exact moment. What shows up? Depends on the consistency model. In a banking app, if you transfer $500 and the recipient checks their balance before the system finishes syncing, do they see the old balance or the new one? The consistency model determines who sees what, when, and whether your system produces correct results or a confusing mess.

**Prerequisites:** Chapters 1-3 (What Is System Design?, Scalability, Availability & Reliability)

### The Simple Version

Imagine a library with three branches (A, B, C), each holding a copy of every book. Someone donates a new book to Branch A.

- **Strong consistency**: The new book instantly appears at all branches before anyone can check. If you visit any branch, you see the same collection. Slow (every branch must update before the donation is "done") but always correct.

- **Eventual consistency**: Branch A has the book now. Branches B and C will get their copies... eventually. Maybe in a few seconds, maybe a few minutes. If you visit Branch B right after the donation, the book isn't there yet. But wait a bit, and all branches catch up.

- **Causal consistency**: If someone donates Book 1, then donates Book 2 as a sequel, every branch sees Book 1 before Book 2. The order of related events is preserved. But unrelated donations at different branches may appear in any order.

### How It Actually Works

The core tension: your database is replicated across multiple servers (for availability and performance). When one copy is updated, how quickly do the other copies catch up — and what happens to reads in the meantime?

| Model | What Users See | Speed | Use Case |
|---|---|---|---|
| Strong consistency | Always the latest write | Slowest (must sync all replicas) | Bank balances, inventory counts |
| Eventual consistency | Might see stale data briefly | Fastest (write returns immediately) | Social media likes, DNS |
| Causal consistency | Related events in order, unrelated may be out of order | Medium | Comment threads, messaging |
| Read-your-writes | You see your own updates immediately; others may lag | Medium | User profiles, settings |

```
Strong vs Eventual Consistency
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  STRONG: Write waits for all replicas
  Client ──write──→ Primary ──sync──→ Replica 1  ✓
                            ──sync──→ Replica 2  ✓
                            ──sync──→ Replica 3  ✓
         ←── "OK, write confirmed" ──┘
  (Slow, but any read from ANY replica returns the new value)

  EVENTUAL: Write returns immediately
  Client ──write──→ Primary ──"OK!"──→ Client
                     │
                     └──async──→ Replica 1  (seconds later)
                     └──async──→ Replica 2  (seconds later)
                     └──async──→ Replica 3  (seconds later)
  (Fast, but reads from replicas may return stale data briefly)
```

### Real-World Examples

**Example 1: Amazon DynamoDB — Eventual Consistency by Default**

DynamoDB replicates data across three facilities. By default, reads are eventually consistent — you might read data that's a fraction of a second stale. This is fine for a product catalog (it doesn't matter if a product description update takes 200ms to propagate). But for the shopping cart, Amazon uses strongly consistent reads — if you add an item, the next page load must show it. DynamoDB lets you choose per-read, not per-table. One system, two consistency models, applied where each makes sense.

**Example 2: Google Spanner — Global Strong Consistency**

Google Spanner is the only globally distributed database that provides strong consistency across continents. How? Atomic clocks and GPS receivers in every data center, creating a globally synchronized timestamp called TrueTime. Every transaction gets a globally unique timestamp, and reads always see the latest committed state. The cost: higher latency (writes wait for cross-continental replication, ~7-10ms within a continent, more across). Google uses it for AdWords (where billing accuracy matters more than speed) and Google Play.

### When To Use / When NOT To Use

| Use Strong Consistency When | Use Eventual Consistency When |
|---|---|
| Money is involved (bank transfers, payments, billing) | Social features (likes, follower counts, view counts) |
| Inventory that can oversell (concert tickets, limited stock) | Content that's not time-critical (user feeds, recommendations) |
| Security-critical data (permissions, access control) | Caching layers (cache is inherently eventually consistent) |
| Coordination tasks (leader election, distributed locks) | DNS, CDN content — stale for seconds is acceptable |

### Q&A

**Q: If strong consistency is always "correct," why doesn't everyone just use it?**
A: Because it's slow and reduces availability. To guarantee every read sees the latest write, the system must wait for all replicas to confirm every write before returning "success." If one replica is slow or unreachable, the write blocks. In a globally distributed system, this means every write takes at least the latency of the slowest data center. For Amazon's product pages (billions of reads/day), adding 100ms per read for strong consistency would be devastating. Eventual consistency lets reads fly while writes propagate in the background.

**Q: You said eventual consistency means data "catches up eventually." How long is "eventually"?**
A: Usually milliseconds to a few seconds. In practice, DynamoDB replicates within ~200ms. Cassandra typically converges within 1-2 seconds. But under heavy load, network partitions, or replica failures, it could be longer. "Eventually" has no guaranteed upper bound — that's the trade-off. Systems like Cassandra let you tune this: you can require 2 out of 3 replicas to acknowledge a write, which gives you faster convergence at the cost of slightly higher write latency.

**Q: How is eventual consistency different from "my data is just wrong"?**
A: Eventual consistency guarantees convergence — all replicas WILL reach the same state. "Wrong data" means they never will. Think of it as a delay, not an error. If you update your profile picture, eventually consistent replicas will show the old picture for a brief moment, then the new one. They won't show a random picture. The "eventually" part is a bounded window of staleness, not permanent incorrectness.

**Q: You're building an e-commerce site. The product page shows "5 left in stock." Two users click "Buy" at the same moment. What consistency model prevents overselling?**
A: Strong consistency with a compare-and-swap (or serializable transaction). When User A clicks buy, the system reads stock=5, decrements to 4, and writes — but only if stock is still 5 (no one else changed it). User B's concurrent read also sees 5, tries to write 4, but the compare-and-swap fails because stock is now 4 (User A's write went first). User B retries: reads 4, writes 3, succeeds. This is slower than eventual consistency but prevents overselling. For non-critical inventory (showing "5 left" on the product page), eventual consistency is fine — it's only the actual purchase that needs strong consistency.

**Q: Your messaging app shows "142 people liked this post" but different users see slightly different numbers (140, 142, 143). Is this a bug?**
A: No — this is eventual consistency working as designed. Like counts are written to multiple replicas asynchronously. Different users may read from different replicas that haven't all caught up yet. Within seconds, they converge. For a like counter, this is an excellent trade-off: strong consistency would require locking the counter for every like, destroying performance on viral posts. Facebook, Instagram, and Twitter all use eventual consistency for engagement metrics. The exact number doesn't matter — the trend does.

---

## Chapter 6: CAP & PACELC Theorems

**One-liner:** CAP says that during a network failure, you must choose between consistency and availability — you can't have both. PACELC extends this to normal operations too.

**Why you should care:** Your database cluster spans two data centers — New York and London. The network link between them goes down (this happens more often than you'd think). Requests are still coming in from both sides. Do you: (A) Keep serving requests from both data centers, knowing New York and London might now have different data? Or (B) Shut down one data center and only serve from the other, guaranteeing consistency but cutting your capacity in half? There is no Option C. CAP says you must choose, and your choice defines your system.

**Prerequisites:** Chapters 3 and 5 (Availability & Reliability, Consistency Models)

### The Simple Version

Imagine two friends, Alice (in New York) and Bob (in London), who manage a shared contact list. They've each got a copy. They sync by calling each other whenever something changes.

One day, the phone line goes dead. Alice adds a new contact. Bob deletes an old one.

Now they have a choice:
- **Stay available (AP)**: Both keep accepting changes to their own copy. When the phone line comes back, they'll have conflicting lists to reconcile.
- **Stay consistent (CP)**: They both stop accepting changes until they can talk again. Neither list gets corrupted, but no updates happen during the outage.

That's CAP. During a communication failure (**Partition**), choose **Consistency** or **Availability**.

### How It Actually Works

**CAP Theorem** (Eric Brewer, 2000): A distributed system can guarantee at most two of three properties:

- **C**onsistency — Every read returns the most recent write
- **A**vailability — Every request gets a response (even if it's stale)
- **P**artition tolerance — The system works despite network failures between nodes

Since network partitions *will* happen (they're not optional), the real choice is:

| Type | During Partition... | Examples |
|---|---|---|
| **CP** (Consistency + Partition tolerance) | Refuse requests that might return stale data. Some users see errors. | MongoDB, HBase, ZooKeeper, etcd |
| **AP** (Availability + Partition tolerance) | Keep serving all requests, even if some data is stale. | Cassandra, DynamoDB, CouchDB |

```
CAP Theorem — The Real Choice
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

                  Consistency
                     /\
                    /  \
                   /    \
                  / CP   \
                 /  zone  \
                /          \
               /____________\
  Partition   /              \   Availability
  Tolerance  /    AP zone     \
             \________________/

  Network partitions WILL happen.
  So you're really choosing: C or A?
```

**PACELC** (Daniel Abadi, 2012) extends CAP to normal operations: "If there's a **P**artition, choose **A** or **C**. **E**lse (normal operation), choose **L**atency or **C**onsistency."

| System | During Partition (PAC) | Normal Operation (ELC) | Classification |
|---|---|---|---|
| DynamoDB | Availability | Latency (eventual consistency default) | PA/EL |
| MongoDB | Consistency | Consistency | PC/EC |
| Cassandra | Availability | Latency | PA/EL |
| Google Spanner | Consistency | Consistency (with higher latency) | PC/EC |

PACELC is more useful than CAP because partitions are rare — most of the time, your system is running normally, and the Latency vs Consistency trade-off is the one you actually live with daily.

### Real-World Examples

**Example 1: DynamoDB — AP System (Choose Availability)**

DynamoDB is designed to always accept writes, even during network partitions. When a partition happens, both sides of the split keep accepting writes. When the partition heals, DynamoDB uses "last writer wins" (based on timestamps) to resolve conflicts. This means you might lose a write in rare cases. For Amazon's shopping cart (the original use case), this was acceptable — a lost item in a cart is annoying but fixable. A shopping cart that refuses to work during a network blip loses sales permanently.

**Example 2: ZooKeeper — CP System (Choose Consistency)**

ZooKeeper is used for distributed coordination: leader election, distributed locks, configuration management. If ZooKeeper returned stale data, two servers might both think they're the leader and process the same payment twice. So ZooKeeper chooses consistency: during a partition, the minority side stops serving reads and writes. This means some clients temporarily can't reach ZooKeeper — but those who can always get correct data. For coordination, this is the only sane choice.

### When To Use / When NOT To Use

| Choose AP (Availability) When | Choose CP (Consistency) When |
|---|---|
| Users seeing stale data is annoying but not dangerous | Wrong data causes real harm (money, health, security) |
| Every request must get a response (e-commerce, social media) | It's better to be unavailable than inconsistent (banking, inventory) |
| You can resolve conflicts after the fact (merge, last-write-wins) | Data conflicts are unresolvable or catastrophic (double-charging) |
| User experience depends on responsiveness | Correctness is more important than responsiveness |

### Q&A

**Q: People say "CAP — pick 2 out of 3." So why can't I just pick CA (consistency + availability) and skip partition tolerance?**
A: Because you can't skip partition tolerance. Network partitions happen — cables get cut, routers fail, cloud regions have outages. If you "pick CA," you're saying "my system only works when the network is perfect." That's a system that runs on one machine with no replication — which gives you zero fault tolerance. The moment you distribute data across machines, partitions are possible, and CAP applies.

**Q: If partitions are so rare, why do we obsess over CAP?**
A: Two reasons. First, partitions happen more than you think: within a data center, network blips happen weekly. Across regions, they happen monthly. Second, and this is the real insight, PACELC shows that even without partitions, you're choosing between latency and consistency. That's a trade-off you make on every single request, not just during failures. CAP is the headline. PACELC is the daily reality.

**Q: Can I use both AP and CP in the same system — different models for different data?**
A: Absolutely, and this is exactly what good system designs do. Amazon uses CP for payment processing (strong consistency — can't double-charge) and AP for the product catalog (eventual consistency — a stale product description for 200ms is harmless). Your database choice might even support this: DynamoDB lets you choose strong or eventual consistency per-read. Design by data criticality, not by blanket policy.

**Q: You're building an airline booking system. When a partition happens, should remaining seats be consistent or available?**
A: Consistent (CP). An AP system might sell the same seat to two passengers during a partition — a nightmare to resolve (someone gets bumped). It's better for the booking page to show an error ("please try again in a moment") than to oversell. However, the *flight search* page can be AP: showing slightly stale seat counts is harmless. Passengers don't commit until the booking step, where consistency matters. Different operations, different CAP choices, same system.

**Q: CAP is from 2000. Is it still relevant, or is there something better?**
A: CAP is still the conceptual foundation, but PACELC (2012) is more practically useful because it covers normal operations, not just partitions. And modern research adds nuance: consistency isn't binary (strong vs eventual), and you can tune it per-operation. CRDTs (Conflict-free Replicated Data Types) even let you have availability AND eventual convergence with automatic conflict resolution for certain data types (counters, sets, text). CAP is the right starting framework. PACELC is the everyday tool. CRDTs are the cutting edge.

---

## Chapter 7: ACID vs BASE

**One-liner:** ACID gives you strict guarantees that your data is always correct; BASE trades some correctness for speed and availability at scale.

**Why you should care:** You transfer $500 from checking to savings. The system deducts $500 from checking, then crashes before adding it to savings. Is your $500 gone? With ACID guarantees — no. The entire transaction rolls back. Without them, you just lost $500 and have to file a support ticket. ACID vs BASE is the choice between "this will never go wrong" and "this is fast enough for a billion users, and we'll fix the occasional hiccup."

**Prerequisites:** Chapters 5-6 (Consistency Models, CAP & PACELC)

### The Simple Version

Think about two ways to run a restaurant kitchen:

**ACID kitchen (fine dining):** Every dish must be perfect. If the steak is overcooked, the entire table's order is thrown out and restarted. Nothing leaves the kitchen unless it's all correct. Slow, expensive, but the customer always gets exactly what they ordered.

**BASE kitchen (fast food):** Get food out fast. If the fries are slightly off, serve them anyway — they're close enough. The occasional wrong order gets fixed at the counter. 99% of customers are happy, and you serve 10x more people per hour.

Neither is "wrong." Fine dining needs ACID. A food court needs BASE. Your system design choice depends on what your data demands.

### How It Actually Works

**ACID** (used by SQL databases: PostgreSQL, MySQL, Oracle):

| Property | What It Means | Example |
|---|---|---|
| **A**tomicity | All or nothing. If any part fails, the whole transaction rolls back. | Transfer $500: deduct AND deposit, or neither. |
| **C**onsistency | Data always moves from one valid state to another. Rules are never broken. | Account balance can never go negative. |
| **I**solation | Concurrent transactions don't interfere with each other. | Two users buying the last item don't both succeed. |
| **D**urability | Once committed, the data survives crashes, power loss, anything. | After "transfer complete," it stays complete even if the server dies. |

**BASE** (used by NoSQL databases: Cassandra, DynamoDB, MongoDB):

| Property | What It Means |
|---|---|
| **B**asically **A**vailable | The system always responds, even if the data isn't the freshest. |
| **S**oft state | The system's state may change over time, even without new input (replicas syncing). |
| **E**ventual consistency | All copies of data will converge to the same value... eventually. |

```
ACID vs BASE — The Core Trade-off
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ACID (Strict)                     BASE (Flexible)
  ┌─────────────────────┐           ┌─────────────────────┐
  │ BEGIN TRANSACTION   │           │ Write to Node 1     │
  │   Deduct $500       │           │   → Return "OK"     │
  │   Add $500          │           │   → Async replicate  │
  │   All passed?       │           │     to Nodes 2, 3   │
  │     → COMMIT        │           │                     │
  │   Any failed?       │           │ Reads from Node 2   │
  │     → ROLLBACK ALL  │           │   may be stale for  │
  └─────────────────────┘           │   milliseconds      │
                                    └─────────────────────┘
  Slower, but never wrong            Faster, but briefly stale
```

### Real-World Examples

**Example 1: Stripe — ACID for Every Dollar**

Stripe processes hundreds of billions of dollars in payments annually. Every payment is an ACID transaction: charge the card, record the transaction, update the merchant balance — all atomically. If any step fails, everything rolls back. They use PostgreSQL for their core financial data precisely because of ACID guarantees. For Stripe, a "fast but occasionally wrong" system isn't an option — financial regulators and merchants demand every cent be accounted for.

**Example 2: Instagram — BASE for Social Features**

Instagram uses Cassandra (a BASE system) for its feed and activity data. When you like a photo, the like count doesn't need to be globally consistent in that instant — if one server says 1,042 likes and another says 1,043, nobody notices or cares. But the performance gains are massive: Cassandra handles millions of writes per second across Instagram's data centers. If Instagram required ACID for every like, the system would be orders of magnitude slower and more expensive to run.

### When To Use / When NOT To Use

| Use ACID When | Use BASE When |
|---|---|
| Financial transactions (payments, transfers, billing) | Social features (likes, views, follower counts) |
| Inventory management (don't oversell) | Content feeds and recommendations |
| User registration (don't create duplicate accounts) | Analytics and logging (a missed log event isn't critical) |
| Any data where "close enough" isn't good enough | High-write-throughput systems (IoT, real-time tracking) |

### Q&A

**Q: Does using a SQL database automatically give me ACID, and does NoSQL mean I get BASE?**
A: Mostly yes, but not exactly. All major SQL databases (PostgreSQL, MySQL, Oracle) support ACID transactions by default. Most NoSQL databases (Cassandra, DynamoDB) are BASE by default. But MongoDB added multi-document ACID transactions in version 4.0, and CockroachDB is a distributed SQL database with ACID. Similarly, you can use PostgreSQL with such loose isolation levels that you effectively lose some ACID guarantees. The database gives you the option — you still have to use it correctly.

**Q: Can I use ACID and BASE in the same application?**
A: Yes, and you should. This is called polyglot persistence. A common pattern: PostgreSQL (ACID) for user accounts, payments, and orders. Cassandra or DynamoDB (BASE) for activity feeds, analytics, and session data. Redis (BASE) for caching. Each data store handles the data that matches its strengths. Most real-world systems at scale use 3-5 different data stores.

**Q: If ACID guarantees correctness, why don't all databases just use ACID?**
A: Because ACID requires coordination. To guarantee atomicity and isolation, the database must lock rows, maintain transaction logs, and often synchronize across replicas. This adds overhead per write. At millions of writes per second across globally distributed nodes, this overhead becomes a bottleneck. BASE systems skip this coordination — writes return immediately and sync in the background. For many data types, this speed-for-correctness trade-off is worth it.

**Q: Your e-commerce app uses one PostgreSQL database for everything. The product catalog gets 100x more reads than writes, and the read load is crushing the database. What's your move?**
A: Add read replicas (still ACID-compliant for writes). All writes go to the primary, reads are distributed across replicas. The replicas may lag by milliseconds (slightly BASE-like for reads), but writes remain ACID. For the product catalog specifically, add a Redis cache in front (definitely BASE — cache can be stale by seconds). Keep ACID for the checkout flow and payment processing. You've split the workload by criticality without abandoning ACID where it matters.

**Q: What's the worst thing that happens if you use eventual consistency (BASE) for something that needs ACID?**
A: Real damage. Classic example: an airline uses eventual consistency for seat booking. Two users book the same seat simultaneously on different replicas. Both get confirmation emails. At the gate, one gets bumped. Or worse: a payment system uses eventual consistency, a transfer is "partially applied" (deducted from one account but not yet credited to the other), and the system crashes. The money is in limbo. With ACID, this literally cannot happen — the transaction either fully completes or fully rolls back.

---

## Chapter 8: Back-of-Envelope Estimation

**One-liner:** Back-of-envelope estimation is the skill of calculating whether your design can handle the load — using rough math, not gut feelings.

**Why you should care:** You're in a system design interview. You say "we'll use a single MySQL database." The interviewer asks: "How many writes per second will it handle?" You freeze. You didn't estimate. A single MySQL instance handles ~5,000-10,000 writes per second. Your system needs 200,000. You just proposed a design that's 20x too slow, and you didn't even know it. Estimation turns "I think this will work" into "I know this will work — here's the math."

**Prerequisites:** Chapters 1-4 (all previous Foundations chapters)

### The Simple Version

You're throwing a house party. How much pizza do you order? You don't just guess. You think: 40 guests, each eats ~3 slices, that's 120 slices. A pizza has 8 slices, so 15 pizzas. You rounded, you estimated, and you're probably close enough — certainly better than "uhh, let's get some pizza."

Back-of-envelope estimation is the same thing for systems. How much storage? How many servers? How much bandwidth? You won't get exact numbers, but you'll know if you need 1 server or 1,000 — and that's the difference between a design that works and one that collapses on day one.

### How It Actually Works

**The Numbers You Need to Know:**

| Thing | How Much / How Fast |
|---|---|
| Characters in a tweet/text | ~200 bytes |
| A photo (compressed) | ~200 KB |
| A 1-minute video (compressed) | ~5 MB |
| A row in a database | ~1 KB |
| Read from memory (RAM) | ~100 ns |
| Read from SSD | ~150 μs |
| Network round-trip (same region) | ~0.5 ms |
| Network round-trip (cross-continent) | ~150 ms |
| Single MySQL writes/sec | ~5,000-10,000 |
| Single Redis reads/sec | ~100,000 |
| S3 storage cost | ~$0.023/GB/month |

**The Estimation Framework (4 steps):**

1. **Start with users** — How many daily active users (DAU)?
2. **Convert to requests** — How many actions per user per day? Multiply to get requests/day, then divide by 86,400 to get requests/second (QPS)
3. **Estimate storage** — How much data per action? Multiply by actions/day × 365 for annual storage
4. **Check against limits** — Can one server/database handle this? If not, how many do you need?

**Useful shortcuts:**
- 1 million requests/day ≈ ~12 requests/second (1M / 86,400)
- 1 billion requests/day ≈ ~12,000 requests/second
- Peak traffic is typically 2-5x average
- 1 TB = 1,000 GB = 1,000,000 MB
- Seconds in a day ≈ 100,000 (actually 86,400 — use 10⁵ for quick math)

```
Example: Estimating a URL Shortener
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Given: 100M new URLs/day, 100:1 read-to-write ratio

  WRITES:
    100M / 86,400 sec ≈ 1,200 writes/sec
    Peak: ~3,600 writes/sec (3x average)
    → One MySQL instance can handle this ✓

  READS:
    100M × 100 = 10B reads/day
    10B / 86,400 ≈ 116,000 reads/sec
    Peak: ~350,000 reads/sec
    → Need caching (Redis: 100K reads/sec per instance)
    → 4 Redis instances for peak ✓

  STORAGE (5 years):
    Each record: short_code (7 bytes) + long_url (200 bytes)
       + metadata (~100 bytes) ≈ 300 bytes
    100M × 300 bytes = 30 GB/day
    30 GB × 365 × 5 = ~55 TB over 5 years
    → Need sharding (one DB holds ~2-5 TB comfortably)
    → ~15-25 shards

  BANDWIDTH:
    Writes: 1,200/sec × 300 bytes ≈ 360 KB/sec (tiny)
    Reads: 116,000/sec × 300 bytes ≈ 35 MB/sec (manageable)
```

### Real-World Examples

**Example 1: Estimating Twitter's Storage**

Twitter has ~400 million tweets per day (as of recent estimates). Each tweet: 280 characters × 2 bytes (Unicode) = ~560 bytes text + ~500 bytes metadata (user ID, timestamps, counts) ≈ 1 KB per tweet. Daily: 400M × 1 KB = 400 GB/day. Per year: ~146 TB just for tweet text + metadata. Media (images, videos) is stored separately in object storage and adds petabytes. This estimate tells you: tweet metadata fits in a sharded SQL database. Media goes to S3/equivalent. You need this separation in your design.

**Example 2: Why WhatsApp's Storage is Surprisingly Small**

WhatsApp handles ~100 billion messages per day. But each message is tiny: ~200 bytes average (text). 100B × 200 bytes = 20 TB/day. That sounds huge, but WhatsApp doesn't store messages permanently — once delivered, messages are deleted from servers (end-to-end encryption means the server can't read them anyway). So actual storage = undelivered messages only, which at any given time is a fraction of 20 TB. This is a key estimation insight: understanding the data lifecycle can reduce storage requirements by 100x.

### When To Use / When NOT To Use

| Do Estimation When | Don't Obsess Over Estimation When |
|---|---|
| System design interviews (expected by every interviewer) | Building a prototype (just build it and measure) |
| Planning infrastructure for a new product | You have actual production metrics (use real data, not estimates) |
| Evaluating whether a design is feasible before building it | The numbers don't change the design (if either 1 server or 2 servers works, precision doesn't matter) |
| Choosing between fundamentally different approaches (SQL vs NoSQL, one region vs multi-region) | You're within 2-3x of the same answer either way |

### Q&A

**Q: What if my estimate is way off? How close do I need to be?**
A: Within 10x is usually good enough. The point isn't precision — it's order of magnitude. If your estimate says you need 50 servers and the real answer is 30, that's fine — your design accommodates it. If your estimate says 1 server and you actually need 500, your entire architecture is wrong. Get the right order of magnitude and you'll make the right design choices.

**Q: In an interview, do I need to memorize all these numbers?**
A: Memorize the rough magnitudes, not exact numbers. Know that: a text message is ~hundreds of bytes, a photo is ~hundreds of KB, a video minute is ~a few MB, MySQL handles ~thousands of writes/sec, Redis handles ~hundreds of thousands of reads/sec. These rough anchors let you derive everything else. Nobody expects you to know that Redis does exactly 114,000 reads per second.

**Q: How do I estimate peak traffic vs average?**
A: A common rule of thumb: peak is 2-5x average for most consumer apps. Social media peaks during evenings. E-commerce peaks on Black Friday (can be 10-20x average). Gaming peaks on weekend evenings. For interviews, saying "peak is about 3x average" and designing for that is perfectly reasonable.

**Q: You're designing a photo-sharing app with 10 million DAU. Each user uploads 2 photos/day and views 100 photos/day. Estimate the storage and bandwidth needs.**
A: **Storage**: 10M × 2 photos × 200 KB = 4 TB/day. Per year: ~1.5 PB. You need object storage (S3 — $0.023/GB/month = ~$35K/month for 1.5 PB). Plus thumbnails at ~20 KB each, add ~10%. **Bandwidth for uploads**: 10M × 2 × 200 KB / 86,400 sec = ~46 MB/sec. Manageable. **Bandwidth for reads**: 10M × 100 × 200 KB / 86,400 sec = ~2.3 TB/sec at peak? That can't be right — oh, CDN. Serve photos from CDN edge servers. Origin bandwidth is a fraction of this because the CDN caches popular photos. This is why CDNs are mandatory for media-heavy apps.

**Q: Your estimate shows you need 200 database shards. Is something wrong with your design?**
A: Probably. 200 shards adds enormous operational complexity. Before accepting that number, question your assumptions: Can you cache more aggressively (reducing read load by 90%+)? Can you use a different data store (Cassandra handles high write volume on fewer nodes than MySQL)? Can you archive old data (most queries hit recent data)? Can you precompute and denormalize (reduce query complexity)? High shard counts often mean you're using the wrong tool, not that you need more of the current tool.

---

## Putting It Together: Design a Simple Notes App

*Now let's apply everything from Part 1 to a real (simple) system. We'll see how the foundation concepts turn into actual design decisions.*

**The scenario:** You're building a cloud notes app (think a basic Notion or Google Keep). Users create text notes, edit them, and access them from any device.

### Two Worlds: 100 Users vs 10 Million Users

**For 100 users:**

```
Simple Notes App (100 Users)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ┌──────────┐
  │  Users   │
  └────┬─────┘
       │
  ┌────┴─────┐
  │ Web App  │  ← One server. Django/Rails/Express. Handles everything.
  │ (1 server)│
  └────┬─────┘
       │
  ┌────┴─────┐
  │PostgreSQL│  ← One database. ACID for note saves.
  │ (1 instance)│
  └──────────┘
```

- **Scalability**: Not needed. One server handles 100 users easily.
- **Availability**: Not critical. If it's down for 10 minutes, users survive.
- **Consistency**: Strong consistency. PostgreSQL ACID. Simple.
- **Estimation**: 100 users × 10 notes/day × 2 KB/note = 2 MB/day. One database handles this for decades.

**For 10 million users:**

```
Notes App at Scale (10M Users)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ┌──────────┐
  │  Users   │──→ CDN (static assets, cached note content)
  └────┬─────┘
       │
  ┌────┴──────────┐
  │ Load Balancer │
  └──┬─────┬──────┘
     │     │
  ┌──┴──┐┌─┴───┐
  │App 1││App 2│...  ← Stateless app servers (auto-scale)
  └──┬──┘└──┬──┘
     │      │
  ┌──┴──────┴──┐
  │   Redis    │  ← Cache hot notes (reduces DB reads by 90%)
  │   Cache    │
  └─────┬──────┘
        │
  ┌─────┴──────────────────┐
  │      PostgreSQL        │
  │  Primary + 3 Replicas  │  ← Writes → Primary. Reads → Replicas.
  │  (future: sharding)    │
  └────────────────────────┘
```

- **Scalability**: Horizontal. Stateless app servers behind a load balancer. Database read replicas. Cache layer.
- **Availability**: 99.9% target. Multiple app servers (one dies, others continue). Database replication (primary dies, replica promotes).
- **Consistency**: Strong for saves (ACID write to primary). Read-your-writes for the editing user (read from primary after writing). Eventual consistency for other viewers (read from replicas, ~200ms lag).
- **Estimation**: 10M DAU × 5 reads/day + 2 writes/day. Reads: 50M/day ÷ 86,400 ≈ 580 reads/sec. With cache (90% hit rate), DB sees ~58 reads/sec. Writes: 20M/day ÷ 86,400 ≈ 230 writes/sec. One PostgreSQL primary handles this. Storage: 10M × 10 notes × 2 KB = 200 GB. Fits on one database — sharding not needed yet.
- **CAP choice**: CP. If a network partition occurs, we'd rather notes be temporarily unavailable than have two users editing the same note and losing one person's changes.
- **ACID vs BASE**: ACID for note storage (can't lose a user's notes). BASE for the cache layer (stale cache is fine — just re-fetch from the database on miss).

**Key takeaway**: At 100 users, every design works. At 10 million, every decision matters — and the foundations from Part 1 tell you exactly which decisions to make and why.

---

*Part 1 complete. You now have the vocabulary: scalability, availability, consistency, latency, throughput, CAP, ACID/BASE, and estimation. Every chapter from here on uses these concepts. Next up: Part 2 — The Building Blocks. The actual tools you'll assemble into systems.*
