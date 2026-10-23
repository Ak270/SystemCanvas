# Chapter 2: Networking Primitives — TCP, UDP, Latency, and Packet Loss

## Why a Distributed Systems Book Covers Networking

You already know that services talk over the network. You've used HTTP, gRPC, and message queues. But most distributed systems bugs aren't in the application logic — they're in the assumptions the application makes about the network.

When a Senior Engineer says "it works on my machine," they're usually right — because on a single machine, the "network" between two processes is a kernel memory copy that takes microseconds and never fails. The moment that communication crosses a physical wire, everything changes.

This chapter takes you to the wire level. We'll trace the life of a packet from application to destination and back, understand where failures happen, and build intuition for the latency numbers that govern every distributed systems design decision.

---

## The Network Stack: A Quick Refresher

When your application calls `socket.send(data)`, the data passes through several layers before hitting the wire:

```
┌─────────────────────────┐
│   Application Layer     │  Your code: HTTP, gRPC, custom protocol
├─────────────────────────┤
│   Transport Layer       │  TCP or UDP: reliability, flow control, ports
├─────────────────────────┤
│   Network Layer         │  IP: addressing, routing between networks
├─────────────────────────┤
│   Link Layer            │  Ethernet/WiFi: frames on the physical medium
├─────────────────────────┤
│   Physical Layer        │  Electrical signals, light pulses, radio waves
└─────────────────────────┘
```

For distributed systems, the Transport and Network layers matter most. The Application layer is where your protocol runs. Everything below IP is handled by hardware and the OS kernel.

---

## UDP: The Bare Minimum

UDP (User Datagram Protocol) is the simplest transport protocol. It adds almost nothing on top of IP:

```
UDP Header (8 bytes):
┌─────────────────────┬─────────────────────┐
│  Source Port (16b)   │  Dest Port (16b)    │
├─────────────────────┼─────────────────────┤
│  Length (16b)        │  Checksum (16b)     │
└─────────────────────┴─────────────────────┘
│                Payload                      │
└─────────────────────────────────────────────┘
```

### What UDP Gives You

1. **Multiplexing via ports.** Multiple applications on the same machine can send and receive packets independently.
2. **Integrity check.** The checksum detects (most) corruption in transit.
3. **Framing.** Each `send()` maps to exactly one datagram. The receiver gets complete messages, not a stream of bytes.

### What UDP Does NOT Give You

1. **No delivery guarantee.** A sent datagram might never arrive.
2. **No ordering guarantee.** Datagram A sent before datagram B might arrive after B.
3. **No duplicate detection.** The same datagram might arrive twice.
4. **No flow control.** If you send faster than the receiver can process, datagrams are silently dropped.
5. **No congestion control.** If you flood the network, UDP won't slow down — it'll just keep sending until the network collapses.

### When Distributed Systems Use UDP

UDP is used where **speed matters more than reliability**, and the application handles loss at a higher level:

- **DNS.** A query is a single datagram. If it's lost, the resolver retries. The simplicity of UDP means DNS servers can handle millions of queries per second.
- **Failure detectors.** Gossip protocols (Chapter 8) send heartbeats over UDP because a lost heartbeat simply triggers the next scheduled probe — no connection overhead needed.
- **Real-time metrics.** StatsD sends metrics over UDP because dropping a data point is better than blocking the application.
- **NTP.** Clock synchronization packets use UDP because the timestamps must reflect actual send/receive times without TCP's buffering delays.

### UDP in Code

```python
import socket

# Sender
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.sendto(b"heartbeat:node-5:alive", ("10.0.1.20", 9090))
# Returns immediately. No confirmation that the packet arrived.

# Receiver
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(("0.0.0.0", 9090))
data, addr = sock.recvfrom(1024)
# data = b"heartbeat:node-5:alive"
# But we have no idea if this is the first time we received this,
# or if we missed 10 heartbeats before this one.
```

---

## TCP: Reliable, Ordered, Byte-Stream Delivery

TCP (Transmission Control Protocol) is the workhorse of distributed systems. Almost every inter-service communication — HTTP, gRPC, database connections, replication streams — runs over TCP.

TCP provides the illusion of a reliable, ordered, bidirectional byte stream between two endpoints. Under the hood, it does an enormous amount of work to maintain this illusion.

