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

/**
 * The shell only ever loads documents it generated itself: main.ts `dataUrl()`
 * encodes pages.ts / chrome.ts HTML with exactly this media type.
 */
export const SHELL_DATA_PREFIX = 'data:text/html;charset=utf-8,'

/** Preload bridge every generated chrome document references. */
const SHELL_BRIDGE_MARKER = 'window.dshCommunity'

export function shellIpcMarker(token: string): string {
  return `<!-- dsh-shell:${token} -->`
}

export function stampShellDocument(html: string, token: string): string {
  const marker = shellIpcMarker(token)
  if (html.includes(marker)) return html
  const closingIndex = html.lastIndexOf('</html>')
  if (closingIndex === -1) return `${html}\n${marker}`
  return `${html.slice(0, closingIndex)}${marker}\n${html.slice(closingIndex)}`
}

/** True only for our own generated chrome documents, not arbitrary data:* URLs. */
export function isDataHtmlUrl(raw: string, expectedToken?: string): boolean {
  if (!raw.startsWith(SHELL_DATA_PREFIX)) return false
  try {
    const html = decodeURIComponent(raw.slice(SHELL_DATA_PREFIX.length))
    if (!html.includes(SHELL_BRIDGE_MARKER)) return false
    if (expectedToken !== undefined && expectedToken !== '' && !html.includes(shellIpcMarker(expectedToken))) {
      return false
    }
    return true
  } catch {
    return false
  }
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

/**
 * Fail-closed origin check for IPC calls: only shell chrome documents
 * bearing our bridge marker (and per-boot token when provided) may invoke desktop IPC.
 */
export function isAuthorizedIpcSender(
  senderFrame: { url: string } | null | undefined,
  expectedToken?: string,
): boolean {
  if (senderFrame == null || typeof senderFrame.url !== 'string') return false
  return isDataHtmlUrl(senderFrame.url, expectedToken)
}
