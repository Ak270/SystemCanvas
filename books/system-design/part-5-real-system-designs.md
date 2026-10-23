# Part 5: Real System Designs — The Practice

*This is where everything clicks. Each design in this part exercises 5+ concepts from Parts 1-4. These aren't toy examples — they're the actual systems that serve billions of users, built from the same building blocks and patterns you've learned. Each one follows the structure an interviewer expects: requirements, estimation, architecture, deep dive, trade-offs, and failure scenarios.*

---

## Design 1: WhatsApp

### Requirements

**Functional:**
- One-on-one messaging (text, images, videos)
- Group messaging (up to 256 members)
- Online/offline presence (last seen)
- Message delivery receipts (sent, delivered, read)
- End-to-end encryption

**Non-functional:**
- Very low latency (< 200ms message delivery)
- High availability (99.99% — people rely on this for daily communication)
- Messages must not be lost (durability)
- Support 2 billion users, 100 billion messages/day

### Capacity Estimation

```
Users: 2 billion total, 500 million DAU
Messages: 100 billion/day = ~1.15 million messages/sec
Average message size: 100 bytes text, 200KB media
Storage: 100B × 100 bytes = 10 TB text/day
         20% media messages × 200KB = ~4 PB media/day
Connections: 500M concurrent WebSocket connections
Bandwidth: ~1.15M msg/sec × 100 bytes = ~115 MB/sec (text only)
```

### High-Level Architecture

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│  Mobile   │────→│   Gateway    │────→│   Chat       │
│  Client   │←───│   (WebSocket)│←───│   Service    │
└──────────┘     └──────────────┘     └──────┬───────┘
                                            │
                 ┌──────────────┐     ┌──────┴───────┐
                 │  Presence    │     │  Message     │
                 │  Service     │     │  Store       │
                 └──────────────┘     │  (Cassandra) │
                                      └──────────────┘
                 ┌──────────────┐     ┌──────────────┐
                 │  Media       │     │  Push        │
                 │  Store (S3)  │     │  Notification│
                 └──────────────┘     └──────────────┘
```

### Key Components Deep Dive

**1. Connection Gateway (WebSockets — Chapter 29)**

Each user maintains a persistent WebSocket connection to a gateway server. With 500M concurrent connections and ~60K connections per server, you need ~8,000 gateway servers. The gateway maps `userId → serverId` in a distributed hash table (Redis). When User A sends a message to User B, the Chat Service looks up which gateway server holds B's connection and pushes the message there.

**2. Message Flow**

```
A sends "Hey!" to B:
1. A's client → WebSocket → Gateway Server 1
2. Gateway 1 → Chat Service → validate, encrypt check
3. Chat Service → Message Store (Cassandra) → persist
4. Chat Service → lookup B's gateway → Gateway Server 47
5. Gateway 47 → WebSocket → B's client
6. B's client → ack → delivery receipt back to A

If B is OFFLINE:
3. Message stored in Cassandra
4. Push Notification → APNs/FCM → B's phone
5. When B comes online → sync all undelivered messages
```

**3. Message Store (Cassandra — Chapter 12, 15)**

Partition key: `recipient_userId`. All messages for a user are on the same partition, ordered by timestamp. This means "get all unread messages for user X" is a single, fast query. At WhatsApp's scale, Cassandra handles millions of writes/sec with eventual consistency — acceptable because messages are append-only and rarely updated.

**4. Presence & Last Seen**

Presence ("online" / "last seen 5 min ago") uses a heartbeat mechanism (Chapter 38). Clients send a heartbeat every 30 seconds. The Presence Service stores `userId → lastSeen` in Redis. "Online" = heartbeat within the last 30 seconds. WhatsApp deliberately chose a 30-second granularity to reduce infrastructure load — real-time presence for 2 billion users would require enormous resources.

### Database & Schema

```
Messages table (Cassandra):
  Partition key: recipient_user_id
  Clustering key: timestamp (DESC)
  Columns: message_id, sender_id, content (encrypted),
           media_url, status (sent/delivered/read)

User table:
  user_id (PK), phone_number, display_name,
  public_key, created_at

Group table:
  group_id (PK), group_name, members[], admin_id
```

### Key Trade-offs

| Decision | Trade-off |
|---|---|
| Cassandra over PostgreSQL | Horizontal scale + high write throughput vs. no joins, eventual consistency |
| WebSockets over polling | Real-time delivery vs. 500M persistent connections to manage |
| 30-second presence heartbeat | Infrastructure savings vs. less precise "last seen" |
| Encrypt end-to-end | Privacy vs. WhatsApp can't scan for spam server-side |

### What Could Go Wrong

- **Gateway server dies:** 60K users disconnect simultaneously. Clients reconnect to another gateway (auto-reconnect with backoff). Missed messages are synced from the message store.
- **Cassandra partition hotspot:** A celebrity with 1M contacts sends a message → 1M writes to different partitions simultaneously. Mitigate with write buffering and async fan-out.
- **Network partition between regions:** Users in different regions can't message each other. Solution: replicate messages to multiple regions; deliver when the partition heals.

### Q&A

**Q: How does end-to-end encryption work if the server can't read messages?**
A: The Signal Protocol. Each user has a public/private key pair. When A messages B, A encrypts with B's public key. Only B's private key can decrypt. The server stores encrypted blobs it can't read. Group messages: A encrypts once per member. Key exchange happens when users first connect, and keys rotate periodically for forward secrecy.

**Q: How do group messages work at scale?**
A: Fan-out on write. When A sends to a group of 50, the Chat Service creates 49 individual messages (one per recipient) and delivers each one independently. This is simpler than fan-out on read and ensures delivery even if some members are offline. WhatsApp caps groups at 1,024 members partly to limit this fan-out.

**Q: How does message ordering work?**
A: Messages have server-assigned timestamps (or Lamport clocks) per conversation. Within a one-on-one chat, messages are ordered by the server's receive time. In groups, messages from different senders might interleave, but each sender's messages maintain their order. True global ordering in a distributed system is expensive (Chapter 33), and for chat, "close enough" ordering is fine.

**Q: Why Cassandra and not MySQL?**
A: Write throughput. WhatsApp writes 1M+ messages/sec. Cassandra is designed for massive write throughput across distributed nodes with tunable consistency. MySQL would need complex sharding (Chapter 15) and still wouldn't match Cassandra's write performance. The trade-off: Cassandra doesn't support joins or complex queries — but for a message store (write, read by user, read by time range), you don't need them.

**Q: How would you handle message search ("find all messages containing 'flight')?**
A: This is tricky with end-to-end encryption — the server can't search encrypted content. WhatsApp does this client-side: the search runs on the user's device against locally stored messages. For a non-encrypted messaging system, you'd index messages in Elasticsearch (Chapter 21) with the partition key as `userId`, allowing per-user full-text search without scanning every message in the system.

---

## Design 2: YouTube

### Requirements

**Functional:**
- Upload videos (up to 12 hours, any format)
- Stream videos (adaptive quality based on bandwidth)
- Search videos by title, description, tags
- Like, comment, subscribe
- Recommendations / home feed

**Non-functional:**
- High availability (99.99%)
- Low latency for video playback start (< 2 seconds)
- Support 2 billion monthly active users
- 500+ hours of video uploaded every minute
- Handle variable bandwidth (HD to 144p depending on connection)

### Capacity Estimation

```
MAU: 2 billion, 1 billion DAU
Daily views: 5 billion video views/day = ~58,000 views/sec
Uploads: 500 hours/minute = ~720,000 minutes of video/day
Storage per minute of video (all qualities): ~150 MB
New storage/day: 720K min × 150 MB = ~108 PB/day
Total storage: hundreds of exabytes
CDN bandwidth: 5B views × 5 min avg × 5 Mbps avg = ~18 Tbps peak
```

### High-Level Architecture

```
┌─────────┐    ┌──────────────┐    ┌──────────────┐
│ Upload  │───→│  Upload      │───→│  Transcoding │
│ Client  │    │  Service     │    │  Pipeline    │
└─────────┘    └──────────────┘    └──────┬───────┘
                                          │
                                   ┌──────┴───────┐
                                   │ Object Store │
                                   │  (S3/GCS)    │
                                   └──────┬───────┘
                                          │