### The Three-Way Handshake

Before any data can flow, TCP establishes a connection:

```
Client                                    Server
  |                                          |
  |--- SYN (seq=x) -----------------------> |  "I want to connect"
  |                                          |
  |<-- SYN-ACK (seq=y, ack=x+1) ----------- |  "OK, I acknowledge your seq"
  |                                          |
  |--- ACK (ack=y+1) ---------------------> |  "I acknowledge yours"
  |                                          |
  |  Connection established. Data can flow.  |
  |                                          |
```

**Cost of the handshake: 1 round trip (1 RTT).**

Within the same datacenter (RTT ≈ 0.5 ms), this is negligible. Between US coasts (RTT ≈ 40 ms), establishing a new TCP connection costs 40 ms before any data is sent. Between continents (RTT ≈ 80-150 ms), it's even worse.

This is why **connection pooling** is critical in distributed systems. Establishing a new TCP connection for every RPC call would waste enormous amounts of time.

```python
# Bad: new connection per request
def call_service(request):
    conn = create_tcp_connection("service-b:8080")  # 1 RTT wasted
    conn.send(request)
    return conn.recv()

# Good: reuse connections from a pool
pool = ConnectionPool("service-b:8080", max_size=100)
def call_service(request):
    conn = pool.get()  # instant: connection already established
    conn.send(request)
    response = conn.recv()
    pool.put(conn)
    return response
```

### TLS Adds More Round Trips

If the connection uses TLS (and it should — even within your datacenter), the TLS handshake adds 1-2 more round trips on top of the TCP handshake:

```
TCP handshake:     1 RTT
TLS 1.2:           2 RTT (additional)
TLS 1.3:           1 RTT (additional)
TLS 1.3 0-RTT:     0 RTT (for resumed connections)

Total to first byte:
  - TCP + TLS 1.2:  3 RTT  (120 ms at 40 ms RTT)
  - TCP + TLS 1.3:  2 RTT  (80 ms at 40 ms RTT)
  - Resumed TLS:    1 RTT  (40 ms at 40 ms RTT)
```

At intercontinental distances, a fresh TLS 1.2 connection costs nearly half a second before any application data is sent. This is why HTTP/2 and gRPC multiplex many requests over a single connection — the handshake cost is amortized.

### Sequence Numbers, ACKs, and Retransmission

TCP assigns a sequence number to every byte of data. The receiver acknowledges bytes by their sequence number, telling the sender "I've received everything up to byte N."

```
Sender                                          Receiver
  |                                                |
  |--- [seq=1000, 500 bytes] --------------------> |
  |                                                |  (received bytes 1000-1499)
  |<-- [ack=1500] -------------------------------- |  "send me byte 1500 next"
  |                                                |
  |--- [seq=1500, 500 bytes] ---X  (packet lost)   |
  |                                                |  (waiting...)
  |--- [seq=2000, 500 bytes] --------------------> |
  |                                                |  (received 2000-2499, but 
  |                                                |   missing 1500-1999!)
  |<-- [ack=1500] -------------------------------- |  "I still need byte 1500"
  |<-- [ack=1500] -------------------------------- |  (duplicate ack)
  |<-- [ack=1500] -------------------------------- |  (triple duplicate ack)
  |                                                |
  |  Sender detects: 3 duplicate acks → packet lost
  |--- [seq=1500, 500 bytes] --------------------> |  (retransmit)
  |                                                |  (now has everything)
  |<-- [ack=2500] -------------------------------- |  "send me byte 2500 next"
```

This retransmission is **invisible to the application**. Your `recv()` call simply blocks until the retransmitted packet arrives and the kernel can deliver a contiguous stream of bytes. But the delay is real — a single lost packet can stall the stream for an entire RTT while the retransmission happens.

### Head-of-Line Blocking

TCP guarantees ordered delivery. This means if packet 5 out of 10 is lost, packets 6-10 (which arrived fine) must wait in the kernel's receive buffer until packet 5 is retransmitted and arrives. The application sees nothing until the gap is filled.

```
Sent:     [P1] [P2] [P3] [P4] [P5] [P6] [P7] [P8]
Received: [P1] [P2] [P3] [P4] [  ] [P6] [P7] [P8]
                                ↑
                           P5 lost — P6-P8 must wait

Application's recv() blocks for ~1 RTT while P5 is retransmitted.
P6, P7, P8 were available immediately but can't be delivered out of order.
```

