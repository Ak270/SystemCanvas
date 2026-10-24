import { motion } from 'motion/react'

type N = { id: string; x: number; y: number; w: number; label: string; hot?: boolean }
const nodes: N[] = [
  { id: 'c', x: 20, y: 150, w: 78, label: 'client' },
  { id: 'lb', x: 150, y: 150, w: 54, label: 'LB' },
  { id: 'a', x: 262, y: 84, w: 84, label: 'api-1' },
  { id: 'b', x: 262, y: 216, w: 84, label: 'api-2' },
  { id: 'cache', x: 398, y: 84, w: 76, label: 'cache', hot: true },
  { id: 'db', x: 398, y: 216, w: 76, label: 'db' },
]
const H = 34
const edges = [
  ['c', 'lb'],
  ['lb', 'a'],
  ['lb', 'b'],
  ['a', 'cache'],
  ['b', 'db'],
  ['a', 'db'],
]
const by = Object.fromEntries(nodes.map((n) => [n.id, n]))
const path = (a: string, b: string) => {
  const A = by[a], B = by[b]
  const x1 = A.x + A.w, y1 = A.y + H / 2, x2 = B.x, y2 = B.y + H / 2
  const mx = (x1 + x2) / 2
  return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`
}

export function CanvasArt() {
  const dots = []
  for (let x = 0; x <= 520; x += 26) for (let y = 0; y <= 330; y += 26) dots.push(<circle key={`${x}-${y}`} className="grid-dot" cx={x} cy={y} r="1" />)
  return (
    <svg className="canvas-art" viewBox="-6 -6 532 342" role="img" aria-label="Diagram of a request flowing from a client through a load balancer to two API servers, a cache and a database">
      <g opacity="0.7">{dots}</g>
      {edges.map(([a, b], i) => (
        <motion.path
          key={a + b}
          className="edge"
          d={path(a, b)}
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.9, delay: 0.5 + i * 0.12, ease: [0.22, 1, 0.36, 1] }}
        />
      ))}
      {edges.map(([a, b], i) => (
        <circle key={'p' + a + b} className="packet" r="3.2">
          <animateMotion dur="3.2s" begin={`${1.8 + i * 0.45}s`} repeatCount="indefinite" path={path(a, b)} keyPoints="0;1" keyTimes="0;1" calcMode="linear" />
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.85;1" dur="3.2s" begin={`${1.8 + i * 0.45}s`} repeatCount="indefinite" />
        </circle>
      ))}
      {nodes.map((n, i) => (
        <motion.g
          key={n.id}
          className={`node ${n.hot ? 'hot' : ''}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 + i * 0.07, ease: [0.22, 1, 0.36, 1] }}
        >
          <rect x={n.x} y={n.y} width={n.w} height={H} rx="7" />
          <text x={n.x + n.w / 2} y={n.y + H / 2 + 4} textAnchor="middle">
            {n.label}
          </text>
        </motion.g>
      ))}
      <text className="note" x="20" y="312">
        one request, six hops — where does it break?
      </text>
    </svg>
  )
}
