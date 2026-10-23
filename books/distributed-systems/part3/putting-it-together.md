# Putting It Together: Raft Leader Election from Scratch

> **Exercise**: Walk through a complete Raft leader election, trace every message when a leader crashes mid-replication, follow the new leader's log reconciliation, and then simulate a network partition healing with diverged log entries.

This exercise ties together replication mechanics (Ch 17), quorum concepts (Ch 18), the CAP trade-off (Ch 20), FLP impossibility and its practical workarounds (Ch 21), and the full Raft algorithm (Ch 22).

---

## The Setup

A five-node Raft cluster: S1, S2, S3, S4, S5. A majority quorum requires 3 nodes.

Initial state — S1 is the leader in **term 2**, and the cluster has committed entries through index 4:

```
           S1 (Leader, term=2)
          ╱  |  ╲
        S2   S3   S4   S5
     (Follower) (Follower) (Follower) (Follower)

All nodes' logs (committed through index 4):
┌───────┬───────┬───────┬───────┐
│ idx 1 │ idx 2 │ idx 3 │ idx 4 │
│ t=1   │ t=1   │ t=2   │ t=2   │
│ x←1   │ y←2   │ x←5   │ z←3   │
└───────┴───────┴───────┴───────┘
commitIndex = 4 on all nodes
```

---

## Phase 1: Leader Crashes Mid-Replication

S1 receives two new client requests: `w←7` (index 5) and `v←9` (index 6). It begins replicating them via `AppendEntries` RPCs.

### Step 1: S1 appends locally and sends AppendEntries

```
S1 log: [1:x←1, 2:y←2, 3:x←5, 4:z←3, 5:w←7, 6:v←9]  (5,6 uncommitted)

S1 ──AppendEntries(term=2, prevLogIndex=4, prevLogTerm=2, entries=[5:w←7, 6:v←9])──▶ S2
S1 ──AppendEntries(term=2, prevLogIndex=4, prevLogTerm=2, entries=[5:w←7, 6:v←9])──▶ S3
S1 ──AppendEntries(term=2, prevLogIndex=4, prevLogTerm=2, entries=[5:w←7, 6:v←9])──▶ S4
S1 ──AppendEntries(term=2, prevLogIndex=4, prevLogTerm=2, entries=[5:w←7, 6:v←9])──▶ S5
```

### Step 2: Partial delivery — then S1 crashes

The network delivers the messages to S2 and S3 before S1 crashes. S4 and S5 never receive them.

```
S2 receives entries, appends to log, replies success
S3 receives entries, appends to log, replies success
S4 ✗ message lost (S1 crashed before delivery)
S5 ✗ message lost (S1 crashed before delivery)

              ╳ S1 CRASHES ╳

Node states after crash:
┌──────┬─────────────────────────────────┬────────┬────────────┐
│ Node │ Log                             │ Term   │ commitIdx  │
├──────┼─────────────────────────────────┼────────┼────────────┤
│ S1   │ [1,2,3,4,5,6] (5,6 uncommitted)│ 2      │ 4 (dead)   │
│ S2   │ [1,2,3,4,5,6] (5,6 uncommitted)│ 2      │ 4          │
│ S3   │ [1,2,3,4,5,6] (5,6 uncommitted)│ 2      │ 4          │
│ S4   │ [1,2,3,4]                       │ 2      │ 4          │
│ S5   │ [1,2,3,4]                       │ 2      │ 4          │
└──────┴─────────────────────────────────┴────────┴────────────┘
```

**Critical observation**: S1 never received enough acks to advance `commitIndex` to 5 or 6. Even though S2 and S3 have the entries, they are **not committed**. But are they safe? We'll trace through the election to find out.

---

## Phase 2: Election Timeout and Vote Campaign

### Step 3: S4's election timer fires first

Each follower has a randomized election timeout (e.g., 150–300ms). Suppose S4's timeout fires first at T+200ms.

```
S4: No heartbeat from S1 for 200ms. Convert to candidate.
    currentTerm: 2 → 3
    votedFor: S4 (votes for self)
    votes received: {S4}
```

### Step 4: S4 sends RequestVote RPCs

```
S4 ──RequestVote(term=3, candidateId=S4, lastLogIndex=4, lastLogTerm=2)──▶ S2
S4 ──RequestVote(term=3, candidateId=S4, lastLogIndex=4, lastLogTerm=2)──▶ S3
S4 ──RequestVote(term=3, candidateId=S4, lastLogIndex=4, lastLogTerm=2)──▶ S5
(S1 is dead, not contacted or unreachable)
```

### Step 5: Followers evaluate the vote

The **Election Restriction** (Raft §5.4.1): a voter grants its vote only if the candidate's log is **at least as up-to-date** as the voter's own log. "Up-to-date" means:
1. The candidate's last log entry has a higher term, OR
2. Same last term but equal or higher index.

Let's evaluate each voter:

**S2** (log ends at index 6, term 2):
```
S4's last: index=4, term=2
S2's last: index=6, term=2
Same last term (2), but S4's index (4) < S2's index (6).
S4's log is LESS up-to-date.
→ S2 REJECTS the vote.
```