This is **head-of-line (HOL) blocking**, and it's one of TCP's most significant performance problems for distributed systems. If you're multiplexing many independent requests over a single TCP connection (as HTTP/2 does), a single lost packet stalls *all* in-flight requests.

This is why QUIC (used by HTTP/3) runs over UDP and implements its own reliability — it can deliver streams independently, so one stream's packet loss doesn't block another stream.

### TCP Flow Control: The Receive Window

TCP prevents a fast sender from overwhelming a slow receiver using a **receive window**. The receiver advertises how much buffer space it has, and the sender limits its in-flight data accordingly.

```
Receiver advertises: "My receive window is 64 KB"
Sender can have at most 64 KB of unacknowledged data in flight.

If the receiver's application is slow to read data:
  - Receive buffer fills up
  - Receiver advertises window = 0
  - Sender stops sending (flow-controlled)
  - When the application reads data, the window opens again
```

This is how a slow consumer naturally applies **backpressure** to a fast producer, a concept that reappears throughout distributed systems design. Without flow control, the fast producer would send data until the receiver's buffers overflow and packets are dropped — wasting bandwidth on data that will just be lost.

### TCP Congestion Control: Don't Collapse the Network

Flow control prevents overwhelming the receiver. **Congestion control** prevents overwhelming the *network*.

TCP starts with a small **congestion window** (typically 10 segments, or about 14 KB) and gradually increases it as acknowledgments arrive, probing for available bandwidth:

```
Congestion Window over time (simplified):

cwnd
 │
 │                    ╱ (linear growth: congestion avoidance)
 │                   ╱
 │                  ╱
 │          ╱──────╱ ← ssthresh (slow start threshold)
 │         ╱
 │        ╱ (exponential growth: slow start)
 │       ╱
 │      ╱
 │─────╱
 └──────────────────────────── time
       ↑
  Connection established
  (cwnd = ~14 KB)
```

**Slow start** is misleadingly named — it's actually exponential growth. The window doubles every RTT until it hits a threshold or detects packet loss. Then it switches to **congestion avoidance** (linear growth).

When packet loss is detected:
- **TCP Reno/Cubic:** Halves the congestion window and resumes linear growth.
- **TCP BBR (Google):** Estimates bottleneck bandwidth and RTT, and targets the optimal operating point.

**Impact on distributed systems:** A fresh TCP connection starts with a tiny congestion window. On a 40 ms RTT link, it takes several round trips to ramp up to full bandwidth. A request-response protocol that opens a new connection per request pays this ramp-up cost every time — another reason connection pooling matters.

```
Time to transmit 1 MB over a fresh TCP connection (40 ms RTT):

  - Handshake:          40 ms  (1 RTT)
  - Slow start ramp-up: ~200 ms (5 RTTs to reach ~450 KB window)
  - Data transfer:      ~80 ms
  - Total:              ~320 ms

With a pre-warmed connection (cwnd already large):
  - Data transfer:      ~80 ms
  - Total:              ~80 ms

4x improvement from connection reuse.
```

---

## Where Packets Get Lost

Understanding *where* packets are lost helps you design systems that handle loss gracefully.

### 1. Network Interface Card (NIC) Ring Buffer Overflow

The NIC has a small hardware buffer (ring buffer) where incoming packets wait for the kernel to process them. If the kernel is busy (e.g., handling a garbage collection pause, processing interrupts for another device), the ring buffer fills up and new packets are **silently dropped**.

```
NIC Ring Buffer (typically 256-4096 entries):

[pkt] [pkt] [pkt] [pkt] [pkt] [pkt] [pkt] [pkt] ... [FULL]
                                                         ↑
                                              New packet arrives → DROPPED

Check drops: ethtool -S eth0 | grep rx_dropped
```

This is a common source of packet loss in high-throughput systems. The kernel never sees the packet, so there's no log entry — the packet simply vanishes.

### 2. Kernel Socket Buffer Overflow

After the NIC, packets move to the kernel's socket receive buffer. If the application doesn't call `recv()` fast enough, this buffer fills up and the kernel drops packets (for UDP) or stops acknowledging them (for TCP, triggering flow control).

