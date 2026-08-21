import type { KernelStatus } from '@claudette/shared'

// The kernel-status vocabulary, shared by the notebook header and the Kernels dock so
// the two surfaces can't drift apart — they previously held identical private copies,
// and "reads the same on both" was only true by hand.
export const STATUS_DOT: Record<KernelStatus, string> = {
  none: 'bg-ctp-surface2',
  idle: 'bg-ctp-green',
  busy: 'bg-ctp-yellow animate-pulse',
  starting: 'bg-ctp-overlay animate-pulse',
  dead: 'bg-ctp-red',
}
export const STATUS_LABEL: Record<KernelStatus, string> = {
  none: 'no kernel', idle: 'idle', busy: 'busy', starting: 'starting…', dead: 'dead',
}