**S3** (log ends at index 6, term 2):
```
Same reasoning as S2.
→ S3 REJECTS the vote.
```

**S5** (log ends at index 4, term 2):
```
S4's last: index=4, term=2
S5's last: index=4, term=2
Same last term, same index. S4's log is equally up-to-date.
→ S5 GRANTS the vote.
```

### Step 6: S4 tallies votes

```
S4 votes: {S4, S5} = 2 out of 5. Not a majority.
S4 cannot become leader.
```

**This is Raft's safety mechanism at work.** S4 cannot win because S2 and S3 have longer logs. Any node elected leader in term 3 **must** have entries 5 and 6, because a majority (S2, S3 plus at least one more) has those entries and won't vote for a candidate without them.

### Step 7: S3's election timer fires

After S4's failed attempt, suppose S3's timer fires and it starts a new election in term 3 (or term 4 if S4's RequestVote bumped everyone to term 3 — let's trace it carefully).

When S2 and S3 received S4's RequestVote with term=3, they updated their `currentTerm` to 3 (Raft rule: if you see a higher term, update), but rejected the vote. Now S3 starts its own campaign:

```
S3: Convert to candidate.
    currentTerm: 3 → 4
    votedFor: S3
    votes: {S3}
```

```
S3 ──RequestVote(term=4, candidateId=S3, lastLogIndex=6, lastLogTerm=2)──▶ S2
S3 ──RequestVote(term=4, candidateId=S3, lastLogIndex=6, lastLogTerm=2)──▶ S4
S3 ──RequestVote(term=4, candidateId=S3, lastLogIndex=6, lastLogTerm=2)──▶ S5
```

**S2** (log ends at index 6, term 2):
```
S3's last: index=6, term=2. S2's last: index=6, term=2. Equal.
S2 has not voted in term 4 yet.
→ S2 GRANTS the vote.
```

**S4** (log ends at index 4, term 2):
```
S3's last: index=6, term=2 ≥ S4's last: index=4, term=2. More up-to-date.
→ S4 GRANTS the vote.
```

**S5**: Same reasoning as S4 → **GRANTS**.

```
S3 votes: {S3, S2, S4, S5} = 4. Majority achieved!
S3 becomes leader of term 4.
```

---

## Phase 3: New Leader's Log Reconciliation

### Step 8: S3 sends initial heartbeats

As the new leader, S3 immediately sends empty `AppendEntries` (heartbeats) to establish authority. It also begins reconciling logs.

S3's log: `[1:t1, 2:t1, 3:t2, 4:t2, 5:t2, 6:t2]`

S3 initializes `nextIndex` for each follower to its own log length + 1 = 7:

```
nextIndex = {S2: 7, S4: 7, S5: 7}
```

### Step 9: AppendEntries to S4 and S5

```
S3 ──AppendEntries(term=4, prevLogIndex=6, prevLogTerm=2, entries=[], leaderCommit=4)──▶ S4
```

S4's log only goes to index 4. It doesn't have an entry at index 6, so the `prevLogIndex` consistency check fails:

```
S4: I don't have index 6. → Reply: success=false
```

S3 decrements `nextIndex[S4]` to 6 and retries:

```
S3 ──AppendEntries(term=4, prevLogIndex=5, prevLogTerm=2, entries=[6:v←9], leaderCommit=4)──▶ S4
S4: I don't have index 5 either. → Reply: success=false
```

S3 decrements to 5:

```
S3 ──AppendEntries(term=4, prevLogIndex=4, prevLogTerm=2, entries=[5:w←7, 6:v←9], leaderCommit=4)──▶ S4
S4: I have index 4 with term 2. Match! Append entries 5 and 6. → Reply: success=true
```

Now S4 and S5 have the full log. S2 already matched at index 6.

### Step 10: Committing entries 5 and 6

Now S3 has replicated entries 5 and 6 to S2, S4, and S5 (plus itself). That's 4 out of 5.

**But wait** — can S3 commit entries 5 and 6? They were written in term 2, not term 4. Raft's **commitment rule** (§5.4.2) says: a leader only commits entries from *previous* terms indirectly, by committing a new entry from its *current* term, which implicitly commits everything before it.

So S3 appends a **no-op** entry at index 7 with term 4:

```
S3 appends: index 7, term 4, no-op
S3 ──AppendEntries(..., entries=[7:noop_t4], leaderCommit=4)──▶ S2, S4, S5
```

Once a majority acknowledges index 7:

```
S3 advances commitIndex: 4 → 7
  (This commits entries 5, 6, and 7 together)
S3 ──AppendEntries(..., leaderCommit=7)──▶ all followers
```

Entries `w←7` and `v←9` are now **committed and safe**. They will never be lost or overwritten.

---

## Phase 4: Network Partition with Diverged Logs

Now consider a more complex scenario. Starting from the original state (S1 as leader, term 2, all logs at index 4), a **network partition** occurs:

