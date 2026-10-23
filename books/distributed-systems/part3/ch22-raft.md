# Chapter 22: Raft — Full Algorithm and Safety Proof

> *How does Raft guarantee that exactly one leader is elected per term, and what prevents two leaders from committing conflicting log entries?*

**Prerequisites**: Chapter 17 (Primary-Backup Replication), Chapter 20 (CAP Theorem), Chapter 21 (FLP Impossibility)

---

## Why Raft Exists

In 2014, Diego Ongaro and John Ousterhout published "In Search of an Understandable Consensus Algorithm." Their motivation was blunt: Paxos, the dominant consensus algorithm since Lamport's 1989 paper, is notoriously difficult to understand and even harder to implement correctly.

Ongaro conducted a formal study: he taught both Paxos and Raft to Stanford graduate students and measured comprehension. Raft scored significantly higher. The algorithm was designed from the ground up for understandability, using two key principles:

1. **Decomposition**: Break consensus into independent subproblems (leader election, log replication, safety).
2. **State space reduction**: Minimize the number of states the system can be in by making things more deterministic (e.g., logs never have holes).

Raft and Paxos are equivalent in power — both solve consensus in the partial synchrony model with crash faults. Raft's contribution is making the algorithm clear enough that engineers can implement it correctly.

---

## The Big Picture: What Raft Does

Raft implements a **replicated state machine**. Multiple servers maintain identical copies of a log of commands. A client sends a command; the servers agree on the order of commands; each server applies commands to its state machine in that order. The result: every server has the same state.

```
Client ──▶ Leader ──▶ Replicate to followers ──▶ Commit ──▶ Apply to state machine

┌─────────────────────────────────────────────────────────┐
│                    Server 1 (Leader)                     │
│  Log: [set x=1] [set y=2] [del x] [set z=3]           │
│  State Machine: {y=2, z=3}                              │
├─────────────────────────────────────────────────────────┤
│                    Server 2 (Follower)                   │
│  Log: [set x=1] [set y=2] [del x] [set z=3]           │
│  State Machine: {y=2, z=3}                              │
├─────────────────────────────────────────────────────────┤
│                    Server 3 (Follower)                   │
│  Log: [set x=1] [set y=2] [del x] [set z=3]           │
│  State Machine: {y=2, z=3}                              │
└─────────────────────────────────────────────────────────┘
All logs identical → All state machines identical
```

Raft decomposes this into three subproblems:

1. **Leader election**: How do servers choose one leader?
2. **Log replication**: How does the leader replicate log entries to followers?
3. **Safety**: How do we guarantee that all servers apply the same commands in the same order, even when servers crash and restart?

---

## Core Concepts

### Server States

Every Raft server is in one of three states:

```
              times out,           receives votes
              starts election      from majority
┌──────────┐ ──────────────▶ ┌───────────┐ ──────────────▶ ┌──────────┐
│ Follower │                 │ Candidate │                  │  Leader  │
└──────────┘ ◀────────────── └───────────┘                  └──────────┘
                discovers                                        │
                current leader                                   │
                or new term          ◀───────────────────────────┘
                                          discovers server
                                          with higher term
```

- **Follower**: Passive. Responds to RPCs from leaders and candidates. If it hears nothing for a while, it becomes a candidate.
- **Candidate**: Actively trying to become leader. Requests votes from other servers.
- **Leader**: Handles all client requests. Replicates log entries to followers.

### Terms

Time is divided into **terms** of arbitrary length. Each term begins with an election. Terms are numbered with monotonically increasing integers.

```
Term 1          Term 2       Term 3        Term 4
┌──────────────┐┌───────────┐┌────────────┐┌──────────────────
│ election │    ││ election  ││ election   ││ election │
│  ↓      │    ││   ↓       ││ (no leader ││   ↓      │
│ leader   │    ││ leader    ││  elected)  ││ leader   │
│ normal   │    ││ normal    ││            ││ normal   │
│ operation│    ││ operation ││            ││ operation│
└──────────────┘└───────────┘└────────────┘└──────────────────
    time ──────────────────────────────────────────────▶
```

Terms serve as a **logical clock** (Chapter 10). Each server stores its current term number, which it includes in every RPC. If a server receives a message with a higher term, it updates its term and reverts to follower. If a server receives a message with a stale (lower) term, it rejects the message.

```
Rules for terms:
1. Each server persists its currentTerm to stable storage.
2. currentTerm increases monotonically.
3. If you receive an RPC with term > currentTerm:
   → set currentTerm = that term
   → revert to follower state
4. If you receive an RPC with term < currentTerm:
   → reject the RPC (stale)
```

### The Raft Log

