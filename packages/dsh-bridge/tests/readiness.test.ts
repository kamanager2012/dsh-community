import { describe, expect, it } from 'vitest'
import { createReadinessParser, parseReadinessLine, READINESS_PREFIX } from '../src/readiness.ts'

describe('parseReadinessLine', () => {
  it('accepts canonical loopback readiness URLs', () => {
    expect(parseReadinessLine(`${READINESS_PREFIX}http://127.0.0.1:3080`)).toBe('http://127.0.0.1:3080')
    expect(parseReadinessLine(`${READINESS_PREFIX}http://localhost:4123\r`)).toBe('http://localhost:4123')
  })

  it('accepts alpha.3 browser bootstrap token but returns only the origin', () => {
    expect(parseReadinessLine(
      `${READINESS_PREFIX}http://127.0.0.1:3080/?token=secret-bootstrap-token`,
    )).toBe('http://127.0.0.1:3080')
    expect(parseReadinessLine(
      `${READINESS_PREFIX}http://localhost:4123/?token=a%2Fb%2Bc`,
    )).toBe('http://localhost:4123')
  })

  it('never echoes a readiness token when rejecting an unsafe URL', () => {
    const secret = 'do-not-leak-this-token'
    let message = ''
    try {
      parseReadinessLine(`${READINESS_PREFIX}http://example.com:3080/?token=${secret}`)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('loopback')
    expect(message).not.toContain(secret)
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

  it('accepts only one non-empty token query and no fragment', () => {
    expect(() => parseReadinessLine(`${READINESS_PREFIX}http://127.0.0.1:3080/?token=`)).toThrow(/token query/)
    expect(() => parseReadinessLine(
      `${READINESS_PREFIX}http://127.0.0.1:3080/?token=one&token=two`,
    )).toThrow(/token query/)
    expect(() => parseReadinessLine(
      `${READINESS_PREFIX}http://127.0.0.1:3080/?token=one&next=x`,
    )).toThrow(/token query/)
    expect(() => parseReadinessLine(
      `${READINESS_PREFIX}http://127.0.0.1:3080/?token=one#fragment`,
    )).toThrow(/token query/)
  })

  it('skips the 0.1.0-rc.8-era browser-handoff diagnostic that shares the prefix', () => {
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

  it('accepts a tokenized URL after the browser-handoff diagnostic without retaining the token', () => {
    const parser = createReadinessParser()
    expect(parser.push(`${READINESS_PREFIX}opening the default browser; pass --no-open to disable\n`)).toBeUndefined()
    expect(parser.push(
      `${READINESS_PREFIX}http://127.0.0.1:3080/?token=secret-bootstrap-token\n`,
    )).toBe('http://127.0.0.1:3080')
    expect(parser.finalize()).toBe('http://127.0.0.1:3080')
  })

  it('treats different bootstrap tokens on the same origin as the same readiness origin', () => {
    const parser = createReadinessParser()
    parser.push(`${READINESS_PREFIX}http://127.0.0.1:3080/?token=first\n`)
    expect(parser.push(`${READINESS_PREFIX}http://127.0.0.1:3080/?token=second\n`))
      .toBe('http://127.0.0.1:3080')
  })

  it('rejects two different ready origins', () => {
    const parser = createReadinessParser()
    parser.push(`${READINESS_PREFIX}http://127.0.0.1:3080/?token=first\n`)
    expect(() => parser.push(
      `${READINESS_PREFIX}http://127.0.0.1:3081/?token=second\n`,
    )).toThrow(/conflicting/)
  })

  it('finalize fails when the process never printed ready', () => {
    const parser = createReadinessParser()
    parser.push('still booting\n')
    expect(() => parser.finalize()).toThrow(/before emitting/)
  })
})
