# Chapter 8: Phi Accrual Failure Detectors

## The Question This Chapter Answers

**Is there a smarter failure detector than a hardcoded timeout — and what does Cassandra actually use?**

Chapter 7 established that all failure detection is a trade-off between speed and accuracy, and that fixed timeouts encode an assumption about network behavior that will eventually be violated. This chapter presents the Phi Accrual Failure Detector — a failure detection algorithm that replaces the binary "alive or dead" verdict with a continuous *suspicion level* that the application can interpret according to its own requirements. It's the failure detection mechanism used by Apache Cassandra, Akka, and several other production systems.

---

## 8.1 What's Wrong with Binary Failure Detectors

Let's revisit the standard heartbeat-based detector from Chapter 7:

```python
def is_alive(node, timeout):
    return (current_time() - last_heartbeat[node]) < timeout
```

This function returns `True` or `False`. There is no middle ground. At timeout minus one millisecond, the node is "alive." At timeout, it's "dead." This cliff creates two problems:

**Problem 1: The timeout must be chosen before deployment.** You set it based on your understanding of the network at deploy time. If the network characteristics change (new traffic patterns, a noisy neighbor, a switch firmware upgrade), the timeout is wrong.

**Problem 2: Different parts of the system need different trade-offs.** The leader election module might want aggressive failure detection (detect a dead leader fast, even if it means occasional false positives). The data rebalancing module might want conservative detection (don't start an expensive rebalance unless you're very sure the node is gone). With a binary detector, both modules are forced to use the same threshold.

The Phi Accrual approach decouples these concerns:

```
Binary detector:           Phi Accrual detector:

  Input:  heartbeat          Input:  heartbeat
  Output: ALIVE or DEAD      Output: φ = 2.7 (a number)

  The detector decides       The application decides
  for the application.       for itself.
```

---

## 8.2 The Key Insight: Output a Suspicion Level, Not a Verdict

The Phi Accrual Failure Detector, proposed by Hayashibara, Défago, Yared, and Katayama in 2004, outputs a value called **φ (phi)** that represents the suspicion level for a monitored node. The value has these properties:

- **φ increases over time** since the last heartbeat. The longer you wait, the more suspicious the silence becomes.
- **φ = 0** means no suspicion at all (heartbeat just arrived).
- **φ = 1** means roughly "the probability that the node has crashed, given the observed heartbeat history, is ~10%."
- **φ = 2** means the probability is ~1%.
- **φ = 3** means ~0.1%.
- In general: **P(mistake | φ) ≈ 10^(-φ)**

The application sets a threshold φ_threshold and declares a node "suspected" when φ exceeds it:

```
φ value    │ P(false positive)  │ Meaning
───────────┼────────────────────┼──────────────────────────────
  1        │ ~10%               │ "Might be dead"
  2        │ ~1%                │ "Probably dead"
  3        │ ~0.1%              │ "Almost certainly dead"
  5        │ ~0.001%            │ "Dead beyond reasonable doubt"
  8        │ ~0.000001%         │ "Dead beyond any doubt"
```

This means:
- An aggressive module (leader election) can use φ_threshold = 1 — faster detection, more false positives
- A conservative module (data rebalancing) can use φ_threshold = 8 — slower detection, almost no false positives
- Both modules use the same underlying detector and heartbeat data

---

## 8.3 How φ Is Computed: Step by Step

The Phi Accrual detector works by maintaining a statistical model of heartbeat arrival times and computing the probability that the monitored node has crashed based on how long it's been since the last heartbeat.

### Step 1: Record Heartbeat Inter-arrival Times

Every time a heartbeat arrives, the detector records the time since the previous heartbeat:

```python
class PhiAccrualDetector:
    def __init__(self, max_sample_size=1000, 
                 min_std_deviation_ms=100):
        self.arrival_intervals = []  # sampling window
        self.max_sample_size = max_sample_size
        self.min_std_deviation = min_std_deviation_ms
        self.last_heartbeat_time = None
    
    def heartbeat_received(self):
        now = current_time_ms()
        if self.last_heartbeat_time is not None:
            interval = now - self.last_heartbeat_time
            self.arrival_intervals.append(interval)
            if len(self.arrival_intervals) > self.max_sample_size:
                self.arrival_intervals.pop(0)
        self.last_heartbeat_time = now
```

If heartbeats are expected every 1000ms but the network is slightly variable, you might see intervals like:

```
[998, 1003, 1001, 997, 1045, 999, 1002, 1050, 998, 1001, ...]
```

### Step 2: Compute the Distribution Parameters

The detector models heartbeat inter-arrival times as following a **normal distribution** (Gaussian). It computes the mean (μ) and standard deviation (σ) from the sample window:

```python
    def _mean(self):
        if not self.arrival_intervals:
            return 0
        return sum(self.arrival_intervals) / len(self.arrival_intervals)
    
    def _std_deviation(self):
        if len(self.arrival_intervals) < 2:
            return self.min_std_deviation
        mean = self._mean()
        variance = sum(
            (x - mean) ** 2 for x in self.arrival_intervals
        ) / len(self.arrival_intervals)
        std_dev = variance ** 0.5
        return max(std_dev, self.min_std_deviation)
```