Each server maintains a **log** of entries. Each entry contains:
- A **command** (the state machine operation)
- The **term number** in which it was created
- The **index** (position in the log, starting at 1)

```
Index:  1        2        3        4        5
      ┌────────┬────────┬────────┬────────┬────────┐
Term: │ term 1 │ term 1 │ term 2 │ term 3 │ term 3 │
      ├────────┼────────┼────────┼────────┼────────┤
Cmd:  │ x ← 1 │ y ← 2 │ x ← 3 │ y ← 1 │ z ← 5 │
      └────────┴────────┴────────┴────────┴────────┘
                                    ▲
                              commitIndex = 4
                    (entries 1-4 are committed and applied)
```

A critical property: **Raft logs have no holes.** Every entry occupies a consecutive index. This is a deliberate simplification over Paxos, which allows gaps.

---

## Subproblem 1: Leader Election

### Election Trigger

A follower starts an election when its **election timer** expires without receiving a heartbeat from the leader.

The election timeout is chosen randomly from a range (e.g., 150–300ms). This randomization is critical — it prevents split votes where multiple candidates start elections simultaneously.

### The Election Process

```
Follower's election timer expires:

1. Increment currentTerm
2. Transition to candidate state
3. Vote for self
4. Send RequestVote RPC to all other servers
5. Wait for responses:
   a. Receive votes from majority → become leader
   b. Receive AppendEntries from valid leader → revert to follower
   c. Election timer expires again → start new election (back to step 1)
```

### RequestVote RPC

```
RequestVote Arguments:
  term:         candidate's current term
  candidateId:  candidate requesting the vote
  lastLogIndex: index of candidate's last log entry
  lastLogTerm:  term of candidate's last log entry

RequestVote Results:
  term:         currentTerm of the voter (for candidate to update itself)
  voteGranted:  true if the voter granted the vote
```

### Voting Rules

A server grants its vote if and only if **all** of these are true:

1. The candidate's term ≥ the voter's currentTerm.
2. The voter has not already voted in this term (or voted for this same candidate).
3. The candidate's log is **at least as up-to-date** as the voter's log.

The "at least as up-to-date" comparison is crucial for safety:

```python
def is_candidate_log_up_to_date(candidate_last_term, candidate_last_index,
                                 my_last_term, my_last_index):
    if candidate_last_term != my_last_term:
        return candidate_last_term > my_last_term
    return candidate_last_index >= my_last_index
```

The log with the higher last term is more up-to-date. If the terms are equal, the longer log is more up-to-date. This ensures that a candidate with a stale log cannot become leader.

### Why Randomized Timeouts Work

Without randomization, a common failure pattern:

```
Without randomization (all timeouts = 200ms):

Time 0ms:    Leader crashes
Time 200ms:  ALL followers timeout simultaneously
             ALL become candidates
             ALL vote for themselves
             Nobody gets a majority
Time 400ms:  ALL timeout again, start new election
             Repeat forever → LIVELOCK
```

With randomization (timeouts between 150–300ms):

```
With randomization:

Time 0ms:    Leader crashes
Time 162ms:  Server B times out first (drew 162ms)
             B becomes candidate, sends RequestVote to all
Time 162ms:  Servers A, C, D, E haven't timed out yet
             They receive B's RequestVote
             They grant votes to B
             B receives majority → becomes leader
Time 210ms:  Server D would have timed out (drew 210ms)
             But B is already sending heartbeats
             D's timer is reset
```

The probability of a split vote decreases exponentially with the spread of the random timeout range. In practice, elections typically complete in one round.

### Election Safety Property

**Theorem**: At most one leader can be elected in any given term.

**Proof**:
1. Each server votes for at most one candidate per term (persisted to stable storage before responding).
2. A candidate needs votes from a majority of servers to win.
3. Any two majorities in a cluster of N servers overlap in at least one server.
4. That overlapping server voted for one candidate, so it cannot also vote for another in the same term.
5. Therefore, two different candidates cannot both receive a majority in the same term. ∎

```
5-server cluster: need 3 votes to win.

Candidate A gets votes from: {1, 2, 3}     ← majority
Candidate B gets votes from: {3, 4, 5}     ← majority

But server 3 voted for BOTH?
Impossible — server 3 votes for at most one candidate per term.

Therefore A and B cannot both win in the same term.
```

### Persisted State

Three pieces of state must be **persisted to stable storage** before responding to any RPC:

1. `currentTerm` — must survive restarts so a server doesn't vote twice
2. `votedFor` — must survive restarts so a server doesn't vote twice
3. `log[]` — must survive restarts so committed entries aren't lost

