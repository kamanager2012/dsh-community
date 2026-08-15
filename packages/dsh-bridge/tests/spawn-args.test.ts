import { describe, expect, it } from 'vitest'
import { officialWebArgv } from '../src/spawn-web.ts'

describe('officialWebArgv', () => {
  it('is the published web alias plus loopback bind', () => {
    expect(officialWebArgv()).toEqual(['web', '--host', '127.0.0.1', '--port', '0'])
    expect(officialWebArgv({ host: '127.0.0.1', port: 3080 })).toEqual([
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '3080',
    ])
  })
})
