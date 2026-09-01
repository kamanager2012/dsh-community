import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const verifier = join(repoRoot, 'scripts', 'verify-release-set.mjs')

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-set-'))
  roots.push(root)
  const artifacts = join(root, 'dist-artifacts')
  const signed = join(root, 'dist-signed')
  mkdirSync(artifacts, { recursive: true })
  mkdirSync(signed, { recursive: true })
  return { root, artifacts, signed }
}

function addAsset(artifacts: string, signed: string, bucket: string, name: string, body: string) {
  const assetDir = join(artifacts, bucket)
  const signedDir = join(signed, bucket)
  mkdirSync(assetDir, { recursive: true })
  mkdirSync(signedDir, { recursive: true })
  const asset = join(assetDir, name)
  writeFileSync(asset, body)
  const digest = createHash('sha256').update(body).digest('hex')
  writeFileSync(asset + '.sha256', digest + '  ' + basename(asset) + '\n')
  writeFileSync(join(signedDir, name + '.sigstore.json'), '{"bundle":true}\n')
  writeFileSync(join(signedDir, name + '.sha256.sigstore.json'), '{"bundle":true}\n')
  return asset
}

function runVerifier(artifacts: string, signed: string) {
  return spawnSync(process.execPath, [verifier, artifacts, signed], {
    encoding: 'utf8',
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('verify-release-set CLI', () => {
  it('accepts a complete cross-platform release set', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')

    const result = runVerifier(artifacts, signed)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('release-set verified: primary=3 sidecars=3 bundles=6')
  })

  it('rejects a tampered binary even when sidecars and bundles still exist', () => {
    const { artifacts, signed } = makeRoot()
    const linux = addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    writeFileSync(linux, 'tampered')

    const result = runVerifier(artifacts, signed)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('sha256 mismatch')
  })

  it('rejects missing bundles', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    rmSync(join(signed, 'windows', 'DSH Community Setup.exe.sigstore.json'))

    const result = runVerifier(artifacts, signed)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing or empty sigstore bundle')
  })

  it('rejects orphan signature bundles that do not map to a published asset', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    writeFileSync(join(signed, 'linux', 'ghost.bin.sigstore.json'), '{"bundle":true}\n')

    const result = runVerifier(artifacts, signed)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('orphan sigstore bundle')
  })

  it('rejects an orphan checksum sidecar without a primary asset', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    writeFileSync(join(artifacts, 'linux', 'ghost.bin.sha256'), '0'.repeat(64) + '  ghost.bin\n')
    writeFileSync(join(signed, 'linux', 'ghost.bin.sha256.sigstore.json'), '{"bundle":true}\n')

    const result = runVerifier(artifacts, signed)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('orphan sha256 sidecar')
  })

  it('rejects a sidecar that names a different file', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    const mac = addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    const digest = createHash('sha256').update('macos-bytes').digest('hex')
    writeFileSync(mac + '.sha256', digest + '  wrong-name.dmg\n')

    const result = runVerifier(artifacts, signed)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('filename mismatch')
  })
})