If any of these is lost on restart, safety can be violated. This is the most common implementation bug in Raft.

---

## Subproblem 2: Log Replication

### Normal Operation

Once a leader is elected, it serves all client requests:

```
1. Client sends command to leader
2. Leader appends command to its local log
3. Leader sends AppendEntries RPC to each follower
4. Follower appends entry to its log, responds success
5. Once a majority of servers have the entry:
   → Leader marks entry as committed
   → Leader applies entry to its state machine
   → Leader responds to client
6. Followers learn about committed entries in subsequent AppendEntries
   → Followers apply committed entries to their state machines
```

### AppendEntries RPC

```
AppendEntries Arguments:
  term:          leader's current term
  leaderId:      so followers can redirect clients
  prevLogIndex:  index of log entry immediately preceding new entries
  prevLogTerm:   term of prevLogIndex entry
  entries[]:     log entries to append (empty for heartbeat)
  leaderCommit:  leader's commitIndex

AppendEntries Results:
  term:          currentTerm of the follower
  success:       true if follower contained entry matching prevLogIndex/prevLogTerm
```

### The Consistency Check

The key mechanism: when the leader sends AppendEntries, it includes the **index and term of the entry immediately before** the new entries (`prevLogIndex` and `prevLogTerm`). The follower checks that it has an entry at `prevLogIndex` with term `prevLogTerm`.

```
Leader's log:
  Index: 1      2      3      4      5
  Term:  [1]    [1]    [2]    [3]    [3]

Leader sends AppendEntries for entry at index 5:
  prevLogIndex = 4
  prevLogTerm = 3
  entries = [{index: 5, term: 3, cmd: "set z=5"}]

Follower checks:
  "Do I have an entry at index 4 with term 3?"
  YES → accept, append entry 5
  NO  → reject, I'm missing entries
```

If the follower rejects, the leader **decrements prevLogIndex and retries** until it finds the point where the logs agree. Then it sends all entries from that point forward, overwriting any conflicting entries on the follower.

```
Leader's log:     [1:t1] [2:t1] [3:t2] [4:t3] [5:t3]
Follower's log:   [1:t1] [2:t1] [3:t2] [4:t2]
                                         ▲
                                   Conflict at index 4!
                                   Leader has term 3, follower has term 2.

Step 1: Leader sends prevLogIndex=4, prevLogTerm=3 → REJECTED
Step 2: Leader sends prevLogIndex=3, prevLogTerm=2 → ACCEPTED
Step 3: Leader sends entries 4 and 5
        Follower overwrites index 4 (was t2, now t3) and appends index 5

After reconciliation:
Leader's log:     [1:t1] [2:t1] [3:t2] [4:t3] [5:t3]
Follower's log:   [1:t1] [2:t1] [3:t2] [4:t3] [5:t3]  ← identical
```

### Optimization: Fast Log Backtracking

The naive approach (decrement by 1 each time) can be slow if a follower is far behind. An optimization: on rejection, the follower returns the **conflicting term** and the **first index of that term**. The leader can skip directly to the right point.

```python
# Follower's rejection response includes:
conflictTerm = log[prevLogIndex].term  # The term that conflicts
conflictIndex = first index where term == conflictTerm

# Leader finds:
# - If leader has entries with conflictTerm:
#   nextIndex = leader's last entry for that term + 1
# - If leader doesn't have conflictTerm:
#   nextIndex = conflictIndex
```

### The Log Matching Property

**Theorem (Log Matching)**: If two logs contain an entry with the same index and term, then:
1. The entries store the same command.
2. The logs are identical in all preceding entries.

**Proof**:
1. A leader creates at most one entry per index per term (entries are assigned consecutive indices). So same index + same term = same command.
2. The AppendEntries consistency check ensures this inductively. When a follower accepts an AppendEntries at index k, it has verified that index k-1 matches the leader's log. By induction from the start of the log, all entries up to k are identical. ∎

This property is fundamental to Raft's safety: if two servers agree on any log entry, they agree on the entire history up to that point.

---

## Subproblem 3: Safety

The central safety property of Raft:

**State Machine Safety**: If a server has applied a log entry at a given index to its state machine, no other server will ever apply a different entry for that index.

This requires two sub-properties:

### Leader Completeness Property

**If a log entry is committed in a given term, that entry will be present in the logs of all leaders for all higher-numbered terms.**

This is the most important safety property. It guarantees that once an entry is committed, no future leader can "lose" it.

#### Why the Voting Restriction Matters

Recall the voting rule: a candidate's log must be "at least as up-to-date" as the voter's log. This is not just an optimization — it is essential for leader completeness.

Consider what would happen without this restriction:

```
A 5-server cluster. Entry E at index 4 is committed (replicated to S1, S2, S3).

S1: [1:t1] [2:t1] [3:t2] [4:t2]  ← has E
S2: [1:t1] [2:t1] [3:t2] [4:t2]  ← has E
S3: [1:t1] [2:t1] [3:t2] [4:t2]  ← has E
S4: [1:t1] [2:t1] [3:t2]          ← missing E
S5: [1:t1] [2:t1] [3:t2]          ← missing E

Now S1, S2, S3 crash. S4 starts an election.

WITHOUT the log restriction:
  S4 gets votes from S4, S5 (only 2 available) ... not a majority.
  Actually, S4 can't win because there are only 2 servers alive out of 5.

But consider: S1, S2 crash. S4 starts election.
  S4 needs 3 votes: itself (S4), S5, and one of {S1, S2, S3}.
  S3 is up and has E. If S3 grants the vote...

WITH the log restriction:
  S3 compares: S4's last log (index 3, term 2) vs S3's last log (index 4, term 2).
  S4's log is SHORTER. S3 denies the vote.
  S4 cannot become leader. ✓

  Only a candidate with E in its log can get votes from servers that have E.
  Since E is on a majority, any majority must include at least one server with E.
  That server will deny the vote to a candidate without E.
```

#### Formal Proof of Leader Completeness

**Theorem**: If entry E is committed during term T, then E appears in the log of every leader of term T' > T.

**Proof** (by contradiction):

Assume E is committed in term T but there exists a leader L of term T' > T that does not have E. Choose the smallest such T'.

1. E was committed, so it is on a majority of servers S_commit.
2. L won the election in term T', so it received votes from a majority S_vote.
3. S_commit and S_vote overlap (any two majorities share at least one member). Call the overlap server V.
4. V has E (it's in S_commit) and V voted for L (it's in S_vote).
5. V must have voted for L **after** E was committed (because V had E in its log when it voted — committed entries are durable).
6. V voted for L, which means L's log was at least as up-to-date as V's log.
7. Case analysis on V's vote:

   **Case a**: L's last log term > V's last log term.
   Then L's log has entries from a term between T and T'. By our assumption that T' is the smallest term with a leader missing E, the leader of that intermediate term had E. So L must have received E from that leader (entries propagate through leaders). Contradiction.

   **Case b**: L's last log term = V's last log term, and L's log is at least as long as V's.
   V has E, so L's log (being at least as long with the same last term) must also contain E. Contradiction.

In both cases, L must have E. ∎

### The Commitment Rule: Only Commit Current-Term Entries

There is a subtle edge case that Raft handles with a specific rule: **a leader may only commit entries from its current term by counting replicas.** Entries from previous terms are committed indirectly when a current-term entry is committed after them.

The reason is illustrated by this scenario:

```
Timeline (5 servers: S1-S5):

(a) S1 is leader of term 2. Replicates entry at index 2 (term 2) to S2.

S1: [1:t1] [2:t2]          S1 is leader
S2: [1:t1] [2:t2]
S3: [1:t1]
S4: [1:t1]
S5: [1:t1]

(b) S1 crashes. S5 is elected leader of term 3 (votes from S3, S4, S5).
    S5 receives a client request, appends entry at index 2 (term 3).

S1: [1:t1] [2:t2]          (crashed)
S2: [1:t1] [2:t2]
S3: [1:t1]
S4: [1:t1]
S5: [1:t1] [2:t3]          S5 is leader

(c) S5 crashes. S1 restarts, is elected leader of term 4 (votes from S1, S2, S3).
    S1 replicates its entry at index 2 (term 2) to S3.

S1: [1:t1] [2:t2]          S1 is leader
S2: [1:t1] [2:t2]
S3: [1:t1] [2:t2]          ← replicated from S1
S4: [1:t1]
S5: [1:t1] [2:t3]          (crashed)

    Now entry [2:t2] is on S1, S2, S3 — a majority!
    Can S1 commit it?

(d) DANGER: If S1 commits [2:t2] and then crashes...
    S5 restarts. S5 could be elected leader of term 5 (votes from S3, S4, S5
    — S5's log [1:t1, 2:t3] has a higher last term than S3's [1:t1, 2:t2]).
    S5 would overwrite the committed entry with [2:t3]. SAFETY VIOLATION!

(e) THE FIX: S1 does NOT commit [2:t2] directly.
    Instead, S1 appends a new entry [3:t4] from its own term.
    S1 replicates [3:t4] to a majority.
    When [3:t4] is committed, [2:t2] is also committed (it precedes [3:t4]).
    Now the log looks like:

S1: [1:t1] [2:t2] [3:t4]   S1 is leader
S2: [1:t1] [2:t2] [3:t4]
S3: [1:t1] [2:t2] [3:t4]   ← majority has [3:t4]
S4: [1:t1]
S5: [1:t1] [2:t3]

    Now S5 CANNOT be elected: its log (last term 3) is less up-to-date
    than S1/S2/S3's logs (last term 4). S5 can't get a majority of votes.
```

