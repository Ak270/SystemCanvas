# Part 1: Foundations — "Why Does RAG Exist?"

> **What this part covers**: Why LLMs alone aren't enough, what happens inside them (just enough to understand RAG), the complete RAG pipeline, and when to use RAG vs. the alternatives.
>
> **Prerequisites**: None. This is where we start.
>
> **After this part, you'll be able to**: Explain RAG to a colleague, sketch the pipeline on a whiteboard, and know when RAG is the right tool — and when it isn't.

---

## Chapter 1: The Problem RAG Solves

**One-liner**: RAG lets an AI answer questions using *your* data instead of making things up.

**Why you should care**: Your company just deployed a chatbot for internal HR questions. An employee asks "What's our parental leave policy?" The chatbot confidently responds: "Most companies offer 12 weeks of paid parental leave." That's not *your* policy — your company offers 16 weeks. The chatbot invented a plausible-sounding answer because it has no access to your actual employee handbook. Now multiply that by 500 employees asking questions every day. That's not a chatbot. That's a liability.

**Prerequisites**: None.

### The Simple Version

Imagine you're a brilliant professor who's memorized thousands of textbooks. Someone asks you a question about a company's specific internal policy. You've never seen that policy document. What do you do? You guess — confidently — based on what you know about policies in general.

Now imagine someone hands you the actual policy document before you answer. You read the relevant page, then answer. *That's* RAG.

RAG is the difference between "guess from memory" and "look it up, then answer."

### How It Actually Works

Large Language Models (LLMs) like ChatGPT are trained on massive public datasets. They learn patterns, facts, and language — but they have two critical limits:

1. **Knowledge cutoff** — They don't know anything after their training date
2. **No private data** — They've never seen your company's documents, your codebase, or your customer data
3. **Hallucination** — When uncertain, they generate plausible-sounding but incorrect answers

RAG fixes this by adding a **retrieval step** before generation:

```
User Question
     ↓
┌─────────────┐
│  RETRIEVE    │ ← Search your documents for relevant passages
└─────┬───────┘
      ↓
┌─────────────┐
│  AUGMENT     │ ← Inject those passages into the LLM's prompt
└─────┬───────┘
      ↓
┌─────────────┐
│  GENERATE    │ ← LLM answers using the retrieved context
└─────────────┘
      ↓
  Answer (grounded in your data)
```

*What question does this diagram answer? "What are the three steps in RAG and how do they connect?"*

The term was coined in a 2020 paper by Lewis et al. at Facebook AI Research. The key insight: instead of cramming all knowledge into model weights (expensive, static), retrieve relevant knowledge at query time (cheap, dynamic).

### Real-World Examples

**Example 1: Notion AI**

Notion has millions of users, each with private workspaces full of notes, docs, and databases. When a user asks Notion AI "What were the action items from last week's team meeting?", it can't rely on a generic LLM — the answer is in *that user's* specific meeting notes. Notion uses RAG to search the user's workspace, retrieve relevant blocks of text, and feed them to the LLM. They use block-level chunking (Notion's data is already structured as blocks) and permission-aware retrieval so users only get answers from documents they have access to.

**Example 2: Klarna's AI Assistant**

Klarna deployed an AI customer service agent that handled 2.3 million conversations in its first month — the equivalent of 700 full-time agents. It resolves questions about orders, refunds, and policies by retrieving from Klarna's actual support documentation and order data. Without RAG, a generic LLM would hallucinate refund policies and order statuses. With RAG, the system grounds every answer in Klarna's real data — and the average resolution time dropped from 11 minutes to under 2 minutes.

### When To Use / When NOT To Use

| Use RAG When | Don't Use RAG When |
|---|---|
| You need answers from private/proprietary data | The LLM's built-in knowledge is sufficient |
| Your data changes frequently | Your data is static and small enough to fine-tune |
| You need citations and source attribution | You need creative generation (stories, brainstorming) |
| You need to control what knowledge the AI accesses | Latency requirements are extremely tight (<100ms) |
| Different users should see different data | Your questions don't need external knowledge |

