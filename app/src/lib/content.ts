const raw = import.meta.glob(['../../../books/*/*.md', '../../../books/*/*/*.md'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

export type QA = { q: string; a: string }
export type Section = { id: string; title: string; body: string; qa?: QA[] }
export type Unit = {
  id: string
  label: string // "Chapter 3", "Design 2", "Capstone"
  title: string
  partNo: number
  oneLiner?: string
  why?: string
  prereq?: string
  prereqLabel?: string
  intro: string
  sections: Section[]
  words: number
  minutes: number
}
export type Term = { term: string; def: string }
type Alias = Term & { alias: string; exact: boolean }
export type Glossary = { terms: Map<string, Alias>; re: RegExp | null }
export type Part = { no: number; title: string; blurb: string; units: Unit[] }
export type Book = {
  slug: string
  title: string
  tagline: string
  audience: string
  status: 'ready' | 'planned'
  parts: Part[]
  plan: string
  units: Unit[]
  minutes: number
  glossary: Glossary
}

const clean = (t: string) =>
  t
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()

/** Title, tagline and audience come from PLAN.md when present, so a new folder needs no registration. */
function describe(slug: string, plan: string, parts: Part[]) {
  const h1 = plan.match(/^## Book Title\s*\n+\*\*(.+?)\*\*/m)?.[1] ?? plan.match(/^# (.+)$/m)?.[1]
  const [name, ...sub] = h1 ? clean(h1).split(/\s*[:—–]\s+/) : []
  const title = name || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  const afterH1 = h1 ? plan.slice(plan.indexOf(h1) + h1.length) : ''
  const bold = afterH1.split(/^## /m)[0].match(/^\*\*(.+?)\*\*\s*$/m)?.[1]
  const who = plan.match(/^## Who Is This For\?\s*\n+([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? ''
  const para = who.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('|'))
  const audience = para ? clean(para.replace(/^[-*]\s+/, '')).split(/(?<=\.)\s/)[0] : ''
  const tagline = (bold && clean(bold)) || sub.join(': ') || parts[0]?.blurb || audience.split(/(?<=\.)\s/)[0] || ''
  return { title, tagline, audience }
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')

const field = (body: string, name: string) => {
  const m = body.match(new RegExp(`^\\*\\*${name}(?::\\*\\*|\\*\\*:)\\s*(.+)$`, 'm'))
  return m ? { value: m[1].trim(), rest: body.replace(m[0], '') } : { value: undefined, rest: body }
}

const stripRules = (s: string) => s.replace(/^\s*---\s*$/gm, '').trim()

function parseQA(body: string): QA[] {
  const out: QA[] = []
  const re = /\*\*Q:\s*([\s\S]*?)\*\*\s*\n+A:\s*([\s\S]*?)(?=\n\s*\*\*Q:|\s*$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out.push({ q: m[1].trim(), a: stripRules(m[2]) })
  return out
}

function parseUnit(chunk: string, partNo: number): Unit {
  const nl = chunk.indexOf('\n')
  const heading = chunk.slice(0, nl).trim()
  let body = chunk.slice(nl + 1)

  const m = heading.match(/^([A-Za-z][A-Za-z ]*?) (\d+):\s*(.+)$/)
  const capstone = /^Putting It Together/i.test(heading)
  const label = m ? `${m[1]} ${m[2]}` : capstone ? 'Capstone' : 'Section'
  const title = m ? m[3] : heading.replace(/^Putting It Together:?\s*/i, '') || heading
  const id = m ? `${slugify(m[1])}-${m[2]}` : `part-${partNo}-${slugify(heading) || 'section'}`

  const one = field(body, 'One-liner')
  const why = field(one.rest, 'Why you should care')
  const pre = field(why.rest, 'Prerequisites')
  body = pre.rest

  const [introRaw, ...secRaw] = body.split(/^### /m)
  const sections: Section[] = secRaw.map((s) => {
    const i = s.indexOf('\n')
    const t = s.slice(0, i).trim()
    const b = stripRules(s.slice(i + 1))
    const isQA = /^Q&A/i.test(t)
    const qa = isQA ? parseQA(b) : undefined
    return { id: slugify(t), title: t, body: b, qa: qa && qa.length ? qa : undefined }
  })

  const words = chunk.split(/\s+/).length
  return {
    id,
    label,
    title,
    partNo,
    oneLiner: one.value && clean(one.value),
    why: why.value && clean(why.value),
    prereq: pre.value && clean(pre.value),
    intro: stripRules(introRaw),
    sections,
    words,
    minutes: Math.max(1, Math.round(words / 210)),
  }
}

/** One chapter per file (books/<slug>/partN/chNN-*.md): `# Title`, a lede blockquote, a bold meta line, then `##` sections. */
function parseChapterFile(src: string, partNo: number): Unit {
  const nl = src.indexOf('\n')
  const unit = parseUnit(src.slice(0, nl).replace(/^# /, '') + '\n' + src.slice(nl + 1), partNo)
  let body = src.slice(nl + 1)

  const quote = body.match(/^>\s*(.+(?:\n>.*)*)/m)
  if (quote) {
    unit.oneLiner = clean(quote[1].replace(/^>\s?/gm, ' ').replace(/^\s*Exercise:\s*/i, '').replace(/\*/g, ''))
    body = body.replace(quote[0], '')
  }
  const meta = body.match(/^\*\*(Prerequisites|Concepts exercised)\*\*:\s*(.+)$/m)
  if (meta) {
    unit.prereq = clean(meta[2])
    unit.prereqLabel = meta[1] === 'Prerequisites' ? 'Before this' : 'Concepts'
    body = body.replace(meta[0], '')
  }

  const [introRaw, ...secRaw] = body.split(/^## /m)
  unit.intro = stripRules(introRaw)
  unit.sections = secRaw.map((c) => {
    const i = c.indexOf('\n')
    const t = c.slice(0, i).trim()
    return { id: slugify(t), title: t, body: stripRules(c.slice(i + 1)) }
  })
  unit.why = undefined
  return unit
}

/** Part titles and blurbs live in README.md / PLAN.md as `### Part N: Title` followed by an italic line. */
function partMeta(docs: string[]) {
  const out: Record<number, { title: string; blurb: string }> = {}
  for (const doc of docs)
    for (const m of doc.matchAll(/^### Part (\d+):\s*(.+?)(?:\s+\(Layer.*\))?\s*\n+\*?([^\n|#]*)/gm))
      out[Number(m[1])] ??= { title: m[2].trim(), blurb: m[3].replace(/^\*|\*$/g, '').trim() }
  return out
}

function parsePart(src: string, fallbackNo: number): Part {
  const [head, ...chunks] = src.split(/^## /m)
  const h = head.match(/^# Part (\d+):\s*(.+?)(?:\s+[—–-]\s+.*)?$/m)
  const no = h ? Number(h[1]) : fallbackNo
  const blurb = clean(head.match(/^\*(.+)\*\s*$/m)?.[1] ?? head.match(/^>\s*\*\*What this part covers\*\*:\s*(.+)$/m)?.[1] ?? '')
  return { no, title: h ? h[2].trim() : `Part ${no}`, blurb, units: chunks.map((c) => parseUnit(c, no)) }
}


/* ── glossary: part-0-jargon-buster.md is not a chapter; its entries become hover definitions ── */
const isGlossaryFile = (file: string) => /jargon|glossary/i.test(file)

const aliasesOf = (title: string) =>
  [...new Set(
    title
      .replace(/\(([^)]*)\)/g, ', $1')
      .split(/\s*(?:,|\/|:|&|\bvs\.?\b|\bor\b|\band\b)\s*/i)
      .map((a) => clean(a))
      .filter((a) => a.length >= 3 || (a.length >= 2 && a === a.toUpperCase())),
  )]

function parseGlossary(src: string): Glossary {
  const terms = new Map<string, Alias>()
  for (const chunk of src.split(/^### /m).slice(1)) {
    const nl = chunk.indexOf('\n')
    const title = clean(chunk.slice(0, nl))
    const def = stripRules(chunk.slice(nl + 1).split(/^## /m)[0]).replace(/\n+/g, ' ')
    if (!title || !def) continue
    const names = aliasesOf(title)
    // synonyms already contained in a longer name ('Stateless server, stateless') read as noise in the card title
    const shown = names.filter((n) => !names.some((o) => o !== n && o.toLowerCase().includes(n.toLowerCase()))).join(', ') || title
    for (const a of names) if (!terms.has(a.toLowerCase()))
        terms.set(a.toLowerCase(), { term: shown, def, alias: a, exact: a === a.toUpperCase() && /[A-Z]/.test(a) && a.length <= 5 })
  }
  const esc = [...terms.keys()].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = esc.length ? new RegExp(`(?<![\\w-])(${esc.join('|')})(?:s|es)?(?![\\w-])`, 'gi') : null
  return { terms, re }
}

export type TermHit = { start: number; end: number; key: string }
/** Finds glossary terms in plain text. Acronyms (IP, TCP, LLM) must match case exactly so "ip" never lights up. */
export function findTerms(gl: Glossary, text: string): TermHit[] {
  if (!gl.re) return []
  const out: TermHit[] = []
  gl.re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = gl.re.exec(text))) {
    const key = m[1].toLowerCase()
    const hit = gl.terms.get(key)
    if (!hit) continue
    if (hit.exact && m[1] !== hit.alias) continue
    out.push({ start: m.index, end: m.index + m[0].length, key })
  }
  return out
}

const proseOnly = (md: string) =>
  md.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/^#{1,6} .*$/gm, ' ').replace(/\]\([^)]*\)/g, ']')

/** For each markdown block in reading order, which terms it should link: the first occurrence in the whole chapter. */
export function assignTerms(gl: Glossary, blocks: string[]): Set<string>[] {
  const seen = new Set<string>()
  return blocks.map((b) => {
    const mine = new Set<string>()
    for (const h of findTerms(gl, proseOnly(b))) if (!seen.has(h.key)) (seen.add(h.key), mine.add(h.key))
    return mine
  })
}

function build(): Book[] {
  type Slot = { parts: Map<number, Part>; plan: string; readme: string; gloss: string; loose: { no: number; file: string; unit: Unit }[] }
  const bySlug: Record<string, Slot> = {}
  const entries = Object.entries(raw).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
  for (const [path, src] of entries) {
    const m = path.match(/books\/([^/]+)\/(?:part-?(\d+)\/)?([^/]+)\.md$/)
    if (!m) continue
    const [, slug, dirNo, file] = m
    const slot = (bySlug[slug] ??= { parts: new Map(), plan: '', readme: '', gloss: '', loose: [] })
    if (dirNo) slot.loose.push({ no: Number(dirNo), file, unit: parseChapterFile(src, Number(dirNo)) })
    else if (isGlossaryFile(file)) slot.gloss = src
    else if (file === 'PLAN') slot.plan = src
    else if (file === 'README') slot.readme = src
    else if (/^part-\d+/.test(file)) {
      const part = parsePart(src, slot.parts.size + 1)
      slot.parts.set(part.no, part)
    }
  }
  return Object.entries(bySlug)
    .map(([slug, slot]) => {
      const meta = partMeta([slot.readme, slot.plan])
      for (const { no, unit } of slot.loose) {
        const part = slot.parts.get(no) ?? { no, title: meta[no]?.title ?? `Part ${no}`, blurb: meta[no]?.blurb ?? '', units: [] }
        part.units.push(unit)
        slot.parts.set(no, part)
      }
      const parts = [...slot.parts.values()].sort((x, y) => x.no - y.no)
      const plan = slot.plan || slot.readme
      const units = parts.flatMap((p) => p.units)
      return {
        slug,
        ...describe(slug, plan, parts),
        status: parts.length ? ('ready' as const) : ('planned' as const),
        parts,
        plan,
        units,
        minutes: units.reduce((n, u) => n + u.minutes, 0),
        glossary: parseGlossary(slot.gloss),
      }
    })
    .sort((a, b) => a.title.localeCompare(b.title))
}

export const books = build()
export const getBook = (slug?: string) => books.find((b) => b.slug === slug)
export const unitKey = (b: Book, u: Unit) => `${b.slug}/${u.id}`

/** Planned books: pull "Part N: …" headings and chapter tables out of PLAN.md. */
export type PlannedPart = { title: string; blurb: string; topics: { n: string; topic: string; question: string }[] }
export function parsePlan(plan: string): PlannedPart[] {
  const section = plan.split(/^## Complete Chapter Plan/m)[1]?.split(/^## /m)[0] ?? ''
  return section
    .split(/^### /m)
    .slice(1)
    .map((chunk) => {
      const lines = chunk.split('\n')
      const title = lines[0].replace(/\s*\(Layer.*\)$/, '').trim()
      const blurb = lines.slice(1).find((l) => l.trim() && !l.startsWith('|'))?.trim() ?? ''
      const topics = lines
        .filter((l) => /^\|\s*\d+\s*\|/.test(l))
        .map((l) => l.split('|').map((c) => c.trim()))
        .map((c) => ({ n: c[1], topic: c[2], question: c[3] }))
      return { title, blurb, topics }
    })
    .filter((p) => p.topics.length)
}

export type Hit = { book: Book; unit: Unit; snippet: string; score: number }
const searchable = books.flatMap((b) =>
  b.units.map((u) => ({
    b,
    u,
    title: `${u.label} ${u.title}`.toLowerCase(),
    text: [u.oneLiner, u.why, u.intro, ...u.sections.map((s) => s.body)].join(' ').replace(/\s+/g, ' '),
  })),
)
export function search(q: string, limit = 8): Hit[] {
  const needle = q.trim().toLowerCase()
  if (needle.length < 2) return []
  const terms = needle.split(/\s+/)
  const hits: Hit[] = []
  for (const { b, u, title, text } of searchable) {
    const low = text.toLowerCase()
    if (!terms.every((t) => title.includes(t) || low.includes(t))) continue
    let score = terms.reduce((n, t) => n + (title.includes(t) ? 40 : 0) + Math.min(10, low.split(t).length - 1), 0)
    if (title.includes(needle)) score += 60
    const at = Math.max(0, low.indexOf(terms[0]))
    const snippet = u.oneLiner && title.includes(terms[0]) ? u.oneLiner : '…' + text.slice(Math.max(0, at - 50), at + 110).trim() + '…'
    hits.push({ book: b, unit: u, snippet, score })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}
