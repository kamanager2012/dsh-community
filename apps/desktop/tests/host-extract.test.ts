import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ensureOfficialHostExtracted,
  isOfficialHostReady,
  officialHostBin,
  officialHostReady,
  officialHostRoot,
} from '../src/host-extract.ts'

function writeArchive(root: string, body: string): string {
  const payload = join(root, 'payload')
  const binRel = officialHostBin(payload)
  mkdirSync(join(binRel, '..'), { recursive: true })
  writeFileSync(binRel, body)
  const appBoot = join(payload, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  mkdirSync(appBoot, { recursive: true })
  writeFileSync(join(appBoot, 'package.json'), '{"name":"@deepseek-ai/dsh-app-boot"}\n')
  const archive = join(root, 'official-dsh.tar')
  const packed = spawnSync('tar', ['-cf', archive, 'node_modules'], { cwd: payload })
  expect(packed.status).toBe(0)
  return archive
}

describe('ensureOfficialHostExtracted', () => {
  it('unpacks the official archive once per pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-extract-'))
    const dest = officialHostRoot(root, '0.1.0-rc.6')
    const archive = writeArchive(root, '#!/usr/bin/env node\n')

    const first = ensureOfficialHostExtracted({ archivePath: archive, destRoot: dest })
    expect(first).toBe(officialHostBin(dest))
    expect(isOfficialHostReady(dest)).toBe(true)
    const again = ensureOfficialHostExtracted({ archivePath: archive, destRoot: dest })
    expect(again).toBe(first)
  })

  it('retries a dest that has a bin but no ready stamp', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-retry-'))
    const dest = officialHostRoot(root, '0.1.0-rc.6')
    const archive = writeArchive(root, 'good-bin\n')
    mkdirSync(join(officialHostBin(dest), '..'), { recursive: true })
    writeFileSync(officialHostBin(dest), 'stale\n')
    expect(isOfficialHostReady(dest)).toBe(false)

    const extracted = ensureOfficialHostExtracted({ archivePath: archive, destRoot: dest })
    expect(readFileSync(extracted, 'utf8')).toBe('good-bin\n')
    expect(readFileSync(officialHostReady(dest), 'utf8')).toBe('ok\n')
  })

  it('wipes a half-extracted dest before retrying', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-wipe-'))
    const dest = officialHostRoot(root, '0.1.0-rc.6')
    const archive = writeArchive(root, 'fresh\n')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'junk.txt'), 'nope')
    rmSync(officialHostReady(dest), { force: true })

    ensureOfficialHostExtracted({ archivePath: archive, destRoot: dest })
    expect(readFileSync(officialHostBin(dest), 'utf8')).toBe('fresh\n')
  })
})
