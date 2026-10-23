# Chapter 6: RPC and the Eight Fallacies of Distributed Computing

## What Assumptions Will Silently Destroy a Distributed System That Seemed Fine in Testing?

In 1994, Peter Deutsch at Sun Microsystems wrote down seven assumptions that developers new to distributed computing invariably make — and that invariably cause systems to fail. James Gosling later added an eighth. These "Eight Fallacies of Distributed Computing" are not theoretical curiosities. They're the reason your staging environment works flawlessly while production burns.

This chapter examines each fallacy in detail, explains *why* each assumption is wrong, quantifies the real-world impact, and shows how the most common distributed abstraction — the Remote Procedure Call (RPC) — either addresses or fails to address each one. We end with a practical framework for designing systems that respect these realities instead of denying them.

---

## 6.1 The Promise of RPC: Making the Network Invisible

Before the fallacies, we need to understand why they exist. Their root cause is a single, seductive idea:

> **"What if calling a function on a remote machine looked exactly like calling a local function?"**

This idea is the Remote Procedure Call (RPC), proposed by Birrell and Nelson in their 1984 paper "Implementing Remote Procedure Calls." The vision:

```
// Local call
result = computeTax(order)

// Remote call — looks identical
result = taxService.computeTax(order)
```

The developer writes the same code. A system called a **stub** or **proxy** intercepts the remote call, serializes the arguments, sends them over the network, waits for the response, deserializes it, and returns it as if it were a local function returning.

```
┌─────────────┐                          ┌─────────────┐
│   Client     │                          │   Server     │
│              │                          │              │
│  client code │                          │  server code │
│      │       │                          │      ▲       │
│      ▼       │                          │      │       │
│  client stub │                          │  server stub │
│      │       │                          │      ▲       │
│      ▼       │                          │      │       │
│   network    │  ═══ request ══════════> │   network    │
│   layer      │  <═══ response ═════════ │   layer      │
└─────────────┘                          └─────────────┘
```

### Modern RPC Frameworks

The concept has evolved through many incarnations:

| Era | Technology | Serialization |
|-----|-----------|---------------|
| 1990s | CORBA, Java RMI, DCOM | Binary (IDL-compiled) |
| 2000s | SOAP/XML-RPC | XML |
| 2010s | REST/JSON (not strictly RPC) | JSON |
| 2015+ | gRPC, Thrift, Avro RPC | Protocol Buffers, Thrift Binary, Avro |

gRPC is the dominant modern RPC framework, used by Google, Netflix, Square, and most microservice architectures. It uses Protocol Buffers for serialization and HTTP/2 for transport:

```protobuf
// tax_service.proto
service TaxService {
  rpc ComputeTax(TaxRequest) returns (TaxResponse);
}

message TaxRequest {
  string order_id = 1;
  double subtotal = 2;
  string jurisdiction = 3;
}

message TaxResponse {
  double tax_amount = 1;
  double total = 2;
}
```

The generated client code looks like a local method call:

```python
# gRPC client — looks like a local call
response = tax_stub.ComputeTax(
    TaxRequest(order_id="ord-123", subtotal=99.99, jurisdiction="CA")
)
print(response.total)  # 108.74
```

This is clean, elegant, and *dangerous* — because it hides everything that can go wrong.

---

## 6.2 Why RPC Is a Leaky Abstraction

Steve Warnock and Jim Waldo, in their 1994 paper "A Note on Distributed Computing," made a devastating argument against location transparency: **remote calls are fundamentally different from local calls in ways that cannot be papered over.**

The differences:

| Property | Local Call | Remote Call |
|----------|-----------|-------------|
| Latency | Nanoseconds (in-process) | Milliseconds to seconds |
| Failure modes | Process crash (all-or-nothing) | Partial failure (request sent, response lost) |
| Memory model | Shared address space | Separate address spaces; must serialize |
| Concurrency | Same thread or explicit threading | Inherently concurrent across machines |
| Retry safety | N/A (no network) | Depends on idempotency |
| Observability | Stack trace | Distributed trace required |
| Versioning | Same binary | Independent deployment; schema drift |