This is the subtlest part of Raft and the source of many implementation bugs. The rule is simple:

```
A leader commits entry E at index i if and only if:
1. E.term == currentTerm (the entry is from the leader's own term)
2. E is stored on a majority of servers
```

Entries from previous terms are never committed directly. They are committed implicitly when a later entry from the current term is committed.

---

## The Complete Raft Algorithm: Pseudocode

### State

```
# Persistent state (on all servers, saved to disk before responding to RPCs)
currentTerm    = 0          # Latest term this server has seen
votedFor       = null       # CandidateId that received vote in current term
log[]          = []         # Log entries; each has {command, term, index}

# Volatile state (on all servers)
commitIndex    = 0          # Highest log entry known to be committed
lastApplied    = 0          # Highest log entry applied to state machine

# Volatile state (on leaders, reinitialized after election)
nextIndex[]    = {}         # For each server: index of next log entry to send
matchIndex[]   = {}         # For each server: highest log entry known to be replicated
```

### RequestVote Handler

```python
def handle_request_vote(args):
    # 1. Reply false if term < currentTerm
    if args.term < currentTerm:
        return RequestVoteReply(term=currentTerm, voteGranted=False)

    # Step down if term > currentTerm
    if args.term > currentTerm:
        currentTerm = args.term
        votedFor = null
        state = FOLLOWER

    # 2. If votedFor is null or candidateId, and candidate's log
    #    is at least as up-to-date as ours, grant vote
    if (votedFor is null or votedFor == args.candidateId):
        my_last_term = log[-1].term if log else 0
        my_last_index = len(log)

        candidate_up_to_date = (
            args.lastLogTerm > my_last_term or
            (args.lastLogTerm == my_last_term and
             args.lastLogIndex >= my_last_index)
        )

        if candidate_up_to_date:
            votedFor = args.candidateId
            persist(currentTerm, votedFor)  # MUST persist before responding
            reset_election_timer()
            return RequestVoteReply(term=currentTerm, voteGranted=True)

    return RequestVoteReply(term=currentTerm, voteGranted=False)
```

### AppendEntries Handler

```python
def handle_append_entries(args):
    # 1. Reply false if term < currentTerm
    if args.term < currentTerm:
        return AppendEntriesReply(term=currentTerm, success=False)

    # Recognize the leader's authority
    if args.term > currentTerm:
        currentTerm = args.term
        votedFor = null
    state = FOLLOWER
    reset_election_timer()

    # 2. Reply false if log doesn't contain an entry at prevLogIndex
    #    whose term matches prevLogTerm
    if args.prevLogIndex > 0:
        if args.prevLogIndex > len(log):
            return AppendEntriesReply(term=currentTerm, success=False)
        if log[args.prevLogIndex - 1].term != args.prevLogTerm:
            # Delete this entry and all that follow it
            log = log[:args.prevLogIndex - 1]
            persist(log)
            return AppendEntriesReply(term=currentTerm, success=False)

    # 3. Append any new entries not already in the log
    for i, entry in enumerate(args.entries):
        log_index = args.prevLogIndex + i + 1
        if log_index <= len(log):
            if log[log_index - 1].term != entry.term:
                # Conflict: delete existing entry and all after it
                log = log[:log_index - 1]
                log.append(entry)
            # else: already have this entry, skip
        else:
            log.append(entry)

    persist(currentTerm, votedFor, log)

    # 4. If leaderCommit > commitIndex, update commitIndex
    if args.leaderCommit > commitIndex:
        commitIndex = min(args.leaderCommit, len(log))

    # Apply newly committed entries
    while lastApplied < commitIndex:
        lastApplied += 1
        apply_to_state_machine(log[lastApplied - 1].command)

    return AppendEntriesReply(term=currentTerm, success=True)
```

### Leader's Replication Loop