From the example intervals above:
- μ ≈ 1009ms (heartbeats arrive on average every 1009ms)
- σ ≈ 20ms (standard deviation of arrival times)

The `min_std_deviation` floor prevents the detector from becoming infinitely sensitive when the network is extremely stable. Without it, a perfectly regular heartbeat stream (σ → 0) would make the detector declare a node dead after any delay at all.

### Step 3: Compute the Cumulative Distribution Function

Given the normal distribution N(μ, σ²), we want to know: "What is the probability that the next heartbeat would arrive *after* time t, given the historical distribution?"

This is the complementary CDF (also called the survival function):

```
P(late | t) = 1 - CDF(t)
            = 1 - Φ((t - μ) / σ)

where Φ is the standard normal CDF.
```

If t is small (less than the mean), P(late) is high — it's normal for the heartbeat not to have arrived yet. If t is large (much greater than the mean), P(late) is very small — the silence is highly unusual.

### Step 4: Take the Negative Logarithm

The final step converts the probability to the φ scale:

```
φ(t) = -log₁₀(P(late | t))
      = -log₁₀(1 - Φ((t - μ) / σ))
```

Taking the negative logarithm gives us the nice property that φ = 1 corresponds to P = 0.1, φ = 2 to P = 0.01, etc.

```python
    import math

    def _normal_cdf(self, x):
        """Approximation of the standard normal CDF."""
        return 0.5 * (1 + math.erf(x / math.sqrt(2)))
    
    def phi(self, now=None):
        """Compute current φ value for the monitored node."""
        if self.last_heartbeat_time is None:
            return float('inf')  # never heard from this node
        
        if now is None:
            now = current_time_ms()
        
        t = now - self.last_heartbeat_time
        mean = self._mean()
        std_dev = self._std_deviation()
        
        # How many standard deviations above the mean?
        z = (t - mean) / std_dev
        
        # CDF of the normal distribution
        cdf = self._normal_cdf(z)
        
        # P(heartbeat is this late or later)
        p_late = 1.0 - cdf
        
        # Avoid log(0)
        if p_late < 1e-15:
            return 15.0  # cap at φ=15
        
        # φ = -log₁₀(p_late)
        return -math.log10(p_late)
    
    def is_available(self, threshold=8.0, now=None):
        """Application-level check using a chosen threshold."""
        return self.phi(now) < threshold
```

### Worked Example

Suppose we've observed heartbeat intervals with μ = 1000ms and σ = 50ms. A heartbeat was last received 1200ms ago. What is φ?

```
t = 1200ms

z = (1200 - 1000) / 50 = 4.0

CDF(4.0) = 0.99997  (from standard normal tables)

P(late) = 1 - 0.99997 = 0.00003

φ = -log₁₀(0.00003) = -log₁₀(3 × 10⁻⁵) = -(log₁₀(3) + log₁₀(10⁻⁵))
  = -(0.477 + (-5)) = 4.52
```

So φ = 4.52. If our threshold is 8, the node is still considered alive. If our threshold is 3, we'd suspect it.

Now suppose 2000ms have passed since the last heartbeat:

```
t = 2000ms

z = (2000 - 1000) / 50 = 20.0

CDF(20.0) ≈ 1.0 (virtually certain)

P(late) ≈ 5.5 × 10⁻⁸⁹  (absurdly small)

φ ≈ 88.3
```

φ has exploded. The node is overwhelmingly likely to have crashed.

### Visualizing φ Over Time

```
φ value
  │
15│                                                           ╱
  │                                                         ╱
  │                                                       ╱
10│                                                     ╱
  │                                                   ╱
  │                                                 ╱
 5│                                 ╱──────────╱
  │                         ╱─────╱
  │                   ╱────╱
 2│            ╱─────╱
  │      ╱────╱                   ← φ grows slowly near μ,
 1│  ╱──╱                            then accelerates past μ+2σ
  │╱
 0┼──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────▶
  0    500    1000   1200   1500   2000   2500   3000    t (ms)
              │μ│
              
  Heartbeat expected around t=1000ms (μ)
  At t=1000ms: φ ≈ 0.3 (nothing unusual)
  At t=1100ms: φ ≈ 1.4 (getting late)
  At t=1200ms: φ ≈ 4.5 (quite late)
  At t=1500ms: φ ≈ 24  (almost certainly dead)
```

The shape of the curve reveals the detector's intelligence: φ grows slowly around the expected arrival time (because late heartbeats are common) and accelerates sharply past it (because very late heartbeats are rare). This naturally adapts to the network's behavior.

---

## 8.4 Why the Normal Distribution?

The original paper models inter-arrival times with a normal distribution. This is a simplification — real network latency distributions are typically:

