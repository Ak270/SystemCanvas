# SystemCanvas — Content Creation Rules & Book Plan

## Vision

A website with "books" on technical subjects (System Design, Distributed Systems, etc.).
Each book teaches the subject from zero to advanced — like a smart friend explaining over coffee.
Less content, but everything that matters. No filler. No fluff.

---

## The Science: Why These Rules Exist

These rules come from research on how the human brain actually learns. Every rule maps to a proven principle:

| Principle | Source | What It Means For Us |
|-----------|--------|---------------------|
| Working memory holds ~4 items | Cowan (2001), Cognitive Load Theory (Sweller) | Max 4 core ideas per section. Group related facts into named chunks. |
| Analogy activates frontoparietal network | fMRI studies (PMC2951846) | Brain literally searches for stored patterns that match. Every concept needs a real-life analogy FIRST. |
| Concrete organizers beat abstract ones | Advance organizer studies (Bruner) | Lead with a real example, never a definition. "Netflix does X" beats "X is defined as..." |
| Active recall is 3x more effective than re-reading | Dunlosky et al. (2013) meta-analysis | Q&A sections that force retrieval, not recognition. |
| Spaced repetition strengthens long-term memory | Ebbinghaus + modern studies | Reference earlier topics in later chapters = free spaced repetition. |
| Dual coding: text + visuals together | Paivio's dual coding theory | Diagrams for flows. Tables for comparisons. Every visual must answer a question. |
| Zone of Proximal Development | Vygotsky | Each topic stretches exactly one step beyond the previous. State prerequisites. |
| Feynman Technique | Retrieval practice research | If you can't explain it in simple words, you don't understand it enough to write it. |
| SUCCESs framework | "Made to Stick" (Heath brothers) | Content that sticks is: Simple, Unexpected, Concrete, Credible, Emotional, Story-driven. |
| Why technical books fail | Head First research + reader complaints (HN/Reddit) | Walls of text, definition-first, no testing, jargon without anchoring, no visuals. |

---

## The 10 Rules of Writing (Apply to ALL Subjects)

### Rule 1: Analogy First, Technical Second

The brain learns new things by mapping them to things it already knows. fMRI studies show this literally activates pattern-matching circuits in the brain.

**Every concept gets two layers:**
- **Layer 1**: A dead-simple analogy from everyday life (no jargon, no tech words)
- **Layer 2**: The real technical version, building on that analogy

> **Example**:
> *Layer 1*: "A load balancer is like a restaurant host. When customers walk in, the host doesn't send everyone to the same waiter. They spread people across all waiters so nobody gets overwhelmed."
>
> *Layer 2*: "A load balancer distributes incoming network traffic across multiple servers using algorithms like round robin, least connections, or consistent hashing."

**Why this works**: The analogy creates a "shelf" in the brain. The technical details then have somewhere to land.

### Rule 2: Concrete Before Abstract — Always

Research shows students recall significantly more when given concrete examples BEFORE the abstract principle. Abstract-first explanations perform no better than no explanation at all.

**Never open a topic with a definition.** Always open with:
- A scenario ("Your app suddenly gets 10x users overnight...")
- A real company ("Netflix serves videos from servers near you...")
- A problem ("Two users edit the same document at the same time...")

> **Bad**: "A CDN is a geographically distributed network of proxy servers."
> **Good**: "Netflix streams videos to 200 million users across the world. A user in Tokyo and one in London both get fast streaming. How? Netflix puts copies of popular videos on servers close to users everywhere. That's a CDN."

### Rule 3: The 4-Item Rule (Respect Working Memory)

Working memory holds ~4 items. Anything beyond that creates overload and nothing sticks.

- **Max 4 core ideas per section**
- **Max 150 words per core explanation** (before examples/Q&A)
- **One idea per paragraph**, max 3 sentences
- **Group related concepts into named chunks** (e.g., "The Database Toolkit" = indexing + sharding + replication)
- No filler phrases ("It is important to note that...", "As we all know...")
- Prefer tables and bullet points over paragraphs