┌─────────┐    ┌──────────────┐    ┌──────┴───────┐
│ Viewer  │←──│     CDN      │←──│  Origin      │
│ Client  │    │  (Edge Cache)│    │  Servers     │
└─────────┘    └──────────────┘    └──────────────┘

┌──────────────┐    ┌──────────────┐    ┌───────────┐
│   Search     │    │ Recommendation│   │  Metadata │
│(Elasticsearch)│   │   Engine     │    │  DB       │
└──────────────┘    └──────────────┘    └───────────┘
```

### Key Components Deep Dive

**1. Video Transcoding Pipeline (Message Queues — Chapter 18)**

When a creator uploads a video, it doesn't go directly to viewers. The upload service stores the raw file in object storage (Chapter 20) and publishes a "VideoUploaded" event to a message queue. A fleet of transcoding workers picks up the job and converts the video into multiple formats and resolutions:

```
Transcoding Pipeline
━━━━━━━━━━━━━━━━━━━━
Raw Upload (4K, 60fps, 50 GB)
    │
    ▼
┌────────────────────────────────┐
│ Transcoding Workers (100s)     │
│                                │
│ → 2160p (4K)  → H.264 + VP9  │
│ → 1080p (HD)  → H.264 + VP9  │
│ → 720p        → H.264 + VP9  │
│ → 480p        → H.264 + VP9  │
│ → 360p        → H.264 + VP9  │
│ → 144p        → H.264         │
│ → Thumbnails (multiple sizes)  │
│ → Audio tracks (multiple lang) │
└───────────────┬────────────────┘
                │
                ▼
        Object Storage (S3/GCS)
        → 12+ versions per video
```

A 10-minute video takes ~5-15 minutes to transcode across all formats. YouTube processes 500 hours of video per minute — that's ~6,000 transcoding jobs per minute, each producing 12+ output files. This is a massive parallel computing problem solved by message queues and worker pools.

**2. Adaptive Bitrate Streaming (CDN — Chapter 17)**

YouTube doesn't stream one continuous file. It splits each video into 2-10 second segments, each available at every quality level. The client's player downloads segments one at a time, switching quality based on current bandwidth:

```
Adaptive Bitrate Streaming
━━━━━━━━━━━━━━━━━━━━━━━━━━
Video split into segments:
  [Seg1][Seg2][Seg3][Seg4][Seg5][Seg6]...

Manifest file tells client what's available:
  1080p: seg1_1080.ts, seg2_1080.ts, ...
  720p:  seg1_720.ts,  seg2_720.ts,  ...
  480p:  seg1_480.ts,  seg2_480.ts,  ...

Client on fast wifi:
  [1080p][1080p][1080p]...

Client enters tunnel (bandwidth drops):
  [1080p][720p][480p][480p][720p][1080p]...

Seamless quality switching mid-video.
```

**3. CDN Architecture**

YouTube's CDN (Google's global edge network) caches popular videos on servers close to viewers. A video trending in Japan is cached on Tokyo edge servers. The same video might not be cached in São Paulo's edge — if a Brazilian viewer requests it, the edge fetches from the origin, caches it, and serves subsequent viewers locally. At YouTube's scale, CDN cache hit rates exceed 90% for popular content — 90% of video traffic never reaches the origin servers.

**4. Recommendation Engine**

YouTube's recommendation system (driving 70%+ of watch time) combines collaborative filtering ("users who watched X also watched Y"), content-based filtering (video metadata, transcripts), and deep learning models trained on user behavior. The model runs as a batch pipeline: process billions of watch events nightly, update recommendation scores, and store them in a fast-read cache. Real-time signals (recent watches, trending topics) adjust recommendations in near-real-time.

### Database & Schema

```
Videos table (PostgreSQL / Spanner):
  video_id (PK), creator_id, title, description,
  upload_time, duration, status (processing/live/removed),
  view_count, like_count

Video files (Object Storage paths):
  video_id/1080p/segment_001.ts
  video_id/720p/segment_001.ts
  video_id/thumbnails/default.jpg

User table:
  user_id (PK), username, email, subscriber_count

Watch history (Cassandra — high write volume):
  user_id (partition key), video_id, watched_at, watch_duration
