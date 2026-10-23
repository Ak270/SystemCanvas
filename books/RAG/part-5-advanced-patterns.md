# Part 5: Advanced Patterns — "Beyond Basic RAG"

> **What this part covers**: Agentic RAG (multi-step retrieval with reasoning), Graph RAG (answering relationship questions), Multimodal RAG (tables, images, PDFs), the long-context vs. RAG debate, and RAG for code.
>
> **Prerequisites**: [Part 4: Evaluation & Production](part-4-evaluation-production.md) — you should be comfortable building, evaluating, and running production RAG.
>
> **After this part, you'll be able to**: Handle the hard cases that break basic RAG: multi-hop questions, relationship queries, non-text data, and codebase search.

---

## Chapter 21: Agentic RAG — When One Search Isn't Enough

**One-liner**: Agentic RAG uses an LLM as a reasoning agent that plans multiple retrieval steps, evaluates results, and iterates — handling complex questions that need information from multiple sources.

**Why you should care**: A user asks your enterprise assistant: "What was the revenue impact of the features the London team shipped in Q3?" Basic RAG searches for this exact question and retrieves... nothing useful. Because no single document answers it. The answer requires: (1) finding what the London team shipped in Q3, (2) finding the revenue data for those features, and (3) connecting them. That's three retrieval steps with reasoning in between. Basic RAG does one search. Agentic RAG chains as many as needed.

