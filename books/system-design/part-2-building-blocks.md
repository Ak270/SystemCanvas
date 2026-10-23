# Part 2: Building Blocks — The Toolbox

*Part 1 gave you the vocabulary: scalability, availability, consistency, trade-offs. Now you learn the actual components you'll wire together into real systems. Each building block solves a specific problem. By the end of this part, you'll trace a request from a user's browser through every layer of a production system.*

---

## Chapter 9: DNS (Domain Name System)

**One-liner:** DNS is the phone book of the internet — it translates human-readable names like "google.com" into machine-readable IP addresses like 142.250.80.46.

**Why you should care:** You type "netflix.com" into your browser. But computers don't understand words — they need numbers (IP addresses) to route traffic. Without DNS, you'd have to memorize 142.250.80.46 instead of "google.com," and every time a company changed servers, you'd need the new number. DNS is the invisible first step of every single request on the internet. If DNS goes down, the internet goes dark — and in October 2021, exactly that happened to Facebook for 6 hours.

**Prerequisites:** Chapter 1 (What Is System Design?)

### The Simple Version

Your phone has a contacts app. You tap "Mom" and it dials 555-0123. You never think about the number — the contacts app translates the name to a number for you.

DNS is your phone's contacts app, but for the entire internet. When you type "google.com," DNS looks up which IP address that name points to and sends your browser there. And just like your contacts app, DNS caches the answer so it doesn't have to look it up every time.

### How It Actually Works

DNS resolution happens in stages, like asking a chain of increasingly knowledgeable people:

```
How DNS Resolves "www.netflix.com"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1. Browser cache: "Do I already know this?" → No
  2. OS cache: "Has my computer looked this up recently?" → No
  3. Resolver (ISP): "Let me find out for you."
     │
     ├──→ 4. Root server: "I don't know netflix.com, but
     │       try the .com servers." (13 root server clusters worldwide)
     │
     ├──→ 5. TLD server (.com): "I don't know netflix.com's IP,
     │       but Netflix's authoritative server is at ns1.netflix.com."
     │
     └──→ 6. Authoritative server (Netflix's): "www.netflix.com
             is at 54.237.226.164." (TTL: 60 seconds)

  Result cached at every level. Next request skips to the cache.
```

**Key DNS record types:**

| Record | What It Does | Example |
|--------|-------------|---------|
| A | Maps name → IPv4 address | google.com → 142.250.80.46 |
| AAAA | Maps name → IPv6 address | google.com → 2607:f8b0:4004:800::200e |
| CNAME | Maps name → another name (alias) | www.example.com → example.com |
| MX | Mail server for a domain | example.com → mail.example.com |
| NS | Which name server is authoritative | example.com → ns1.example.com |

**DNS for system design — the features that matter:**

1. **Load balancing**: Return different IPs for the same domain (round-robin DNS) to spread traffic across servers
2. **Geo-routing**: Return different IPs based on the user's location — user in Tokyo gets a Tokyo server, user in London gets a London server
3. **Failover**: Health-check servers and stop returning IPs of dead ones
4. **TTL (Time To Live)**: How long the answer is cached. Low TTL (60s) = fast failover but more DNS lookups. High TTL (86400s/1 day) = fewer lookups but slow to change.

### Real-World Examples

**Example 1: Facebook's 2021 DNS Outage — 6 Hours of Global Darkness**

On October 4, 2021, a routine BGP configuration change accidentally withdrew the routes to Facebook's DNS servers. The result: the entire internet "forgot" how to reach facebook.com, instagram.com, and whatsapp.com. For 6 hours, 3.5 billion users couldn't access any Facebook service. The irony: Facebook engineers couldn't even access their own internal tools to fix it — those also relied on DNS. They had to send engineers physically to data centers to fix routers. Estimated revenue loss: $60-100 million. Lesson: DNS is a single point of failure you don't think about until it breaks.

**Example 2: Netflix — DNS-Based Geo-Routing**

Netflix uses Amazon Route 53 (managed DNS) with latency-based routing. When a user in Tokyo hits netflix.com, Route 53 returns the IP of Netflix's nearest AWS region (ap-northeast-1). A user in Virginia gets a Virginia IP. This happens at the DNS layer — before the first HTTP request even begins. Netflix also uses health checks: if a region goes unhealthy, Route 53 stops returning its IP within 60 seconds (the TTL). Traffic automatically shifts to the next nearest healthy region.

### When To Use / When NOT To Use

