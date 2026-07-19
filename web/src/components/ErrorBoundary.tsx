import React from 'react'

// Root error boundary. Without one, any uncaught render error unmounts the whole
// `createRoot` tree and leaves a black screen that only a manual refresh recovers
// from (e.g. a rules-of-hooks violation when a notebook is closed). Catch it here,
// show a recoverable fallback, and let the user reload without losing the tab.
interface State { error: Error | null }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Uncaught render error:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-3 bg-ctp-base text-ctp-text p-6 text-center">
          <div className="text-sm font-medium">Something went wrong.</div>
          <div className="max-w-lg text-xs text-ctp-overlay font-mono break-words">
            {this.state.error.message}
          </div>
          <button
            className="mt-2 px-3 py-1.5 text-xs rounded bg-ctp-surface0 hover:bg-ctp-surface1 text-ctp-text"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