```

### Key Trade-offs

| Decision | Trade-off |
|---|---|
| Pre-transcode all resolutions | Huge storage cost (12+ versions per video) vs. instant playback at any quality |
| CDN-first architecture | CDN costs ($0.02-0.08/GB) vs. origin server bandwidth ($0.01/GB) — CDN is cheaper at scale because it reduces origin load |
| Eventually consistent view counts | Users might see slightly stale counts vs. avoiding a hot-write bottleneck on every view |
| Batch recommendations | Slightly stale suggestions vs. enormous real-time compute cost |

### What Could Go Wrong

- **Transcoding backlog:** A viral event (Super Bowl) causes upload spikes. Queue depth grows, processing delays hours. Solution: auto-scale transcoding workers, prioritize videos from high-subscriber channels.
- **CDN cache miss storm:** A new viral video isn't cached anywhere. Millions of requests hit the origin simultaneously (thundering herd — Chapter 41). Solution: request coalescing at the CDN edge — one origin fetch per edge server, all viewers wait for that result.
- **Storage cost explosion:** 108 PB/day of new storage. At $0.023/GB/month (S3 Standard), that's $2.5M/day. Solution: tiered storage — move old, rarely watched videos to cold storage ($0.004/GB), keep popular content on fast storage.

### Q&A

**Q: How does YouTube handle 500 hours of video uploaded every minute?**
A: Parallel processing. Each upload triggers an independent transcoding pipeline. Hundreds of transcoding workers process jobs from a queue. The key insight: transcoding is embarrassingly parallel — each resolution and each segment can be processed independently. A 10-minute video can be split into 60 segments × 6 resolutions = 360 independent jobs running simultaneously.

**Q: Why does YouTube buffer at the start but then plays smoothly?**
A: Adaptive bitrate streaming. The player starts by downloading the first few segments at low quality (fast download, fast start). As it measures actual bandwidth, it switches to higher quality. The buffer you see at the start is the player accumulating enough segments ahead of playback. Once it has a 5-10 second buffer, playback is smooth even if individual segment downloads vary in speed.

**Q: How does YouTube count views without a write bottleneck?**
A: Approximate counting with eventual consistency. Views are recorded as events to Kafka, then aggregated in near-real-time by a stream processing system (like Apache Flink). The displayed count updates every few seconds, not on every view. For a video getting 100K views/second, writing to a single row on every view would be impossible. Kafka absorbs the write spike, and aggregation batches the updates.

**Q: How would you design the video search feature?**
A: Elasticsearch (Chapter 21) indexing video metadata: title, description, tags, creator name, auto-generated transcripts (speech-to-text). The search service receives the query, searches Elasticsearch, ranks results by relevance + recency + popularity, and returns video IDs. The API layer then fetches thumbnails and metadata from the cache/database. For autocomplete, use a prefix trie or Elasticsearch's completion suggester, served from an in-memory cache for sub-50ms response times.

---

## Design 3: URL Shortener

### Requirements

**Functional:**
- Shorten a long URL to a short one (e.g., `short.ly/abc123`)
- Redirect short URL to original URL
- Custom aliases (optional)
- Analytics (click count, geographic distribution, referrer)
- Expiration (optional TTL)

**Non-functional:**
- Very low latency for redirects (< 50ms)
- High availability (99.99%)
- 100 million new URLs/day, 10 billion redirects/day
- Short URLs should be as short as possible

### Capacity Estimation

```
New URLs: 100M/day = ~1,160/sec
Redirects: 10B/day = ~115,000/sec (read-heavy: 100:1 ratio)
URL storage: 100M/day × 500 bytes = 50 GB/day, ~18 TB/year
Short code length: base62 (a-z, A-Z, 0-9) with 7 chars = 62^7 = 3.5 trillion combinations (enough for decades)
Cache: Top 20% of URLs handle 80% of traffic → cache ~20M URLs in Redis
```

### High-Level Architecture

```
┌─────────┐   ┌──────────────┐   ┌──────────────┐
│ Client  │──→│ API Gateway  │──→│ URL Service  │
└─────────┘   │(rate limiting)│  └──────┬───────┘
              └──────────────┘         │
                                ┌──────┴───────┐
                                │   Cache      │
                                │  (Redis)     │
                                └──────┬───────┘
                                       │ miss
                                ┌──────┴───────┐
                                │  Database    │
                                │  (DynamoDB)  │
                                └──────────────┘
                                ┌──────────────┐
                                │  Analytics   │
                                │  (Kafka →    │
                                │   ClickHouse)│
                                └──────────────┘
```

### Key Components Deep Dive

**1. Short Code Generation**

Two main approaches:

```
Approach 1: Hash-based
  MD5("https://example.com/very/long/url") → "a1b2c3d4e5..."
  Take first 7 characters → "a1b2c3d"
  Collision? Append counter and re-hash

Approach 2: Counter-based (better)
  Distributed counter (Snowflake ID or pre-allocated ranges)
  Server 1 gets range: 1-1,000,000
  Server 2 gets range: 1,000,001-2,000,000
  Convert counter to base62: 1,000,000 → "4c92"

  No collisions. No hash computation. Predictable.
```

Counter-based is preferred at scale: no collision handling, no hash computation, guaranteed uniqueness. Each server pre-fetches a range of IDs from a central counter service (ZooKeeper or a simple database sequence), eliminating the counter as a bottleneck.

**2. Redirect Flow (Caching — Chapter 16)**

```
GET /abc123
1. Check Redis cache → HIT → 301 redirect (< 5ms)
                     → MISS ↓
2. Query DynamoDB → found → cache in Redis → 301 redirect
                  → not found → 404

Cache strategy: LRU eviction, 24-hour TTL
Cache hit rate: ~90% (popular URLs are accessed repeatedly)
```

Use HTTP 301 (permanent redirect) for SEO-friendly URLs and 302 (temporary redirect) when you need to track every click (browsers cache 301s and skip the shortener on subsequent visits).

**3. Analytics Pipeline**

Every redirect generates a click event: `{short_code, timestamp, IP, user_agent, referrer}`. These events flow through Kafka into an analytics store (ClickHouse or BigQuery). Real-time counters are maintained in Redis (increment on every click). Historical analytics queries run against the OLAP store (Chapter 40) — "show me clicks by country over the past 30 days."

### Database & Schema

```
URLs table (DynamoDB):
  short_code (PK): "abc123"
  original_url: "https://example.com/very/long/path"
  creator_id: "user_42"
  created_at: timestamp
  expires_at: timestamp (optional)
  click_count: number (approximate, updated from analytics)

Analytics events (Kafka → ClickHouse):
  short_code, clicked_at, country, device_type,
  browser, referrer_domain
```

### Key Trade-offs

| Decision | Trade-off |
|---|---|
| DynamoDB over PostgreSQL | Infinite horizontal scale, simple key-value lookups vs. no complex queries |
| Counter-based IDs over hashing | No collisions, simple logic vs. sequential codes are predictable (use base62 encoding to obscure) |
| 302 vs 301 redirects | Track every click (302) vs. better performance and SEO (301) |
| Redis cache with 24h TTL | Fast redirects vs. stale data if URL is updated or deleted |

### What Could Go Wrong

- **Hot URL (thundering herd):** A viral tweet shortens a URL that gets 1M clicks/sec. The Redis cache handles it — a single Redis node serves 100K reads/sec for cached keys. Shard Redis by short_code hash for higher throughput.
- **Counter service failure:** If the ID counter goes down, no new URLs can be created. Solution: pre-allocate large ranges to each server. Server holds 1M IDs locally; if the counter is down, it continues with its local range.
- **Abuse (spam, phishing):** Short URLs hide the destination, enabling phishing. Defense: check URLs against Safe Browsing databases (using a Bloom filter — Chapter 37) on creation, and scan again periodically.

### Q&A

**Q: Why not just use a UUID as the short code?**
A: UUIDs are 36 characters — longer than most original URLs. The point of a shortener is brevity. A 7-character base62 code gives 3.5 trillion combinations in just 7 characters. Even a base62-encoded UUID would be 22 characters — still too long.

**Q: How do you prevent code collisions with the hash approach?**
A: Check the database. If `hash("url") → "abc123"` already exists and points to a different URL, append a counter and re-hash: `hash("url" + "1") → "xyz789"`. But this adds a read-before-write for every creation. Counter-based generation avoids this entirely.

**Q: How would you handle URL expiration?**
A: Store `expires_at` in the database. On redirect, check if the current time exceeds `expires_at`. If yes, return 410 Gone. For cleanup, run a periodic batch job that deletes expired entries from the database and invalidates their cache entries. Don't scan the entire table — use a secondary index on `expires_at` or a TTL feature (DynamoDB supports automatic TTL-based deletion).

**Q: What if someone creates the same long URL twice?**
A: Design choice. Option A: return a new short code each time (simpler, but wastes codes). Option B: check if the long URL already exists and return the existing code (saves codes, but requires a secondary index on `original_url`, which is expensive at scale). Most shorteners choose Option A — with 3.5 trillion codes, waste isn't a concern.

---

## Design 4: Twitter / News Feed

### Requirements

**Functional:**
- Post tweets (text, images, videos)
- Follow/unfollow users
- Home timeline (aggregated feed of people you follow)
- Search tweets
- Like, retweet, reply

**Non-functional:**
- Timeline generation < 500ms
- 500 million tweets/day
- 300 million DAU
- Support users following 1 to 50 million accounts (celebrities)

### Capacity Estimation

```
DAU: 300 million
Tweets: 500M/day = ~5,800 tweets/sec
Timeline reads: 300M × 10 refreshes/day = 3B reads/day = 34,700/sec
Average follows: 200 accounts
Celebrity followers: up to 50 million (e.g., @BarackObama)
Storage per tweet: ~1 KB (text + metadata), media separate
```

### High-Level Architecture

```
┌─────────┐   ┌──────────────┐   ┌──────────────┐
│ Client  │──→│ API Gateway  │──→│ Tweet Service│
└─────────┘   └──────────────┘   └──────┬───────┘
                                        │
              ┌──────────────┐   ┌──────┴───────┐
              │  Timeline    │   │  Fan-out     │
              │  Service     │   │  Service     │
              └──────┬───────┘   └──────────────┘
                     │
              ┌──────┴───────┐   ┌──────────────┐
              │  Timeline    │   │   Social     │
              │  Cache       │   │   Graph      │
              │  (Redis)     │   │   Service    │
              └──────────────┘   └──────────────┘
