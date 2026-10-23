# Putting It Together: The Failed Payment

> **Exercise**: Trace a failed payment across five microservices. Given only the logs and timestamps, reconstruct what happened, identify which server caused the timeout, and determine whether the payment was charged.

This exercise ties together every concept from Part 1: failure taxonomy (Ch 3), system models (Ch 4), the impossibility of agreement (Ch 5), RPC semantics (Ch 6), and failure detection (Ch 7–8).

---

## The Scenario

Your company runs a payment flow that spans five microservices:

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  API      │───▶│  Order   │───▶│  Payment │───▶│  Fraud   │───▶│  Bank    │
│  Gateway  │    │  Service │    │  Service │    │  Check   │    │  Gateway │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
     A               B               C               D               E
```

A customer submits a $247.50 payment. Five minutes later, they see "Payment Failed — Please Try Again." They try again. Now they've been charged twice.

Your job: use the logs below to figure out what happened.

---

## The Logs

Each service writes structured logs with a request ID, timestamp, and event description. The timestamps come from each machine's local clock (synchronized via NTP, but not perfectly).

### Service A — API Gateway
```
2024-03-15T14:22:01.003Z  req=abc-123  Received POST /payments {amount: 247.50, idempotency_key: "ik_9f8e7d"}
2024-03-15T14:22:01.005Z  req=abc-123  Forwarding to Order Service
2024-03-15T14:22:06.005Z  req=abc-123  Timeout waiting for Order Service (5000ms)
2024-03-15T14:22:06.006Z  req=abc-123  Returning 504 Gateway Timeout to client
```

### Service B — Order Service
```
2024-03-15T14:22:01.047Z  req=abc-123  Received from API Gateway
2024-03-15T14:22:01.052Z  req=abc-123  Created order ord_441 status=PENDING
2024-03-15T14:22:01.053Z  req=abc-123  Calling Payment Service
2024-03-15T14:22:05.891Z  req=abc-123  Payment Service returned {status: "charged", txn_id: "txn_882"}
2024-03-15T14:22:05.893Z  req=abc-123  Updated order ord_441 status=PAID
2024-03-15T14:22:05.894Z  req=abc-123  Returning 200 OK to API Gateway
```

### Service C — Payment Service
```
2024-03-15T14:22:01.112Z  req=abc-123  Received from Order Service
2024-03-15T14:22:01.115Z  req=abc-123  Idempotency key ik_9f8e7d not found, proceeding
2024-03-15T14:22:01.116Z  req=abc-123  Calling Fraud Check
2024-03-15T14:22:03.220Z  req=abc-123  Fraud Check returned {decision: "allow"}
2024-03-15T14:22:03.222Z  req=abc-123  Calling Bank Gateway
2024-03-15T14:22:05.810Z  req=abc-123  Bank Gateway returned {status: "approved", txn_id: "txn_882"}
2024-03-15T14:22:05.815Z  req=abc-123  Stored idempotency result for ik_9f8e7d -> charged
2024-03-15T14:22:05.816Z  req=abc-123  Returning {status: "charged"} to Order Service
```

### Service D — Fraud Check
```
2024-03-15T14:22:01.200Z  req=abc-123  Received from Payment Service
2024-03-15T14:22:03.150Z  req=abc-123  ML model scored 0.12 (threshold 0.80), allowing
2024-03-15T14:22:03.151Z  req=abc-123  Returning {decision: "allow"}
```

### Service E — Bank Gateway
```
2024-03-15T14:22:03.305Z  req=abc-123  Received from Payment Service
2024-03-15T14:22:05.702Z  req=abc-123  Bank API returned HTTP 200 {approved: true, reference: "txn_882"}
2024-03-15T14:22:05.703Z  req=abc-123  Returning {status: "approved"} to Payment Service
```

---

## Analysis Questions

Work through these before reading the answers below.

### Question 1: Timeline Reconstruction

Draw a timeline of every network call, including when each was sent and when the response arrived. Account for network latency between services.

### Question 2: Where Did the Timeout Happen?

The API Gateway timed out at 14:22:06.005Z. The Order Service returned its response at 14:22:05.894Z. Why did the customer see a failure?

### Question 3: Was the Payment Charged?

The customer saw "Payment Failed." Was $247.50 actually deducted from their bank account?

### Question 4: What Happened on the Retry?

The customer clicked "Pay" again with the same idempotency key. What will happen?

### Question 5: What If They Used a Different Idempotency Key?

Suppose the frontend generates a new idempotency key on each click (a common bug). What happens then?

### Question 6: Which Failure Model Applies?

Classify the failure of each service from the API Gateway's perspective using the taxonomy from Chapter 3.

---

## Answers

### Answer 1: The Timeline

```
Time (ms from start)    Event
─────────────────────────────────────────────────────────
   0    A receives HTTP request from client
   2    A sends request to B
  44    B receives request (42ms network latency)
  49    B creates order, sends request to C
 109    C receives request (60ms network latency)
 112    C sends request to D (Fraud Check)
 197    D receives request (85ms network latency)
2147    D returns decision (1950ms processing)
2217    C receives fraud result (70ms return latency)
2219    C sends request to E (Bank Gateway)
2302    E receives request (83ms network latency)
4699    E receives bank API response (2397ms bank processing)
4700    E returns to C
4807    C receives bank result (107ms return latency)
4812    C stores idempotency result, returns to B
4888    B receives payment result (76ms return latency)
4891    B updates order, returns to A
       ??? A receives response from B ???
