import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// https://vite.dev/config/
//
// The API (apps/api, NestJS on :3000) serves controllers at the ROOT —
// /auth/login, /iam/orgs, … — with no global prefix. The web client always
// calls it through the axios baseURL '/api'; this dev proxy strips the
// '/api' prefix so '/api/auth/login' → 'http://localhost:3000/auth/login'.

// onnxruntime-web does `import(wasmPaths + 'ort-*.mjs')`. Vite dev refuses to
// serve public/ files through the module pipeline, so serve /ort/* and
// /ocr-models/* straight from public/ here (prod copies them into dist as-is).
const servePublicAssets = (): Plugin => ({
  name: 'serve-ort-assets-dev',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '').split('?')[0]
      if (!url.startsWith('/ort/') && !url.startsWith('/ocr-models/')) return next()
      const file = join(__dirname, 'public', decodeURIComponent(url))
      if (!existsSync(file) || !statSync(file).isFile()) return next()
      res.setHeader(
        'Content-Type',
        file.endsWith('.mjs') || file.endsWith('.js')
          ? 'text/javascript'
          : 'application/octet-stream',
      )
      createReadStream(file).pipe(res)
    })
  },
})

export default defineConfig({
  plugins: [react(), servePublicAssets()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  // `vite preview` serves the production build — mirror the same /api proxy
  // so a prod-mode smoke exercises the same path as dev.
  preview: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
