# Part 0: Jargon Buster

*Every term the book throws at you, in plain English. Each entry is: what it means, an everyday picture, and why you should care. Skim it first, or jump back whenever a word feels foreign.*

---

## Jargon 1: Servers & Scaling

### Server, servers
A computer that waits for requests and answers them. *Think of a waiter: customers (clients) ask, the waiter brings back an answer.* Your app is usually many servers, not one.

### Stateless server, stateless
A server that remembers nothing between requests. Every request carries everything the server needs (who you are, what you want). *A vending machine: it doesn't remember you came yesterday.* Why it matters: any stateless server can answer any request, so you can add or remove servers freely and a crash loses nothing.

### Stateful server, stateful
A server that remembers things between requests (your login session, your shopping cart in its own memory). *A waiter who remembers your order.* Harder to scale, because your next request must reach that same server, or the memory is lost if it dies. The usual fix is to push the memory out to a shared store such as Redis, making the servers stateless.

### Horizontal scaling (scale out)
Handling more load by adding more machines. *Opening more checkout lanes.* Nearly unlimited, but your software must work across many machines.

### Vertical scaling (scale up)
Handling more load by buying a bigger machine (more CPU, RAM). *Hiring one superhuman cashier.* Simple, but there is a ceiling and the price climbs steeply.

### Load balancer, load balancing, load balanced
A traffic director that spreads incoming requests over many servers. *A restaurant host seating guests across waiters.* It also notices dead servers and stops sending them traffic.

### Reverse proxy
A server that sits in front of your real servers and talks to the internet on their behalf. *A receptionist: visitors never meet the staff directly.* Used for load balancing, caching, TLS, and hiding internal servers.

### API gateway
A reverse proxy specialised for APIs: the single front door that handles login checks, rate limits, and routing to the right backend service.

### Failover
Automatically switching to a standby when the main component dies. *The spare tyre.* Good failover is invisible to users.

### Single point of failure (SPOF)
Any one component whose death takes down the whole system. *One bridge into town.* Fixed by redundancy (a second bridge).

### Monolith vs microservices
Monolith: the whole app is one deployable program. Microservices: many small programs, each owning one job (payments, search), talking over the network. Microservices let teams ship independently but add network failures and complexity.

### Container / Docker
A sealed box that holds your program plus everything it needs to run, so it behaves identically on any machine. *A shipping container.* Docker is the best-known tool.

### Kubernetes
Software that runs and babysits thousands of containers: restarts crashed ones, adds more under load, spreads them over machines. *An air-traffic controller for containers.*