5002    A times out (5000ms deadline)
5003    A returns 504 to client
```

The critical insight: **B sent its response at 14:22:05.894Z, and A timed out at 14:22:06.005Z.** That's a gap of only 111ms. The response from B was *in flight on the network* when A's timeout fired.

### Answer 2: The Race Condition

This is a textbook illustration of why **you can't tell dead from slow** (Chapter 7).

From A's perspective, B could have been:
1. **Crashed** — B is dead, the request was lost
2. **Slow** — B is still processing
3. **Done but the response is in transit** — B already responded, but the network hasn't delivered it yet

A can't distinguish these cases. Its 5-second timeout is a *guess* — a heuristic, not a fact. In this case, the guess was wrong by about 111 milliseconds.

This is the **Two Generals Problem** (Chapter 5) in action. A needs to know whether the payment succeeded, but the communication channel (the network) is unreliable. There is no number of additional messages that can give A certainty.

### Answer 3: Yes, the Payment Was Charged

The bank deducted $247.50 at ~14:22:05.702Z. The transaction completed successfully. Every service in the chain (D → E → C → B) returned success. But the response from B arrived at A ~111ms too late.

The customer was charged, but was told the payment failed. This is an **omission failure** (Chapter 3) from A's perspective — B's response was effectively lost (or rather, arrived after A stopped listening).

### Answer 4: Idempotency Saves the Day (If Implemented Correctly)

When the retry arrives with the same `ik_9f8e7d`:

1. A forwards to B
2. B calls C
3. C looks up `ik_9f8e7d` in its idempotency store
4. C finds the stored result: `{status: "charged", txn_id: "txn_882"}`
5. C returns the cached result **without calling the bank again**
6. The response propagates back: C → B → A → client

The customer sees "Payment Successful" and is charged exactly once. The idempotency key prevented a double charge.

But this only works because:
- C stored the idempotency result *after* the bank confirmed (line: `Stored idempotency result for ik_9f8e7d -> charged`)
- The idempotency key is scoped to the *payment*, not the *request*
- C's idempotency store is durable (survives restarts)

### Answer 5: Double Charge

If the frontend generates a new idempotency key (e.g., `ik_a1b2c3`) on each click:

1. C sees a new key it hasn't encountered before
2. C treats it as a brand-new payment
3. C calls the bank again
4. The bank charges another $247.50

The customer is now charged $495.00. This is the most common payment bug in production systems, and it stems from a misunderstanding of where idempotency keys should be generated (the answer: on the client, once per user intent, persisted across retries).

### Answer 6: Failure Classification

From A's perspective:

| Service | What A Observes | Failure Model |
|---------|----------------|---------------|
| A (self) | Functioning correctly | No failure |
| B | No response within 5s | **Omission failure** — B sent a response, but A never received it in time. From A's perspective this is indistinguishable from a crash-stop failure. |
| C, D, E | A has no visibility | Unknown — A doesn't even know these services exist. It only talks to B. |

This highlights a key point: **the failure model depends on the observer.** B didn't fail from B's perspective — it completed successfully. But from A's perspective, B committed an omission failure. The system model (Chapter 4) determines what A is *allowed to assume* about B's state after the timeout.

---

## The Deeper Lessons

### 1. Timeouts Are Heuristics, Not Facts

A's 5-second timeout was a design decision. Setting it to 6 seconds would have made this request succeed. Setting it to 4 seconds would have caused more false failures. There is no "correct" timeout — only trade-offs between:
- **Too short**: False positives (healthy services declared dead)
- **Too long**: The client waits forever; resources pile up

This is why Chapter 8's phi accrual failure detector exists — it replaces a single timeout with a continuous suspicion level.

### 2. Success and Failure Are Not Binary

The payment *succeeded* (the bank charged the card) and *failed* (the customer was told it failed) simultaneously. In a distributed system, "did it work?" is not a yes/no question — it's "from whose perspective?"

### 3. Idempotency Is Not Optional

Without idempotency keys, every timeout becomes a potential double-charge. Idempotency is not a nice-to-have; it's the only mechanism that makes retries safe. And it must be implemented at the right layer — the service that talks to the external side-effecting system (here, the bank).

### 4. The Two Generals Problem Is Not Academic

The customer wants to know: "Was I charged?" The API Gateway cannot answer this with certainty. It could:
- Call B again to check (but what if *that* call also times out?)
- Query the bank directly (but now A needs to know about E, breaking service boundaries)
- Return "unknown" to the client (honest, but terrible UX)

There is no protocol that gives A certainty. The Two Generals Problem is real, and idempotency + retries is the pragmatic workaround.

### 5. Observability Across Clock Boundaries

Notice that reconstructing the timeline required aligning timestamps from five different machines. If their NTP synchronization is off by even 100ms, the causal ordering becomes ambiguous. In Part 2, we'll see how Lamport clocks and vector clocks solve this without relying on synchronized wall clocks.

---

## Try It Yourself

1. **Change the timeout**: What happens if A's timeout is 3 seconds instead of 5? Trace which services would have completed and which wouldn't.

2. **Add a crash**: Suppose C crashes *after* calling the bank but *before* storing the idempotency result. Now what happens on retry? (This is the crash-recovery model from Chapter 3.)

3. **Add a network partition**: Suppose the network between C and B goes down for 10 seconds starting at 14:22:05.800Z. C has already charged the bank. Draw the timeline and determine the system's final state.

4. **Design the fix**: Sketch a protocol where the customer always sees the correct payment status, even when the API Gateway times out. What are the minimum components you need? (Hint: you'll need concepts from Parts 2 and 4.)

---

**Next**: [Part 2 — Time, Clocks & Storage Engines →](../part2/ch09-physical-clocks.md)
