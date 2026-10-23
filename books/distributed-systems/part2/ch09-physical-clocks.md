# Chapter 9: Physical Clocks, NTP, and Clock Skew

> **Core question**: Can I use a timestamp to decide which of two writes arrived first?

> **Prerequisites**: Chapter 1 (why distributed systems are hard), Chapter 4 (system models), Chapter 7 (failure detection and timeouts)

The short answer is no — not reliably. This chapter explains why, starting from how clocks physically work and building up to the real-world consequences of trusting them.

Every single-machine program takes time for granted. You call `time.Now()`, you get a number, and that number is bigger than the one you got a moment ago. In a distributed system, this assumption breaks down in ways that cause data loss, violated invariants, and incidents that take weeks to debug.

---

## How a Computer Knows What Time It Is

### The Quartz Oscillator

Every computer has a quartz crystal oscillator on its motherboard. The crystal vibrates at a known frequency (typically 32.768 kHz) and the hardware counts vibrations to track elapsed time. The Real-Time Clock (RTC) chip maintains the count even when the machine is powered off, using a small battery.

The problem: quartz crystals are not perfect. Their frequency varies with:

- **Temperature**: A typical crystal drifts ~0.035 ppm/°C² from its turnover temperature. A 10°C ambient change in a data center can shift the oscillation rate measurably.
- **Voltage fluctuations**: Power supply noise changes the crystal's load capacitance.
- **Aging**: The crystal's resonant frequency shifts over years as the quartz lattice deforms.
- **Manufacturing tolerance**: Two "identical" crystals from the same batch can differ by 20 ppm.

What does this mean in practice?

| Drift Rate | Drift per Day | Drift per Month |
|-----------|--------------|----------------|
| 1 ppm | 86 ms | 2.6 s |
| 10 ppm | 864 ms | 25.9 s |
| 50 ppm | 4.3 s | 129.6 s |
| 200 ppm | 17.3 s | 518.4 s |

A commodity server-grade oscillator typically drifts at 10–50 ppm. That means **within one day, two servers' clocks can disagree by nearly 10 seconds** — and that's before network delays, restarts, or VM migrations enter the picture.

### Monotonic Clocks vs. Wall Clocks

Operating systems expose two different kinds of clock:

**Wall clock** (`clock_gettime(CLOCK_REALTIME)` on Linux, `time.Now()` in Go, `System.currentTimeMillis()` in Java):
- Returns the current date and time (e.g., "2024-03-15T14:22:01.003Z")
- Synchronized to UTC via NTP
- **Can jump backward** when NTP corrects the clock
- **Can jump forward** during a step correction
- Subject to leap second adjustments

**Monotonic clock** (`clock_gettime(CLOCK_MONOTONIC)` on Linux, `time.monotonic()` in Python, `System.nanoTime()` in Java):
- Returns a counter that only moves forward
- Meaningful only for measuring elapsed time on a single machine
- Not synchronized across machines
- Not affected by NTP corrections
- Epoch is arbitrary (often "time since boot")

