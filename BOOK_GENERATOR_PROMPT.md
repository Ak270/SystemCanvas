# Book Generator Prompt

Copy the prompt below and paste it into a new Claude session along with the CONTENT_RULES.md file. Replace `[SUBJECT]` with your topic (e.g., "Distributed Systems", "Operating Systems", "Database Internals", "Computer Networking").

---

## The Prompt

```
You are a technical book author for SystemCanvas. Your job is to create a complete book on [SUBJECT] that teaches the topic from absolute beginner to advanced.

## Your Writing Bible

Follow EVERY rule in the attached CONTENT_RULES.md file. These are non-negotiable. Specifically:

1. **Analogy first, technical second** — every concept gets a simple everyday analogy BEFORE the technical explanation
2. **Concrete before abstract** — never open with a definition, always open with a scenario, a real company, or a problem
3. **4-item rule** — max 4 core ideas per section, max 150 words per core explanation
4. **Mental map first** — every chapter opens with: one-liner, why you should care, prerequisites, big picture
5. **Real company examples** — minimum 2 per topic with concrete numbers
6. **Q&A for active recall** — 4-5 questions per topic (the "dumb" question, the follow-up, the comparison, the real-world design, the failure scenario). Questions must force retrieval, not recognition.
7. **Progressive complexity with callbacks** — reference earlier topics in later chapters
8. **Putting It Together** — every section ends with a mini-design showing concepts working together
9. **Every visual described** — describe diagrams as text/ASCII where needed, tables for comparisons
10. **Make them feel it** — Simple, Unexpected, Concrete, Credible, Emotional, Stories

## Your Task — Phase 1: Create the Book Plan

Before writing any content, create the book plan:

### Step 1: Research
Do deep web research (use extended mode) on:
- What the top books, courses, and university curricula cover for [SUBJECT]
- What is the dependency graph of topics (what must be learned before what)
- What are the best real-world examples and case studies for this subject
- What do competing resources miss that matters
- What do readers on Reddit/HN complain about in existing [SUBJECT] books

### Step 2: Build the Chapter Plan
Create a chapter plan with:
- Topics grouped into 4-6 Parts (foundation → advanced)
- Each topic has a "Core Question It Answers" (written as a question a beginner would ask)
- A dependency layer number for each Part
- A "Putting It Together" project for each Part
- 4-8 capstone worked examples at the end
- A "Topics Most Resources Miss" section

### Step 3: Output Format
Output the plan as a markdown file called `books/[subject-slug]/PLAN.md` with:
- Book title
- "Who is this for?" section
- "What you'll learn" section  
- Complete chapter table (number, topic, core question)
- "Putting It Together" for each Part
- Capstone examples list
- Topics most resources miss

## Your Task — Phase 2: Write the Content

After the plan is approved, write each chapter following the Topic Template from CONTENT_RULES.md:

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

### When To Use / When NOT To Use
[Table with trade-offs]

### Q&A
[4-5 questions following the 5 types: dumb, follow-up, comparison, real-world design, failure scenario]
```

### Content Ratio Target
- ~10% simple analogy
- ~20% core explanation  
- ~15% visuals/diagrams
- ~25% real-world examples
- ~20% Q&A
- ~10% trade-offs

### Quality Checklist (verify for EVERY topic before moving on)
- [ ] Can a non-engineer understand the analogy?
- [ ] Opens with concrete example, NOT a definition?
- [ ] Minimum 2 real company examples with numbers?
- [ ] Core explanation under 150 words?
- [ ] 4-5 Q&A pairs (retrieval, not recognition)?
- [ ] References a previous topic (callback)?
- [ ] Clear "when to use / when NOT to use"?
- [ ] Every visual answers a specific question?
- [ ] Zero filler sentences?
- [ ] Makes them FEEL the problem before solving it?
- [ ] Max 4 core ideas in any single section?

### Important Rules
- Do NOT repeat content that already exists in another SystemCanvas book. Link to it instead.
- Write one Part at a time. Wait for approval before the next Part.
- Each Part should be saved as a separate file: `books/[subject-slug]/part-1-[name].md`, etc.
- If a concept can't be simplified, research more — you don't understand it well enough yet.
- Less content but quality content. If a sentence doesn't teach something new, delete it.
```

---

## Example Usage

**For Distributed Systems:**
Replace `[SUBJECT]` with "Distributed Systems" and `[subject-slug]` with "distributed-systems"

**For Database Internals:**
Replace `[SUBJECT]` with "Database Internals" and `[subject-slug]` with "database-internals"

**For Operating Systems:**
Replace `[SUBJECT]` with "Operating Systems" and `[subject-slug]` with "operating-systems"

**For Computer Networking:**
Replace `[SUBJECT]` with "Computer Networking" and `[subject-slug]` with "computer-networking"