```python
# Default Linux socket buffer: 128 KB - 256 KB
# For high-throughput systems, increase it:
sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)  # 4 MB
```

### 3. Switch and Router Buffer Overflow

Network switches have limited buffer memory. When multiple input ports send traffic to the same output port, the output buffer can fill up. The switch must then drop packets.

```
        Port 1 (1 Gbps) ──┐
        Port 2 (1 Gbps) ──┼──→ Output Port (1 Gbps)
        Port 3 (1 Gbps) ──┘         ↑
                                 Buffer overflow!
                                 3 Gbps in, 1 Gbps out
```

This is called **incast** and is a well-known problem in datacenter networks, especially with patterns like MapReduce where many workers send results to a single reducer simultaneously.

### 4. Routing Changes and Black Holes

When a router's routing table changes (due to a link failure, a BGP update, or a configuration change), packets can be **black-holed** — sent to a destination that doesn't exist or can't forward them — for seconds to minutes while routing converges.

BGP convergence after a link failure can take 30-90 seconds. During this time, some paths through the Internet simply don't work.

### 5. Firewall and Security Group Rules

Cloud security groups and firewalls can silently drop packets. This is especially insidious because:
- The sender gets no error (the packet is dropped, not rejected)
- The behavior looks exactly like a network partition
- It can be asymmetric: A can reach B, but B can't reach A

```
Common cloud gotcha:

  Service A (security group: allow outbound to B)
  Service B (security group: allow inbound from A on port 8080)

  A → B on port 8080:  ✓ works
  A → B on port 9090:  ✗ silently dropped (not in security group)
  B → A on port 8080:  ✗ silently dropped (A doesn't allow inbound from B)
```

### 6. TCP Connection Resets

A TCP connection can be killed by an intermediary (a load balancer, a NAT gateway, a firewall) that has a connection timeout. The intermediary drops its state for the connection, and when the next packet arrives, it responds with a TCP RST (reset).

```
Timeline:
  t=0    Client and Server establish TCP connection
  t=0    NAT gateway records the connection (timeout: 5 minutes)
  t=3m   Client and Server are idle (no packets)
  t=5m   NAT gateway's connection timer expires. State deleted.
  t=6m   Client sends data on the connection
  t=6m   NAT gateway doesn't recognize this connection → sends RST
  t=6m   Client sees "Connection reset by peer"
```

This is why long-lived TCP connections (database connections, gRPC streams) need **keepalive packets** — periodic empty messages that prevent intermediaries from timing out the connection.

```python
# Enable TCP keepalives
sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60)    # seconds before probes
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10)   # seconds between probes
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 5)      # probes before giving up
```

---

## Latency: The Numbers You Must Know

Every distributed system design decision is constrained by latency. Here are the numbers that matter, along with context for why they matter.

### Within a Datacenter

```
Operation                          Latency        Notes
───────────────────────────────────────────────────────────────
Localhost loopback (same machine)  ~10 μs         Kernel memory copy
Same rack (top-of-rack switch)     ~100 μs        1 switch hop
Same datacenter (spine switch)     ~300-500 μs    2-3 switch hops
Same datacenter, 99th percentile   ~1-5 ms        Includes queuing delays
```

Within a datacenter, network latency is small compared to application processing time. A database query that takes 5 ms to execute pays 0.5 ms for the round trip — a 10% overhead.

### Between Datacenters

```
Route                              Latency (RTT)   Notes
───────────────────────────────────────────────────────────────
Same region (us-east-1a to 1b)     ~1 ms           Same metro area
Cross-region (us-east to us-west)  ~40-60 ms       Coast to coast
US to Europe                       ~80-120 ms      Transatlantic
US to Asia                         ~150-250 ms     Transpacific
US to Australia                    ~180-300 ms     Pacific + routing
```

Cross-datacenter latency dominates everything. A synchronous replication write from US-East to US-West costs 60 ms per write — and that's before the response travels back.

### The Latency Tax of Synchronous Replication

Consider a write to a database with three replicas:

