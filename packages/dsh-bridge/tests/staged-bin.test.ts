import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { PINNED_DSH_VERSION } from '../src/pin.ts'
import { resolveOfficialDsh } from '../src/resolve-bin.ts'

describe('packaged official bin resolution', () => {
  it('DSH_COMMUNITY_BIN points at a staged bin with its own package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-staged-'))
    const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(pkgDir, { recursive: true })
    const binPath = join(pkgDir, 'lib', 'bin.js')
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(binPath, '#!/usr/bin/env node\n')
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: PINNED_DSH_VERSION,
      bin: { dsh: 'lib/bin.js' },
    }))

    const install = resolveOfficialDsh({
      from: import.meta.url,
      env: { DSH_COMMUNITY_BIN: binPath },
    })
    expect(install.binPath).toBe(binPath)
    expect(install.version).toBe(PINNED_DSH_VERSION)
    expect(install.packageDir).toBe(pkgDir)
  })

  it('rejects a staged override that does not exist', () => {
    expect(() => resolveOfficialDsh({
      from: import.meta.url,
      env: { DSH_COMMUNITY_BIN: '/nope/missing/bin.js' },
    })).toThrow(/DSH_COMMUNITY_BIN does not exist/)
  })

  it('still resolves the published package from the workspace', () => {
    const install = resolveOfficialDsh({ from: import.meta.url })
    expect(existsSync(install.binPath)).toBe(true)
    expect(install.version).toBe(PINNED_DSH_VERSION)
  })
})