### Q&A

**Q: Wait — if the LLM is just reading documents I give it, how is that different from Ctrl+F?**
A: Great starting point. Ctrl+F finds exact text matches. RAG understands *meaning*. If your document says "employees receive sixteen weeks of paid family leave" and someone asks "how long is maternity leave?", Ctrl+F finds nothing. RAG understands that "maternity leave" relates to "paid family leave" and retrieves the right passage. Then the LLM synthesizes an answer from potentially dozens of passages, something search alone can't do.

**Q: If we retrieve the right document, why would the LLM still hallucinate?**
A: Because retrieval and generation are two separate steps, and each can fail independently. You might retrieve the right document but the LLM ignores it (especially if the answer is buried in the middle of a long context — the "lost in the middle" problem). Or you might retrieve a *partially* relevant document and the LLM fills in gaps with made-up details. We'll cover both failure modes and their fixes in Part 3 (Reranking) and Part 4 (Evaluation).

**Q: How is RAG different from just Googling something and pasting it into ChatGPT?**
A: Mechanically, it's the same idea — find relevant info, then ask an LLM to use it. RAG automates and optimizes every step: the search is over *your* data (not the public web), it uses semantic similarity (not just keywords), it retrieves precisely the relevant *passages* (not entire web pages), and it formats them into a prompt designed for accurate grounding. You're building what you do manually, but at scale, with quality controls.

**Q: Our legal team is worried about the AI giving wrong answers to customers. Will RAG fix that?**
A: RAG dramatically reduces hallucination by grounding answers in real documents, but it doesn't eliminate it. A Stanford study found that RAG-based legal research tools still hallucinated 17–33% of the time. The fix isn't just "add RAG" — it's RAG plus evaluation, monitoring, citation requirements, confidence thresholds, and human-in-the-loop for high-stakes queries. We cover all of this in Part 4.

**Q: What happens if my RAG system retrieves the wrong document entirely?**
A: Then you get a confidently wrong answer that *looks* grounded. This is arguably worse than a generic hallucination because it has a false citation. This is why retrieval quality is the single most important thing to get right — and why we spend all of Part 2 on it. The short answer: better chunking, better embeddings, hybrid search, and reranking. The long answer is the next 25 chapters.

---

## Chapter 2: How LLMs Actually Work (Just Enough)

**One-liner**: LLMs predict the next word — and that simple trick, at massive scale, produces something that looks like understanding.

**Why you should care**: You can't debug a RAG system if you don't understand *why* the LLM ignores retrieved context, hallucinates details, or suddenly gives great answers when you rearrange the same chunks in a different order. You don't need a PhD — but you need a mental model of what's happening inside.

