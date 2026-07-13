// Minimal service worker — just enough to make Claudette installable and load
// its shell fast. It is deliberately conservative: it NEVER caches the API or the
// WebSocket (those must always hit the live server), and it uses hashed Vite
// asset filenames (immutable) for the only long-lived cache. This is not an
// offline app — the server is required — but the shell opens instantly and the
// PWA install criteria are met.

const CACHE = 'claudette-shell-v1'

self.addEventListener('install', (event) => {
  // Precache the app entry so a cold start / flaky network still opens the shell.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  // Drop old shell caches when the SW version bumps.
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Only handle same-origin GETs. Never touch the API or the WebSocket.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return

  // Navigations: network-first, fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/').then((r) => r ?? Response.error())),
    )
    return
  }

  // Hashed static assets: cache-first (immutable), populate on first fetch.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((hit) =>
        hit ?? fetch(request).then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(request, copy))
          return res
        }),
      ),
    )
  }
})
