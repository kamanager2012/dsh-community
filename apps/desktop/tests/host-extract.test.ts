import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ensureOfficialHostExtracted,
  officialHostBin,
  officialHostRoot,
} from '../src/host-extract.ts'

describe('ensureOfficialHostExtracted', () => {
  it('unpacks the official archive once per pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-extract-'))
    const payload = join(root, 'payload')
    const dest = officialHostRoot(root, '0.1.0-rc.6')
    const binRel = officialHostBin(payload)
    mkdirSync(join(binRel, '..'), { recursive: true })
    writeFileSync(binRel, '#!/usr/bin/env node\n')
    const archive = join(root, 'official-dsh.tar')
    const packed = spawnSync('tar', ['-cf', archive, 'node_modules'], { cwd: payload })
    expect(packed.status).toBe(0)

    const first = ensureOfficialHostExtracted({ archivePath: archive, destRoot: dest })
    expect(first).toBe(officialHostBin(dest))
    const again = ensureOfficialHostExtracted({ archivePath: archive, destRoot: dest })
    expect(again).toBe(first)
  })
})
