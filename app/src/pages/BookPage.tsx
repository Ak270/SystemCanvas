import { Link, useParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { ArrowRight } from 'lucide-react'
import { TopBar } from '../components/TopBar'
import { getBook, parsePlan } from '../lib/content'
import { useRead } from '../lib/store'
import { useOpenSearch } from '../lib/ui'

const ease = [0.22, 1, 0.36, 1] as const

export default function BookPage() {
  const { book: slug } = useParams()
  const book = getBook(slug)
  const read = useRead()
  const openSearch = useOpenSearch()

  if (!book)
    return (
      <>
        <TopBar onSearch={openSearch} />
        <main className="wrap book-hero">
          <h1>Not on the shelf.</h1>
          <Link to="/" className="btn">Back home</Link>
        </main>
      </>
    )

  const plan = parsePlan(book.plan)
  const next = book.units.find((u) => !read.has(`${book.slug}/${u.id}`)) ?? book.units[0]
  const done = read.count(book.slug + '/')

  return (
    <>
      <TopBar onSearch={openSearch} crumbs={[{ label: book.title }]} />
      <main className="wrap">
        <motion.div className="book-hero" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease }}>
          <span className={`pill ${book.status === 'ready' ? 'live' : ''}`}>{book.status === 'ready' ? 'Readable now' : 'In the works'}</span>
          <h1>{book.title}</h1>
          <p>{book.tagline}</p>
          <p style={{ fontSize: 15, color: 'var(--muted)' }}>For: {book.audience}</p>
          {book.status === 'ready' && next && (
            <Link to={`/${book.slug}/${next.id}`} className="btn primary">
              {done ? `Continue · ${next.label}` : 'Start with Chapter 1'} <ArrowRight size={16} />
            </Link>
          )}
        </motion.div>

        {book.status === 'ready' ? (
          <div className="toc-index" style={{ marginBottom: 96 }}>
            {book.parts.map((p) => (
              <section key={p.no} className="part-block">
                <div>
                  <span className="label">Part {p.no}</span>
                  <h3>{p.title}</h3>
                  <p>{p.blurb}</p>
                </div>
                <div>
                  {p.units.map((u) => (
                    <Link key={u.id} to={`/${book.slug}/${u.id}`} className="idx-link">
                      <span className="label">{u.label}</span>
                      <b>{u.title}</b>
                      <small>{read.has(`${book.slug}/${u.id}`) ? 'read' : `${u.minutes} min`}</small>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div style={{ marginBottom: 96 }}>
            <div className="section-head"><h2>Planned chapters</h2><span className="label">Writing in progress</span></div>
            {plan.map((p) => (
              <section key={p.title} className="plan-part">
                <div>
                  <span className="label">{p.title.split(':')[0]}</span>
                  <h3>{p.title.split(':').slice(1).join(':').trim()}</h3>
                </div>
                <div className="plan-topics">
                  {p.topics.map((t) => (
                    <div key={t.n} className="plan-topic">
                      <span className="n">{t.n.padStart(2, '0')}</span>
                      <div>
                        <b>{t.topic}</b>
                        <p>{t.question}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </>
  )
}
