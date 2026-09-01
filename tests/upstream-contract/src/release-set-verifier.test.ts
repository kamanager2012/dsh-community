import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyReleaseSet } from '../../../scripts/verify-release-set.mjs'

const roots: string[] = []

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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('verify-release-set', () => {
  it('accepts a complete cross-platform release set', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')

    expect(verifyReleaseSet({ artifactsRoot: artifacts, signedRoot: signed })).toMatchObject({
      primaryCount: 3,
      sidecarCount: 3,
      bundleCount: 6,
    })
  })

  it('rejects a tampered binary even when sidecars and bundles still exist', () => {
    const { artifacts, signed } = makeRoot()
    const linux = addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    writeFileSync(linux, 'tampered')

    expect(() => verifyReleaseSet({ artifactsRoot: artifacts, signedRoot: signed })).toThrow(/sha256 mismatch/u)
  })

  it('rejects missing bundles', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    rmSync(join(signed, 'windows', 'DSH Community Setup.exe.sigstore.json'))

    expect(() => verifyReleaseSet({ artifactsRoot: artifacts, signedRoot: signed })).toThrow(/missing or empty sigstore bundle/u)
  })

  it('rejects orphan signature bundles that do not map to a published asset', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    writeFileSync(join(signed, 'linux', 'ghost.bin.sigstore.json'), '{"bundle":true}\n')

    expect(() => verifyReleaseSet({ artifactsRoot: artifacts, signedRoot: signed })).toThrow(/orphan sigstore bundle/u)
  })

  it('rejects an orphan checksum sidecar without a primary asset', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    writeFileSync(join(artifacts, 'linux', 'ghost.bin.sha256'), '0'.repeat(64) + '  ghost.bin\n')
    writeFileSync(join(signed, 'linux', 'ghost.bin.sha256.sigstore.json'), '{"bundle":true}\n')

    expect(() => verifyReleaseSet({ artifactsRoot: artifacts, signedRoot: signed })).toThrow(/orphan sha256 sidecar/u)
  })

  it('rejects a sidecar that names a different file', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    const mac = addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    const digest = createHash('sha256').update('macos-bytes').digest('hex')
    writeFileSync(mac + '.sha256', digest + '  wrong-name.dmg\n')

    expect(() => verifyReleaseSet({ artifactsRoot: artifacts, signedRoot: signed })).toThrow(/filename mismatch/u)
  })
})
