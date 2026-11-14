export type WindowCloseDecision = 'hide' | 'quit'
export type HostCrashDecision = 'offer-restart' | 'ignore'

export interface WindowCloseInput {
  readonly quitting: boolean
  readonly trayAvailable: boolean
}

/**
 * Reconstruction of "tray owns the host":
 * close hides the window when a tray is present; there is no host without a
 * visible owner if the tray failed to create.
 */
export function decideWindowClose(input: WindowCloseInput): WindowCloseDecision {
  if (input.quitting) return 'quit'
  return input.trayAvailable ? 'hide' : 'quit'
}

export function decideHostCrash(quitting: boolean): HostCrashDecision {
  return quitting ? 'ignore' : 'offer-restart'
}

/**
 * Ensures async background completions (e.g. remote host start or plugin install)
 * only re-render and switch into their target HTML view when the user is still on that page.
 */
export function shouldApplyAsyncPageUpdate(input: {
  readonly quitting: boolean
  readonly showingOfficial: boolean
  readonly currentPage: string
  readonly expectedPage: string
}): boolean {
  return !input.quitting && !input.showingOfficial && input.currentPage === input.expectedPage
}