1. **Right-skewed**: The tail extends much further to the right (high latency) than the left (you can't have negative latency)
2. **Heavy-tailed**: Extreme outliers (GC pauses, network retransmits) are more common than a normal distribution predicts
3. **Multi-modal**: Different causes of delay (network, disk, CPU) create overlapping distributions

Despite this, the normal approximation works surprisingly well in practice for several reasons:

**The mean and variance capture the dominant behavior.** For the purpose of "has enough time passed that this silence is suspicious?", knowing the center and spread of the distribution is usually sufficient.

**Errors are conservative in the right direction.** A normal distribution has thinner tails than real network latency. This means the detector slightly overestimates the probability of a crash (φ grows slightly too fast), making it slightly more aggressive than optimal. In practice, this is preferable to being too conservative.

**Cassandra's implementation uses a different distribution anyway.** The Cassandra implementation doesn't use the normal distribution at all — it uses an exponential distribution for the inter-arrival times, which is more appropriate for a Poisson process (random arrivals). We'll see this in Section 8.6.

Some implementations use the **log-normal distribution** (model the logarithm of inter-arrival times as normal), which better captures the right-skew of real latency distributions.

---

## 8.5 Adaptive Behavior: How φ Responds to Changing Networks

One of the Phi Accrual detector's most valuable properties is automatic adaptation to changing network conditions. Let's trace through three scenarios.

### Scenario 1: Stable Network

Heartbeat interval: 1000ms. Network is stable, σ ≈ 20ms.

```
Observed intervals: [998, 1003, 1001, 997, 1005, 999, 1002, 998, 1001, 1000]
μ = 1000.4ms, σ = 20ms (floored to min_std_deviation)

If a heartbeat is 50ms late (t = 1050ms):
z = (1050 - 1000.4) / 20 = 2.48
P(late) = 1 - CDF(2.48) = 0.0066
φ = -log₁₀(0.0066) = 2.18

→ Mildly suspicious, but below most thresholds.
```

### Scenario 2: Network Becomes Congested

Heartbeat interval: still 1000ms, but the network becomes jittery:

```
Observed intervals: [1050, 980, 1120, 940, 1200, 1080, 960, 1150, 1030, 1090]
μ = 1060ms, σ = 81ms

The same 50ms-late heartbeat (t = 1050ms):
z = (1050 - 1060) / 81 = -0.12
P(late) = 1 - CDF(-0.12) = 0.548
φ = -log₁₀(0.548) = 0.26

→ Not suspicious at all! The detector learned that jitter is normal now.
```

### Scenario 3: GC Pauses

One node occasionally has long GC pauses that delay heartbeats by 3 seconds:

```
Observed intervals: [1000, 1000, 3500, 1000, 1000, 1000, 4200, 1000, 1000, 1000]
μ = 1270ms, σ = 1123ms

A 2-second gap (t = 2000ms):
z = (2000 - 1270) / 1123 = 0.65
P(late) = 1 - CDF(0.65) = 0.258
φ = -log₁₀(0.258) = 0.59

→ Not suspicious. The high variance from GC pauses makes
   the detector very tolerant.
```

This is both a strength and a weakness. The detector correctly avoids false positives during GC pauses. But it also becomes slower to detect real crashes, because the high variance means it takes longer for φ to reach any given threshold.

```
Effect of variance on detection speed:

                    Low variance (σ=20ms)     High variance (σ=200ms)
                    ─────────────────────     ──────────────────────
Time for φ > 3:    ~1060ms after expected    ~1600ms after expected
Time for φ > 5:    ~1100ms after expected    ~2000ms after expected
Time for φ > 8:    ~1160ms after expected    ~2600ms after expected

Higher variance → slower detection (but fewer false positives)
```

---

## 8.6 Cassandra's Implementation

Apache Cassandra's implementation is the most widely deployed Phi Accrual failure detector. Let's examine how it differs from the original paper.

### Key Design Choices

**1. Exponential distribution instead of normal.**

Cassandra models inter-arrival times using an exponential distribution. The reasoning: if heartbeats are sent at fixed intervals and network delays are memoryless (each delay is independent), the inter-arrival time distribution is approximately exponential.

For the exponential distribution with rate parameter λ = 1/μ:

```
P(arrival time > t) = e^(-t/μ)

φ(t) = -log₁₀(e^(-t/μ))
      = (t/μ) × log₁₀(e)
      = (t/μ) × 0.4343
```

This is simpler to compute (no error function needed) and produces a φ that grows linearly with time, rather than the accelerating growth of the normal distribution.

**2. Sliding window of samples.**

Cassandra keeps the most recent 1000 heartbeat intervals (configurable via `phi_convict_threshold` in `cassandra.yaml`, though the window size is hardcoded). Older samples are discarded, so the detector adapts to changing conditions within the window timeframe.

**3. Configurable conviction threshold.**

The `phi_convict_threshold` setting (default: 8) determines when a node is declared dead:

```yaml
# cassandra.yaml
phi_convict_threshold: 8
```

A threshold of 8 means the node is convicted when there's a ~10⁻⁸ (one in 100 million) probability that the node is actually alive. This is extremely conservative — Cassandra strongly prefers false negatives (slow detection of real crashes) over false positives (incorrect death declarations that cause unnecessary data streaming).

### Cassandra's Actual Code (Simplified)

The core of Cassandra's `FailureDetector.java`:

```java
public class FailureDetector {
    private static final int SAMPLE_SIZE = 1000;
    private static final long DEFAULT_MAX_PAUSE = 5000; // ms
    
    // Per-node arrival time samples
    private final Map<InetAddress, ArrivalWindow> arrivalSamples;
    
    public void report(InetAddress endpoint) {
        // Called when a heartbeat arrives
        ArrivalWindow window = arrivalSamples.get(endpoint);
        if (window == null) {
            window = new ArrivalWindow(SAMPLE_SIZE);
            arrivalSamples.put(endpoint, window);
        }
        window.add(System.nanoTime());
    }
    
    public void interpret(InetAddress endpoint) {
        ArrivalWindow window = arrivalSamples.get(endpoint);
        if (window == null) return;
        
        double phi = window.phi(System.nanoTime());
        if (phi > getPhiConvictThreshold()) {
            // Node is declared dead
            markDead(endpoint);
        }
    }
}

class ArrivalWindow {
    private final BoundedStatsDeque intervals;
    private long lastNanotime;
    
    void add(long nanotime) {
        if (lastNanotime > 0) {
            long interval = nanotime - lastNanotime;
            intervals.add(interval);
        }
        lastNanotime = nanotime;
    }
    
    double phi(long nowNano) {
        long timeSinceLastHeartbeat = nowNano - lastNanotime;
        double mean = intervals.mean();
        
        // Exponential CDF: P(late) = e^(-t/mean)
        double exponent = -1.0 * timeSinceLastHeartbeat / mean;
        double pLate = Math.exp(exponent);
        
        // φ = -log₁₀(pLate)
        return -1.0 * Math.log10(pLate);
    }
}
```

### How Cassandra Uses Phi in the Gossip Protocol

Cassandra's gossip protocol (based on the one described in Chapter 7) serves as the heartbeat mechanism. Every second, each node:

1. Picks a random live peer and sends a gossip message
2. Picks a random unreachable peer (with low probability) and sends a gossip message
3. If the node hasn't gossipped with a seed node recently, gossips with a seed

Each gossip message serves as a heartbeat. The receiving node updates its `ArrivalWindow` for the sender. The phi calculation then runs on top of these gossip-derived heartbeats.

```
Cassandra's failure detection stack:

┌──────────────────────────────────────┐
│  Application layer:                  │
│  "Is this node available for reads?" │
│  Checks: phi < phi_convict_threshold │
└───────────────┬──────────────────────┘
                │
┌───────────────▼──────────────────────┐
│  Phi Accrual Detector:               │
│  Computes φ from heartbeat history   │
└───────────────┬──────────────────────┘
                │
┌───────────────▼──────────────────────┐
│  Gossip Protocol:                    │
│  Exchanges state every 1 second      │
│  Gossip messages serve as heartbeats │
└──────────────────────────────────────┘
```

### Tuning Cassandra's Failure Detection

The default `phi_convict_threshold` of 8 is tuned for typical datacenter networks. In different environments:

**Cloud / cross-datacenter**: Increase to 10–12. Network jitter across cloud availability zones is higher than within a single datacenter. A higher threshold avoids false positives during network weather events.

**Low-latency local network**: You could decrease to 5–6 for faster detection, but only if you've confirmed that your network doesn't have latency spikes that would cause false positives.

**Single-machine testing**: Decrease to 2–3. On localhost, there's virtually no network jitter, so a lower threshold provides faster feedback during development.

Cassandra logs the phi value when a node is convicted, which is invaluable for tuning:

```
INFO  [GossipStage:1] FailureDetector.java:288 - 
  InetAddress /10.0.1.42 is now dead, phi=12.83
```

If you see nodes being convicted with phi values just barely above the threshold (e.g., phi=8.5 with threshold=8), you should increase the threshold — the detector is making borderline calls that might be wrong.

---

## 8.7 Comparison: Static Timeout vs. Phi Accrual

Let's compare the two approaches on the same workload: a cluster where heartbeats arrive every ~1 second, but the network occasionally has 200ms jitter spikes and rare 2-second GC pauses.

```
Heartbeat arrival intervals over 60 seconds:

Normal:  ~1000ms ± 30ms   (95% of the time)
Jittery: ~1000ms ± 200ms  (4% of the time)
GC:      ~3000ms           (1% of the time)
```

### Static Timeout = 2000ms

```
Detection time for real crash:  2000ms (always)
False positives per hour:
  - From jitter: ~0 (200ms jitter doesn't exceed 2000ms)
  - From GC:     ~36 (1% of heartbeats are 3000ms > 2000ms timeout
                       → 1% × 3600 seconds / 1 second = ~36 false alarms)
```

36 false positives per hour is unacceptable for most systems. Each one triggers unnecessary failover logic.

### Static Timeout = 5000ms

```
Detection time for real crash:  5000ms (always)
False positives per hour:       ~0 (GC pauses are 3000ms < 5000ms)
```

Zero false positives, but now every real crash takes 5 seconds to detect.

### Phi Accrual (threshold = 8)

```
After warm-up, the detector learns:
  μ ≈ 1020ms (slightly above 1000 due to GC outliers)
  σ ≈ 280ms  (inflated by GC outliers)

Detection time for real crash:
  Time for φ > 8 with these parameters ≈ 3200ms
  (much faster than the 5000ms static timeout that achieves
   similar false positive rates)

False positives from GC (3000ms pause):
  t = 3000ms
  φ = (3000 / 1020) × 0.4343 ≈ 1.28  (using exponential model)
  1.28 < 8 → not convicted
  
  Even a 4000ms pause:
  φ = (4000 / 1020) × 0.4343 ≈ 1.70
  Still below threshold.
  
  The detector would need a ~18-second silence to reach φ = 8.
  But this is because of the high σ from GC pauses.
```

Wait — this seems too tolerant. 18 seconds to detect a crash? That's worse than the 5-second static timeout! What happened?

The GC pauses inflated σ so much that the detector became very conservative. This reveals an important practical consideration: **the Phi Accrual detector is only as good as its sample quality.** If your samples include extreme outliers (like GC pauses), the detector becomes sluggish.

### The Fix: Sample Filtering

Production implementations address this by filtering outliers from the sample window:

```python
def add_interval(self, interval):
    # Cap extreme outliers at a configurable maximum
    MAX_PAUSE_MS = 5000
    capped = min(interval, MAX_PAUSE_MS)
    self.intervals.append(capped)
```

Cassandra's implementation caps the inter-arrival time at the `MAX_LOCAL_PAUSE_IN_MS` value (default 5000ms). This prevents GC pauses or other extreme events from permanently corrupting the distribution estimate.

With capping at 5000ms, the effective statistics change:

```
With GC pause capping:
  μ ≈ 1020ms (GC outliers capped, so less impact)
  σ ≈ 180ms  (much lower without extreme outliers)

Time for φ > 8 ≈ 2400ms — competitive with the static timeout
while maintaining much better false positive rates.
```

---

## 8.8 Multi-Level Thresholds

One of the most powerful applications of the Phi Accrual detector is using multiple thresholds for different actions:

```python
class MultiLevelFailurePolicy:
    def __init__(self, detector):
        self.detector = detector
    
    def evaluate(self, node_id):
        phi = self.detector.phi(node_id)
        
        if phi < 1:
            return "HEALTHY"
        elif phi < 3:
            return "SUSPECT"
            # Actions: 
            #   - Stop sending NEW requests to this node
            #   - Allow in-flight requests to complete
            #   - Start warming up a standby
        elif phi < 5:
            return "LIKELY_DEAD"
            # Actions:
            #   - Redirect all traffic to other nodes
            #   - Begin data re-replication from replicas
            #   - Notify operations team
        elif phi < 8:
            return "PROBABLY_DEAD"
            # Actions:
            #   - Complete data re-replication
            #   - Update routing tables permanently
        else:
            return "CONVICTED"
            # Actions:
            #   - Remove from cluster membership
            #   - Reclaim resources (IPs, slots)
            #   - Considered permanently gone
```

This graduated response is impossible with a binary failure detector. With a binary detector, you go from "alive" to "dead" in one step, and every response must be triggered simultaneously. With phi, you can:

1. **Stop sending new work** at φ = 1 (within ~100ms of the expected heartbeat)
2. **Redirect existing traffic** at φ = 3 (within ~500ms)
3. **Start rebalancing** at φ = 5 (within ~1000ms)
4. **Remove from membership** at φ = 8 (within ~2000ms)

This staged response means the system begins reacting almost immediately while still reserving the most expensive operations (membership changes, data rebalancing) for cases where the evidence is overwhelming.

```
Timeline of graduated response after a real crash:

  T=0:     Node crashes. Last heartbeat was at T=0.
  T=100ms: φ ≈ 1. Stop sending new requests.
  T=500ms: φ ≈ 3. Redirect traffic to other nodes.
  T=1s:    φ ≈ 5. Start data re-replication.
  T=2s:    φ ≈ 8. Remove from cluster membership.

  Compare to binary detector with 5s timeout:
  T=0–5s:  No response at all. Requests pile up.
  T=5s:    Node declared dead. ALL actions triggered at once.
           Thundering herd of rebalancing, rerouting, alerting.
```

---

## 8.9 Limitations and Pitfalls

The Phi Accrual detector is not a silver bullet. Understanding its limitations is as important as understanding its strengths.

### Limitation 1: Cold Start

When a node first joins the cluster, there are no heartbeat samples. The detector has no distribution to compute φ from. Most implementations handle this with an initial assumed interval:

```python
def phi(self, now=None):
    if len(self.arrival_intervals) < 2:
        # Cold start: fall back to a conservative estimate
        if self.last_heartbeat_time is None:
            return float('inf')
        t = now - self.last_heartbeat_time
        # Assume 1s intervals with 500ms std dev
        return (t / 1000) * 0.4343  # exponential model
    # ... normal computation
```

During cold start, the detector is essentially a crude static timeout. It takes several heartbeat rounds (typically 10–30) to collect enough samples for accurate phi computation.

### Limitation 2: Non-Stationary Distributions

The detector assumes that the heartbeat inter-arrival time distribution is approximately stationary within the sample window. If the network behavior changes abruptly (e.g., a datacenter link goes from 1ms to 100ms latency due to a routing change), the detector needs time to adapt — specifically, enough new samples must arrive to shift μ and σ to the new values.

During this transition period, the detector may produce incorrect φ values:
- If latency increased: φ values will be too high (overestimating crash probability), causing false positives
- If latency decreased: φ values will be too low (underestimating crash probability), potentially missing real crashes

The adaptation time is approximately:

```
adaptation_time ≈ window_size × heartbeat_interval

With window_size = 1000 and heartbeat_interval = 1s:
adaptation_time ≈ 1000s ≈ 16 minutes

With window_size = 100:
adaptation_time ≈ 100s ≈ 1.7 minutes
```

Smaller windows adapt faster but have noisier estimates. Larger windows are more stable but adapt slowly. This is the bias-variance trade-off from statistics, applied to failure detection.

### Limitation 3: Correlated Failures

The detector treats each monitored node independently. If all five nodes in a rack become unreachable simultaneously (because the top-of-rack switch died), the detector will independently suspect each one. The system might then try to re-replicate data from all five nodes simultaneously, overwhelming the cluster with data transfer.

Smart systems add **correlated failure detection** on top of phi:

```python
def check_correlated_failures(suspected_nodes):
    # If many nodes in the same rack are suspected simultaneously,
    # it's likely a network issue, not individual node crashes.
    by_rack = group_by_rack(suspected_nodes)
    for rack, nodes in by_rack.items():
        if len(nodes) > 2:  # More than 2 nodes in one rack suspected
            # Likely a rack-level network failure.
            # Don't start rebalancing — wait for the rack to recover.
            for node in nodes:
                node.suppress_rebalancing = True
            alert_ops("Possible rack failure: " + rack)
```

### Limitation 4: Symmetric Assumption

The phi value for Node B as computed by Node A reflects the A→B network path. But failure might be asymmetric: B can reach A but A can't reach B. The detector at A will suspect B, but B's detector won't suspect A.

In a consensus system using phi for leader election, this can cause:
- A suspects the leader (B) is dead and starts an election
- B doesn't suspect anything is wrong and keeps accepting writes
- Both A and B think they're doing the right thing
- Potential for split-brain until the partition heals

This is fundamentally the same problem as Chapter 7's discussion of asymmetric partitions, and the phi detector doesn't solve it — it just provides a more nuanced signal about it.

---

## 8.10 Comparison with Other Adaptive Detectors

The Phi Accrual detector isn't the only adaptive failure detection algorithm. Here's how it compares to alternatives:

### Chen et al.'s Adaptive Detector (2002)

This detector dynamically adjusts the timeout based on recent heartbeat history:

```
timeout = mean + α × (max_observed - mean)

where α is a safety margin (typically 1.0–2.0)
```

It's simpler than Phi Accrual but outputs a binary decision (alive/dead) rather than a continuous suspicion level. It also uses the maximum observed delay, which makes it sensitive to outliers.

### Bertier et al.'s Adaptive Detector (2002)

Uses an exponentially weighted moving average (EWMA) of heartbeat intervals:

```
estimated_delay = α × actual_delay + (1 - α) × estimated_delay
timeout = estimated_delay + β × error_variance
```

Similar to the dynamic timeout from Chapter 7, Section 7.6. Simpler to implement than Phi Accrual, adapts smoothly to changing conditions, but still outputs a binary decision.

### Comparison Table

```
┌────────────────────┬──────────┬───────────┬───────────┬────────────┐
│ Detector           │ Output   │ Adaptive? │ Multi-    │ Used by    │
│                    │ type     │           │ threshold │            │
├────────────────────┼──────────┼───────────┼───────────┼────────────┤
│ Static timeout     │ Binary   │ No        │ No        │ K8s, etcd  │
│ EWMA-based         │ Binary   │ Yes       │ No        │ TCP RTO    │
│ Chen et al.        │ Binary   │ Yes       │ No        │ Research   │
│ Phi Accrual        │ φ value  │ Yes       │ Yes       │ Cassandra, │
│                    │          │           │           │ Akka       │
│ SWIM + suspicion   │ Multi-   │ Indirect  │ Yes       │ Consul,    │
│                    │ state    │ (via      │ (alive/   │ Nomad      │
│                    │          │  protocol)│  suspect/ │            │
│                    │          │           │  dead)    │            │
└────────────────────┴──────────┴───────────┴───────────┴────────────┘
```

---

## 8.11 Implementing a Production Phi Accrual Detector

Here's a complete, production-quality implementation incorporating all the lessons from this chapter:

```python
import math
import time
import threading
from collections import deque


class PhiAccrualFailureDetector:
    """
    Phi Accrual Failure Detector.
    
    Outputs a continuous suspicion level (φ) rather than a 
    binary alive/dead verdict. Uses the exponential distribution
    model (matching Cassandra's approach).
    """
    
    def __init__(
        self,
        threshold: float = 8.0,
        max_sample_size: int = 1000,
        min_std_deviation_ms: float = 100.0,
        acceptable_heartbeat_pause_ms: float = 0.0,
        first_heartbeat_estimate_ms: float = 1000.0,
    ):
        self.threshold = threshold
        self.max_sample_size = max_sample_size
        self.min_std_deviation_ms = min_std_deviation_ms
        self.acceptable_heartbeat_pause_ms = acceptable_heartbeat_pause_ms
        self.first_heartbeat_estimate_ms = first_heartbeat_estimate_ms
        
        self._lock = threading.Lock()
        self._state = {}  # node_id -> _NodeState
    
    def heartbeat(self, node_id: str) -> None:
        """Record a heartbeat from a node."""
        now = time.monotonic() * 1000  # milliseconds
        with self._lock:
            state = self._state.get(node_id)
            if state is None:
                state = _NodeState(
                    max_sample_size=self.max_sample_size,
                    first_heartbeat_estimate_ms=self.first_heartbeat_estimate_ms,
                )
                self._state[node_id] = state
            state.add(now)
    
    def phi(self, node_id: str) -> float:
        """
        Compute the current φ value for a node.
        
        Returns float('inf') if the node has never sent a heartbeat.
        Returns 0.0 if a heartbeat literally just arrived.
        """
        now = time.monotonic() * 1000
        with self._lock:
            state = self._state.get(node_id)
            if state is None or state.last_time is None:
                return float('inf')
            
            time_diff = now - state.last_time
            mean = state.mean() + self.acceptable_heartbeat_pause_ms
            std_dev = max(state.std_deviation(), self.min_std_deviation_ms)
            
            return self._compute_phi(time_diff, mean, std_dev)
    
    def is_available(self, node_id: str) -> bool:
        """Check if a node is considered available."""
        return self.phi(node_id) < self.threshold
    
    @staticmethod
    def _compute_phi(time_diff_ms: float, mean: float, 
                     std_dev: float) -> float:
        """
        Compute φ using the exponential distribution model.
        
        For the exponential distribution:
          P(X > t) = e^(-t/μ)
          φ = -log₁₀(P(X > t)) = (t/μ) × log₁₀(e)
        """
        if time_diff_ms <= 0:
            return 0.0
        
        # Use the exponential CDF: P(late) = exp(-t / mean)
        exponent = -time_diff_ms / mean
        p_late = math.exp(exponent)
        
        if p_late < 1e-15:
            return 15.0  # cap to avoid infinity
        
        return -math.log10(p_late)
    
    def remove(self, node_id: str) -> None:
        """Stop tracking a node."""
        with self._lock:
            self._state.pop(node_id, None)


class _NodeState:
    """Per-node heartbeat arrival time tracking."""
    
    def __init__(self, max_sample_size: int, 
                 first_heartbeat_estimate_ms: float):
        self.intervals = deque(maxlen=max_sample_size)
        self.last_time = None
        self._first_estimate = first_heartbeat_estimate_ms
    
    def add(self, timestamp_ms: float) -> None:
        if self.last_time is not None:
            interval = timestamp_ms - self.last_time
            # Cap at a reasonable maximum to avoid outlier corruption
            interval = min(interval, 60000)  # 60s cap
            self.intervals.append(interval)
        self.last_time = timestamp_ms
    
    def mean(self) -> float:
        if not self.intervals:
            return self._first_estimate
        return sum(self.intervals) / len(self.intervals)
    
    def std_deviation(self) -> float:
        if len(self.intervals) < 2:
            return self._first_estimate / 4.0
        m = self.mean()
        variance = sum((x - m) ** 2 for x in self.intervals) / len(self.intervals)
        return math.sqrt(variance)
```

### Usage Example

```python
detector = PhiAccrualFailureDetector(threshold=8.0)

# In the heartbeat receiver:
def on_heartbeat(sender_id):
    detector.heartbeat(sender_id)

# In the health check loop:
def check_cluster_health():
    for node_id in cluster_nodes:
        phi = detector.phi(node_id)
        if phi > 8:
            mark_dead(node_id)
        elif phi > 3:
            mark_suspect(node_id)
            reduce_traffic(node_id)
        elif phi > 1:
            log_warning(f"Node {node_id} showing elevated phi: {phi:.2f}")
```

---

## 8.12 Akka's Implementation

Akka (the actor framework for JVM languages) includes a Phi Accrual failure detector for its cluster membership. Its implementation is notable for using the **normal distribution** (matching the original paper) rather than Cassandra's exponential model.

Key differences from Cassandra:

```
┌─────────────────────┬──────────────────┬────────────────────┐
│ Parameter           │ Cassandra        │ Akka               │
├─────────────────────┼──────────────────┼────────────────────┤
│ Distribution        │ Exponential      │ Normal              │
│ Default threshold   │ 8                │ 8                   │
│ Sample window       │ 1000             │ 1000                │
│ Heartbeat interval  │ ~1s (gossip)     │ 1s (configurable)   │
│ Min std deviation   │ (not explicit)   │ 100ms               │
│ Acceptable pause    │ (via MAX_PAUSE)  │ 0ms (configurable)  │
│ First heartbeat est.│ (hardcoded)      │ 1000ms              │
└─────────────────────┴──────────────────┴────────────────────┘
```

Akka's configuration:

```
akka.cluster.failure-detector {
  implementation-class = 
    "akka.remote.PhiAccrualFailureDetector"
  
  threshold = 8.0
  
  # Number of heartbeat samples to keep
  max-sample-size = 1000
  
  # Minimum standard deviation used in phi calculation
  min-std-deviation = 100 ms
  
  # Added to the mean as a margin for acceptable pauses
  # (GC pauses, network maintenance)
  acceptable-heartbeat-pause = 3 s
  
  # Initial value used before enough samples are collected
  heartbeat-interval = 1 s
  
  # Number of missed heartbeats that triggers first 
  # phi computation (before cold start is over)
  expected-response-after = 1 s
}
```

The `acceptable-heartbeat-pause` parameter is Akka's way of handling GC pauses: instead of capping outlier samples (Cassandra's approach), Akka adds this value to the mean. The effect is similar — it shifts the distribution to be more tolerant of long pauses.

