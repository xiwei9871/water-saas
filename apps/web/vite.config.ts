import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
//
// The API (apps/api, NestJS on :3000) serves controllers at the ROOT —
// /auth/login, /iam/orgs, … — with no global prefix. The web client always
// calls it through the axios baseURL '/api'; this dev proxy strips the
// '/api' prefix so '/api/auth/login' → 'http://localhost:3000/auth/login'.
export default defineConfig({
  plugins: [react()],
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
