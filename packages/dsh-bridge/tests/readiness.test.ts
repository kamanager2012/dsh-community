import { describe, expect, it } from 'vitest'
import { createReadinessParser, parseReadinessLine, READINESS_PREFIX } from '../src/readiness.ts'

describe('parseReadinessLine', () => {
  it('accepts the official loopback print line', () => {
    expect(parseReadinessLine(`${READINESS_PREFIX}http://127.0.0.1:3080`)).toBe('http://127.0.0.1:3080')
    expect(parseReadinessLine(`${READINESS_PREFIX}http://localhost:4123\r`)).toBe('http://localhost:4123')
  })

  it('ignores unrelated stdout', () => {
    expect(parseReadinessLine('loading plugins')).toBeUndefined()
    expect(parseReadinessLine('web: http://127.0.0.1:3080')).toBeUndefined()
  })

  it('rejects non-loopback or non-http binds', () => {
    expect(() => parseReadinessLine(`${READINESS_PREFIX}http://0.0.0.0:3080`)).toThrow(/loopback/)
    expect(() => parseReadinessLine(`${READINESS_PREFIX}https://127.0.0.1:3080`)).toThrow(/loopback/)
    expect(() => parseReadinessLine(`${READINESS_PREFIX}http://127.0.0.1:3080/chat`)).toThrow(/loopback/)
    expect(() => parseReadinessLine(`${READINESS_PREFIX}http://127.0.0.1`)).toThrow(/loopback/)
    expect(() => parseReadinessLine(`${READINESS_PREFIX}not-a-url`)).toThrow(/invalid/)
  })
})

describe('createReadinessParser', () => {
  it('assembles a split official line', () => {
    const parser = createReadinessParser()
    expect(parser.push('dsh we')).toBeUndefined()
    expect(parser.push('b: http://127.0.0.1:9')).toBeUndefined()
    expect(parser.push('001/\nmore\n')).toBe('http://127.0.0.1:9001')
  })

  it('rejects two different ready URLs', () => {
    const parser = createReadinessParser()
    parser.push(`${READINESS_PREFIX}http://127.0.0.1:3080\n`)
    expect(() => parser.push(`${READINESS_PREFIX}http://127.0.0.1:3081\n`)).toThrow(/conflicting/)
  })

  it('finalize fails when the process never printed ready', () => {
    const parser = createReadinessParser()
    parser.push('still booting\n')
    expect(() => parser.finalize()).toThrow(/before emitting/)
  })
})
