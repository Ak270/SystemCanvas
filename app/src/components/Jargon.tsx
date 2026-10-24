import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import ReactMarkdown from 'react-markdown'
import type { Glossary } from '../lib/content'

export const GlossaryCtx = createContext<Glossary | null>(null)

type Pos = { left: number; top: number; above: boolean }
const W = 340

export function JargonTerm(props: { children?: ReactNode; 'data-term'?: string }) {
  const gl = useContext(GlossaryCtx)
  const entry = gl?.terms.get(props['data-term'] ?? '')
  const [pos, setPos] = useState<Pos | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  const timer = useRef<number>(0)
  const id = useId()

  const open = () => {
    window.clearTimeout(timer.current)
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.min(Math.max(12, r.left + r.width / 2 - W / 2), window.innerWidth - Math.min(W, window.innerWidth - 24) - 12)
    const above = r.bottom + 180 > window.innerHeight && r.top > 200
    setPos({ left, top: above ? r.top - 8 : r.bottom + 8, above })
  }
  const later = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(fn, ms)
  }
  const close = () => later(() => setPos(null), 120)

  useEffect(() => {
    if (!pos) return
    const hide = () => setPos(null)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.('.jpop') && hide()
    window.addEventListener('scroll', hide, { passive: true })
    window.addEventListener('keydown', key)
    window.addEventListener('pointerdown', away)
    return () => {
      window.removeEventListener('scroll', hide)
      window.removeEventListener('keydown', key)
      window.removeEventListener('pointerdown', away)
    }
  }, [pos])

  if (!entry) return <>{props.children}</>
  return (
    <>
      <span
        ref={ref}
        className="jt"
        tabIndex={0}
        aria-describedby={pos ? id : undefined}
        onMouseEnter={() => later(open, 140)}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        onClick={() => (pos ? setPos(null) : open())}
      >
        {props.children}
      </span>
      {createPortal(
        <AnimatePresence>
          {pos && (
            <motion.div
              key="pop"
              id={id}
              role="tooltip"
              className="jpop"
              style={{ left: pos.left, top: pos.top, transform: pos.above ? 'translateY(-100%)' : undefined }}
              initial={{ opacity: 0, y: pos.above ? 4 : -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
              onMouseEnter={() => window.clearTimeout(timer.current)}
              onMouseLeave={close}
            >
              <div className="jpop-term">{entry.term}</div>
              <ReactMarkdown>{entry.def}</ReactMarkdown>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
