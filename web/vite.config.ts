import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies the app origin to the Node backend so the browser uses one
// origin (no CORS). The same pattern will carry the /jupyter reverse-proxy.
// Host + ports read from env so launch.sh (and `HOST=… WEB_PORT=… PORT=… ./launch.sh`)
// drive them: WEB_PORT picks the port the UI is served on, HOST picks the interface
// (default loopback; set 0.0.0.0 to reach the dev server from another device/VPN).
// A distinct default port (5273) avoids colliding with ClaudeMaster's Vite on 5173.
const HOST = process.env.HOST ?? '127.0.0.1'
const SERVER_PORT = process.env.PORT ?? '4319'
const WEB_PORT = Number(process.env.WEB_PORT ?? 5273)

export default defineConfig({
  plugins: [react()],
  server: {
    host: HOST,
    port: WEB_PORT,
    strictPort: true,
    // The proxy always targets the backend on loopback (both run on the same host);
    // only the public-facing bind (host above) changes for remote access.
    proxy: {
      '/api': `http://127.0.0.1:${SERVER_PORT}`,
      '/ws': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
    },
  },
})
