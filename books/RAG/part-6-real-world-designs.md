# Part 6: Real-World Designs — "Putting It All Together"

> **What this part covers**: Five complete system designs that apply every concept from Parts 1–5 to real domains: enterprise knowledge bases, customer support bots, legal research, code search, and e-commerce product search. Each design makes specific choices about chunking, retrieval, reranking, guardrails, and evaluation — and explains *why*.
>
> **Prerequisites**: [Part 5: Advanced Patterns](part-5-advanced-patterns.md) — you should understand agentic RAG, graph RAG, multimodal RAG, and the long-context trade-offs.
>
> **After this part, you'll be able to**: Design a RAG system for any domain by recognizing which patterns from this book to combine, which trade-offs to make, and which pitfalls are specific to that domain.

---

## Chapter 26: Design — Enterprise Knowledge Base

**One-liner**: An enterprise knowledge base uses RAG to unify search across Confluence, Slack, Google Docs, Jira, and dozens more internal tools — giving every employee a single place to ask "How do we do X?"

**Why you should care**: A new engineer joins your 5,000-person company. They need to find the on-call rotation policy. It might be in Confluence (3 versions, all slightly different), a Slack thread from last month, a Google Doc shared in a channel they're not in, or a Jira ticket with the latest update. They spend 45 minutes searching before pinging someone who's busy. Multiply that by every question every employee asks. McKinsey estimates knowledge workers spend 19% of their time searching for information. For a 5,000-person company averaging $100K salary, that's $95 million/year lost to searching.

