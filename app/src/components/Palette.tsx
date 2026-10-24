import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { CornerDownLeft, Search } from 'lucide-react'
import { search } from '../lib/content'

export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const nav = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  const hits = useMemo(() => search(q), [q])

  useEffect(() => {
    if (open) {
      setQ('')
      setI(0)
      setTimeout(() => input.current?.focus(), 10)
    }
  }, [open])
  useEffect(() => {
    setI(0)
  }, [q])

  const go = (n: number) => {
    const h = hits[n]
    if (!h) return
    nav(`/${h.book.slug}/${h.unit.id}`)
    onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            className="palette"
            role="dialog"
            aria-label="Search the books"
            initial={{ opacity: 0, y: -12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.99 }}
            transition={{ type: 'spring', stiffness: 520, damping: 38 }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') (e.preventDefault(), setI((v) => Math.min(hits.length - 1, v + 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setI((v) => Math.max(0, v - 1)))
              else if (e.key === 'Enter') go(i)
            }}
          >
            <div className="palette-in">
              <Search size={18} />
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chapters — try “CAP theorem” or “cache”" aria-label="Search" />
              <span className="kbd">esc</span>
            </div>
            <div className="palette-list" role="listbox">
              {q.trim().length < 2 ? (
                <div className="palette-empty">Type two or more letters to search every chapter.</div>
              ) : hits.length === 0 ? (
                <div className="palette-empty">Nothing matches “{q}”.</div>
              ) : (
                hits.map((h, n) => (
                  <div key={h.book.slug + h.unit.id} className="hit" role="option" aria-selected={n === i} onMouseMove={() => setI(n)} onClick={() => go(n)}>
                    <div className="t">
                      <span className="label">{h.unit.label}</span>
                      {h.unit.title}
                      <span className="label" style={{ marginLeft: 'auto' }}>{h.book.title}</span>
                    </div>
                    <p>{h.snippet}</p>
                  </div>
                ))
              )}
            </div>
            <div className="palette-foot">
              <span><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span>
              <span><CornerDownLeft size={12} /> open</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
