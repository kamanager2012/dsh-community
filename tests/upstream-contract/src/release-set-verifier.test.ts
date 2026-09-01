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

function addSbom(artifacts: string, signed: string, body?: string) {
  const sbom = body ?? JSON.stringify({
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    metadata: {
      component: {
        type: 'application',
        name: 'dsh-community-official-runtime-lock',
        version: '0.0.0',
      },
    },
    components: [
      {
        type: 'application',
        name: '@deepseek-ai/dsh',
        version: '0.1.1-rc.2',
      },
    ],
  })
  return addAsset(
    artifacts,
    signed,
    'sbom',
    'dsh-community-0.1.1-rc.2-official-runtime.cdx.json',
    sbom + '\n',
  )
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
    addSbom(artifacts, signed)

    const result = runVerifier(artifacts, signed)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      'release-set verified: primary=3 metadata=1 sidecars=4 bundles=8',
    )
  })

  it('rejects a tampered binary even when sidecars and bundles still exist', () => {
    const { artifacts, signed } = makeRoot()
    const linux = addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    addSbom(artifacts, signed)
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
    addSbom(artifacts, signed)
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
    addSbom(artifacts, signed)
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
    addSbom(artifacts, signed)
    writeFileSync(join(artifacts, 'linux', 'ghost.bin.sha256'), '0'.repeat(64) + '  ghost.bin\n')
    writeFileSync(join(signed, 'linux', 'ghost.bin.sha256.sigstore.json'), '{"bundle":true}\n')

    const result = runVerifier(artifacts, signed)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('orphan sha256 sidecar')
  })

  it('rejects a release with no official-runtime SBOM', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')

    const result = runVerifier(artifacts, signed)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('expected exactly one official-runtime CycloneDX SBOM')
  })

  it('rejects malformed official-runtime SBOM JSON', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    addSbom(artifacts, signed, '{not-json')

    const result = runVerifier(artifacts, signed)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('invalid JSON in official-runtime SBOM')
  })

  it('rejects an SBOM that does not describe official DSH', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    addSbom(artifacts, signed, JSON.stringify({
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      metadata: { component: { name: 'dsh-community-official-runtime-lock' } },
      components: [],
    }))

    const result = runVerifier(artifacts, signed)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not include @deepseek-ai/dsh')
  })
  it('rejects a sidecar that names a different file', () => {
    const { artifacts, signed } = makeRoot()
    addAsset(artifacts, signed, 'linux', 'dsh-community.AppImage', 'linux-bytes')
    addAsset(artifacts, signed, 'windows', 'DSH Community Setup.exe', 'windows-bytes')
    const mac = addAsset(artifacts, signed, 'macos', 'dsh-community.dmg', 'macos-bytes')
    addSbom(artifacts, signed)
    const digest = createHash('sha256').update('macos-bytes').digest('hex')
    writeFileSync(mac + '.sha256', digest + '  wrong-name.dmg\n')

    const result = runVerifier(artifacts, signed)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('filename mismatch')
  })
})
