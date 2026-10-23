# Part 3: Generation & Orchestration — "Getting Good Answers"

> **What this part covers**: How to write prompts that make LLMs use your retrieved context, rerank results to surface the best ones, rewrite vague queries, manage limited context windows, and handle multi-turn conversations.
>
> **Prerequisites**: [Part 2: The Retrieval Stack](part-2-retrieval-stack.md) — you should understand chunking, embeddings, and hybrid search.
>
> **After this part, you'll be able to**: Turn raw retrieval results into accurate, cited answers. Handle vague questions, multi-turn conversations, and context window limits.

---

## Chapter 10: Prompt Engineering for RAG

**One-liner**: The prompt is the contract between you and the LLM — it tells the model *how* to use retrieved context, when to admit ignorance, and how to cite sources.

**Why you should care**: You retrieved the perfect chunks. They contain the exact answer. You pass them to the LLM and... it ignores them. It answers from its own training data. Or worse, it blends your retrieved context with hallucinated details, creating an answer that's 80% right and 20% dangerously wrong. The problem isn't retrieval. The problem is your prompt.

**Prerequisites**: [Chapter 3: The RAG Pipeline](part-1-foundations.md#chapter-3-the-rag-pipeline-birds-eye-view), [Chapter 9: Hybrid Search](#chapter-9-hybrid-search--best-of-both-worlds)

### The Simple Version

Imagine you hand a research assistant five pages of notes and ask them to answer a question. If you just say "Answer this question" and hand them the notes, they might glance at them and answer from memory. But if you say: "Answer *only* from these notes. If the notes don't contain the answer, say 'I don't know.' Quote the specific note you used." — now they're forced to actually use your material.

That's the difference between a lazy prompt and a RAG prompt.

### How It Actually Works

A production RAG prompt has four sections:

```
┌─────────────────────────────────────────────────┐
│ SYSTEM INSTRUCTIONS                              │
│ "You are a helpful assistant. Answer questions   │
│  using ONLY the provided context. If the context │
│  doesn't contain the answer, say 'I don't have  │
│  enough information to answer that.'"            │
├─────────────────────────────────────────────────┤
│ CONTEXT (retrieved chunks)                       │
│ [Source: Engineering Runbook, Section 3.2]       │
│ "On-call rotation runs Monday to Monday.         │
│  Engineers rotate alphabetically..."             │
│                                                  │
│ [Source: HR Policy v4.1, Page 12]                │
│ "On-call compensation: $500/week flat rate       │
│  plus $50 per incident after hours..."           │
├─────────────────────────────────────────────────┤
│ USER QUESTION                                    │
│ "How does our on-call rotation work and          │
│  what's the compensation?"                       │
├─────────────────────────────────────────────────┤
│ OUTPUT FORMAT INSTRUCTIONS                       │
│ "Provide a concise answer. Cite sources using    │
│  [Source: title] format. If multiple sources     │
│  are relevant, cite each one."                   │
└─────────────────────────────────────────────────┘
```

*What question does this diagram answer? "What goes into a RAG prompt and in what order?"*

**The four critical prompt rules:**

1. **Ground the model** — "Answer ONLY from the provided context." Without this, the LLM mixes retrieved context with training data. This is the single most important instruction.

2. **Handle the "I don't know" case** — "If the context doesn't contain the answer, say so." Without this, the model hallucinates rather than admitting ignorance. Many teams add: "Never make up information not present in the context."

3. **Require citations** — "Cite the source document for each claim." This makes hallucination auditable. If the LLM cites a source for a made-up fact, you can catch it in evaluation.

4. **Control output format** — Specify structure, length, and tone. "Answer in 2-3 sentences" prevents rambling. "Use bullet points for lists" improves readability.

### The "Lost in the Middle" Problem

Research by Liu et al. (2023) showed that LLMs use information at the **beginning** and **end** of the context window much more effectively than information in the **middle**.

```
Accuracy of using information by position:

Position:    |  Start  |  Middle  |   End   |
Accuracy:    |  ~85%   |  ~55%    |  ~80%   |

  ████████      ██████       ████████
  ████████      ██████       ████████
  ████████      ██████       ████████
  ████████                   ████████
  ████████                   ████████
```

*What question does this diagram answer? "Where in the context window should I put the most important chunks?"*

**Practical fix**: Place the most relevant chunk *first* and the second-most relevant *last*. Put lower-relevance context in the middle.

### Real-World Examples

**Example 1: Anthropic's Claude — System Prompt Grounding**

Anthropic's Claude models respond well to grounding instructions in the system prompt. Teams building on Claude find that explicit instructions like "Base your answer solely on the provided documents. Do not supplement with your own knowledge." reduce hallucination rates by 30-50% compared to naive prompts. Anthropic recommends placing retrieved context inside XML tags (`<context>...</context>`) so the model can clearly distinguish between instructions and source material.

**Example 2: Microsoft's Copilot — Citation-Required Prompts**

Microsoft's Copilot (used in Bing, Office 365, and GitHub) enforces citation in its RAG prompts. Every factual claim must be attributed to a retrieved source with a numbered reference. If the system can't cite a source for a claim, it either omits the claim or flags it as uncertain. This approach reduced user-reported factual errors by over 40% compared to their initial prompt without citation requirements. The citations also serve as a quality signal: if the LLM cites source [3] but the claim doesn't appear in source [3], that's a detectable hallucination.

### When To Use / When NOT To Use

| Prompt Technique | Use When | Don't Use When |
|---|---|---|
| Strict grounding ("ONLY from context") | High-stakes answers (legal, medical, financial) | Creative tasks, brainstorming |
| "I don't know" fallback | User-facing products where wrong > silent | Internal tools where any guess is better than nothing |
| Citation requirements | Users need to verify answers, audit trails | Quick internal lookups where speed matters most |
| XML/structured context tags | Using Claude or models that support structured input | Simple prompts with a single short context chunk |

### Q&A

**Q: My LLM keeps ignoring the context and answering from its training data. What am I doing wrong?**
A: Three common causes: (1) Your grounding instruction is too weak — change "Use the following context" to "Answer ONLY based on the following context. Do not use any other knowledge." (2) The context is too long and the answer is buried in the middle — rerank to put the best chunk first. (3) The model has a strong prior from training data that overrides weak context — try explicitly saying "Even if you know the answer from your training, only use the provided context."

**Q: Should I tell the model what to do when chunks contradict each other?**
A: Yes. Retrieved chunks can contradict when: documents are from different dates (old policy vs. new), different sources disagree, or chunking split a nuanced answer. Add to your prompt: "If sources contradict, note the disagreement and cite both sources. Prefer the most recent source when dates are available." This turns a potential hallucination into transparent handling.

**Q: How many chunks should I include in the prompt?**
A: 3-5 is the sweet spot for most use cases. Research shows diminishing returns after 5 chunks — more context means more noise and higher cost. With a reranker (Chapter 11), you can retrieve 20, rerank to top 5, and include those. If you need more than 5 chunks to answer a question, consider whether the question should be decomposed (Chapter 12) or whether your chunks are too small (Chapter 5).

**Q: Temperature 0 or higher for RAG?**
A: Temperature 0 (or very low, like 0.1) for factual RAG. You want deterministic, grounded answers — not creative variations. Higher temperature increases the chance of the model "improvising" beyond the context. The exception: if your RAG system generates creative content *informed by* context (e.g., "write a blog post using these research notes"), moderate temperature (0.5-0.7) is appropriate.

**Q: Does prompt engineering matter less with better models?**
A: Less, but it still matters. GPT-4 and Claude 3.5 are better at following grounding instructions than GPT-3.5. But even the best models hallucinate without explicit grounding, and no model reliably says "I don't know" unless instructed to. Think of prompt engineering as a seatbelt — better cars still need them.

---

## Chapter 11: Reranking — Sorting the Wheat from the Chaff

**One-liner**: A reranker takes your retrieval results and re-scores them with a more powerful model, pushing the most relevant chunks to the top.

**Why you should care**: Your hybrid search returns 20 results. Result #1 is a decent match. But result #7 is *exactly* what the user needs — the perfect paragraph that directly answers their question. Your LLM only sees the top 5 results (context window budget). Without a reranker, the best answer never reaches the LLM.

**Prerequisites**: [Chapter 9: Hybrid Search](part-2-retrieval-stack.md#chapter-9-hybrid-search--best-of-both-worlds)

### The Simple Version

Imagine you're hiring. The first screening (retrieval) narrows 10,000 resumes to 50 candidates who roughly match. But "roughly match" means some are mediocre and some are perfect — they're not in the right order. So you bring in a senior interviewer (the reranker) who spends 5 minutes with each of the 50 candidates and ranks them properly. Now your top 5 are the *actually* best candidates.

The initial screen is fast but rough. The interview is slow but accurate. You need both.

### How It Actually Works

**Retrieval** (bi-encoder) — Embeds query and documents *separately*, then compares. Fast because document embeddings are precomputed.

**Reranking** (cross-encoder) — Processes query and document *together* as one input. Slow but much more accurate because it sees the interaction between query words and document words.

```
Bi-encoder (retrieval):          Cross-encoder (reranking):
                                 
Query  → [Encoder] → vec_q      Query + Doc → [Encoder] → Score
Doc    → [Encoder] → vec_d      
                                 The cross-encoder sees BOTH at
cosine(vec_q, vec_d) = 0.82     once, like reading the question
                                 and answer side by side.
Fast: encode once, compare many  
Accuracy: Good                   Slow: must process each pair
                                 Accuracy: Excellent
```

*What question does this diagram answer? "Why is reranking more accurate than retrieval, and why is it slower?"*

**The reranking pipeline:**

```
Query: "How do I handle webhook retries?"
         ↓
Hybrid search retrieves top 20 candidates
         ↓
Cross-encoder scores each (query, candidate) pair:
  Doc A: "Webhook retry configuration..."         → 0.94 ★
  Doc B: "Setting up webhooks..."                  → 0.71
  Doc C: "Retry logic and exponential backoff..."  → 0.89 ★
  Doc D: "Webhook security best practices..."      → 0.45
  ...
         ↓
Reranked top 5 sent to LLM
```

**Popular reranking models:**

| Model | Speed | Quality | Cost |
|---|---|---|---|
| Cohere Rerank v3.5 | Fast (API) | Excellent | ~$2/1000 queries |
| Jina Reranker v2 | Fast (API) | Very good | ~$1/1000 queries |
| BGE Reranker (open-source) | Self-hosted | Good | Free (GPU needed) |
| ColBERT v2 (late interaction) | Medium | Very good | Free (GPU needed) |
| LLM-as-reranker (GPT-4, etc.) | Slow | Excellent | Expensive |

### Real-World Examples

**Example 1: Cohere's Rerank in Production**

Cohere reports that adding their Rerank model to RAG pipelines improves answer quality by 15-30% across their customer base. One enterprise customer, a large financial services firm, saw their RAG system's top-1 retrieval accuracy jump from 67% to 84% after adding Cohere Rerank — meaning the most relevant document moved from being scattered across the top 20 to consistently being #1. The reranking step added only 100-200ms of latency. For a system where the LLM generation takes 1-2 seconds anyway, that's a negligible cost for a major quality improvement.

**Example 2: You.com Search**

You.com, an AI search engine, uses a multi-stage retrieval pipeline: first BM25 and dense retrieval, then a cross-encoder reranker, then an LLM for answer generation. Their public benchmarks show reranking improves NDCG@10 (a standard search quality metric) by 20%+ over retrieval alone. The key insight from their engineering blog: without a reranker, you need to retrieve more candidates (top-50) and include more in the LLM context to compensate — which costs more in LLM tokens than the reranker itself.

### When To Use / When NOT To Use

| Use Reranking When | Skip It When |
|---|---|
| Answer quality is critical (production, user-facing) | Prototyping or internal tools where "good enough" suffices |
| Top-1 retrieval accuracy matters (users see first result) | Your retrieval already hits 90%+ accuracy |
| You can tolerate 100-300ms added latency | Ultra-low latency requirements (<200ms total) |
| Budget allows ~$1-2 per 1000 queries | Cost is extremely constrained |

### Q&A

**Q: If cross-encoders are better, why not use them for retrieval too?**
A: Speed. A cross-encoder must process each (query, document) pair together. For 1 million documents, that's 1 million forward passes per query — minutes, not milliseconds. The bi-encoder trick of precomputing document embeddings makes retrieval feasible at scale. Reranking works because it only scores 20-50 candidates, not millions.

**Q: How many candidates should I retrieve before reranking?**
A: Retrieve 20-50, rerank to top 3-5. Retrieving fewer risks missing the best result. Retrieving more than 50 has diminishing returns (the best result is rarely ranked #51). The exact number depends on your retrieval quality — if your retrieval is already good, 20 is fine. If it's noisy, go to 50.

**Q: Can I use an LLM as a reranker instead of a specialized model?**
A: Yes — prompt an LLM with "Given this query and these 10 documents, rank them by relevance." This often outperforms specialized cross-encoders because LLMs understand nuance better. The downsides: 5-10x slower, 10-50x more expensive, and you're using LLM tokens for reranking instead of generation. Use it when quality is paramount and latency/cost are secondary.

**Q: Reranking adds latency. How do I keep my system fast?**
A: Three strategies: (1) Rerank fewer candidates (top 10 instead of top 50). (2) Use a fast reranker (Cohere Rerank adds ~100ms; an LLM-as-reranker adds 1-2s). (3) Parallelize retrieval and reranking where possible. In most systems, the LLM generation (1-2s) dominates total latency, so 100-200ms for reranking is negligible.

**Q: Does reranking replace hybrid search, or do I need both?**
A: Both. Hybrid search ensures you *retrieve* the right candidates (casting a wide net across keyword and semantic matching). Reranking ensures you *prioritize* the right candidates (sorting the catch). A reranker can't rescue a result that was never retrieved. Think: hybrid search improves *recall* (finding relevant documents); reranking improves *precision* (ranking them correctly).

---

## Chapter 12: Query Transformation

**One-liner**: Query transformation rewrites the user's question to make it better for retrieval — expanding vague queries, decomposing complex ones, and adding context from conversation history.

**Why you should care**: A user asks your internal chatbot: "What about that thing from the last meeting?" Your retriever has no idea what "that thing" or "the last meeting" refers to. It retrieves random meeting notes. The answer is useless. But if you first rewrite the query to "What were the action items from the Q3 planning meeting on September 15?", retrieval finds exactly the right document. Same user intent, dramatically better retrieval.

**Prerequisites**: [Chapter 10: Prompt Engineering for RAG](#chapter-10-prompt-engineering-for-rag)

### The Simple Version

Imagine you're a reference librarian. Someone walks in and says "I need that book about the thing." You don't search the catalog for "that book about the thing." You ask clarifying questions: "What topic? When did you see it? Was it about science or history?" Then you search for the *refined* query.

Query transformation is an automated librarian that rewrites bad queries before they hit the retriever.

### How It Actually Works

Four main transformation techniques:

**1. Query Rewriting (HyDE — Hypothetical Document Embedding)**

Instead of embedding the question directly, generate a hypothetical answer, then embed *that*. The hypothetical answer is closer in style and vocabulary to your actual documents.

```
Original query:  "Why is my app slow?"
                      ↓
LLM generates hypothetical answer:
  "Application slowness is commonly caused by database
   query N+1 problems, missing indexes, unoptimized API
   calls, and memory leaks in the connection pool..."
                      ↓
Embed the hypothetical answer → search for similar chunks
```

This works because the hypothetical answer uses the same *vocabulary* your documents use (technical terms, jargon), making embedding-based retrieval more effective.

**2. Query Decomposition (Sub-Questions)**

Break a complex question into simpler sub-questions, retrieve for each, then synthesize.

```
Original: "Compare our Q3 revenue in EU vs US and explain the difference"
                      ↓
Sub-question 1: "What was Q3 revenue in the EU?"
Sub-question 2: "What was Q3 revenue in the US?"
Sub-question 3: "What factors affected EU vs US revenue in Q3?"
                      ↓
Retrieve for each → Combine results → LLM synthesizes final answer
```

**3. Query Expansion (Multi-Query)**

Generate multiple phrasings of the same question, retrieve for each, then merge results.

```
Original: "How do I fix a memory leak?"
                      ↓
Variant 1: "How do I fix a memory leak?"
Variant 2: "memory leak debugging techniques"
Variant 3: "heap memory growing indefinitely troubleshooting"
Variant 4: "out of memory error resolution"
                      ↓
Retrieve for all four → Merge with RRF → Deduplicate
```

**4. Step-Back Prompting**

For questions that are too specific, "step back" to a broader question first.

```
Original: "Why does Python 3.11 raise TypeError when I use match-case with dataclasses?"
                      ↓
Step-back: "How does Python structural pattern matching work with dataclasses?"
                      ↓
Retrieve the broader conceptual document, then use it alongside the specific query.
```

*What question does this diagram answer? "What are the four ways to rewrite a query, and when does each help?"*

### Real-World Examples

**Example 1: Google's Gemini Search — Multi-Query**

When Google's AI search features process ambiguous queries, they generate multiple interpretations. A search for "apple" might generate queries for both "Apple Inc technology company" and "apple fruit nutrition." This multi-query approach ensures retrieval covers multiple possible intents. Google reports that multi-query retrieval surfaces 30% more relevant results for ambiguous queries compared to single-query retrieval.

**Example 2: LangChain's Multi-Query Retriever**

LangChain's open-source framework includes a MultiQueryRetriever that generates 3-5 alternative phrasings of any user query using an LLM, retrieves for each, and deduplicates the results. In their benchmarks on multi-domain knowledge bases, this approach improved recall by 15-25% over single-query retrieval. The latency cost is the LLM call to generate alternatives (~200-500ms) plus parallel retrieval calls — typically adding 300-700ms total. Worth it for complex queries; overkill for simple lookups.

### When To Use / When NOT To Use

| Technique | Use When | Don't Use When |
|---|---|---|
| HyDE | Documents are in a different style than user queries | Queries already use the same vocabulary as documents |
| Decomposition | Questions require info from multiple sources | Simple factual questions with one-chunk answers |
| Multi-query | Queries could be interpreted multiple ways | Queries are specific and unambiguous |
| Step-back | Overly specific queries fail retrieval | Queries are already at the right abstraction level |

### Q&A

**Q: Doesn't query rewriting add latency from the extra LLM call?**
A: Yes — typically 200-500ms for query rewriting, plus any additional retrieval calls. For simple factual queries, this overhead isn't worth it. The pattern: detect when a query is likely to fail (vague, complex, conversational) and only apply transformation then. A simple heuristic: if the query is under 5 words or contains pronouns ("it," "that," "they"), transform it. Otherwise, search directly.

**Q: How do I know which transformation technique to use?**
A: Match the technique to the failure mode. If your retriever returns *irrelevant* results → try HyDE (the vocabulary gap is the problem). If it returns *partial* results → try decomposition (the question needs multiple pieces). If it returns *nothing* → try multi-query (your single phrasing doesn't match anything). If it returns *too broad* results → try step-back (zoom out, then zoom in).

**Q: Can I chain multiple transformations?**
A: Yes, but be careful with latency. A common production chain: (1) resolve pronouns from conversation history, then (2) apply HyDE or multi-query. Each step adds 200-500ms. More than two transformations usually means diminishing returns and 1+ seconds of added latency. Start with one technique, measure, then add another only if the first didn't solve the problem.

**Q: For conversational RAG, do I always need to rewrite the follow-up query?**
A: Yes. "What about the pricing?" means nothing without conversation history. The standard approach: use the LLM to rewrite the follow-up into a standalone query. Input: conversation history + follow-up. Output: self-contained query. "What about the pricing?" → "What is the pricing for the Enterprise plan discussed in the previous messages?" This is covered in detail in Chapter 14.

**Q: HyDE generates a hypothetical answer — what if that answer is wrong?**
A: It doesn't matter! You're not using the hypothetical answer as the final answer — you're using it as a *search query*. Even a partially wrong hypothetical answer uses the right vocabulary and concepts, making it a better embedding for retrieval than the original short question. The real documents found by retrieval still provide the actual answer.

---

## Chapter 13: Context Window Management

**One-liner**: Context window management is the art of fitting the most useful information into a limited prompt — because what you include (and exclude) determines the answer quality.

**Why you should care**: Your retriever returns 15 relevant chunks, totaling 8,000 tokens. Your prompt template and system instructions use 500 tokens. You want to reserve 500 tokens for the LLM's answer. Your context window budget is 4,000 tokens. You can fit maybe 3,000 tokens of context — about 6 of your 15 chunks. *Which 6 do you pick, and in what order?*

**Prerequisites**: [Chapter 10: Prompt Engineering for RAG](#chapter-10-prompt-engineering-for-rag), [Chapter 11: Reranking](#chapter-11-reranking--sorting-the-wheat-from-the-chaff)

### The Simple Version

Imagine you're writing a one-page briefing for your CEO before a meeting. You have 50 pages of notes. You can't include everything — the CEO will only read one page. You have to:

1. **Select** — Pick the 5 most important points from 50 pages
2. **Order** — Put the most critical point first, second-most-critical last (she reads the start and end carefully, skims the middle)
3. **Compress** — Summarize long passages into key sentences
4. **Budget** — Leave room for her to write notes in the margin

Same problem, same solutions.

### How It Actually Works

**Step 1: Token Budgeting**

```
Total context window:              8,000 tokens (example)
─ System prompt:                   - 300 tokens
─ Conversation history (if any):   - 500 tokens
─ Query:                           - 50 tokens
─ Reserved for generation:         - 1,000 tokens
─ Safety margin:                   - 150 tokens
═══════════════════════════════════════════════
Available for retrieved context:   6,000 tokens
```

**Step 2: Chunk Selection**

After reranking, you have chunks ordered by relevance. Fill the budget greedily:

| Chunk | Tokens | Cumulative | Include? |
|---|---|---|---|
| Chunk A (rank 1) | 450 | 450 | Yes |
| Chunk B (rank 2) | 380 | 830 | Yes |
| Chunk C (rank 3) | 1,200 | 2,030 | Yes |
| Chunk D (rank 4) | 600 | 2,630 | Yes |
| Chunk E (rank 5) | 520 | 3,150 | Yes |
| Chunk F (rank 6) | 480 | 3,630 | Yes |
| Chunk G (rank 7) | 900 | 4,530 | Yes |
| Chunk H (rank 8) | 800 | 5,330 | Yes |
| Chunk I (rank 9) | 750 | 6,080 | Barely — yes |
| Chunk J (rank 10) | 600 | 6,680 | No — over budget |

**Step 3: Chunk Ordering (Lost-in-the-Middle Mitigation)**

Place chunks for maximum attention:

```
Position 1 (high attention): Chunk A (most relevant)
Position 2:                  Chunk D
Position 3:                  Chunk F
Position 4 (low attention):  Chunk G   ← Middle = least attended
Position 5 (low attention):  Chunk H   ← Middle
Position 6:                  Chunk E
Position 7:                  Chunk C
Position 8:                  Chunk I
Position 9 (high attention): Chunk B (second most relevant)
```

*What question does this diagram answer? "In what order should I arrange retrieved chunks in the prompt?"*

### Advanced Strategies

**Context Compression**: When chunks are long, use an LLM to summarize them before including them:

```
Original chunk (450 tokens):
  "The authentication system uses OAuth 2.0 with PKCE flow.
   When a user initiates login, the client generates a code
   verifier and code challenge. The authorization server
   validates the challenge during token exchange. This prevents
   authorization code interception attacks. The implementation
   follows RFC 7636 specifications. Note: legacy clients still
   use the implicit flow, which is being deprecated..."

Compressed (120 tokens):
  "Auth uses OAuth 2.0 + PKCE (RFC 7636). Client generates
   code verifier/challenge; server validates during token
   exchange to prevent code interception. Legacy implicit
   flow is being deprecated."
```

Trade-off: compression adds an LLM call (~200ms, ~$0.001) but frees 300 tokens for another chunk.

**Deduplication**: If multiple retrieved chunks contain overlapping information (common when chunks have overlap windows), deduplicate before including. Simple method: if two chunks have >70% text overlap, keep only the higher-ranked one.

### Real-World Examples

**Example 1: Anthropic's Claude — 200K Context, Used Wisely**

Anthropic's Claude offers 200K token context windows, but Anthropic's own RAG guidance doesn't suggest filling it all. Their internal testing shows that 5-10 well-selected chunks (2,000-5,000 tokens of context) consistently outperform 50 mediocre chunks (25,000 tokens) for factual Q&A. The reason: more irrelevant context = more noise for the model to sift through = more chances to latch onto wrong information. Their recommendation: use the large window for *high-quality* context, not *all* context.

**Example 2: Cursor (AI Code Editor)**

Cursor, the AI-powered code editor, faces an extreme context window challenge: codebases have millions of lines but the model sees thousands. Their approach: retrieve code snippets relevant to the current edit, the file being edited, recently opened files, and relevant type definitions — all within a strict token budget. They dynamically adjust how many tokens each category gets based on the task. A "write a function" task gets more retrieval budget; a "fix this typo" task uses almost none. This dynamic budgeting keeps responses fast and relevant.

### When To Use / When NOT To Use

| Strategy | Use When | Don't Use When |
|---|---|---|
| Token budgeting | Always — this is mandatory for production RAG | Never skip this |
| Lost-in-the-middle reordering | Context has 5+ chunks | Only 1-2 chunks (ordering doesn't matter) |
| Context compression | Chunks are long (>300 tokens) and budget is tight | Chunks are already concise |
| Deduplication | Chunks have overlap or come from similar sections | Chunks are from diverse sources |

### Q&A

**Q: If I have a 200K token window, why not just include everything?**
A: Three reasons. (1) **Cost** — more tokens = more money per query. At $3/million input tokens, 200K tokens per query costs $0.60. At 10,000 queries/day, that's $6,000/day vs. $300/day with 10K tokens. (2) **Quality** — "lost in the middle" means the model misses information in large contexts. (3) **Latency** — more input tokens = slower time-to-first-token. 200K tokens adds seconds of processing time.

**Q: How do I decide the right number of chunks to include?**
A: Start with 5 and measure. If answer quality improves with 7, use 7. If quality is the same at 3 as at 5, use 3 (save cost). The optimum depends on your chunk size, query complexity, and model. For simple factual Q&A, 3-5 chunks. For synthesis across documents, 7-10. For complex analysis, 10-15. Always measure with your evaluation set (Chapter 15).

**Q: Can I use a smaller, cheaper model to compress chunks before sending to a larger model?**
A: Yes — this is called the "summarize-then-read" pattern. Use a fast model (GPT-4o mini, Haiku) to compress 10 chunks into summaries, then feed the summaries to a stronger model (GPT-4, Opus) for the final answer. This reduces token costs by 50-70% for the expensive model. The trade-off: two LLM calls instead of one, and compression might lose important details.

**Q: Should I include metadata (source title, date, section) with each chunk in the prompt?**
A: Yes — it helps the LLM cite sources correctly and resolve ambiguity ("HR Policy v4.1, updated January 2025" vs. "HR Policy v3.0, updated June 2023"). Each metadata header costs ~20-30 tokens. Worth it. Some teams also include a relevance score to help the model weight chunks: "[Relevance: High] Source: Engineering Runbook..."

**Q: What if my most relevant chunk alone is 4,000 tokens — larger than my entire context budget?**
A: Three options: (1) Use a model with a larger context window. (2) Compress the chunk using summarization. (3) Extract only the relevant sub-section (if you can identify it with a sentence-level reranker). Option 3 is most elegant — a sentence-level reranker or a "highlight the relevant passage" LLM call can pinpoint the 500 tokens that actually matter within the 4,000.

---

## Chapter 14: Conversational RAG & Memory

**One-liner**: Conversational RAG lets users ask follow-up questions — "What about the pricing?" — by resolving references and maintaining context across turns.

**Why you should care**: Your RAG chatbot answers the first question perfectly. The user says "Great, and how much does it cost?" Your system has no idea what "it" refers to. It retrieves random pricing pages. The user gets frustrated, restates their entire question, and wonders why they're talking to a chatbot that has the memory of a goldfish.

**Prerequisites**: [Chapter 10: Prompt Engineering for RAG](#chapter-10-prompt-engineering-for-rag), [Chapter 12: Query Transformation](#chapter-12-query-transformation)

### The Simple Version

Imagine you're at a help desk. You ask about a product. The agent explains it. You ask "How much is it?" The agent knows "it" = the product you just discussed. They don't say "How much is *what*?"

But RAG systems are stateless by default — each query is independent. Conversational RAG adds memory: it tracks the conversation so that "it," "that," "the same one," and "what about pricing?" all resolve to the right thing.

### How It Actually Works

The core technique is **query contextualization** — rewriting each follow-up query into a standalone query using the conversation history.

```
Conversation:
  User: "What deployment options does your platform support?"
  Bot:  "We support AWS, GCP, Azure, and on-premise deployment..."
  User: "What about the pricing for the cloud options?"
                ↓
Contextualization (LLM call):
  Input: conversation history + "What about the pricing for the cloud options?"
  Output: "What is the pricing for AWS, GCP, and Azure deployment options?"
                ↓
Retriever searches for: "pricing for AWS, GCP, and Azure deployment options"
(not "What about the pricing for the cloud options?" — which would retrieve garbage)
```

*What question does this diagram answer? "How does the system know what 'the cloud options' refers to?"*

**Three levels of conversational memory:**

| Level | What It Tracks | How | Use When |
|---|---|---|---|
| **Chat history** | Last N messages (verbatim) | Include in prompt as context | Short conversations (<10 turns) |
| **Summarized history** | LLM-compressed summary of conversation | Summarize every 5-10 turns | Long conversations (10-50 turns) |
| **Session memory** | Key facts extracted from conversation | Extract entities and facts per turn | Very long conversations, agent-style |

### Real-World Examples

**Example 1: ChatGPT — Conversation Memory at Scale**

OpenAI's ChatGPT maintains conversation context across turns for 100+ million users. Each turn includes recent conversation history in the prompt. For long conversations, they use a sliding window (last N messages) plus a running summary. When a user says "make it shorter" after a long explanation, the model knows exactly what "it" refers to. This conversational coherence is the primary reason users prefer ChatGPT over single-turn Q&A tools.

**Example 2: Intercom's Fin AI — Support Conversations**

Intercom's Fin AI handles customer support conversations that routinely go 5-15 turns. A customer might say: "My order hasn't arrived" → (bot asks for order number) → "It's #12345" → "Actually, can you also check #12346?" The system must track both order numbers across turns. Fin uses conversation-aware RAG: each turn rewrites the query with full context (both order numbers, the shipping issue) before retrieving from the knowledge base. Intercom reports Fin resolves 50%+ of conversations without human intervention, and conversational context is critical — without it, resolution drops to under 20%.

### When To Use / When NOT To Use

| Use Conversational RAG When | Skip It When |
|---|---|
| Users interact in multi-turn dialogues | Single-question search interface |
| Follow-up questions are expected ("and what about...?") | Each query is independent |
| Users refer to previous context (pronouns, "that one") | Queries are always self-contained |
| Support, research, or exploratory use cases | Quick lookup tools |

### Q&A

**Q: Can't I just concatenate the entire conversation history into the prompt?**
A: For short conversations (3-5 turns), yes. For longer ones, you'll hit context limits and pay for thousands of tokens of history per query. The standard approach: keep the last 3-5 turns verbatim, summarize earlier turns, and always rewrite the current query into a standalone form for retrieval. The retrieval query should never contain pronouns or references to "the above."

**Q: How do I handle "Actually, I meant the other one" — corrections mid-conversation?**
A: Treat corrections as new context that overrides previous context. Your query rewriting step should produce: "User initially asked about Product A, then corrected to Product B. Current question is about Product B's pricing." The key: the rewriting LLM needs to understand conversational pragmatics — corrections, clarifications, and topic shifts.

**Q: How much does conversation history cost per query?**
A: Each turn of conversation adds ~100-300 tokens to every subsequent query. A 10-turn conversation means 1,000-3,000 extra tokens per query. At $3/million tokens, that's $0.003-$0.009 per query just for history. Summarization cuts this by 60-80% but adds an LLM call. The break-even depends on your conversation length distribution — if most conversations are under 5 turns, skip summarization.

**Q: Should the conversation history also be used for retrieval, not just query rewriting?**
A: Smart approach. Some systems embed the *entire conversation so far* and retrieve based on that, not just the latest query. This catches cases where the context from turn 2 is needed to answer the question at turn 5. The trade-off: broader retrieval = more noise. A balanced approach: rewrite the query using history (for precision), but also include 1-2 history-based retrieval results (for coverage).

**Q: What about users who completely change topics mid-conversation?**
A: Topic detection is the key. If the query rewriting step produces a standalone query that has nothing to do with recent history, it's a topic change. In that case, don't include irrelevant history context. Some systems explicitly detect topic shifts: if the new query's embedding is below 0.3 cosine similarity to the conversation summary, treat it as a new conversation.

---

## Putting It Together: Customer Support Chatbot

Let's combine everything from Part 3 into a real system.

### The Scenario

You're building a customer support chatbot for a B2B SaaS company. The knowledge base has 2,000 articles: product documentation, troubleshooting guides, billing FAQs, and API references. Users ask in natural language, often in multi-turn conversations. The chatbot must cite sources and say "I don't know" when appropriate.

### The Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                USER SENDS MESSAGE                                │
│  "What about the pricing for the enterprise plan?"              │
│   (follow-up to previous question about plans)                   │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│  1. QUERY CONTEXTUALIZATION (LLM call ~200ms)                    │
│     Input: conversation history + "What about the pricing..."   │
│     Output: "What is the pricing for the Enterprise plan?"      │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│  2. HYBRID RETRIEVAL (from Part 2)                               │
│     BM25 search → top 20                                        │
│     Vector search → top 20                                      │
│     RRF fusion → top 20 candidates                              │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│  3. RERANKING (~150ms)                                           │
│     Cross-encoder scores all 20 candidates                      │
│     Select top 5 by relevance                                   │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│  4. CONTEXT WINDOW ASSEMBLY                                      │
│     Token budget: 4,000 tokens for context                      │
│     Include top 5 chunks, most relevant first and last          │
│     Add metadata (source, date) per chunk                       │
│     Include last 3 conversation turns                           │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│  5. GENERATION (LLM call ~1-2s)                                  │
│     System: "Answer ONLY from context. Cite sources. Say        │
│             'I don't have that information' if not in context."  │
│     Context: [5 chunks with metadata]                           │
│     History: [last 3 turns]                                     │
│     Query: "What is the pricing for the Enterprise plan?"       │
│                                                                  │
│     → "The Enterprise plan starts at $499/month for up to       │
│        50 users, with volume discounts available for annual      │
│        billing. [Source: Pricing Guide v2.3, Section: Enterprise]│
│        For custom pricing above 500 users, contact our sales    │
│        team. [Source: Enterprise FAQ, Updated: Oct 2025]"       │
└─────────────────────────────────────────────────────────────────┘
```

### Test Results Against 50 Support Tickets

| Metric | Without Part 3 Techniques | With Part 3 Techniques |
|---|---|---|
| Answer accuracy | 64% | 87% |
| Correct "I don't know" | 31% | 78% |
| Source citation accuracy | 52% | 91% |
| Follow-up handling | 23% | 82% |
| Average latency | 1.8s | 2.5s |

The 700ms latency increase (from reranking + query rewriting) is worth the 23-point accuracy improvement. Users don't notice 2.5s vs 1.8s, but they absolutely notice wrong answers.

### Key Takeaway

Part 2 got the right documents into the pipeline. Part 3 ensures they become the right *answers*. The pattern is: rewrite the query → retrieve broadly → rerank precisely → assemble carefully → generate with guardrails. Each step adds a small latency cost but a significant quality gain. In Part 4, we'll learn how to *measure* whether all this is actually working — because without evaluation, you're flying blind.