The Eight Fallacies are the specific false assumptions that arise when developers treat remote calls like local calls.

---

## 6.3 Fallacy 1: The Network Is Reliable

**The assumption**: Messages I send will arrive. Connections I establish will stay up. The network is a pipe that just works.

**The reality**: Networks fail constantly, in varied and creative ways.

### Failure Modes

```
                      Types of Network Failure
                      ========================

   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │  Packet  │   │Connection│   │  Switch  │   │  Cable   │
   │   Loss   │   │  Reset   │   │ Failure  │   │   Cut    │
   └──────────┘   └──────────┘   └──────────┘   └──────────┘
   
   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │  DNS     │   │Asymmetric│   │ Network  │   │ BGP Route│
   │ Failure  │   │ Failure  │   │Partition │   │  Leak    │
   └──────────┘   └──────────┘   └──────────┘   └──────────┘
```

### Real-World Data

Google's published data (from "The Tail at Scale," Jeff Dean, 2013) shows that in a large datacenter:
- **A single server has about a 2-4% chance of becoming unreachable** during any given year
- **Network maintenance and switch failures** cause brief partitions regularly
- **In-datacenter round-trip tail latency** (99th percentile) can spike to 10-100× the median

Amazon's internal studies have found that network partitions within a single datacenter are **not rare** — they happen multiple times per year.

### The Two Generals Connection

Chapter 5 proved that you can't achieve guaranteed agreement over an unreliable link. Fallacy 1 is the practical manifestation: developers assume the link is reliable, so they don't plan for the case where it isn't.

### What Happens in Practice

```python
# Code that assumes network reliability
def place_order(order):
    inventory_service.reserve(order.items)     # What if this fails?
    payment_service.charge(order.payment)       # What if this times out?
    shipping_service.schedule(order.address)    # What if this partially succeeds?
    return "Order placed!"                      # All lies.
```

When any of these calls fails, the system is in an inconsistent state. Items might be reserved without payment. Payment might be charged without shipping scheduled.

### How to Design for It

```python
def place_order(order):
    saga_id = generate_saga_id()
    
    try:
        inventory_service.reserve(order.items, saga_id=saga_id)
    except (NetworkError, TimeoutError):
        return retry_or_fail(saga_id, "inventory_reserve")
    
    try:
        payment_service.charge(order.payment, saga_id=saga_id)
    except (NetworkError, TimeoutError):
        compensate(saga_id, "inventory_reserve")  # Undo the reservation
        return retry_or_fail(saga_id, "payment_charge")
    
    try:
        shipping_service.schedule(order.address, saga_id=saga_id)
    except (NetworkError, TimeoutError):
        compensate(saga_id, "payment_charge")
        compensate(saga_id, "inventory_reserve")
        return retry_or_fail(saga_id, "shipping_schedule")
    
    return "Order placed!"
```

Key patterns:
- **Sagas with compensating transactions** (Chapter 26)
- **Idempotency keys** for safe retries
- **Circuit breakers** to fail fast when a service is down
- **Outbox pattern** for reliable event publishing (Chapter 31)

---

## 6.4 Fallacy 2: Latency Is Zero

**The assumption**: A remote call takes the same amount of time as a local call. I can make as many remote calls as I want without worrying about performance.

**The reality**: Network latency is 5-7 orders of magnitude slower than in-process calls, and it varies unpredictably.

### The Numbers

```
Operation                          Time          Relative
─────────────────────────────────────────────────────────
L1 cache reference                 0.5 ns        1x
L2 cache reference                   7 ns        14x
Main memory reference              100 ns        200x
SSD random read              150,000 ns        300,000x    (150 μs)
Same-datacenter round trip   500,000 ns      1,000,000x    (0.5 ms)
Cross-region round trip   80,000,000 ns    160,000,000x    (80 ms)
Cross-continent round trip 200,000,000 ns  400,000,000x    (200 ms)
```

A local function call (in-process) completes in nanoseconds. The same call over the network within a datacenter takes at least 500 microseconds — **a million times slower**. Cross-continent, it's 200 million times slower.

