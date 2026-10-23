# Part 2: The Retrieval Stack — "Finding the Right Needle"

> **What this part covers**: How to split documents (chunking), convert text to searchable numbers (embeddings), store and search them (vector databases), and combine keyword and semantic search (hybrid search).
>
> **Prerequisites**: [Part 1: Foundations](part-1-foundations.md) — you should understand the RAG pipeline, what an LLM is, and why retrieval matters.
>
> **After this part, you'll be able to**: Build a retrieval system that actually finds the right passages, choose the right embedding model and vector database for your use case, and combine search methods for better results.

---

## Chapter 5: Chunking Strategies

**One-liner**: Chunking is how you split your documents into pieces the retriever can search — and bad chunking is the #1 reason RAG systems fail.

**Why you should care**: You've built a RAG prototype and it works great on clean Markdown docs. Then your company feeds in 10,000 PDFs. Suddenly, answers are wrong or nonsensical. You check the retrieved chunks and find: a table split in half (rows 1-15 in one chunk, rows 16-30 in another — with no column headers). A paragraph ripped mid-sentence. A code block severed from the function signature above it. Your retrieval scores look fine — the *chunks themselves* are broken.

**Prerequisites**: [Chapter 3: The RAG Pipeline](part-1-foundations.md#chapter-3-the-rag-pipeline-birds-eye-view)

### The Simple Version

Imagine you're cutting a textbook into flashcards. If you just cut every 200 words regardless of content, you'll slice sentences in half, separate a question from its answer, and put a table header on one card and its data on the next. Useless.

A good librarian cuts by *meaning*: one flashcard per concept. A section about refund policies stays together. A table stays whole. A code example stays with its explanation.

That's the difference between dumb chunking and smart chunking.

### How It Actually Works

There are four main strategies, each with different trade-offs:

**1. Fixed-Size Chunking**
Split every N characters (or tokens), with an overlap window.

```
Document: "Our refund policy allows returns within 30 days. Items must be
unused. Exceptions include: electronics (15 days), food (non-returnable).
For international orders, contact support..."

Chunk 1 (chars 0-100):   "Our refund policy allows returns within 30 days. Items must be unused. Exceptions include: electr"
Chunk 2 (chars 80-180):  "tronics (15 days), food (non-returnable). For international orders, contact support..."
                           ↑ overlap
```

- **Pros**: Dead simple. Predictable chunk sizes. Fast.
- **Cons**: Splits mid-sentence, mid-table, mid-code. Overlap helps but doesn't solve it. Most tutorials teach this because it's easy, not because it's good.

**2. Recursive/Separator-Based Chunking**
Split on natural boundaries — paragraphs first, then sentences, then characters as a fallback.

```
Split hierarchy:
  1. Try splitting on "\n\n" (paragraphs)
  2. If chunk still too big, split on "\n" (lines)
  3. If still too big, split on ". " (sentences)
  4. Last resort: split on " " (words)
```

- **Pros**: Respects natural text boundaries. Keeps sentences intact.
- **Cons**: Uneven chunk sizes. Doesn't understand document *structure* (headers, sections).

**3. Semantic Chunking**
Use an embedding model to detect where the *topic* changes, and split there.

```
Paragraph 1: "Our refund policy allows returns within 30 days..."  ← Topic: refunds
Paragraph 2: "Items must be in original packaging..."              ← Topic: refunds (similar → merge)
Paragraph 3: "Shipping costs are non-refundable..."                ← Topic: refunds (similar → merge)
Paragraph 4: "For new orders, delivery takes 3-5 business days..." ← Topic: shipping (different → split!)
```

- **Pros**: Chunks represent coherent topics. Best retrieval quality.
- **Cons**: Slower (requires embedding each paragraph). Harder to implement. Chunk sizes vary widely.

**4. Structural Chunking**
Use the document's own structure — HTML headers, Markdown sections, PDF sections — as split boundaries.

```
# Returns Policy          ← Chunk boundary
Our refund policy...
Items must be...

# Shipping Policy         ← Chunk boundary
For new orders...
Delivery takes...
```

- **Pros**: Leverages the author's own organization. Great for structured docs.
- **Cons**: Requires parsing document format. Sections may be too large or too small.

### The Chunk Size Dilemma

```
         ◄──── TOO SMALL ────►          ◄──── TOO LARGE ────►
         
Small chunks (100-200 tokens):          Large chunks (1000-2000 tokens):
  ✓ Precise retrieval                     ✓ Rich context
  ✗ Lost context                          ✗ Noise dilutes signal  
  ✗ Multiple chunks needed                ✗ Fewer fit in context window
  ✗ Can't answer complex Qs               ✗ Lower retrieval precision

                    Sweet spot: 256-512 tokens
                    (for most use cases)
```

*What question does this diagram answer? "How big should my chunks be?"*

### Real-World Examples

**Example 1: LlamaIndex's "Small-to-Big" Retrieval**

LlamaIndex (a popular RAG framework) popularized the "small-to-big" pattern: embed *small* chunks (2-3 sentences) for precise retrieval, but when the retriever finds a match, expand to the *parent* chunk (the full section) for context. This gives you the best of both worlds — precise retrieval with rich context. The small chunks act as a "pointer" to the larger section. In benchmarks, this approach improves answer quality by 15-25% over fixed-size chunking on long documents.

**Example 2: Unstructured.io's Document Parsing**

Unstructured.io processes over 1 billion documents per month for enterprise clients. Their key insight: *parsing* is the hardest part of chunking. A PDF table that renders beautifully on screen becomes garbage when naively extracted as text. Their pipeline detects document elements (titles, paragraphs, tables, images, headers) using layout analysis models, then chunks by element type. Tables become single chunks with headers preserved. Images get OCR'd and captioned. This approach recovered 40%+ of previously "lost" information from PDF-heavy datasets.

### When To Use / When NOT To Use

| Strategy | Use When | Don't Use When |
|---|---|---|
| Fixed-size | Prototyping, uniform text (novels, articles) | Tables, code, structured docs |
| Recursive | General-purpose, mixed content | Highly structured docs with clear sections |
| Semantic | Highest quality needed, topics vary within pages | Latency-sensitive indexing, small datasets |
| Structural | HTML/Markdown with good headers, API docs | Poorly structured PDFs, flat text files |

### Q&A

**Q: I'm just prototyping. Does chunking really matter that much?**
A: For a 10-document demo? No — fixed-size chunks with overlap will work fine. For anything beyond that, chunking is where the most retrieval failures originate. One practitioner found that switching from fixed 500-character chunks to header-based structural chunks improved answer accuracy from 62% to 84% on their internal docs — same embedding model, same LLM, same everything else. Chunking was the bottleneck.

**Q: What happens when a single "unit" (like a big table) is larger than my target chunk size?**
A: You have three options. (1) Keep it as one oversized chunk — many vector databases handle variable-size chunks fine. (2) Summarize the table into a text chunk and store both. (3) Store the table as a structured chunk with special handling in your retriever. Option 1 is simplest and usually good enough. Option 2 is best when the table is very large (>1000 tokens).

**Q: Should I overlap chunks? By how much?**
A: Overlap helps when using fixed-size or recursive chunking — it reduces the chance of splitting a key sentence. 10-20% overlap is typical (a 500-token chunk with 50-100 token overlap). But overlap is a band-aid for bad split points. If you're using semantic or structural chunking, overlap is usually unnecessary — you're already splitting at natural boundaries.

**Q: I have code documentation with code examples. How should I chunk?**
A: Keep code blocks with their surrounding explanation. The worst thing you can do is split a code example from the text describing it. Strategy: use structural chunking on headers, and treat code fences as atomic blocks that stay with their preceding paragraph. If a code block is huge (>500 tokens), chunk it as its own unit with the function signature and docstring.

**Q: My retrieval precision is 70%. I want 90%. Is chunking the lever or should I look elsewhere?**
A: It depends where the 30% failure is happening. Pull 20 failed queries and look at what was retrieved. If the retrieved chunks are *irrelevant* — wrong topic entirely — your embedding model or search method is the problem (Chapters 6–9). If the chunks are *partially relevant* but missing key context — right topic but wrong section, table split in half — chunking is your lever. In practice, fixing chunking is the highest-ROI improvement for most early-stage RAG systems.

---

## Chapter 6: Embeddings — Turning Text Into Numbers

**One-liner**: Embeddings convert text into lists of numbers (vectors) where similar meanings end up near each other in space — and this is what makes semantic search possible.

**Why you should care**: A customer types "I can't log in" into your support chatbot. Your knowledge base has an article titled "Authentication Troubleshooting Guide." There's zero word overlap between the query and the title. Keyword search finds nothing. But an embedding model maps both "I can't log in" and "Authentication Troubleshooting" to nearby points in vector space — because they *mean* the same thing. Without embeddings, your RAG system is just a fancy Ctrl+F.

**Prerequisites**: [Chapter 2: How LLMs Actually Work](part-1-foundations.md#chapter-2-how-llms-actually-work-just-enough), [Chapter 5: Chunking Strategies](#chapter-5-chunking-strategies)

### The Simple Version

Imagine a massive warehouse where every concept in language has a physical location. "Happy" is near "joyful" and "cheerful." "Sad" is far from "happy" but near "melancholy." "Bank" (money) is in one corner; "bank" (river) is in another — even though they're spelled the same.

An embedding model is a translator that takes any piece of text and gives you GPS coordinates in this warehouse. When you need to find documents similar to a question, you get the question's coordinates, then look for documents stored nearby.

The warehouse has hundreds of dimensions (not just 3), which lets it capture subtle relationships: "king" minus "man" plus "woman" ≈ "queen."

### How It Actually Works

An embedding model takes text input and outputs a fixed-length vector (list of numbers):

```
Input: "How do I reset my password?"
                ↓
        Embedding Model
                ↓
Output: [0.023, -0.041, 0.089, ..., -0.012]
        ←——————— 768 dimensions ———————→
```

**Similarity is measured by distance:**

```
"How do I reset my password?"     → [0.023, -0.041, 0.089, ...]
"Password reset instructions"     → [0.025, -0.039, 0.091, ...]  ← Close! (cosine similarity: 0.94)
"Best pizza restaurants nearby"   → [0.871, 0.234, -0.567, ...]  ← Far!  (cosine similarity: 0.12)
```

*What question does this diagram answer? "How does the system know two pieces of text are about the same thing?"*

**Key properties of good embeddings:**

1. **Semantic similarity** — "automobile" and "car" map to nearby vectors
2. **Asymmetric search** — A short question can match a long answer paragraph
3. **Multi-lingual** — Some models map "dog" (English) and "chien" (French) to the same region
4. **Domain awareness** — Medical embeddings know "MI" means "myocardial infarction," not "Michigan"

**Choosing an embedding model:**

| Model | Dimensions | Speed | Quality (MTEB) | Best For |
|---|---|---|---|---|
| OpenAI text-embedding-3-small | 1536 | Fast | Good | General purpose, cost-sensitive |
| OpenAI text-embedding-3-large | 3072 | Medium | Very good | High-quality retrieval |
| Cohere embed-v4 | 1024 | Fast | Excellent | Multi-lingual, enterprise |
| Voyage AI voyage-3 | 1024 | Fast | Excellent | Code, technical domains |
| BGE/GTE (open-source) | 768–1024 | Self-hosted | Good–Excellent | Privacy-sensitive, self-hosted |

### Real-World Examples

**Example 1: Airbnb's Listing Search**

Airbnb uses embedding models to power search across 7+ million listings in 220+ countries. When a user searches "cozy cabin near a lake for a family weekend," the embedding captures intent — family-friendly, nature setting, cabin style — without needing exact keyword matches. Listings described as "charming cottage on the waterfront, sleeps 5" score highly even though there's minimal word overlap. Airbnb found that embedding-based search increased booking conversion by double digits compared to keyword-only search, because users found listings that *matched their intent*, not just their words.

**Example 2: GitHub Copilot's Code Search**

GitHub uses specialized code embeddings (similar to Voyage AI's code models) for Copilot's codebase search. When you ask "function that validates email addresses," the embedding model understands this should match a function named `is_valid_email()` even if the docstring says "checks the format of user-provided email strings." Code embeddings are trained on code-text pairs, so they bridge the gap between natural language questions and programming constructs. GitHub reports that code-specific embeddings outperform general-purpose embeddings by 30%+ on code search benchmarks.

### When To Use / When NOT To Use

| Choose This Embedding When | Don't Choose When |
|---|---|
| **API-hosted (OpenAI, Cohere, Voyage)**: Fast setup, no infrastructure | Data can't leave your network (regulated industries) |
| **Open-source self-hosted (BGE, GTE)**: Full control, no API costs | You don't have GPU infrastructure for inference |
| **Domain-specific (code, medical, legal)**: 20-40% better in-domain | Your data is general-purpose across many domains |
| **Multi-lingual**: Users query in multiple languages | All your data and users are single-language |

### Q&A

**Q: Are embeddings just a fancy version of TF-IDF or bag-of-words?**
A: They solve the same problem — representing text numerically — but embeddings are far more powerful. TF-IDF counts word frequencies; "car" and "automobile" have zero similarity because they're different words. Embeddings capture *meaning*; those two words map to nearly identical vectors. The trade-off: TF-IDF is simple, fast, and interpretable. Embeddings need a trained model and are opaque. For RAG, embeddings are almost always worth it — but adding keyword search alongside them (Chapter 8) captures what embeddings miss.

**Q: My domain has very specific jargon (medical, legal, financial). Will generic embeddings work?**
A: Surprisingly often, yes — modern models like text-embedding-3-large handle domain terms better than you'd expect. But if you see retrieval failures on domain-specific terms (e.g., "MI" retrieving Michigan instead of myocardial infarction), you have options: (1) use a domain-specific model (PubMedBERT for medical), (2) fine-tune an embedding model on your domain data, or (3) add keyword search as a fallback. Option 3 is the fastest win.

**Q: More dimensions = better, right?**
A: Not necessarily. Going from 384 to 768 dimensions usually helps. Going from 1024 to 3072 shows diminishing returns for most use cases. More dimensions means: larger storage, slower search, and higher cost. OpenAI's text-embedding-3 models let you *truncate* dimensions — you can use 256 dimensions of the 3072-dimension model and still get decent quality at 12x less storage. Start with 768–1024 and only increase if benchmarks show improvement on *your* data.

**Q: How much does it cost to embed a million documents?**
A: At OpenAI's text-embedding-3-small pricing (~$0.02/million tokens), embedding 1 million documents of ~500 tokens each costs about $10. That's a one-time cost (plus incremental updates). The ongoing cost is embedding each user *query* — at one query per second, that's about $1.50/day. Embedding costs are rarely the bottleneck; LLM generation costs dominate (typically 10-50x more per query).

**Q: Should I embed the query with the same model I used for documents?**
A: Yes — always use the same model for queries and documents. Different models produce incompatible vector spaces. "Dog" in model A's space and "Dog" in model B's space might be in completely different locations. This sounds obvious, but it's a common production bug: someone upgrades the document embedding model but forgets to re-embed the corpus, and suddenly retrieval quality tanks.

---

## Chapter 7: Vector Databases & Indexes

**One-liner**: A vector database stores your embeddings and finds the most similar ones in milliseconds — even across millions of documents.

**Why you should care**: You've embedded 100,000 document chunks. Each is a 1024-dimensional vector. To find the 5 most similar to a query, you could compare the query against all 100,000 vectors — but that's 100,000 distance calculations per query. At 100 queries/second, that's 10 million calculations per second. At 10 million documents, it's untenable. You need an index that makes this fast.

**Prerequisites**: [Chapter 6: Embeddings](#chapter-6-embeddings--turning-text-into-numbers)

### The Simple Version

Imagine you're looking for a book in a library. You could walk down every aisle and check every book (exact search) — you'll find it, but it takes hours. Or you could use the catalog system: go to the right floor (non-fiction), then the right section (science), then the right shelf (physics). You might miss a relevant book that's miscataloged in the history section — but you'll find a great match in seconds.

Vector databases are that catalog system for embeddings. They trade a tiny bit of accuracy for massive speed gains — finding approximate nearest neighbors instead of exact ones.

### How It Actually Works

**The core problem**: Given a query vector, find the K vectors most similar to it.

**Brute-force search** (exact, slow):
Compare query against every vector. O(N) per query.

**Approximate Nearest Neighbor (ANN) search** (fast, 95-99% as accurate):
Build an index structure that narrows the search space.

Two dominant indexing algorithms:

**HNSW (Hierarchical Navigable Small World):**

```
Layer 2 (express):    A ─────────────── D
                      │                 │
Layer 1 (local):      A ── B ── C ── D ── E
                      │    │    │    │    │
Layer 0 (ground):     A  B  C  D  E  F  G  H

Search: Start at top layer, greedily move toward query.
Drop to lower layer. Repeat. Navigate to nearest neighbors.
```

- Think of it like a highway system: express lanes connect far-apart nodes, local roads connect nearby ones. Search starts on the highway and zooms in.
- **Pros**: Fast queries (sub-millisecond), good recall. The most popular choice.
- **Cons**: High memory usage (entire index in RAM), slow to build.

**IVF (Inverted File Index):**

- Cluster all vectors into ~1000 buckets using k-means.
- At query time, find the 10 closest bucket centers, then search only within those buckets.
- **Pros**: Lower memory, can live on disk. Works well with quantization.
- **Cons**: Slower queries, quality depends on cluster quality.

*What question does this diagram answer? "How does HNSW search millions of vectors in milliseconds?"*

**The Vector Database Landscape:**

| Database | Type | Best For | Scale |
|---|---|---|---|
| **FAISS** (Meta) | Library (in-process) | Prototyping, research, self-hosted | Billions of vectors |
| **Pinecone** | Managed cloud | Fastest time-to-production, serverless | Billions |
| **Qdrant** | Self-hosted or cloud | Filtering + search, cost control | Billions |
| **Weaviate** | Self-hosted or cloud | Multi-modal, GraphQL API | Millions–Billions |
| **Milvus** | Self-hosted or cloud | Highest scale, GPU-accelerated | Billions+ |
| **pgvector** (Postgres) | Extension | Already using Postgres, < 1M vectors | Millions |
| **Chroma** | Embedded | Prototyping, local development | Thousands–Millions |

### Real-World Examples

**Example 1: Pinecone at Scale**

Pinecone handles billions of vector search queries for customers like HubSpot, Gong, and Notion. HubSpot uses Pinecone to power their AI content assistant, searching across millions of marketing documents. A key design choice: Pinecone's serverless architecture means HubSpot pays per query, not per server — important when traffic is spiky (10x more queries during business hours). At peak, their system handles thousands of queries per second with p99 latency under 50ms.

**Example 2: DoorDash's Menu Search with pgvector**

DoorDash needed semantic search across millions of restaurant menu items. Rather than adopting a new database, they added pgvector to their existing PostgreSQL infrastructure. When a user searches "spicy chicken sandwich," pgvector finds semantically similar items like "Nashville hot chicken on a brioche bun." Starting with their existing database saved months of infrastructure work. At DoorDash's scale (~1M active menu items), pgvector handles the load. They noted they'd switch to a dedicated vector DB if they hit 10M+ items or needed sub-10ms latency.

### When To Use / When NOT To Use

| Choose This When | Don't Choose When |
|---|---|
| **FAISS/Chroma**: Prototyping, experiments, < 100K docs | You need managed infrastructure and uptime SLAs |
| **Pinecone**: You want zero infrastructure management | You need data to stay on-premise (regulated) |
| **Qdrant/Milvus**: You need metadata filtering + vector search | You want the simplest possible setup |
| **pgvector**: You already run Postgres, < 1M vectors | You need billion-scale or sub-10ms latency |
| **Weaviate**: Multi-modal data (text + images) | You only have text data |

### Q&A

**Q: Can I just store embeddings in a regular database like Postgres?**
A: Yes, with pgvector. For under 1 million vectors, it works surprisingly well (10-50ms queries). Beyond that, dedicated vector databases are 10-100x faster because they use specialized index structures (HNSW, IVF) optimized for high-dimensional similarity search. The pgvector extension supports HNSW now, but at large scale, purpose-built databases have better memory management and query optimization.

**Q: HNSW vs. IVF — which should I pick?**
A: HNSW for most use cases. It's faster at query time and easier to configure. Choose IVF when: (1) your dataset is so large the HNSW index doesn't fit in RAM, (2) you're combining with product quantization (PQ) to compress vectors, or (3) you're using a GPU-accelerated system like Milvus where IVF+PQ shines. When in doubt, start with HNSW.

**Q: What's "recall" in the context of ANN search, and how much do I lose?**
A: Recall measures what fraction of the *true* top-K neighbors the approximate search actually finds. Most HNSW indexes achieve 95-99% recall — meaning for every 100 queries, the "right" result is missed 1-5 times. In practice, this is almost never the bottleneck. Your chunking and embedding quality matter 10x more than the difference between 96% and 99% ANN recall.

**Q: How much does vector database hosting cost in production?**
A: Rough ranges for 1 million 1024-dimensional vectors: Pinecone serverless ~$25-70/month (usage-based). Self-hosted Qdrant on a decent VM ~$50-100/month. pgvector on an existing Postgres instance ~$0 marginal. FAISS in-memory ~$0 (but you manage everything). These costs are typically 5-10% of your total RAG bill — the LLM generation cost dominates.

**Q: We need to filter by metadata (e.g., "only search documents from the engineering team") — does vector search support that?**
A: Yes, and this is critical for production RAG. Most vector databases support "filtered search" — you apply metadata filters (team=engineering, date>2024-01, access_level=public) *before* or *during* vector search. Pinecone, Qdrant, and Weaviate are especially strong here. This is how you implement access control (Chapter 19): each chunk carries a metadata tag for who can see it, and you filter at query time.

---

## Chapter 8: Keyword Search & Sparse Retrieval

**One-liner**: Keyword search (BM25) finds documents containing the exact terms in your query — and it catches things that semantic search misses.

**Why you should care**: A developer asks your RAG system: "What does error code ERR_SSL_PROTOCOL_ERROR mean?" Your vector search returns chunks about SSL certificates, TLS handshakes, and HTTPS configuration — all *semantically related* but none containing the specific error code. The actual answer is in a troubleshooting page that lists "ERR_SSL_PROTOCOL_ERROR" explicitly. Keyword search finds it instantly. This isn't a niche case — product IDs, error codes, proper nouns, acronyms, and exact phrases all trip up pure vector search.

**Prerequisites**: [Chapter 6: Embeddings](#chapter-6-embeddings--turning-text-into-numbers)

### The Simple Version

Imagine two librarians helping you find a book.

**Librarian A (keyword search)** looks at the exact words you used. You say "quantum entanglement experiments 2024." She checks the index for those exact words and hands you every book that contains them. She's fast and precise — but if a book discusses "quantum correlation tests" (same topic, different words), she misses it.

**Librarian B (vector search)** understands what you *mean*. She'd find the "quantum correlation tests" book. But if you ask for "paper #arXiv:2401.12345," she has no idea — that specific ID has no "meaning" to her, just a string of characters.

You need both librarians.

### How It Actually Works

**BM25** (Best Matching 25) is the gold standard for keyword search. It scores documents based on:

1. **Term frequency** — How often does the query term appear in this document?
2. **Inverse document frequency** — How rare is this term across *all* documents? Rare terms are more important.
3. **Document length normalization** — Short documents with a term match score higher than long documents (the term is a bigger "part" of the document).

```
Query: "kubernetes pod crash restart"

Document A: "When a Kubernetes pod crashes, the kubelet will restart it
             based on the restart policy. CrashLoopBackOff means the
             pod is repeatedly crashing..."
             BM25 Score: 8.7 (many exact term matches)

Document B: "Container orchestration platforms handle failure recovery
             by automatically restarting failed workloads..."
             BM25 Score: 1.2 (no exact matches, related words don't count)
```

*What question does this diagram answer? "How does keyword search rank documents differently from semantic search?"*

**Sparse Retrieval** is the generalized term. BM25 is the most common, but newer approaches include:

| Method | How It Works | When To Use |
|---|---|---|
| **BM25** | Classic term-frequency scoring | Default keyword search; works everywhere |
| **SPLADE** | Learned sparse vectors (like BM25 but trained) | When you want keyword precision + some semantic understanding |
| **TF-IDF** | Simpler predecessor to BM25 | Legacy systems; BM25 is strictly better |

**Infrastructure:**
- **Elasticsearch / OpenSearch** — Full-featured search engines with BM25 built-in. The industry default for keyword search.
- **Built-in to vector DBs** — Qdrant, Weaviate, and Milvus now support BM25 natively alongside vector search.

### Real-World Examples

**Example 1: Wikipedia Search**

Wikipedia serves 6,000+ searches per second. Despite the rise of AI, their core search is still BM25-based (via Elasticsearch). When you search "Treaty of Westphalia 1648," BM25 finds the exact article instantly because the exact terms match. A vector search would also find it — but might also return articles about "European peace agreements" that are semantically similar but not the specific treaty. For encyclopedic content where users search for specific topics, BM25's precision is hard to beat.

**Example 2: Stack Overflow**

Stack Overflow's search handles millions of queries with very specific technical terms: "NullPointerException ArrayList java 11," "segfault mmap MAP_PRIVATE." These queries are full of exact identifiers, version numbers, and error messages. Vector search would find *related* questions but might miss the exact error. BM25 finds exact matches first. Stack Overflow's ranking blends BM25 with other signals (votes, recency, accepted answer status) to surface the most helpful result.

### When To Use / When NOT To Use

| Use Keyword/BM25 When | Don't Use (Alone) When |
|---|---|
| Queries contain exact identifiers (error codes, product IDs, names) | Users ask natural-language questions ("how do I...") |
| Your documents have specific technical terms | Synonyms and paraphrasing matter |
| You need fast, explainable results | The concept matters more than the words |
| Compliance requires traceable matching | Multi-lingual search is needed |

### Q&A

**Q: If BM25 is so old, why hasn't vector search replaced it?**
A: Because they fail on *different* queries. Vector search excels at "what does this mean?" questions. BM25 excels at "find this exact thing" queries. In one benchmark across enterprise search tasks, BM25 alone scored 48% accuracy, vector search alone scored 52%, and combining them scored 68%. Neither alone is enough. This is why hybrid search (Chapter 9) is the production standard.

**Q: I'm already using a vector database. Do I need to add Elasticsearch too?**
A: Not necessarily. Many modern vector databases (Qdrant, Weaviate, Milvus) now support BM25 natively alongside vector search. If yours does, use it — you get hybrid search without a second system. If you're using FAISS or Pinecone (which focuses on vector search), you have two options: add Elasticsearch alongside it, or switch to a database that supports both.

**Q: What about SPLADE? Is it better than BM25?**
A: SPLADE is a *learned* sparse retrieval model — it creates sparse vectors like BM25 but the weights are trained on relevance data. It typically beats BM25 by 5-15% on benchmarks. The trade-off: it requires a model (inference cost), it's harder to set up, and it's less interpretable. For most teams, BM25 is the right default. Consider SPLADE if you're already optimizing the last few percent of retrieval quality.

**Q: How do I handle multilingual keyword search?**
A: BM25 works per-language since it depends on tokenization and term matching. For multilingual RAG, you need either: (1) a separate BM25 index per language, (2) a multilingual search engine configuration (Elasticsearch supports this), or (3) rely more heavily on multilingual vector search (which handles languages natively) and use BM25 only for exact-match terms that are language-independent (product IDs, error codes).

**Q: My users misspell things constantly. BM25 can't handle that, right?**
A: Raw BM25, no — "kubernetez" won't match "kubernetes." But production search engines add fuzzy matching (Elasticsearch's `fuzziness` parameter), stemming ("running" matches "run"), and synonyms. This closes most of the gap. For truly mangled queries, vector search is more robust since embeddings are somewhat spelling-tolerant ("kubernetez" still embeds close to "kubernetes").

---

## Chapter 9: Hybrid Search — Best of Both Worlds

**One-liner**: Hybrid search combines keyword search (BM25) and vector search, then merges the results — giving you both precision on exact terms and understanding of meaning.

**Why you should care**: Remember Chapter 8, where the developer searched for "ERR_SSL_PROTOCOL_ERROR" and vector search failed? And Chapter 6, where the customer searched "I can't log in" and keyword search failed? Hybrid search handles *both* queries correctly. In production RAG systems, hybrid search is the default — not an optimization, a requirement.

**Prerequisites**: [Chapter 6: Embeddings](#chapter-6-embeddings--turning-text-into-numbers), [Chapter 8: Keyword Search](#chapter-8-keyword-search--sparse-retrieval)

### The Simple Version

Imagine you're hiring for a role. You have two recruiters:

**Recruiter A** (keyword) matches resume keywords to job requirements. "5 years Python experience" matches "Python: 6 years." Precise but misses candidates who wrote "proficient in Python programming."

**Recruiter B** (semantic) understands what roles *mean*. They know a "machine learning engineer" and a "data scientist with ML focus" are basically the same. But they might miss that your job requires "Series 65 certification" — a specific license number that has no semantic meaning.

You hire *both*. Each brings candidates. You merge their lists, keeping candidates that either (or both) recruiters recommended. More hires, fewer misses.

### How It Actually Works

Hybrid search has three steps:

```
User Query: "ERR_SSL_PROTOCOL_ERROR troubleshooting chrome"
                    │
         ┌──────────┴──────────┐
         ↓                     ↓
   ┌──────────┐          ┌──────────┐
   │ BM25     │          │ Vector   │
   │ Search   │          │ Search   │
   └────┬─────┘          └────┬─────┘
        │                     │
   Results:               Results:
   1. SSL Error Guide     1. HTTPS Setup Guide
      (score: 9.2)           (score: 0.91)
   2. Chrome SSL FAQ      2. SSL Error Guide
      (score: 7.1)           (score: 0.88)
   3. TLS Config Doc      3. TLS Basics
      (score: 5.3)           (score: 0.85)
        │                     │
        └──────────┬──────────┘
                   ↓
            ┌─────────────┐
            │   FUSION    │  ← Merge & rerank
            └──────┬──────┘
                   ↓
            Final Results:
            1. SSL Error Guide  (appeared in both → high score)
            2. Chrome SSL FAQ   (BM25 exact match on error code)
            3. HTTPS Setup Guide (semantic relevance)
```

*What question does this diagram answer? "How do two different search systems combine into one ranked list?"*

**The Fusion Problem**: BM25 scores and vector similarity scores are on completely different scales (BM25: 0 to 25+, cosine similarity: 0 to 1). You can't just average them. Two popular solutions:

**1. Reciprocal Rank Fusion (RRF)**
Ignores raw scores entirely. Only looks at *rank position*.

```
RRF Score = Σ  1 / (k + rank_i)
             i

Where k is a constant (typically 60) and rank_i is the document's
position in result list i.

Document "SSL Error Guide":
  BM25 rank: 1    → 1/(60+1) = 0.0164
  Vector rank: 2  → 1/(60+2) = 0.0161
  RRF Score: 0.0325

Document "Chrome SSL FAQ":
  BM25 rank: 2    → 1/(60+2) = 0.0161
  Vector rank: 8  → 1/(60+8) = 0.0147
  RRF Score: 0.0308
```

Simple, robust, no tuning needed. The most common choice.

**2. Weighted Linear Combination**
Normalize both score scales to 0-1, then combine with weights.

```
Final Score = α × BM25_normalized + (1 - α) × Vector_normalized

α = 0.3: Favor semantic search (general questions)
α = 0.7: Favor keyword search (technical lookups)
```

More tunable, but requires choosing α for your use case.

### Real-World Examples

**Example 1: Elastic's ELSER + BM25**

Elasticsearch, the most widely deployed search engine, added native hybrid search combining their traditional BM25 with their ELSER (Elastic Learned Sparse Encoder) and dense vector search. Customers using hybrid search saw an average 15-20% improvement in search relevance over either method alone. One enterprise customer processing 2M+ support tickets found that hybrid search reduced "no results" rates from 8% to under 2% — queries that either keyword or semantic search alone would miss.

**Example 2: Perplexity AI**

Perplexity AI, the AI-powered search engine processing millions of queries daily, uses hybrid retrieval under the hood. When you ask Perplexity "What is the latest CUDA version for RTX 4090?", it needs both semantic understanding (what the user is really asking) and exact matching ("CUDA," "RTX 4090" — specific product identifiers). Perplexity combines web-scale sparse and dense retrieval indexes to answer both natural-language and specific technical queries, citing sources for each answer.

### When To Use / When NOT To Use

| Use Hybrid Search When | Skip It When |
|---|---|
| Production RAG with real users | Quick prototype on clean data |
| Mix of natural-language and exact-term queries | All queries are the same type (either all conversational OR all exact lookups) |
| Enterprise search across diverse document types | Dataset is tiny (<1,000 chunks) |
| You can't predict how users will phrase queries | You've proven pure vector search works on your benchmark |

### Q&A

**Q: Which fusion method should I use — RRF or weighted combination?**
A: Start with RRF. It's parameter-free, robust, and works well in most scenarios. Switch to weighted combination only if you have a labeled evaluation set and can tune α. In benchmarks, RRF and well-tuned weighted combination perform similarly — but a *poorly* tuned α makes weighted combination worse than either method alone. RRF is the safe default.

**Q: What ratio of keyword vs. vector results should I retrieve before fusion?**
A: Retrieve the same number from each — typically 20-50 from each search method, then fuse to a final top-K (usually 5-10 for the LLM context). Retrieving more candidates before fusion gives the fusion step more to work with. The cost is minimal since retrieval is cheap; the LLM call (which only sees the final top-K) is where cost matters.

**Q: Does hybrid search double my infrastructure costs?**
A: Not if you use a database that supports both natively (Qdrant, Weaviate, Elasticsearch). You store chunks once and run both searches against the same dataset. If you're running separate systems (FAISS + Elasticsearch), yes — you're maintaining two indexes. The operational complexity is the real cost, not the compute.

**Q: If I add a reranker (Chapter 11), do I still need hybrid search?**
A: Yes — they solve different problems. Hybrid search ensures you *retrieve* relevant candidates from different search paradigms. A reranker *re-scores* whatever candidates you give it. A reranker can't rescue results that were never retrieved. Think of hybrid search as casting a wider net, and the reranker as sorting the catch. Use both.

**Q: We're a healthcare company. Our doctors search for both drug names (exact) and symptoms (semantic). Is hybrid search the answer?**
A: Textbook hybrid search use case. "metformin 500mg side effects" needs exact matching on "metformin 500mg" and semantic matching on "side effects" (which might match "adverse reactions" or "common complaints"). Hybrid search handles both in a single query. One healthcare RAG system reported that hybrid search improved medication-related query accuracy from 71% (vector only) to 89%.

---

## Putting It Together: Building a Document Search Engine

Let's combine everything from Part 2 into a real system.

### The Scenario

You're building documentation search for a developer tools company. The knowledge base has 5,000 technical articles: API references, how-to guides, troubleshooting pages, and changelog entries. Developers query it with everything from natural-language questions ("how do I authenticate with OAuth?") to exact lookups ("error code 4012").

### The Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     INDEXING PIPELINE                             │
│                                                                   │
│  5,000 articles                                                  │
│       ↓                                                           │
│  Parse HTML → Extract sections by <h2>/<h3> headers              │
│       ↓                                                           │
│  Structural chunking (keep code blocks intact)                   │
│  Average chunk: ~300 tokens, range: 100-800                      │
│       ↓                                                           │
│  Embed with text-embedding-3-small (1536 dims)                   │
│       ↓                                                           │
│  Store in Qdrant with metadata:                                  │
│    { article_title, section, url, product, last_updated }        │
│       ↓                                                           │
│  Also index in Qdrant's BM25 full-text search                   │
│                                                                   │
│  Total: ~25,000 chunks, indexed in ~10 minutes                   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     QUERY PIPELINE                                │
│                                                                   │
│  Developer: "error code 4012 when using OAuth"                   │
│       ↓                                                           │
│  Embed query (same model: text-embedding-3-small)                │
│       ↓                                                           │
│  Hybrid search:                                                  │
│    BM25 → top 20 results (catches "4012" exact match)            │
│    Vector → top 20 results (catches OAuth-related content)       │
│       ↓                                                           │
│  RRF fusion → top 10 merged results                              │
│       ↓                                                           │
│  [Part 3 adds: reranker, query rewriting, prompt engineering]    │
│       ↓                                                           │
│  LLM generates answer with citations                             │
└─────────────────────────────────────────────────────────────────┘
```

### What This System Gets Right

1. **Structural chunking** preserves code examples and section context (Chapter 5)
2. **Purpose-fit embeddings** that handle technical content (Chapter 6)
3. **Metadata storage** enables filtering by product, date, and section (Chapter 7)
4. **Hybrid search** catches both "error code 4012" (keyword) and "authentication issues" (semantic) (Chapters 8-9)
5. **Single database** (Qdrant) handles both vector and keyword search — no Elasticsearch needed

### What's Still Missing (Covered in Part 3)

| Gap | Impact | Fix (Part 3) |
|---|---|---|
| No reranker | Top-1 result isn't always the best match | Add cross-encoder reranker (Ch. 11) |
| No query rewriting | "that thing I asked about before" fails | Add query transformation (Ch. 12) |
| Raw prompt | LLM sometimes ignores context or adds facts | Engineered RAG prompt (Ch. 10) |
| No conversation memory | Follow-up questions lose context | Conversational RAG (Ch. 14) |

### Key Takeaway

The retrieval stack is the *foundation* of your RAG system. Every dollar spent improving retrieval quality pays dividends in answer quality — because the best LLM in the world can't generate a good answer from bad context. The techniques in this part (smart chunking, good embeddings, hybrid search) are where most RAG improvements come from. In Part 3, we'll refine the signal: reranking, query rewriting, and prompt engineering turn good retrieval into great answers.
