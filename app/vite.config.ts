import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/** `books/` sits outside the app root: watch it so adding a folder or part file shows up without a restart. */
function watchBooks(): Plugin {
  const dir = resolve(__dirname, '../books')
  return {
    name: 'watch-books',
    configureServer(server) {
      server.watcher.add(dir)
      const refresh = (file: string) => {
        if (!file.startsWith(dir) || !file.endsWith('.md')) return
        const mod = server.moduleGraph.getModuleById(resolve(__dirname, 'src/lib/content.ts'))
        if (mod) server.moduleGraph.invalidateModule(mod)
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.on('add', refresh).on('unlink', refresh).on('change', refresh)
    },
  }
}

export default defineConfig({
  plugins: [react(), watchBooks()],
  server: { fs: { allow: ['..'] } },
})