```
Scenario A: Single-datacenter, synchronous replication
  Client → Primary: 0.5 ms
  Primary → Replica 1 (same DC): 0.5 ms
  Primary → Replica 2 (same DC): 0.5 ms
  Wait for both acks: 0.5 ms
  Primary → Client: 0.5 ms
  Total: ~2 ms

Scenario B: Cross-datacenter synchronous replication
  Client → Primary (US-East): 0.5 ms
  Primary → Replica 1 (US-West): 30 ms
  Primary → Replica 2 (EU-West): 40 ms
  Wait for slowest ack: 40 ms
  Primary → Client: 0.5 ms
  Total: ~71 ms

Scenario C: Cross-datacenter, quorum replication (2 of 3)
  Client → Primary (US-East): 0.5 ms
  Primary → Replica 1 (US-West): 30 ms  ← first ack
  Primary → Replica 2 (EU-West): 40 ms  ← don't need to wait
  Wait for first ack only: 30 ms
  Primary → Client: 0.5 ms
  Total: ~61 ms
```

The jump from 2 ms to 71 ms is why most databases offer asynchronous replication as the default — and why engineers who turn on synchronous cross-datacenter replication without understanding the latency implications get surprised by dramatic performance drops.

### Tail Latency: The P99 Problem

Average latency is misleading. In a distributed system, the overall latency is bounded by the **slowest** component.

If a single request fans out to 10 backend services, and each service has a 99th-percentile (P99) latency of 100 ms, the probability that *all* services respond within 100 ms is:

```
P(all 10 respond in < 100ms) = 0.99^10 = 0.904

That means 9.6% of requests hit a P99 latency on at least one backend.
```

With 100 backend calls:
```
P(all 100 respond in < 100ms) = 0.99^100 = 0.366

63.4% of requests hit a P99 latency on at least one backend!
```

This is the **tail-at-scale** problem, described by Jeff Dean and Luiz André Barroso in their 2013 paper. The more services a request touches, the more likely it is to hit a slow outlier. Solutions include:

- **Hedged requests:** Send the same request to two replicas and use whichever responds first.
- **Tied requests:** Send to one replica, and if no response within a threshold, send to a second. The replicas communicate to cancel the redundant copy.
- **Backup requests with delay:** Wait for P50 latency, then send a backup request to another replica.

```python
# Hedged request pattern
async def hedged_read(key, replicas):
    tasks = [replica.get(key) for replica in replicas[:2]]
    done, pending = await asyncio.wait(tasks, return_when=FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    return done.pop().result()
```

---

## TCP Timeouts: The Hidden Configuration

TCP timeouts are one of the most misunderstood and misconfigured aspects of distributed systems.

### Connection Timeout

How long the client waits for the TCP handshake to complete. The OS default is often 20-120 seconds. For datacenter communication, this is absurdly long — if a service hasn't responded to a SYN in 1 second within the same datacenter, it's not going to respond.

```python
# Python: set connection timeout
sock.settimeout(1.0)  # 1 second
sock.connect(("service-b", 8080))

# Go: context-based timeout
ctx, cancel := context.WithTimeout(context.Background(), time.Second)
defer cancel()
conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", "service-b:8080")
```

### Read/Write Timeout

How long a `recv()` or `send()` call waits. This needs more thought:

- Too short: You'll abort requests that were going to succeed, creating unnecessary retries and load.
- Too long: A dead service blocks callers for ages, consuming thread pools and causing cascading failure.

A good heuristic: set the timeout to **P99 latency × 3**. If the service normally responds in 50 ms at P99, set a timeout of 150 ms. This catches genuine failures without being too trigger-happy.

### TCP Retransmission Timeout (RTO)

When TCP detects a lost packet, it waits before retransmitting. The initial RTO is typically 1 second, and it doubles on each consecutive timeout (exponential backoff), up to a maximum of 120 seconds.

```
Lost packet detected:
  - Wait 1 second, retransmit
  - Still lost? Wait 2 seconds, retransmit
  - Still lost? Wait 4 seconds, retransmit
  - Still lost? Wait 8 seconds, retransmit
  ...
  - After ~15 retransmissions (about 15 minutes): give up, RST the connection
```

Linux allows tuning the initial RTO:

```bash
# Check current settings
sysctl net.ipv4.tcp_syn_retries        # SYN retransmissions (default: 6)
sysctl net.ipv4.tcp_retries2           # Data retransmissions (default: 15)
```

