# Putting It Together: Flight Booking System

> **Exercise**: Design a flight booking system where seat inventory and payment records live on separate services. Use the Outbox pattern to guarantee a seat is reserved if and only if the payment succeeds — without 2PC. Write a compensating saga for the failure case where the payment service goes down after the seat is reserved.

This exercise ties together serializability vs linearizability (Ch 25), why we avoid 2PC in microservices (Ch 26), the Outbox pattern (Ch 31), exactly-once semantics (Ch 30), and idempotency.

---

## The Architecture

```
┌────────────┐      ┌─────────────────┐      ┌──────────────────┐
│  Booking   │      │  Seat Inventory  │      │  Payment         │
│  Orchestrator│────▶│  Service         │      │  Service         │
│  (Saga)    │────▶│  (seats_db)      │      │  (payments_db)   │
└────────────┘      └────────┬────────┘      └────────┬─────────┘
       │                     │                         │
       │              ┌──────▼──────┐           ┌──────▼──────┐
       │              │  seats_db   │           │ payments_db │
       │              │  + outbox   │           │  + outbox   │
       │              └──────┬──────┘           └──────┬──────┘
       │                     │ CDC / Poller            │ CDC / Poller
       │              ┌──────▼──────────────────────────▼──────┐
       └─────────────▶│          Message Broker (Kafka)        │
                      └────────────────────────────────────────┘
```

Two separate databases. No shared transactions. The Outbox pattern keeps each database in sync with Kafka without 2PC.

---

## Database Schemas

### Seat Inventory Service — `seats_db`

```sql
CREATE TABLE seats (
    flight_id       TEXT NOT NULL,
    seat_number     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'AVAILABLE',
                    -- AVAILABLE | HELD | RESERVED | RELEASED
    hold_id         TEXT,          -- reservation attempt that holds this seat
    hold_expires_at TIMESTAMPTZ,   -- soft lock TTL
    version         INT NOT NULL DEFAULT 0,  -- optimistic concurrency
    PRIMARY KEY (flight_id, seat_number)
);

CREATE TABLE outbox (
    id              BIGSERIAL PRIMARY KEY,
    aggregate_type  TEXT NOT NULL,     -- e.g. 'seat_reservation'
    aggregate_id    TEXT NOT NULL,     -- e.g. 'FL100-14A'
    event_type      TEXT NOT NULL,     -- e.g. 'SeatHeld', 'SeatReleased'
    payload         JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    published       BOOLEAN NOT NULL DEFAULT FALSE
);
```

### Payment Service — `payments_db`

```sql
CREATE TABLE payments (
    payment_id      TEXT PRIMARY KEY,
    booking_id      TEXT NOT NULL,
    amount_cents    INT NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'USD',
    status          TEXT NOT NULL DEFAULT 'PENDING',
                    -- PENDING | CHARGED | REFUNDED | FAILED
    idempotency_key TEXT UNIQUE NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
    id              BIGSERIAL PRIMARY KEY,
    aggregate_type  TEXT NOT NULL,
    aggregate_id    TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    payload         JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    published       BOOLEAN NOT NULL DEFAULT FALSE
);
```

### Booking Orchestrator — `bookings_db`

