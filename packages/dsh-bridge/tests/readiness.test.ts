import { describe, expect, it } from 'vitest'
import { createReadinessParser, parseReadinessLine, READINESS_PREFIX } from '../src/readiness.ts'

const TOKEN_A = 'A'.repeat(43)
const TOKEN_B = 'B'.repeat(43)

describe('parseReadinessLine', () => {
  it('accepts canonical loopback readiness URLs', () => {
    expect(parseReadinessLine(`${READINESS_PREFIX}http://127.0.0.1:3080`)).toBe('http://127.0.0.1:3080')
    expect(parseReadinessLine(`${READINESS_PREFIX}http://localhost:4123\r`)).toBe('http://localhost:4123')
  })

  it('accepts the alpha.3 process token but returns only the clean origin', () => {
    expect(parseReadinessLine(
      `${READINESS_PREFIX}http://127.0.0.1:3080/?token=${TOKEN_A}`,
    )).toBe('http://127.0.0.1:3080')
  })

  it('never echoes a readiness token when rejecting an unsafe URL', () => {
    let message = ''
    try {
      parseReadinessLine(`${READINESS_PREFIX}http://example.com:3080/?token=${TOKEN_A}`)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('loopback')
    expect(message).not.toContain(TOKEN_A)
  })

  it('ignores unrelated stdout', () => {
    expect(parseReadinessLine('loading plugins')).toBeUndefined()
    expect(parseReadinessLine('web: http://127.0.0.1:3080')).toBeUndefined()
  })

  it('rejects non-loopback, non-http, non-canonical, or credential-bearing authorities', () => {
    expect(() => parseReadinessLine(`${READINESS_PREFIX}http://0.0.0.0:3080`)).toThrow(/loopback/)
    expect(() => parseReadinessLine(`${READINESS_PREFIX}https://127.0.0.1:3080`)).toThrow(/loopback/)
    expect(() => parseReadinessLine(`${READINESS_PREFIX}http://127.0.0.1:3080/chat`)).toThrow(/loopback/)
    expect(() => parseReadinessLine(`${READINESS_PREFIX}http://127.0.0.1`)).toThrow(/loopback/)
    expect(() => parseReadinessLine(`${READINESS_PREFIX}http://user@127.0.0.1:3080/`)).toThrow(/loopback/)
    expect(() => parseReadinessLine(`${READINESS_PREFIX}http://127.1:3080/`)).toThrow(/loopback/)
  })

  it('accepts only one exact non-empty process token query and no fragment', () => {
    expect(() => parseReadinessLine(`${READINESS_PREFIX}http://127.0.0.1:3080/?token=`)).toThrow(/token query/)
    expect(() => parseReadinessLine(
      `${READINESS_PREFIX}http://127.0.0.1:3080/?token=short`,
    )).toThrow(/token query/)
    expect(() => parseReadinessLine(
      `${READINESS_PREFIX}http://127.0.0.1:3080/?token=${TOKEN_A}&token=${TOKEN_B}`,
    )).toThrow(/token query/)
    expect(() => parseReadinessLine(
      `${READINESS_PREFIX}http://127.0.0.1:3080/?token=${TOKEN_A}&next=x`,
    )).toThrow(/token query/)
    expect(() => parseReadinessLine(
      `${READINESS_PREFIX}http://127.0.0.1:3080/?token=${TOKEN_A}#fragment`,
    )).toThrow(/loopback/)
  })

  it('skips the historical browser-handoff diagnostic that shares the prefix', () => {
    expect(parseReadinessLine(`${READINESS_PREFIX}opening the default browser; pass --no-open to disable`)).toBeUndefined()
    expect(parseReadinessLine(`${READINESS_PREFIX}not-a-url`)).toBeUndefined()
  })
})

describe('createReadinessParser', () => {
  it('assembles a split official line', () => {
    const parser = createReadinessParser()
    expect(parser.push('dsh we')).toBeUndefined()
    expect(parser.push('b: http://127.0.0.1:9')).toBeUndefined()
    expect(parser.push('001/\nmore\n')).toBe('http://127.0.0.1:9001')
  })

  it('reports the credential-bearing alpha.3 bootstrap only through the explicit callback', () => {
    const bootstraps: string[] = []
    const parser = createReadinessParser({
      onBrowserBootstrapUrl: (url) => {
        bootstraps.push(url)
      },
    })
    expect(parser.push(`${READINESS_PREFIX}opening the default browser; pass --no-open to disable\n`))
      .toBeUndefined()
    expect(parser.push(
      `${READINESS_PREFIX}http://127.0.0.1:3080/?token=${TOKEN_A}\n`,
    )).toBe('http://127.0.0.1:3080')
    expect(parser.finalize()).toBe('http://127.0.0.1:3080')
    expect(bootstraps).toEqual([`http://127.0.0.1:3080/?token=${TOKEN_A}`])
  })

  it('treats different bootstrap tokens on the same origin as the same readiness origin', () => {
    const parser = createReadinessParser()
    parser.push(`${READINESS_PREFIX}http://127.0.0.1:3080/?token=${TOKEN_A}\n`)
    expect(parser.push(`${READINESS_PREFIX}http://127.0.0.1:3080/?token=${TOKEN_B}\n`))
      .toBe('http://127.0.0.1:3080')
  })

  it('rejects two different ready origins', () => {
    const parser = createReadinessParser()
    parser.push(`${READINESS_PREFIX}http://127.0.0.1:3080/?token=${TOKEN_A}\n`)
    expect(() => parser.push(
      `${READINESS_PREFIX}http://127.0.0.1:3081/?token=${TOKEN_B}\n`,
    )).toThrow(/conflicting/)
  })

  it('finalize fails when the process never printed ready', () => {
    const parser = createReadinessParser()
    parser.push('still booting\n')
    expect(() => parser.finalize()).toThrow(/before emitting/)
  })
})