---

## 8.13 When to Use Phi Accrual vs. Simpler Approaches

The Phi Accrual detector adds complexity. Here's when it's worth it and when simpler approaches suffice:

### Use Phi Accrual when:

- **Variable network conditions**: Cloud environments, cross-datacenter links, or mixed hardware where latency characteristics change over time
- **Different modules need different thresholds**: Leader election wants fast detection; rebalancing wants certainty
- **False positives are costly**: Triggering rebalancing, failover, or re-election on a false positive causes cascading disruption
- **GC pauses or other application-level stalls are common**: JVM-based systems with stop-the-world GC

### Use a static timeout when:

- **The network is predictable**: Dedicated datacenter with managed switches and predictable latency
- **Simplicity is paramount**: The failure detector is not the bottleneck or the primary source of incidents
- **Detection speed is more important than accuracy**: For example, a stateless web server behind a load balancer — a false positive just means one unnecessary restart
- **You're implementing Raft or another consensus protocol**: Raft's built-in heartbeat mechanism uses a fixed election timeout, and adding phi on top adds complexity without clear benefit (Raft already handles spurious elections gracefully through randomized timeouts)

### Use SWIM when:

- **Cluster size is large** (hundreds or thousands of nodes): SWIM's O(n) message complexity and indirect probing make it the best choice for large clusters
- **You need membership management, not just failure detection**: SWIM naturally integrates membership with detection
- **You want high accuracy without per-node tuning**: SWIM's indirect probing eliminates most false positives caused by asymmetric network issues