```python
def leader_replicate():
    while state == LEADER:
        for server in other_servers:
            if len(log) >= nextIndex[server]:
                prev_index = nextIndex[server] - 1
                prev_term = log[prev_index - 1].term if prev_index > 0 else 0
                entries = log[nextIndex[server] - 1:]

                reply = send_append_entries(server, AppendEntriesArgs(
                    term=currentTerm,
                    leaderId=self_id,
                    prevLogIndex=prev_index,
                    prevLogTerm=prev_term,
                    entries=entries,
                    leaderCommit=commitIndex
                ))

                if reply.term > currentTerm:
                    currentTerm = reply.term
                    state = FOLLOWER
                    return

                if reply.success:
                    nextIndex[server] = prev_index + len(entries) + 1
                    matchIndex[server] = nextIndex[server] - 1
                else:
                    nextIndex[server] = max(1, nextIndex[server] - 1)
            else:
                # Send heartbeat (empty AppendEntries)
                send_heartbeat(server)

        # Update commitIndex
        update_commit_index()

        sleep(heartbeat_interval)

def update_commit_index():
    for n in range(len(log), commitIndex, -1):
        if log[n - 1].term == currentTerm:  # Only commit current-term entries!
            replicated_count = 1  # Count self
            for server in other_servers:
                if matchIndex[server] >= n:
                    replicated_count += 1
            if replicated_count > len(all_servers) // 2:
                commitIndex = n
                break
```

### Candidate Election

```python
def start_election():
    currentTerm += 1
    votedFor = self_id
    state = CANDIDATE
    persist(currentTerm, votedFor)

    votes_received = 1  # Vote for self
    my_last_index = len(log)
    my_last_term = log[-1].term if log else 0

    for server in other_servers:
        reply = send_request_vote(server, RequestVoteArgs(
            term=currentTerm,
            candidateId=self_id,
            lastLogIndex=my_last_index,
            lastLogTerm=my_last_term
        ))

        if reply.term > currentTerm:
            currentTerm = reply.term
            state = FOLLOWER
            persist(currentTerm, votedFor=null)
            return

        if reply.voteGranted:
            votes_received += 1

        if votes_received > len(all_servers) // 2:
            state = LEADER
            # Initialize nextIndex and matchIndex
            for s in other_servers:
                nextIndex[s] = len(log) + 1
                matchIndex[s] = 0
            # Send initial empty AppendEntries (heartbeat) to all
            send_heartbeats()
            return

    # If election didn't succeed, wait for timeout and try again
    # (randomized timeout prevents infinite loops)
```

---

## Cluster Membership Changes

One of Raft's practical contributions is a safe mechanism for changing the cluster membership (adding or removing servers) without downtime.

### The Problem with Naive Reconfiguration

Suppose you have a 3-server cluster {A, B, C} and want to add servers D and E. If you simply tell all servers "the cluster is now {A, B, C, D, E}," different servers will learn the new configuration at different times.

```
Time ────────────────────────────────────────▶

Server A learns new config:  |──────────▶ majority = 3 of 5
Server B learns new config:  |──────────────▶ majority = 3 of 5
Server C still on old config:|──── majority = 2 of 3
Server D learns new config:  |────▶ majority = 3 of 5
Server E learns new config:  |──────▶ majority = 3 of 5

Danger window: C thinks majority = 2 of 3.
C and one other old-config server could elect a leader.
Simultaneously, 3 new-config servers could elect ANOTHER leader.
TWO LEADERS in the same term!
```

### Joint Consensus

Raft solves this with a two-phase approach called **joint consensus**:

**Phase 1**: The leader creates a special configuration entry C_old,new that requires a majority of **both** the old configuration AND the new configuration to commit.

```
C_old,new requires:
  Majority of {A, B, C} = 2 of 3       AND
  Majority of {A, B, C, D, E} = 3 of 5
```

**Phase 2**: Once C_old,new is committed, the leader creates a C_new entry that requires only the new configuration's majority.

```
Transition:
  C_old → C_old,new → C_new

During C_old,new:
  - Leader must get agreement from majorities of BOTH old and new configs
  - No single-config majority can make decisions alone
  - Safe overlap guaranteed

After C_new committed:
  - Old configuration servers not in C_new can be shut down
  - Cluster operates normally with new membership
```

### Single-Server Changes (Simpler Alternative)

In practice, many Raft implementations use a simpler approach: change the cluster by one server at a time. Adding or removing a single server is safe because the old and new majorities always overlap:

```
Old cluster: {A, B, C}          Majority: 2 of 3
New cluster: {A, B, C, D}      Majority: 3 of 4

Any majority of the old (2 of 3) and any majority of the new (3 of 4)
share at least one server. Safe!

But:
Old cluster: {A, B, C}          Majority: 2 of 3
New cluster: {A, B, C, D, E}   Majority: 3 of 5

A majority of old = {A, B}. A majority of new = {C, D, E}.
NO OVERLAP. Unsafe!
```

So single-server changes are safe; multi-server changes must use joint consensus or be decomposed into a sequence of single-server changes.

---

