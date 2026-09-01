#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE_MANIFESTS = [
  'package.json',
  'apps/desktop/package.json',
  'apps/tui/package.json',
  'packages/dsh-bridge/package.json',
  'packages/shared-types/package.json',
  'packages/tui-adapter/package.json',
  'packages/tui/package.json',
  'tests/upstream-contract/package.json',
]

const OFFICIAL_PACKAGE = '@deepseek-ai/dsh'
const COMMUNITY_SUFFIX = /-community\.(?:0|[1-9]\d*)$/u

function readJson(root, rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'))
}

function fail(message) {
  throw new Error(message)
}

function sourceConstant(root, rel, name) {
  const text = readFileSync(join(root, rel), 'utf8')
  const match = text.match(new RegExp(`\\b${name}\\s*=\\s*['"]([^'"]+)['"]`, 'u'))
  if (!match?.[1]) fail(`cannot read ${name} from ${rel}`)
  return match[1]
}

export function validateReleaseTag(tag, root = process.cwd()) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) {
    fail(`invalid release tag syntax: ${tag}`)
  }

  const rootManifest = readJson(root, 'package.json')
  const productVersion = rootManifest.version
  if (typeof productVersion !== 'string' || productVersion.length === 0) {
    fail('root package.json has no product version')
  }

  const expectedTag = `v${productVersion}`
  if (tag !== expectedTag) {
    fail(`release tag ${tag} does not match workspace product version ${expectedTag}`)
  }

  for (const rel of WORKSPACE_MANIFESTS) {
    const version = readJson(root, rel).version
    if (version !== productVersion) {
      fail(`${rel} version ${String(version)} does not match ${productVersion}`)
    }
  }

  const officialPin = sourceConstant(
    root,
    'packages/dsh-bridge/src/pin.ts',
    'PINNED_DSH_VERSION',
  )
  const communityConstant = sourceConstant(
    root,
    'packages/dsh-bridge/src/community-version.ts',
    'COMMUNITY_PRODUCT_VERSION',
  )
  if (communityConstant !== productVersion) {
    fail(
      `COMMUNITY_PRODUCT_VERSION ${communityConstant} does not match package version ${productVersion}`,
    )
  }

  const baseVersion = productVersion.replace(COMMUNITY_SUFFIX, '')
  if (baseVersion !== officialPin) {
    fail(
      `community product ${productVersion} does not mirror official pin ${officialPin}`,
    )
  }

  const officialDependencyManifests = [
    'apps/desktop/package.json',
    'apps/tui/package.json',
    'packages/dsh-bridge/package.json',
    'tests/upstream-contract/package.json',
  ]
  for (const rel of officialDependencyManifests) {
    const manifest = readJson(root, rel)
    const dependency = manifest.dependencies?.[OFFICIAL_PACKAGE]
    if (dependency !== officialPin) {
      fail(
        `${rel} depends on ${OFFICIAL_PACKAGE}@${String(dependency)}, expected ${officialPin}`,
      )
    }
  }

  const facts = readJson(root, 'docs/current-release.json')
  if (facts.officialKernel?.package !== OFFICIAL_PACKAGE) {
    fail(`current-release official package is not ${OFFICIAL_PACKAGE}`)
  }
  if (facts.officialKernel?.version !== officialPin) {
    fail(
      `current-release official version ${String(facts.officialKernel?.version)} does not match ${officialPin}`,
    )
  }
  if (facts.communityProduct?.version !== productVersion) {
    fail(
      `current-release product version ${String(facts.communityProduct?.version)} does not match ${productVersion}`,
    )
  }
  const isCommunityPatch = COMMUNITY_SUFFIX.test(productVersion)
  const expectedLatestTag = isCommunityPatch ? `v${officialPin}` : tag
  if (facts.communityProduct?.githubLatestTag !== expectedLatestTag) {
    fail(
      `current-release GitHub Latest ${String(facts.communityProduct?.githubLatestTag)} does not match expected ${expectedLatestTag}`,
    )
  }

  const expectedBadge =
    `DeepSeek Harness Community v${productVersion} [Official Core: ${OFFICIAL_PACKAGE}@${officialPin}]`
  if (facts.dualBadge !== expectedBadge) {
    fail('current-release Dual-Badge does not match product/core identity')
  }

  const expectedAssets = {
    linuxAppImage: `dsh-community-${productVersion}.AppImage`,
    macosDmg: `dsh-community-${productVersion}.dmg`,
    windowsSetup: `DSH.Community.Setup.${productVersion}.exe`,
  }
  for (const [key, expected] of Object.entries(expectedAssets)) {
    if (facts.assets?.[key] !== expected) {
      fail(
        `current-release asset ${key}=${String(facts.assets?.[key])}, expected ${expected}`,
      )
    }
  }

  if (Array.isArray(facts.historicalIndependentTags)
      && facts.historicalIndependentTags.includes(tag)) {
    fail(`current release tag is incorrectly listed as historical: ${tag}`)
  }

  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const marker = `## ${productVersion}`
  if (!changelog.split(/\r?\n/u).some((line) => line.trim() === marker)) {
    fail(`CHANGELOG.md has no exact section for ${productVersion}`)
  }

  return {
    tag,
    productVersion,
    officialPackage: OFFICIAL_PACKAGE,
    officialPin,
    workspaceManifestCount: WORKSPACE_MANIFESTS.length,
  }
}

function main() {
  const tag = process.argv[2]
  if (!tag) {
    process.stderr.write('usage: node scripts/validate-release-tag.mjs <vX.Y.Z[-prerelease]>\n')
    process.exitCode = 2
    return
  }
  try {
    const result = validateReleaseTag(tag)
    process.stdout.write(
      `release identity verified: ${result.tag} -> ${result.officialPackage}@${result.officialPin}; `
        + `workspace manifests=${result.workspaceManifestCount}\n`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`release identity verification failed: ${message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