### The "Chatty" API Problem

Latency doesn't just slow things down — it makes certain designs catastrophically slow:

```python
# The N+1 query problem, distributed edition
def get_order_details(order_id):
    order = order_service.get(order_id)              # 1 RPC (2ms)
    customer = customer_service.get(order.customer_id) # 1 RPC (2ms)
    items = []
    for item_id in order.item_ids:                    # N RPCs (2ms each)
        item = catalog_service.get(item_id)
        items.append(item)
    return OrderDetails(order, customer, items)
    
# For an order with 10 items: 12 RPCs × 2ms = 24ms minimum
# For an order with 100 items: 102 RPCs × 2ms = 204ms minimum
# With 99th percentile latency spikes: much worse
```

Compare with the batched version:

```python
def get_order_details(order_id):
    order = order_service.get(order_id)                          # 1 RPC
    customer, items = parallel(
        lambda: customer_service.get(order.customer_id),         # 1 RPC
        lambda: catalog_service.get_batch(order.item_ids),       # 1 RPC
    )
    return OrderDetails(order, customer, items)

# Total: 2 sequential rounds × 2ms = 4ms (vs 24-204ms)
```

### Tail Latency Amplification

When a request fans out to multiple services, the total latency is the **maximum** of all individual latencies, not the average. Jeff Dean's "The Tail at Scale" paper shows why this matters:

```
If a single service has:
  - 1ms median latency
  - 10ms 99th percentile latency

A request that fans out to 100 services:
  - P(all < 10ms) = 0.99^100 = 0.366
  - 63.4% of requests will hit at least one 99th percentile tail!
```

With 100 services, the **median** end-to-end latency of a fan-out request is dominated by tail latencies of individual services.

### How to Design for It

1. **Batch RPCs**: Combine multiple calls into a single request.
2. **Parallelize independent calls**: Use futures/async to run non-dependent calls concurrently.
3. **Cache aggressively**: Store frequently accessed remote data locally.
4. **Use hedged requests**: Send the same request to multiple replicas; use the first response. (Dean & Barroso, 2013)
5. **Set and enforce deadlines**: Propagate timeout budgets across service boundaries.

```python
# gRPC deadline propagation
def handle_request(request, context):
    remaining = context.time_remaining()
    
    # Pass reduced deadline to downstream calls
    downstream_deadline = remaining - timedelta(milliseconds=50)  # Reserve 50ms
    
    if downstream_deadline <= timedelta(0):
        raise DeadlineExceeded("Not enough time budget remaining")
    
    response = downstream_stub.Call(
        downstream_request,
        timeout=downstream_deadline.total_seconds()
    )
```

---

## 6.5 Fallacy 3: Bandwidth Is Infinite

**The assumption**: I can send as much data as I want between services without worrying about the size.

**The reality**: Bandwidth is finite, shared, and expensive — especially across datacenters and regions.

### The Numbers

```
Link Type                  Bandwidth        Cost (approx)
──────────────────────────────────────────────────────────
Same-machine (loopback)    ~50 Gbps         Free
Same-rack                  10-25 Gbps       Cheap
Same-datacenter            1-10 Gbps        Moderate
Cross-region (cloud)       Limited*         $0.01-0.02/GB
Cross-continent            Limited*         $0.02-0.15/GB

* Cloud providers throttle cross-region bandwidth and charge premium rates
```

### The Hidden Cost of Serialization

Large payloads don't just use bandwidth — they consume CPU for serialization and deserialization. The choice of serialization format matters enormously:

```
Format          Relative Size    Serialize Speed    Deserialize Speed
────────────────────────────────────────────────────────────────────
JSON            1.0x (baseline)  1.0x               1.0x
Protocol Buffers 0.3-0.5x       3-10x faster       3-10x faster
MessagePack     0.5-0.7x        2-5x faster        2-5x faster
XML             1.5-2.0x        0.3-0.5x slower    0.3-0.5x slower
```

### How to Design for It

