import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  desktopSourceRequiredMessage,
  findPackagedDesktopExecutable,
  packagedReleaseCandidates,
  siblingExecutableCandidates,
} from '../src/desktop-launch.ts'

function touch(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
}

describe('packaged desktop discovery', () => {
  it('lists the electron-builder product executables per platform', () => {
    const candidates = packagedReleaseCandidates('/release')
    expect(candidates).toContain('/release/linux-unpacked/dsh-community')
    expect(candidates).toContain('/release/win-unpacked/DSH Community.exe')
    expect(candidates.some((c) => c.includes('DSH Community.app'))).toBe(true)
    expect(siblingExecutableCandidates('/bundle')).toEqual([
      '/bundle/dsh-community',
      '/bundle/DSH Community.exe',
    ])
  })

  it('finds a linux-unpacked build in the source tree release output', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-src-'))
    const bin = join(root, 'apps/desktop/release/linux-unpacked/dsh-community')
    touch(bin)
    const found = findPackagedDesktopExecutable({ execPath: join(root, 'elsewhere/node'), repoRoot: root })
    expect(found).toBe(bin)
  })

  it('prefers the binary next to the running executable (unpacked bundle)', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundle-'))
    const bundled = join(root, 'dsh-community')
    touch(bundled)
    touch(join(root, 'apps/desktop/release/win-unpacked/DSH Community.exe'))
    const found = findPackagedDesktopExecutable({ execPath: join(root, 'some-cli'), repoRoot: root })
    expect(found).toBe(bundled)
  })

  it('returns undefined when no package layout exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-empty-'))
    expect(findPackagedDesktopExecutable({ execPath: join(root, 'node'), repoRoot: root })).toBeUndefined()
    expect(findPackagedDesktopExecutable({ execPath: join(root, 'node') })).toBeUndefined()
  })

  it('ignores directories that only look like the binary', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-dir-'))
    mkdirSync(join(root, 'linux-unpacked', 'dsh-community'), { recursive: true })
    expect(findPackagedDesktopExecutable({ execPath: '/bin/node' })).toBeUndefined()
    expect(findPackagedDesktopExecutable({ execPath: '/bin/node', repoRoot: root })).toBeUndefined()
  })

  it('failure message tells the operator what to do instead', () => {
    const message = desktopSourceRequiredMessage('spawn pnpm ENOENT')
    expect(message).toMatch(/pnpm install/)
    expect(message).toMatch(/apps\/desktop\/release\/linux-unpacked\/dsh-community/)
    expect(message).toContain('spawn pnpm ENOENT')
  })
})
