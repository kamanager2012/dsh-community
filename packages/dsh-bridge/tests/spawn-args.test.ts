import { describe, expect, it } from 'vitest'
import { officialHostArgs, officialWebArgv } from '../src/spawn-web.ts'

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

describe('officialHostArgs', () => {
  it('prepends Node flags before the official CLI entry on the Electron-as-node fallback', () => {
    expect(officialHostArgs({
      cliEntry: '/staged/bin.js',
      bind: { host: '127.0.0.1', port: 0 },
      execArgv: ['--expose-internals'],
    })).toEqual([
      '--expose-internals',
      '/staged/bin.js',
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ])
  })

  it('spawns without flags when the caller is plain Node', () => {
    expect(officialHostArgs({ cliEntry: '/staged/bin.js' })).toEqual([
      '/staged/bin.js',
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ])
  })
})