**Prerequisites**: [Chapter 12: Query Transformation](part-3-generation-orchestration.md#chapter-12-query-transformation), [Chapter 14: Conversational RAG](part-3-generation-orchestration.md#chapter-14-conversational-rag--memory)

### The Simple Version

Imagine you're a detective investigating a case. You don't walk into the evidence room, grab one file, and write your report. You:

1. **Start with what you know** — read the initial report
2. **Identify what's missing** — "I need the suspect's alibi and the forensic results"
3. **Search for each piece** — check alibis, request lab results
4. **Evaluate what you found** — "The alibi doesn't match the timeline. I need cell phone records too."
5. **Iterate** — search again for the new piece
6. **Synthesize** — write the final report connecting all evidence

Agentic RAG gives the LLM this detective workflow. It searches, thinks, searches again, and keeps going until it has enough to answer.

### How It Actually Works

```
User: "What was the revenue impact of the features the London team shipped in Q3?"
                    ↓
┌──────────────────────────────────────────────────────────┐
│  AGENT: Plan retrieval steps                              │
│  "I need to:                                             │
│   1. Find what the London team shipped in Q3             │
│   2. Find revenue data for those features                │
│   3. Calculate/summarize the impact"                     │
└──────────────────────┬───────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────────┐
│  Step 1: Search "London team Q3 shipped features"        │
│  → Retrieved: "London shipped: Smart Search (July),      │
│    Auto-tagging (Aug), Batch Export (Sep)"               │
└──────────────────────┬───────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────────┐
│  Step 2: Search "Smart Search revenue impact Q3"         │
│  → Retrieved: "Smart Search: +$1.2M ARR in Q3"          │
│                                                           │
│  Step 3: Search "Auto-tagging revenue" + "Batch Export"  │
│  → Retrieved: "Auto-tagging: +$340K ARR"                │
│  → Retrieved: "Batch Export: too early to measure"       │
└──────────────────────┬───────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────────┐
│  AGENT: Evaluate — do I have enough?                     │
│  "I have revenue for 2 of 3 features. Batch Export has   │
│   no data yet. I can answer with a caveat."              │
└──────────────────────┬───────────────────────────────────┘
                       ↓
│  Final Answer: "The London team shipped 3 features in Q3.│
│  Combined measurable revenue impact: +$1.54M ARR.        │
│  Smart Search: +$1.2M, Auto-tagging: +$340K.            │
│  Batch Export (Sept) doesn't have revenue data yet.      │
│  [Sources: Q3 Roadmap, Revenue Dashboard, Feature Impact]│
└──────────────────────────────────────────────────────────┘
```

*What question does this diagram answer? "How does an agent break down a complex question into multiple retrieval steps?"*

**Key agentic patterns:**

| Pattern | How It Works | Best For |
|---|---|---|
| **ReAct (Reason + Act)** | LLM alternates between reasoning ("I need X") and acting (searching, calculating) | General multi-step questions |
| **Plan-and-Execute** | LLM creates a full plan upfront, then executes each step | Questions with clear sub-parts |
| **Self-RAG** | LLM evaluates its own retrieved context and decides if it needs more | When retrieval quality varies |
| **Iterative refinement** | Search → evaluate → refine query → search again | Exploratory research questions |

**The critical design choice: when to stop.**

Agentic RAG can loop forever if not constrained. Production systems use:
- **Max iterations** (typically 3-5 retrieval rounds)
- **Confidence threshold** (stop when the agent judges it has enough info)
- **Budget limit** (stop after N tokens or $X spent)

### Real-World Examples

**Example 1: Perplexity AI — Multi-Step Research**

Perplexity processes complex research queries that require multiple searches. When you ask "Compare the AI investment strategies of Google, Microsoft, and Amazon in 2025," Perplexity doesn't do one search. It searches for each company separately, retrieves recent financial reports and news, cross-references data, and synthesizes a comparison — often performing 5-10 retrieval steps. Their "Pro" mode explicitly shows this multi-step reasoning. Perplexity reports that agentic multi-step search resolves 40% more complex queries correctly compared to single-step retrieval.

**Example 2: LangGraph — Agentic RAG Framework**

LangGraph (by LangChain) is a framework specifically for building agentic RAG workflows. It represents retrieval-reasoning cycles as a graph of states and transitions. One enterprise customer built a compliance checking system using LangGraph: given a contract, the agent retrieves relevant regulations, checks each clause against the regulations, identifies gaps, and produces a compliance report — typically requiring 10-15 retrieval steps per contract. The agentic approach caught 30% more compliance issues than a single-pass RAG system because it could follow chains of regulatory references.

### When To Use / When NOT To Use

| Use Agentic RAG When | Don't Use When |
|---|---|
| Questions require info from multiple sources | Simple factual lookups with one-chunk answers |
| Answers require reasoning/computation across retrieved data | Latency must be under 3 seconds |
| Users ask complex, multi-part questions | Cost per query must stay under $0.05 |
| Research, analysis, or investigation workflows | High-volume, low-complexity query traffic |

### Q&A

**Q: Doesn't agentic RAG cost way more than basic RAG?**
A: Yes — typically 3-10x more per query because of multiple LLM calls for reasoning and multiple retrieval steps. A single agentic query might cost $0.10-0.50. This is fine for high-value queries (research, compliance, analysis) but prohibitive for FAQ-style support. The solution: route simple queries to basic RAG and only invoke the agent for complex ones (the routing pattern from Chapter 18).

**Q: How do I prevent the agent from looping forever?**
A: Three safeguards: (1) Hard max of 5 retrieval iterations — if it hasn't found enough by then, answer with what it has plus caveats. (2) Token budget — stop after spending X tokens. (3) Repetition detection — if the agent searches for the same thing twice, force it to synthesize or give up. In practice, most useful questions resolve in 2-3 steps.

**Q: Can the agent use tools besides search? Like a calculator or database query?**
A: Absolutely — this is where agentic RAG becomes most powerful. The agent can search documents (RAG), query a SQL database, call an API, run calculations, and more. "What's our average deal size for enterprise accounts this quarter?" might: (1) search for the definition of "enterprise account," (2) query the CRM database with the right filter, (3) calculate the average. The RAG component provides context; the tools provide data.

**Q: How do I evaluate agentic RAG? The standard metrics from Chapter 15 don't seem sufficient.**
A: You need additional metrics: (1) **Step efficiency** — how many steps did it take vs. the minimum needed? (2) **Plan quality** — did the agent's decomposition make sense? (3) **Coverage** — did it find all the necessary pieces of information? Plus the standard faithfulness and correctness metrics on the final answer. Evaluation is harder because you're assessing a *process*, not just an *output*.

**Q: Is agentic RAG the same as "AI agents"?**
A: Agentic RAG is a specific pattern: an agent whose primary tool is document retrieval. General AI agents can do anything (write code, send emails, manage calendars). Agentic RAG is scoped: the agent reasons and searches, but its actions are limited to retrieval and synthesis. This scoping makes it safer and more predictable than a fully autonomous agent.

---

## Chapter 22: Graph RAG — When Relationships Matter

**One-liner**: Graph RAG builds a knowledge graph from your documents and uses it to answer questions about relationships, connections, and themes that vector search can't handle.

**Why you should care**: A manager asks your internal AI: "Who in the engineering team has experience with Kubernetes and has worked on the payments service?" Vector search finds chunks about Kubernetes and chunks about payments — but it can't *connect* a person to both. The answer requires understanding relationships: Person → has_skill → Kubernetes, Person → worked_on → Payments Service. This is a graph problem, not a search problem.

**Prerequisites**: [Chapter 21: Agentic RAG](#chapter-21-agentic-rag--when-one-search-isnt-enough)

### The Simple Version

Imagine you're playing a detective board game (like Clue). You have scattered notes: "Alice was seen in the library." "The library contains the candlestick." "Alice knows Bob." "Bob was in the kitchen."

Vector search can find each individual note. But to answer "Could Alice have given the candlestick to Bob?" you need to connect the dots: Alice → was in library → library has candlestick → Alice knows Bob. That's traversing a graph of relationships.

Graph RAG builds this web of connections from your documents and lets the LLM walk along the connections to find answers.

### How It Actually Works

**Step 1: Build the Knowledge Graph (offline)**

An LLM reads your documents and extracts entities and relationships:

```
Document: "Sarah Chen leads the Platform team. The Platform team
           maintains the Payments service and the Auth service.
           The Payments service uses Kubernetes for orchestration."

Extracted:
  (Sarah Chen) ──leads──→ (Platform Team)
  (Platform Team) ──maintains──→ (Payments Service)
  (Platform Team) ──maintains──→ (Auth Service)
  (Payments Service) ──uses──→ (Kubernetes)
```

**Step 2: Query the Graph (at query time)**

```
Query: "Who has experience with Kubernetes and the Payments service?"
         ↓
Graph traversal:
  Kubernetes ←──uses── Payments Service ←──maintains── Platform Team ←──leads── Sarah Chen
         ↓
Answer: "Sarah Chen — she leads the Platform Team, which maintains
         the Payments Service, which uses Kubernetes."
```

*What question does this diagram answer? "How does Graph RAG connect information spread across multiple documents?"*

**Microsoft's GraphRAG architecture:**

Microsoft's open-source GraphRAG implementation adds a unique feature: **community detection**. It clusters related entities into "communities" and generates summaries at different levels of abstraction. This handles two types of questions:

| Question Type | Method | Example |
|---|---|---|
| **Local** (specific entities) | Graph traversal from query entities | "What does Sarah Chen work on?" |
| **Global** (themes, summaries) | Community summaries | "What are the main engineering initiatives?" |

Basic RAG handles local questions reasonably well. Graph RAG's unique advantage is global/thematic questions — "What are the recurring themes in customer complaints?" — where no single chunk contains the answer.

### Real-World Examples

**Example 1: Microsoft GraphRAG**

Microsoft released GraphRAG as an open-source project in 2024. Their benchmark showed it significantly outperforms basic RAG on global questions. When asked "What are the main themes in this dataset?", basic RAG returned scattered fragments. GraphRAG's community summaries provided coherent thematic analysis. One notable use: analyzing investigative journalism datasets (news articles, court documents) to find patterns and connections. The trade-off: indexing is 10-100x more expensive than basic RAG because every document goes through LLM entity extraction.

**Example 2: Neo4j + LLM Integration**

Neo4j, the graph database, has integrated with LLM frameworks for Graph RAG. Financial institutions use Neo4j-backed RAG to answer compliance questions like "Show me all transactions connected to this flagged entity within 3 degrees of separation." Traditional RAG would retrieve documents mentioning the entity, but couldn't traverse connections. The graph traversal reveals hidden networks — transactions laundered through multiple intermediaries — that vector search fundamentally cannot find.

### When To Use / When NOT To Use

| Use Graph RAG When | Don't Use When |
|---|---|
| Questions involve relationships between entities | Simple factual Q&A from single documents |
| You need thematic/summary answers across large corpora | Your data is mostly unstructured prose |
| Entity connections matter (org charts, supply chains, compliance) | Quick setup is more important than relationship understanding |
| Dataset has rich interconnections | Indexing cost is a concern (10-100x basic RAG) |

### Q&A

**Q: Graph RAG indexing costs 10-100x more than basic RAG. Is it worth it?**
A: Only if your questions require it. If 80% of your queries are factual lookups (basic RAG handles fine), and 20% are relationship/thematic questions, consider: build a basic RAG system for the 80%, and add a graph layer for the 20%. Route relationship questions to Graph RAG and factual questions to basic RAG. Don't graph-index your entire corpus if most queries don't need it.

**Q: Can I combine Graph RAG with vector search?**
A: Yes — and you should. The best systems use vector search for factual retrieval and graph traversal for relationship queries. The routing decision can be automatic: if the query mentions entities and relationships ("Who worked on X that connects to Y"), route to graph. If it's a factual question ("What is X?"), route to vector search. Hybrid approaches (graph + vector) are an active research area.

**Q: How do I handle errors in the knowledge graph? LLM entity extraction isn't perfect.**
A: Entity extraction has ~80-90% accuracy, meaning 10-20% of entities and relationships will be wrong. Mitigations: (1) Multiple extraction passes with different prompts, keep only entities found by majority vote. (2) Human review of the most-connected entities (high-impact nodes). (3) Versioned graphs — when errors are found, correct and re-extract.

**Q: How big does my corpus need to be for Graph RAG to be worth it?**
A: Graph RAG shines with 1,000+ documents where relationships span across many documents. At 100 documents, you can often fit enough context for an LLM to reason about relationships without a graph. At 10,000+ documents, the graph becomes essential — no context window can hold all the relationship information. The break-even depends on your question complexity, not just corpus size.

**Q: Doesn't a long-context model with all my documents make Graph RAG unnecessary?**
A: For small corpora (<100 docs), yes. For large corpora, no. Even a 1M-token context can't hold 10,000 documents. And even if it could, the LLM struggles to identify multi-hop relationships across long contexts. The graph pre-computes relationship structure, making traversal reliable. It's the difference between "find connections in these 10,000 pages" (hard) and "follow edges in this precomputed graph" (easy).

---

## Chapter 23: Multimodal RAG — Beyond Text

**One-liner**: Multimodal RAG retrieves and reasons over non-text content — tables, images, diagrams, PDFs with complex layouts — that text-only RAG ignores or destroys.

**Why you should care**: Your company has 20,000 PDFs. Half of them contain tables, charts, diagrams, and images with critical information. Your text-only RAG pipeline extracts the text and throws away everything else. An analyst asks "What were the top 5 products by revenue in Q3?" The answer is in a table in a quarterly report PDF. But your chunker serialized the table into garbage: "Product A 1.2M Product B 900K" — rows mashed together, column headers lost. The LLM returns a wrong answer because the data was mangled before it ever reached retrieval.

**Prerequisites**: [Chapter 5: Chunking Strategies](part-2-retrieval-stack.md#chapter-5-chunking-strategies)

### The Simple Version

Imagine you're studying for an exam using a textbook. If you only read the words and skip every table, chart, and diagram, you miss half the information. The chart showing revenue growth tells you more at a glance than three paragraphs of description. The table comparing product specs is the definitive source — not the prose around it.

Multimodal RAG is like studying with your eyes open — reading text, tables, and images as the author intended.

### How It Actually Works

**The challenge**: Different data types need different processing:

```
PDF Document
     │
     ├─ Text paragraphs  → Standard chunking + embedding
     │
     ├─ Tables            → Preserve structure (rows, columns, headers)
     │                       Option A: Serialize to Markdown table → embed
     │                       Option B: Store as structured data → query directly
     │
     ├─ Images/Charts     → Option A: OCR + caption with vision LLM → embed caption
     │                       Option B: Embed image directly with multimodal embeddings
     │
     └─ Complex layouts   → Use layout-aware parsing (detect columns, sidebars, footnotes)
```

*What question does this diagram answer? "How do I handle different content types within the same document?"*

**Three approaches to multimodal RAG:**

| Approach | How It Works | Pros | Cons |
|---|---|---|---|
| **Text extraction + description** | Convert everything to text (OCR images, serialize tables, describe charts) | Simple, works with any embedding model | Lossy — complex tables and charts lose information |
| **Multimodal embeddings** | Embed images and text in the same vector space (e.g., CLIP-based models) | Preserves visual information | Models are less mature, fewer options |
| **Vision LLM at query time** | Retrieve document *pages* (as images), send to a vision-capable LLM | Highest fidelity — LLM sees exactly what the human sees | Expensive, slow, page-level retrieval is coarse |

**Table handling (the most common multimodal need):**

```
Original PDF table:
┌──────────┬─────────┬──────────┐
│ Product  │ Q3 Rev  │ Growth   │
├──────────┼─────────┼──────────┤
│ Widget A │ $1.2M   │ +15%     │
│ Widget B │ $900K   │ +8%      │
│ Widget C │ $750K   │ -3%      │
└──────────┴─────────┴──────────┘

Bad text extraction:
"Product Q3 Rev Growth Widget A $1.2M +15% Widget B $900K +8%..."

Good Markdown conversion:
"| Product | Q3 Rev | Growth |
 |---------|--------|--------|
 | Widget A | $1.2M | +15% |
 | Widget B | $900K | +8% |
 | Widget C | $750K | -3% |"

Best: Store as structured data AND generate a text summary:
"Q3 revenue by product: Widget A led at $1.2M (+15% growth),
 followed by Widget B ($900K, +8%) and Widget C ($750K, -3%)."
```

### Real-World Examples

**Example 1: Unstructured.io — Document Parsing at Scale**

Unstructured.io processes over 1 billion documents monthly, specializing in extracting structured data from complex PDFs. Their pipeline uses layout analysis models to detect document elements: titles, paragraphs, tables, images, headers, footers, and page numbers. Tables are extracted with structure preserved (rows, columns, headers maintained). Images are captioned using vision models. This approach recovered 40%+ of information that pure text extraction missed. One insurance client found that claims processing accuracy jumped from 71% to 93% after switching from text-only to Unstructured.io's multimodal parsing.

**Example 2: Amazon Textract + RAG**

Amazon Textract extracts text, tables, and forms from scanned documents with high accuracy. Financial services companies use Textract as the parsing layer in their RAG pipelines for processing loan applications, tax forms, and financial statements. One bank processes 50,000+ mortgage documents per month. Tables (income statements, asset listings) are the most critical content. Textract preserves table structure, which feeds into their RAG system for underwriter Q&A: "What is the applicant's total monthly income across all sources?" Without table-aware extraction, this question is unanswerable from the PDF.

### When To Use / When NOT To Use

| Use Multimodal RAG When | Text-Only RAG Suffices When |
|---|---|
| Documents contain critical tables (financial, scientific, technical) | Documents are primarily prose text |
| Images/diagrams carry information not in the text | Images are decorative, not informational |
| PDFs have complex layouts (multi-column, sidebars, forms) | Documents are clean Markdown/HTML |
| Users ask questions whose answers are in tables/charts | Questions are about concepts explained in text |

### Q&A

**Q: Do I need a vision model or is text extraction enough?**
A: For 80% of use cases, good text extraction with table preservation is enough. The Markdown table approach works well for most tabular data. Use a vision model when: (1) documents contain charts/graphs where the visual pattern is the answer, (2) layouts are too complex for text extraction (engineering drawings, infographics), or (3) you need to understand spatial relationships ("What's in the top-right quadrant of this diagram?").

**Q: Tables are my biggest problem. What's the best approach?**
A: Three-step approach: (1) Use a table-aware parser (Unstructured.io, Textract, or Camelot for PDFs) to extract tables with structure. (2) Convert to Markdown table format for embedding and retrieval. (3) Also generate a text summary of each table for semantic search. The text summary catches semantic queries ("Which product grew fastest?") while the structured table catches specific lookups ("What was Widget A's revenue?").

**Q: How do I embed images for retrieval?**
A: Two practical approaches: (1) Caption the image with a vision LLM ("This chart shows revenue growth from $2M to $5M over Q1-Q4 2025"), then embed the caption. This works with any text embedding model. (2) Use a multimodal embedding model (like CLIP or Cohere's multimodal embeddings) that can embed images and text in the same space. Approach 1 is simpler and more reliable today.

**Q: Vision LLM processing is expensive. How do I make it practical?**
A: Process at indexing time, not query time. During indexing, use a vision LLM to generate rich descriptions of every image and chart. Store these descriptions as text chunks. At query time, you're searching text descriptions — fast and cheap. Only invoke the vision LLM at query time for the rare cases where the user is specifically asking about an image's visual details.

**Q: My documents are scanned PDFs (images of text). How do I handle those?**
A: OCR first — convert the scanned image to text. Modern OCR (Tesseract, AWS Textract, Google Document AI) handles most scanned documents well. Then process the extracted text normally. The key quality factor: OCR accuracy on your specific document types. Run a sample through OCR and manually verify. If accuracy is below 95%, invest in better OCR (Document AI with custom training) before building the RAG pipeline — garbage in, garbage out.

---

## Chapter 24: Long Context vs. RAG

**One-liner**: Long-context models that handle 1M+ tokens are changing when you need RAG — but they don't eliminate it.

**Why you should care**: Your CEO reads that Gemini can process 1 million tokens — "that's 700,000 words! Just paste all our docs in!" Your engineering team spent 6 months building a RAG pipeline. Is it now obsolete? The answer is nuanced: for some use cases, long context is genuinely simpler and better. For others, RAG remains essential. Making the wrong call wastes either engineering effort or API costs.

**Prerequisites**: [Chapter 4: RAG vs. Fine-Tuning vs. Long Context](part-1-foundations.md#chapter-4-rag-vs-fine-tuning-vs-long-context)

### The Simple Version

Imagine you're a lawyer preparing for a trial.

**Long context** is like having the entire case file (10,000 pages) spread across your desk. You can see everything, but finding a specific detail requires scanning through all 10,000 pages for *every* question. It's comprehensive but slow and expensive.

**RAG** is like having a paralegal who's read the entire case file, indexed it, and can instantly pull the 5 relevant pages for any question. It's fast and cheap, but you're trusting the paralegal's judgment on what's relevant.

For a 50-page document, spread it on the desk. For 10,000 pages, you need the paralegal.

### How It Actually Works

**The crossover analysis:**

```
                    Cost per query vs. Corpus size
                    
Cost ($) │
  $1.00  │  Long context ────────────────────── (scales linearly)
         │         ╱
  $0.10  │        ╱          
         │       ╱    
  $0.01  │──────╱──── RAG ─────────────────── (roughly constant)
         │     ╱
  $0.001 │    ╱
         │───╱──────────────────────────────────────
         └──┴───────┴───────────┴───────────┴───────→
           10KB    100KB      1MB        10MB    Corpus
           (~5pp)  (~50pp)   (~500pp)  (~5000pp)
           
         Crossover: ~100-500 pages depending on query volume
```

*What question does this diagram answer? "At what corpus size does RAG become cheaper than long context?"*

**Head-to-head comparison for 2025-2026:**

| Dimension | Long Context | RAG |
|---|---|---|
| **Corpus size** | Up to ~500 pages per query | Unlimited (search narrows it) |
| **Cost per query (500 pages)** | ~$0.50-1.00 | ~$0.01-0.05 |
| **Cost per query (5 pages)** | ~$0.01 | ~$0.01 (RAG overhead ≈ long context) |
| **Latency (500 pages)** | 5-15 seconds (processing all tokens) | 1-3 seconds (search + generate) |
| **Quality on single-doc Q&A** | Excellent (sees everything) | Good (depends on retrieval quality) |
| **Quality on multi-doc synthesis** | Good (if it fits) | Varies (depends on retrieval) |
| **"Lost in the middle"** | Yes — worse with more tokens | Mitigated (fewer, well-ordered chunks) |
| **Access control** | Hard (can't partially include a prompt) | Native (filter at retrieval time) |
| **Freshness** | Instant (just update the prompt) | Minutes (re-index changed docs) |
| **Attribution/citation** | Harder (everything is "context") | Built-in (know which chunks were used) |

### Real-World Examples

**Example 1: Google NotebookLM — Long Context Done Right**

Google's NotebookLM lets users upload documents (up to 50 sources, millions of words total) and ask questions. For small to medium collections, it uses long-context processing — feeding entire documents to Gemini. This gives excellent results because the model sees complete documents without chunking artifacts. Users love the quality for research and analysis tasks. But there's a limit: with very large collections, NotebookLM switches to a retrieval-based approach behind the scenes, because even Gemini's context window can't hold everything.

**Example 2: Cursor's Hybrid Approach**

Cursor, the AI code editor, faces this trade-off constantly. For the file you're editing (typically <1000 lines), they use long context — the model sees the complete file. For answers that require information from elsewhere in the codebase (thousands of files), they use RAG-style retrieval to find relevant files and functions. This hybrid approach gives the best of both: complete context for local edits, targeted retrieval for codebase-wide questions.

### The Decision Framework

```
Is your total corpus < 50 pages?
  YES → Long context. Skip RAG entirely.
  
Is your corpus 50-500 pages and query volume < 100/day?
  YES → Long context is simpler and quality is excellent.
        Cost is manageable at low volume.
  
Is your corpus > 500 pages OR query volume > 1,000/day?
  YES → RAG. Cost and latency of long context don't scale.
  
Do you need access control (different users, different data)?
  YES → RAG. Long context can't partially filter.
  
Do you need citations for every claim?
  YES → RAG makes this natural. Long context makes it hard.
  
Best of both worlds:
  Use RAG to FIND the right documents, then long-context those
  specific documents for deep analysis.
```

### When To Use / When NOT To Use

| Choose Long Context When | Choose RAG When |
|---|---|
| Corpus is small (<50 pages) | Corpus is large (>500 pages) |
| Deep analysis of a few documents | Quick Q&A across many documents |
| Low query volume (<100/day) | High query volume (>1,000/day) |
| Freshness is critical (no indexing lag) | Cost per query matters |
| Prototyping quickly | Production system at scale |

### Q&A

**Q: Context windows are growing every year. Won't they eventually make RAG obsolete?**
A: They'll make RAG unnecessary for *small* corpora. But three factors prevent obsolescence: (1) **Cost scales linearly** — 10x bigger window = 10x cost per query. Enterprise knowledge bases (100K+ documents) will never be economical to process fully. (2) **Quality degrades** — research consistently shows models use information less effectively in longer contexts. (3) **Access control requires filtering** — you can't partially include documents in a single prompt based on user permissions.

**Q: What about the quality argument? Doesn't the model understand better when it sees everything?**
A: For single-document analysis, yes — long context outperforms RAG because there are no chunking or retrieval errors. For multi-document Q&A across large corpora, it's a wash. RAG might miss a relevant chunk (retrieval error), but long context might miss information buried on page 400 (lost in the middle). Pick your trade-off based on corpus size and budget.

**Q: Can I use long context as a "backup" when RAG retrieval fails?**
A: Smart pattern. When retrieval scores are low (suggesting the answer isn't in the retrieved chunks), fall back to a long-context call with more documents. This acts as a safety net. The cost is higher for those queries, but it only triggers on the ~10-20% of queries where retrieval struggles. Monitor the fallback rate — if it's consistently high, your retrieval needs fixing (not more fallbacks).

**Q: We're a small startup with 200 pages of docs. Should we even bother with RAG?**
A: Not yet. Start with long context — paste your docs into a prompt and ask questions. It'll work great and you'll ship in a day instead of a month. Build RAG when you hit: 500+ pages, or 1,000+ queries/day, or access control requirements, or citation needs. Over-engineering the retrieval stack for 200 pages is premature optimization.

**Q: What's the hybrid "RAG + long context" approach?**
A: Use RAG as a *filter* to find the 3-5 most relevant documents, then feed those complete documents (not chunks) to a long-context model. You get RAG's efficiency at finding documents plus long context's quality at reading them. This is increasingly the architecture for high-stakes use cases: legal research (find relevant cases, then read them fully) and code analysis (find relevant files, then analyze them in full).

---

## Chapter 25: RAG for Code

**One-liner**: Code RAG lets an AI answer questions about your codebase — "What does this function do?", "Where is auth handled?", "How do I use the payments API?" — by retrieving relevant code and documentation.

**Why you should care**: Your engineering team has a 500,000-line codebase, 3 years of commit history, and scattered documentation. A new engineer joins and asks: "How does the authentication flow work?" Currently, they spend 2 weeks reading code, asking colleagues, and piecing it together. With code RAG, they ask the question and get an answer with links to the relevant files, functions, and documentation — in seconds.

**Prerequisites**: [Chapter 6: Embeddings](part-2-retrieval-stack.md#chapter-6-embeddings--turning-text-into-numbers), [Chapter 9: Hybrid Search](part-2-retrieval-stack.md#chapter-9-hybrid-search--best-of-both-worlds)

### The Simple Version

Imagine you just joined a company with a massive code warehouse. You need to find where "payments" are handled. You could walk through every aisle (file) checking every box (function). Or you could ask the warehouse manager who's memorized the layout.

Code RAG is that warehouse manager. It's indexed every file, function, class, and comment. When you ask a question, it retrieves the relevant code and explains it in context.

### How It Actually Works

**Code RAG differs from document RAG in key ways:**

| Aspect | Document RAG | Code RAG |
|---|---|---|
| **Chunking** | By paragraphs/sections | By functions, classes, methods |
| **Relationships** | Loose (topic-based) | Strict (imports, calls, inheritance) |
| **Identifiers** | Natural language (semantic) | Exact names (function names, variable names) |
| **Context needed** | Self-contained chunks | Signature + body + callers + callees |
| **Updates** | Docs change occasionally | Code changes with every commit |

**Code-specific chunking:**

```
# Bad: chunk by line count (splits functions)
# Good: chunk by semantic code units

Repository
  ├── auth/
  │   ├── login.py
  │   │   ├── Chunk: class LoginHandler (signature + docstring + body)
  │   │   ├── Chunk: def validate_credentials() (full function)
  │   │   └── Chunk: def generate_token() (full function)
  │   └── middleware.py
  │       └── Chunk: class AuthMiddleware (full class)
  └── payments/
      ├── processor.py
      │   ├── Chunk: class PaymentProcessor
      │   └── Chunk: def charge_card()
      └── README.md
          └── Chunk: Payments API documentation
```

**Retrieval for code combines:**
1. **Semantic search** — "How does authentication work?" matches auth-related code by meaning
2. **Keyword/symbol search** — "PaymentProcessor" matches the exact class name
3. **Graph traversal** — Find `charge_card()`, then also retrieve its callers and dependencies

### Real-World Examples

**Example 1: GitHub Copilot's Codebase Awareness**

GitHub Copilot uses code RAG to understand your entire repository, not just the current file. When you write a function that needs to call the payments API, Copilot retrieves the relevant API functions, their signatures, and examples of how they're used elsewhere in the codebase. GitHub reports that repository-aware suggestions are 30%+ more likely to be accepted than context-unaware ones. The key: Copilot indexes code at the function/class level and uses code-specific embeddings (trained on code-text pairs) for retrieval.

**Example 2: Sourcegraph Cody**

Sourcegraph's Cody is an AI coding assistant with deep codebase understanding. It indexes entire repositories and answers questions like "What services does the user authentication flow touch?" by retrieving code across multiple files and services. Cody uses a combination of code graph analysis (who calls what), keyword search (exact identifier matching), and semantic search (natural language to code). Enterprise customers report that Cody reduces time-to-understand-codebase for new engineers from weeks to days.

### When To Use / When NOT To Use

| Use Code RAG When | Don't Use When |
|---|---|
| Large codebases (>50K lines) | Small projects a single dev understands fully |
| Onboarding new engineers | Everyone knows the codebase intimately |
| Complex microservice architectures | Simple monolith with good documentation |
| Code review assistance (understanding unfamiliar modules) | Tasks only involve the current file |

### Q&A

**Q: How do I chunk code? Functions can be 5 lines or 500 lines.**
A: Use AST (Abstract Syntax Tree) parsing to chunk by semantic units: functions, classes, methods. For large functions (>200 lines), chunk by logical blocks within the function. Always include the function signature and docstring — these are the "header" that tells the LLM what the code does. For imports and module-level code, chunk them together as the "module context."

**Q: Regular embeddings or code-specific embeddings?**
A: Code-specific embeddings (Voyage Code, CodeBERT, StarCoder embeddings) outperform general-purpose embeddings by 20-40% on code search tasks. They understand that `get_user()` relates to "retrieve user information" — a mapping general embeddings don't learn as well. If your RAG system handles both code and documentation, use code-specific embeddings for code chunks and general embeddings for doc chunks, or a single model that handles both (like Voyage AI's models).

**Q: Code changes every commit. How do I keep the index fresh?**
A: Hook into your CI/CD pipeline. On every push to main: (1) detect changed files via `git diff`, (2) re-parse and re-chunk only changed files, (3) delete old chunks and insert new ones. Most codebases have <100 changed files per day — incremental indexing takes seconds. Full re-indexing of a 500K-line codebase takes minutes with batch embedding.

**Q: Should I index just code, or also comments, docs, and commit messages?**
A: All of the above, as separate chunk types. Code chunks answer "what does this do?" and "how does it work?". Comment/doc chunks answer "why was this built?" and "how do I use it?". Commit messages answer "when did this change?" and "why was it changed?" Tag each chunk type with metadata so the retriever can filter: a "how do I use X?" query should prefer documentation, while "why was X changed?" should prefer commit messages.

**Q: How do I handle cross-file dependencies? A function in file A calls a function in file B.**
A: Build a lightweight code graph (call graph + import graph). When retrieving a function, also retrieve its direct callers and callees. LangChain and LlamaIndex have code graph integrations. For simple cases: include the import statements and type signatures of dependencies as metadata on each chunk. For complex cases: use the agentic approach (Chapter 21) — the agent retrieves a function, identifies its dependencies, retrieves those, and continues until it has the full picture.

---

## Putting It Together: Agentic Research Assistant

Let's combine everything from Part 5 into a system that handles the hard cases.

### The Scenario

You're building a research assistant for an investment firm. Analysts ask complex questions that span financial reports (PDFs with tables), company wikis (text), market data (structured), and news (web). Questions like: "Compare the cloud revenue growth of the top 3 enterprise software companies and identify which is best positioned for the AI transition."

### The Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  AGENTIC RESEARCH ASSISTANT                   │
│                                                               │
│  Analyst: "Compare cloud revenue growth of top 3 enterprise  │
│            software companies for AI transition readiness"    │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  AGENT PLANNER                                          │  │
│  │  Step 1: Identify top 3 enterprise software companies  │  │
│  │  Step 2: Retrieve cloud revenue data for each          │  │
│  │  Step 3: Retrieve AI strategy/investment data for each │  │
│  │  Step 4: Compare and synthesize                        │  │
│  └────────────────────┬───────────────────────────────────┘  │
│                       ↓                                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  MULTIMODAL RETRIEVAL                                   │  │
│  │  • Financial reports (PDF) → Table-aware parsing        │  │
│  │  • Company wiki → Text RAG                             │  │
│  │  • Revenue tables → Structured extraction               │  │
│  │  • News articles → Web RAG                             │  │
│  └────────────────────┬───────────────────────────────────┘  │
│                       ↓                                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  GRAPH CONNECTIONS                                      │  │
│  │  • Company → acquired → AI startup                     │  │
│  │  • Company → invested_in → AI infrastructure           │  │
│  │  • Company → launched → AI product                     │  │
│  └────────────────────┬───────────────────────────────────┘  │
│                       ↓                                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  SYNTHESIS                                              │  │
│  │  Long-context the 10-15 most relevant documents for    │  │
│  │  deep analysis. Generate comparison with citations.    │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### What Makes This System Advanced

1. **Agentic planning** — Breaks the complex question into steps (Chapter 21)
2. **Graph relationships** — Traces connections between companies and AI investments (Chapter 22)
3. **Multimodal** — Extracts tables from financial PDFs (Chapter 23)
4. **Hybrid context strategy** — Uses RAG to find documents, then long-context for deep analysis (Chapter 24)
5. **Everything from Parts 1-4** — Hybrid search, reranking, evaluation, access control

### Key Takeaway

Advanced RAG isn't about picking one technique — it's about combining them for the problem at hand. Simple questions get simple RAG. Complex questions get agentic orchestration with multimodal retrieval and graph-enhanced reasoning. The art is routing each query to the right level of sophistication. In Part 6, we'll see how real-world systems make these choices across different domains.