---

## 8.14 Key Takeaways

1. **φ is a suspicion level, not a verdict.** The Phi Accrual detector decouples the sensing (measuring heartbeat patterns) from the decision (declaring a node dead or alive). This separation allows different parts of the system to use different thresholds based on their tolerance for false positives.

2. **φ adapts automatically.** By maintaining a statistical model of heartbeat inter-arrival times, the detector adjusts to changing network conditions without manual tuning. When the network becomes jittery, the detector becomes more tolerant. When the network is stable, the detector becomes more aggressive.

3. **P(false positive) ≈ 10^(-φ).** This logarithmic scale means that each unit increase in the threshold reduces false positives by a factor of 10. A threshold of 8 corresponds to a false positive probability of roughly one in 100 million.

4. **Sample quality matters.** The detector is only as good as its heartbeat samples. Extreme outliers (GC pauses, network blips) can inflate the variance and make the detector sluggish. Production implementations cap outlier values or add a margin for known pauses.

5. **Graduated response is the killer feature.** The ability to take mild action (redirect traffic) at low φ and drastic action (remove from cluster) at high φ gives the system a much smoother response to failures than a binary detector that triggers everything at once.

6. **Cold start requires a fallback.** Until enough samples are collected, the detector falls back to a crude estimate. Systems should be designed to tolerate the less accurate detection during startup.

