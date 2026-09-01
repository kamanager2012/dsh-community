/** Official web-app prints this prefix once the Loader tree has settled. */
export const READINESS_PREFIX = 'dsh web: '

export const DEFAULT_READINESS_TIMEOUT_MS = 90_000

export interface ReadinessParser {
  push(chunk: string): string | undefined
  finalize(): string
}

function canonicalLoopbackAuthority(rawUrl: string, url: URL): boolean {
  const match = rawUrl.match(/^http:\/\/([^/?#]+)(?:[/?#]|$)/u)
  if (!match?.[1]) return false
  return match[1] === `${url.hostname}:${url.port}`
}

function hasAllowedReadinessQuery(url: URL): boolean {
  if (url.search === '') return true
  const entries = [...url.searchParams.entries()]
  return entries.length === 1
    && entries[0]?.[0] === 'token'
    && (entries[0]?.[1].length ?? 0) > 0
}

/**
 * Lifecycle only: official start + loopback port.
 * stdout/stderr are otherwise diagnostics. Do not parse agent/tool/session
 * state out of these streams — that is official session/event, not a Desktop protocol.
 *
 * Official 0.1.2-alpha.3 may print a one-time browser bootstrap token in the
 * readiness URL. The token is intentionally discarded: callers receive only
 * the loopback origin, and rejection paths never echo the credential-bearing URL.
 */
export function parseReadinessLine(line: string): string | undefined {
  const trimmed = line.replace(/\r$/u, '')
  if (!trimmed.startsWith(READINESS_PREFIX)) return undefined
  const rawUrl = trimmed.slice(READINESS_PREFIX.length).split(/\s/u, 1)[0]
  if (rawUrl === undefined || rawUrl.length === 0) {
    throw new Error('official readiness line has no URL')
  }

  // Official 0.1.0-rc.8 also prints `dsh web: opening the default browser; pass --no-open to disable`.
  // That shares the readiness prefix but is not a bind URL — skip it.
  if (!/^https?:\/\//u.test(rawUrl)) return undefined

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('official readiness URL is invalid')
  }

  const port = Number(url.port)
  if (
    url.protocol !== 'http:'
    || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    || !canonicalLoopbackAuthority(rawUrl, url)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || !hasAllowedReadinessQuery(url)
    || url.hash !== ''
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
  ) {
    throw new Error('official readiness URL must be canonical loopback HTTP with an explicit port and optional token query')
  }
  return url.origin
}

export function createReadinessParser(): ReadinessParser {
  let pending = ''
  let readyUrl: string | undefined

  const accept = (line: string): string | undefined => {
    const parsed = parseReadinessLine(line)
    if (parsed === undefined) return undefined
    if (readyUrl !== undefined && parsed !== readyUrl) {
      throw new Error(`official dsh web emitted conflicting readiness origins: ${readyUrl} and ${parsed}`)
    }
    readyUrl = parsed
    return readyUrl
  }

  return {
    push(chunk) {
      pending += chunk
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline === -1) return readyUrl
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        const parsed = accept(line)
        if (parsed !== undefined) return parsed
      }
    },
    finalize() {
      if (pending !== '') accept(pending)
      if (readyUrl === undefined) {
        throw new Error('official dsh web exited before emitting its readiness URL')
      }
      return readyUrl
    },
  }
}