1. **Use efficient serialization**: Protocol Buffers or FlatBuffers instead of JSON for high-throughput internal services.
2. **Compress large payloads**: gRPC supports gzip compression natively.
3. **Paginate results**: Never return unbounded collections.
4. **Use field masks**: Let the client specify which fields it needs.

```protobuf
// gRPC field mask — request only the fields you need
message GetUserRequest {
  string user_id = 1;
  google.protobuf.FieldMask field_mask = 2;
  // Client sends: field_mask { paths: ["name", "email"] }
  // Server returns only name and email, not the entire user object
}
```

---

## 6.6 Fallacy 4: The Network Is Secure

**The assumption**: I can trust data that arrives over the network. Internal services don't need authentication.

**The reality**: Networks are hostile environments, even inside your own datacenter.

### Internal Network Threats

The "perimeter security" model (hard outer shell, soft interior) has been proven inadequate by every major breach of the last decade:

- **Lateral movement**: An attacker who compromises one service can reach all internal services
- **Man-in-the-middle**: Without TLS, any machine on the network path can read and modify traffic
- **Service impersonation**: Without mutual authentication, any process can pretend to be any service
- **DNS spoofing**: Internal DNS can be poisoned to redirect traffic

### Zero Trust Architecture

Modern distributed systems use **zero trust**: every request is authenticated and authorized, regardless of network location.

```
Traditional (Perimeter Security):
  Internet → [Firewall] → Trusted Internal Network
                           (everything trusts everything)

Zero Trust:
  Every service → [mTLS + AuthZ] → Every other service
  (nothing trusts anything by default)
```

**Mutual TLS (mTLS)** is the foundation: both client and server present certificates, proving their identity to each other.

```
Client Service                              Server Service
     |                                           |
     |--- ClientHello ------------------------------>|
     |<--- ServerHello + ServerCert + CertRequest ---|
     |--- ClientCert + KeyExchange ----------------->|
     |<--- Finished (encrypted) ---------------------|
     |                                           |
     | (Both sides verified; encrypted channel)  |
```

Service meshes like Istio and Linkerd automate mTLS between all services in a Kubernetes cluster, making zero trust practical without code changes.

### How to Design for It

1. **Use mTLS** for all service-to-service communication.
2. **Authenticate and authorize every request**, even internal ones.
3. **Encrypt data in transit and at rest.**
4. **Use service mesh** for automatic mTLS and policy enforcement.
5. **Rotate credentials automatically** — don't embed secrets in code.

---

## 6.7 Fallacy 5: Topology Doesn't Change

**The assumption**: The network layout — which machines exist, their IP addresses, the routing between them — is static.

**The reality**: In modern cloud and container environments, topology changes constantly.

### What Changes and Why

```
Event                          Frequency in Production
──────────────────────────────────────────────────────
Container restart              Multiple times per day
Auto-scaling (new instances)   Hourly during load changes
Deployment (rolling update)    Multiple times per day
Node failure/replacement       Weekly
Availability zone failover     Annually (but happens)
Region migration               Rare (but disastrous if not designed for)
```

In a Kubernetes cluster, pod IP addresses are ephemeral. A service that was at `10.0.0.42` five minutes ago might now be at `10.0.1.87`. DNS entries change. Load balancer targets update. The entire network graph is in constant flux.

### How to Design for It

1. **Service discovery**: Use DNS-based or registry-based service discovery (Consul, etcd, Kubernetes Services) instead of hardcoded addresses.
2. **Client-side load balancing**: Let clients resolve multiple endpoints and distribute load.
3. **Health checks**: Continuously verify that endpoints are alive.
4. **Graceful shutdown**: Drain connections before stopping a service instance.

```python
# Anti-pattern: hardcoded address
payment_client = PaymentClient("10.0.0.42:8080")

# Pattern: service discovery
payment_client = PaymentClient("payment-service.default.svc.cluster.local:8080")

# Better: client-side load balancing with health checks
payment_client = PaymentClient(
    discovery="consul://payment-service",
    health_check_interval=5,
    retry_policy=RetryPolicy(max_retries=3, backoff="exponential")
)
```

---

## 6.8 Fallacy 6: There Is One Administrator