7. **Cassandra uses the exponential model.** Despite the original paper using the normal distribution, Cassandra's production implementation uses the exponential distribution, which is simpler to compute and works well for memoryless heartbeat arrivals. Akka uses the normal model. Both work in practice.

---

## References

- Hayashibara, N., Défago, X., Yared, R., & Katayama, T. (2004). "The φ Accrual Failure Detector." *23rd IEEE International Symposium on Reliable Distributed Systems (SRDS'04)*, pp. 66–78.
- Chen, W., Toueg, S., & Aguilera, M. K. (2002). "On the Quality of Service of Failure Detectors." *IEEE Transactions on Computers*, 51(1), 13–32.
- Bertier, M., Marin, O., & Sens, P. (2002). "Implementation and Performance Evaluation of an Adaptable Failure Detector." *International Conference on Dependable Systems and Networks (DSN)*.
- Apache Cassandra source code: `org.apache.cassandra.gms.FailureDetector`
- Akka documentation: "Failure Detector" in Akka Cluster documentation
- Lakshman, A., & Malik, P. (2010). "Cassandra — A Decentralized Structured Storage System." *ACM SIGOPS Operating Systems Review*, 44(2), 35–40.

---

*Next: Part 1 concludes with a "Putting It Together" exercise that traces a failed payment across five microservices — applying failure detection, system models, and RPC semantics to a real incident scenario.*
