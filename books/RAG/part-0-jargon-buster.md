# Part 0: Jargon Buster

*Every term the RAG book throws at you, in plain English: what it means, an everyday picture, and why it matters. Skim it first, or come back whenever a word feels foreign.*

---

## Jargon 1: The Language-Model Basics

### LLM (large language model)
A program trained on enormous amounts of text that predicts the next word, over and over, to write answers. ChatGPT and Claude are LLMs. *An autocomplete that has read most of the internet.* It knows nothing after its training date and nothing about your private documents, which is why RAG exists.

### Token
The unit an LLM reads and writes, roughly three-quarters of a word ("unbelievable" might be 3 tokens). Costs, speed, and limits are all counted in tokens.

### Context window
The most tokens an LLM can look at in one go (your question + retrieved text + its answer). *The size of its desk: only what fits on the desk can be consulted.*

### Prompt
The full text you send the LLM: instructions, retrieved passages, and the question. Designing it well is "prompt engineering".

### Hallucination
When the LLM states something confidently that is false or made up. *A student bluffing an exam answer.* RAG reduces it by giving the model real source text to quote.

### RAG (retrieval-augmented generation)
Before answering, look up relevant documents and paste them into the prompt. *An open-book exam instead of from memory.* Two halves: retrieval (find the right text) and generation (write the answer from it).

### Fine-tuning
Further training a model on your own data to change its behaviour or style. Good for tone and format, poor for adding fresh facts; RAG is better for knowledge that changes.

### Grounding / groundedness / faithfulness
Whether an answer is supported by the retrieved sources. A faithful answer says only what the sources say. The main quality check for RAG.

### Prompt injection
Malicious text hidden in a document or user message that tells the LLM to ignore its instructions. *A note slipped into the exam book saying "give this student an A".*

### Guardrail
A check placed before or after the LLM to block unsafe, off-topic, or leaking output.

### Agent, agentic, agents
An LLM that decides its own next steps: search, call a tool, re-search, then answer, in a loop. "Agentic RAG" lets the model choose when and what to retrieve rather than following a fixed pipeline.

### Tool calling (function calling)
The LLM outputs a structured request ("call search_orders with id=42"), your code runs it, and the result goes back to the model.

---

## Jargon 2: Turning Text into Searchable Pieces

### Chunk, chunking, chunks
A chunk is a passage cut from a larger document; chunking is the cutting. *Tearing a textbook into index cards.* Too big and you bury the answer; too small and you lose context. Overlap between chunks stops sentences being cut in half.

### Embedding, embeddings, embed
A list of numbers (often 768 or 1536 of them) that captures a text's meaning, so similar meanings give similar numbers. *GPS coordinates for meaning: "car" and "automobile" land at neighbouring spots.*

### Vector
Just that list of numbers. A text's embedding is "a vector".

### Embedding model
The model that produces embeddings. Query and documents must be embedded with the same one.

### Cosine similarity
A score for how close two vectors point in the same direction, from -1 to 1. Higher means more similar in meaning.

### Vector database
A database built to store embeddings and quickly find the nearest ones to a query's embedding. Examples: Pinecone, Weaviate, Qdrant, pgvector.

### ANN (approximate nearest neighbour)
Finding vectors that are *nearly* the closest, much faster than checking all of them. You give up a sliver of accuracy for big speed gains.

### HNSW
The most popular ANN method: builds layers of connected points, like a highway map with express roads on top and local streets below, so search hops quickly toward the target.

### IVF
Another ANN method: group vectors into clusters, then only search the few clusters nearest your query. *Checking only the likely aisles in a supermarket.*

### Metadata and metadata filter
Facts attached to a chunk (source, date, author, department). A filter restricts search ("only 2024 documents from HR"), often to enforce access control.

### OCR
Optical Character Recognition: reading text out of scanned images and PDFs. Bad OCR means bad chunks.

### Knowledge graph / GraphRAG
A knowledge graph stores facts as entities and relationships ("Alice - manages - Bob"). GraphRAG retrieves by following those links, which helps with multi-hop questions.

