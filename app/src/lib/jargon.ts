import { findTerms, type Glossary } from './content'

type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> }
const SKIP = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition', 'heading', 'html'])

/** remark plugin: wraps the first occurrence (per block) of each allowed glossary term in a <jargon-term>. */
export function remarkJargon(gl: Glossary, allowed: Set<string>) {
  return () => (tree: Node) => {
    const done = new Set<string>()
    const walk = (node: Node) => {
      if (!node.children || SKIP.has(node.type)) return
      const next: Node[] = []
      for (const child of node.children) {
        if (child.type !== 'text' || !child.value) {
          walk(child)
          next.push(child)
          continue
        }
        const text = child.value
        let at = 0
        for (const h of findTerms(gl, text)) {
          if (!allowed.has(h.key) || done.has(h.key) || h.start < at) continue
          done.add(h.key)
          if (h.start > at) next.push({ type: 'text', value: text.slice(at, h.start) })
          next.push({
            type: 'jargon',
            data: { hName: 'jargon-term', hProperties: { 'data-term': h.key } },
            children: [{ type: 'text', value: text.slice(h.start, h.end) }],
          })
          at = h.end
        }
        next.push(at ? { type: 'text', value: text.slice(at) } : child)
      }
      node.children = next
    }
    walk(tree)
  }
}