**Prerequisites**: [Chapter 5: Chunking Strategies](part-2-retrieval-stack.md#chapter-5-chunking-strategies), [Chapter 9: Hybrid Search](part-2-retrieval-stack.md#chapter-9-hybrid-search--best-of-both-worlds), [Chapter 19: Security & Access Control](part-4-evaluation-production.md#chapter-19-security--access-control), [Chapter 20: Keeping Data Fresh](part-4-evaluation-production.md#chapter-20-keeping-data-fresh)

### The Simple Version

Imagine your company's knowledge is scattered across 15 different filing cabinets in 15 different offices, each organized differently. Some are alphabetical, some by date, some by team. An enterprise knowledge base RAG is like hiring a librarian who has a key to every cabinet, reads everything nightly, makes a unified index card catalog, and sits at the front desk to answer any employee's question — checking their badge first to make sure they're allowed to see the answer.

### How It Actually Works

```
                    ┌─────────────────────────────────────────┐
                    │           Data Source Connectors          │
                    │                                           │
                    │  Confluence  Slack  Google   Jira  Notion │
                    │      │        │     Docs      │      │   │
                    └──────┼────────┼──────┼────────┼──────┼───┘
                           └────────┴──────┴────────┴──────┘
                                        │
                                        ↓
                    ┌──────────────────────────────────────────┐
                    │       Ingestion Pipeline                  │
                    │                                           │
                    │  1. Crawl/webhook (incremental)           │
                    │  2. Extract text + metadata               │
                    │  3. Resolve permissions (who can see?)    │
                    │  4. Chunk (per-source strategy)           │
                    │  5. Embed + store                         │
                    └──────────────────┬───────────────────────┘
                                       ↓
                    ┌──────────────────────────────────────────┐
                    │        Vector DB + Metadata Store         │
                    │                                           │
                    │  Chunks + embeddings + ACLs per chunk     │
                    └──────────────────┬───────────────────────┘
                                       ↓
          User: "What's our PTO policy?"  →  Query Pipeline
                                       │
                    ┌──────────────────────────────────────────┐
                    │  1. Rewrite query (expand acronyms)       │
                    │  2. Hybrid search (vector + keyword)      │
                    │  3. Filter by user's permissions          │
                    │  4. Rerank top-k                          │
                    │  5. Generate answer with citations        │
                    └──────────────────────────────────────────┘
```

*What question does this diagram answer? "What are the major components of an enterprise knowledge base RAG system, from data ingestion to answer generation?"*

**The 4 hard problems (and how to solve them):**

**1. Connector Hell — Every Source Is Different**

Confluence stores pages in a tree with rich HTML. Slack has threads, reactions, and ephemeral messages. Google Docs use a proprietary format. Jira has structured fields plus free-text descriptions.

| Source | Chunking Strategy | Special Handling |
|---|---|---|
| Confluence | Structural — split by heading hierarchy | Preserve page tree context ("This is under Engineering > On-Call") |
| Slack | Thread-based — each thread is one chunk | Filter out noise (reactions, "thanks!", one-word replies). Keep only threads with >3 replies or from designated answer channels |
| Google Docs | Recursive — paragraph-aware splits | Handle comments, suggestion mode, version history (index latest only) |
| Jira | Structured — title + description + comments separately | Preserve fields as metadata (status, assignee, sprint) for filtering |
| Notion | Structural — block-level hierarchy | Handle databases (tables) as structured data, pages as text |

**2. Permission Synchronization — The Silent Killer**

Remember [Chapter 19: Security & Access Control](part-4-evaluation-production.md#chapter-19-security--access-control)? This is where it gets real. An intern asks about Q4 strategy and gets board meeting notes because someone didn't sync permissions.

The solution: **pre-filter with permission syncing**. Every chunk carries an ACL (access control list) synced from the source system. At query time, filter chunks to only those the user can access *before* retrieval.

```
  User (Engineering, Level 3) asks question
            │
            ↓
  Permission filter: only return chunks where
  ACL includes "Engineering" OR "All-Company"
  AND classification ≤ "Internal"
            │
            ↓
  Vector search (on filtered subset)
```

*What question does this diagram answer? "How do permissions filter chunks before the search even runs?"*

**The gotcha**: Permission syncing must be near-real-time. If someone removes a user from a Confluence space, the RAG system must reflect that within minutes, not days. Glean solves this by maintaining a permission graph that updates via webhooks from each source system, with a full reconciliation crawl every 6 hours.

**3. Freshness — Knowledge Goes Stale Fast**

Remember [Chapter 20: Keeping Data Fresh](part-4-evaluation-production.md#chapter-20-keeping-data-fresh)? Enterprise data changes constantly. The PTO policy was updated yesterday. Slack threads from this morning have the latest incident details.

| Strategy | Latency | Cost | Use When |
|---|---|---|---|
| Webhook-triggered re-index | Seconds to minutes | Low — only changed docs | Source supports webhooks (Confluence, Jira, Notion) |
| Polling with change detection | Minutes to hours | Medium — frequent API calls | Source has no webhooks (some file shares) |
| Scheduled full crawl | Hours | High — re-embeds everything | Backup to catch missed changes, run nightly |

**4. Deduplication — The Same Answer in Five Places**

The PTO policy exists in: the HR Confluence page (official), a Slack message from the CEO (slightly different wording), a Google Doc draft (outdated), a Jira ticket requesting the change, and someone's Notion page (copy-pasted).

Solution: **source authority ranking**. Tag each source with an authority level. When retrieved chunks from multiple sources say similar things, prefer the higher-authority source.

```
Authority hierarchy:
1. Official wiki (Confluence spaces marked "official")
2. Policy documents (Google Docs in HR folder)
3. Jira tickets (for current state of projects)
4. Slack (for recent context only — deprioritize >30 days)
5. Personal notes (Notion personal spaces — lowest weight)
```

### Real-World Examples

**Example 1: Glean — The Enterprise Search Pioneer**

Glean connects to 100+ enterprise apps and builds a unified search layer. Their key insight: **people signals matter as much as text signals**. When ranking results, Glean considers who wrote the document, who read it, how recently it was accessed, and which team the questioner belongs to. A document written by the head of engineering that was viewed 50 times this week ranks higher than an identical doc in someone's personal space. Glean indexes over 1 billion documents across their customer base and reports that employees save an average of 2 hours per week versus traditional search. Their permission model syncs with each source system's native permissions, ensuring that a query from a contractor never surfaces full-time-employee-only documents.

**Example 2: Notion AI — RAG Over Your Own Workspace**

Notion AI lets users ask natural language questions over their entire Notion workspace. Their approach is simpler than Glean's (single source, not multi-source) but instructive. They chunk Notion pages using the block-level hierarchy — a page with three sections becomes three chunks, each tagged with the page title and parent path for context. They handle the permission model by filtering at Notion's native sharing level: if a page is shared with you, all chunks from it are searchable. If a page is in a private workspace you don't belong to, those chunks are invisible. Notion reports that their AI feature, launched in 2023, reached 50% adoption within enterprise accounts in the first quarter, with "Find in workspace" being the most-used action.

### When To Use / When NOT To Use

| Use When | Don't Use When |
|---|---|
| Knowledge is scattered across 5+ tools | All knowledge is already in one well-organized wiki |
| Employees spend >30 min/day searching | Team is <20 people who all know where things are |
| Information changes frequently | Data is static and a simple FAQ page covers it |
| Multiple teams need cross-functional answers | Each team only needs their own docs |
| You can invest in permission syncing | You can't guarantee permission accuracy (legal risk) |

### Q&A

**Q: "Wait, so the RAG system needs to integrate with every tool separately? That sounds like a nightmare."**

A: It is. Connectors are the single biggest engineering investment in an enterprise RAG system — often 60%+ of total effort. Each source has its own API, authentication, rate limits, data format, and permission model. This is why companies like Glean, Danswer (open-source), and Coveo build entire businesses around maintaining these connectors. If you're building in-house, start with 2-3 sources that cover the most questions (usually the wiki + Slack) and expand later.

**Q: "How do you keep permissions in sync without a 24-hour lag?"**

A: Three-layer approach. Layer 1: webhooks from source systems for real-time permission changes (Confluence, Google Workspace, and Slack all support this). Layer 2: polling for sources that don't support webhooks (check every 15 minutes). Layer 3: a nightly full reconciliation crawl that catches anything the first two layers missed. The worst-case exposure window should be under 30 minutes.

**Q: "How is this different from just putting everything in Elasticsearch?"**

A: Traditional full-text search (Elasticsearch, Algolia) matches keywords. It finds documents containing "PTO policy." But it can't answer "How many PTO days do I get as a Level 3 engineer who started 6 months ago?" because that answer requires pulling from the PTO policy, the engineering levels page, and the new-hire accrual rules — then synthesizing. RAG retrieves the relevant chunks AND generates an answer from them. That said, many enterprise RAG systems use Elasticsearch as part of their hybrid search layer (remember [Chapter 9](part-2-retrieval-stack.md#chapter-9-hybrid-search--best-of-both-worlds)).

**Q: "You're designing an enterprise KB for a 10,000-person financial services company. They have strict data classification (Public, Internal, Confidential, Restricted). How do you handle it?"**

A: Pre-filter only. Every chunk gets tagged with its classification level during ingestion. User roles map to maximum classification levels (e.g., analyst = Internal, VP+ = Confidential, C-suite = Restricted). At query time, the vector search is constrained to chunks at or below the user's classification level. Never rely on the LLM to filter — it will leak restricted information in its reasoning. Also: log every query and every chunk retrieved for audit. Financial services regulators expect this.

**Q: "What happens if a connector goes down and misses an update — someone deletes a sensitive doc but it's still in the RAG index?"**

A: This is the scariest failure mode. Mitigation: (1) every chunk has a TTL (time-to-live); if the source can't be reached to confirm the chunk is still valid within the TTL window, the chunk is quarantined — excluded from retrieval until confirmed. (2) The nightly reconciliation crawl catches deletions that webhooks missed. (3) Critical sources (HR policies, legal docs) have a shorter TTL (1 hour vs. 24 hours for general content). Glean also maintains a "tombstone" list — when a deletion webhook arrives, the chunk is immediately removed even if the re-index hasn't run yet.

---

## Chapter 27: Design — Customer Support Bot

**One-liner**: A customer support RAG bot resolves common tickets by retrieving answers from help docs, past tickets, and product data — while knowing when to escalate to a human.

**Why you should care**: Your support team handles 10,000 tickets per month. 60% are questions like "How do I reset my password?" "What's your refund policy?" "Why is my integration not working?" — questions that are already answered in your help center. But customers don't search docs. They open tickets. Each ticket costs $15–25 in agent time. A RAG bot that handles 60% of tickets saves $90K–$150K per month. Intercom reports their AI bot Fin resolves up to 50% of support conversations instantly. Zendesk reports AI-resolved tickets take an average of 2 minutes vs. 24 hours for human-handled ones.

**Prerequisites**: [Chapter 10: Prompt Engineering for RAG](part-3-generation-orchestration.md#chapter-10-prompt-engineering-for-rag), [Chapter 14: Conversational RAG](part-3-generation-orchestration.md#chapter-14-conversational-rag--memory), [Chapter 17: Monitoring & Observability](part-4-evaluation-production.md#chapter-17-monitoring--observability)

### The Simple Version

Imagine you're training a new support agent. On their first day, you don't hand them the entire product manual and say "good luck." You give them:

1. **A knowledge base** — the help center articles, organized by topic
2. **A playbook** — decision trees for common issues ("If password reset → check if email is verified → send reset link → if still failing, check account status")
3. **Escalation rules** — "If the customer mentions legal action, refund over $500, or account security — transfer to a senior agent immediately"
4. **Past examples** — "Here's how experienced agents handled similar tickets"

A RAG support bot works the same way, except it retrieves from these sources at machine speed.

### How It Actually Works

```
Customer: "I was charged twice for my subscription"
                    │
                    ↓
    ┌───────────────────────────────────────────┐
    │  1. Intent Classification                  │
    │     → "billing_dispute" (confidence: 0.94) │
    └────────────────┬──────────────────────────┘
                     ↓
    ┌───────────────────────────────────────────┐
    │  2. Safety Check                           │
    │     → mentions "charged twice" → billing   │
    │     → NOT legal threat, NOT security issue │
    │     → proceed (don't escalate yet)         │
    └────────────────┬──────────────────────────┘
                     ↓
    ┌───────────────────────────────────────────┐
    │  3. RAG Retrieval (multi-source)           │
    │     Source 1: Help Center                  │
    │       → "How to request a refund" article  │
    │     Source 2: Billing Playbook             │
    │       → "Double-charge: verify in Stripe,  │
    │          auto-refund if confirmed"          │
    │     Source 3: Customer's Account Data       │
    │       → 2 charges on Oct 15, same amount   │
    └────────────────┬──────────────────────────┘
                     ↓
    ┌───────────────────────────────────────────┐
    │  4. Generate Response                      │
    │     "I can see you were charged twice on   │
    │      Oct 15. I've initiated a refund for   │
    │      the duplicate charge. You'll see it   │
    │      in 5-7 business days. [Source: ...]"  │
    └────────────────┬──────────────────────────┘
                     ↓
    ┌───────────────────────────────────────────┐
    │  5. Action Execution (if authorized)       │
    │     → Call Stripe API: refund $29.99       │
    │     → Update ticket: resolved              │
    │     → Log: auto-resolved, refund issued    │
    └───────────────────────────────────────────┘
```

*What question does this diagram answer? "What are the stages a customer message goes through from receipt to resolution in a RAG support bot?"*

**The 4 critical design decisions:**

**1. Multi-Source Retrieval with Different Strategies**

Support bots retrieve from fundamentally different data types, each needing its own approach:

| Source | What It Contains | Retrieval Strategy |
|---|---|---|
| Help center articles | How-to guides, FAQs | Semantic search — customer words don't match doc titles |
| Decision playbooks | If-then rules for common issues | Keyword + structured lookup — exact issue → exact playbook |
| Past resolved tickets | Similar customer situations | Semantic search with outcome filtering — only retrieve tickets that were resolved successfully |
| Customer account data | Subscription status, billing history | Direct API/database lookup — not vector search |
| Product changelog | Recent changes, known bugs | Keyword search with recency bias — prioritize last 30 days |

**2. The Escalation Safety Net**

The bot must know when NOT to answer. Get this wrong and you'll have an AI promising unauthorized refunds or dismissing a security breach.

```
Escalation triggers (always transfer to human):
├── Customer sentiment: anger score > 0.8 after 2+ messages
├── Topics: legal, security breach, account compromise
├── Actions beyond bot authority: refund > $100, account deletion
├── Confidence: retrieval score < 0.6 on any source
├── Loop detection: same question rephrased 3+ times
└── Explicit request: "Let me talk to a human"
```

*What question does this diagram answer? "When should a RAG support bot stop trying and hand off to a human agent?"*

**3. Conversational Context — Multi-Turn Support**

Remember [Chapter 14: Conversational RAG](part-3-generation-orchestration.md#chapter-14-conversational-rag--memory)? Support conversations are inherently multi-turn:

- Turn 1: "I was charged twice"
- Turn 2: "It happened on my business account"
- Turn 3: "Can you also update my billing email while you're at it?"

Each turn requires re-retrieval with the accumulated context. Turn 3 is a topic switch — the bot must handle it without losing context from turns 1-2.

**4. Tone and Brand Voice**

The LLM's natural tone may not match your brand. A casual DTC brand wants "Hey! I totally get how annoying that is 😊" while a B2B enterprise wants "I understand your concern. Let me look into this immediately."

Encode voice in the system prompt:
- Tone words: "professional, empathetic, concise"
- Do/don't: "DO acknowledge the customer's frustration. DON'T use exclamation marks or emojis for billing issues."
- Length: "Keep responses under 3 sentences for simple answers. Use bullet points for multi-step instructions."

### Real-World Examples

**Example 1: Intercom's Fin — 50% Resolution Without Humans**

Intercom's Fin bot is built on RAG over the customer's help center plus custom training data. Key architectural choices: Fin uses **trusted-source-only** generation — it will only answer if it can cite a specific help article. If it can't find a relevant article, it says "Let me connect you with a teammate" rather than guessing. This eliminates the hallucination problem almost entirely for support. Intercom reports Fin resolves up to 50% of conversations without human involvement, with a customer satisfaction score within 5 points of human agents. Their secret: aggressive "I don't know" behavior. Fin would rather escalate than risk a wrong answer.

**Example 2: Klarna's AI Assistant — 2.3 Million Conversations in One Month**

In February 2024, Klarna reported their AI assistant handled 2.3 million customer service conversations in its first month — equivalent to the work of 700 full-time human agents. It resolved inquiries in an average of 2 minutes vs. 11 minutes for human agents, and the company projected $40 million in annual savings. Key design: the bot has access to customer account data (orders, payments, returns) via API lookup, combined with RAG over Klarna's help documentation. The bot can take actions — initiate returns, explain charges, update addresses — within strictly defined authorization boundaries. Repeat-contact rate dropped 25%, meaning customers weren't coming back because the first answer was wrong.

### When To Use / When NOT To Use

| Use When | Don't Use When |
|---|---|
| >1,000 tickets/month with >40% repetitive questions | Low ticket volume (<200/month) where humans handle load fine |
| Help center content is comprehensive and up to date | Knowledge base is sparse or outdated (garbage in, garbage out) |
| Issues have clear right/wrong answers | Most tickets require subjective judgment or negotiation |
| You can define clear escalation boundaries | Every ticket potentially involves legal/compliance risk |
| You have 3+ months of resolved tickets for evaluation data | No historical data to measure against |

### Q&A

**Q: "If the bot only answers from help articles, how is it better than just showing search results?"**

A: Three ways. First, it synthesizes — a customer asks "Can I get a refund if I cancel after 30 days?" and the bot combines the refund policy article with the cancellation terms article to give a direct answer, instead of making the customer read both. Second, it personalizes — using account data, it says "Your order #4521 is eligible for a refund" not just "Here's the refund policy." Third, it acts — the bot can initiate the refund, not just explain the process.

**Q: "What's the risk of the bot giving a wrong answer about billing?"**

A: This is the #1 risk. A bot that says "you're eligible for a refund" when you're not creates a contractual problem. Mitigation: for any answer involving money, the bot must cite the exact policy clause and include a confidence score internally. If confidence is below 0.9 for billing/legal questions, auto-escalate. Also: every bot-resolved billing ticket gets a random audit (sample 5%) where a human verifies the answer was correct.

**Q: "How is a support RAG bot different from the enterprise knowledge base in Chapter 26?"**

A: Three key differences. (1) **Action execution** — the support bot doesn't just answer, it does things (issue refunds, reset passwords, update accounts). The enterprise KB is read-only. (2) **Escalation** — the support bot must know its limits and hand off to humans. The enterprise KB just says "I don't know." (3) **Customer-facing** — wrong answers have direct business and legal consequences. The enterprise KB serves employees who can verify internally.

**Q: "You're building a support bot for a SaaS with 50K customers. The top 3 ticket categories are billing (35%), how-to (40%), and bug reports (25%). How do you prioritize?"**

A: Launch with how-to tickets first — they have the clearest right answers, lowest risk, and highest volume. RAG over help articles handles these well. Phase 2: billing questions, but with strict guardrails (cite exact policy, escalate if ambiguous, auto-audit 5% of responses). Phase 3: bug reports — these are the hardest because the bot needs to check known-issues databases and potentially reproduce the issue. Many teams keep bug reports human-only permanently.

**Q: "What if a customer intentionally tries to trick the bot into giving an unauthorized refund?"**

A: Adversarial users are real. Defenses: (1) **Action limits** — the bot physically cannot issue refunds above $X without human approval, enforced at the API level, not the prompt level. (2) **Prompt injection protection** — sanitize customer input before including it in the LLM prompt (remember: customer messages are untrusted input). (3) **Rate limiting** — flag accounts that attempt 3+ refund requests in 24 hours. (4) **Audit trail** — every action is logged with the full conversation context, so fraudulent patterns can be detected retroactively.

---

## Chapter 28: Design — Legal Document Research

**One-liner**: Legal RAG builds a research system where lawyers can ask natural-language questions over contracts, case law, regulations, and internal memos — getting precise, cited answers with zero tolerance for hallucination.

**Why you should care**: A junior associate at a law firm bills $300/hour. They spend 30-40% of their time on legal research — reading through case law, contracts, and regulations to find relevant precedents and clauses. For a firm with 200 associates, that's $25-35 million/year in research time. But the real cost isn't money — it's the missed citation. A lawyer who misses a relevant precedent or cites a case that was later overturned doesn't just look bad — they commit malpractice. In 2023, a New York attorney used ChatGPT for legal research and cited six fake cases that the AI hallucinated. The judge sanctioned the attorney $5,000 and the story made national news. Legal RAG must be *provably correct or silent*.

**Prerequisites**: [Chapter 11: Reranking](part-3-generation-orchestration.md#chapter-11-reranking--promoting-the-best-results), [Chapter 15: RAG Evaluation Metrics](part-4-evaluation-production.md#chapter-15-rag-evaluation-metrics), [Chapter 23: Multimodal RAG](part-5-advanced-patterns.md#chapter-23-multimodal-rag--beyond-text)

### The Simple Version

Imagine a law library with a million books. A traditional legal search is like a keyword search through the index cards — you find books that mention "breach of fiduciary duty" but you have to read each one yourself to decide if it's relevant. Legal RAG is like having a paralegal who has read every book in the library, understands legal reasoning, and can say: "Based on your question, the most relevant cases are X, Y, and Z. Here are the exact paragraphs. Case X was decided in 2019 in the 9th Circuit and held that... Case Y, however, was partially overturned by Z in 2022."

But here's the critical difference from other RAG applications: the paralegal must *never make up a case* and must always tell you if they're unsure.

### How It Actually Works

```
Lawyer: "Has the 9th Circuit ruled on whether AI-generated
         content is copyrightable?"
              │
              ↓
    ┌────────────────────────────────────────────┐
    │  1. Legal Query Understanding                │
    │     Jurisdiction: 9th Circuit                │
    │     Topic: AI + copyright                    │
    │     Query type: precedent search             │
    │     Time: any (but flag recent cases)        │
    └─────────────────┬──────────────────────────┘
                      ↓
    ┌────────────────────────────────────────────┐
    │  2. Multi-Index Search                       │
    │                                              │
    │     Index 1: Case law database               │
    │       → Semantic: "AI content copyright"     │
    │       → Filter: jurisdiction = 9th Circuit   │
    │       → 12 candidate cases                   │
    │                                              │
    │     Index 2: Statutory law                   │
    │       → Copyright Act §§ 101-103             │
    │       → Recent amendments                    │
    │                                              │
    │     Index 3: Secondary sources               │
    │       → Law review articles on AI copyright  │
    └─────────────────┬──────────────────────────┘
                      ↓
    ┌────────────────────────────────────────────┐
    │  3. Legal-Specific Reranking                 │
    │     → Prioritize: binding authority > 		   │
    │       persuasive authority                   │
    │     → Recency: newer cases rank higher       │
    │     → Treatment: exclude overruled cases     │
    │     → Result: 4 highly relevant cases        │
    └─────────────────┬──────────────────────────┘
                      ↓
    ┌────────────────────────────────────────────┐
    │  4. Generate Answer WITH Verification        │
    │     → Draft answer citing 4 cases            │
    │     → Cross-check: does each citation exist? │
    │     → Cross-check: are quotes accurate?      │
    │     → Cross-check: is any case overruled?    │
    │     → Final answer with pinpoint citations   │
    └────────────────────────────────────────────┘
```

*What question does this diagram answer? "What are the stages of a legal RAG query from question to verified, cited answer?"*

**The 4 non-negotiable requirements:**

**1. Pinpoint Citations — Not Just Source, But Paragraph**

In legal work, "see Smith v. Jones" isn't enough. Lawyers need: "Smith v. Jones, 543 F.3d 812, 819 (9th Cir. 2019)" — the case name, reporter volume, page, pinpoint page, court, and year. Your chunks must carry this metadata.

| Citation Element | Where It Comes From | Stored As |
|---|---|---|
| Case name | Document title | Metadata field |
| Reporter citation | Document metadata | Structured field (volume, reporter, page) |
| Pinpoint page/paragraph | Chunk position within document | Chunk-level metadata |
| Court and year | Document metadata | Structured fields |
| Treatment (overruled, affirmed, etc.) | External citator service (Shepard's, KeyCite) | Linked metadata, refreshed daily |

**2. Hallucination Elimination — Not Reduction, Elimination**

For most RAG applications, a 5% hallucination rate is annoying but tolerable. For legal, it's malpractice. The approach:

- **Extractive over generative**: The system quotes directly from sources wherever possible rather than paraphrasing. Paraphrasing introduces hallucination risk.
- **Verification loop**: After generating an answer, a second LLM pass verifies that every cited case exists in the index and every quoted passage matches the stored text. If any citation can't be verified, it's removed and the answer is regenerated.
- **Explicit uncertainty**: If retrieval confidence is below a threshold, the system says "I found limited authority on this question" rather than generating from the LLM's training data.

**3. Authority Hierarchy — Not All Sources Are Equal**

Legal reasoning has a strict hierarchy of authority that must be encoded into retrieval ranking:

```
Authority hierarchy (binding → persuasive):
1. Constitutional provisions
2. Statutes (federal → state)
3. Binding case law (same jurisdiction, higher court)
4. Persuasive case law (other jurisdictions, lower courts)
5. Regulations and administrative rulings
6. Secondary sources (law reviews, treatises, restatements)
7. Internal firm memos and work product
```

*What question does this diagram answer? "How should a legal RAG system prioritize different types of legal sources?"*

**4. Temporal Awareness — Law Changes**

A case decided in 2015 may have been overruled in 2022. A statute amended in 2023 may supersede older case law. The system must:

- Track the "treatment" of every case (affirmed, overruled, distinguished, superseded)
- Flag cited authorities that have negative treatment
- Prioritize recent authorities for evolving areas of law
- Show the user the full treatment chain when relevant

### Real-World Examples

**Example 1: Harvey AI — AI for Elite Law Firms**

Harvey AI, backed by $100M+ in funding, builds AI tools for law firms including Allen & Overy (one of the world's largest). Their system is trained on legal data and uses RAG over firm-specific knowledge (contracts, memos, precedent research). Key design choice: Harvey never generates legal conclusions from training data alone. Every factual claim must be grounded in a retrieved document. When lawyers ask a question Harvey can't answer from the firm's knowledge base, it says so explicitly rather than guessing. Allen & Overy reported that Harvey reduced the time for certain research tasks by 70% while maintaining the accuracy standards required for client-facing work.

**Example 2: Clio — Practice Management + AI**

Clio, used by over 150,000 law firms, added AI-powered search across a firm's entire document collection — contracts, correspondence, court filings, and notes. Their approach handles the multimodal challenge: legal documents include scanned PDFs, handwritten annotations, tables, and exhibits. Clio uses OCR + layout-aware chunking (remember [Chapter 23: Multimodal RAG](part-5-advanced-patterns.md#chapter-23-multimodal-rag--beyond-text)) to extract text while preserving document structure. A contract's "Termination Clause" chunk carries metadata noting it's in Article 7, Section 3 — enabling pinpoint references. For a personal injury firm, finding the relevant medical record page in a 500-page exhibit takes seconds instead of hours.

### When To Use / When NOT To Use

| Use When | Don't Use When |
|---|---|
| Research across large document collections (>10K docs) | Simple clause lookup in a single known document |
| Questions require synthesizing multiple sources | The answer is always in one specific place |
| Junior associates spend >30% of time on research | Experienced attorneys who know exactly where to look |
| Firm has structured citation and precedent needs | Internal-only memo writing where precision is less critical |
| You can invest in verification and audit infrastructure | You can't build the hallucination verification loop |

### Q&A

**Q: "Can't lawyers just use ChatGPT with web search? Why build a whole RAG system?"**

A: The New York attorney who got sanctioned asked ChatGPT the same question. General LLMs hallucinate case citations — they generate plausible-sounding but fake case names and reporter citations. A legal RAG system searches over *verified* databases of actual cases. Every citation it returns exists and can be verified. This is a fundamental difference: the LLM generates language, but the facts come from a known-good index.

**Q: "How do you handle contracts that are 200 pages long with cross-references between sections?"**

A: Structural chunking with cross-reference resolution. A 200-page contract is chunked by clause (Article → Section → Subsection). Each chunk carries its full hierarchical path ("Master Services Agreement > Article 7: Termination > Section 7.3: Termination for Cause"). Cross-references like "subject to Section 12.4" are resolved at index time — the chunk includes a pointer to Section 12.4, and when that chunk is retrieved, Section 12.4 is automatically included as supporting context. This mirrors how lawyers actually read contracts: they follow the cross-reference chain.

**Q: "How is legal RAG different from the enterprise knowledge base in Chapter 26?"**

A: Three critical differences. (1) **Zero hallucination tolerance** — enterprise KB can sometimes be "close enough." Legal RAG must be exactly right or say nothing. (2) **Citation specificity** — enterprise KB cites a document. Legal RAG cites a specific paragraph with full legal citation format. (3) **Authority hierarchy** — in enterprise KB, a CEO's Slack message and an HR policy might conflict and both are "valid." In legal RAG, a Supreme Court decision overrides a district court opinion — there's a strict, well-defined hierarchy.

**Q: "A law firm wants to build a RAG system over 30 years of their own contracts to help draft new ones. What's the biggest risk?"**

A: Confidentiality contamination. Those 30 years of contracts contain confidential information from hundreds of clients. If a lawyer working for Client A asks a question and the RAG system retrieves clauses from Client B's contracts, you've just breached attorney-client privilege. The solution is strict multi-tenancy: every chunk is tagged with the client matter it belongs to, and retrieval is filtered to only return chunks from the current client's matters, plus the firm's template library. This is the access control problem from [Chapter 19](part-4-evaluation-production.md#chapter-19-security--access-control), but with legal liability if you get it wrong.

**Q: "What happens when the legal database itself has errors — a case was incorrectly entered or a statute reference is wrong?"**

A: This is why legal RAG must integrate with authoritative legal databases (Westlaw, LexisNexis) rather than building their own case law corpus from scratch. These services have decades of editorial review and citator services that track when cases are overruled, distinguished, or criticized. Even so, the RAG system should: (1) display the primary source alongside the AI-generated answer so the lawyer can verify, (2) flag any authority with negative treatment (a case that was later overruled), and (3) include a "last verified" timestamp on every citation. The lawyer makes the final judgment — the AI is a research accelerator, not a replacement for legal reasoning.

---

## Chapter 29: Design — Code Search & Documentation

**One-liner**: Code RAG builds an AI assistant that understands a codebase — answering questions like "How does authentication work?" or "Where is the payment flow implemented?" by retrieving and reasoning over actual source code, documentation, and commit history.

**Why you should care**: Your company has a 5-million-line monorepo. A new engineer needs to understand the payment processing flow. They could grep for "payment" — 2,300 results across 400 files. They could ask a senior engineer — but the person who wrote it left the company two years ago. They could read the documentation — which is 18 months out of date. They spend 3 days piecing together the flow from code comments, git blame, and Slack archaeology. GitHub's 2023 developer survey found that developers spend 60% of their time *reading and understanding code*, not writing it. Code RAG turns 3 days of archaeology into a 30-second conversation.

**Prerequisites**: [Chapter 25: RAG for Code](part-5-advanced-patterns.md#chapter-25-rag-for-code), [Chapter 21: Agentic RAG](part-5-advanced-patterns.md#chapter-21-agentic-rag--when-one-search-isnt-enough)

### The Simple Version

Imagine a massive library where every book is written in a programming language, books reference each other constantly ("see Chapter 4 of Book 237"), and the librarian needs to understand not just what words are on the page but how they *execute*. Code RAG is that librarian. But unlike a text librarian, it understands structure: this is a function, it calls that function, which reads from this database table, which is defined in that migration file. It traces the *flow* of logic across files.

### How It Actually Works

```
Developer: "How does our API handle rate limiting?"
                    │
                    ↓
    ┌────────────────────────────────────────────┐
    │  1. Query Analysis                           │
    │     Type: conceptual ("how does X work")     │
    │     Entities: "API", "rate limiting"         │
    │     Strategy: multi-hop (need definition +   │
    │               implementation + config)        │
    └─────────────────┬──────────────────────────┘
                      ↓
    ┌────────────────────────────────────────────┐
    │  2. Multi-Index Retrieval                    │
    │                                              │
    │   Code Index (AST-chunked):                  │
    │     → RateLimiter class definition           │
    │     → middleware/rate_limit.py (full file)   │
    │     → config/rate_limits.yaml                │
    │                                              │
    │   Docs Index:                                │
    │     → API rate limiting docs (if they exist) │
    │     → Architecture Decision Record #47       │
    │                                              │
    │   Git History Index:                         │
    │     → PR #1823: "Add sliding window rate     │
    │       limiter" (commit message + diff)        │
    │     → PR #2104: "Fix rate limit bypass bug"  │
    └─────────────────┬──────────────────────────┘
                      ↓
    ┌────────────────────────────────────────────┐
    │  3. Code-Aware Reranking                     │
    │     → Definitions > usages > tests           │
    │     → Active code > deprecated/dead code     │
    │     → Recent changes > old, unchanged code   │
    │     → Result: 6 highly relevant code chunks  │
    └─────────────────┬──────────────────────────┘
                      ↓
    ┌────────────────────────────────────────────┐
    │  4. Code-Aware Generation                    │
    │     "Our API uses a sliding window rate      │
    │      limiter (implemented in                 │
    │      middleware/rate_limit.py). Each API key  │
    │      gets 1000 req/min (configured in        │
    │      config/rate_limits.yaml). When exceeded, │
    │      it returns 429 with a Retry-After        │
    │      header. The rate limiter uses Redis      │
    │      sorted sets — see RateLimiter.check()   │
    │      at line 47."                             │
    └────────────────────────────────────────────┘
```

*What question does this diagram answer? "How does a code RAG system trace a concept across code, documentation, and git history to answer an architectural question?"*

**The 4 unique challenges of code RAG:**

**1. Chunking Code Is Not Like Chunking Text**

Remember [Chapter 25: RAG for Code](part-5-advanced-patterns.md#chapter-25-rag-for-code)? Text chunking splits by paragraphs. Code chunking must respect structure:

| Chunk Unit | What It Contains | When to Use |
|---|---|---|
| Function/method | Complete function with signature, docstring, body | Default for most languages — functions are the natural unit of code logic |
| Class | Full class with all methods | When the class is small (<100 lines) or cohesion matters |
| File | Entire source file | For config files, small utility files, schema definitions |
| Logical block | A section of a function separated by blank lines or comments | For very long functions (>200 lines) that should be broken up |
| Dependency graph slice | A function + all functions it calls (1-2 levels deep) | For tracing execution flows |

**2. Understanding Call Graphs and Dependencies**

Code isn't just text — it has *structure*. A function calls other functions, imports modules, reads from databases, and writes to queues. To answer "How does authentication work?" you need to follow the chain:

```
login_handler() → authenticate() → verify_password()
                                  → check_mfa()
                                  → create_session() → generate_jwt()
                                                     → store_in_redis()
```

*What question does this diagram answer? "Why does a code RAG system need to understand call graphs, not just individual functions?"*

Solution: Build a **code graph** at index time using AST (Abstract Syntax Tree) parsing. When a function is retrieved, automatically include its immediate callees as supporting context. Sourcegraph's code intelligence does exactly this — when you hover over a function, it shows you the definition, all callers, and all callees.

**3. Keeping the Index Fresh as Code Changes**

Codebases change constantly. Hundreds of commits per day in active repos. The index must stay current:

- **Webhook on merge to main**: re-index only changed files
- **Incremental embedding**: re-embed only chunks that actually changed (compare hashes)
- **Dependency propagation**: when `auth.py` changes, also re-index files that import from it (their context has changed)
- **Full re-index**: nightly, to catch structural changes that incremental misses

**4. Multi-Language, Multi-Repo**

Real companies have code in Python, TypeScript, Go, Java, and more — across multiple repositories with dependencies between them. The indexing pipeline must:

- Parse each language's AST separately (tree-sitter handles 100+ languages)
- Understand cross-language calls (Python service calls Go service via gRPC)
- Resolve cross-repo dependencies (shared libraries, internal packages)

### Real-World Examples

**Example 1: Sourcegraph Cody — Code AI With Full Repo Context**

Sourcegraph's Cody is a code AI assistant that uses RAG over entire codebases. Their key innovation: **code graph indexing**. They don't just index files as text — they build a semantic graph of definitions, references, implementations, and type hierarchies using their Code Intelligence platform (which processes over 5 million repositories). When a developer asks "How does our error handling work?", Cody retrieves not just files containing "error" but traces the actual error propagation path through the code graph. Sourcegraph reports that Cody users answer codebase questions 55% faster than using traditional search, and new engineers reach productive contribution 30% faster.

**Example 2: GitHub Copilot's Workspace Context**

GitHub Copilot increasingly uses RAG over the local workspace to provide contextual suggestions. When you're editing a file, Copilot retrieves relevant code from open tabs, recently edited files, and imported modules to inform its completions. The retrieval strategy is workspace-local (no cloud search), uses a combination of file proximity (files in the same directory), recency (recently opened files), and dependency analysis (imported modules). GitHub reports that Copilot improves developer productivity by 55% for code completion tasks, and its accuracy is significantly higher when it has more workspace context through RAG.

### When To Use / When NOT To Use

| Use When | Don't Use When |
|---|---|
| Codebase >500K lines where tribal knowledge is a bottleneck | Small codebase (<50K lines) where grep works fine |
| Frequent onboarding (>5 new engineers/quarter) | Stable team that all know the code |
| Code spans multiple languages/repos with complex dependencies | Single-language, single-repo with good docs |
| Existing documentation is sparse, outdated, or scattered | Documentation is comprehensive and maintained |
| Architecture questions ("How does X connect to Y?") are common | Most questions are about syntax or API usage (use general Copilot) |

### Q&A

**Q: "Can't developers just use grep or their IDE's search? Why build a whole RAG system?"**

A: Grep finds text matches. It tells you "rate_limit" appears in 47 files. It doesn't tell you which one defines the rate limiter, which ones use it, which one configures it, and how they connect. Code RAG understands *semantics*, not just strings. Ask it "How does rate limiting work?" and it traces the flow from the middleware through the configuration to the Redis backend — something grep can't do.

**Q: "How do you handle code that's behind feature flags or only runs in certain environments?"**

A: Index metadata matters. Every chunk should carry metadata: branch, feature flag status, environment tags. When a developer asks about the payment flow, the system should surface the *production* version by default, with a note if there's a feature-flagged version that differs. Some teams maintain a "code state" index that maps feature flags to the code paths they enable, so the RAG system can answer "What does the payment flow look like with the new checkout flag enabled?"

**Q: "How is code RAG different from the enterprise KB in Chapter 26?"**

A: Two fundamental differences. (1) **Structure matters** — enterprise docs are text blobs. Code has ASTs, call graphs, type systems, and dependency chains. You need specialized parsers, not just text chunking. (2) **Execution semantics** — a text document means what it says. Code means what it *does*, which may not be obvious from reading it. A function called `validateInput` might also write to a log, emit a metric, and throw an exception — code RAG must understand these side effects.

**Q: "You're building a code RAG system for a company with a 10-million-line monorepo in Python/TypeScript/Go. What's the hardest problem?"**

A: Cross-language tracing. The Python API layer calls a Go microservice via gRPC, which writes to a database whose schema is defined in SQL migration files. When a developer asks "What happens when a user places an order?", the answer spans all three languages and a schema definition. You need: (1) language-specific AST parsers for each language, (2) cross-language dependency resolution (the Python gRPC client stub → the Go server implementation), (3) a unified code graph that connects across language boundaries. This is the hardest unsolved problem in code RAG — most tools handle single-language well but struggle at cross-language boundaries.

**Q: "The codebase has 10,000 tests. Should those be indexed too?"**

A: Yes — tests are some of the most valuable code to index. They show *how* to use an API (tests are executable documentation), *what edge cases were considered* (boundary tests reveal known gotchas), and *what behavior is expected* (assertions are specifications). When a developer asks "How do I use the PaymentProcessor?", retrieving the test file that exercises PaymentProcessor is often more useful than retrieving the implementation. Index tests, but rank them below production code definitions and above usage sites.

---

## Chapter 30: Design — E-Commerce Product Search

**One-liner**: E-commerce RAG replaces keyword product search with natural-language understanding — turning queries like "red dress under $50 for a summer wedding" into accurate product results that understand intent, style, occasion, and constraints.

**Why you should care**: Your online store has 500,000 products. A customer searches "comfortable work shoes for standing all day." Traditional keyword search matches "shoes" and maybe "comfortable" — returning 8,000 results including high heels, running shoes, and sandals. The customer scrolls past three pages of irrelevant results and leaves. 68% of e-commerce searches fail to return relevant results on the first page (Baymard Institute). For a store doing $100M in annual revenue, improving search relevance by just 10% can drive $5-15M in additional revenue. Amazon attributes 35% of its revenue to its recommendation and search engine.

**Prerequisites**: [Chapter 6: Embeddings](part-2-retrieval-stack.md#chapter-6-embeddings--turning-text-into-numbers), [Chapter 9: Hybrid Search](part-2-retrieval-stack.md#chapter-9-hybrid-search--best-of-both-worlds), [Chapter 18: Cost & Latency Optimization](part-4-evaluation-production.md#chapter-18-cost--latency-optimization)

### The Simple Version

Imagine a personal shopper at a department store. You walk in and say "I need something for a beach vacation — casual, not too expensive, and I burn easily." A keyword-matching robot would hear "beach" and point you to the beach section. The personal shopper understands the full intent: you need resort wear, with UV protection, at a mid-range price point, probably in light colors. They take you to three specific items, not an aisle.

E-commerce RAG is the personal shopper. It understands the *intent* behind the query, matches it against product attributes that may not contain those exact words, and returns a curated, ranked set of products.

### How It Actually Works

```
Customer: "red dress under $50 for a summer wedding"
                    │
                    ↓
    ┌────────────────────────────────────────────┐
    │  1. Query Understanding                      │
    │     Color: red                                │
    │     Category: dress                           │
    │     Price: < $50                              │
    │     Occasion: wedding (→ semi-formal+)        │
    │     Season: summer (→ lightweight fabric)     │
    │     Implicit: not white (wedding guest rule)  │
    └─────────────────┬──────────────────────────┘
                      ↓
    ┌────────────────────────────────────────────┐
    │  2. Hybrid Retrieval                         │
    │                                              │
    │   Structured Filters (hard constraints):     │
    │     price ≤ $50                              │
    │     category = "dresses"                     │
    │     color_family = "red"                     │
    │     in_stock = true                          │
    │                                              │
    │   Semantic Search (soft preferences):        │
    │     "summer wedding guest dress"             │
    │     → matches descriptions mentioning:       │
    │       "cocktail," "garden party,"            │
    │       "lightweight," "formal event"          │
    │                                              │
    │   Combine: RRF over filtered results         │
    └─────────────────┬──────────────────────────┘
                      ↓
    ┌────────────────────────────────────────────┐
    │  3. Personalization Reranking                │
    │     User's past purchases: size M, prefers  │
    │       midi length, bought brand X before     │
    │     Boost: products matching past preferences│
    │     Boost: products with >4★ reviews         │
    │     Boost: products with "wedding" in reviews│
    └─────────────────┬──────────────────────────┘
                      ↓
    ┌────────────────────────────────────────────┐
    │  4. Results + Optional NL Summary            │
    │     "Here are 12 red dresses under $50,     │
    │      sorted by best match for a summer      │
    │      wedding. Top picks: [3 products with   │
    │      high review scores for wedding wear]"  │
    └────────────────────────────────────────────┘
```

*What question does this diagram answer? "How does an e-commerce RAG system decompose a natural-language query into structured filters and semantic search?"*

**The 4 unique challenges of e-commerce search:**

**1. Structured + Unstructured: The Hybrid Problem**

Product data is uniquely hybrid — it has structured attributes (price, color, size, category) and unstructured text (descriptions, reviews, Q&A). The query "red dress under $50 for a summer wedding" contains both:

| Query Part | Type | Handling |
|---|---|---|
| "red" | Structured — exact match on color attribute | Filter |
| "dress" | Structured — exact match on category | Filter |
| "under $50" | Structured — numeric range on price | Filter |
| "summer wedding" | Unstructured — intent/occasion | Semantic search over descriptions + reviews |

The key insight: apply structured filters *first* to narrow the candidate set, then semantic search over the filtered results. This is faster (smaller search space) and more accurate (no semantic drift into shoes or bags).

**2. The Vocabulary Gap — Customers Don't Speak Product Catalog**

Customers say "comfy" but the product description says "ergonomic cushioning technology." They say "good for hiking" but the spec sheet says "Vibram outsole, GORE-TEX waterproof membrane." This vocabulary gap is where keyword search fails and semantic search shines.

Closing the gap:

- **Embed product descriptions + review text together** — reviews contain customer language ("so comfy!", "wore these to a wedding")
- **Query expansion** — "summer wedding" → also search for "cocktail party," "outdoor event," "garden party"
- **Synonym mapping** — "couch" = "sofa," "sneakers" = "trainers," "pants" = "trousers"

**3. Latency Under 200ms — No Exceptions**

Remember [Chapter 18: Cost & Latency Optimization](part-4-evaluation-production.md#chapter-18-cost--latency-optimization)? E-commerce search must return results in under 200ms. Every 100ms of added latency reduces conversion by 1% (Amazon's data). This rules out calling an LLM on every search query.

```
Latency budget for e-commerce search:

Component          Target    Approach
─────────────────────────────────────────────
Query parsing      10ms     Rule-based + small classifier
Structured filter  20ms     Database index scan
Semantic search    50ms     ANN on pre-computed embeddings
Reranking          30ms     Lightweight cross-encoder or LTR model
Personalization    20ms     Pre-computed user vectors
Response build     10ms     Template
─────────────────────────────────────────────
Total budget:     <200ms
```

*What question does this diagram answer? "Where does the latency budget go in e-commerce search, and how do you stay under 200ms?"*

Notice: no LLM in the hot path. The LLM is used for *offline* tasks — generating product embeddings, enriching product metadata, expanding the synonym dictionary — not for real-time query processing.

**4. Conversion Optimization — Relevance ≠ Revenue**

In e-commerce, "most relevant" isn't always "best result." A perfectly relevant $10 item might rank above a slightly less relevant $45 item — but the $45 item has higher margin, better reviews, and lower return rate. Real e-commerce ranking balances:

- **Relevance** — does the product match the query?
- **Business value** — margin, conversion rate, return rate
- **User value** — review scores, inventory availability
- **Diversity** — show different brands/styles, not 12 variations of the same dress

### Real-World Examples

**Example 1: Amazon — The Gold Standard of Product Search**

Amazon processes over 300 million active customer accounts and billions of products. Their search system combines keyword matching, semantic understanding, and behavioral signals. When you search "laptop for video editing," Amazon doesn't just keyword-match — it understands you need a powerful GPU, large RAM, and good display. Their A9 ranking algorithm considers text relevance, sales velocity, customer ratings, price competitiveness, and Prime eligibility. Amazon's internal data shows that 35% of revenue comes from product recommendations, and semantic search improvements drove a 5% increase in conversion in their 2022 A/B tests. The key insight: Amazon embeds product titles, bullet points, descriptions, *and* customer reviews together — so when a customer says "good for video editing," it matches products where other customers mentioned video editing in their reviews.

**Example 2: Shopify's Semantic Search — From Keywords to Intent**

Shopify introduced semantic search (powered by Shopify Magic) for their merchants' stores. Previously, a search for "gift for dad" on a store selling outdoor gear would return nothing unless a product literally contained "gift for dad." With semantic search, it returns popular items like multi-tools, hiking socks, and campfire cooking sets — products frequently bought as gifts, with reviews mentioning "got this for my dad." Shopify reported that merchants who enabled semantic search saw a 4-7% increase in search-to-purchase conversion. Their approach: pre-compute embeddings for all products using the title + description + review text, and match against the query embedding at search time. They use Shopify's own embedding model fine-tuned on e-commerce data, because general-purpose embeddings don't understand that "date night outfit" and "cocktail dress" are semantically close.

### When To Use / When NOT To Use

| Use When | Don't Use When |
|---|---|
| Catalog >10K products where keyword search fails on long-tail queries | Small catalog (<500 products) where faceted browse works fine |
| Customers use natural language ("gift for 10-year-old who likes science") | Users search by exact product name or SKU |
| Products have rich text descriptions and reviews | Products are commodities with minimal descriptions (e.g., raw materials) |
| Vocabulary gap is high (customer language ≠ catalog language) | Products have standardized, searchable specifications (e.g., industrial parts) |
| You can invest in embedding infrastructure and A/B testing | Latency or cost budget can't support semantic search |

### Q&A

**Q: "Why not just use an LLM to process every search query in real time?"**

A: Latency and cost. An LLM call takes 500ms-2000ms. E-commerce search needs <200ms. And at 100K searches/day, LLM calls would cost $5K-50K/month for search alone. Instead, use LLMs *offline* (enrich product data, generate embeddings, build synonym maps) and fast vector search *online*. Some systems use an LLM only for complex queries ("I need a gift for my mother-in-law who's hard to shop for, she likes gardening but already has all the tools") — maybe 5% of queries — and fast vector search for the other 95%.

**Q: "How do you handle it when a customer searches for something that doesn't exist in the catalog?"**

A: Three approaches. (1) **Nearest-neighbor fallback** — return the closest products, with a message: "We don't have an exact match for 'green velvet jumpsuit,' but here are similar items." (2) **Query relaxation** — drop the least important constraint: "green velvet jumpsuit" → "green jumpsuit" → "velvet jumpsuit." (3) **Category redirect** — if semantic search confidence is very low, redirect to the most relevant category page instead of showing poor results. Never show a "no results" page — that's a lost customer.

**Q: "How is this different from the enterprise knowledge base in Chapter 26? Both do search."**

A: Three key differences. (1) **Structured data dominance** — enterprise KB is mostly text. E-commerce has structured attributes (price, color, size) that are hard constraints, not soft preferences. (2) **Latency** — enterprise KB can take 1-2 seconds. E-commerce must respond in <200ms. (3) **Ranking objective** — enterprise KB optimizes for accuracy (did you find the right document?). E-commerce optimizes for conversion (did the customer buy?). The "best" result might not be the most relevant one — it's the one with the highest predicted purchase probability.

**Q: "You're building search for a fashion e-commerce site with 2 million products. The CEO wants 'AI-powered search.' What's your architecture?"**

A: Three layers. Layer 1 (offline): embed all products using title + description + review text with an e-commerce-fine-tuned model. Store in a vector DB with all structured attributes as metadata. Layer 2 (online, <200ms): parse the query into structured filters (price, color, category) and a semantic component. Apply filters, then ANN search over the filtered subset, then rerank with a lightweight model trained on click-through data. Layer 3 (enhancement): for the 5% of complex queries (long, conversational, ambiguous), route to an LLM that rewrites the query into a better search query, then run Layer 2. Start measuring conversion uplift from day one with A/B tests — feature-flagged so you can roll back.

**Q: "What happens during Black Friday when search traffic spikes 10x?"**

A: Pre-compute and cache aggressively. (1) **Warm the cache** — pre-compute results for the top 1,000 search queries (they cover ~40% of traffic). (2) **Pre-filter embeddings** — during peak, skip personalization reranking (saves 20ms) and serve generic results. (3) **Horizontal scaling** — vector search is stateless and scales horizontally; pre-provision extra replicas before the event. (4) **Graceful degradation** — if semantic search latency exceeds 100ms, fall back to keyword search + filters. A fast keyword result is better than a slow semantic result that causes the customer to leave. Remember [Chapter 18](part-4-evaluation-production.md#chapter-18-cost--latency-optimization): always have a degradation plan.

---

## Putting It Together (Part 6): Architecture Comparison and Decision Framework

We've designed five very different RAG systems. Let's see what they share, where they diverge, and why.

### Architecture Comparison Table

| Dimension | Enterprise KB (Ch 26) | Support Bot (Ch 27) | Legal Research (Ch 28) | Code Search (Ch 29) | E-Commerce (Ch 30) |
|---|---|---|---|---|---|
| **Primary data type** | Mixed text (docs, Slack, wikis) | Help articles + customer data | Legal documents (cases, contracts, statutes) | Source code + docs + git history | Product catalog + reviews |
| **Chunking strategy** | Per-source (structural, thread, recursive) | Article-based + playbook-based | Clause-level structural | AST-based (function/class) | Product-as-document |
| **Search type** | Hybrid (vector + keyword) | Multi-source hybrid | Multi-index with authority ranking | Code-graph-aware semantic | Structured filters + semantic |
| **Reranking** | Source authority + recency | Intent confidence + playbook match | Legal authority hierarchy + recency | Definition > usage > test | Relevance × business value × personalization |
| **Hallucination tolerance** | Low (employees can usually verify) | Very low (customer-facing, brand risk) | Zero (malpractice risk) | Low (can verify against code) | Medium (wrong product ≠ wrong fact) |
| **Latency target** | 2-5 seconds | 1-3 seconds | 3-10 seconds | 2-5 seconds | <200ms |
| **Action execution** | No (read-only answers) | Yes (refunds, resets, updates) | No (research only) | No (answers, not code changes) | No (search results, not purchases) |
| **Access control** | Critical (multi-team, per-doc ACLs) | Customer-scoped (see own data only) | Critical (client confidentiality) | Team/repo-level | Public catalog (no ACL needed) |
| **Freshness requirement** | Minutes (webhooks + daily crawl) | Hours (help articles change slowly) | Daily (case law updates daily) | Minutes (code changes constantly) | Hours (catalog updates in batches) |
| **Evaluation metric** | Answer accuracy + user satisfaction | Resolution rate + CSAT + escalation rate | Citation accuracy + completeness | Answer accuracy + code traceability | Conversion rate + click-through |
| **LLM in hot path?** | Yes (generates answer) | Yes (generates + decides actions) | Yes (generates + verifies citations) | Yes (generates answer from code) | No (offline only; LLM too slow) |

*What question does this table answer? "How do the five RAG architectures differ across key design dimensions?"*

### What They All Share

Despite their differences, all five architectures share these core patterns:

1. **Hybrid retrieval** — None relies on pure vector search alone. Every system combines semantic search with some form of structured or keyword matching. E-commerce uses structured filters + semantic. Legal uses keyword for exact citations + semantic for concepts. The universal lesson: vector search alone isn't enough for production RAG.

2. **Source-aware chunking** — No system uses naive fixed-size chunks. Every one has a chunking strategy tailored to its data: clause-level for legal, AST-based for code, thread-based for Slack, product-as-document for e-commerce. The universal lesson: chunking strategy is the most important design decision in any RAG system (as we said in [Chapter 5](part-2-retrieval-stack.md#chapter-5-chunking-strategies)).

3. **Evaluation tied to business outcomes** — None measures "retrieval accuracy" in isolation. Enterprise KB measures time-to-answer. Support bot measures resolution rate. Legal measures citation accuracy. Code measures developer onboarding speed. E-commerce measures conversion. The universal lesson: RAG metrics must connect to the business problem you're solving.

4. **Graceful degradation** — Every system has a fallback: the support bot escalates to a human, the legal system says "I found limited authority," the enterprise KB says "I don't know," the e-commerce search falls back to keyword matching. The universal lesson: knowing when to fail gracefully is as important as succeeding.

### The Decision Framework

When designing a RAG system for a new use case, answer these four questions:

**Question 1: What's your hallucination tolerance?**

```
Zero tolerance (legal, medical, financial)
  → Extractive answers + citation verification loop
  → "I don't know" as default behavior
  → Human-in-the-loop for all outputs

Low tolerance (enterprise, support, code)
  → Grounded generation with citations
  → Confidence thresholds for escalation
  → Periodic audit sampling

Medium tolerance (search, recommendations, creative)
  → Standard RAG with quality monitoring
  → Focus on relevance over precision
```

**Question 2: What's your latency budget?**

```
<200ms (e-commerce, real-time search)
  → No LLM in hot path
  → Pre-computed embeddings + ANN search
  → Cache aggressively

1-5 seconds (enterprise KB, code search)
  → LLM in hot path for answer generation
  → Reranking + single generation call
  → Moderate caching

5-30 seconds (legal research, deep analysis)
  → Multi-step agentic retrieval acceptable
  → Verification loops feasible
  → Thoroughness > speed
```

**Question 3: What's your data structure?**

```
Mostly unstructured text (enterprise docs, legal)
  → Structural chunking + hybrid search
  → Focus on chunk quality and boundaries

Mostly structured (e-commerce, databases)
  → Structured filters + semantic overlay
  → Metadata-first retrieval

Code
  → AST-based chunking + code graph
  → Language-specific parsers

Mixed (support — articles + account data + playbooks)
  → Multi-source retrieval with different strategies per source
  → Combine API lookups with vector search
```

**Question 4: Who is the user and what's the cost of a wrong answer?**

```
Internal employees (enterprise KB, code search)
  → They can verify and provide feedback
  → Focus on coverage and speed
  → Wrong answer = wasted time

External customers (support bot, e-commerce)
  → They trust the system implicitly
  → Focus on accuracy and safety
  → Wrong answer = lost trust/revenue

Regulated professionals (legal, medical)
  → They need audit trails
  → Focus on citations and verifiability
  → Wrong answer = liability
```

### The Architecture Selection Flowchart

```
                    What are you building?
                          │
          ┌───────────────┼───────────────┐
          ↓               ↓               ↓
     Internal tool   Customer-facing   Regulated domain
          │               │               │
          ↓               ↓               ↓
    ┌───────────┐   ┌───────────┐   ┌───────────┐
    │Must it act │   │ Is latency│   │ Must every │
    │(not just   │   │ critical  │   │ claim be   │
    │ answer)?   │   │ (<200ms)? │   │ cited?     │
    └─┬───────┬─┘   └─┬──────┬─┘   └───────────┘
      │       │        │      │          │
     Yes      No      Yes     No        Yes (always)
      │       │        │      │          │
      ↓       ↓        ↓      ↓          ↓
   Ch 27    Ch 26    Ch 30  Ch 27      Ch 28
  Support  Enterprise E-Com  Support   Legal
    Bot       KB    Search    Bot     Research
              │
         Is it code?
         Yes → Ch 29
```

*What question does this flowchart answer? "Given my use case, which RAG architecture pattern should I start with?"*

### Final Thought

No real-world RAG system fits neatly into one of these five designs. Most production systems are hybrids. A customer support bot might use code RAG to search a technical knowledge base. An enterprise KB might serve e-commerce employees who need product search alongside internal docs. A legal research tool might integrate an enterprise KB for internal firm knowledge alongside external case law.

The value of these five designs isn't that they're templates to copy — it's that they represent five sets of *trade-offs*. Every RAG system you build will make choices about chunking, retrieval, ranking, latency, safety, and evaluation. These five designs show you the range of choices available and the reasoning behind each one.

Start with the design closest to your use case. Steal the patterns that fit. Adapt the trade-offs to your domain. And always — always — measure whether it's working. Because as we learned in [Chapter 15](part-4-evaluation-production.md#chapter-15-rag-evaluation-metrics): vibes don't scale.

---

*This concludes the RAG book. You now have the complete toolkit — from the foundations of why RAG exists, through the retrieval and generation stack, evaluation and production operations, advanced patterns for hard problems, and five real-world designs showing how it all fits together. Build something.*