## Log Compaction (Snapshotting)

Over time, the log grows without bound. Raft uses **snapshotting** to compact it:

```
Before compaction:
Log: [1:t1] [2:t1] [3:t2] [4:t2] [5:t3] [6:t3] [7:t3] [8:t4]
                                     ▲
                              lastApplied = 5

After compaction:
Snapshot: {state machine state as of index 5, last included term = t3}
Log: [6:t3] [7:t3] [8:t4]

The snapshot replaces log entries 1-5.
```

Each server independently decides when to snapshot (typically when the log exceeds a size threshold).

### InstallSnapshot RPC

When a leader needs to send entries to a follower that is so far behind that those entries have already been compacted:

```
Leader's state:
  Snapshot up to index 100
  Log starts at index 101

Follower's nextIndex: 50 (follower is very far behind)

Leader can't send entries 50-100 — they're in the snapshot.
Leader sends InstallSnapshot RPC with the full snapshot.
Follower replaces its log and state machine with the snapshot.
```

```
InstallSnapshot Arguments:
  term:               leader's current term
  leaderId:           for follower to redirect clients
  lastIncludedIndex:  snapshot replaces all entries up through this index
  lastIncludedTerm:   term of lastIncludedIndex entry
  offset:             byte offset for chunked transfer
  data[]:             raw bytes of snapshot chunk
  done:               true if this is the last chunk
```

---

## Edge Cases and Common Implementation Bugs

### 1. Stale Leader Processing Reads

A leader that has been partitioned from the cluster doesn't know it's been deposed. If it serves a read from its local state machine, it might return stale data.

```
Partition:

  [S1(old leader)] | [S2, S3, S4, S5]
                   |
  S1 thinks it's   | S3 becomes new leader
  still leader     | New writes go to S3
  Serves stale     |
  reads!           |
```

**Solutions**:
- **Read from leader only after confirming leadership**: Send a heartbeat to a majority before serving a read. (Raft default.)
- **Lease-based reads**: Leader holds a lease for a bounded period. Reads are safe during the lease. Requires bounded clock skew.
- **Linearizable reads via the log**: Append a no-op entry and wait for it to commit. The commit proves the leader is still current.

### 2. Pre-Vote Extension

A server partitioned from the cluster will repeatedly time out and increment its term. When it rejoins, its artificially high term disrupts the cluster:

```
S5 partitioned:
  term 4 → timeout → term 5 → timeout → term 6 → ... → term 100

S5 rejoins. Sends RequestVote with term 100.
All other servers (term 4) see term 100 > their term.
They step down, disrupting the current leader.
```

**Solution: Pre-Vote**. Before starting an election, a candidate sends a "pre-vote" to check if it could win, without incrementing its term. The pre-vote succeeds only if the candidate's log is up-to-date and the voter hasn't heard from a leader recently. This prevents partitioned servers from disrupting the cluster.

### 3. Leader Steps Down Without Client Notification

If the leader steps down (discovers a higher term) while processing a client request, the client may not receive a response. The client must retry, and idempotency at the state machine level prevents duplicate application.

### 4. Exactly-Once Client Semantics

Raft by itself provides at-least-once semantics. For exactly-once:
- Clients include a unique request ID with each command.
- The state machine tracks the latest response for each client.
- If a command with a duplicate request ID arrives, the cached response is returned without re-executing.

```python
class StateMachine:
    def __init__(self):
        self.data = {}
        self.client_responses = {}  # clientId -> (requestId, response)

    def apply(self, command):
        if (command.clientId in self.client_responses and
            self.client_responses[command.clientId][0] == command.requestId):
            return self.client_responses[command.clientId][1]

        result = self._execute(command)
        self.client_responses[command.clientId] = (command.requestId, result)
        return result
```

---

## Raft vs Paxos

| Aspect | Raft | Multi-Paxos |
|---|---|---|
| **Understandability** | Designed for clarity; decomposed into subproblems | Notoriously difficult; "Part-Time Parliament" metaphor confuses |
| **Leader** | Strong leader required; all writes go through leader | Leader optional; any proposer can propose |
| **Log** | No gaps; entries are consecutive | Gaps allowed; entries can be committed out of order |
| **Membership changes** | Joint consensus or single-server changes | Less standardized; many ad-hoc approaches |
| **Implementations** | etcd, CockroachDB, TiKV, Consul | Chubby (Google), Spanner (internally), ZooKeeper (ZAB variant) |
| **Performance** | Slightly less flexible | Can be slightly faster (out-of-order commits) |
| **Safety proof** | Clear and complete in the original paper | Distributed across multiple Lamport papers |

