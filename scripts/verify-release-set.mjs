#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRIMARY_SUFFIXES = ['.AppImage', '.exe', '.zip', '.dmg']
const METADATA_SUFFIXES = ['-official-runtime.cdx.json']

function fail(message) {
  throw new Error(message)
}

function walk(root) {
  if (!existsSync(root)) fail(`missing directory: ${root}`)
  const out = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) fail(`symlink not allowed in release set: ${full}`)
      if (entry.isDirectory()) {
        visit(full)
      } else if (entry.isFile()) {
        out.push(full)
      } else {
        fail(`unsupported filesystem entry in release set: ${full}`)
      }
    }
  }
  visit(root)
  return out.sort()
}

function isPrimary(file) {
  return PRIMARY_SUFFIXES.some((suffix) => file.endsWith(suffix))
}

function isMetadata(file) {
  return METADATA_SUFFIXES.some((suffix) => file.endsWith(suffix))
}

function isPayload(file) {
  return isPrimary(file) || isMetadata(file)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function normalizeRel(root, file) {
  const rel = relative(root, file)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..') {
    fail(`path escapes root: ${file}`)
  }
  return rel.split(sep).join('/')
}

export function verifyReleaseSet({
  artifactsRoot = 'dist-artifacts',
  signedRoot = 'dist-signed',
} = {}) {
  const artifactsAbs = resolve(artifactsRoot)
  const signedAbs = resolve(signedRoot)
  const artifactFiles = walk(artifactsAbs)
  const signedFiles = walk(signedAbs)

  const primary = artifactFiles.filter(isPrimary)
  const metadata = artifactFiles.filter(isMetadata)
  const payload = [...primary, ...metadata].sort()
  const sidecars = artifactFiles.filter((file) => file.endsWith('.sha256'))
  const publishable = [...payload, ...sidecars].sort()

  if (primary.length === 0) fail('no primary release artifacts found')
  for (const required of ['.AppImage', '.exe', '.dmg']) {
    if (!primary.some((file) => file.endsWith(required))) {
      fail(`missing required platform artifact: *${required}`)
    }
  }

  if (metadata.length !== 1) {
    fail(`expected exactly one official-runtime CycloneDX SBOM; found ${metadata.length}`)
  }
  let sbom
  try {
    sbom = JSON.parse(readFileSync(metadata[0], 'utf8'))
  } catch {
    fail(`invalid JSON in official-runtime SBOM: ${normalizeRel(artifactsAbs, metadata[0])}`)
  }
  if (sbom?.bomFormat !== 'CycloneDX' || typeof sbom?.specVersion !== 'string') {
    fail('official-runtime SBOM is not a CycloneDX document')
  }
  if (sbom?.metadata?.component?.name !== 'dsh-community-official-runtime-lock') {
    fail('official-runtime SBOM root component is not the reviewed runtime-lock manifest')
  }
  if (!Array.isArray(sbom?.components) || !sbom.components.some(
    (component) => component?.name === '@deepseek-ai/dsh',
  )) {
    fail('official-runtime SBOM does not include @deepseek-ai/dsh')
  }

  const unexpected = artifactFiles.filter(
    (file) => !isPayload(file) && !file.endsWith('.sha256'),
  )
  if (unexpected.length > 0) {
    fail(`unexpected downloaded artifact file: ${normalizeRel(artifactsAbs, unexpected[0])}`)
  }

  const payloadSet = new Set(payload)

  for (const sidecar of sidecars) {
    const asset = sidecar.slice(0, -'.sha256'.length)
    if (!payloadSet.has(asset)) {
      fail(`orphan sha256 sidecar: ${normalizeRel(artifactsAbs, sidecar)}`)
    }
  }

  for (const asset of payload) {
    const sidecar = `${asset}.sha256`
    if (!existsSync(sidecar)) {
      fail(`missing sha256 sidecar for ${normalizeRel(artifactsAbs, asset)}`)
    }

    const raw = readFileSync(sidecar, 'utf8')
    const match = raw.match(/^([0-9a-fA-F]{64}) {2}([^\r\n]+)\r?\n?$/u)
    if (!match) {
      fail(`invalid sha256 sidecar format: ${normalizeRel(artifactsAbs, sidecar)}`)
    }

    const expectedDigest = match[1].toLowerCase()
    const expectedName = match[2]
    if (expectedName !== basename(asset)) {
      fail(
        `sha256 sidecar filename mismatch for ${normalizeRel(artifactsAbs, asset)}: ${expectedName}`,
      )
    }

    const actualDigest = sha256(asset)
    if (actualDigest !== expectedDigest) {
      fail(`sha256 mismatch for ${normalizeRel(artifactsAbs, asset)}`)
    }
  }

  const publishableRel = new Set(publishable.map((file) => normalizeRel(artifactsAbs, file)))

  for (const asset of publishable) {
    const rel = normalizeRel(artifactsAbs, asset)
    const bundle = join(signedAbs, `${rel}.sigstore.json`)
    if (!existsSync(bundle) || readFileSync(bundle).length === 0) {
      fail(`missing or empty sigstore bundle for ${rel}`)
    }
  }

  const bundleFiles = signedFiles.filter((file) => file.endsWith('.sigstore.json'))
  const unexpectedSigned = signedFiles.filter((file) => !file.endsWith('.sigstore.json'))
  if (unexpectedSigned.length > 0) {
    fail(`unexpected signed artifact file: ${normalizeRel(signedAbs, unexpectedSigned[0])}`)
  }

  for (const bundle of bundleFiles) {
    const relBundle = normalizeRel(signedAbs, bundle)
    const relAsset = relBundle.slice(0, -'.sigstore.json'.length)
    if (!publishableRel.has(relAsset)) {
      fail(`orphan sigstore bundle: ${relBundle}`)
    }
  }

  if (bundleFiles.length !== publishable.length) {
    fail(
      `sigstore bundle count mismatch: assets=${publishable.length} bundles=${bundleFiles.length}`,
    )
  }

  return {
    primaryCount: primary.length,
    metadataCount: metadata.length,
    sidecarCount: sidecars.length,
    bundleCount: bundleFiles.length,
    publishable: [...publishableRel].sort(),
  }
}

function main() {
  const [artifactsRoot = 'dist-artifacts', signedRoot = 'dist-signed'] = process.argv.slice(2)
  const result = verifyReleaseSet({ artifactsRoot, signedRoot })
  process.stdout.write(
    `release-set verified: primary=${result.primaryCount} metadata=${result.metadataCount} sidecars=${result.sidecarCount} bundles=${result.bundleCount}\n`,
  )
  for (const rel of result.publishable) process.stdout.write(`verified: ${rel}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`release-set verification failed: ${message}\n`)
    process.exitCode = 1
  }
}