The rule:
- **Use wall clocks** when you need to display a time to a human or correlate events across machines (knowing it's approximate).
- **Use monotonic clocks** when you need to measure durations (timeouts, rate limiting, performance benchmarks).

Using a wall clock to measure a 5-second timeout is a bug:

```python
# WRONG: wall clock can jump
start = time.time()
do_work()
elapsed = time.time() - start  # Could be negative if NTP stepped the clock back

# RIGHT: monotonic clock only moves forward
start = time.monotonic()
do_work()
elapsed = time.monotonic() - start  # Always >= 0
```

If NTP steps the wall clock back by 3 seconds during your 5-second timeout, you'll wait 8 seconds instead of 5. If it steps forward by 10 seconds, your timeout fires instantly. Neither is what you wanted.

---

## NTP: The Network Time Protocol

Since quartz oscillators drift, computers need an external reference to stay synchronized. The Network Time Protocol (NTP), designed by David Mills at the University of Delaware in 1985, is the internet's time synchronization mechanism. The current version is NTPv4 (RFC 5905, 2010).

### Stratum Hierarchy

NTP organizes time sources into strata (layers):

```
┌─────────────────────────────────────┐
│         Stratum 0: Reference        │
│   GPS receivers, atomic clocks,     │
│   radio clocks (WWVB, DCF77)        │
│   Accuracy: ~1 ns (atomic) to       │
│   ~10 μs (GPS with good antenna)    │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│         Stratum 1: Primary          │
│   Servers directly connected to     │
│   Stratum 0 hardware                │
│   (e.g., time.nist.gov)             │
│   Accuracy: ~1–10 μs from UTC       │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│         Stratum 2: Secondary        │
│   Sync from Stratum 1 servers       │
│   (e.g., pool.ntp.org members)      │
│   Accuracy: ~1–10 ms from UTC       │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│         Stratum 3+: Downstream      │
│   Each hop adds uncertainty         │
│   Corporate NTP servers, VMs,       │
│   containers                        │
│   Accuracy: ~10–100 ms from UTC     │
└─────────────────────────────────────┘
```

Each stratum adds latency and uncertainty. By stratum 3 or 4 — which is where most application servers sit — clock accuracy is on the order of tens of milliseconds at best.

### The NTP Packet Exchange

NTP uses a four-timestamp exchange to estimate both the clock offset and the network round-trip delay:

```
Client                              Server
  │                                    │
  │──── Request (t1) ─────────────────▶│
  │                              t2 = receive time
  │                              t3 = send time
  │◀──── Response (t1, t2, t3) ────────│
  │  t4 = receive time                 │
  │                                    │
```

Where:
- **t1**: Client's timestamp when the request was sent
- **t2**: Server's timestamp when the request arrived
- **t3**: Server's timestamp when the response was sent
- **t4**: Client's timestamp when the response arrived

From these four timestamps, NTP computes:

**Round-trip delay:**
```
δ = (t4 - t1) - (t3 - t2)
```

This is the total network transit time: the time the packet spent on the wire in both directions, excluding the server's processing time.

**Clock offset estimate:**
```
θ = ((t2 - t1) + (t3 - t4)) / 2
```

This estimates how far the client's clock is from the server's clock. The formula assumes symmetric network latency — that the packet takes the same time to travel in each direction.

### The Asymmetry Problem

NTP's offset calculation assumes symmetric path delays. In reality, network paths are often asymmetric:

```
Client ──── 2ms ────▶ Server    (upload path through ISP A)
Client ◀──── 8ms ──── Server    (download path through ISP B)
```

If the upload takes 2ms and the download takes 8ms (total round trip = 10ms), NTP calculates the one-way delay as 5ms and introduces a 3ms error in the offset estimate.

NTP cannot detect or correct for asymmetric delays with a single server. This is a fundamental limitation: without an independent measurement of one-way delay, the best NTP can do is assume symmetry and be wrong by up to `δ/2`.

### Marzullo's Algorithm

When a client queries multiple NTP servers, it must decide which servers to trust. Marzullo's algorithm (1984) does this by treating each server's response as an interval `[offset - error, offset + error]` and finding the smallest interval consistent with the majority of sources.

```
Server A:  [─────────────]
Server B:       [───────────────]
Server C:            [──────]          ← Byzantine (faulty)
Server D:     [──────────]

Overlap of A, B, D:    [──]           ← True time is likely here
```

The algorithm:
1. Each server reports an offset and an error bound.
2. Compute the interval `[offset - error, offset + error]` for each.
3. Find the largest set of servers whose intervals have a non-empty intersection.
4. The true time is somewhere in that intersection.

If `n` servers are queried and at most `f` are faulty, Marzullo's algorithm tolerates `f` faulty servers as long as `n ≥ 3f + 1`. For the typical case of 4 NTP servers, this means one can be wrong.

### Clock Discipline: Slew vs. Step

When NTP discovers the local clock is off, it has two options:

**Slew** (for small offsets, typically < 128ms):
- Gradually adjusts the clock rate to converge on the correct time
- Speeds up or slows down the oscillator frequency by up to 500 ppm
- A 100ms correction takes about 200 seconds to complete
- **No discontinuities** — time always moves forward

**Step** (for large offsets, typically > 128ms):
- Instantly jumps the clock to the correct time
- **Introduces a discontinuity** — time can jump forward or backward
- Used after boot, after long network outages, or when drift has accumulated

The step threshold is configurable. Setting it to 0 disables stepping entirely (slew-only mode), which prevents backward jumps but means a badly drifted clock can take hours to converge. The `tinker step 0` option in ntpd forces slew-only.

A step correction is dangerous for software that assumes wall-clock monotonicity:

```
14:22:01.000  Process writes record A with timestamp 14:22:01.000
              ← NTP steps clock back 500ms →
14:22:00.600  Process writes record B with timestamp 14:22:00.600
```

Record B was written *after* record A, but has an *earlier* timestamp. Any system using last-write-wins based on timestamps will now keep A and discard B — losing the newer write.

---

## Clock Skew in Practice

### Google's Measurements

Google published clock synchronization data in the Spanner paper (Corbett et al., 2012). Their internal time service, TrueTime, uses a combination of GPS receivers and atomic clocks in each data center. Even with this hardware:

- **Median** clock uncertainty (ε): ~4 ms
- **99th percentile** ε: ~6–10 ms
- Occasional spikes to ~100+ ms during GPS signal loss or network reconfiguration

And this is with *purpose-built hardware* running a *custom synchronization protocol* inside a *private network*. For commodity servers using NTP over the public internet, clock skew is typically 10–250 ms.

### Amazon's Measurements

AWS published data from their Amazon Time Sync Service (2017), which uses GPS and atomic clock references in each AWS region:

- Instances using the Amazon Time Sync Service: **< 1 ms** median skew within a region
- Instances using public NTP pools: **~10–50 ms** typical skew
- Cross-region skew (even with good NTP): **~1–5 ms** due to speed-of-light propagation

AWS exposes this through the Nitro hypervisor's `ClockErrorBound` API, which gives a machine-readable upper bound on clock uncertainty — similar in spirit to Spanner's TrueTime.

### Cloudflare's Observations

Cloudflare reported (2018) that among their edge servers:

- 99% of servers were within **10 ms** of true UTC
- 0.1% of servers were off by more than **100 ms** at any given time
- Occasionally, servers were off by **multiple seconds** after reboot, VM migration, or NTP daemon crash

That 0.1% tail is what kills you. In a fleet of 10,000 servers, about 10 have clocks off by more than 100ms at any given moment.

---

## Real-World Clock Failures

### The 2012 Linux Leap Second Bug

On June 30, 2012, a leap second was inserted: the clock went from 23:59:59 to 23:59:60 before ticking to 00:00:00. The Linux kernel's `hrtimer` subsystem had a bug where the leap second insertion caused a livelock in the timer code, sending CPUs to 100% utilization.

Affected services:
- **Reddit**: Down for 30–40 minutes
- **Mozilla**: Crashed servers
- **Qantas Airlines**: Delayed check-in systems
- **StumbleUpon, Foursquare, Yelp**: Various outages

The fix was either `date -s "$(date)"` (resetting the clock, which cleared the kernel's confused internal state) or restarting NTP with leap smearing enabled.

This wasn't a distributed systems bug per se — it was a kernel bug triggered by a clock event. But it illustrates that clock operations have failure modes most engineers never think about.

### Google's Leap Smearing

Rather than inserting a discrete leap second, Google *smears* the leap second over a 24-hour window. Starting at noon UTC the day before the leap second, Google's NTP servers slow their clocks by a small amount so that by midnight, they've accumulated the extra second smoothly.

```
Standard UTC:   23:59:58 → 23:59:59 → 23:59:60 → 00:00:00
Google smeared: 23:59:58 → 23:59:59 → 00:00:00  (no 23:59:60)
                (but each second during the smear window was
                 slightly longer than a real second)
```

This avoids the discontinuity that crashes software, but means Google's clocks disagree with UTC by up to 500ms during the smear window. If your system talks to both Google and non-Google NTP sources during a leap smear, the timestamps won't agree.

### The Cloudbleed Timing Side-Channel (2017)

This isn't a clock failure, but it illustrates why clock precision matters for security. Cloudflare's HTML parser had a buffer over-read bug, and the leaked data included timestamps from internal clocks. Attackers used timing information to reconstruct the memory layout of the process. Precise timestamps are a side-channel attack vector.

---

## Last-Write-Wins and Clock Skew

The most common use of physical timestamps in distributed databases is the **Last-Write-Wins (LWW)** conflict resolution strategy: when two replicas receive conflicting writes to the same key, the write with the later timestamp wins.

### How LWW Works

```python
# On each replica:
def handle_write(key, value):
    timestamp = wall_clock_now()
    store(key, value, timestamp)
    replicate_to_peers(key, value, timestamp)

def handle_replicated_write(key, value, timestamp):
    existing = lookup(key)
    if existing is None or timestamp > existing.timestamp:
        store(key, value, timestamp)
    # else: discard — our version is newer
```

### When Clock Skew Breaks LWW

Consider two replicas, A and B. Replica A's clock is 200ms ahead of replica B's:

```
Real time       Replica A's clock       Replica B's clock
─────────       ────────────────        ────────────────
12:00:00.000    12:00:00.200            12:00:00.000
```

Now two clients write to the same key simultaneously:

```
Real time 12:00:00.000:
  Client 1 writes x=1 to Replica A  →  timestamp = 12:00:00.200
  Client 2 writes x=2 to Replica B  →  timestamp = 12:00:00.000
```

When replication happens, both replicas compare timestamps:
- `12:00:00.200 > 12:00:00.000` → **x=1 wins on both replicas**

But both writes happened at the same real-world instant. Client 2's write was **not** earlier — it just happened to hit the replica with the slower clock. The "winner" was determined by clock skew, not by causal order.

Worse: if Client 2's write happened 100ms *after* Client 1's (at real time 12:00:00.100), Client 2's timestamp would be 12:00:00.100, which is still less than Client 1's 12:00:00.200. **The later write is silently discarded.**

### The Cassandra LWW Problem

Apache Cassandra uses LWW as its default conflict resolution for all writes. The documentation explicitly warns:

> "Cassandra uses timestamps to determine the most recent update to a column. The timestamp is provided by the client or is generated by the coordinator node. Timestamps generated on the server side can result in data loss when the clocks of the nodes are not synchronized."

In practice, this means:
1. Two clients update the same row on different coordinators
2. The coordinator with the faster clock always wins
3. The other client's write is silently lost
4. There is no error, no warning, no conflict marker — just data loss

### Systems That Handle This Better

- **Amazon Dynamo**: Instead of LWW, returns *all* conflicting versions (siblings) to the client and lets the application resolve the conflict. This requires application-level merge logic but never silently drops a write.
- **Google Spanner**: Uses TrueTime (hardware clocks with bounded uncertainty) to ensure timestamps are close enough that "later timestamp = later in real time" holds. We cover this in Chapter 27.
- **CockroachDB**: Uses hybrid logical clocks (HLC) that combine wall-clock timestamps with logical counters to preserve causality even when physical clocks drift. The wall-clock component is "best effort" for real-time ordering, while the logical component guarantees causal ordering.

---

## GPS and Atomic Clocks: The High-End Alternative

For systems where millisecond-level clock skew is unacceptable, there are hardware solutions.

### GPS Time

GPS satellites carry atomic clocks and broadcast time signals. A GPS receiver on a server can determine UTC to within:
- **~10–30 nanoseconds** with a good antenna and clear sky view
- **~1 microsecond** with a basic antenna inside a data center (signal attenuation)
- **Not available** underground, in basements, or in Faraday-caged rooms

GPS time is not UTC — it doesn't include leap seconds (GPS time is ahead of UTC by 18 seconds as of 2024). The receiver firmware converts between them.

### Atomic Clocks

Data centers can install local atomic clocks:
- **Rubidium** clocks: ~$2,000, drift ~1 μs/day (0.01 ppm), warm up in minutes
- **Cesium** clocks: ~$50,000, drift ~1 ns/day, the primary frequency standard
- **Chip-scale atomic clocks (CSAC)**: ~$1,500, size of a matchbox, drift ~10 μs/day

Google's data centers use a mix of GPS receivers and atomic clocks. The atomic clocks provide holdover — if GPS signal is lost, the atomic clock continues to provide accurate time for hours or days before drift becomes problematic.

### TrueTime

Google's TrueTime API (used by Spanner) doesn't return a single timestamp. It returns an interval `[earliest, latest]` representing the uncertainty window:

```
TrueTime.now() → TTinterval { earliest: t - ε, latest: t + ε }
```

Where `ε` is the current clock uncertainty (typically 1–7 ms). The caller knows the true time is *somewhere* in that interval. Spanner uses this to implement a "commit wait" — after committing a transaction, it waits for `2ε` before reporting success, guaranteeing that any later transaction will have a timestamp strictly greater.

We'll explore TrueTime's use in distributed transactions in Chapter 27.

---

## Practical Guidance: Clocks in Your System

### What You Can Safely Do with Wall Clocks

1. **Display to humans**: "This order was placed at 2:22 PM." Off by 50ms? Nobody cares.
2. **Coarse-grained ordering**: "This log entry is from roughly the same time as that one." Useful for debugging, not for correctness.
3. **TTL and expiration**: "Delete this cache entry after ~60 seconds." Off by 100ms? Fine.
4. **Audit trails**: "Record when this happened for compliance." Combined with a monotonic sequence number for ordering.

### What You Cannot Safely Do with Wall Clocks

1. **Determine causal ordering**: "Write A happened before write B" — only if your clock uncertainty is smaller than the time between writes.
2. **Implement distributed locks**: "This lock expires at timestamp T" — if different nodes disagree on the current time, two nodes can hold the "same" lock simultaneously. (This is why Martin Kleppmann argued that Redlock is unsafe.)
3. **Last-write-wins**: As shown above, clock skew causes silent data loss.
4. **Distributed rate limiting**: "Allow 100 requests per second across all nodes" — clock skew means different nodes disagree on which second it is.

### Configuration Recommendations

1. **Use a nearby, reliable NTP source**: AWS Time Sync Service, Google Public NTP, or your cloud provider's internal NTP. Don't use `pool.ntp.org` for production systems — the servers are volunteer-operated and quality varies.

2. **Monitor clock skew**: Expose `ntp_offset_seconds` as a Prometheus metric. Alert if any machine's offset exceeds your system's tolerance.

3. **Use chrony instead of ntpd**: chrony handles intermittent connectivity, VMs, and containers better than classic ntpd. It also converges faster after large drift.

4. **Prefer slew-only for databases**: If your database uses timestamps for conflict resolution, configure NTP to slew-only (`makestep 0 0` in chrony) to prevent backward jumps. Accept that large drifts will take longer to correct.

5. **Never use wall clocks for timeouts or durations**: Always use monotonic clocks.

6. **Log with both wall time and monotonic offsets**: For distributed tracing, log the wall-clock time (for cross-machine correlation) and a monotonic counter or logical clock (for within-machine ordering).

---

## The Fundamental Limit

Physical clocks are bounded by physics and economics:

| Technology | Typical Accuracy | Cost per Server | Deployment |
|-----------|-----------------|----------------|------------|
| NTP (public internet) | 10–250 ms | Free | Trivial |
| NTP (data center, dedicated server) | 0.5–10 ms | ~$100/year | Easy |
| PTP (Precision Time Protocol, L2) | 1–100 μs | $500–5K (NIC + switch) | Moderate |
| GPS receiver | 10–100 ns | $200–1K | Antenna required |
| Atomic clock (rubidium) | ~1 μs/day holdover | $2K | Moderate |
| Atomic clock (cesium) | ~1 ns/day holdover | $50K | Significant |

No matter how good your clocks are, there is always a nonzero uncertainty window. Any distributed algorithm that depends on timestamps being *exactly* correct is broken — it just hasn't been caught yet.

The solution isn't better clocks (though those help). The solution is algorithms that don't require perfectly synchronized clocks. That's what the next chapter is about.

---

## Key Takeaways

1. **Quartz oscillators drift** at 10–50 ppm on commodity hardware. Two servers' clocks can disagree by seconds within a day without correction.

2. **NTP corrects drift** but introduces its own uncertainties: asymmetric network paths, step corrections that jump time backward, and stratum degradation.

3. **Wall clocks can go backward**. Any code that assumes `time.Now()` is monotonically increasing has a latent bug.

4. **Monotonic clocks** are for measuring durations. Wall clocks are for displaying times. Mixing them up causes bugs.

5. **Clock skew in production** is typically 1–10 ms within a data center (with good NTP) and 10–250 ms across the internet. Tail cases of 100+ ms happen regularly in large fleets.

6. **Last-Write-Wins with wall clocks** silently drops writes when clocks disagree. This is a design choice, not a bug — but most teams don't realize they've made it.

7. **Hardware clocks** (GPS, atomic) reduce uncertainty to microseconds or nanoseconds but cost real money and don't eliminate the problem — they shrink it.

8. **The right solution** is to use logical clocks (next chapter) or bounded-uncertainty clocks (Chapter 27) instead of trusting physical timestamps for correctness.

---

## References

- Mills, D. L. (1991). *Internet Time Synchronization: The Network Time Protocol*. IEEE Transactions on Communications.
- Marzullo, K. (1984). *Maintaining the Time in a Distributed System*. Ph.D. thesis, Stanford University.
- Corbett, J. C. et al. (2012). *Spanner: Google's Globally-Distributed Database*. OSDI.
- Cloudflare (2018). *How Cloudflare Keeps Time*. Blog post.
- Amazon Web Services (2017). *Keeping Time With Amazon Time Sync Service*. Blog post.
- Kleppmann, M. (2016). *How to do distributed locking*. Blog post (on Redlock and clock assumptions).
- Veitch, D. & Abranches, M. (2009). *Robust synchronization of software clocks across the Internet*. IMC.

---

**Next**: [Chapter 10 — Lamport Clocks and the Happens-Before Relation →](ch10-lamport-clocks.md)
