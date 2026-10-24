import { useCallback, useEffect, useSyncExternalStore } from 'react'

const read = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* private mode */
  }
}

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

/* ── theme ───────────────────────────── */
export type Theme = 'light' | 'dark'
const mq = () => window.matchMedia('(prefers-color-scheme: dark)')
const stored = () => read('sc:theme', '')
const systemSubscribe = (l: () => void) => {
  const m = mq()
  m.addEventListener('change', l)
  return () => m.removeEventListener('change', l)
}
/** Follows the OS until the reader picks a side; the toggle then flips between light and dark. */
export function useTheme() {
  const pref = useSyncExternalStore(subscribe, stored)
  const sysDark = useSyncExternalStore(systemSubscribe, () => mq().matches)
  const theme: Theme = pref === 'light' || pref === 'dark' ? pref : sysDark ? 'dark' : 'light'
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  const toggle = useCallback(() => {
    write('sc:theme', theme === 'dark' ? 'light' : 'dark')
    emit()
  }, [theme])
  return [theme, toggle] as const
}

/* ── reading progress ────────────────── */
const readSet = () => {
  try {
    return new Set<string>(JSON.parse(read('sc:read', '[]')))
  } catch {
    return new Set<string>()
  }
}
export function useRead() {
  const snap = useSyncExternalStore(subscribe, () => read('sc:read', '[]'))
  const set = (() => {
    try {
      return new Set<string>(JSON.parse(snap))
    } catch {
      return new Set<string>()
    }
  })()
  const mark = useCallback((key: string) => {
    const s = readSet()
    if (s.has(key)) return
    s.add(key)
    write('sc:read', JSON.stringify([...s]))
    emit()
  }, [])
  return { has: (k: string) => set.has(k), mark, count: (prefix: string) => [...set].filter((k) => k.startsWith(prefix)).length }
}

export function rememberLast(key: string) {
  write('sc:last', key)
}
export function getLast() {
  return read('sc:last', '')
}