| Use DNS-Level Features When | Don't Rely on DNS Alone When |
|---|---|
| Routing users to the nearest region (geo-routing) | You need sub-second failover (DNS TTL is typically 60-300 seconds) |
| Basic load balancing across a few servers | You need intelligent load balancing (DNS can't check server health in real-time) |
| Disaster recovery / region failover | You need session persistence (DNS doesn't know which server a user was on) |
| Migrating traffic between old and new infrastructure | You need request-level routing decisions (use a load balancer instead) |

### Q&A

**Q: If DNS is just a lookup, why is it so important for system design?**
A: Because DNS is the first decision point in every request. The IP address DNS returns determines which data center, which load balancer, and which set of servers handles the request. By controlling DNS, you control traffic routing at a global scale — before any of your own infrastructure even sees the request. That's why DNS-based geo-routing and failover are fundamental system design tools.

**Q: What happens if my DNS provider goes down?**
A: Your domain becomes unreachable — nobody can resolve your name to an IP. This is why critical services use multiple DNS providers (multi-provider DNS). Cloudflare + Route 53, for example. If one provider goes down, the other still resolves your domain. This costs more and adds configuration complexity, but it eliminates DNS as a single point of failure.

**Q: How is DNS load balancing different from a regular load balancer?**
A: DNS load balancing is crude: it returns different IPs in rotation, but it can't check how busy each server is, can't route based on request content, and changes take TTL-seconds to propagate. A real load balancer (Chapter 10) sits in the request path and makes decisions per-request: it knows which servers are healthy, which are overloaded, and can route based on URL path, headers, or cookies. Use DNS for global routing (which region), load balancers for local routing (which server within the region).

**Q: You're migrating your app from AWS to GCP. How do you use DNS to do this without downtime?**
A: Lower the DNS TTL to 60 seconds a week before the migration (so caches expire fast). Spin up the app in GCP. When ready, update the DNS record to point to the GCP IP. Within 60 seconds, most traffic shifts. Keep the AWS servers running for a few hours to handle stragglers with cached old DNS. Monitor error rates. Once traffic fully shifts, decommission AWS. The key: lowering TTL in advance. If your TTL was 24 hours, the old IP is cached everywhere for up to a day — half your users would still hit AWS.

**Q: Your website is under a DDoS attack. Millions of requests are flooding your server. How does DNS help?**
A: Route your DNS through a DDoS protection service like Cloudflare. Instead of your DNS records pointing to your server's IP directly, they point to Cloudflare's IPs. Cloudflare absorbs the attack traffic (they have massive global capacity), filters out malicious requests, and forwards only legitimate traffic to your origin server. Your real IP never gets exposed. This is why most companies don't expose their origin server IPs in DNS.

---

## Chapter 10: Load Balancers

**One-liner:** A load balancer distributes incoming traffic across multiple servers so no single server gets overwhelmed.

**Why you should care:** Your app runs on one server. It handles 500 requests per second comfortably. Tuesday night, your app goes viral on TikTok. Traffic hits 10,000 requests per second. Your one server chokes — CPU pegs at 100%, response times spike to 30 seconds, and users see timeout errors. You spin up 9 more servers, but all traffic still goes to the first one because users' browsers have its IP address. A load balancer sits in front of your servers and distributes traffic so all 10 share the work equally.

**Prerequisites:** Chapters 2 and 9 (Scalability, DNS)

### The Simple Version

Walk into a bank with 5 teller windows. Without a system, everyone crowds window 1 — the poor teller is drowning while the other 4 are idle. Now the bank puts a host at the entrance who sends each customer to the next available window. That host is the load balancer.

The host doesn't handle any transactions — they just direct traffic. If a teller goes on break, the host stops sending people there. If the bank opens a 6th window, the host starts including it. Simple, but without it, the bank is chaos.

### How It Actually Works

A load balancer sits between clients and your servers, forwarding each request to one of the available servers:

```
Without Load Balancer              With Load Balancer
━━━━━━━━━━━━━━━━━━━               ━━━━━━━━━━━━━━━━━━

  All users                         All users
     │                                 │
     ▼                            ┌────┴────┐
  ┌──────┐                        │  Load   │
  │Server│ ← overloaded           │Balancer │
  └──────┘                        └┬───┬───┬┘
                                   │   │   │
  ┌──────┐                      ┌──┴┐┌─┴─┐┌┴──┐
  │Server│ ← idle               │ S1││ S2││ S3│
  └──────┘                      └───┘└───┘└───┘
                                 Each gets ~33%
  ┌──────┐
  │Server│ ← idle
  └──────┘
```

**Two types, at different network layers:**

| Type | Layer | How It Routes | Best For |
|---|---|---|---|
| L4 (Transport) | TCP/UDP | Routes by IP address and port. Fast — doesn't inspect the request content. | Raw speed, simple routing, TCP traffic |
| L7 (Application) | HTTP | Routes by URL path, headers, cookies, request body. Smarter but slower. | Content-based routing, A/B testing, microservices |

**Common algorithms:**

| Algorithm | How It Works | When To Use |
|---|---|---|
| Round Robin | Server 1, 2, 3, 1, 2, 3... | Servers are identical, requests are similar |
| Weighted Round Robin | Server 1 gets 50%, Server 2 gets 30%, Server 3 gets 20% | Servers have different capacities |
| Least Connections | Send to the server with the fewest active connections | Requests have variable processing time |
| IP Hash | Hash the client IP to pick a server. Same client always hits the same server. | Session stickiness without cookies |
| Consistent Hashing | Like IP hash, but adding/removing servers only moves a fraction of clients | Dynamic fleet sizes (Chapter 25) |

### Real-World Examples

**Example 1: Netflix — Multi-Layer Load Balancing**

Netflix uses a two-tier load balancing system. At the edge, AWS Elastic Load Balancer (ELB) distributes traffic across Zuul API gateway instances. Zuul (Netflix's custom L7 load balancer) then routes requests to specific microservices based on URL path: /api/profiles goes to the profile service, /api/playback goes to the streaming service. Each microservice has its own internal load balancer. This multi-layer approach handles millions of requests per second while allowing fine-grained routing control.

**Example 2: GitHub — Load Balancer as the First Line of Defense**

GitHub uses HAProxy (open-source L4/L7 load balancer) in front of its application servers. When GitHub experienced its massive 2018 DDoS attack (1.35 Tbps — the largest at the time), the load balancer was the first to see it. HAProxy's health checks detected backend servers becoming overwhelmed and started returning cached responses. Meanwhile, traffic was rerouted through Akamai's scrubbing centers. The load balancer bought time by gracefully degrading rather than crashing.

### When To Use / When NOT To Use

| Use a Load Balancer When | Don't Need One When |
|---|---|
| You have 2+ servers handling the same traffic | You have exactly 1 server (but plan for the future) |
| You need zero-downtime deployments (drain old servers, add new ones) | It's a batch job or scheduled task, not user-facing traffic |
| You want automatic failover (unhealthy server gets removed) | The client can handle server selection itself (service mesh, client-side LB) |
| You need to route by URL path, header, or content (L7) | Simple DNS round-robin is sufficient for your scale |

### Q&A

**Q: Is the load balancer itself a single point of failure? What if it crashes?**
A: Yes, if you have only one. In production, you run at least two load balancers in an active-passive or active-active setup. They share a virtual IP address (VIP) using a protocol like VRRP. If the active one dies, the passive takes over in seconds. Cloud load balancers (AWS ALB, GCP Cloud Load Balancer) handle this automatically — they're distributed across multiple availability zones.

**Q: What's the difference between a load balancer and a reverse proxy? (Chapter 11 preview)**
A: A load balancer distributes traffic across multiple servers. A reverse proxy sits in front of your servers and can do that PLUS additional things: SSL termination, caching, compression, and request/response modification. In practice, most modern tools (Nginx, HAProxy, AWS ALB) are both. When someone says "load balancer," they usually mean the traffic distribution function. When they say "reverse proxy," they mean the broader set of features.

**Q: We talked about stateless servers in Chapter 2. Why does that matter for load balancing?**
A: Because if servers are stateful (they store user sessions in memory), you MUST send the same user to the same server every time — a technique called "sticky sessions." This is fragile: if that server dies, the session is lost. If servers are stateless (sessions stored in Redis or a database), any server can handle any request. The load balancer has full freedom to distribute traffic optimally. This is the callback from Chapter 2 — making servers stateless is the enabler for effective load balancing.

**Q: You have 10 servers behind a load balancer. One server is 2x more powerful than the others. How do you configure the load balancer?**
A: Weighted round robin. Give the powerful server a weight of 2 and the others a weight of 1. The load balancer sends twice as many requests to the powerful server. Alternatively, use least-connections: the powerful server handles requests faster, finishes sooner, and naturally gets more new requests because it has fewer active connections. Least-connections is self-adjusting and often simpler than manually tuning weights.

**Q: Your servers are healthy, but users complain about slow responses. The load balancer dashboard shows even traffic distribution. What's going on?**
A: Even distribution doesn't mean even load. If 50% of your requests are fast (read from cache, 10ms) and 50% are slow (database query, 500ms), round-robin sends a mix to each server. But if one server happens to get a burst of slow requests, it backs up while others are fine. Switch to least-connections: it naturally routes new requests to servers that have finished their work, rather than blindly alternating. Also check if one server is slower due to noisy neighbors (shared cloud hardware), insufficient resources, or garbage collection pauses.

---

## Chapter 11: Reverse Proxy & API Gateway

**One-liner:** A reverse proxy sits between clients and your servers, handling cross-cutting concerns (security, routing, caching) so your servers don't have to. An API gateway is a reverse proxy specialized for APIs.

**Why you should care:** You have 15 microservices. Every one needs authentication, rate limiting, HTTPS, request logging, and CORS headers. Do you copy-paste that code into all 15 services? Or do you put one gatekeeper at the front door that handles it all? Without a reverse proxy / API gateway, every service reimplements infrastructure logic, every service is exposed directly to the internet, and one misconfigured service becomes a security hole.

**Prerequisites:** Chapters 9-10 (DNS, Load Balancers)

### The Simple Version

Think about a hotel concierge. Guests don't go directly to the kitchen for food, or to the maintenance room for a broken faucet, or to housekeeping for towels. They go to the concierge, who handles everything: routes requests to the right department, translates between languages, and shields departments from dealing with guests directly.

A reverse proxy is that concierge. Clients talk to it, not to your servers directly. It handles security, routing, and translation so your backend services can focus on their actual job.

### How It Actually Works

```
Without API Gateway                With API Gateway
━━━━━━━━━━━━━━━━━━                ━━━━━━━━━━━━━━━━━

  Client                            Client
    │                                 │
    ├──→ Auth Service                 ▼
    ├──→ User Service          ┌────────────┐
    ├──→ Order Service         │ API Gateway│
    ├──→ Payment Service       │            │
    └──→ Notification Service  │ • Auth     │
                               │ • Rate Limit│
  Each service must handle:    │ • SSL      │
  • SSL termination            │ • Logging  │
  • Auth validation            │ • Routing  │
  • Rate limiting              └──┬──┬──┬───┘
  • CORS                          │  │  │
  • Logging                    ┌──┴┐┌┴──┐┌┴──┐
                               │Usr││Ord││Pay│  ← Only business logic
                               └───┘└───┘└───┘
```

**What a reverse proxy / API gateway does:**

| Feature | What It Does | Why It Matters |
|---|---|---|
| SSL termination | Handles HTTPS encryption/decryption | Backend services communicate in plain HTTP (simpler, faster) |
| Authentication | Validates JWT tokens, API keys, OAuth | Services trust that requests reaching them are already authenticated |
| Rate limiting | Blocks clients exceeding their request quota | Protects all backend services from abuse, in one place |
| Request routing | Routes /users → User Service, /orders → Order Service | One public URL, many internal services |
| Response caching | Caches frequent responses | Reduces load on backend services |
| Load balancing | Distributes requests across service instances | Built-in, per-service load balancing |
| Request/response transformation | Modify headers, compress responses, translate protocols | Clients get a clean API regardless of internal formats |

**Common tools:**

| Tool | Type | Best For |
|---|---|---|
| Nginx | Reverse proxy + LB | General-purpose, high-performance static serving + proxying |
| Kong | API Gateway | Full-featured, plugin-based, Lua/Go extensible |
| AWS API Gateway | Managed API Gateway | Serverless APIs, Lambda integration |
| Envoy | Service proxy | Service mesh sidecar (Istio), advanced observability |

### Real-World Examples

**Example 1: Uber — API Gateway for 2,000+ Microservices**

Uber's API gateway handles all external and internal traffic routing. When you open the Uber app, your request hits the gateway, which authenticates you, rate-limits your requests, and routes to the right microservice (pricing, matching, ETA, payment). Uber processes millions of requests per second. Without the gateway, each of their 2,000+ microservices would need its own authentication stack, rate limiting, and SSL — an operational nightmare. The gateway also enables Uber to do canary deployments: route 1% of traffic to a new version of a service, monitor for errors, then gradually increase.

**Example 2: Stripe — The API Gateway as a Product Feature**

Stripe's API gateway isn't just infrastructure — it's part of their product. The gateway handles: API key validation (test vs live keys), request idempotency (if you send the same request twice, the gateway recognizes the idempotency key and returns the cached response), versioning (old clients hit API version 2022-11-15, new clients hit 2024-06-01), and detailed request logging for the developer dashboard. The gateway becomes a feature, not just plumbing.

### When To Use / When NOT To Use

| Use an API Gateway When | Skip It When |
|---|---|
| You have multiple backend services (microservices) | You have a single monolith — it already handles everything |
| Multiple clients need different APIs (web, mobile, IoT) | Internal tool with no external traffic |
| You need centralized auth, rate limiting, logging | The added latency (1-5ms per request) is unacceptable (ultra-low-latency trading) |
| You want to decouple client-facing API from internal service structure | You're using a service mesh that already handles cross-cutting concerns |

### Q&A

**Q: Isn't an API gateway just a load balancer with extra features?**
A: Close, but the emphasis is different. A load balancer's primary job is distributing traffic across server instances for availability and performance. An API gateway's primary job is managing API concerns: authentication, routing by path, rate limiting, protocol translation, and versioning. Modern tools like Nginx and Kong do both — but when you hear "load balancer," think "distribute traffic." When you hear "API gateway," think "manage API traffic."

**Q: Doesn't adding an API gateway add latency to every request?**
A: Yes — typically 1-5ms. For most applications, this is negligible compared to the 50-500ms of actual processing. And the gateway often reduces overall latency by caching responses and short-circuiting bad requests (auth failures, rate limit exceeded) before they hit your backend. The net effect is usually positive. Only skip it for ultra-low-latency systems (high-frequency trading, real-time gaming) where every millisecond counts.

**Q: We talked about load balancers in Chapter 10. Where does the API gateway fit relative to the load balancer?**
A: Usually: Internet → Load Balancer → API Gateway → Services. The load balancer distributes traffic across multiple API gateway instances (for availability). The API gateway then routes to specific backend services. In cloud setups, the load balancer is often managed (AWS ALB) and the API gateway is a separate layer. Some teams collapse them into one: Nginx can act as both load balancer and API gateway.

**Q: You're building a mobile app with a web app that talk to the same backend. The mobile app needs smaller payloads (bandwidth is expensive). How does the API gateway help?**
A: The gateway can implement the Backend-for-Frontend (BFF) pattern: /api/v1/mobile/feed returns a compact response with small image URLs and minimal text. /api/v1/web/feed returns a richer response with full-resolution images and extra metadata. Both hit the same backend services, but the gateway shapes the response differently. Alternatively, use GraphQL at the gateway layer — clients request exactly the fields they need.

**Q: Your API gateway becomes a bottleneck — it can't handle the traffic. How do you scale it?**
A: API gateways are stateless (they just proxy requests), so they scale horizontally. Put a load balancer in front of multiple gateway instances and auto-scale. If the gateway does response caching, add a shared cache (Redis) so all instances share cached responses. At extreme scale, some companies split into multiple gateways: one for public API traffic, one for internal service-to-service traffic, each optimized differently.

---

## Chapter 12: Databases — SQL vs NoSQL

**One-liner:** SQL databases store data in structured tables with strict rules; NoSQL databases trade some of those rules for flexibility, speed, or scale.

**Why you should care:** You're building a social network. You pick MySQL because it's what you know. Your users table, posts table, and comments table work great. Then you need to store user activity feeds — billions of events with varying schemas. Your friendship graph — billions of edges, traversed frequently. User-generated content with unpredictable fields. MySQL struggles with all of these. You should have used different databases for different data. The first big design decision in any system is: where does the data live?

**Prerequisites:** Chapters 5 and 7 (Consistency Models, ACID vs BASE)

### The Simple Version

Think about organizing information in two ways:

**SQL = a spreadsheet.** Rows and columns. Every row has the same columns. You can't put a phone number in the "age" column. Strict, organized, easy to query ("show me all users over 25 in California"). Great for structured data that follows rules.

**NoSQL = a filing cabinet.** Each folder can contain anything: a document, a photo, a sticky note. Different folders can have different types of things. Flexible, fast to toss something in, but harder to ask structured questions across all folders.

Neither is "better." Spreadsheets are great for financial records. Filing cabinets are great for creative projects. Use the right tool for the data.

### How It Actually Works

**SQL (Relational) Databases:**

Store data in tables with predefined schemas. Relationships between tables are defined by foreign keys. Queried with SQL. ACID compliant.

| Database | Known For | Used By |
|---|---|---|
| PostgreSQL | Feature-rich, extensible, strong consistency | Stripe, Instagram, Notion |
| MySQL | Reliable, mature, read-optimized | Facebook, Twitter, Uber |
| Oracle | Enterprise features, commercial | Banks, governments, airlines |

**NoSQL Databases — four types, four use cases:**

| Type | How It Stores Data | Best For | Examples |
|---|---|---|---|
| Key-Value | Simple pairs: key → value | Caching, sessions, simple lookups | Redis, DynamoDB, Memcached |
| Document | JSON/BSON documents, flexible schema | User profiles, content catalogs, CMS | MongoDB, CouchDB, Firestore |
| Wide-Column | Rows with dynamic columns, optimized for writes | Time-series, IoT, messaging, analytics | Cassandra, HBase, ScyllaDB |
| Graph | Nodes + edges, optimized for relationships | Social networks, recommendations, fraud detection | Neo4j, Amazon Neptune |

```
SQL vs NoSQL — Decision Flowchart
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Is your data highly structured with
  clear relationships?
    │
    ├── YES → Do you need ACID transactions?
    │           ├── YES → SQL (PostgreSQL, MySQL)
    │           └── NO  → Either works. SQL is safer default.
    │
    └── NO  → What's your primary concern?
                ├── Massive write throughput → Wide-Column (Cassandra)
                ├── Flexible/nested documents → Document (MongoDB)
                ├── Simple key lookups at speed → Key-Value (Redis/DynamoDB)
                └── Relationship traversal → Graph (Neo4j)
```

### Real-World Examples

**Example 1: Instagram — PostgreSQL Under the Hood**

Instagram started with and still uses PostgreSQL as its primary database. Their user data, photos metadata, relationships (followers/following), and likes all live in PostgreSQL. They shard PostgreSQL across many instances (thousands) using user ID. Why SQL for a social network? Because the core data IS relational: users follow users, users like photos, photos belong to users. SQL makes these queries natural. Instagram added Cassandra for their feed/activity data (high write throughput, eventual consistency is fine for feeds) — polyglot persistence in action.

**Example 2: Uber — PostgreSQL + Cassandra + Redis**

Uber uses PostgreSQL for trip data and financial records (ACID for payments), Cassandra for driver location tracking (millions of writes per second, location data has natural time-based partitioning), and Redis for real-time caching (driver availability, surge pricing calculations). Three databases, three use cases, each chosen for its strength. Uber's CTO has said their biggest early mistake was using one MySQL instance for everything — they spent years migrating to the right tools.

### When To Use / When NOT To Use

| Use SQL When | Use NoSQL When |
|---|---|
| Data has clear structure and relationships (users, orders, products) | Schema changes frequently or varies by record |
| You need ACID transactions (payments, inventory) | You need massive write throughput (IoT, logging, time-series) |
| Complex queries with JOINs are common | Queries are simple key-based lookups |
| Data integrity is critical | Availability and partition tolerance matter more than strict consistency |
| You're unsure — SQL is the safer default | You've identified a specific NoSQL advantage for your use case |

### Q&A

**Q: I've heard "NoSQL is faster than SQL." Is that true?**
A: It's misleading. NoSQL key-value lookups (Redis, DynamoDB) are faster than SQL queries with JOINs — that's comparing a dictionary lookup to a cross-reference search. But PostgreSQL with a proper index is just as fast for single-row lookups. NoSQL's speed advantage comes from: (1) simpler query patterns (no JOINs), (2) horizontal scaling built-in (Cassandra), and (3) trading consistency for availability. An indexed SQL query on a properly tuned database is not slow. The "NoSQL is faster" myth comes from comparing unindexed SQL queries against NoSQL key lookups.

**Q: Can I start with SQL and switch to NoSQL later if I need to scale?**
A: Partially. You can add NoSQL alongside SQL (polyglot persistence) — move your cache to Redis, your activity feeds to Cassandra, and keep your core data in PostgreSQL. But migrating existing data FROM SQL TO NoSQL is painful: you must reshape your data model, rewrite queries, and handle the migration without downtime. Start with SQL for structured data. Add NoSQL for specific use cases as they emerge. Don't try to predict all your data needs on day one.

**Q: What about NewSQL databases like CockroachDB and Google Spanner? Where do they fit?**
A: NewSQL gives you the best of both: SQL's relational model and ACID transactions, plus NoSQL's horizontal scalability. CockroachDB and Spanner distribute data across nodes automatically, support standard SQL, and provide strong consistency. The trade-off is higher latency per query (distributed coordination) and operational complexity. Use NewSQL when you need both ACID and horizontal scale — global financial systems, multi-region e-commerce. For most apps, PostgreSQL with read replicas is simpler and sufficient.

**Q: You're building a messaging app. Where do you store messages — SQL or NoSQL?**
A: NoSQL (wide-column store like Cassandra or ScyllaDB). Here's why: messaging is write-heavy (billions of messages per day), reads are sequential (load a conversation in order), and the data model is simple (userId, conversationId, timestamp, messageBody — no complex JOINs). Cassandra excels at this: partition by conversationId, sort by timestamp, and writes are fast because it uses an LSM tree (append-only, no random disk seeks). WhatsApp uses a similar approach. User account data (email, profile, settings) still belongs in PostgreSQL.

**Q: Your startup uses MongoDB for everything — user data, payments, analytics. The team loves the flexibility. What could go wrong?**
A: Payments without ACID transactions. MongoDB added multi-document transactions in v4.0, but they're slower and more limited than PostgreSQL's. If your payment flow requires atomically updating an order, a payment record, and inventory, MongoDB can do it, but it's working against the grain. Also: as your data becomes more relational (users → orders → items → reviews), you'll find yourself doing application-level JOINs (multiple queries) instead of SQL JOINs (one query). The flexibility you loved early becomes the overhead you fight later. Consider PostgreSQL for transactional data and keeping MongoDB for the flexible-schema use cases it excels at.

---

## Chapter 13: Database Indexing

**One-liner:** An index is a data structure that makes database lookups fast — turning a "scan every row" operation into a "jump straight to the answer" operation.

**Why you should care:** Your users table has 50 million rows. A user logs in and you query: `SELECT * FROM users WHERE email = 'alice@example.com'`. Without an index, the database reads all 50 million rows to find Alice. Time: 10-30 seconds. With an index on the email column, the database jumps directly to Alice's row. Time: 1-5 milliseconds. Same query. Same data. 10,000x faster. Indexes are probably the single highest-ROI optimization in all of software engineering.

**Prerequisites:** Chapter 12 (Databases — SQL vs NoSQL)

### The Simple Version

Think about a textbook with 1,000 pages. You need to find every mention of "photosynthesis."

**Without an index:** Read all 1,000 pages, scanning for the word. This is a full table scan.

**With an index (the back-of-book index):** Flip to the index at the back: "Photosynthesis: pages 42, 156, 301." Jump directly to those pages. Done in seconds instead of hours.

The index is a separate, sorted list that says "this value is on this page." It takes extra space (the index itself is pages long) and must be updated whenever content changes. But the lookup speedup is so dramatic that it's almost always worth it.

### How It Actually Works

**B-tree index** (the default in PostgreSQL, MySQL):

A balanced tree structure where each node points to a range of values. Lookups follow the tree from root to leaf in O(log n) — for 50 million rows, that's about 8 steps instead of 50 million.

```
B-Tree Index: Finding email = "alice@example.com"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

                    ┌───────────────┐
                    │   M           │  ← Root: "alice" < M, go left
                    └──┬─────────┬──┘
                       │         │
                 ┌─────┴──┐  ┌──┴─────┐
                 │  D   H │  │  R   V │
                 └┬──┬──┬─┘  └────────┘
                  │  │  │
            ┌─────┘  │  └─────┐
            ▼        ▼        ▼
         ┌─────┐ ┌──────┐ ┌──────┐
         │A-C  │ │D-G   │ │H-L   │  ← Leaf: found "alice@..." → row pointer
         │alice│ │david │ │henry │
         └─────┘ └──────┘ └──────┘

  8 comparisons instead of 50,000,000. O(log n) vs O(n).
```

**Key index types:**

| Index Type | How It Works | Best For |
|---|---|---|
| B-tree | Sorted tree, O(log n) lookup | Range queries, equality, ORDER BY. The default. |
| Hash | Hash function, O(1) lookup | Exact equality only. Can't do ranges. |
| Composite | Index on multiple columns (e.g., country + city) | Queries that filter on multiple columns. Leftmost prefix rule applies. |
| Full-text | Inverted index (word → document list) | Search queries, text matching |
| LSM tree | Append-only log + sorted compaction | Write-heavy workloads (Cassandra, RocksDB) |

**The trade-off:** Indexes speed up reads but slow down writes. Every INSERT, UPDATE, or DELETE must also update every index on that table. A table with 10 indexes means every write does 10 extra operations. Index what you query. Don't index everything.

### Real-World Examples

**Example 1: Stack Overflow — How Indexing Handles 1.3 Billion Page Views**

Stack Overflow serves 1.3 billion page views per month from a surprisingly small number of SQL Server instances. The secret: aggressive, targeted indexing. Their most common query patterns — loading questions by ID, searching by tag, sorting by votes — all have dedicated indexes. They use composite indexes heavily: an index on (Tag, Score DESC) lets the query "top questions for Python" skip scanning millions of rows. Their DBA team treats indexing as a core engineering practice, not an afterthought.

**Example 2: Shopify — The Missing Index That Took Down Black Friday**

During a past Black Friday, a Shopify merchant's store slowed to a crawl. The root cause: a query filtering orders by date range AND status had no composite index. Each query did a partial index scan on date, then filtered millions of rows for status in application code. Adding a composite index on (status, created_at) fixed it — query time dropped from 12 seconds to 3 milliseconds. This is a common pattern: applications work fine with small data, then crumble when data grows because nobody added the right index.

### When To Use / When NOT To Use

| Add an Index When | Don't Index When |
|---|---|
| A column appears in WHERE clauses frequently | The table is small (< 10,000 rows) — full scan is fast enough |
| A column is used in JOIN conditions | The column has very low cardinality (e.g., boolean: only true/false) |
| You sort by a column (ORDER BY) | The table is write-heavy and rarely queried (logs, event streams) |
| Query performance matters for that table | You already have 10+ indexes on the table — each write is paying the cost |

### Q&A

**Q: If indexes make reads faster, why not index every column?**
A: Because every index slows down writes and uses disk space. An index is a separate data structure that must be updated on every INSERT, UPDATE, and DELETE. A table with 10 indexes means each write does 11 operations (1 to the table + 10 index updates). For a write-heavy table (logging, analytics events), excessive indexes can make writes 5-10x slower. Index only the columns you actually query.

**Q: What's the "leftmost prefix rule" for composite indexes?**
A: A composite index on (country, city, zip_code) can be used for queries filtering on: (country), (country + city), or (country + city + zip_code). But NOT for (city) alone or (zip_code) alone — the database can only use the index starting from the left. So if your most common query filters by city only, you need a separate index on (city). Order matters when designing composite indexes.

**Q: My query is slow. How do I know if it's an indexing problem?**
A: Use EXPLAIN (PostgreSQL) or EXPLAIN ANALYZE. It shows the query plan: whether the database is using an index (Index Scan — fast) or scanning the whole table (Seq Scan — slow). If you see a sequential scan on a large table with a WHERE clause, you're missing an index. EXPLAIN also shows estimated vs actual row counts — a big mismatch means statistics are stale (run ANALYZE).

**Q: You have a users table with 100 million rows. You need to find all users who signed up in the last 7 days. How do you make this fast?**
A: Create an index on the created_at column: `CREATE INDEX idx_users_created_at ON users(created_at)`. The database uses the B-tree index to jump directly to the rows from the last 7 days without scanning all 100 million rows. If you also filter by status (active/inactive), create a composite index: `CREATE INDEX idx_users_status_created ON users(status, created_at)`. The leftmost prefix rule means the database first narrows to the status, then scans the date range within that subset.

**Q: Cassandra and DynamoDB don't have B-tree indexes. How do they make lookups fast?**
A: They use partition keys instead of traditional indexes. Data is distributed across nodes by hashing the partition key. When you query by partition key, the system goes directly to the node holding that data — O(1) lookup. Within a partition, data is sorted by the clustering key (like a built-in sorted index). The trade-off: you can only efficiently query by partition key (and optionally clustering key). Queries on other columns require a full cluster scan or a secondary index — which is why data modeling in Cassandra starts with "what queries will I run?" and works backwards to the table design.

---

## Chapter 14: Database Replication

**One-liner:** Database replication copies your data to multiple servers so you can survive failures and distribute read traffic.

**Why you should care:** It's 3 AM. Your database server's hard drive fails. All your data — user accounts, orders, payment records — lives on that one machine. If you have no replicas, you're restoring from last night's backup and losing everything since then. If you have a replica, it takes over in seconds, and you lose nothing. Replication is the difference between "5-second blip" and "front-page news data loss incident."

**Prerequisites:** Chapters 3, 5, and 12 (Availability, Consistency Models, Databases)

### The Simple Version

Imagine you're an author writing a book. You keep the only copy on your laptop. Your laptop gets stolen. Years of work — gone.

Now imagine you set up automatic cloud backup. Your laptop syncs every change to the cloud in real-time. Laptop stolen? Open your cloud copy and keep writing. That's replication: keeping copies of your data on separate machines so you're never one failure away from catastrophe.

But there's a choice: do you wait for the cloud backup to confirm before you save locally (slower, but you know the backup exists), or save locally first and let the backup happen in the background (faster, but if you lose the laptop before the sync finishes, you lose recent work)?

### How It Actually Works

**Primary-Replica (Master-Slave) replication:**

One server (primary) handles all writes. One or more replicas receive copies of those writes and handle reads.

```
Primary-Replica Replication
━━━━━━━━━━━━━━━━━━━━━━━━━━

  App Servers
    │ writes            │ reads
    ▼                   ▼
  ┌───────┐    ┌──────────────────┐
  │Primary│──→ │Replica 1│Replica 2│
  │ (RW)  │    │  (RO)   │  (RO)  │
  └───────┘    └──────────────────┘
       │
       │ replication stream
       └──→ changes are copied
            to all replicas
```

**Sync vs Async replication:**

| | Synchronous | Asynchronous |
|---|---|---|
| How | Primary waits for replica to confirm before acknowledging write | Primary acknowledges write immediately, sends to replica in background |
| Consistency | Strong — replicas always have latest data | Eventual — replicas may lag by milliseconds to seconds |
| Write speed | Slower (must wait for replica) | Faster (write returns immediately) |
| Data loss risk | None (replica confirmed) | Possible (if primary dies before replica gets the write) |
| Used by | Financial systems, critical data | Social media, content platforms, most web apps |

**Multi-primary (Master-Master) replication:**

Multiple servers accept writes. Higher availability (any server can handle writes even if others fail), but introduces write conflicts. If User A updates a record on Server 1 and User B updates the same record on Server 2 simultaneously, you need a conflict resolution strategy (last-write-wins, merge, or application-level resolution).

### Real-World Examples

**Example 1: MySQL at Facebook — Lag-Aware Reads**

Facebook uses MySQL with primary-replica replication. Writes go to the primary. Reads go to replicas. But replicas can lag behind the primary by milliseconds. If you just posted a photo and immediately refresh your profile, you might not see it (your read hit a lagging replica). Facebook's solution: after a write, the user's subsequent reads are routed to the primary (or a replica guaranteed to be caught up) for a short window. This is the "read-your-writes" consistency model from Chapter 5, implemented through replication-aware routing.

**Example 2: GitHub — Replica Promotion During the 2018 Outage**

In the 2018 GitHub outage (Chapter 3), a 43-second network partition caused the MySQL primary and replicas to diverge. When connectivity returned, GitHub had to choose: promote the replica (which had some writes the primary didn't) or keep the primary (which had writes the replicas didn't). They chose data integrity — they stopped writes, reconciled the diverged data manually, and only then resumed. This took 24 hours. Lesson: replication handles most failures gracefully, but a split-brain during a partition is the hardest case.

### When To Use / When NOT To Use

| Use Replication When | Async vs Sync |
|---|---|
| You need failover (your primary dies, a replica takes over) | Async for most apps (faster, small data loss acceptable) |
| Read traffic far exceeds write traffic (add read replicas) | Sync for financial/critical data (zero data loss tolerance) |
| You serve users in multiple regions (replica per region = lower latency) | Semi-sync for a middle ground (1 replica sync, rest async) |

| Be Careful When |
|---|
| Multi-primary: write conflicts are complex and bug-prone |
| Cross-region replication: high latency between continents adds replication lag |
| Too many replicas: the primary spends too much CPU shipping replication data |

### Q&A

**Q: If the primary dies, how does a replica "take over" automatically?**
A: This is called automatic failover. The system monitors the primary's health (heartbeats). If the primary stops responding, a replica is promoted to primary. The load balancer or DNS is updated to point writes to the new primary. Tools like Patroni (PostgreSQL), Orchestrator (MySQL), or cloud-managed databases (AWS RDS) handle this automatically. Manual failover (a human decides and promotes) is safer but slower — minutes vs seconds.

**Q: You mentioned "replication lag." How much lag is normal, and when is it a problem?**
A: In async replication within the same data center, lag is typically under 100 milliseconds. Cross-region, it's 50-200ms. Lag becomes a problem when: (1) a user writes data and immediately reads it from a lagging replica, seeing stale state (fix: read-your-writes routing), or (2) lag spikes during heavy write periods, causing replicas to fall minutes behind (fix: monitor lag, throttle writes, or add more replicas to distribute the load).

**Q: Can replication replace backups?**
A: No. Replication protects against hardware failure (a server dies). Backups protect against logical errors (someone accidentally runs `DELETE FROM users` — the replicas happily replicate the deletion). You need both. Replication for high availability. Point-in-time backups for disaster recovery.

**Q: You have a primary database in Virginia and a replica in Frankfurt. A user in Germany reads from the Frankfurt replica. Their data is 200ms behind. Is this a problem?**
A: Depends on the data. For a social media feed, no — 200ms-stale post data is unnoticeable. For a bank balance after a transfer, yes — the user needs to see the updated balance immediately. The solution isn't to make everything synchronous (that would add 200ms to every write). It's to route critical reads (balance checks, inventory counts) to the primary, and non-critical reads (feeds, recommendations) to the nearest replica. Different data, different routing, same system.

**Q: Your database primary handles 5,000 writes/sec and 50,000 reads/sec. Adding a third replica doesn't help. What's the bottleneck?**
A: If reads are the bottleneck, a third replica should help — unless all three replicas are in the same availability zone and the network between them is saturated. Check if queries are hitting the primary instead of replicas (misconfigured connection pooler). If writes are the bottleneck, replicas don't help at all — all writes go to the primary. For write scaling, you need sharding (Chapter 15): split data across multiple primaries, each handling a subset of writes.

---

## Chapter 15: Database Sharding

**One-liner:** Sharding splits your database across multiple machines, so each machine stores only a portion of the data.

**Why you should care:** Your PostgreSQL database has 2 billion rows and 4 TB of data. Queries are slowing down — even with indexes, the B-trees are huge, the working set doesn't fit in RAM, and every write touches a massive WAL (write-ahead log). You've scaled vertically (the biggest instance available) and added read replicas (which handle reads but don't help with writes). You're stuck. Sharding is the next step: split that 4 TB across 10 databases of 400 GB each. Each shard is small enough to be fast again.

**Prerequisites:** Chapters 12-14 (Databases, Indexing, Replication)

### The Simple Version

Imagine a library with 10 million books on one floor. Finding a book means navigating one enormous space. The library is crowded — everyone is on the same floor, bumping into each other.

Now split the library across 10 floors: Floor 1 has authors A-C, Floor 2 has D-F, and so on. Each floor is smaller, faster to navigate, and less crowded. You can even staff each floor independently.

But there's a catch: if a visitor wants books by authors from A-C AND D-F, they have to visit two floors. Cross-shard queries are the price of sharding.

### How It Actually Works

**Sharding strategies:**

| Strategy | How It Works | Pros | Cons |
|---|---|---|---|
| Hash-based | shard = hash(key) % num_shards | Even distribution | Resharding (adding shards) moves lots of data |
| Range-based | Shard by ranges (A-M → Shard 1, N-Z → Shard 2) | Range queries stay on one shard | Hotspots if data isn't uniform (most users start with "J") |
| Geography-based | Shard by region (US data → US shard, EU data → EU shard) | Data locality, compliance (GDPR) | Cross-region queries are slow |
| Consistent hashing | Hash ring with virtual nodes | Adding/removing shards moves minimal data | More complex to implement |

```
Hash-Based Sharding Example
━━━━━━━━━━━━━━━━━━━━━━━━━━━

  User "alice" → hash("alice") = 7429
  7429 % 4 shards = shard 1

  User "bob" → hash("bob") = 2198
  2198 % 4 shards = shard 2

  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
  │ Shard 0 │  │ Shard 1 │  │ Shard 2 │  │ Shard 3 │
  │         │  │ alice   │  │  bob    │  │         │
  │         │  │ charlie │  │  dave   │  │ eve     │
  └─────────┘  └─────────┘  └─────────┘  └─────────┘
```

**The shard key** is the most important decision. It determines which shard a piece of data lives on. A good shard key:
1. **Distributes data evenly** (no "hot" shards)
2. **Routes most queries to a single shard** (avoids cross-shard queries)
3. **Doesn't change** (changing the shard key means moving data between shards)

For a messaging app, shard key = userId. All of a user's messages live on one shard. "Load conversation" hits one shard. If you sharded by conversationId, loading a user's inbox would hit every shard — terrible.

### Real-World Examples

**Example 1: Instagram — Sharding PostgreSQL by User ID**

Instagram shards its PostgreSQL databases by user ID. Each shard holds a few million users' data: photos, likes, comments, relationships. When you load a user's profile, the app computes the shard (hash(userId) % num_shards), connects to that shard, and queries locally. The critical insight: Instagram chose user ID as the shard key because most operations are user-centric (my photos, my feed, my likes). Cross-user queries (who liked this photo?) are denormalized — the photo's shard stores a copy of the like data, avoiding cross-shard lookups.

**Example 2: Discord — Moving from MongoDB to Cassandra to Handle Trillions of Messages**

Discord originally stored messages in MongoDB, sharded by channel ID. As servers (Discord communities) grew, some channels had billions of messages — creating massive hot shards. A single large server's chat history could overwhelm one shard while others sat idle. They migrated to Cassandra, where the partition key is (channel_id, bucket) — time-bucketed so no single partition grows unboundedly. Each bucket covers a fixed time range. This eliminated hot shards while keeping message queries fast (always scoped to a channel + time range).

### When To Use / When NOT To Use

| Shard When | Don't Shard When |
|---|---|
| Your data exceeds what one machine can handle (TB+) | Your data fits on one instance with room to grow |
| Write throughput exceeds single-primary capacity | Read replicas can handle your read load |
| You need data locality (regulatory: EU data in EU) | The operational complexity of sharding isn't worth it for your scale |
| You've exhausted vertical scaling and read replicas | You can use a horizontally-scalable database (Cassandra, DynamoDB) instead of manually sharding |

### Q&A

**Q: Sharding sounds like a lot of complexity. Why not just use a bigger server?**
A: Because there's a ceiling. The biggest cloud database instance has ~128 vCPUs and ~4 TB RAM. If your data is 10 TB with 100,000 writes/second, no single server handles it. More practically, even before hitting hardware limits, a single database has bottlenecks: one WAL, one replication stream, one lock manager. Sharding parallelizes everything — each shard has its own resources. But you're right that it's complex: only shard when you've exhausted simpler solutions (indexing, caching, read replicas, vertical scaling).

**Q: What's the difference between sharding and partitioning?**
A: In common usage, they're often interchangeable. Technically: partitioning splits data within one database server (e.g., PostgreSQL table partitioning by date). Sharding splits data across multiple database servers. Partitioning helps with query performance on large tables. Sharding helps with scaling beyond one machine. You often use both: shard across machines, then partition within each shard.

**Q: What happens when I need to add a new shard? How do I redistribute data?**
A: This is resharding, and it's painful with naive hash-based sharding. hash(key) % 4 and hash(key) % 5 produce completely different assignments — you'd move ~80% of data. This is why consistent hashing (Chapter 25) was invented: adding a node only moves ~1/N of the data (where N is the number of nodes). Alternatively, pre-allocate more logical shards than you need (e.g., 256 logical shards mapped to 4 physical servers), and rebalance by moving entire logical shards — no rehashing needed.

**Q: You're designing an e-commerce platform. Should you shard by user ID or order ID?**
A: User ID. Most queries are user-centric: "show my orders," "show my cart," "show my wishlist." Sharding by userId keeps all of a user's data on one shard, making these queries fast. Sharding by orderId would spread one user's orders across random shards — loading "my orders" would hit every shard. For queries like "all orders for product X" (admin analytics), use a separate analytics pipeline (Chapter 40) rather than cross-shard queries.

**Q: Your sharded database has 8 shards. Shard 3 has 10x the data and traffic of the other shards because it contains a celebrity user with 50 million followers. What do you do?**
A: This is a "hot shard" problem. Options: (1) Shard the hot shard further — split shard 3 into 3a and 3b, dividing the celebrity's data (e.g., by follower ID range). (2) Move the hot user to a dedicated shard with more resources. (3) Add a cache layer in front of shard 3 specifically (since celebrity data is read-heavy). (4) If your shard key is hash-based, double-check — a truly random hash shouldn't create hot shards unless one user generates disproportionate traffic, which suggests the shard key granularity is too coarse (shard by userId, not by first letter of username).

---

## Chapter 16: Caching

**One-liner:** A cache stores frequently accessed data in fast memory so you don't keep hitting the slow database for the same thing.

**Why you should care:** Your homepage shows the top 20 trending articles. Every visitor triggers the same database query: complex JOIN across 3 tables, aggregation, sorting. 10,000 visitors per minute. That's 10,000 identical, expensive queries — each taking 200ms of database time. With a cache: run the query once, store the result in Redis (in-memory, < 1ms read). The next 9,999 visitors get the cached result. Database load drops 99.9%. Response time drops from 200ms to 1ms. One concept, 200x improvement.

**Prerequisites:** Chapters 4 and 12 (Latency vs Throughput, Databases)

### The Simple Version

You're studying for an exam. Your textbook is in the library (database). Every time you need to check a fact, you walk to the library, find the book, read it, and walk back. Slow.

Instead, you photocopy the most important pages and keep them on your desk (cache). Now most lookups are instant — just glance at your desk. You only walk to the library when you need something that isn't on your desk.

The trade-off: your photocopies might be outdated if the textbook gets a new edition. That's cache staleness. But for most facts (capital of France, boiling point of water), the cached answer is correct for a long time.

### How It Actually Works

**Common caching patterns:**

| Pattern | How It Works | Consistency | Best For |
|---|---|---|---|
| Cache-aside | App checks cache first. On miss, reads DB, writes to cache. | App manages; can go stale | Most common, general purpose |
| Write-through | App writes to cache AND DB simultaneously | Always consistent | When reads of recently written data are common |
| Write-back | App writes to cache only. Cache writes to DB async. | Risk of data loss | Extremely high write throughput |
| Read-through | Cache loads from DB on miss (cache manages its own filling) | Simpler app code | When cache and DB are tightly integrated |

```
Cache-Aside Pattern (Most Common)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1. App checks cache
     ┌─────┐  "user:123?"  ┌───────┐
     │ App │──────────────→│ Redis │
     │     │←──────────────│(Cache)│
     └─────┘   MISS         └───────┘

  2. App reads from DB
     ┌─────┐  SELECT...    ┌────┐
     │ App │──────────────→│ DB │
     │     │←──────────────│    │
     └─────┘  {user data}  └────┘

  3. App writes result to cache (with TTL)
     ┌─────┐  SET user:123  ┌───────┐
     │ App │───────────────→│ Redis │
     └─────┘   TTL=300s     └───────┘

  4. Next request: cache HIT (< 1ms)
```

**Cache eviction policies (when cache is full, what gets removed?):**

| Policy | Rule | Good For |
|---|---|---|
| LRU (Least Recently Used) | Remove what hasn't been accessed longest | General purpose (most popular choice) |
| LFU (Least Frequently Used) | Remove what's accessed least often | Data with stable popularity (trending lists) |
| TTL (Time To Live) | Remove after a fixed time regardless | Data that goes stale on a schedule (API responses, sessions) |

**Cache invalidation** — keeping the cache in sync with the database — is famously one of the two hard problems in computer science. Common strategies:
1. **TTL-based**: Set a 60-second TTL. Data might be stale for up to 60 seconds. Simple.
2. **Event-based**: When data changes in the DB, publish an event that deletes/updates the cache entry. Consistent but complex.
3. **Write-through**: Write to cache and DB simultaneously. Always consistent but every write is slower.

### Real-World Examples

**Example 1: Twitter — Cache Everything**

Twitter caches aggressively at every layer. User timelines are precomputed and cached in Redis (when someone tweets, it's fanned out to followers' cached timelines — more on this in the Twitter design in Part 5). User profiles are cached. Tweet data is cached. Even the count of retweets and likes is cached in Redis and periodically flushed to the database. Twitter's cache hit rate is reportedly above 99% — meaning less than 1% of reads actually hit the database. Without caching, Twitter's database would need to handle ~300 billion reads/day instead of ~3 billion.

**Example 2: Stack Overflow — L1 + L2 Cache Architecture**

Stack Overflow uses a two-level caching strategy. L1: in-process memory cache (each web server caches hot data in its own RAM). L2: Redis (shared cache across all web servers). A request first checks L1 (fastest, but per-server, limited capacity). On L1 miss, checks L2 Redis (slightly slower, but shared and larger). On L2 miss, queries SQL Server. This minimizes both network calls (L1 avoids even the Redis round-trip) and database load (L2 catches what L1 misses). Result: 1.3 billion page views/month on 9 web servers.

### When To Use / When NOT To Use

| Cache When | Don't Cache When |
|---|---|
| The same data is read much more often than it's written | Data changes on every request (real-time stock prices) |
| Database queries are expensive (complex JOINs, aggregations) | Data must always be 100% fresh (bank account balances after transactions) |
| Response time matters (user-facing pages, APIs) | Cache hit rate would be low (highly unique queries, large working set) |
| You can tolerate briefly stale data | Correctness depends on exact-moment accuracy |

### Q&A

**Q: Is a cache just... faster memory? How is Redis different from a database?**
A: Redis stores data in RAM, which is ~1,000x faster than disk. A database stores data on disk (SSD) with some RAM caching. Redis gives you microsecond reads for data in memory, but RAM is expensive and limited (a few hundred GB). A database gives you millisecond reads from terabytes of data. Redis is complementary, not a replacement: put hot, frequently read data in Redis (small), keep everything in the database (large). Also, Redis is ephemeral by default — if it restarts, the cache is cold (empty). Your database is durable.

**Q: What's a cache stampede, and how do I prevent it?**
A: When a popular cache entry expires, hundreds of concurrent requests all miss the cache simultaneously and all hit the database with the same expensive query. The database gets hammered. Prevention: (1) Lock: the first request that misses sets a lock; others wait and read the cache once it's refilled. (2) Early recompute: refresh the cache before TTL expires (background refresh). (3) Stale-while-revalidate: serve the stale cached value while one request refreshes it in the background.

**Q: How do I decide what to cache?**
A: Cache based on the 80/20 rule: 20% of your data serves 80% of reads. Find your "hot" data — popular products, trending content, user sessions, configuration — and cache that. Don't try to cache your entire database. Measure your cache hit rate: aim for 90%+. If your hit rate is below 50%, your working set is too large for your cache, or your data is too unique (each request needs different data).

**Q: You're building an e-commerce site. You cache product prices in Redis with a 1-hour TTL. A merchant updates a price from $100 to $50 (sale). Customers still see $100 for up to an hour. How do you fix this?**
A: Event-based invalidation. When the merchant updates the price in the database, publish a "price_changed" event. A cache invalidation service listens for this event and deletes the cached price immediately. The next read sees a cache miss and fetches the new $50 price from the database. This gives you the performance of caching (most reads hit cache) with the freshness of real-time updates (changes propagate in milliseconds, not hours).

**Q: Your Redis cache has a 95% hit rate but uses 100 GB of RAM ($800/month on AWS). Is it worth the cost?**
A: Calculate the alternative. Without cache, 100% of reads hit the database. If you serve 100,000 reads/sec and the cache handles 95,000 of them, you'd need a database 20x more powerful to handle all 100,000. A large RDS PostgreSQL instance costs ~$3,000-$10,000/month. Your $800/month Redis saves you $2,200-$9,200/month in database costs AND provides lower latency. Caching ROI is almost always positive. The exception: if your working set is so large that you need 1 TB+ of Redis, the cost might exceed the database savings.

---

## Chapter 17: CDN (Content Delivery Network)

**One-liner:** A CDN caches your content (images, videos, web pages) on servers around the world so users load it from a nearby location instead of your origin server thousands of miles away.

**Why you should care:** A user in Mumbai loads your website. Your server is in Virginia. The data travels 13,000 km — through undersea cables, multiple routers, and several networks. Round-trip: ~200ms. Your page has 50 assets (images, CSS, JS). Loading them sequentially: 10 seconds. With a CDN, those assets are cached on a server in Mumbai. Round-trip: ~5ms. Same assets, 40x faster. For a video streaming service, CDNs aren't optional — without them, your origin server's bandwidth bill alone would bankrupt you.

**Prerequisites:** Chapters 4, 9, and 16 (Latency, DNS, Caching)

### The Simple Version

Amazon doesn't ship every package from one giant warehouse in Seattle. They have fulfillment centers in every major city. When you order something, it ships from the closest warehouse — maybe 50 miles away instead of 3,000.

A CDN does the same thing for digital content. Instead of one server in Virginia serving the whole world, a CDN puts copies of your content on servers (called "edge servers" or "Points of Presence") in 200+ cities worldwide. Users automatically get served from the nearest one.

### How It Actually Works

**Two types:**

| Type | How It Works | Best For |
|---|---|---|
| Pull CDN | Edge server fetches from your origin server on first request, then caches it. Subsequent requests served from cache. | Most websites — set it up and forget it. |
| Push CDN | You upload content to CDN directly. It's available on all edges before any user requests it. | Video streaming, large files — where you know content needs to be everywhere. |

```
How a CDN Serves Content
━━━━━━━━━━━━━━━━━━━━━━━━

  User in Tokyo requests image.jpg

  1. DNS resolves cdn.example.com → nearest CDN edge (Tokyo)
  2. Edge checks: "Do I have image.jpg?"

  ┌─ YES (cache hit) ──→ Serve directly. 5ms. Done.
  │
  └─ NO (cache miss) ──→ Fetch from origin (Virginia). 200ms.
                         Cache it at Tokyo edge.
                         Serve to user.
                         Next Tokyo user gets it in 5ms.

  ┌──────────────────────────────────────────────┐
  │              Your Origin Server              │
  │              (Virginia, USA)                  │
  └──────┬──────────┬──────────┬─────────────────┘
         │          │          │
    ┌────┴───┐ ┌────┴───┐ ┌───┴────┐
    │ CDN    │ │ CDN    │ │ CDN    │
    │ Tokyo  │ │ London │ │ Mumbai │  ... 200+ locations
    └────────┘ └────────┘ └────────┘
         ↑          ↑          ↑
     Users in    Users in   Users in
      Japan      Europe      India
```

### Real-World Examples

**Example 1: Netflix — CDN as the Core Product**

Netflix built its own CDN called Open Connect. They place custom servers (Open Connect Appliances — OCAs) directly inside ISP networks. During off-peak hours, Netflix pre-positions popular content on these local servers. When you watch a show, the video streams from a server literally inside your ISP's building — maybe 1 mile away instead of 1,000. Netflix serves over 100 million hours of video per day this way. By embedding in ISPs, they reduced bandwidth costs and latency simultaneously. Netflix's CDN handles ~95% of all their traffic.

**Example 2: Cloudflare — CDN Plus Security**

Cloudflare is a CDN that also acts as a security layer (callback to Chapter 9: DNS). When you put your website behind Cloudflare, it caches static content at 310+ edge locations, but also: absorbs DDoS attacks (they've mitigated attacks over 7 Tbps), blocks malicious bots, provides a WAF (Web Application Firewall), and offers SSL certificates. Many websites use Cloudflare not primarily for speed but for protection — the CDN is a bonus.

### When To Use / When NOT To Use

| Use a CDN When | CDN Won't Help When |
|---|---|
| You serve static content globally (images, CSS, JS, videos) | Content is highly personalized per-user (can't cache one-off responses) |
| You need to reduce origin server load and bandwidth costs | Your users are all in one region near your server |
| You want DDoS protection and edge security | Content changes every second (real-time dynamic data) |
| Low latency matters for user experience | Data is private/sensitive and can't be cached on third-party servers |

### Q&A

**Q: If a CDN is basically a cache, how is it different from Redis?**
A: Scale and location. Redis is one or a few servers in YOUR data center — it caches data to reduce database load. A CDN is hundreds of servers spread across the WORLD — it caches content to reduce network latency. Redis handles key-value lookups. CDNs handle HTTP requests for files. Use Redis for API responses and database query results. Use CDN for images, videos, CSS, JavaScript, and HTML pages.

**Q: My website has dynamic content (user dashboard, personalized feed). Can I still use a CDN?**
A: Partially. Cache static assets (CSS, JS, images, fonts) on the CDN — these are the same for every user and represent most of the page weight. For dynamic HTML, you can use edge computing (Cloudflare Workers, AWS Lambda@Edge) to generate personalized content at the edge server instead of your origin. Or use "stale-while-revalidate" headers: serve the cached version immediately while fetching a fresh version in the background.

**Q: We cached content at the CDN with a 24-hour TTL. We just deployed a critical bug fix to our JavaScript file. Users are still getting the old, buggy version. How do we force a refresh?**
A: Cache busting. Change the URL: instead of `/app.js`, deploy as `/app.v2.3.1.js` or `/app.js?hash=abc123`. The CDN treats this as a new resource and fetches the updated file from your origin. Most build tools (Webpack, Vite) do this automatically by appending a content hash to filenames. Alternatively, send a cache purge/invalidation request to the CDN to forcibly clear `/app.js` from all edges — but this can take minutes to propagate to all 200+ locations.

**Q: You're building a photo-sharing app with 10 million global users. How does CDN fit into your architecture?**
A: Photos are the perfect CDN use case: large files, read-heavy, static after upload. When a user uploads a photo, store the original in S3 (object storage — Chapter 20). Generate thumbnails (small, medium, large). Push thumbnails to the CDN. When a user's feed loads, image URLs point to the CDN (cdn.yourapp.com/photos/abc123_thumb.jpg). The CDN serves from the nearest edge. Your origin S3 only gets hit for cache misses (rare for popular photos). For unpopular photos (long-tail), the CDN fetches on-demand and caches. Your bandwidth bill drops by 80-90% compared to serving directly from S3.

**Q: Netflix has its own CDN. Should my company build one too?**
A: Almost certainly not. Netflix built Open Connect because they're 30%+ of internet traffic and the economics of embedding in ISPs make sense at that scale. For everyone else, use a commercial CDN (Cloudflare, AWS CloudFront, Fastly, Akamai). They've already built the global network, negotiated peering agreements, and handle DDoS protection. Building your own CDN is like building your own power plant — only do it if you're an electricity company.

---

## Chapter 18: Message Queues

**One-liner:** A message queue is a buffer that lets services send work to each other without waiting — the sender drops a message, the receiver picks it up when ready.

**Why you should care:** A user uploads a video. Your server needs to: (1) store the original, (2) transcode it to 5 resolutions, (3) generate thumbnails, (4) scan for inappropriate content, (5) update the search index. Steps 2-5 take 5 minutes. Do you make the user wait 5 minutes staring at a spinner? No. You put the video in a message queue and return "Upload successful! Your video will be ready shortly." Background workers pick up the job and process it. The user moves on. The work still gets done. That's the power of async processing.

**Prerequisites:** Chapters 2 and 3 (Scalability, Availability)

### The Simple Version

Think about a restaurant kitchen. The waiter doesn't walk into the kitchen and stand there while the chef cooks. They write the order on a ticket and clip it to the order wheel. The chef grabs tickets and cooks at their own pace. If 20 orders come in at once, the tickets queue up — the kitchen isn't overwhelmed, just busy.

The order wheel is the message queue. The waiter is the producer (sends messages). The chef is the consumer (processes messages). The ticket is the message. If the chef goes on break, tickets accumulate but nothing is lost — they'll be processed when the chef comes back.

### How It Actually Works

**Two messaging patterns:**

| Pattern | How It Works | Use Case |
|---|---|---|
| Point-to-point (Queue) | One message → one consumer. Once processed, it's gone. | Task distribution (one worker per task) |
| Pub/Sub (Topic) | One message → all subscribers. Every subscriber gets a copy. | Event broadcasting (multiple services react) |

```
Point-to-Point Queue                  Pub/Sub Topic
━━━━━━━━━━━━━━━━━━━                  ━━━━━━━━━━━━━━

  Producer                             Producer
     │                                    │
     ▼                                    ▼
  ┌──────┐                            ┌──────┐
  │Queue │  msg1, msg2, msg3           │Topic │  msg published
  └──┬───┘                            └──┬───┘
     │                                   │
     │ (each msg to ONE consumer)        ├──→ Subscriber 1 (gets msg)
     ▼                                   ├──→ Subscriber 2 (gets msg)
  Worker 1 gets msg1                     └──→ Subscriber 3 (gets msg)
  Worker 2 gets msg2
  Worker 3 gets msg3                   All subscribers get ALL messages
```

**Common tools:**

| Tool | Type | Throughput | Best For |
|---|---|---|---|
| RabbitMQ | Traditional queue | ~50K msgs/sec | Task queues, request-reply, routing |
| Apache Kafka | Distributed log | ~1M+ msgs/sec | Event streaming, log aggregation, data pipelines |
| AWS SQS | Managed queue | ~3K msgs/sec (per queue) | Simple task queues, serverless integrations |
| Redis Streams | Lightweight stream | ~100K msgs/sec | Simple pub/sub, when you already use Redis |

**Kafka vs RabbitMQ — the most common comparison:**

| | Kafka | RabbitMQ |
|---|---|---|
| Model | Append-only log (messages persist after consumption) | Traditional queue (messages deleted after consumption) |
| Throughput | 1M+ messages/sec | ~50K messages/sec |
| Replay | Yes — consumers can re-read old messages | No — once consumed, it's gone |
| Ordering | Guaranteed within a partition | Guaranteed within a queue |
| Best for | Event streaming, data pipelines, audit logs | Task distribution, request-reply |

### Real-World Examples

**Example 1: Uber — Kafka as the Nervous System**

Uber processes trillions of messages per day through Apache Kafka. Every event in Uber's ecosystem flows through Kafka: ride requests, driver locations, trip updates, payment events, analytics events. When you request a ride, the matching service publishes a "ride_requested" event to Kafka. The pricing service, ETA service, driver notification service, and analytics pipeline all subscribe to this topic. Each processes the event independently, at their own pace. If the analytics pipeline falls behind, it doesn't slow down the matching service — Kafka buffers the messages. Uber's Kafka cluster reportedly handles over 7 million messages per second at peak.

**Example 2: Shopify — Message Queues for Resilient Checkouts**

During Black Friday/Cyber Monday, Shopify processes millions of checkouts. If every checkout had to synchronously update inventory, process payment, send confirmation email, update analytics, and notify the merchant — a single slow service would cascade into checkout failures. Instead, Shopify uses message queues: the checkout service places an order and publishes an "order_placed" event. Payment processing, inventory updates, email notifications, and analytics each consume from the queue independently. If the email service is slow, checkouts don't wait — the email gets sent when the service catches up.

### When To Use / When NOT To Use

| Use Message Queues When | Don't Use When |
|---|---|
| Processing is slow and the user shouldn't wait (video transcoding, email, report generation) | You need a synchronous response (user needs the result RIGHT NOW) |
| You need to decouple services (producer doesn't need to know about consumers) | The overhead of queue infrastructure exceeds the benefit (simple 2-service app) |
| Traffic is bursty (queue buffers spikes, workers process at steady rate) | You need request-reply semantics with low latency (use HTTP/gRPC instead) |
| You need reliable delivery (queue persists messages until confirmed processed) | Message ordering isn't important and fire-and-forget is acceptable (use simple HTTP webhooks) |

### Q&A

**Q: If a worker picks up a message and crashes mid-processing, is the message lost?**
A: Not if you use acknowledgements correctly. The pattern: (1) Worker picks message from queue (message becomes "in-flight" but not deleted). (2) Worker processes it. (3) Worker sends ACK to queue ("I'm done"). (4) Queue deletes the message. If the worker crashes before sending ACK, the queue re-delivers the message to another worker after a timeout. The message is never lost. But it might be processed twice — which is why idempotency (Chapter 27) matters.

**Q: We said Kafka is an "append-only log." How is that different from a database?**
A: Kafka appends messages sequentially and consumers read forward from their position (called an "offset"). It's not a database — you can't query "find all messages where userId=123." You read messages in order, one after another. The advantage: sequential writes are extremely fast (Kafka can write 1M+ messages/sec because it just appends). And messages persist — consumers can re-read old messages by resetting their offset. This makes Kafka ideal for event sourcing, audit logs, and data pipelines where you need a replayable history.

**Q: How do message queues help with scaling?**
A: They decouple production rate from consumption rate. If your web servers receive 10,000 requests/second during a spike, they can enqueue 10,000 messages instantly. Your workers process them at a steady 2,000/second. The queue absorbs the spike — no dropped requests, no overloaded workers. When the spike ends, workers catch up. Without a queue, you'd need to scale workers to handle peak (10,000/sec) even though average is 2,000 — expensive and wasteful.

**Q: You're building a food delivery app. When an order is placed, you need to: charge payment, notify the restaurant, assign a driver, and send the customer a confirmation. Which of these should go through a queue?**
A: Payment — synchronous (the user needs to know if it succeeded before confirming the order). Restaurant notification, driver assignment, and customer confirmation — asynchronous via queue. If the restaurant's notification system is slow, it shouldn't block the order. If driver assignment takes 30 seconds, the user sees "Finding your driver..." while the matching service works in the background. The confirmation email can be sent seconds later. Queue-based design means one slow downstream service doesn't cascade into a failed order.

**Q: Your Kafka consumer falls behind — messages are piling up faster than it can process them. What do you do?**
A: (1) Add more consumers. Kafka partitions allow parallel consumption — if your topic has 10 partitions, you can have up to 10 consumers in the same consumer group, each reading from different partitions. (2) Check if the consumer is doing too much work per message — can you batch process? (3) If the lag is temporary (a traffic spike), Kafka retains messages for days — the consumer will catch up when traffic drops. (4) If it's persistent, you need more partitions (requires topic reconfiguration) or faster processing (optimize the consumer code, or split into smaller processing steps with intermediate queues).

---

## Chapter 19: Rate Limiting

**One-liner:** Rate limiting controls how many requests a client can make in a given time period — protecting your servers from abuse and overload.

**Why you should care:** A single script kiddie writes a loop that hammers your login API 100,000 times per second, trying to brute-force passwords. Or a bug in a partner's integration code creates an infinite retry loop. Or a viral tweet sends 50x normal traffic to one endpoint. Without rate limiting, any of these kills your server. With rate limiting, you say "each client gets 100 requests per minute — exceeded that? Here's a 429 Too Many Requests." Your server stays healthy, legitimate users aren't affected, and the abuser is blocked.

**Prerequisites:** Chapters 10-11 (Load Balancers, API Gateway)

### The Simple Version

Highway on-ramp meters. During rush hour, traffic lights at highway entrances only let one car through every few seconds. This prevents the highway from gridlocking. Some cars wait a bit at the on-ramp, but the highway keeps flowing for everyone.

Rate limiting is that traffic light for your API. It lets requests through at a controlled rate, and excess requests either wait in line or get turned away. Some individual clients experience a small delay, but the overall system stays healthy.

### How It Actually Works

**Four common algorithms:**

| Algorithm | How It Works | Pros | Cons |
|---|---|---|---|
| Token Bucket | A bucket fills with tokens at a fixed rate. Each request costs a token. No tokens = rejected. | Allows bursts (up to bucket size), smooth rate limiting | Slightly more complex to implement |
| Leaky Bucket | Requests enter a queue (bucket) and are processed at a fixed rate. Overflow = rejected. | Perfectly smooth output rate | No burst capacity; slow for bursty workloads |
| Fixed Window | Count requests in fixed time windows (e.g., per minute). Reset count at window boundary. | Simple to implement | Burst at window boundaries (99 at 0:59, 99 at 1:00 = 198 in 2 seconds) |
| Sliding Window | Like fixed window, but the window slides with each request. Weighted average of current and previous window. | Smooth, no boundary bursts | Slightly more memory/computation |

```
Token Bucket Algorithm
━━━━━━━━━━━━━━━━━━━━━━

  Bucket capacity: 10 tokens
  Refill rate: 2 tokens/second

  ┌─────────────────┐
  │ 🪙🪙🪙🪙🪙🪙🪙🪙  │ ← 8 tokens available
  │                 │
  └─────────────────┘
        ↑                    ↑
    +2 tokens/sec      Request arrives:
    (refill)           Take 1 token → ALLOWED
                       0 tokens? → REJECTED (429)

  Burst: Client can use all 10 tokens instantly,
  then must wait for refill.
```

**Where to implement it:** Most commonly at the API gateway layer (Chapter 11). This means rate limiting happens before requests reach your backend services. Use Redis to store counters (shared across all API gateway instances).

### Real-World Examples

**Example 1: GitHub API — Rate Limiting as a Feature**

GitHub's API has clear rate limits: 5,000 requests per hour for authenticated users, 60/hour for unauthenticated. Every API response includes headers telling you your limit, remaining requests, and when the window resets: `X-RateLimit-Limit: 5000`, `X-RateLimit-Remaining: 4987`, `X-RateLimit-Reset: 1609459200`. This transparency lets developers build well-behaved integrations. GitHub uses a token bucket algorithm — you can burst up to your limit, but once exhausted, you wait for the refill.

**Example 2: Stripe — Tiered Rate Limits by Endpoint**

Stripe doesn't apply a single rate limit across all endpoints. Read endpoints (list charges, get balance) have higher limits than write endpoints (create charge, create refund). This makes sense: reads are cheap and cacheable; writes trigger real payment processing. Stripe also applies per-API-key limits AND per-IP limits — so a compromised API key can't take down the service, and a DDoS from a single IP is automatically blocked.

### When To Use / When NOT To Use

| Use Rate Limiting When | Considerations |
|---|---|
| Public APIs (protect from abuse, enforce usage tiers) | Set limits high enough that legitimate users aren't affected |
| Login/authentication endpoints (prevent brute-force) | Use exponential backoff + account lockout alongside rate limits |
| Any endpoint exposed to the internet | Implement at the gateway, not in each service |
| Protecting against accidental abuse (buggy client in infinite loop) | Return clear error messages with retry-after headers |

### Q&A

**Q: Where should rate limiting happen — at the load balancer, API gateway, or application level?**
A: API gateway (Chapter 11) is the best default. It's centralized, all traffic passes through it, and it can block bad requests before they consume backend resources. Use Redis as the backing store so all gateway instances share the same counters. Application-level rate limiting is a backup — it catches requests that slip through (internal service-to-service traffic, for example). Load balancer rate limiting exists but is usually too coarse (IP-based, can't distinguish between API keys).

**Q: If I rate-limit by IP address, what about users behind a corporate NAT or VPN who share one IP?**
A: You'll accidentally rate-limit legitimate users. Rate limit by API key or user token when possible — each user has their own quota regardless of IP. Use IP-based rate limiting as a secondary defense (for unauthenticated endpoints or DDoS protection), not as the primary mechanism. You can also use a combined approach: per-API-key limits for normal usage, per-IP limits as a safety net against massive abuse.

**Q: How do you rate-limit in a distributed system with multiple API gateway instances?**
A: Use a shared counter in Redis. When a request arrives at any gateway instance, it increments the counter for that client in Redis and checks if it exceeds the limit. Redis is fast enough (100K+ operations/sec) to handle this without becoming a bottleneck. If Redis itself goes down, fail open (allow requests through) rather than fail closed (block everything) — a few seconds without rate limiting is better than a complete outage.

**Q: You're building a public API. Your free tier allows 100 requests/minute, and your paid tier allows 10,000/minute. How do you implement this?**
A: At the API gateway, after authenticating the request (validating the API key), look up the user's tier. Apply the corresponding rate limit using a token bucket per API key stored in Redis. Key design: `rate_limit:{api_key}` → {tokens_remaining, last_refill_time}. On each request: refill tokens based on elapsed time, deduct one token. If tokens ≤ 0, return HTTP 429 with `Retry-After` header. For the paid tier, the bucket capacity is 10,000 and refill rate is ~167/second. For free tier: 100 capacity, ~1.67/second.

**Q: Your rate limiter uses a fixed window of 1 minute. A client sends 99 requests at 0:59 and 99 at 1:01 (within the 100/minute limit for each window). But that's 198 requests in 2 seconds. Is this a problem?**
A: Yes — this is the fixed window boundary burst problem. The client technically respects the per-minute limit but sends 2x the intended rate in a 2-second window. Fix: use a sliding window algorithm. It weighs the previous window's count proportionally. At 1:01 (1 second into the new window): estimated count = (previous window count × 59/60) + current window count = (99 × 0.98) + 99 ≈ 196 — which exceeds the 100 limit. Request denied. Sliding window prevents boundary gaming.

---

## Chapter 20: Object Storage

**One-liner:** Object storage is where you put large, unstructured files — images, videos, backups, logs — that don't belong in a database.

**Why you should care:** Your app lets users upload photos. You store them on the server's local disk. Works fine — until you add a second server. Now User A uploads a photo to Server 1, but their next request hits Server 2 (load balancer, remember?). The photo doesn't exist on Server 2. Your local filesystem just became a single point of failure AND a scalability bottleneck. Object storage is the solution: a separate, infinitely scalable storage service that all your servers can access. Store once, read from anywhere.

**Prerequisites:** Chapters 2, 3, and 17 (Scalability, Availability, CDN)

### The Simple Version

A regular database is like a filing cabinet with strict organization — every document goes in a labeled folder, in a specific drawer. Great for structured records.

Object storage is like a warehouse. You put a box in, slap a label on it (the key), and the warehouse handles the rest — where to put it, how to find it later, how to make sure it doesn't get lost. You don't care which shelf it's on. You just say "give me box abc-123" and the warehouse hands it back.

### How It Actually Works

Object storage treats each file as an "object" with three parts:
1. **Key** — A unique identifier (often the file path: `users/123/avatar.jpg`)
2. **Data** — The file contents (bytes)
3. **Metadata** — Information about the file (content type, size, upload time, custom tags)

```
Object Storage Model
━━━━━━━━━━━━━━━━━━━━

  PUT object:
    Key:      "photos/2024/sunset.jpg"
    Data:     [binary image data, 2.4 MB]
    Metadata: {content-type: "image/jpeg", uploaded-by: "user-456"}

  GET object:
    Request: "photos/2024/sunset.jpg"
    Returns: [binary image data] + metadata

  No folders, no hierarchy — the "/" in the key is just a convention.
  Object storage is a flat key-value store for large blobs.
```

**AWS S3** is the dominant object storage service and the de facto standard. Other options: Google Cloud Storage, Azure Blob Storage, MinIO (self-hosted, S3-compatible).

| Feature | Typical Value (S3) |
|---|---|
| Durability | 99.999999999% (11 nines) — you'd lose 1 object out of 10 million every 10,000 years |
| Availability | 99.99% |
| Max object size | 5 TB |
| Cost (Standard) | ~$0.023/GB/month |
| Cost (Infrequent Access) | ~$0.0125/GB/month |
| Cost (Glacier/Archive) | ~$0.004/GB/month |

### Real-World Examples

**Example 1: Dropbox — S3 to Custom Storage and Back**

Dropbox started by storing all user files on Amazon S3. As they grew past 500 petabytes, S3 costs became astronomical. They built their own storage system called Magic Pocket, moving most data to their own hardware. This saved hundreds of millions of dollars per year. But they still use S3 for edge cases and as a backup target. Lesson: S3 is the right starting point for almost everyone. Only build your own when S3 costs exceed the cost of running your own storage infrastructure — which requires Google/Dropbox-scale data.

**Example 2: Airbnb — Object Storage for Millions of Listing Photos**

Airbnb hosts upload millions of property photos. Each listing can have 20-50 high-resolution images. Airbnb stores originals in S3, then generates multiple sizes (thumbnail, medium, large) via an image processing pipeline. The resized images are also stored in S3 and served through a CDN. Total storage: petabytes. Why not a database? Because a PostgreSQL row holding a 5 MB image bloats the database, kills backup performance, and wastes expensive database storage. S3 costs $0.023/GB; RDS storage costs $0.115/GB — 5x more.

### When To Use / When NOT To Use

| Use Object Storage When | Don't Use When |
|---|---|
| Files are large (images, videos, backups, logs) | Data is small and structured (user profiles, transactions) — use a database |
| Files are mostly read after writing (write-once, read-many) | You need frequent in-place updates to file contents — objects are immutable |
| You need durability (11 nines) at low cost | You need file system semantics (ls, mv, permissions) — use EFS/NFS or a real filesystem |
| Multiple services or servers need access to the same files | Sub-millisecond latency is required — object storage adds ~50-100ms per request |

### Q&A

**Q: Why can't I just store images as BLOBs in my PostgreSQL database?**
A: You can, but you shouldn't for most cases. Reasons: (1) Database backups become huge and slow. (2) Database storage is 3-5x more expensive than S3. (3) Serving images from a database ties up database connections. (4) Databases aren't optimized for streaming large binary files. (5) You can't put a CDN in front of database rows. Store the image in S3, store the S3 URL in the database. Best of both worlds.

**Q: What about file metadata — like who uploaded a file, what type it is, when it was created?**
A: Two options. (1) S3 metadata: each object can have custom metadata tags (up to 2 KB). Good for simple cases. (2) Database: store a row with {file_id, s3_key, uploader_id, content_type, size, created_at}. Better for complex queries ("find all images uploaded by user X in January"). Most apps use option 2 — the database is your index for finding objects in S3.

**Q: How do you handle file uploads in a distributed system? The file needs to get to S3, not to your web server.**
A: Pre-signed URLs. Your API generates a temporary, signed URL that gives the client permission to upload directly to S3. The client uploads the file to S3 without your server touching the file at all. Your server only receives a lightweight callback ("upload complete, file is at s3://bucket/key"). This eliminates your server as a bottleneck for uploads — even 10,000 concurrent uploads go directly to S3, which is built to handle them.

**Q: You're building a video platform. Users upload 500 MB videos. How do you handle upload failures mid-way?**
A: S3 multipart upload. The client splits the video into 10 MB chunks and uploads each chunk independently. If chunk 37 fails, only that chunk retries — not the entire 500 MB. Once all chunks are uploaded, a "complete multipart upload" call assembles them into a single object. This is critical for large files over unreliable connections (mobile networks). YouTube, Vimeo, and every major video platform use this pattern.

**Q: Object storage costs $0.023/GB/month, but you're storing 500 TB of logs that nobody looks at. How do you reduce costs?**
A: Storage tiers. Move old logs to cheaper storage: S3 Infrequent Access ($0.0125/GB — 46% cheaper), then to Glacier ($0.004/GB — 83% cheaper) after 90 days. Set up lifecycle policies to automate this: objects older than 30 days → IA, older than 90 → Glacier, older than 365 → delete. For 500 TB, this reduces costs from ~$11,500/month to ~$2,000/month. Most of your data is cold (rarely accessed) — don't pay hot storage prices for it.

---

## Chapter 21: Search Infrastructure

**One-liner:** Search infrastructure lets users find things across massive datasets in milliseconds — by pre-building an index that maps words to documents, instead of scanning everything on every query.

**Why you should care:** Your e-commerce site has 50 million products. A user types "wireless bluetooth headphones under $50." If you run `SELECT * FROM products WHERE name LIKE '%wireless%' AND name LIKE '%bluetooth%' AND name LIKE '%headphones%' AND price < 50` on a SQL database, you're scanning 50 million rows. Response time: 15 seconds. Users leave after 3. Elasticsearch returns the same results in 30 milliseconds. The difference is the data structure: an inverted index that maps each word to the documents containing it.

**Prerequisites:** Chapters 13 and 16 (Database Indexing, Caching)

### The Simple Version

Imagine you're in a library with 10 million books, and someone asks for "all books about World War II submarines." You could walk through every shelf and check every book's title. Or you could use the card catalog — a sorted list of subjects, each pointing to the exact books and their shelf locations.

A search engine's inverted index is that card catalog, but for every word in every book. It's built in advance, so when someone searches, the engine looks up the words in the index and instantly finds which documents contain them — without reading a single full document.

### How It Actually Works

**The inverted index:** maps each term (word) to a list of documents containing it.

```
Building an Inverted Index
━━━━━━━━━━━━━━━━━━━━━━━━━━

  Documents:
    Doc1: "Redis is a fast cache"
    Doc2: "Caching makes apps fast"
    Doc3: "Redis stores data in memory"

  Inverted Index:
    "redis"   → [Doc1, Doc3]
    "fast"    → [Doc1, Doc2]
    "cache"   → [Doc1]
    "caching" → [Doc2]
    "memory"  → [Doc3]
    "apps"    → [Doc2]
    ...

  Query: "fast redis"
    → "fast" = [Doc1, Doc2]
    → "redis" = [Doc1, Doc3]
    → Intersection = [Doc1] ← most relevant result
```

**How Elasticsearch works (the dominant search engine):**

1. **Index time:** Documents are analyzed (tokenized, lowercased, stemmed: "running" → "run") and added to the inverted index across multiple shards
2. **Query time:** The query is analyzed the same way. Each shard searches its local index. Results are merged, scored by relevance (TF-IDF or BM25), and returned
3. **Distributed:** The index is sharded across nodes (like database sharding). Each node searches its shard in parallel. Adding nodes = more capacity

| Feature | SQL LIKE Query | Elasticsearch |
|---|---|---|
| 50M document search | 10-30 seconds | 10-50 milliseconds |
| Typo tolerance | None | Built-in ("headphoens" → "headphones") |
| Relevance ranking | None (random order) | TF-IDF/BM25 scoring |
| Faceted filtering | Expensive GROUP BY | Built-in aggregations |

### Real-World Examples

**Example 1: Wikipedia — Elasticsearch for 60 Million Articles**

Wikipedia uses Elasticsearch (via the CirrusSearch extension) to power search across 60+ million articles in 300+ languages. When you type a query on Wikipedia, Elasticsearch: tokenizes your query, searches the inverted index, ranks results by relevance (article quality, link count, recency), and returns results in under 100ms. The index is sharded across multiple servers and replicated for fault tolerance. Without Elasticsearch, Wikipedia's search would fall back to slow SQL LIKE queries — unusable at their scale.

**Example 2: Uber — Elasticsearch for Real-Time Logging**

Uber ingests billions of log events per day and uses Elasticsearch (via the ELK stack: Elasticsearch, Logstash, Kibana) for real-time log search and analysis. When an engineer needs to debug why a ride failed in São Paulo at 3:42 PM, they query Elasticsearch with filters for timestamp, region, ride_id, and error type. Within seconds, they see the relevant log entries from dozens of services. Without search infrastructure, finding a specific error in billions of log lines would be like finding a needle in a haystack — manually.

### When To Use / When NOT To Use

| Use Search Infrastructure When | Don't Use When |
|---|---|
| Full-text search across large datasets (products, articles, logs) | Simple lookups by ID or exact match (use a database index) |
| You need fuzzy matching, typo tolerance, relevance ranking | Your dataset is small (< 100K records — SQL full-text search works fine) |
| Faceted navigation (filter by category, price range, brand + counts) | You need ACID transactions on the searchable data |
| Real-time log analysis and observability | The added infrastructure complexity isn't justified by the query patterns |

### Q&A

**Q: Why can't I just use my database's built-in search? PostgreSQL has full-text search.**
A: PostgreSQL's full-text search works well for moderate datasets (under a few million rows) and simple queries. But it falls behind Elasticsearch at scale: it doesn't shard the search index across nodes, it lacks built-in fuzzy matching and auto-suggest, and complex search queries compete with your transactional workload for database resources. For a small app, PostgreSQL full-text search is great — less infrastructure to manage. For a product catalog with 50 million items, you need dedicated search infrastructure.

**Q: If Elasticsearch is so fast for search, why not use it as my primary database?**
A: Because Elasticsearch is not a database. It's not ACID-compliant: writes can be lost during a crash (it acknowledges before flushing to disk by default). It doesn't support transactions. Updates are expensive (the entire document is re-indexed). Data integrity isn't guaranteed. Use Elasticsearch as a secondary index: write data to your primary database (PostgreSQL), then sync it to Elasticsearch (via a change data capture pipeline or application-level dual writes). Search hits Elasticsearch; everything else hits the database.

**Q: How do you keep Elasticsearch in sync with your database?**
A: Three approaches: (1) Dual write — your app writes to both the database and Elasticsearch. Simple but fragile (what if one write fails?). (2) Change Data Capture (CDC) — a tool like Debezium watches the database's write-ahead log and streams changes to Elasticsearch. Reliable but adds infrastructure. (3) Periodic batch sync — a job periodically reads changed records from the database and indexes them. Simple but introduces lag. CDC is the gold standard for production systems.

**Q: You're building a job search platform. Users search by title, location, skills, salary range, company, and experience level. How do you design the search?**
A: Elasticsearch is perfect here. Index each job listing as a document with all searchable fields. Use a mapping that analyzes text fields (title, skills) for full-text search and keeps numeric/keyword fields (salary, location, company) for exact filtering. The query combines full-text match on title + filters on location/salary/experience + faceted counts for the sidebar ("42 remote jobs, 18 in New York"). Elasticsearch handles all of this in one query. Back the data with PostgreSQL for ACID (job postings, applications, payments), and sync to Elasticsearch via CDC.

**Q: Your Elasticsearch cluster has 10 shards, but searches are getting slower as data grows. What's happening?**
A: Each search query hits all 10 shards, each shard must search, score, and return results, and the coordinating node must merge them. As data per shard grows, each shard takes longer. Solutions: (1) Add more shards to reduce data per shard (but more shards = more merge overhead). (2) Add replicas — searches are distributed across replicas, increasing parallel capacity. (3) Use time-based indexes for time-series data (logs): search only the last 7 days' index instead of all-time. (4) Optimize the mapping — use `keyword` type for fields you filter on (exact match), not `text` (full-text analysis). (5) Cache frequent queries using Elasticsearch's built-in query cache.

---

## Putting It Together: Tracing a Request Through an E-Commerce System

*You know the building blocks. Now watch them work together. We'll trace what happens when a user types "amazon.com," searches for "wireless headphones," and loads a product page.*

### Step 1: DNS Resolution (Chapter 9)

User types "amazon.com." Their browser asks DNS for the IP address. Route 53 (Amazon's DNS) uses geo-routing to return the IP of the nearest CDN edge server. Time: ~10ms.

### Step 2: CDN Edge (Chapter 17)

The browser connects to the CDN edge server. Static assets (HTML shell, CSS, JavaScript, logo) are served from the edge cache. Time: ~5ms.

### Step 3: Load Balancer (Chapter 10)

The JavaScript app makes an API call to `api.amazon.com`. This hits an Application Load Balancer (L7) that routes the request to a healthy API server using least-connections algorithm.

### Step 4: API Gateway (Chapter 11)

The request passes through the API Gateway, which: validates the user's session token, applies rate limiting (100 requests/minute for this user tier), logs the request, and routes `/api/search` to the Search Service.

### Step 5: Search (Chapter 21)

The Search Service sends the query "wireless headphones" to Elasticsearch. The inverted index finds matching products in ~30ms across sharded indexes. Results are ranked by relevance, filtered by availability, and returned.

### Step 6: Cache Check (Chapter 16)

Before hitting the database for product details, the service checks Redis. The top 20 search results for "wireless headphones" are a hot query — cache hit rate is 95%. Cached product data returned in ~1ms.

### Step 7: Database (Chapters 12-15)

For cache misses, the service queries PostgreSQL. The product table is indexed on product_id (B-tree). The query hits a read replica (not the primary — saves write capacity). If the product data is sharded, the request is routed to the correct shard based on product_id.

### Step 8: Product Images (Chapters 17, 20)

Product images are stored in S3 (Object Storage) and served through the CDN. The product page HTML references `cdn.amazon.com/images/headphones-123.jpg`. The CDN serves it from the nearest edge. Origin S3 is hit only on cache misses.

### Step 9: Rate Limiting (Chapter 19)

Throughout this flow, the API Gateway enforces rate limits per user and per IP. If a bot is scraping product pages at 1,000 requests/second, it gets 429 responses after exceeding the limit. Legitimate users are unaffected.

```
Full Request Flow
━━━━━━━━━━━━━━━━━

  User (Tokyo)
    │
    ├─1→ DNS (Route 53) → nearest CDN IP
    │
    ├─2→ CDN Edge (Tokyo) → static assets (CSS, JS, images)
    │
    ├─3→ Load Balancer → healthy API server
    │
    ├─4→ API Gateway → auth, rate limit, route to service
    │
    ├─5→ Search Service → Elasticsearch → ranked results
    │
    ├─6→ Cache (Redis) → product details (95% hit)
    │
    ├─7→ Database (PostgreSQL replica) → cache misses
    │
    └─8→ CDN → S3 → product images

  Total time: ~200-400ms for a fully rendered product page
  Without these building blocks: 3-10 seconds
```

**Key insight:** No single building block makes this system work. It's the combination — DNS routes globally, CDN caches at the edge, the load balancer distributes traffic, the gateway handles cross-cutting concerns, search indexes make queries fast, the cache prevents database overload, replication handles read scale, and object storage handles media. Each concept from Part 2 has a specific job, and together they serve millions of users.

---

*Part 2 complete. You now have the building blocks: DNS, load balancers, API gateways, databases (SQL/NoSQL), indexing, replication, sharding, caching, CDNs, message queues, rate limiting, object storage, and search. Next up: Part 3 — Patterns & Architecture. How to wire these blocks together using proven patterns.*