For intra-datacenter communication, the default 15 retries means TCP will keep trying for about 15 minutes before giving up. Most distributed systems want to detect failures much faster, which is why application-level timeouts and health checks exist on top of TCP's built-in mechanisms.

### Keepalive Timeout

If a TCP connection is idle (no data in either direction), TCP can optionally send small keepalive probes to check that the connection is still alive. The default settings are extremely conservative:

```bash
# Linux defaults
net.ipv4.tcp_keepalive_time  = 7200    # 2 hours (!) before first probe
net.ipv4.tcp_keepalive_intvl = 75      # 75 seconds between probes
net.ipv4.tcp_keepalive_probes = 9      # 9 probes before declaring dead

# Total time to detect a dead connection with defaults:
# 7200 + (75 × 9) = 7875 seconds ≈ 2.2 hours
```

For a distributed system, 2 hours to detect a dead connection is absurd. Most production systems override these:

```bash
# Reasonable production settings
net.ipv4.tcp_keepalive_time  = 60      # 60 seconds before first probe
net.ipv4.tcp_keepalive_intvl = 10      # 10 seconds between probes
net.ipv4.tcp_keepalive_probes = 6      # 6 probes before declaring dead
# Total: 60 + (10 × 6) = 120 seconds to detect a dead connection
```

But even 2 minutes is slow. Application-level health checks (Chapter 7) typically detect failures in 5-30 seconds.

---

## Network Partitions: When the Network Lies

A **network partition** occurs when a network failure divides a cluster into two or more groups that can communicate internally but not with each other. Partitions are rare in well-run datacenters but absolutely happen in production:

### Types of Partitions

**Complete partition:** No traffic flows between the two sides.
```
[A] ── [B] ── [C]     becomes     [A] ── [B]     [C]
                                          ↑ link cut ↑
```

**Asymmetric partition:** Traffic flows in one direction but not the other.
```
[A] ──→ [B]  ✓
[A] ←── [B]  ✗
```

This happens when a switch's egress queue is full but its ingress queue is fine, or when a firewall rule is misconfigured.

**Partial partition:** Some node pairs can communicate, but not all.
```
[A] ── [B]  ✓
[B] ── [C]  ✓
[A] ── [C]  ✗
```

This violates the common assumption that network reachability is transitive ("if A can reach B and B can reach C, then A can reach C"). It's surprisingly common when nodes are on different network segments.

### Real-World Partition Examples

**GitHub (2012):** A network partition between their primary datacenter and a secondary site caused a brief split-brain condition in their MySQL replication. Data was written to both sides, and the merge after the partition healed required manual intervention.

**Amazon DynamoDB (2015):** A network partition within an availability zone caused a subset of DynamoDB servers to be unable to reach the metadata service. These servers continued serving stale data, while the rest of the cluster had moved on.

**Cloudflare (2020):** A BGP routing issue caused traffic for some backbone links to be dropped, creating a partial partition where some PoPs could not reach others.

### How Long Do Partitions Last?

Research by Bailis and Kingsbury (2014) surveyed network partition durations in real systems:

```
Duration          Frequency
─────────────────────────────
< 1 minute        Common (transient switch failover, routing reconvergence)
1 - 10 minutes    Occasional (switch reboot, link flap)
10 - 60 minutes   Rare (fiber cut, major routing event)
> 1 hour          Very rare (physical damage, misconfiguration)
```

Most partitions heal within minutes. But the damage done during even a short partition — conflicting writes, split elections, inconsistent state — can take much longer to repair.

---

## The Anatomy of an RPC Call

Remote Procedure Calls (RPCs) are the primary communication pattern in distributed systems. Let's trace one end-to-end:

```
Client Application                              Server Application
       |                                                |
  1. Serialize request to bytes (protobuf, JSON)        |
  2. Write to TCP socket send buffer                    |
       |                                                |
  ═══ Network Transit (outbound) ═══════════════        |
       |                                                |
  3. TCP segments traverse switches/routers              |
  4. Any segment can be lost, delayed, reordered         |
       |                                                |
  ═══ Network Transit (arrive) ═════════════════        |
       |                                                |
       |   5. TCP reassembles segments into byte stream  |
       |   6. Deserialize request from bytes             |
       |   7. Execute handler (business logic)           |
       |   8. Serialize response to bytes                |
       |   9. Write to TCP socket send buffer            |
       |                                                |
  ═══ Network Transit (return) ═════════════════        |
       |                                                |
  10. TCP reassembles response segments                  |
  11. Deserialize response from bytes                    |
  12. Return to application code                         |
```