**The assumption**: One person or team controls the entire network and all the services on it. Changes are coordinated and consistent.

**The reality**: In any non-trivial system, multiple teams, organizations, or even companies control different parts of the infrastructure.

### The Organizational Boundary Problem

```
Your Company
├── Team A: Order Service (Go, Kubernetes)
├── Team B: Payment Service (Java, ECS)
├── Team C: Inventory Service (Python, Lambda)
└── External
    ├── Stripe API (third-party payment processor)
    ├── Twilio (notification service)
    └── AWS (infrastructure provider)
```

Each team and provider has its own:
- Deployment schedule
- Change management process
- SLA commitments
- Incident response procedures
- Upgrade timelines

### Consequences

- **Uncoordinated changes**: Team B upgrades their gRPC version; their response headers change; Team A's client parsing breaks.
- **Conflicting SLAs**: Your service promises 99.99% uptime, but depends on a vendor with 99.9% SLA. You can't make promises your dependencies can't keep.
- **Different security policies**: Team A requires mTLS; Team C's Lambda functions don't support it; now you need a compatibility layer.

### How to Design for It

1. **Define clear API contracts** with schema versioning (Chapter 30 covers schema evolution).
2. **Assume external dependencies will change without notice.** Wrap them in anti-corruption layers.
3. **Budget your SLA**: If you depend on 5 services each at 99.9%, your theoretical maximum availability is 0.999⁵ = 99.5%.
4. **Use contract testing**: Verify that your assumptions about other teams' APIs still hold.

---

## 6.9 Fallacy 7: Transport Cost Is Zero

**The assumption**: Sending data across the network is free — no CPU cost, no money cost, no infrastructure cost.

**The reality**: Every byte transmitted costs compute (serialization), network (bandwidth), and often real money.

### The Hidden Costs of RPC

A single gRPC call involves:

```
Client Side:
  1. Serialize request (CPU)
  2. Compress payload (CPU)
  3. TLS encrypt (CPU)
  4. TCP send + wait (network I/O, thread blocked or context switch)
  5. TLS decrypt response (CPU)
  6. Decompress response (CPU)
  7. Deserialize response (CPU)
  8. Memory allocation for request/response objects (memory)

Server Side:
  1-7: Mirror of client operations
  8. Thread/goroutine allocation (memory, scheduling)
  9. Connection tracking (memory)
  10. Load balancer processing (additional hop)
```

Each step has a cost. At high throughput, these costs dominate.

### Cloud Egress Costs

Cross-region and cross-cloud data transfer is surprisingly expensive:

```
AWS Data Transfer Pricing (approximate, 2024):
  Same AZ:           Free
  Cross-AZ:          $0.01/GB each direction
  Cross-region:      $0.02/GB
  To internet:       $0.09/GB (first 10TB/month)

A service sending 1TB/day cross-region:
  Monthly cost: 30 × $0.02 × 1000 = $600/month just for data transfer
```

### How to Design for It

1. **Minimize cross-boundary calls**: Co-locate services that communicate frequently.
2. **Use efficient serialization**: Protocol Buffers over JSON saves 50-70% bandwidth.
3. **Aggregate and batch**: One call with 100 items is cheaper than 100 calls with 1 item.
4. **Monitor data transfer costs**: Cloud bills reveal chatty services.

---

## 6.10 Fallacy 8: The Network Is Homogeneous

**The assumption**: All parts of the network use the same protocols, have the same capabilities, and behave the same way.

**The reality**: Production networks are heterogeneous in every dimension.

### Heterogeneity in Practice

```
                        ┌─────────────────┐
                        │  Mobile Client   │
                        │  (4G/WiFi, high  │
                        │   latency, lossy)│
                        └────────┬─────────┘
                                 │
                        ┌────────▼─────────┐
                        │   API Gateway     │
                        │   (HTTP/JSON)     │
                        └────────┬─────────┘
                                 │
               ┌─────────────────┼─────────────────┐
               │                 │                  │
      ┌────────▼──────┐ ┌───────▼───────┐ ┌───────▼───────┐
      │ gRPC Service  │ │  REST Service  │ │ Legacy SOAP   │
      │ (Proto3, H/2) │ │  (JSON, H/1.1)│ │ (XML, H/1.1)  │
      └───────────────┘ └───────────────┘ └───────────────┘
```