**Prerequisites**: [Chapter 1: The Problem RAG Solves](#chapter-1-the-problem-rag-solves)

### The Simple Version

Imagine your phone's autocomplete, but trained on the entire internet and a thousand times more sophisticated. You type "The capital of France is..." and it predicts "Paris." That's fundamentally what an LLM does — predict the next word given everything that came before.

But here's what's mind-bending: when you train this simple mechanism on trillions of words, the model develops internal representations that capture meaning, relationships, and reasoning patterns. It doesn't "know" facts the way you do. It has statistical patterns that are so rich they *behave* like knowledge.

### How It Actually Works

An LLM processes text through four key stages:

**1. Tokenization** — Text is split into tokens (roughly word-pieces). "unhappiness" becomes ["un", "happiness"]. A typical model has a vocabulary of 50,000–100,000 tokens.

**2. Embedding** — Each token becomes a vector (a list of numbers) in a high-dimensional space. Similar words end up near each other. "king" and "queen" are close; "king" and "refrigerator" are far apart.

**3. Attention** — The transformer architecture lets every token "look at" every other token in the input to understand context. In "The bank of the river was muddy," attention connects "bank" to "river" to disambiguate from a financial bank. This is the mechanism that lets LLMs understand your prompt and the retrieved context.

**4. Generation** — The model predicts a probability distribution over all possible next tokens and samples from it, one token at a time.

```
Input: "The capital of France is"

Token:    [The] [capital] [of] [France] [is] [???]
                                              ↓
                              Probability distribution:
                              "Paris"  → 0.92
                              "Lyon"   → 0.02
                              "a"      → 0.01
                              ...      → ...
```

*What question does this diagram answer? "How does an LLM decide what word to say next?"*

### Why This Matters for RAG

Understanding how LLMs work reveals three things critical for RAG:

1. **The context window is everything.** The LLM can only "see" what's in its current input (the context window). It has no memory between calls. If the answer to a question isn't in the context window, the model either guesses from its training data or hallucinates. RAG works by putting the answer *into* the context window.

2. **Position matters.** Attention mechanisms don't treat all positions equally. Research shows LLMs are better at using information at the *beginning* and *end* of the context window, and worse at using information in the *middle* (the "lost in the middle" phenomenon). This means the order you place retrieved chunks matters.

3. **Tokens cost money.** Every token in the context window costs compute (and money). If you stuff 50 irrelevant chunks into the prompt, you're paying for tokens that hurt rather than help. Efficient retrieval isn't just about accuracy — it's about cost.

### Real-World Examples

**Example 1: OpenAI's GPT-4**

GPT-4 was trained on roughly 13 trillion tokens at an estimated cost of $100 million+. Despite this massive investment, it doesn't know what happened yesterday, what's in your Confluence wiki, or what your company's refund policy says. Its training data has a cutoff date. This fundamental limitation — you can't retrain a $100M model every time a document changes — is precisely why RAG exists.

**Example 2: Google's Gemini with 1M+ Token Context**

Google's Gemini models support context windows exceeding 1 million tokens — roughly 700,000 words, or about 8 novels. This seems like it should eliminate RAG entirely: just paste all your documents in. But at $1+ per million input tokens, processing a 500-page knowledge base for *every single query* adds up fast. At 10,000 queries per day, that's $10,000/day just in token costs. RAG lets you retrieve only the 3-5 relevant passages, cutting costs by 100x or more.

### When To Use / When NOT To Use

| LLM Concept | RAG Implication |
|---|---|
| Context window has a size limit | You can't feed the LLM your entire knowledge base — you must *select* relevant passages |
| Tokens cost money per call | Retrieving fewer, better chunks = lower cost per query |
| Attention degrades in the middle | Place the most relevant chunks at the start or end of the prompt |
| LLMs generate one token at a time | Long answers are more expensive and slower — keep generated responses concise |

### Q&A

**Q: If LLMs are just predicting the next word, how do they seem to "reason"?**
A: Scale creates emergent behavior. A model trained on billions of math textbook pages develops internal circuits that perform arithmetic — not because it was programmed to, but because predicting the next token in "2+3=" *requires* learning addition. Similarly, patterns in logical text create something that functions like reasoning. It's not human reasoning, but it's useful enough to interpret retrieved documents and synthesize answers.

**Q: Why can't I just retrain the LLM on my company's data instead of using RAG?**
A: Three reasons. Cost: fine-tuning a large model costs thousands to millions of dollars. Staleness: your data changes; you'd need to retrain constantly. Blending: fine-tuning *blends* new knowledge into existing weights, making it hard to cite sources or control access. RAG keeps your data separate from the model — retrievable, updatable, and auditable. We compare these approaches head-to-head in Chapter 4.

**Q: What's the actual size limit of a context window in practice?**
A: In late 2025, frontier models offer 128K to 2M tokens. But "fits in the window" ≠ "works well." Research shows quality degrades well before the limit. Most practitioners find that 4K–16K tokens of well-selected context outperforms 100K tokens of everything-and-the-kitchen-sink. Quality of context beats quantity.

**Q: If attention degrades in the middle, why not just make the context window smaller?**
A: Because some queries genuinely need lots of context — comparing multiple documents, synthesizing information across sources, or answering questions that require several pieces of evidence. The fix isn't a smaller window; it's better *ordering* of chunks within the window and better *selection* of which chunks to include. We'll cover both in Part 3.

**Q: My CEO read that GPT-5 will have infinite context. Does that kill RAG?**
A: We address this honestly in Chapter 24 ("Long Context vs. RAG"). The short version: even with enormous context windows, RAG wins on cost (don't process your entire knowledge base for every query), freshness (update documents without reprocessing), access control (different users see different data), and attribution (know exactly which document produced the answer). Long context changes *when* you need RAG, not *whether* you need it.

---

## Chapter 3: The RAG Pipeline: Bird's-Eye View

**One-liner**: A RAG system has two phases — indexing (prepare your data once) and querying (answer questions many times) — with distinct components in each.

**Why you should care**: You just built your first RAG prototype following a tutorial. It works on 10 documents. Then you try it on your real data — 50,000 PDFs — and everything breaks. Answers are wrong, latency is awful, and costs are through the roof. The problem? You don't understand the pipeline well enough to know *which part* is failing. This chapter gives you the map.

**Prerequisites**: [Chapter 1: The Problem RAG Solves](#chapter-1-the-problem-rag-solves), [Chapter 2: How LLMs Actually Work](#chapter-2-how-llms-actually-work-just-enough)

### The Simple Version

Think of building a RAG system like setting up a library.

**Phase 1 — Stocking the library (done once, updated periodically):**
You receive a truckload of books. You can't just dump them on the floor. You break each book into chapters, write a summary card for each chapter, and file those cards in a catalog. This is *indexing*.

**Phase 2 — Answering a question (done for every query):**
Someone walks in and asks a question. You search the catalog for the most relevant chapter summaries, pull those chapters off the shelf, hand them to an expert, and the expert reads them and gives an answer. This is *querying*.

If your catalog cards are bad (poor chunking), or your filing system is slow (bad index), or your expert ignores the chapters you hand them (bad prompt) — the answer will be wrong.

### How It Actually Works

```
                    INDEXING PIPELINE (offline, run periodically)
                    ============================================

 Raw Documents          Chunking           Embedding          Vector Store
 ┌──────────┐      ┌──────────────┐    ┌─────────────┐    ┌──────────────┐
 │ PDFs     │      │ Split into   │    │ Convert to  │    │ Store chunks │
 │ Docs     │ ──→  │ meaningful   │ ──→│ numerical   │ ──→│ + vectors    │
 │ HTML     │      │ chunks       │    │ vectors     │    │ for search   │
 │ Markdown │      └──────────────┘    └─────────────┘    └──────────────┘
 └──────────┘

                    QUERY PIPELINE (online, per user question)
                    ==========================================

 User Query      Query Processing     Retrieval        Augmentation       Generation
 ┌─────────┐    ┌──────────────┐   ┌───────────┐    ┌─────────────┐   ┌───────────┐
 │ "What's │    │ Embed query  │   │ Find top-K│    │ Build prompt│   │ LLM reads │
 │  our    │ ──→│ (+ rewrite   │──→│ matching  │──→ │ with query +│──→│ context + │
 │  leave  │    │  if needed)  │   │ chunks    │    │ chunks      │   │ generates │
 │  policy?"│    └──────────────┘   └───────────┘    └─────────────┘   └───────────┘
 └─────────┘                                                                │
                                                                            ↓
                                                                     Answer + Citations
```

*What question does this diagram answer? "What are all the steps in a RAG system, from raw documents to final answer?"*

**The Indexing Pipeline (4 components):**

| Component | What It Does | Key Decision | Chapter |
|---|---|---|---|
| **Document Loader** | Reads raw files (PDF, HTML, Markdown, databases) | How to handle tables, images, headers | Ch. 5 |
| **Chunker** | Splits documents into smaller passages | Chunk size, overlap, splitting strategy | Ch. 5 |
| **Embedding Model** | Converts text chunks into numerical vectors | Which model, dimensions, cost | Ch. 6 |
| **Vector Store** | Stores and indexes vectors for fast search | Which database, indexing algorithm | Ch. 7 |

**The Query Pipeline (4 components):**

| Component | What It Does | Key Decision | Chapter |
|---|---|---|---|
| **Query Processor** | Embeds the question (optionally rewrites it) | Whether to use query expansion/rewriting | Ch. 12 |
| **Retriever** | Finds the top-K most similar chunks | K value, similarity metric, hybrid vs. dense | Ch. 8–9 |
| **Reranker** | Re-scores and reorders retrieved chunks | Cross-encoder model, how many to rerank | Ch. 11 |
| **Generator** | LLM produces the answer from query + context | Model choice, prompt template, temperature | Ch. 10 |

### Real-World Examples

**Example 1: Stripe's Documentation Search**

Stripe has thousands of pages of API documentation, integration guides, and support articles. Their RAG pipeline ingests documentation on every deploy (indexing pipeline), chunking by section headers to preserve context. When a developer asks "How do I handle webhook retries?", the query pipeline retrieves relevant sections from the webhooks documentation, and the LLM generates an answer with code examples. The key insight: Stripe chunks by *logical sections* (headers), not fixed character counts — because a code example split in half is useless.

**Example 2: Spotify's AiKA Internal Assistant**

Spotify built AiKA (AI Knowledge Assistant) to help employees search internal documentation. With thousands of engineering docs, runbooks, and postmortems spread across multiple systems, finding information was a constant time sink. AiKA uses RAG to search across these sources and generate answers with links to source documents. Employees went from spending 15+ minutes searching wikis to getting answers in seconds. The pipeline integrates with Spotify's internal search infrastructure and respects document-level access permissions.

### When To Use / When NOT To Use

| Pipeline Component | Common Failure Mode | How You'll Know |
|---|---|---|
| Chunker | Chunks too large (noise) or too small (no context) | Retrieved chunks are technically relevant but answers are wrong |
| Embedding Model | Wrong model for your domain (legal, medical, code) | Semantically similar documents score low |
| Vector Store | Index too slow or too expensive at scale | Latency spikes or costs explode with more documents |
| Retriever | Retrieves plausible but wrong chunks | Answers cite the wrong section of the right document |
| Reranker | Missing entirely (most tutorials skip it) | Top-1 result is mediocre, answer 3 would have been better |
| Generator | Ignores context or hallucinates beyond it | Answer contradicts or adds to the retrieved passages |

### Q&A

**Q: Do I need ALL these components? Can't I just embed documents and search?**
A: For a prototype, yes — embed, search, generate. That's "naive RAG" and it works surprisingly well on clean, small datasets. But in production, each missing component becomes a failure mode. No reranker? Your top results are mediocre. No query rewriting? Vague questions get bad results. No monitoring? Quality degrades silently. Start simple, then add components as you identify specific failure modes.

**Q: How long does the indexing pipeline take? Is it a bottleneck?**
A: Indexing 10,000 documents typically takes minutes to hours depending on chunk size and embedding model. It's a one-time cost (plus incremental updates). The query pipeline is what matters for user experience — that should be under 2 seconds end-to-end. If indexing is your bottleneck, you're probably re-embedding everything on every update instead of doing incremental indexing (Chapter 20).

**Q: Where does the most time go in the query pipeline?**
A: Typically: LLM generation (500ms–2s) > reranking (100–300ms) > embedding the query (50–100ms) > vector search (10–50ms). The LLM is the bottleneck. This means retrieving 3 perfect chunks is almost always better than retrieving 20 mediocre ones — you save on reranking time and LLM token costs.

**Q: I'm building a chatbot for a 50-person startup. Do I need a vector database?**
A: Maybe not. If you have fewer than 10,000 chunks, you can store embeddings in memory (a NumPy array) or use SQLite with a vector extension. A dedicated vector database (Pinecone, Qdrant, Weaviate) becomes worthwhile when you need: >100K chunks, metadata filtering, production reliability, or horizontal scaling. Don't over-engineer on day one. We cover the full decision in Chapter 7.

**Q: What if the user's question doesn't match any document — should the system say "I don't know"?**
A: Yes, and this is one of the hardest problems in RAG. If you always generate an answer, you'll hallucinate when nothing relevant was retrieved. The fix is a combination of: retrieval score thresholds (if no chunk scores above 0.7, say "I don't know"), explicit instructions in the prompt ("If the provided context doesn't contain the answer, say so"), and confidence calibration. We cover this in detail in Chapter 10 (Prompt Engineering) and Chapter 15 (Evaluation).

---

## Chapter 4: RAG vs. Fine-Tuning vs. Long Context

**One-liner**: RAG, fine-tuning, and long-context prompting are three different answers to the same question: "How do I make an LLM use my data?" — and each wins in different situations.

**Why you should care**: Your team is debating how to build an internal AI assistant. The ML engineer says "fine-tune a model." The product lead says "just use the new 1-million-token context window." You've been reading about RAG. Everyone's right — and everyone's wrong. Picking the wrong approach wastes months and tens of thousands of dollars.

**Prerequisites**: [Chapter 1: The Problem RAG Solves](#chapter-1-the-problem-rag-solves), [Chapter 2: How LLMs Actually Work](#chapter-2-how-llms-actually-work-just-enough)

### The Simple Version

You're preparing for a job interview and need to know about a specific company.

**Fine-tuning** is like studying that company intensively for weeks until you've internalized everything. You know it cold — but if the company reorganizes next week, your knowledge is stale. And you can't explain *where* you learned each fact.

**Long-context prompting** is like bringing the company's entire 200-page annual report into the interview and reading it on the spot. You have all the info, but it takes a while to find things, it's expensive (imagine being billed per page you bring), and you might miss details buried on page 147.

**RAG** is like having a research assistant who highlights the 5 most relevant pages from the annual report and hands you just those. Fast, cheap, and you know exactly where each fact came from.

### How It Actually Works

| Dimension | RAG | Fine-Tuning | Long Context |
|---|---|---|---|
| **How it works** | Retrieve relevant docs at query time, add to prompt | Retrain model weights on your data | Stuff all data into the prompt for every query |
| **Setup cost** | Medium (build pipeline) | High ($1K–$100K+ training) | Low (just paste data) |
| **Per-query cost** | Low (embed query + few chunks + generation) | Low (just generation) | High (all tokens processed every query) |
| **Data freshness** | Minutes (re-index changed docs) | Weeks (retrain the model) | Instant (just update the prompt) |
| **Handles 1M+ docs** | Yes (search narrows to top-K) | No (can't fit in training) | No (exceeds any context window) |
| **Source attribution** | Built-in (you know which chunks were used) | Impossible (knowledge is in weights) | Possible but noisy (entire doc is context) |
| **Access control** | Yes (filter by user permissions) | No (everyone gets same model) | Manual (curate per-user prompts) |
| **Best for** | Knowledge bases, support, search | Style/tone, domain vocabulary, structured output | Small docs, one-off analysis, prototyping |

### Real-World Examples

**Example 1: Shopify — Chose RAG Over Fine-Tuning**

Shopify needed an AI assistant to help merchants with store setup, marketing, and troubleshooting. They had millions of help articles, community posts, and documentation. Fine-tuning would have been expensive and stale within weeks as documentation changed. Instead, they built a RAG pipeline that indexes their help center. When a merchant asks "How do I set up international shipping?", the system retrieves current documentation and generates a step-by-step answer. The key advantage: when shipping features change, they update the docs and re-index — no model retraining needed.

**Example 2: Bloomberg — Chose Fine-Tuning (BloombergGPT)**

Bloomberg built BloombergGPT, a 50-billion-parameter model trained on 40 years of financial data — 363 billion tokens of financial text. For Bloomberg, fine-tuning made sense because: (1) the model needs deep financial vocabulary and reasoning that generic models lack, (2) financial language has unique patterns (earnings calls, SEC filings), and (3) Bloomberg's data is massive but relatively stable in *structure* (new filings follow the same formats). The cost was reportedly in the millions. For most companies without Bloomberg's scale and budget, RAG is the pragmatic choice.

### The Decision Framework

```
Start here: "I need an LLM to use my data"
     │
     ├─ Is your data < 50 pages and rarely changes?
     │   └─ YES → Long-context prompting. Just stuff it in the prompt. Done.
     │
     ├─ Do you need the model to adopt a specific style,
     │  tone, or deeply understand domain jargon?
     │   └─ YES → Fine-tune (or RAG + fine-tuned model for both benefits)
     │
     ├─ Does your data change frequently?
     │   └─ YES → RAG. Fine-tuning can't keep up.
     │
     ├─ Do different users need access to different data?
     │   └─ YES → RAG. Access control is nearly impossible with fine-tuning.
     │
     ├─ Do you need to cite sources?
     │   └─ YES → RAG. Fine-tuning buries knowledge in weights.
     │
     └─ None of the above clear?
         └─ Start with RAG. It's the most flexible and reversible choice.
```

*What question does this diagram answer? "Given my specific situation, which approach should I pick?"*

### The Hybrid Play: RAG + Fine-Tuning

These aren't mutually exclusive. The most powerful production systems combine them:

- **Fine-tune for style and reasoning** — The model learns your domain's vocabulary and output format
- **RAG for knowledge** — Retrieved context provides facts, data, and current information

Example: a medical AI might fine-tune on clinical note writing style (so outputs look like real clinical notes) while using RAG to retrieve relevant patient records and medical literature. The fine-tuning handles *how* to answer; RAG handles *what* to answer.

### When To Use / When NOT To Use

| Choose RAG When | Choose Fine-Tuning When | Choose Long Context When |
|---|---|---|
| Data changes weekly or faster | Domain language is highly specialized | You have < 50 pages total |
| You need source citations | You need specific output format/style | You're prototyping or doing one-off analysis |
| Different users see different data | Your entire dataset fits in training budget | Data is small and changes rarely |
| You have 1,000+ documents | Model needs to "think" in your domain | You need it working in 5 minutes, not 5 days |
| Budget is limited | Budget is large and timeline is long | Cost per query doesn't matter |

### Q&A

**Q: Can I use RAG and fine-tuning together? Or is it one or the other?**
A: Absolutely together — and the best production systems often do. Fine-tune for *style* (how the model writes, what format, what tone) and use RAG for *knowledge* (what facts, what data, what's current). A fine-tuned model with RAG retrieval outperforms either approach alone on most benchmarks. The fine-tuning teaches the model to *use* retrieved context more effectively.

**Q: Long-context windows keep getting bigger. Won't they eventually make RAG obsolete?**
A: Three reasons RAG survives even with infinite context: (1) **Cost** — processing your entire knowledge base for every query is wildly expensive at scale, (2) **Quality** — "lost in the middle" research shows models use information less effectively as context grows, and (3) **Access control** — you can't stuff everyone's data into one prompt when users have different permissions. Long context changes the threshold for *when* RAG is worth the complexity, but it doesn't eliminate the need. See Chapter 24 for the full analysis.

**Q: Fine-tuning costs keep dropping. Will RAG become unnecessary once fine-tuning is cheap?**
A: Even free fine-tuning wouldn't kill RAG, because cost isn't the main advantage. The killers are *freshness* and *attribution*. If your knowledge base updates daily, you can't retrain daily. And if you need to cite sources (legal, medical, enterprise), fine-tuning literally cannot do that — the knowledge is dissolved into weights with no traceability.

**Q: My dataset is 100 PDFs totaling 5,000 pages. RAG or long context?**
A: At 5,000 pages (~2.5 million tokens), it's too big for a single long-context call. RAG is your answer. But consider: if 90% of queries only need information from a small subset of those PDFs, you might long-context the relevant 2-3 PDFs and skip the pipeline. The hybrid approach is: use RAG to *find* the right documents, then long-context those specific documents for deep analysis.

**Q: We tried RAG and answers weren't great. Should we switch to fine-tuning?**
A: Before switching, diagnose *why* RAG is failing. In most cases, the problem is retrieval (bad chunking, wrong embedding model, no reranking), not the approach itself. Check: Are the right chunks being retrieved? (If no → fix retrieval.) Is the LLM ignoring good chunks? (If yes → fix prompting.) Is the domain vocabulary too specialized? (If yes → consider RAG + fine-tuning together.) Switching to fine-tuning because RAG retrieval is broken is like buying a new car because your tires are flat.

---

## Putting It Together: Your First RAG System

Let's tie everything from Part 1 together by walking through a minimal but complete RAG system — the kind you'd build in an afternoon to prove the concept works.

### The Scenario

You're an engineer at a 200-person startup. The company wiki has 500 pages of documentation: engineering runbooks, HR policies, product specs, and meeting notes. Employees spend 20 minutes/day searching for information. Your CEO asks: "Can we build an AI that answers questions from our wiki?"

### The Architecture (Minimal Viable RAG)

```
┌─────────────────────────────────────────────────────┐
│                  INDEXING (run once)                  │
│                                                       │
│  Wiki Pages → Split by headers → Embed each chunk    │
│                    → Store in vector DB               │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│               QUERYING (per question)                 │
│                                                       │
│  "What's our on-call rotation?"                      │
│       ↓                                               │
│  Embed the question                                   │
│       ↓                                               │
│  Find top 5 matching chunks from vector DB           │
│       ↓                                               │
│  Send to LLM: "Answer using ONLY this context:       │
│    [chunk 1] [chunk 2] ... [chunk 5]                 │
│    Question: What's our on-call rotation?"           │
│       ↓                                               │
│  "Our on-call rotation runs weekly, Mon–Mon.          │
│   Engineers rotate in alphabetical order.             │
│   Source: Engineering Runbook, page 12"              │
└─────────────────────────────────────────────────────┘
```

### What This Minimal System Gets Right

1. **It works.** For simple factual questions with clear answers in single documents, this is surprisingly good.
2. **It's fast.** Vector search takes milliseconds. The LLM call is the bottleneck at 1-2 seconds.
3. **It cites sources.** The prompt asks the LLM to name its source document.
4. **It's cheap.** Embedding 500 pages costs a few dollars. Each query costs fractions of a cent.

### Where It Falls Apart (And What to Fix)

| Problem | What You'll See | The Fix | Where in This Book |
|---|---|---|---|
| Chunks split mid-paragraph | Answers miss context that was in the other half of a split chunk | Better chunking (semantic, by headers) | Part 2, Ch. 5 |
| Exact terms missed | "Error code XJ-4021" gets no results because vector search is semantic, not exact | Add keyword/hybrid search | Part 2, Ch. 8–9 |
| Wrong chunks ranked first | The most relevant passage is result #7, not #1 | Add a reranker | Part 3, Ch. 11 |
| Vague questions fail | "Tell me about that policy thing" retrieves random policies | Add query rewriting | Part 3, Ch. 12 |
| No way to measure quality | You don't know if it's getting worse until users complain | Add evaluation pipeline | Part 4, Ch. 15–16 |
| Intern sees exec salary data | No access control on retrieved chunks | Add permission filtering | Part 4, Ch. 19 |

### Key Takeaway

**A RAG system is only as good as its weakest component.** The minimal system has one of everything and none of the important refinements. Parts 2–4 of this book systematically fix each weakness. By Part 5, you'll be building systems that handle the hard cases: multi-hop questions, structured data, and multi-source synthesis.

The journey from "works on a demo" to "works in production" is what this book is about.