```sql
CREATE TABLE bookings (
    booking_id      TEXT PRIMARY KEY,
    flight_id       TEXT NOT NULL,
    seat_number     TEXT NOT NULL,
    passenger_name  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'INITIATED',
                    -- INITIATED | SEAT_HELD | PAYMENT_CHARGED | CONFIRMED
                    -- | PAYMENT_FAILED | COMPENSATING | CANCELLED
    idempotency_key TEXT UNIQUE NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE saga_log (
    id              BIGSERIAL PRIMARY KEY,
    booking_id      TEXT NOT NULL,
    step            TEXT NOT NULL,   -- 'hold_seat', 'charge_payment', 'release_seat', ...
    status          TEXT NOT NULL,   -- 'STARTED', 'SUCCEEDED', 'FAILED', 'COMPENSATED'
    detail          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## The Happy Path: Step by Step

```
Customer                Orchestrator          Seat Service           Payment Service
   │                        │                      │                       │
   │  POST /book            │                      │                       │
   │  {flight: FL100,       │                      │                       │
   │   seat: 14A,           │                      │                       │
   │   card: tok_xxx}       │                      │                       │
   ├───────────────────────▶│                      │                       │
   │                        │                      │                       │
   │                 ┌──────┤ 1. Create booking     │                       │
   │                 │ saga │    status=INITIATED   │                       │
   │                 │ log  │                      │                       │
   │                 └──────┤                      │                       │
   │                        │                      │                       │
   │                        │  2. HoldSeat(FL100,  │                       │
   │                        │     14A, booking_id) │                       │
   │                        ├─────────────────────▶│                       │
   │                        │                      │                       │
   │                        │                      │ BEGIN TX               │
   │                        │                      │  UPDATE seats          │
   │                        │                      │    SET status='HELD',  │
   │                        │                      │    hold_id=booking_id  │
   │                        │                      │  WHERE status='AVAILABLE'
   │                        │                      │  INSERT INTO outbox    │
   │                        │                      │    (SeatHeld event)    │
   │                        │                      │ COMMIT TX              │
   │                        │                      │                       │
   │                        │  3. SeatHeld event   │                       │
   │                        │◀─────────────────────┤                       │
   │                        │  (via Kafka/outbox)  │                       │
   │                        │                      │                       │
   │                 ┌──────┤ 4. Update booking     │                       │
   │                 │ saga │    status=SEAT_HELD   │                       │
   │                 └──────┤                      │                       │
   │                        │                      │                       │
   │                        │  5. ChargePayment     │                       │
   │                        │     (booking_id,      │                       │
   │                        │      amount, card)    │                       │
   │                        ├──────────────────────────────────────────────▶│
   │                        │                      │                       │
   │                        │                      │              BEGIN TX  │
   │                        │                      │   INSERT payments     │
   │                        │                      │     status='CHARGED'  │
   │                        │                      │   INSERT outbox       │
   │                        │                      │     (PaymentCharged)  │
   │                        │                      │              COMMIT   │
   │                        │                      │                       │
   │                        │  6. PaymentCharged    │                       │
   │                        │◀─────────────────────────────────────────────┤
   │                        │  (via Kafka/outbox)  │                       │
   │                        │                      │                       │
   │                 ┌──────┤ 7. Update booking     │                       │
   │                 │ saga │    status=CONFIRMED   │                       │
   │                 └──────┤                      │                       │
   │                        │                      │                       │
   │  200 OK {confirmed}    │                      │                       │
   │◀───────────────────────┤                      │                       │
```

### Why the Outbox Pattern Matters Here

At step 2, the Seat Service does two things in **one database transaction**:
1. Updates the seat status to `HELD`
2. Writes a `SeatHeld` event to its local `outbox` table

Because both happen in the same transaction, either both persist or neither does. A separate CDC process (Debezium) or a poller reads the outbox and publishes to Kafka. If the publisher crashes after reading but before marking `published=TRUE`, it will re-publish the event — consumers must be **idempotent**.

Without the Outbox pattern, a dual-write approach would be:
```
UPDATE seats SET status='HELD';  -- succeeds
publish_to_kafka('SeatHeld');    -- fails: Kafka is down!
-- Now the DB says HELD but no event was emitted.
-- The orchestrator never hears about it. The seat is stuck.
```

---

## The Failure Path: Payment Service Down After Seat Held

```
Customer                Orchestrator          Seat Service           Payment Service
   │                        │                      │                       │
   │  POST /book            │                      │                       │
   ├───────────────────────▶│                      │                       │
   │                        │ 1. HoldSeat          │                       │
   │                        ├─────────────────────▶│ ✓ Seat held           │
   │                        │◀─────────────────────┤                       │
   │                        │                      │                       │
   │                        │ 2. ChargePayment     │                       │
   │                        ├──────────────────────────────────────────╳   │
   │                        │                      │              ╳ DOWN ╳ │
   │                        │                      │                       │
   │                        │ (timeout after 5s)   │                       │
   │                        │                      │                       │
   │                        │  *** COMPENSATION BEGINS ***                 │
   │                        │                      │                       │
   │                        │ 3. ReleaseSeat       │                       │
   │                        │    (booking_id)      │                       │
   │                        ├─────────────────────▶│                       │
   │                        │                      │ BEGIN TX               │
   │                        │                      │  UPDATE seats          │
   │                        │                      │    SET status='RELEASED'
   │                        │                      │  INSERT outbox         │
   │                        │                      │    (SeatReleased)      │
   │                        │                      │ COMMIT TX              │
   │                        │◀─────────────────────┤                       │
   │                        │                      │                       │
   │                 ┌──────┤ 4. Update booking     │                       │
   │                 │ saga │    status=CANCELLED   │                       │
   │                 └──────┤                      │                       │
   │                        │                      │                       │
   │  409 {booking_cancelled,│                     │                       │
   │   reason: payment_failed}                     │                       │
   │◀───────────────────────┤                      │                       │