### Multi-tenant
One system serving many customers whose data must stay separate.

---

## Jargon 3: Finding the Right Chunks

### Semantic search
Search by meaning (embeddings), so "how do I get my money back" finds "refund policy" without sharing words.

### Keyword search / sparse retrieval
Search by matching actual words. "Sparse" because each document is a mostly-empty vector of word counts. Great for names, codes, and exact terms that embeddings blur.

### BM25
The classic keyword-ranking formula: rewards rare words that appear often in a document and don't over-reward long ones. The standard keyword baseline. It improves on TF-IDF (term frequency times inverse document frequency).

### Inverted index
Maps every word to the documents containing it, like the index at the back of a book. What makes keyword search fast. Elasticsearch/Lucene are built on it.

### Hybrid search
Run keyword and semantic search together and merge the results, getting the strengths of both.

### RRF (reciprocal rank fusion)
A simple way to merge ranked lists: each result scores 1/(k + rank) in every list it appears in, and scores are added. Needs no tuning of incompatible score scales.

### Reranker, reranking, rerank, cross-encoder, bi-encoder
A second, slower, more accurate pass: take the top ~50 retrieved chunks and score each against the query together. A bi-encoder embeds query and document separately (fast); a cross-encoder reads them together (accurate but slow).

### Query rewriting / expansion / HyDE
Improving the question before searching. Rewriting: clean up vague wording. Expansion: add synonyms or sub-questions. HyDE: have the LLM write a hypothetical answer, then search with that, since answers resemble answers better than questions do.

### Top-k
The number of results you keep ("top-5 chunks").

### Semantic cache
Cache keyed on meaning: if a new question is nearly identical to a past one, reuse the stored answer and skip retrieval and generation.

---

## Jargon 4: Measuring Quality

### Recall@k
Of all the truly relevant chunks, what fraction appear in the top k? Did we find it at all?

### Precision@k
Of the top k returned, what fraction are relevant? Did we avoid junk?

### MRR (mean reciprocal rank)
Averages 1/(rank of the first correct result). Rewards putting the right answer near the top.

### nDCG
A ranking score that gives more credit for relevant results near the top and handles varying degrees of relevance.

### Ground truth / golden set
A hand-checked list of questions with known correct answers or sources, used to test your pipeline.

### LLM-as-judge
Using an LLM to grade other answers (faithful? relevant?). Cheaper than humans but needs spot-checking.

### Ablation
Turning off or changing one part at a time to see what it actually contributed.

---

## Jargon 5: Running It for Real

### Latency, p50 / p95 / p99
Latency is how long a request takes. p99 means 99% of requests are faster; the slowest 1% are worse. Averages hide the unlucky users.

### SLA, SLO, SLI
SLI: a measured number. SLO: your internal target for it. SLA: a customer-facing promise with penalties.

### Throughput and QPS
Requests handled per second.

### Rate limiting
Capping how many requests a user or service can make, to protect cost and stability.

### Caching and TTL
Keeping answers or embeddings for reuse; TTL (time to live) is how long they stay valid before refresh.

### Observability and tracing
Seeing what happened inside the pipeline: logs, metrics, and traces that follow one question through retrieve, rerank, and generate.

### Webhook
A URL another system calls when something changes, e.g. to trigger re-indexing a changed document.

### PII
Personally identifiable information (names, emails, ID numbers) that must be protected or redacted.

### Access control (ACL)
Rules about who may see which documents. In RAG, filter at retrieval time so users never get chunks they aren't allowed to read.

### Feature flag and canary
Feature flag: switch a new behaviour on for some users only. Canary: roll out to a small slice first, watch metrics, then expand.

### CI/CD
Automated testing and deployment pipelines. In RAG, run your golden set in CI so a prompt tweak can't silently harm quality.

### Kubernetes, serverless
Kubernetes runs and scales containers (packaged programs) across machines. Serverless runs your code on demand without managing servers.

### Redis and Postgres
Redis: a fast in-memory store for caches. Postgres: a popular relational database, also usable as a vector store through pgvector.