Different parts of the system might use:
- Different protocols (HTTP/1.1, HTTP/2, WebSocket, raw TCP)
- Different serialization formats (JSON, Protocol Buffers, Avro, XML)
- Different authentication mechanisms (OAuth2, mTLS, API keys)
- Different network characteristics (datacenter fiber vs. mobile 4G)

### How to Design for It

1. **Use API gateways** to translate between external and internal protocols.
2. **Design for the lowest common denominator** at system boundaries (e.g., JSON for external APIs, Protobuf internally).
3. **Abstract transport details**: Your business logic shouldn't care whether it's talking HTTP/1.1 or HTTP/2.
4. **Test with realistic network conditions**: Use traffic shaping tools (tc, toxiproxy) to simulate mobile networks in your test environment.

---

## 6.11 RPC Failure Semantics: The Missing Manual

The fallacies explain what can go wrong. But when an RPC fails, the critical question is: **what exactly happened?** RPC defines three failure semantics that determine what guarantees the system provides:

### At-Most-Once

The call is executed zero or one times. If the client gets an error, it doesn't know which.

```
Client                    Server
  |--- request ----------->|  (server executes)
  |                         |
  |<-- response (success) --|  → executed exactly once
  
OR:

  |--- request ----------->|  (server executes)
  |                         |
  |    (response lost)      |  → executed once, client doesn't know
  |    TIMEOUT              |
  
OR:

  |--- request ----X        |  (request lost)
  |                         |
  |    TIMEOUT              |  → executed zero times, client doesn't know
```

**Used by**: Most RPC frameworks by default. The client sees either success or timeout/error.

### At-Least-Once

If the client doesn't get a response, it retries until it does. The call might be executed multiple times.

```
Client                    Server
  |--- request ----------->|  (executes, response lost)
  |    TIMEOUT             |
  |--- request (retry) --->|  (executes AGAIN)
  |<-- response -----------|  → executed twice!
```

**Safe only for idempotent operations**: Reading a value, setting a value to a specific number. **Dangerous for non-idempotent operations**: Incrementing a counter, charging a credit card, sending an email.

### Exactly-Once (The Holy Grail)

Each call is executed exactly one time, regardless of network failures.

**True exactly-once is impossible** in the general case (a consequence of the Two Generals Problem from Chapter 5). What systems call "exactly-once" is actually "effectively-once": **at-least-once delivery + idempotent processing**.

```python
# Server-side idempotent processing
class IdempotentServer:
    def __init__(self):
        self.executed_requests = {}  # request_id → result
    
    def handle(self, request_id, operation):
        # Check if we've already processed this request
        if request_id in self.executed_requests:
            return self.executed_requests[request_id]  # Return cached result
        
        # First time seeing this request — execute it
        result = operation()
        self.executed_requests[request_id] = result  # Cache for dedup
        return result
```

The client retries with the same `request_id`. The server deduplicates. The combination provides "effectively-once" semantics.

---

## 6.12 Designing RPC-Based Systems That Survive

Given the eight fallacies and the failure semantics, here's a practical checklist for designing robust distributed systems:

### Checklist: Every RPC Call

```
□ What happens if this call times out?
    → Is there a compensating action?
    → Is the operation idempotent (safe to retry)?
    → What state is the system in if I don't know the outcome?

□ What happens if latency spikes to 10× normal?
    → Is there a deadline/timeout budget?
    → Will upstream callers also time out?
    → Can I serve a degraded response from cache?

□ What happens if this service goes down entirely?
    → Is there a circuit breaker?
    → Is there a fallback?
    → Can the system continue in a degraded state?

□ What happens if the response is corrupted or truncated?
    → Am I validating the response schema?
    → Am I checking content length / checksums?

□ What happens if this call is made twice?
    → Is the server idempotent?
    → Will a duplicate cause incorrect state?
```

