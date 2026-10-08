import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Engine the dev server proxies to. Override to run the dashboard against an
// engine on another port, e.g. NOMUS_ENGINE_URL=http://localhost:3131.
const engineUrl = process.env.NOMUS_ENGINE_URL || 'http://localhost:3100'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': engineUrl,
      '/.well-known': engineUrl,
    },
  },
})
