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

export function isDataHtmlUrl(raw: string): boolean {
  return raw.startsWith('data:text/html')
}

/** Shell window: official origin + our chrome documents. */
export function decideNavigation(raw: string, origin: string): NavigationDecision {
  if (isDataHtmlUrl(raw)) return 'allow'
  if (origin !== '' && sameOrigin(raw, origin)) return 'allow'
  if (isHttpUrl(raw)) return 'open-external'
  return 'block'
}

/** Official WebContentsView: never load our chrome documents into the agent UI. */
export function decideOfficialViewNavigation(raw: string, origin: string): NavigationDecision {
  if (origin !== '' && sameOrigin(raw, origin)) return 'allow'
  if (isHttpUrl(raw)) return 'open-external'
  return 'block'
}
