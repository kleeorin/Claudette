import type { ReactNode } from 'react'

// The outer frame every right-dock panel sits in. Trivial, but it was written out
// identically in the Git and Permissions docks, which is exactly how two panels that
// are supposed to look like one system drift apart.
export function DockShell({ children }: { children: ReactNode }) {
  return <div className="flex flex-col h-full bg-ctp-base overflow-hidden">{children}</div>
}
