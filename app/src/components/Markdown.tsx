import { isValidElement, useState, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { GlossaryCtx, JargonTerm } from './Jargon'
import { remarkJargon } from '../lib/jargon'
import type { Glossary } from '../lib/content'

const BOX = /[━─│┌┐└┘├┤┬┴┼▶▼▲◀→←↑↓╔╗╚╝═║]/

function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children)
  return ''
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="copy"
      aria-label="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        })
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

function Figure({ code, lang }: { code: string; lang?: string }) {
  const lines = code.replace(/\n$/, '').split('\n')
  const titled = lines.length > 2 && /^[━─═=-]{5,}\s*$/.test(lines[1] ?? '') && !BOX.test(lines[0])
  const title = titled ? lines[0].trim() : lang ?? (BOX.test(code) ? 'Diagram' : 'Snippet')
  const body = (titled ? lines.slice(2) : lines).join('\n').replace(/^\n+/, '')
  const isDiagram = !lang && BOX.test(code)
  return (
    <figure className={`fig ${isDiagram ? 'diagram' : 'code'}`} style={{ margin: undefined }}>
      <div className="fig-head">
        <span className="label">{title}</span>
        <CopyButton text={body} />
      </div>
      <pre tabIndex={0}>{body}</pre>
    </figure>
  )
}

const components = {
  'jargon-term': JargonTerm,
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children
    const props = isValidElement(child) ? (child as ReactElement<{ className?: string; children?: ReactNode }>).props : {}
    const lang = /language-(\w+)/.exec(props.className ?? '')?.[1]
    return <Figure code={textOf(props.children)} lang={lang} />
  },
  table({ children }) {
    return (
      <div className="table-wrap" role="region" tabIndex={0}>
        <table>{children}</table>
      </div>
    )
  },
  a({ href, children }) {
    const ext = href?.startsWith('http')
    return (
      <a href={href} {...(ext ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
        {children}
      </a>
    )
  },
} as Components

export function Markdown({ children, glossary, terms }: { children: string; glossary?: Glossary; terms?: Set<string> }) {
  const plugins = glossary && terms?.size ? [remarkGfm, remarkJargon(glossary, terms)] : [remarkGfm]
  return (
    <GlossaryCtx.Provider value={glossary ?? null}>
      <div className="prose">
        <ReactMarkdown remarkPlugins={plugins} components={components}>
          {children}
        </ReactMarkdown>
      </div>
    </GlossaryCtx.Provider>
  )
}
