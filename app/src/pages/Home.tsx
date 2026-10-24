import { Link } from 'react-router-dom'
import { motion } from 'motion/react'
import { ArrowRight, ArrowUpRight, BrainCircuit, Layers, MessagesSquare } from 'lucide-react'
import { TopBar } from '../components/TopBar'
import { CanvasArt } from '../components/CanvasArt'
import { books, getBook, parsePlan } from '../lib/content'
import { getLast, useRead } from '../lib/store'
import { useOpenSearch } from '../lib/ui'

const ease = [0.22, 1, 0.36, 1] as const
const rise = (i = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.7, delay: 0.05 + i * 0.08, ease },
})

export default function Home() {
  const read = useRead()
  const openSearch = useOpenSearch()
  const [lb, lu] = getLast().split('/')
  const lastBook = getBook(lb)
  const lastUnit = lastBook?.units.find((u) => u.id === lu)
  const first = books.find((b) => b.status === 'ready')

  const cta = lastBook && lastUnit
    ? { to: `/${lastBook.slug}/${lastUnit.id}`, label: `Continue: ${lastUnit.label}` }
    : first && { to: `/${first.slug}/${first.units[0].id}`, label: 'Start reading' }

  return (
    <>
      <TopBar onSearch={openSearch} />
      <main className="wrap">
        <section className="hero">
          <div>
            <motion.span className="label" {...rise(0)}>Books · built for how memory works</motion.span>
            <motion.h1 {...rise(1)}>
              Learn how <em>real systems</em> are put together.
            </motion.h1>
            <motion.p className="lede" {...rise(2)}>
              Every concept starts with something you already know, then earns its technical detail. Real companies, real numbers, and questions that make you retrieve the answer instead of re-reading it.
            </motion.p>
            <motion.div className="hero-cta" {...rise(3)}>
              {cta && (
                <Link to={cta.to} className="btn primary">
                  {cta.label} <ArrowRight size={16} />
                </Link>
              )}
              <a href="#books" className="btn">Browse the shelf</a>
            </motion.div>
          </div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, delay: 0.2 }}>
            <CanvasArt />
          </motion.div>
        </section>

        <section id="books" aria-labelledby="shelf-h">
          <div className="section-head">
            <h2 id="shelf-h">The shelf</h2>
            <span className="label">{books.length} books</span>
          </div>
          <div className="shelf">
            {books.map((b, i) => {
              const done = read.count(b.slug + '/')
              const pct = b.units.length ? Math.round((done / b.units.length) * 100) : 0
              const planned = b.status === 'planned' ? parsePlan(b.plan).reduce((n, p) => n + p.topics.length, 0) : 0
              return (
                <motion.div key={b.slug} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-40px' }} transition={{ duration: 0.6, delay: i * 0.06, ease }}>
                  <Link to={`/${b.slug}`} className="book-row">
                    <span className="num">{String(i + 1).padStart(2, '0')}</span>
                    <div>
                      <h3>{b.title}</h3>
                      <p>{b.tagline}</p>
                    </div>
                    <div className="book-meta">
                      {b.status === 'ready' ? (
                        <>
                          <span className="pill live">Readable now</span>
                          <span>{b.parts.length} parts · {b.units.length} chapters · ~{Math.round(b.minutes / 60)} h</span>
                          <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Reading progress"><i style={{ width: `${pct}%` }} /></div>
                        </>
                      ) : (
                        <>
                          <span className="pill">In the works</span>
                          <span>{planned} topics planned</span>
                        </>
                      )}
                    </div>
                    <ArrowUpRight className="arrow" size={20} />
                  </Link>
                </motion.div>
              )
            })}
          </div>
        </section>

        <section className="principles" aria-label="How these books teach">
          {[
            [MessagesSquare, 'Analogy first', 'A coffee shop explains a load balancer before the word “load balancer” shows up.'],
            [Layers, 'Four ideas at a time', 'Working memory holds about four chunks, so no section asks for more.'],
            [BrainCircuit, 'Recall, not re-read', 'Every chapter ends with questions you answer in your head before revealing the reply.'],
          ].map(([Icon, h, p], i) => {
            const I = Icon as typeof Layers
            return (
              <motion.div key={h as string} className="principle" initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.55, delay: i * 0.08, ease }}>
                <I size={22} strokeWidth={1.6} />
                <h4>{h as string}</h4>
                <p>{p as string}</p>
              </motion.div>
            )
          })}
        </section>

        <footer className="footer">
          <span>SystemCanvas — written in Markdown, rendered here.</span>
          <span>Press <kbd className="kbd">/</kbd> anywhere to search.</span>
        </footer>
      </main>
    </>
  )
}