```

---

## The Saga Orchestrator: Pseudocode

```python
class BookingSaga:
    def __init__(self, seat_service, payment_service, db):
        self.seat_svc = seat_service
        self.payment_svc = payment_service
        self.db = db

    def execute(self, booking_id, flight_id, seat, amount, card_token, idempotency_key):
        self.db.create_booking(booking_id, flight_id, seat, idempotency_key)
        self.db.log_saga_step(booking_id, 'hold_seat', 'STARTED')

        # Step 1: Hold the seat
        try:
            self.seat_svc.hold_seat(flight_id, seat, booking_id)
            self.db.log_saga_step(booking_id, 'hold_seat', 'SUCCEEDED')
            self.db.update_booking_status(booking_id, 'SEAT_HELD')
        except (TimeoutError, SeatUnavailableError) as e:
            self.db.log_saga_step(booking_id, 'hold_seat', 'FAILED', str(e))
            self.db.update_booking_status(booking_id, 'CANCELLED')
            return BookingResult(status='FAILED', reason='seat_unavailable')

        # Step 2: Charge payment
        self.db.log_saga_step(booking_id, 'charge_payment', 'STARTED')
        try:
            self.payment_svc.charge(booking_id, amount, card_token, idempotency_key)
            self.db.log_saga_step(booking_id, 'charge_payment', 'SUCCEEDED')
            self.db.update_booking_status(booking_id, 'CONFIRMED')
            return BookingResult(status='CONFIRMED')
        except TimeoutError:
            # AMBIGUOUS: payment may or may not have been charged.
            # We do NOT know. Must compensate conservatively.
            self.db.log_saga_step(booking_id, 'charge_payment', 'FAILED', 'timeout')
            self._compensate(booking_id, flight_id, seat, idempotency_key)
            return BookingResult(status='CANCELLED', reason='payment_timeout')
        except PaymentDeclinedError as e:
            self.db.log_saga_step(booking_id, 'charge_payment', 'FAILED', str(e))
            self._compensate(booking_id, flight_id, seat, idempotency_key)
            return BookingResult(status='CANCELLED', reason='payment_declined')

    def _compensate(self, booking_id, flight_id, seat, idempotency_key):
        """Release the held seat. If payment went through, refund it."""
        self.db.update_booking_status(booking_id, 'COMPENSATING')

        # Compensation Step 1: Release the seat
        self.db.log_saga_step(booking_id, 'release_seat', 'STARTED')
        for attempt in range(5):
            try:
                self.seat_svc.release_seat(flight_id, seat, booking_id)
                self.db.log_saga_step(booking_id, 'release_seat', 'SUCCEEDED')
                break
            except TimeoutError:
                time.sleep(2 ** attempt)  # exponential backoff
        else:
            # Seat release failed after retries.
            # The hold has a TTL and will expire automatically.
            self.db.log_saga_step(booking_id, 'release_seat', 'FAILED',
                                  'retries exhausted; hold will expire via TTL')

        # Compensation Step 2: Refund if payment was charged
        self.db.log_saga_step(booking_id, 'check_and_refund', 'STARTED')
        try:
            payment = self.payment_svc.get_payment(idempotency_key)
            if payment and payment.status == 'CHARGED':
                self.payment_svc.refund(payment.payment_id)
                self.db.log_saga_step(booking_id, 'check_and_refund', 'SUCCEEDED',
                                      'refunded')
            else:
                self.db.log_saga_step(booking_id, 'check_and_refund', 'SUCCEEDED',
                                      'no charge found')
        except TimeoutError:
            # Payment service still down. Schedule async retry.
            self.db.log_saga_step(booking_id, 'check_and_refund', 'FAILED',
                                  'scheduled for async retry')
            self._schedule_compensation_retry(booking_id)

        self.db.update_booking_status(booking_id, 'CANCELLED')