At every step, something can go wrong:
- Steps 1, 6, 8, 11: Serialization/deserialization can fail (schema mismatch, corrupt data)
- Steps 2, 9: Socket buffer can be full (backpressure)
- Steps 3-4: Packets can be lost, delayed, or corrupted
- Step 7: Server can crash, pause, or timeout during processing
- Between any two steps: A TCP connection reset can occur

### RPC Failure Modes

When an RPC call fails (the client gets an error or a timeout), the client faces a fundamental uncertainty:

```
Client sends: transfer($100, from=Alice, to=Bob)
Client gets:  TIMEOUT after 5 seconds

What actually happened?

Case 1: Server never received the request.
        The transfer did NOT happen. Safe to retry.

Case 2: Server received the request, processed it, 
        but the response was lost on the network.
        The transfer DID happen. Retrying will transfer $200!

Case 3: Server received the request, began processing,
        then crashed mid-transaction.
        The transfer MIGHT have partially happened.
        Retrying might or might not be safe depending on
        whether the DB transaction rolled back.

Case 4: Server is still processing the request (just slow).
        The transfer hasn't happened YET but will.
        Retrying will cause a double transfer.
```

The client **cannot distinguish** these cases from the timeout alone. This is the fundamental problem that motivates idempotency tokens, at-least-once delivery semantics, and the careful design of retry policies that we'll discuss throughout this book.

---

## Bandwidth vs. Latency: Which Matters?

A common misconception is that network bandwidth limits distributed system performance. In most cases, **latency** is the bottleneck, not bandwidth.

Modern datacenter networks provide 10-100 Gbps per link. At 10 Gbps:

```
Data size      Transfer time    Round trip (0.5ms DC)
──────────────────────────────────────────────────────
1 KB           0.8 μs           500 μs + 0.8 μs ≈ 500 μs
100 KB         80 μs            500 μs + 80 μs ≈ 580 μs
1 MB           800 μs           500 μs + 800 μs ≈ 1.3 ms
100 MB         80 ms            500 μs + 80 ms ≈ 80 ms
```

For typical RPC payloads (1 KB - 100 KB), the transfer time is negligible compared to the round-trip time. The limiting factor is how many sequential round trips are needed, not how much data is transferred.

This is why distributed algorithms are measured in **message complexity** (number of round trips) rather than data volume. A consensus algorithm that requires 2 round trips will always be faster than one that requires 4, regardless of message size — because each round trip pays the full RTT tax.

### When Bandwidth Matters

Bandwidth becomes the bottleneck for:
- **Bulk data transfer:** Replication of large datasets, MapReduce shuffles, log shipping.
- **Incast patterns:** Many nodes sending simultaneously to one node (e.g., scatter-gather queries).
- **Streaming workloads:** High-throughput event streams (Kafka at millions of messages/sec).

For these cases, **batching** is the key optimization: instead of sending many small messages, batch them into larger payloads to reduce per-message overhead and amortize the RTT cost.

```python
# Bad: one network call per event
for event in events:
    kafka.send(event)  # each send pays network overhead

# Good: batch events into a single network call
kafka.send_batch(events)  # one round trip for N events
```

---

## The Network in Cloud Environments

Cloud networks add layers of abstraction that affect latency and failure modes.

### Virtual Private Cloud (VPC) Networks

In AWS, GCP, or Azure, your instances communicate over a virtual network overlay. Packets are encapsulated (VXLAN or similar), routed through software-defined networking, and decapsulated at the destination. This adds:

- **Extra latency:** 10-50 μs overhead per packet for encapsulation/decapsulation.
- **Extra failure modes:** The SDN control plane can fail independently of the physical network.
- **Bandwidth limits:** Cloud instances have per-instance bandwidth limits (e.g., an AWS m5.large gets 10 Gbps burst, 4.75 Gbps baseline).

### Availability Zones

