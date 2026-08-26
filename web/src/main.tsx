import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'
import { trackVisibleHeight } from './lib/visualViewport'

// Publish --vvh before first paint so anything sized off the VISIBLE viewport (the
// AskUserQuestion card) is correct on the first render rather than after a resize.
trackVisibleHeight()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)

// Register the service worker in production only — in dev, Vite's HMR + a caching
// SW fight each other. This is what makes the app installable (Add to Home Screen).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ })
  })
}
