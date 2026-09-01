/** Official web-app prints this prefix once the Loader tree has settled. */
export const READINESS_PREFIX = 'dsh web: '

export const DEFAULT_READINESS_TIMEOUT_MS = 90_000

const PROCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export interface ReadinessParserOptions {
  /**
   * Receives the validated alpha.3 browser bootstrap URL. This is a credential:
   * keep it process-local, consume it once, and never place it in snapshots or logs.
   */
  readonly onBrowserBootstrapUrl?: (url: string) => void
}

export interface ReadinessParser {
  push(chunk: string): string | undefined
  finalize(): string
}

interface ParsedReadiness {
  readonly origin: string
  readonly browserBootstrapUrl?: string
}

function canonicalLoopbackAuthority(rawUrl: string, url: URL): boolean {
  const match = rawUrl.match(/^http:\/\/([^/?#]+)(?:[/?#]|$)/u)
  if (!match?.[1]) return false
  return match[1] === `${url.hostname}:${url.port}`
}

function browserBootstrapUrl(url: URL): string | undefined {
  if (url.search === '') return undefined
  const entries = [...url.searchParams.entries()]
  if (
    entries.length !== 1
    || entries[0]?.[0] !== 'token'
    || !PROCESS_TOKEN_PATTERN.test(entries[0]?.[1] ?? '')
  ) {
    throw new Error('official readiness URL has an invalid token query')
  }
  return url.href
}

function parseReadinessDetail(line: string): ParsedReadiness | undefined {
  const trimmed = line.replace(/\r$/u, '')
  if (!trimmed.startsWith(READINESS_PREFIX)) return undefined
  const rawUrl = trimmed.slice(READINESS_PREFIX.length).split(/\s/u, 1)[0]
  if (rawUrl === undefined || rawUrl.length === 0) {
    throw new Error('official readiness line has no URL')
  }

  // Official 0.1.0-rc.8 also prints a browser-handoff diagnostic on this prefix.
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
    || url.hash !== ''
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
  ) {
    throw new Error(
      'official readiness URL must be canonical loopback HTTP with an explicit port and optional token query',
    )
  }

  const bootstrap = browserBootstrapUrl(url)
  return {
    origin: url.origin,
    ...(bootstrap === undefined ? {} : { browserBootstrapUrl: bootstrap }),
  }
}

/**
 * Lifecycle-only view of the official ready line. Callers receive a clean
 * loopback origin; alpha.3's process token is exposed only through the parser's
 * explicit one-time bootstrap callback.
 */
export function parseReadinessLine(line: string): string | undefined {
  return parseReadinessDetail(line)?.origin
}

export function createReadinessParser(options: ReadinessParserOptions = {}): ReadinessParser {
  let pending = ''
  let readyUrl: string | undefined

  const accept = (line: string): string | undefined => {
    const parsed = parseReadinessDetail(line)
    if (parsed === undefined) return undefined
    if (readyUrl !== undefined && parsed.origin !== readyUrl) {
      throw new Error(
        `official dsh web emitted conflicting readiness origins: ${readyUrl} and ${parsed.origin}`,
      )
    }
    readyUrl = parsed.origin
    if (parsed.browserBootstrapUrl !== undefined) {
      options.onBrowserBootstrapUrl?.(parsed.browserBootstrapUrl)
    }
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
