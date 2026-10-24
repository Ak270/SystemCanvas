import { Link } from 'react-router-dom'
import { motion, useScroll, useSpring } from 'motion/react'
import { ChevronRight, Menu, Moon, Search, Sun } from 'lucide-react'
import { useTheme } from '../lib/store'

export function TopBar({
  crumbs,
  onSearch,
  onMenu,
  progress,
}: {
  crumbs?: { label: string; to?: string; hideSm?: boolean }[]
  onSearch: () => void
  onMenu?: () => void
  progress?: boolean
}) {
  const [theme, toggleTheme] = useTheme()
  const Icon = theme === 'dark' ? Sun : Moon
  const next = theme === 'dark' ? 'light' : 'dark'
  const { scrollYProgress } = useScroll()
  const scaleX = useSpring(scrollYProgress, { stiffness: 220, damping: 40, mass: 0.4 })
  return (
    <header className="topbar">
      {onMenu && (
        <button className="icon-btn only-mobile" onClick={onMenu} aria-label="Open contents">
          <Menu size={18} />
        </button>
      )}
      <Link to="/" className="brand" aria-label="SystemCanvas home">
        <span className="brand-mark">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12V2m0 0h10M2 2l10 10" />
          </svg>
        </span>
        SystemCanvas
      </Link>
      {crumbs && (
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <span key={i} className={c.hideSm ? 'hide-sm' : ''} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <ChevronRight size={14} />
              {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="topbar-spacer" />
      <button className="search-btn" onClick={onSearch} aria-label="Search">
        <Search size={15} />
        <span>Search</span>
        <kbd className="kbd">⌘K</kbd>
      </button>
      <button className="icon-btn" onClick={toggleTheme} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
        <Icon size={17} />
      </button>
      {progress && <motion.div className="progress" style={{ scaleX }} />}
    </header>
  )
}