### Serverless
You hand over a function and the cloud runs it on demand, billing per execution, with no servers for you to manage (they still exist, you just don't see them). *A taxi instead of owning a car.*

### Region and availability zone (AZ)
A region is a geographic area of cloud data centres (e.g. "us-east"). An AZ is one separate data centre (or group) inside it. Spreading across AZs survives a building fire; spreading across regions survives a regional outage.

---

## Jargon 2: Measuring & Surviving Trouble

### Latency
How long one request takes, start to finish. *Time from ordering to food arriving.* Measured in milliseconds.

### Throughput
How many requests the system handles per unit time. *Meals the kitchen serves per hour.* Low latency and high throughput are different goals.

### Bandwidth
How much data the pipe carries per second. *The width of the motorway.* Not the same as speed (latency).

### QPS / RPS
Queries (or requests) per second, the standard way to say how busy a system is.

### Percentiles: p50, p95, p99
p99 latency = the time that 99% of requests beat; the slowest 1% are worse. Averages hide pain; p99 shows what unlucky users feel. If a page makes 100 calls, almost every page load hits some p99.

### SLI, SLO, SLA
SLI: a measured number ("99.95% of requests succeeded"). SLO: your internal target for it ("we aim for 99.9%"). SLA: a promise to customers with consequences, usually refunds, if missed. Measurement, goal, contract.

### Availability and "nines"
The fraction of time the system works. 99.9% ("three nines") allows about 8.8 hours of downtime a year; 99.99% allows about 53 minutes.

### Timeout, timeouts, time out
A deadline after which you give up waiting. Without one, a single slow dependency can pile up threads and freeze your whole service.

### Retry, retries, exponential backoff, backoff, jitter
Retry: try again after a failure. Backoff: wait longer each time (1s, 2s, 4s…) so you don't hammer a struggling server. Jitter: add randomness so thousands of clients don't all retry at the same instant.

### Idempotent, idempotency
Doing it twice has the same effect as doing it once. *Pressing the lift button repeatedly.* Essential for safe retries: "set balance to 50" is idempotent, "add 10" is not unless you attach a unique request ID.

### Circuit breaker
After repeated failures calling a service, stop calling it for a while and fail fast. *A fuse that trips so the house doesn't burn.* Gives the broken service time to recover.

### Rate limiting / token bucket
Capping how many requests a user can make. Token bucket: a bucket refills with tokens at a steady rate; each request spends one; empty bucket means "slow down" (HTTP 429).

### Thundering herd
A huge crowd hitting the same thing at once, typically when a cache entry expires and thousands of requests all hit the database together. *Doors open on Black Friday.*

### Fan-out
One event triggering many downstream actions. Posting a tweet that must reach 10 million followers' timelines is fan-out.

### Heartbeat
A small "I'm alive" message sent regularly. If heartbeats stop, others assume the sender died.

### Observability, logs, metrics, tracing
Your ability to see inside a running system. Logs: diary entries. Metrics: numbers over time. Tracing: following one request across all the services it touched.

### Canary and blue-green deploys
Canary: release to 1% of users first and watch for trouble. Blue-green: run old and new versions side by side and flip traffic over, with instant rollback.

### Chaos engineering
Deliberately breaking things in production (kill a server, drop the network) to prove the system survives.

---

## Jargon 3: Databases & Storage

### SQL / relational database
Data in tables with rows and columns, linked by keys, queried with SQL. *A set of spreadsheets that reference each other.* Examples: PostgreSQL, MySQL. Strong guarantees, flexible queries.

### NoSQL
A family of databases that drop the table model for scale or flexibility: key-value (DynamoDB, Redis), document (MongoDB), wide-column (Cassandra), graph. You trade query flexibility for scale and speed.

### PostgreSQL / MySQL
The two most popular open-source relational databases. Reliable defaults for most apps.

### MongoDB
A document database: stores JSON-like documents rather than table rows. Good when records have varying shapes.

### Cassandra
A NoSQL database built to spread data over many machines with no single leader and to accept very high write rates. Great for write-heavy, always-on workloads.

### DynamoDB
Amazon's managed key-value / document database. You pick a key; it scales almost without limit and answers in single-digit milliseconds.

### Transaction, transactions
A bundle of operations that either all happen or none do. *Moving money: debit and credit together or not at all.*

### ACID
The four promises of a classic transaction. Atomicity: all or nothing. Consistency: rules stay valid. Isolation: concurrent transactions don't see each other's half-done work. Durability: once committed, it survives a crash.

### Index, indexes, indexing, indices
A sorted lookup structure that lets the database find rows without scanning everything. *The index at the back of a book.* Speeds up reads, slows writes slightly, and uses extra space.

### B-tree
The usual structure behind database indexes: a shallow, wide, sorted tree so a lookup touches only a few disk pages.

### Inverted index
Maps each word to the documents containing it. *The back-of-book index, word to page numbers.* The core of full-text search (Elasticsearch).

### Schema
The agreed shape of your data: which fields exist and what types they have. "Schema-less" means the database doesn't enforce it.

### Join
Combining rows from two tables on a shared key ("orders joined with customers"). Easy on one database, painful once data is sharded across machines.

### ORM
Object-Relational Mapper: a library that lets your code treat database rows as objects instead of writing SQL by hand. Convenient, but can generate slow queries.

### OLTP vs OLAP
OLTP: many small, fast transactions (place an order). OLAP: few huge analytical queries over lots of history (sales by region for five years). They are usually separate systems.

### Data warehouse
A database designed for analytics over huge history, fed from your operational databases.

### Write-ahead log (WAL)
Before changing data, the database first appends the change to a log file. After a crash it replays the log. *A diary written before acting.*

### Object storage (S3) and blob
Storage for big files (photos, videos, backups) addressed by name, not folders and blocks. S3 is Amazon's version. A "blob" is just a big opaque chunk of bytes. Cheap, durable, not for small frequent updates.

### Bloom filter
A tiny structure that answers "is this item definitely not here?" instantly, with a small chance of false "maybe". Lets a database skip pointless disk reads.

### Serialization, JSON, Protobuf, Avro
Serialization turns in-memory data into bytes to send or store. JSON: human-readable text. Protobuf and Avro: compact binary formats that are smaller and faster but not readable by eye.

### Hashing
Turning any input into a fixed-size scrambled number. Same input always gives the same output. Used to pick a shard, check integrity, or store passwords. SHA-256 is a common cryptographic hash.

### UUID, Snowflake ID, Base62
Ways to make unique IDs without a central counter. UUID: a huge random number. Snowflake: time + machine ID + counter, so IDs sort by time. Base62: shortening a number using 0-9, a-z, A-Z (how short URLs are made).

---

## Jargon 4: Copying & Splitting Data

### Replication, replica, replicate, replicated
Keeping copies of the same data on several machines. Each copy is a replica. Protects against loss and spreads read traffic.

### Leader and follower (primary / secondary)
In replication, the leader accepts writes; followers copy them and serve reads. *The head chef writes the recipe, line cooks copy it.* If the leader dies, a follower is promoted.

### Read replica
A follower used only to answer reads. Add more to scale read-heavy apps. Catch: it can lag, so you may read slightly old data.

### Replication lag
The delay before a follower catches up with the leader. Causes "I just posted it, why can't I see it?" bugs.

### Synchronous vs asynchronous replication
Synchronous: the leader waits for followers to confirm before saying "done". Safe but slower. Asynchronous: the leader answers immediately and followers catch up later. Fast but a crash can lose recent writes.

### Sharding, sharded, shard, partitioning, partition, partitions
Splitting one big dataset across machines, each holding a slice. *Dividing a dictionary into volumes A-F, G-M…* Scales writes and storage. A "partition" in this book usually means a data slice; in network contexts it means a broken link, so read carefully.

### Shard key
The field that decides which shard a row lives on (e.g. user ID). A poor key creates a hot spot.

### Hot spot / hot key
One shard or key receiving a disproportionate load (a celebrity's profile). It becomes the bottleneck no matter how many machines you add.

### Consistent hashing / hash ring / virtual node
A way to assign data to machines so that adding or removing a machine only moves a small fraction of data. Machines sit on a ring; data goes to the next machine clockwise. Virtual nodes give each machine many ring positions so load stays even.

### Quorum
A majority vote. With 3 replicas, 2 must agree. Reading and writing to overlapping majorities guarantees you see the latest write.

### Split brain
After a network break, two parts of the cluster each think they're the leader and accept conflicting writes. *Two captains steering one ship.*

### Fencing token
An ever-increasing number given to each new leader; storage rejects anything carrying an older token, so a stale leader can't do damage.

### Lease
A time-limited lock or permission ("you're leader for the next 10 seconds, renew or lose it"). Expires on its own if the holder dies.

### Failure detection / gossip
Gossip: nodes periodically chat with random peers to spread news about who is alive. Scales better than everyone pinging everyone.

---

## Jargon 5: Caching & Delivery

### Cache, caching, cached, cache hit, cache miss
A small, fast copy of data you read often, placed closer to the user. *Keeping your keys by the door instead of in the safe.* Cache hit: found it. Cache miss: not there, go to the slow source.

### TTL (time to live)
How long a cached item or DNS answer is considered fresh before it expires.

### Eviction / LRU
When the cache is full, something must go. LRU (least recently used) throws out whatever hasn't been touched for the longest.

### Cache-aside, write-through, write-back
Cache-aside: app checks the cache, on a miss reads the database and fills the cache. Write-through: every write goes to cache and database together. Write-back: write to cache now, database later (fast, but risks loss).

### Redis
A very fast in-memory data store used as a cache, session store, queue, and counter. Data lives in RAM, so reads take microseconds. Can persist to disk but is mainly used for speed.

### Memcached
A simpler in-memory cache than Redis: just keys and values, no fancy data types.

### CDN (content delivery network)
Servers all over the world holding copies of your static files (images, video, scripts), so users fetch from a nearby one. *Local warehouses instead of one central factory.*

### Edge
The servers closest to the user, at the "edge" of the network. "Edge caching" means serving from them.

### DNS
The internet's phone book: turns a name like google.com into an IP address. Answers are cached and carry a TTL.

---

## Jargon 6: Messaging & Architecture Patterns

### Message queue
A line where one service drops a job and another picks it up later. *A restaurant ticket rail.* Decouples producers from consumers and absorbs spikes. RabbitMQ and SQS are examples.

### Pub/sub
Publishers broadcast to a topic; every subscriber gets a copy. *A newsletter.* Contrast with a queue, where each message goes to one worker.

### Kafka
A distributed, durable, append-only log of events that many consumers can read at their own pace and replay. Built for huge streams, not just simple queues.

### Producer, consumer, consumer group
Producer writes messages, consumer reads them. A consumer group splits a topic among its members so each message is handled by one member of the group.

### Dead-letter queue
Where messages that keep failing go, so one bad message doesn't block the line.

### Backpressure
A slow consumer signalling "stop sending so fast" instead of being drowned.

### Webhook
A reverse API call: instead of you polling, the other service calls your URL when something happens.

### WebSocket
A connection that stays open so server and browser can push messages both ways instantly. Used for chat and live dashboards. Plain HTTP is request-then-response only.

### Event sourcing
Store every change as an immutable event ("deposited 50") rather than only the current balance; the state is the replay of events. Gives a complete audit trail.

### CQRS
Command Query Responsibility Segregation: use one model for writes and a separate, read-optimised one for queries.

### Saga
A long business operation split into local steps, each with an "undo" step if a later one fails. The alternative to distributed transactions.

### Two-phase commit (2PC)
A coordinator asks everyone "can you commit?"; if all say yes, it says "commit". Atomic across machines, but blocks if the coordinator dies.

### Change data capture (CDC) / Debezium
Reading the database's own change log to stream every change to other systems. Debezium is a popular tool for it.

### Eventual vs strong consistency
Strong: after a write, everyone sees it immediately. Eventual: replicas may disagree briefly but converge if writes stop.

### CAP theorem and PACELC
CAP: during a network partition you must choose between consistency and availability. PACELC adds: even with no partition, you trade latency against consistency.

### Consensus, Paxos, Raft
Consensus: getting several machines to agree on one value despite failures. Paxos and Raft are the algorithms that do it; Raft is the easier one to understand.

### ZooKeeper and etcd
Small, strongly consistent coordination services that hold config, locks, and "who's the leader". Built on consensus; other systems lean on them.

### CRDT
Conflict-free Replicated Data Type: data structures designed so concurrent edits on different replicas merge automatically without conflict. Used in collaborative editors.

---

## Jargon 7: Networking Basics

### IP address
A machine's numeric address on a network (like 142.250.80.46). *A street address.*

### Packet
A small chunk of data sent over a network; big messages are split into many packets.

### TCP vs UDP
TCP: reliable and ordered, resends lost packets (web pages, databases). UDP: fire and forget, no guarantees but faster (video calls, games, DNS).

### HTTP / HTTPS / TLS
HTTP: the request-response language of the web. TLS: encryption that stops eavesdropping. HTTPS = HTTP over TLS.

### Socket
One endpoint of a network connection; a program opens a socket to talk to another machine.

### Connection pool
A set of pre-opened connections reused across requests, since opening a new connection each time is slow.

### NAT
Network Address Translation: lets many devices share one public IP address. *A company switchboard.*

### REST, GraphQL, gRPC, RPC
Ways to design APIs. REST: URLs and standard verbs (GET, POST). GraphQL: the client asks for exactly the fields it wants. RPC: call a remote function as if local; gRPC is Google's fast binary RPC.

### Proxy
A middleman server. A forward proxy represents clients; a reverse proxy represents servers.

### Encryption
Scrambling data so only holders of the key can read it. "At rest" = stored; "in transit" = moving over the network.