```

### Key Components Deep Dive

**1. The Fan-Out Problem**

When a user tweets, all their followers should see it in their timeline. Two approaches:

```
Fan-Out on Write (push model)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
User A tweets → for each follower, write tweet to their timeline cache

User A has 1,000 followers:
  → Write to 1,000 timeline caches
  → Each follower's next timeline load is instant (pre-computed)

Problem: @BarackObama tweets → write to 130 MILLION timelines
  → Takes minutes. Expensive. Mostly wasted (most won't check).


Fan-Out on Read (pull model)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
User opens timeline → fetch latest tweets from everyone they follow

User follows 200 accounts:
  → Query 200 accounts' recent tweets
  → Merge, rank, return

Problem: 200 queries per timeline load × 34,700 reads/sec
  = ~7 million queries/sec to the tweet store. Slow for the user.


Twitter's Hybrid Approach
━━━━━━━━━━━━━━━━━━━━━━━━
Regular users (< 10,000 followers): fan-out on write
  → Pre-compute followers' timelines on tweet

Celebrities (> 10,000 followers): fan-out on read
  → Their tweets are fetched at timeline-read time
  → Merge with pre-computed timeline from regular follows

This balances write cost (avoid fanning out to millions)
with read speed (most timeline is pre-cached).
```

**2. Timeline Cache (Redis)**

Each user's timeline is stored as a sorted set in Redis: `timeline:{userId}` → `[(tweetId, timestamp), ...]`. When they open the app, the Timeline Service reads the top 200 entries from Redis and hydrates them (fetch tweet text, author info, media URLs). The cache holds the last ~800 tweets per user. Older tweets are fetched from the database on scroll.

**3. Social Graph Service**

The follow relationships are stored in a graph-optimized store. Key queries: "who does user X follow?" (for timeline generation) and "who follows user X?" (for fan-out). At Twitter's scale, this is billions of edges. The Social Graph Service caches hot relationships in memory and serves them with sub-millisecond latency.

### Database & Schema

```
Tweets table (sharded by tweet_id):
  tweet_id (PK, Snowflake ID — encodes timestamp),
  author_id, text, media_urls[], created_at,
  reply_to_id, retweet_of_id, like_count, retweet_count

Follows table (sharded by follower_id):
  follower_id (PK), followee_id, followed_at

Timeline cache (Redis sorted sets):
  Key: timeline:{user_id}
  Members: tweet_id
  Score: timestamp
```

### Key Trade-offs

| Decision | Trade-off |
|---|---|
| Hybrid fan-out | Implementation complexity vs. optimal performance for both regular and celebrity users |
| Redis for timeline | Memory cost (~800 tweets × 300M users ≈ 24 TB) vs. instant timeline loads |
| Snowflake IDs | Coordination overhead vs. time-sortable, globally unique, 64-bit IDs |
| Eventual consistency for counts | Stale like/retweet counts vs. avoiding write hotspots |

### What Could Go Wrong

- **Celebrity tweet storm:** Multiple celebrities tweet simultaneously → massive fan-out on read at timeline load. Solution: pre-fetch celebrity tweets into a "celebrity timeline" cache, merge at read time.
- **Redis cache eviction:** Under memory pressure, timeline caches are evicted. Users see slow timeline loads (cache miss → reconstruct from database). Solution: monitor cache hit rates, scale Redis cluster before eviction rates rise.
- **Cascading failure on trending event:** A major news event causes 10x normal tweet volume + 5x timeline reads simultaneously. Solution: rate limiting on writes, circuit breakers on downstream services, pre-scaled capacity for known events (Super Bowl, elections).

### Q&A

**Q: Why doesn't Twitter just use fan-out on write for everyone?**
A: Math. If @BarackObama tweets once, that's 130 million writes to 130 million timeline caches. At 10K tweets/sec from celebrities, that's 1.3 trillion writes/sec — physically impossible. The hybrid approach keeps celebrity fan-out at read time (only fans who actually open the app trigger the merge) and pre-computes for regular users. This reduced Twitter's fan-out write volume by 90%+.

**Q: How does Twitter rank the timeline instead of just showing chronological order?**
A: A machine learning ranking model scores each tweet for each user based on: engagement probability (will you like/retweet?), recency, author relationship strength, content type, and diversity (avoid showing 10 tweets from the same person). The ranked timeline replaced pure chronological in 2016. The timeline cache stores candidate tweets, and the ranking model reorders them at read time.

**Q: How do Snowflake IDs work?**
A: A 64-bit ID structured as: `[41 bits: timestamp] [10 bits: machine ID] [12 bits: sequence number]`. Timestamp gives time-ordering (newer tweets have higher IDs, so sorting by ID = sorting by time). Machine ID ensures no collisions across servers. Sequence number handles multiple tweets in the same millisecond on the same machine. This generates ~4,096 IDs/ms per machine with no central coordination.

**Q: How would you add a "trending topics" feature?**
A: Streaming aggregation. Every tweet is processed by a stream processor (Kafka Streams or Flink) that extracts hashtags and named entities. A sliding window (last 15 minutes) counts occurrences, weighted by retweet and like velocity. Topics whose count growth rate exceeds a threshold (relative to their historical baseline) are "trending." The top 10-30 are cached and served from Redis. Location-based trending uses the same pipeline filtered by user geo.

---

## Design 5: Uber

### Requirements

**Functional:**
- Rider requests a ride, matched with nearby driver
- Real-time driver location tracking on map
- ETA calculation
- Surge pricing during high demand
- Payment processing after ride completion

**Non-functional:**
- Match rider to driver in < 10 seconds
- Location updates every 3-4 seconds from active drivers
- Support 5 million active drivers, 20 million rides/day
- Sub-second map updates for riders tracking their driver

### Capacity Estimation

```
Active drivers: 5 million sending location every 4 seconds
Location updates: 5M / 4 = 1.25 million updates/sec
Rides: 20M/day = ~230 rides/sec
Each ride: ~15 location points/min × 20 min avg = 300 points
Location storage: 5M drivers × 21,600 updates/day × 50 bytes = ~5.4 TB/day
Matching queries: 230/sec (find drivers near rider)
```

### High-Level Architecture

```
┌──────────┐    ┌──────────────┐    ┌──────────────┐
│  Rider   │←──→│   Gateway    │←──→│   Driver     │
│   App    │    │  (WebSocket) │    │    App       │
└──────────┘    └──────┬───────┘    └──────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
┌──────────────┐ ┌───────────┐ ┌──────────────┐
│  Matching    │ │  Location │ │   Pricing    │
│  Service     │ │  Service  │ │   Service    │
└──────────────┘ └───────────┘ └──────────────┘
        │              │
        ▼              ▼
┌──────────────┐ ┌───────────┐
│  Geo-Index   │ │  Location │
│ (QuadTree /  │ │  Store    │
│  GeoHash)    │ │  (Redis)  │
└──────────────┘ └───────────┘
```

### Key Components Deep Dive

**1. Location Tracking and Geo-Indexing**

Every active driver sends GPS coordinates every 4 seconds. The Location Service stores the latest position in Redis (`driver:{id} → {lat, lng, timestamp}`) and updates a geospatial index.

```
GeoHash — Encoding Location as a String
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The world is divided into a grid.
Each cell has a string code.
Longer strings = smaller, more precise cells.

  "9q8y"     → San Francisco area (~20km × 20km)
  "9q8yh"    → ~5km × 5km
  "9q8yhv"   → ~1km × 1km
  "9q8yhvb"  → ~150m × 150m

Nearby drivers share the same GeoHash prefix!

Finding drivers near rider at (37.78, -122.41):
  1. Compute rider's GeoHash: "9q8yhv"
  2. Query all drivers with GeoHash prefix "9q8yhv"
     + neighboring cells (8 surrounding cells)
  3. Filter by actual distance (Haversine formula)
  4. Sort by distance and availability
```

Redis supports native geospatial indexing (`GEOADD`, `GEORADIUS`). Store all active drivers in a Redis geo set, query "drivers within 3km of rider" in < 10ms.

**2. Matching Algorithm**

```
Rider requests ride at (37.78, -122.41):

1. Query: available drivers within 3km → [D1(0.5km), D2(1.2km), D3(2.1km)]
2. Estimate ETA for each: D1(3min), D2(5min), D3(8min)
3. Score: distance + ETA + driver rating + acceptance rate
4. Send request to D1 (highest score)
5. D1 has 15 seconds to accept
   → Accepts → match confirmed, notify rider
   → Declines/timeout → try D2
   → D2 accepts → match confirmed
```

**3. ETA Calculation**

ETA isn't just distance ÷ speed. It factors in: road network (you can't fly in a straight line), real-time traffic, turn costs, historical patterns (school zones at 3 PM), and road closures. Uber precomputes a road network graph and uses a modified Dijkstra's algorithm. Real-time traffic data (from active drivers' GPS traces) adjusts edge weights in the graph. ETAs are cached for popular routes and updated every few minutes.

**4. Surge Pricing**

```
Surge pricing = supply/demand balance per geo-cell

  Cell "9q8yhv" (downtown SF, Friday 6 PM):
    Ride requests: 500/min (demand)
    Available drivers: 50 (supply)
    Ratio: 10:1 → Surge: 2.5x

  Cell "9q8yj2" (suburban area, Friday 6 PM):
    Ride requests: 20/min
    Available drivers: 30
    Ratio: 0.67:1 → No surge (1.0x)

Recalculated every 1-2 minutes per geo-cell.
Higher prices attract drivers to high-demand areas.
```

### Database & Schema

```
Rides table (PostgreSQL, sharded by ride_id):
  ride_id (PK), rider_id, driver_id, status,
  pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
  requested_at, started_at, completed_at,
  fare, surge_multiplier

Driver locations (Redis geo set):
  Key: active_drivers
  Members: driver_id with lat/lng

Location history (Cassandra — append-heavy):
  driver_id (partition key), timestamp (clustering key),
  lat, lng, speed, heading
```

### Key Trade-offs

| Decision | Trade-off |
|---|---|
| GeoHash over QuadTree | Simpler implementation, works with Redis vs. less flexible cell sizes |
| Redis for live locations | Speed (sub-ms queries) vs. data lost on Redis failure (acceptable — drivers resend in 4 sec) |
| 4-second location interval | Smooth tracking vs. bandwidth cost (1.25M updates/sec) |
| Surge pricing every 2 min | Fair pricing adjustment vs. "price shock" if surge changes mid-request |

### What Could Go Wrong

- **GPS drift in tunnels/urban canyons:** Driver appears to jump between locations. Solution: Kalman filter to smooth GPS readings, snap to nearest road on the road network graph.
- **New Year's Eve spike:** 10x normal demand at midnight. Solution: pre-scale matching and location services, increase surge aggressively to balance supply/demand, and queue riders when no drivers are available (with estimated wait times).
- **Location service Redis failure:** All live driver locations lost. Solution: drivers resend location every 4 seconds — the geo-index rebuilds in < 10 seconds. Use Redis cluster with replicas for redundancy.

### Q&A

**Q: Why GeoHash instead of a simple grid?**
A: GeoHash is hierarchical — "9q8" contains all cells starting with "9q8." This makes range queries natural: searching a wider area just shortens the prefix. A simple grid requires pre-defined cell sizes that can't adapt. GeoHash also compresses location into a string, making it easy to index in databases and key-value stores.

**Q: How does Uber handle 1.25 million location updates per second?**
A: Write to Redis (in-memory, handles millions of writes/sec across a cluster). Location history goes to Kafka → Cassandra asynchronously. The live geo-index only needs the latest position per driver — it's an UPDATE (overwrite), not an INSERT. Redis' GEOADD replaces the old position atomically.

**Q: Why not match multiple riders to drivers simultaneously (batch matching)?**
A: Uber actually does this in high-demand areas. Instead of matching one at a time, they batch requests every 2-3 seconds and solve an optimization problem: minimize total wait time across all pending riders and available drivers. This is a variant of the assignment problem, solved with algorithms like the Hungarian method. Batch matching reduces average wait times by 10-20% compared to greedy one-by-one matching.

**Q: How does Uber's system handle different vehicle types (UberX, UberXL, UberBlack)?**
A: Separate geo-indexes per vehicle type. When a rider requests UberXL, the matching service queries the UberXL geo-index. Drivers register their vehicle type on signup. Surge multipliers are also per-vehicle-type per-geo-cell — UberBlack might have 1.0x surge while UberX has 2.5x in the same area.

---

## Design 6: Google Search

### Requirements

**Functional:**
- Search the entire web by keywords
- Return ranked results in < 500ms
- Autocomplete suggestions while typing
- Spell correction ("Did you mean...?")
- Image, video, and news search

**Non-functional:**
- Index 100+ billion web pages
- 8.5 billion searches/day (~100,000 queries/sec)
- Results in < 200ms (perceived)
- Index freshness: popular sites updated within minutes

### Capacity Estimation

```
Web pages: 100+ billion indexed pages
Average page size: 50 KB (compressed text content)
Index size: several hundred PB (compressed inverted index)
Queries: 8.5B/day = ~100,000/sec
Crawl rate: billions of pages/day (continuous re-crawl)
```

### High-Level Architecture

```
          ┌──────────────┐
          │  Web Crawler  │ (discovers and fetches pages)
          └──────┬───────┘
                 │
          ┌──────┴───────┐
          │  Indexer      │ (builds inverted index)
          └──────┬───────┘
                 │
          ┌──────┴───────┐
          │ Inverted     │ (word → document mapping)
          │ Index        │
          └──────┬───────┘
                 │
┌─────────┐    ┌┴─────────────┐
│  User   │──→ │ Query Server │──→ ranked results
└─────────┘    └──────────────┘
                       │
                ┌──────┴───────┐
                │   Ranking    │ (PageRank + 200+ signals)
                │   Engine     │
                └──────────────┘
```

### Key Components Deep Dive

**1. Web Crawler**

```
Crawling Strategy
━━━━━━━━━━━━━━━━

Start with seed URLs (millions of known high-quality sites)
     │
     ▼
┌──────────────┐
│  URL Frontier │ (priority queue of URLs to crawl)
│  - Prioritize │  by PageRank, freshness needs
│  - Politeness │  don't hit one site too fast
└──────┬───────┘
       │
       ▼
┌──────────────┐    ┌──────────────┐
│ Fetch Page   │──→ │ Parse HTML   │
│ (HTTP GET)   │    │ Extract links│
└──────────────┘    └──────┬───────┘
                           │
                    New URLs → back to Frontier
                    Page content → to Indexer

Duplicate detection:
  Before crawling: check URL Bloom filter (Chapter 37)
  After crawling: content hash to detect duplicate pages
```

The URL frontier is a priority queue with billions of entries. High-PageRank pages (CNN, Wikipedia) are re-crawled every few minutes. Low-priority pages might be re-crawled monthly. A politeness policy ensures no single website is overwhelmed — typically max 1 request per second per domain.

**2. Inverted Index**

```
Regular index (book-style):
  Page 1 → contains words: "cat", "dog", "fish"
  Page 2 → contains words: "cat", "bird"

Inverted index (search-style):
  "cat"  → [Page 1, Page 2]
  "dog"  → [Page 1]
  "bird" → [Page 2]
  "fish" → [Page 1]

Query: "cat bird"
  "cat"  → [Page 1, Page 2]
  "bird" → [Page 2]
  Intersection → [Page 2]

At Google's scale:
  "obama" → [page_1, page_2, ..., page_25,000,000]
  Each entry includes: document ID, position in document,
  font size, anchor text context, freshness score
```

The inverted index is sharded across thousands of servers, partitioned by term. Common terms ("the", "is") appear in billions of documents — these posting lists are compressed and distributed across multiple machines. A single query might touch 10+ index servers in parallel.

**3. PageRank (Simplified)**

```
PageRank: A page is important if important pages link to it.

  Page A (NYT article) links to → Page C (your blog)
  Page B (random site) links to → Page C (your blog)

  Page C's rank is higher because of A's link (NYT is important)
  than B's link (random site has low importance).

  It's recursive: NYT is important because OTHER important pages
  link to it, and so on.

  Computed offline as a massive graph problem over the entire web.
  Updated continuously.
```

In reality, Google uses 200+ ranking signals beyond PageRank: content relevance, freshness, user engagement, mobile-friendliness, page speed, and many more. A machine learning model combines these signals to produce the final ranking.

**4. Query Autocomplete**

As you type, Google suggests completions. This uses a trie (prefix tree) of popular queries weighted by frequency and recency. The trie is stored in memory on edge servers (Chapter 17) for sub-50ms response. Updated every few hours from query logs. Personalized: your past searches influence your suggestions.

### Database & Schema

```
Document store (Bigtable / custom):
  doc_id → {url, title, content_hash, crawl_time,
            pagerank, language, content_type}

Inverted index (custom distributed):
  term → [(doc_id, frequency, positions[], ...),
           (doc_id, frequency, positions[], ...), ...]

Query logs (for autocomplete, analytics):
  query, timestamp, user_locale, result_clicks[]
```

### Key Trade-offs

| Decision | Trade-off |
|---|---|
| Inverted index over full-text scan | Enormous index storage vs. sub-second query response |
| Batch PageRank computation | Slightly stale rankings vs. real-time (computationally infeasible) |
| Crawl politeness (1 req/sec/domain) | Slower crawl vs. not getting banned by websites |
| Tiered index (hot/warm/cold) | Query latency varies by tier vs. storing everything on fast storage |

### What Could Go Wrong

- **Index corruption:** A bug in the indexer produces wrong term→document mappings. Solution: canary deployments — index a small percentage of documents with new code, compare results with the existing index, roll out only if quality metrics hold.
- **Crawl trap:** A site generates infinite pages (dynamic calendars: `/calendar/2024/01/01`, `/calendar/2024/01/02`, ..., forever). Solution: per-domain crawl budget, URL pattern detection, and depth limits.
- **Query of death:** A query like "the" matches every page — the query server tries to intersect every document and times out. Solution: early termination (stop after finding top 1,000 results), index pruning (don't index extremely common terms alone), and query cost estimation before execution.

### Q&A

**Q: How does Google return results in < 200ms when the index is petabytes?**
A: Parallelism and caching. The index is sharded across thousands of machines. A query is sent to all relevant shards simultaneously, each returns its top 100 results, and a merger combines and re-ranks them. Popular queries (covering ~30% of all searches) are cached entirely — the result page is precomputed. The long tail uses the sharded index but still completes in < 500ms because each shard's lookup is a fast sorted list intersection.

**Q: How fresh is Google's index?**
A: It depends on the page. Breaking news sites (CNN, BBC) are re-crawled every few minutes. Popular sites (Wikipedia, Reddit) every few hours. Smaller sites every few days to weeks. Google detects update frequency (a blog that posts daily is crawled daily; one that posts yearly is crawled yearly) and allocates crawl budget accordingly.

**Q: How does "Did you mean...?" work?**
A: Two techniques. (1) Edit distance: find known valid queries within 1-2 character edits of the input ("pythn" → "python"). (2) Query-click data: if users who search "pythn" always click results for "python," learn that correction. The second approach is more powerful because it handles domain-specific and context-dependent corrections that edit distance misses.

---

## Design 7: Notification System

### Requirements

**Functional:**
- Send notifications via push (iOS/Android), email, SMS, and in-app
- Support different notification types (transactional, marketing, alerts)
- User preferences (opt-out per channel, quiet hours)
- Rate limiting per user (no notification spam)
- Delivery tracking (sent, delivered, opened)

**Non-functional:**
- Deliver transactional notifications in < 30 seconds
- Handle 1 billion notifications/day
- 99.9% delivery rate (transactional)
- Graceful degradation if a channel provider is down

### Capacity Estimation

```
Notifications: 1B/day = ~11,600/sec
Breakdown: 60% push, 25% email, 10% in-app, 5% SMS
Push: 600M/day via APNs (Apple) + FCM (Google)
Email: 250M/day via SES/SendGrid
SMS: 50M/day via Twilio (expensive: $0.0075 each = $375K/day)
Storage: notification logs = 1B × 200 bytes = 200 GB/day
```

### High-Level Architecture

```
┌──────────────┐
│   Trigger    │ (order confirmed, delivery update, marketing campaign)
│   Sources    │
└──────┬───────┘
       │
┌──────┴───────┐
│ Notification │
│   Service    │ (validate, check preferences, rate limit)
└──────┬───────┘
       │
┌──────┴───────┐
│  Priority    │ (separate queues: critical, high, normal, low)
│  Queues      │
└──┬──┬──┬──┬──┘
   │  │  │  │
   ▼  ▼  ▼  ▼
┌────┐┌────┐┌─────┐┌──────┐
│Push││Email││ SMS ││In-App│  (channel workers)
│Wkr ││Wkr  ││ Wkr ││ Wkr │
└──┬─┘└──┬─┘└──┬──┘└──┬───┘
   │     │     │      │
   ▼     ▼     ▼      ▼
  APNs  SES  Twilio  WebSocket
  FCM   SG            (Ch. 29)
```

### Key Components Deep Dive

**1. Notification Processing Pipeline**

```
Notification Flow
━━━━━━━━━━━━━━━━

1. Trigger: "OrderShipped" event for user_42

2. Notification Service:
   a. Fetch user preferences:
      - Push: ✓ enabled
      - Email: ✓ enabled
      - SMS: ✗ disabled
      - Quiet hours: 10 PM - 8 AM
   b. Check rate limit: user_42 received 3 notifications in last hour
      (limit: 10/hour) → OK
   c. Template: "Your order #123 has shipped! Track: {link}"
   d. Enqueue to push + email queues (not SMS — disabled)

3. Push Worker:
   a. Fetch device tokens for user_42 → [iPhone: tok_abc, Android: tok_xyz]
   b. Send to APNs (iPhone) and FCM (Android)
   c. Record: {notification_id, channel: "push", status: "sent", timestamp}

4. Email Worker:
   a. Render HTML email template
   b. Send via SES
   c. Record delivery status
```

**2. Priority Queue System (Message Queues — Chapter 18)**

Not all notifications are equal. A two-factor authentication code must arrive in 10 seconds. A marketing email can wait minutes.

```
Priority Levels
━━━━━━━━━━━━━━
Critical:  2FA codes, password resets, security alerts
           → Dedicated queue, process immediately
High:      Order confirmations, payment receipts
           → Process within 30 seconds
Normal:    Shipping updates, social activity
           → Process within 5 minutes
Low:       Marketing emails, weekly digests
           → Process during off-peak hours, rate-limited
```

**3. Rate Limiting (Chapter 19)**

Per-user rate limits prevent notification fatigue: max 10 push notifications/hour, max 3 emails/day for marketing. Per-channel rate limits respect provider constraints: APNs allows bursts but throttles sustained high rates; Twilio has per-second SMS limits. A token bucket (Chapter 19) per user per channel enforces these limits.

**4. Delivery Tracking**

```
Notification Lifecycle
━━━━━━━━━━━━━━━━━━━━━━
CREATED → QUEUED → SENT → DELIVERED → OPENED

Push: APNs/FCM confirms delivery to device
Email: SES webhook reports delivered/bounced/opened
SMS: Twilio callback reports delivered/failed
In-app: Client acks when notification is displayed

Failed → retry with backoff (max 3 attempts)
        → if still failing, try alternate channel
        → if all channels fail, alert operations
```

### Database & Schema

```
Notifications table (Cassandra — high write volume):
  notification_id (PK), user_id, type, channel,
  template_id, content, status, priority,
  created_at, sent_at, delivered_at, opened_at

User preferences (PostgreSQL):
  user_id (PK), push_enabled, email_enabled,
  sms_enabled, quiet_hours_start, quiet_hours_end,
  marketing_opt_in, per_channel_frequency_limits

Device tokens (DynamoDB):
  user_id (PK), device_id (SK), platform,
  push_token, last_active
```

### Key Trade-offs

| Decision | Trade-off |
|---|---|
| Separate queues per priority | Operational complexity (multiple queues) vs. critical notifications never blocked by marketing batch |
| Async delivery | User doesn't wait for notification to send vs. slight delay in delivery |
| Per-user rate limiting | Some notifications dropped vs. no user harassment |
| Multiple channel fallback | Higher delivery rate vs. cost (SMS is expensive) and user annoyance |

### What Could Go Wrong

- **APNs/FCM outage:** Push notifications fail for millions. Solution: circuit breaker (Chapter 26) on the push provider. Queue messages and retry when the provider recovers. For critical notifications (2FA), fall back to SMS immediately.
- **Token invalidation:** A user uninstalls the app but the push token isn't removed. APNs returns "invalid token." Solution: listen to APNs feedback, remove invalid tokens immediately. Periodically clean stale tokens (no activity in 30 days).
- **Notification storm from bad deployment:** A bug triggers "OrderShipped" for all 100M users simultaneously. Solution: rate limiting at the trigger level (max 1M notifications/minute for any single event type), canary deployments for notification triggers, kill switch to halt a specific notification type.

### Q&A

**Q: Why not just use a single queue for all notifications?**
A: A marketing campaign sending 100M emails would clog the queue, delaying a user's 2FA code by minutes. Separate queues ensure critical notifications (2FA, security alerts) are never blocked by bulk sends. Workers process the critical queue first, then high, then normal, then low.

**Q: How do you handle time zones for "quiet hours"?**
A: Store the user's timezone. Before queuing, check: is it currently within their quiet hours? If yes, delay the notification until quiet hours end. For critical notifications (2FA, security alerts), ignore quiet hours — the user needs them immediately. For marketing, always respect quiet hours.

**Q: What's the retry strategy when a notification fails?**
A: Exponential backoff with a max of 3 retries for transactional, 1 retry for marketing. Push retry: 1 min, 5 min, 30 min. Email retry: 5 min, 30 min, 2 hours. SMS retry: 1 min, 5 min (SMS is expensive, don't retry aggressively). After max retries, mark as "failed" and optionally try an alternate channel (push failed → try email).

---

## Design 8: Payment System

### Requirements

**Functional:**
- Process credit card charges
- Handle refunds
- Support multiple currencies
- Double-entry bookkeeping (every debit has a corresponding credit)
- Reconciliation between internal ledger and external providers

**Non-functional:**
- Zero money loss (correctness > availability)
- Idempotent processing (no double charges)
- Sub-second processing for card charges
- Full audit trail for every transaction
- PCI DSS compliance

### Capacity Estimation

```
Transactions: 1M/day = ~12 transactions/sec (not high throughput — correctness matters more)
Average transaction: $50
Daily volume: $50M
Refund rate: ~2%
Storage: 1M txns × 2 KB = 2 GB/day, 730 GB/year
Ledger entries: 2 per transaction (debit + credit) = 2M/day
```

### High-Level Architecture

```
┌──────────┐    ┌──────────────┐    ┌──────────────┐
│ Merchant │───→│  Payment     │───→│  Payment     │
│   API    │    │  Gateway     │    │  Processor   │
└──────────┘    └──────────────┘    └──────┬───────┘
                                          │
                ┌──────────────┐    ┌──────┴───────┐
                │   Ledger     │←──│  Card Network │
                │  Service     │    │ (Visa/MC)    │
                └──────────────┘    └──────────────┘
                       │
                ┌──────┴───────┐    ┌──────────────┐
                │  Ledger DB   │    │ Reconciliation│
                │ (PostgreSQL) │    │  Service     │
                └──────────────┘    └──────────────┘
```

### Key Components Deep Dive

**1. Idempotent Payment Processing (Chapter 27)**

```
Payment Request with Idempotency
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

POST /charges
Headers: Idempotency-Key: order_42_charge_1

1. Check idempotency store (Redis):
   Key "order_42_charge_1" → not found → proceed

2. Acquire distributed lock (Chapter 35):
   LOCK payment:order_42_charge_1

3. Process payment:
   a. Validate: card not expired, sufficient funds
   b. Call card network (Visa): authorize $50
   c. Record in ledger (double-entry)
   d. Store result in idempotency store

4. Release lock

5. Client retries same request:
   → Idempotency key found → return stored result
   → No reprocessing, no double charge
```

**2. Double-Entry Ledger**

```
Double-Entry Bookkeeping
━━━━━━━━━━━━━━━━━━━━━━━━

Every transaction = two entries that sum to zero.

Customer pays $50 for order:
  Entry 1: DEBIT  Customer Account    -$50
  Entry 2: CREDIT Merchant Revenue    +$50
  Sum: $0 ✓

Refund $50:
  Entry 3: DEBIT  Merchant Revenue    -$50
  Entry 4: CREDIT Customer Account    +$50
  Sum: $0 ✓

If the total of all entries ≠ 0, money leaked.
This invariant is checked continuously.
```

Why double-entry? If a bug credits a merchant without debiting the customer, the ledger's sum is non-zero — an automated alert fires. With single-entry bookkeeping, you'd only notice during monthly reconciliation (or never). Every bank, payment processor, and financial institution uses double-entry because it makes errors mathematically detectable.

**3. Payment State Machine**

```
Payment States
━━━━━━━━━━━━━━

  CREATED → AUTHORIZED → CAPTURED → SETTLED
     │           │            │
     ▼           ▼            ▼
  FAILED    AUTH_FAILED    CAPTURE_FAILED
                              │
                              ▼
                          REFUND_PENDING → REFUNDED

  CREATED:    Payment intent received
  AUTHORIZED: Card network confirmed funds are available
  CAPTURED:   Funds moved from customer's bank (T+0)
  SETTLED:    Funds arrive in merchant's bank (T+2 days)

  Each transition is:
  - Logged with timestamp and actor
  - Recorded in the ledger
  - Idempotent (re-applying the same transition is a no-op)
```

**4. Reconciliation**

The ledger says "we charged customer $50 via Visa." Visa's settlement report says "we processed a $50 charge." Reconciliation compares these records. Mismatches mean: a charge was processed but not recorded (money in, no ledger entry), or recorded but not processed (ledger entry, no money). Reconciliation runs daily, comparing internal ledger entries against card network settlement files, bank statements, and payment provider reports. Any discrepancy triggers an alert for manual investigation.

### Database & Schema

```
Payments table (PostgreSQL — ACID required):
  payment_id (PK), idempotency_key (UNIQUE),
  merchant_id, customer_id, amount, currency,
  status, card_network, authorization_code,
  created_at, updated_at

Ledger entries (PostgreSQL — append-only):
  entry_id (PK), payment_id (FK),
  account_id, entry_type (DEBIT/CREDIT),
  amount, currency, created_at

  CONSTRAINT: for any payment_id,
    SUM(DEBIT amounts) = SUM(CREDIT amounts)

Accounts table:
  account_id (PK), account_type (customer/merchant/fees/reserve),
  balance (computed from ledger entries, cached)
```

### Key Trade-offs

| Decision | Trade-off |
|---|---|
| PostgreSQL over NoSQL | ACID transactions for financial data vs. horizontal scaling limitations |
| Synchronous card authorization | User waits ~500ms for Visa response vs. could async but then user doesn't know if charge worked |
| Append-only ledger | Storage grows forever vs. complete audit trail, no data loss |
| Saga for refunds | Eventual consistency for refund vs. simpler implementation than distributed 2PC |

### What Could Go Wrong

- **Double charge due to timeout:** Client sends charge, network drops response, client retries. Solution: idempotency keys (the core of this entire design).
- **Ledger inconsistency:** A bug writes a debit without a credit. Solution: database constraints enforce that every transaction has balanced entries. Continuous reconciliation job alerts on any imbalance.
- **Card network outage (Visa down):** Charges fail for all Visa cards. Solution: circuit breaker on Visa, queue charges for retry, show "payment processing" status to users. For critical flows, attempt an alternate network if the card supports it.
- **Currency conversion errors:** A $50 USD charge should debit €45, but the exchange rate changed between authorization and capture. Solution: lock the exchange rate at authorization time, use that rate for capture. Accept the FX risk for the locked period.

### Q&A

**Q: Why PostgreSQL for a payment system instead of something distributed like CockroachDB?**
A: At 12 transactions/second, PostgreSQL handles the load easily — and ACID compliance on a single node is simpler and more battle-tested than distributed transactions. Payment systems prioritize correctness over throughput. A single PostgreSQL instance with synchronous replication to a hot standby handles millions of transactions/day with strong consistency. If you outgrow this (10,000+ tps), CockroachDB or Google Spanner with serializable isolation would be the next step.

**Q: How does a refund work technically?**
A: It's a new transaction, not an "undo." The system creates a refund record linked to the original payment, sends a refund request to the card network (which credits the customer's bank), and writes reverse ledger entries (debit merchant account, credit customer account). The original charge and refund are separate records — the audit trail shows both. Refunds take 5-10 business days because the card network processes them in batch settlement.

**Q: What's PCI DSS and how does it affect the architecture?**
A: Payment Card Industry Data Security Standard — rules for handling credit card data. The key architectural impact: you almost never store full card numbers. Instead, use a tokenization service (Stripe, Braintree) that stores the card and returns a token. Your system only touches tokens, never raw card data. This drastically reduces PCI scope — only the tokenization service needs full PCI compliance, not your entire application.

**Q: How would you add support for multiple currencies?**
A: Store amounts as integers in the smallest unit (cents, not dollars: $50.00 = 5000 cents). Store the currency code alongside. Never do floating-point math on money (0.1 + 0.2 ≠ 0.3 in floating point). For cross-currency payments, use a currency conversion service with locked rates at authorization time. The ledger stores amounts in the original currency. Reconciliation handles FX gains/losses as separate ledger entries.

**Q: How does the system handle partial failures (authorized but capture fails)?**
A: The payment state machine handles this. After authorization, if capture fails, the state moves to CAPTURE_FAILED. A recovery process retries the capture with the existing authorization code (authorizations are valid for 7-30 days). If capture still fails after retries, the authorization is voided (releasing the hold on the customer's funds), and the merchant is notified. The state machine ensures no money is permanently in limbo.

---

*Part 5 complete. You've now designed eight real systems — WhatsApp, YouTube, a URL Shortener, Twitter, Uber, Google Search, a Notification System, and a Payment System. Each one exercised concepts from Parts 1-4: estimation, databases, caching, queues, sharding, consensus, geo-routing, event-driven architecture, and failure handling. These aren't theoretical exercises — they're how the systems you use every day actually work, built from the same patterns and trade-offs you've learned throughout this book.*

---

*The book is complete. From "I just write code" to "I can design systems that serve millions" — you now have the vocabulary (Part 1), the tools (Part 2), the patterns (Part 3), the hard distributed systems knowledge (Part 4), and the practiced designs (Part 5) to walk into any system design interview or architecture review with confidence. The difference between knowing these concepts and mastering them is practice: take each design, change the requirements, and see how your trade-offs shift.*