In practice, most new systems choose Raft. The performance difference is negligible for most workloads, and the clarity advantage makes Raft significantly easier to implement correctly and debug in production.

---

## Performance Considerations

### Latency

A Raft write requires:
1. Client → Leader (1 network hop)
2. Leader → Followers (1 network hop, parallel to all)
3. Majority of followers → Leader (1 network hop, wait for fastest majority)
4. Leader → Client (1 network hop)

**Minimum latency**: 2 round-trip times (client↔leader + leader↔follower). In practice, ~2-5ms in a single datacenter.

### Throughput

Raft's throughput is limited by the leader's ability to process and replicate entries. Key optimizations:

- **Batching**: Group multiple client requests into a single AppendEntries RPC.
- **Pipelining**: Send the next AppendEntries before receiving the response to the previous one.
- **Parallel replication**: Send AppendEntries to all followers in parallel, not sequentially.
- **Asynchronous apply**: Apply committed entries to the state machine asynchronously.

### Leader Bottleneck

All writes go through the leader, making it a potential bottleneck. This is a fundamental trade-off: strong consistency requires coordination, and Raft centralizes coordination in the leader.

For read-heavy workloads, **follower reads** can help: followers serve reads that don't require linearizability (e.g., reads that tolerate slightly stale data). For linearizable reads from followers, the follower must check with the leader first.

---

## Raft in Production: Real-World Deployments

### etcd (Kubernetes)

Every Kubernetes cluster runs etcd as its source of truth. etcd uses Raft to replicate its key-value store across typically 3 or 5 servers. Kubernetes' control plane depends entirely on etcd's Raft implementation for consistency.

- Typical configuration: 3 or 5 etcd nodes
- Election timeout: 1000ms default
- Heartbeat interval: 100ms default
- Snapshot threshold: 10,000 entries

### CockroachDB

CockroachDB uses Raft to replicate each range (a contiguous slice of the key space) across typically 3 replicas. A single CockroachDB cluster may run thousands of Raft groups simultaneously (Multi-Raft).

### TiKV / TiDB

TiKV, the storage layer of TiDB, uses Raft for replication. TiKV was one of the first production systems to implement Raft's joint consensus for membership changes.

### Consul (HashiCorp)

Consul uses Raft for its service catalog and key-value store. Consul's documentation provides one of the best practical guides to operating a Raft cluster in production.

---

## Key Takeaways

1. **Raft decomposes consensus into three manageable subproblems**: leader election, log replication, and safety. Each can be understood and verified independently.

2. **Terms are logical clocks.** They order elections and prevent stale leaders from corrupting the log. Every RPC includes a term number, and a server always defers to a higher term.

3. **At most one leader per term.** This follows from the majority vote requirement and the one-vote-per-term rule. It is the foundation of Raft's safety.

4. **The log matching property** ensures that if two servers agree on one entry, they agree on the entire prefix. This makes log reconciliation simple and correct.

5. **Leader completeness** ensures that committed entries survive leader changes. It follows from the voting restriction (candidates must have an up-to-date log) and the majority overlap argument.

6. **Only commit current-term entries** directly. This subtle rule prevents a scenario where a committed entry could be overwritten by a future leader. It is the most common source of implementation bugs.

7. **Safety never depends on timing.** Raft's safety proofs make no timing assumptions. Liveness requires partial synchrony (reasonable timeouts), which is FLP's escape hatch.

8. **Persist before responding.** `currentTerm`, `votedFor`, and `log[]` must be written to stable storage before responding to any RPC. Failure to do this is the most common Raft implementation bug.

9. **Raft is not just an algorithm — it is a complete system.** The paper covers log compaction, cluster membership changes, and client interaction. This completeness is what makes Raft practical.

---

## Further Reading

- Ongaro, Ousterhout. "In Search of an Understandable Consensus Algorithm." *USENIX ATC*, 2014. — The Raft paper. Clear, complete, and includes a TLA+ specification.
- Ongaro. "Consensus: Bridging Theory and Practice." PhD dissertation, Stanford, 2014. — The extended Raft dissertation covering all edge cases.
- Lamport. "The Part-Time Parliament." *ACM TOCS*, 1998. — The Paxos paper, for comparison.
- Lamport. "Paxos Made Simple." 2001. — A clearer Paxos explanation, still harder than Raft.
- Howard et al. "Raft Refloated: Do We Have Consensus?" *ACM SIGOPS*, 2015. — Practical evaluation of Raft with failure injection.
- The Raft visualization: raft.github.io — An interactive visualization of the algorithm.

---

**Next**: [Chapter 23 — Testing Distributed Systems: Jepsen and Chaos Engineering →](ch23-testing-distributed-systems.md)
