import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, ArrowRight, Check, ChevronDown, Clock, Target } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { TopBar } from '../components/TopBar'
import { Markdown } from '../components/Markdown'
import { assignTerms, getBook, unitKey, type Book, type Section, type Unit } from '../lib/content'
import { rememberLast, useRead } from '../lib/store'
import { useOpenSearch } from '../lib/ui'

const ease = [0.22, 1, 0.36, 1] as const

function Sidebar({ book, active, open, onNavigate }: { book: Book; active: string; open: boolean; onNavigate: () => void }) {
  const read = useRead()
  const done = read.count(book.slug + '/')
  const pct = Math.round((done / book.units.length) * 100)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <aside ref={ref} className="sidebar" data-open={open} aria-label="Contents">
      <div className="side-book">
        <Link to={`/${book.slug}`} className="label">← All chapters</Link>
        <h2>{book.title}</h2>
        <div className="side-stat"><span>{done} of {book.units.length} read</span><span>{pct}%</span></div>
        <div className="side-bar"><i style={{ width: `${pct}%` }} /></div>
      </div>
      {book.parts.map((p) => (
        <div className="part" key={p.no}>
          <span className="label">Part {p.no} · {p.title}</span>
          {p.units.map((u) => {
            const on = u.id === active
            return (
              <Link key={u.id} to={`/${book.slug}/${u.id}`} className={`nav-item ${on ? 'active' : ''}`} aria-current={on ? 'page' : undefined} onClick={onNavigate}>
                {on && <motion.span layoutId="nav-pip" className="pip" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                {on && <motion.span layoutId="nav-bg" className="bg" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                <span className="n">{u.label.replace(/^\D+/, '') || '★'}</span>
                <span>{u.title}</span>
                {read.has(unitKey(book, u)) && <Check className="tick" size={13} />}
              </Link>
            )
          })}
        </div>
      ))}
    </aside>
  )
}

function QAList({ items }: { items: { q: string; a: string }[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set())
  const toggle = (i: number) =>
    setOpen((s) => {
      const n = new Set(s)
      n.has(i) ? n.delete(i) : n.add(i)
      return n
    })
  return (
    <>
      <p className="qa-hint">Answer in your head first. Then reveal. Retrieval is what makes it stick.</p>
      <div className="qa">
        {items.map((it, i) => {
          const isOpen = open.has(i)
          return (
            <div className="qa-item" data-open={isOpen} key={i}>
              <button className="qa-q" aria-expanded={isOpen} onClick={() => toggle(i)}>
                <span className="qn">Q{String(i + 1).padStart(2, '0')}</span>
                <span>{it.q}</span>
                <ChevronDown className="chev" size={18} />
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease }} style={{ overflow: 'hidden' }}>
                    <div className="qa-a">
                      <ReactMarkdown>{it.a}</ReactMarkdown>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
      </div>
    </>
  )
}

function Sec({ s, i, book, terms }: { s: Section; i: number; book: Book; terms?: Set<string> }) {
  return (
    <motion.section id={s.id} className="sec" initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '0px 0px -80px 0px' }} transition={{ duration: 0.55, ease }}>
      <h2 className="sec-title">
        <span className="label">{String(i + 1).padStart(2, '0')}</span>
        {s.title}
      </h2>
      {s.qa ? <QAList items={s.qa} /> : <Markdown glossary={book.glossary} terms={terms}>{s.body}</Markdown>}
    </motion.section>
  )
}

function Reader({ book, unit }: { book: Book; unit: Unit }) {
  const read = useRead()
  const nav = useNavigate()
  const [menu, setMenu] = useState(false)
  const [spy, setSpy] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const openSearch = useOpenSearch()
  const idx = book.units.indexOf(unit)
  const prev = book.units[idx - 1]
  const next = book.units[idx + 1]
  const key = unitKey(book, unit)
  const part = book.parts.find((p) => p.no === unit.partNo)!

  useEffect(() => {
    rememberLast(key)
    setMenu(false)
  }, [key])

  // mark as read once the reader reaches the end of the chapter
  useEffect(() => {
    const el = end.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => e.isIntersecting && read.mark(key), { threshold: 0.6 })
    io.observe(el)
    return () => io.disconnect()
  }, [key])

  // scroll-spy for the right-hand outline
  useEffect(() => {
    const els = unit.sections.map((s) => document.getElementById(s.id)).filter(Boolean) as HTMLElement[]
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (vis) setSpy(vis.target.id)
      },
      { rootMargin: '-72px 0px -70% 0px' },
    )
    els.forEach((e) => io.observe(e))
    return () => io.disconnect()
  }, [key])

  // ← / → move between chapters
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || /input|textarea/i.test((e.target as HTMLElement).tagName)) return
      if (e.key === 'ArrowRight' && next) nav(`/${book.slug}/${next.id}`)
      if (e.key === 'ArrowLeft' && prev) nav(`/${book.slug}/${prev.id}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [key])

  const hasIntro = unit.intro.replace(/\s/g, '').length > 0
  // glossary terms link on their first appearance in the chapter, in reading order (intro, then sections)
  const termSets = useMemo(() => assignTerms(book.glossary, [unit.intro, ...unit.sections.map((s) => (s.qa ? '' : s.body))]), [book, unit])
  const outline = useMemo(() => unit.sections.map((s) => ({ id: s.id, title: s.title })), [unit])

  return (
    <>
      <TopBar
        onSearch={openSearch}
        onMenu={() => setMenu((v) => !v)}
        progress
        crumbs={[
          { label: book.title, to: `/${book.slug}`, hideSm: true },
          { label: `Part ${part.no}`, hideSm: true },
          { label: `${unit.label} · ${unit.title}` },
        ]}
      />
      <div className="shell">
        <Sidebar book={book} active={unit.id} open={menu} onNavigate={() => setMenu(false)} />
        {menu && <div className="mobile-nav-scrim only-mobile" onClick={() => setMenu(false)} />}

        <main className="article">
          <motion.article key={key} className="article-inner" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease }}>
            <header>
              <div className="eyebrow">
                <span className="label" style={{ color: 'var(--accent)' }}>{unit.label}</span>
                <span className="dot" />
                <span className="label">Part {part.no} · {part.title}</span>
                <span className="dot" />
                <span className="label" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}><Clock size={11} /> {unit.minutes} min</span>
              </div>
              <h1>{unit.title}</h1>
              {unit.oneLiner && <p className="lede">{unit.oneLiner}</p>}
              {(unit.why || unit.prereq) && (
                <div className="facts">
                  {unit.why && (
                    <div className="fact">
                      <span className="label">Why care</span>
                      <p>{unit.why}</p>
                    </div>
                  )}
                  {unit.prereq && (
                    <div className="fact">
                      <span className="label">{unit.prereqLabel ?? 'Before this'}</span>
                      <p>{unit.prereq}</p>
                    </div>
                  )}
                </div>
              )}
            </header>

            {hasIntro && <div style={{ marginTop: 36 }}><Markdown glossary={book.glossary} terms={termSets[0]}>{unit.intro}</Markdown></div>}
            {unit.sections.map((s, i) => (
              <Sec key={s.id + i} s={s} i={i} book={book} terms={termSets[i + 1]} />
            ))}

            <div ref={end} className="done-note" style={{ opacity: read.has(key) ? 1 : 0.0, transition: 'opacity .4s' }}>
              <Check size={16} /> Marked as read
            </div>

            <nav className="pager" aria-label="Chapter navigation">
              {prev ? (
                <Link to={`/${book.slug}/${prev.id}`} className="prev">
                  <span className="label"><ArrowLeft size={12} /> Previous</span>
                  <span className="t">{prev.title}</span>
                </Link>
              ) : <span />}
              {next && (
                <Link to={`/${book.slug}/${next.id}`} className="next">
                  <span className="label">Next <ArrowRight size={12} /></span>
                  <span className="t">{next.title}</span>
                </Link>
              )}
            </nav>
          </motion.article>
        </main>

        <aside className="toc" aria-label="On this page">
          <span className="label">On this page</span>
          {outline.map((o) => (
            <a key={o.id} href={`#${o.id}`} className={spy === o.id ? 'on' : ''} onClick={(e) => (e.preventDefault(), document.getElementById(o.id)?.scrollIntoView({ behavior: 'smooth' }), setSpy(o.id))}>
              {o.title}
            </a>
          ))}
          <div className="mini">
            <div><Target size={14} /> Use <span className="kbd">←</span> <span className="kbd">→</span> to change chapter</div>
            {book.glossary.terms.size > 0 && <div><span className="jt" style={{ cursor: 'default' }}>Dotted</span> words explain themselves on hover</div>}
          </div>
        </aside>
      </div>
    </>
  )
}

export default function ChapterPage() {
  const { book: slug, unit: uid } = useParams()
  const book = getBook(slug)
  if (!book || book.status !== 'ready') return <Navigate to={book ? `/${book.slug}` : '/'} replace />
  const unit = book.units.find((u) => u.id === uid)
  if (!unit) return <Navigate to={`/${book.slug}`} replace />
  return <Reader key={book.slug} book={book} unit={unit} />
}