### Rule 4: Build a Mental Map Before Details

The brain needs to know WHERE to file new information before it can absorb it. Without context, facts float disconnected and are forgotten.

**Every chapter opens with:**
1. **One-line summary**: What this chapter is about
2. **Why you should care**: A real scenario where this matters (make them feel it — "Your app goes down at 3AM and 10,000 users can't pay")
3. **Prerequisites**: What you should already know (link to those chapters)
4. **The big picture**: How this fits into the overall system

### Rule 5: Real Company Examples — Every Single Topic

Don't just explain *what* it is. Show *where* it lives in the wild. Real companies make content credible and concrete (two of the six SUCCESs traits).

**Each topic must include:**
- **What it is** (1-2 sentences, plain English)
- **Why it exists** (what problem does it solve — tell a story)
- **How it works** (simple mechanics, with a diagram)
- **Real-world example** ("WhatsApp uses Cassandra because...", "Uber uses geo-hashing to...")
- **When to use / when NOT to use** (explicit trade-offs, with a table)

**Minimum 2 different company examples per topic.** One for "how it's used" and one for "what happens when you don't use it" or "an alternative approach."

### Rule 6: Q&A That Forces Active Recall

Reading feels like learning but isn't. Dunlosky's meta-analysis (2013) found active recall is the single most effective study technique. Our Q&A sections are the most important part of each topic.

**After each topic, include 4-5 Q&A pairs:**

| Type | Purpose | Example |
|------|---------|---------|
| The "dumb" question | Validates basic understanding | "Wait, so is a cache just... RAM?" |
| The follow-up | Tests deeper thinking | "If we cache everything, when does the cache become stale?" |
| The comparison | Forces discrimination between similar concepts | "How is sharding different from replication?" |
| The real-world design | Applies concept to a system | "You're designing Twitter. Where would you put a cache and why?" |
| The failure scenario | Tests edge-case thinking | "What happens to your cache if one server dies?" |

**Important**: Questions must force *retrieval* ("What problem does sharding solve?"), not *recognition* ("Sharding splits data across machines: True/False?"). Retrieval is 3x more effective.

### Rule 7: Progressive Complexity With Callbacks