```

---

## Failure Analysis: Every Step That Can Go Wrong

| Step | Failure | Consequence | Resolution |
|------|---------|-------------|------------|
| Hold seat | Seat Service down | No seat held, no side effect | Return failure immediately, no compensation needed |
| Hold seat | Seat already taken | Hold fails with conflict | Return "seat unavailable" |
| Hold seat succeeds, then orchestrator crashes | Seat is held, no payment attempted | Hold TTL expires (e.g. 10 min), seat auto-releases |
| Charge payment | Payment Service down (timeout) | Seat held, payment status **unknown** | Compensate: release seat, check-and-refund later |
| Charge payment | Card declined | Seat held, no charge | Compensate: release seat |
| Charge payment succeeds, then orchestrator crashes | Seat held, payment charged, booking not confirmed | Recovery process reads saga_log, sees charge succeeded, re-confirms booking |
| Release seat (compensation) | Seat Service down | Seat stays held | Retry with backoff; hold TTL is the safety net |
| Refund (compensation) | Payment Service still down | Customer charged but booking cancelled | Async retry job; alert ops if retries exhausted |

### The Ambiguous Timeout

The hardest case is the payment timeout. When `ChargePayment` times out, the orchestrator doesn't know whether:
1. The request never reached the Payment Service (no charge)
2. The Payment Service charged the card but the response was lost (charged!)
3. The Payment Service is still processing (will be charged)

This is the **Two Generals Problem** (Part 1, Ch 5). The orchestrator cannot know with certainty. Its strategy:

1. **Assume the worst**: treat the booking as failed and begin compensation.
2. **Check later**: query the Payment Service to see if a charge exists for this `idempotency_key`.
3. **Refund if necessary**: if a charge went through, issue a refund.
4. **Idempotency everywhere**: every compensation step is idempotent, so retries are safe.

---

## Why Not 2PC?

Two-Phase Commit (Chapter 26) could theoretically solve this: the Seat Service and Payment Service both participate in a distributed transaction. But in practice:

1. **Blocking**: If the coordinator crashes after participants vote YES, both services are stuck holding locks, unable to serve other requests.
2. **Latency**: Synchronous disk writes (force-logging) at every phase boundary add ~10-20ms per participant.
3. **Coupling**: Both services must implement the XA protocol, creating tight operational coupling.
4. **Heterogeneous systems**: 2PC requires all participants to speak the same protocol. Real payment gateways (Stripe, Adyen) don't implement XA.

The saga with Outbox trades **atomicity** for **eventual consistency with compensation**. The system may be temporarily inconsistent (seat held, payment not yet charged), but it converges to a consistent state through the saga's forward or compensating actions.

---

## Exercises

1. **Add a notification step**: After the booking is confirmed, the saga should send a confirmation email. If the email service is down, should the booking be rolled back? Design the step and justify your decision.

2. **Concurrent bookings**: Two customers try to book the same seat at the same instant. Trace both sagas through the system. At what point does one fail? Which concurrency control mechanism (in the Seat Service) prevents double-booking?

3. **Orchestrator crash recovery**: The orchestrator crashes after charging payment but before updating the booking to CONFIRMED. Write the recovery procedure that runs on restart by reading the `saga_log` table.

4. **Replace orchestration with choreography**: Redesign the system so that there is no central orchestrator. Each service reacts to events on Kafka. Draw the event flow. What are the trade-offs versus the orchestration approach?

5. **Hold TTL race condition**: The seat hold expires (TTL) at the exact moment the payment succeeds. Now the seat is released and given to another customer, but the first customer has been charged. Design a protocol to prevent this.

6. **Exactly-once with Kafka transactions**: The Payment Service's outbox publisher crashes after reading the outbox but before marking events as published. On restart, it re-publishes the same `PaymentCharged` event. Show how the orchestrator's idempotent consumer handles the duplicate.

---

**Next**: [Part 5 — Capstone System Designs →](../part5/capstone01-distributed-kv-store.md)
