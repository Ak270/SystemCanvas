import { useEffect, useState } from 'react'
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom'
import { MotionConfig } from 'motion/react'
import { Palette } from './components/Palette'
import { SearchCtx } from './lib/ui'
import Home from './pages/Home'
import BookPage from './pages/BookPage'
import ChapterPage from './pages/ChapterPage'

function ScrollReset() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}

export default function App() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === '/' && !/input|textarea/i.test((e.target as HTMLElement).tagName)) {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <MotionConfig reducedMotion="user">
      <HashRouter>
        <SearchCtx.Provider value={() => setOpen(true)}>
          <ScrollReset />
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/:book" element={<BookPage />} />
            <Route path="/:book/:unit" element={<ChapterPage />} />
          </Routes>
          <Palette open={open} onClose={() => setOpen(false)} />
        </SearchCtx.Provider>
      </HashRouter>
    </MotionConfig>
  )
}