An "availability zone" (AZ) is a physically separate datacenter within a region. Inter-AZ latency is typically 1-2 ms. This is low enough for synchronous replication but high enough to show up in P99 latency.

```
Same AZ:        ~0.3-0.5 ms RTT
Cross AZ:       ~1-2 ms RTT
Cross Region:   ~40-150 ms RTT
```

Many distributed databases (e.g., CockroachDB, Spanner) recommend placing replicas across three AZs for fault tolerance. This means every synchronous replication write pays ~2 ms for the cross-AZ round trip — an acceptable cost for the durability guarantee.

---

## Practical Implications for Distributed System Design

### 1. Minimize Round Trips

Every protocol design decision should minimize the number of sequential round trips:

```
Bad:  Client → Auth Service → Permission Service → Data Service → Client
      (3 sequential round trips = 3 × RTT)

Good: Client → API Gateway (which batches auth + permission check,
      then calls Data Service)
      (2 sequential round trips = 2 × RTT)
```

### 2. Design for Packet Loss

Expect 0.01% - 0.1% packet loss within a datacenter and up to 1-5% across the internet. Your protocol must handle loss at the application level:

- **Timeouts and retries** for every network call
- **Idempotency** for every operation that might be retried
- **Circuit breakers** to stop cascading retries when a service is down

### 3. Be Explicit About Timeout Values

Never use default timeouts. Every network call should have an explicit timeout based on the expected latency:

```
Within datacenter:  100ms - 1s
Within region:      500ms - 5s
Cross-region:       1s - 30s
External APIs:      5s - 60s
```

### 4. Use Connection Pools

TCP connection establishment costs 1-3 RTTs (with TLS). For any service that makes repeated calls to the same destination, maintain a pool of pre-established connections.

### 5. Understand Your Network Topology

Know the latency between your services. Measure it regularly. Design your data flow so that hot paths stay within the same datacenter or AZ, and only cold paths cross AZ or region boundaries.

---

## Key Takeaways

1. **UDP gives you speed at the cost of reliability.** It's the right choice for heartbeats, metrics, and DNS — anywhere that a lost message is cheaper than the overhead of TCP.

2. **TCP provides reliable, ordered delivery** but at a cost: connection setup (1-3 RTTs), head-of-line blocking, slow start, and retransmission delays.

3. **Packets are lost at every layer:** NIC buffers, kernel buffers, switch buffers, routing changes, firewalls, and NAT timeouts. Design for loss, not against it.

4. **Latency, not bandwidth, is the bottleneck** for most distributed systems. Minimize sequential round trips, not message sizes.

5. **Tail latency dominates fan-out patterns.** The more services a request touches, the more likely it hits a slow outlier. Hedged requests and backup requests mitigate this.

6. **TCP timeouts are misconfigured by default.** Connection timeouts, keepalive intervals, and retransmission settings should all be tuned for your deployment environment.

7. **Network partitions happen in production.** They can be complete, asymmetric, or partial. They typically last minutes but can cause data inconsistencies that take much longer to repair.

8. **An RPC timeout is ambiguous.** The client cannot distinguish "request was never received" from "request was processed, response was lost." This fundamental uncertainty drives the need for idempotency in every distributed protocol.

---

## Further Reading

- Dean, J. & Barroso, L.A. (2013). "The Tail at Scale." *Communications of the ACM*, 56(2). — The definitive paper on tail latency in large-scale distributed systems.
- Cardwell, N. et al. (2017). "BBR: Congestion-Based Congestion Control." *Queue*, 14(5). — Google's rethinking of TCP congestion control.
- Bailis, P. & Kingsbury, K. (2014). "The Network is Reliable." *Queue*, 12(7). — A survey of real-world network partition events.
- Gregg, B. (2020). "Systems Performance: Enterprise and the Cloud." Pearson. — Chapter 10 covers network performance in depth.
- Google (2022). "An update on Google Cloud networking incident #22013." — Post-mortem of a major BGP-related network event.
- Alizadeh, M. et al. (2010). "Data Center TCP (DCTCP)." *SIGCOMM*. — TCP optimization for datacenter environments.

---

*Next: Chapter 3 — Failure Taxonomy. We'll formalize the types of failures a distributed system can experience — crash-stop, crash-recovery, omission, and Byzantine — and understand why different algorithms are designed for different failure models.*