### A Robust RPC Client Pattern

```python
class ResilientServiceClient:
    def __init__(self, service_name, timeout_ms=2000, max_retries=3):
        self.service_name = service_name
        self.timeout = timeout_ms
        self.max_retries = max_retries
        self.circuit_breaker = CircuitBreaker(
            failure_threshold=5,
            recovery_timeout=30
        )
    
    def call(self, method, request, idempotency_key=None):
        if self.circuit_breaker.is_open():
            raise ServiceUnavailable(f"{self.service_name} circuit open")
        
        last_error = None
        for attempt in range(self.max_retries + 1):
            try:
                # Resolve current endpoint via service discovery
                endpoint = self.discover(self.service_name)
                
                # Set deadline that decreases with each retry
                remaining_budget = self.timeout - (attempt * 200)
                if remaining_budget <= 0:
                    raise DeadlineExceeded("Timeout budget exhausted")
                
                response = self._send(
                    endpoint, method, request,
                    timeout=remaining_budget,
                    idempotency_key=idempotency_key
                )
                
                self.circuit_breaker.record_success()
                return response
                
            except RetryableError as e:
                last_error = e
                self.circuit_breaker.record_failure()
                
                if attempt < self.max_retries:
                    backoff = min(2 ** attempt * 100, 2000)  # Exponential backoff
                    jitter = random.uniform(0, backoff * 0.1)
                    time.sleep((backoff + jitter) / 1000)
                    
            except NonRetryableError as e:
                self.circuit_breaker.record_failure()
                raise
        
        raise MaxRetriesExceeded(last_error)
```

### Key Design Principles

1. **Timeouts on every call.** Never make an RPC without a timeout. Propagate deadline budgets across service boundaries.

2. **Retries with backoff.** Use exponential backoff with jitter to avoid thundering herds. Only retry idempotent operations, or operations with idempotency keys.

3. **Circuit breakers.** Stop sending requests to a service that's failing. Let it recover. Serve degraded responses in the meantime.

4. **Bulkheads.** Isolate failures. Don't let one slow service consume all your threads/connections and take down unrelated functionality.

5. **Idempotency keys.** Every mutating RPC should carry a client-generated unique key. The server deduplicates. This enables safe retries.

---

## 6.13 The Waldo Critique: Why Location Transparency Is a Flawed Goal

Jim Waldo, Geoff Wyant, Ann Wollrath, and Sam Kendall published "A Note on Distributed Computing" (1994), arguing that the entire premise of RPC — making remote calls look like local calls — is fundamentally misguided.

Their argument: **treating remote and local objects identically leads to systems that are either unreliable (ignoring network failures) or unusable (handling network failures on every local call).**

The alternatives they propose:

1. **Make the network explicit.** Don't hide the fact that a call is remote. Let the developer see timeouts, retries, and failure modes in the API.

2. **Design for partial failure.** Local computations either succeed entirely or fail entirely (the process crashes). Remote computations can *partially* succeed: the request was processed, but the response was lost. Design APIs that acknowledge this.