```
┌─────────────────────┐     ╳ PARTITION ╳     ┌──────────────────────┐
│  Partition Left      │                       │  Partition Right     │
│  S1 (leader term=2) │                       │  S4                  │
│  S2                  │                       │  S5                  │
│  S3                  │                       │                      │
└─────────────────────┘                       └──────────────────────┘
```

### Divergence begins

**Left partition (S1, S2, S3)**: S1 can still reach a majority (3/5). It continues accepting writes:

```
S1 appends and commits (with S2, S3 acking):
  index 5: term=2, a←10
  index 6: term=2, b←20
  commitIndex advances to 6.
```

**Right partition (S4, S5)**: They stop receiving heartbeats. S4's election timer fires:

```
S4: Convert to candidate, term=3
S4 ──RequestVote(term=3, lastLogIndex=4, lastLogTerm=2)──▶ S5
S5: Grants vote.
S4 has 2 votes out of 5. NOT a majority. Election fails.
```

S4 and S5 keep timing out and incrementing terms, but they can never form a majority. They cycle through terms 3, 4, 5, 6... without ever electing a leader. **This is correct behavior** — the minority partition is unavailable (the "A" sacrifice in CAP during "P").

### Partition heals

The network heals. Now S4 and S5 rejoin. Suppose by now they've reached term 8 from repeated failed elections.

```
S4 (candidate, term=8) sends RequestVote to everyone.
```

**What happens?**

S1, S2, S3 see term 8 > their term 2. They update their `currentTerm` to 8. S1 **steps down** from leader (a leader seeing a higher term must revert to follower).

But does S4 win?

```
S4's last log: index=4, term=2
S1's last log: index=6, term=2

S1, S2, S3 all have index 6 > S4's index 4.
→ S1, S2, S3 all REJECT S4's vote.
S4 gets only {S4, S5} = 2 votes. Fails.
```

Now S1 (or S2 or S3) starts a new election in term 9. Say S1:

```
S1 ──RequestVote(term=9, lastLogIndex=6, lastLogTerm=2)──▶ everyone
Everyone grants (S1's log is at least as up-to-date as all others).
S1 becomes leader of term 9.
```

S1 sends AppendEntries to S4 and S5. Through the backtracking mechanism (Step 9 above), S4 and S5 receive entries 5 and 6. Their logs converge to match the leader's.

### Final state

```
All nodes:
┌───────┬───────┬───────┬───────┬───────┬───────┐
│ idx 1 │ idx 2 │ idx 3 │ idx 4 │ idx 5 │ idx 6 │
│ t=1   │ t=1   │ t=2   │ t=2   │ t=2   │ t=2   │
│ x←1   │ y←2   │ x←5   │ z←3   │ a←10  │ b←20  │
└───────┴───────┴───────┴───────┴───────┴───────┘
Leader: S1, term=9, commitIndex=6
```

The committed entries (5, 6) from the majority partition survived. The minority partition's term inflation was harmless — high term numbers don't confer any data advantage, only the log contents matter for election eligibility.

---

## Key Takeaways

1. **The Election Restriction prevents data loss.** A candidate with a shorter (less up-to-date) log cannot win an election if any majority of voters has a longer log. Since committed entries exist on a majority, they are always preserved.

2. **The commitment rule prevents the "Figure 8" problem.** A new leader cannot directly commit entries from a previous term. It must first commit an entry from its own term, which indirectly commits all prior entries. This prevents a subtle scenario where a committed entry could be overwritten (see Raft paper §5.4.2, Figure 8).

3. **Minority partitions are safe but unavailable.** Nodes in a minority partition increment terms but can never elect a leader, accept writes, or commit entries. When the partition heals, their high term numbers cause the existing leader to step down, but a node with the most up-to-date log quickly wins a new election.

4. **Log reconciliation is mechanical.** The leader's backtracking via `nextIndex` decrement finds the longest common prefix, then overwrites divergent follower entries. No negotiation, no merge — the leader's log is authoritative.

---

## Exercises

1. **The Figure 8 scenario**: Draw the exact sequence where, without the commitment rule, a leader could commit an entry from a previous term that later gets overwritten. (Hint: refer to Raft paper Figure 8 and trace each step.)

2. **Simultaneous candidates**: S2 and S3 both time out at the same instant and start elections in the same term. Trace the vote-splitting scenario and show how randomized timeouts resolve it.

3. **Pre-vote extension**: In the partition scenario, S4 and S5 kept incrementing terms. The "Pre-Vote" extension (Raft §9.6) prevents this. Describe how Pre-Vote works and trace through the same scenario with it enabled.

4. **Log compaction**: After the partition heals, S1 has already taken a snapshot at index 5 and discarded log entries 1–5. How does S1 bring S4 up to date if it can't send those entries? (Hint: `InstallSnapshot` RPC.)

5. **Exactly one leader per term**: Prove that two nodes cannot both become leader in the same term. (Hint: each node votes at most once per term, and a leader needs a majority.)

---

**Next**: [Part 4 — Transactions, Data Processing, and Production →](../part4/ch25-serializability-vs-linearizability.md)
