export type NavigationDecision = 'allow' | 'open-external' | 'block'

export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function sameOrigin(raw: string, expected: string): boolean {
  try {
    return new URL(raw).origin === expected
  } catch {
    return false
  }
}

/** Official UI stays on the ready origin; everything else leaves the shell. */
export function decideNavigation(raw: string, origin: string): NavigationDecision {
  if (origin !== '' && sameOrigin(raw, origin)) return 'allow'
  if (isHttpUrl(raw)) return 'open-external'
  return 'block'
}