Topics are ordered in a dependency graph (Layer 1 → Layer 7). Each topic stretches exactly one step beyond the previous one (Vygotsky's Zone of Proximal Development).

**Later topics explicitly reference earlier ones:**
- Caching chapter: "Remember the load balancer from Chapter 9? A cache sits between it and the database."
- Sharding chapter: "This is like horizontal scaling (Chapter 2), but for your database specifically."
- Event-Driven chapter: "Remember message queues from Chapter 17? Now imagine every service in your system communicating through them."

**Why this works**: Each callback is a free spaced-repetition event. It strengthens the memory of the earlier concept while building the new one.

**Scaffolding rule**: Early chapters use more analogies and hand-holding. Later chapters assume the reader's vocabulary. Gradually remove training wheels.

### Rule 8: Show the System, Not Just the Parts

Knowing what a load balancer does is useless if you can't see it working inside a real system. Every section ends with a **"Putting It Together"** mini-design that shows 3-4 concepts from that section working together.

This is where understanding clicks — when parts become a whole.

### Rule 9: Every Visual Must Answer a Question

Dual coding (text + visuals) improves retention, but only when the visual carries meaning the text doesn't. No decorative images.

- **Diagrams** → for flows and architectures ("Where does data go?")
- **Tables** → for comparisons with trade-offs ("Which option fits which case?")
- **Numbered step lists** → for processes ("What happens in what order?")

Every visual gets a caption that states what question it answers.

### Rule 10: Make Them Feel It (The SUCCESs Rule)

Content that sticks is: **S**imple, **U**nexpected, **C**oncrete, **C**redible, **E**motional, **S**tories.

- **Simple**: Strip to the essential message. Not dumbing down — prioritizing.
- **Unexpected**: Break expectations. "Your database can handle 1 million reads/second but only 1,000 writes" grabs attention.
- **Concrete**: Tangible language. "A server 50 miles away" beats "reduced latency."
- **Credible**: Real numbers. "WhatsApp handles 10 billion messages/day on just 50 engineers."
- **Emotional**: Make them care. "Your app goes down at 3AM..." beats "availability is important."
- **Stories**: "Here's how a message gets from you to your friend on WhatsApp" is a story. "Message queues decouple services" is a definition.

---

## Topic Template (Every Topic Follows This Structure)

```
## [Topic Name]

**One-liner**: [What this topic is, in one sentence]
**Why you should care**: [A scenario that makes them feel the problem]
**Prerequisites**: [Links to earlier topics they need]

### The Simple Version
[Everyday analogy — no tech words. 3-5 sentences.]

### How It Actually Works
[Technical explanation building on the analogy. Max 150 words. Include a diagram.]

### Real-World Examples
[Minimum 2 company examples with concrete numbers]

**Example 1: [Company]**
[How they use this concept and why]

**Example 2: [Company]**
[A different approach or what happens without it]

### When To Use / When NOT To Use
[Table with trade-offs]

| Use When | Don't Use When |
|----------|---------------|
| ...      | ...            |

### Q&A
[4-5 questions following the types in Rule 6]

**Q: [The "dumb" question]**
A: [Answer]

**Q: [The follow-up]**
A: [Answer]

... (3 more)
```

---

## Content Quality Checklist (Before Publishing Any Topic)

- [ ] Can a non-engineer understand the analogy/simple version?
- [ ] Does it open with a concrete example, NOT a definition?
- [ ] Are there minimum 2 real company examples with numbers?
- [ ] Is the core explanation under 150 words?
- [ ] Are there 4-5 Q&A pairs (retrieval, not recognition)?
- [ ] Does it reference a previous topic (callback)?
- [ ] Is there a clear "when to use / when NOT to use" section?
- [ ] Does every visual answer a specific question?
- [ ] Zero filler sentences?
- [ ] Does it make them *feel* the problem before solving it?
- [ ] Max 4 core ideas in any single section?

---

## Content Ratio Per Topic

Based on research (Head First series, ByteByteGo, Educative):

| Component | % of Topic | Purpose |
|-----------|-----------|---------|
| Simple analogy | 10% | Hook + anchor to existing knowledge |
| Core explanation | 20% | The real concept, plain language |
| Visual/diagram | 15% | Spatial understanding, dual coding |
| Real-world examples | 25% | Concrete + credible |
| Q&A / exercises | 20% | Active recall + retrieval practice |
| Trade-offs / when not to use | 10% | Decision-making skill |

**Target**: ~30% theory, ~40% examples, ~30% practice/Q&A.

---

## Rules for Future Subjects

When adding a new book (Distributed Systems, Databases, Operating Systems, etc.):

1. **Reuse all 10 Rules above** — they apply to every subject
2. **Don't repeat content** — if System Design covers caching, the Databases book links to it
3. **Each book has its own "Putting It Together" examples** relevant to that domain
4. **Max 40 topics per book** — if you have more, split into two books
5. **Every book starts with "Who is this for?" and "What you'll learn"**
6. **Research the subject's dependency graph first** — order topics by what depends on what
7. **Identify the top 5 "worked examples" for that domain** — capstone projects that tie concepts together
8. **Find what competing resources miss** — that's our edge

---

## Research Sources

This plan is based on research from:
- **Learning Science**: Cognitive Load Theory (Sweller), Chunking (Cowan 2001), fMRI analogy studies, Dunlosky meta-analysis (2013), Vygotsky ZPD, Paivio dual coding, Feynman Technique
- **Content Design**: "Made to Stick" (Heath brothers), Head First series methodology
- **System Design Curriculum**: DDIA (Kleppmann), System Design Interview (Alex Xu Vol 1 & 2), Grokking System Design (DesignGurus), ByteByteGo, Stanford/MIT distributed systems courses
- **Reader Feedback**: Common complaints on HN, Reddit about technical books
