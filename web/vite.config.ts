import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies the app origin to the Node backend so the browser uses one
// origin (no CORS). The same pattern will carry the /jupyter reverse-proxy.
// Ports read from env so launch.sh (and `PORT=… ./launch.sh`) drive them; a
// distinct default (5273) avoids colliding with ClaudeMaster's Vite on 5173.
const SERVER_PORT = process.env.PORT ?? '4319'
const WEB_PORT = Number(process.env.WEB_PORT ?? 5273)

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${SERVER_PORT}`,
      '/ws': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
    },
  },
})