3. **Use asynchronous messaging** instead of synchronous RPC where possible. A message queue (Kafka, RabbitMQ) naturally handles: retries (redelivery), partial failure (dead-letter queues), and latency (the sender doesn't wait).

```python
# Synchronous RPC: hides the network, fragile
def process_order(order):
    inventory_service.reserve(order.items)      # Blocks, might fail
    payment_service.charge(order.total)         # Blocks, might fail
    notification_service.send_confirmation()    # Blocks, might fail

# Asynchronous messaging: network-aware, resilient
def process_order(order):
    message_bus.publish("orders.created", {
        "order_id": order.id,
        "items": order.items,
        "total": order.total,
    })
    # Each downstream service consumes the event independently
    # Failures are handled by each service with retries and DLQs
```

This doesn't mean RPC is always wrong — it means you should choose RPC consciously, knowing its limitations, rather than defaulting to it because it looks like a local function call.

---

## 6.14 Modern RPC: How gRPC Addresses the Fallacies

gRPC, the dominant modern RPC framework, addresses several (but not all) of the fallacies:

| Fallacy | gRPC's Response | Remaining Gap |
|---------|----------------|---------------|
| 1. Network unreliable | Deadlines, retry policies, health checks | Developer must configure; not automatic |
| 2. Latency non-zero | HTTP/2 multiplexing, streaming, header compression | Doesn't eliminate latency; reduces overhead |
| 3. Bandwidth finite | Protocol Buffers (compact), compression | Developer must choose message sizes wisely |
| 4. Network insecure | Built-in TLS, per-call credentials | Developer must configure mTLS |
| 5. Topology changes | Name resolution plugins, client-side LB | Requires service discovery infrastructure |
| 6. Multiple admins | Schema-first development (`.proto` files) | Schema evolution still hard |
| 7. Transport costs | Efficient binary protocol | Cross-region costs still real |
| 8. Heterogeneous | Multi-language code generation | Not all clients support gRPC (browsers need gRPC-Web) |

gRPC helps with the mechanics but cannot solve the fundamental problems. The developer still must reason about failure modes, design for partial failure, and choose the right consistency guarantees.

---

## 6.15 Measuring Network Reality: What to Monitor

You can't design for what you don't measure. Here's what to monitor in any RPC-based system:

```
Metric                      What It Reveals
─────────────────────────────────────────────────────
Request rate (req/s)        Load level
Error rate (% failures)     Reliability
Latency (p50, p95, p99)     User experience and tail effects
Timeout rate                Network or server saturation
Retry rate                  Hidden failures
Circuit breaker trips       Persistent downstream failures
Connection pool exhaustion  Thread/connection leaks
Serialization time          CPU cost of data format choice
DNS resolution time         Service discovery health
TLS handshake time          Certificate/encryption overhead
```

The **RED method** (Rate, Errors, Duration) is the minimum viable monitoring for any RPC service.

---

## 6.16 Key Takeaways

1. **RPC tries to make remote calls look like local calls.** This is useful but dangerous — the abstraction hides critical differences in latency, failure modes, and consistency.

2. **The Eight Fallacies** are assumptions about the network that seem true in development but fail catastrophically in production:
   - The network is reliable → it isn't; design for failure
   - Latency is zero → it isn't; batch, parallelize, cache
   - Bandwidth is infinite → it isn't; use efficient serialization
   - The network is secure → it isn't; use mTLS and zero trust
   - Topology doesn't change → it does; use service discovery
   - There is one administrator → there isn't; define clear contracts
   - Transport cost is zero → it isn't; minimize cross-boundary calls
   - The network is homogeneous → it isn't; use protocol translation

3. **RPC failure semantics** (at-most-once, at-least-once, exactly-once) determine what guarantees your system provides. True exactly-once is impossible; "effectively-once" requires idempotent processing.

4. **The Waldo critique** argues that location transparency is fundamentally flawed. Making the network explicit — through timeouts, retries, and asynchronous messaging — produces more reliable systems than hiding it.

5. **Every RPC call needs**: a timeout, a retry strategy (if idempotent), a circuit breaker, and monitoring. No exceptions.

6. **Modern frameworks like gRPC** help with serialization, transport, and code generation, but cannot solve the fundamental fallacies. The developer must design for network reality.

---

## 6.17 Further Reading

- **Birrell, A.D. and Nelson, B.J.** (1984). "Implementing Remote Procedure Calls." *ACM Transactions on Computer Systems*, 2(1), 39-59.
- **Waldo, J., Wyant, G., Wollrath, A., and Kendall, S.** (1994). "A Note on Distributed Computing." Sun Microsystems Technical Report TR-94-29.
- **Deutsch, P.** (1994). "The Eight Fallacies of Distributed Computing." Sun Microsystems internal memo.
- **Dean, J. and Barroso, L.A.** (2013). "The Tail at Scale." *Communications of the ACM*, 56(2), 74-80.
- **gRPC documentation**: https://grpc.io/docs/

---

*Next: Chapter 7 confronts the most immediate practical consequence of unreliable networks — how does a system decide that another machine is dead, when it might just be slow?*
