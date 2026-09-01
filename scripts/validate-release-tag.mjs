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

const OFFICIAL_DEPENDENCY_MANIFESTS = [
  'apps/desktop/package.json',
  'apps/tui/package.json',
  'packages/dsh-bridge/package.json',
  'tests/upstream-contract/package.json',
]

const OFFICIAL_PACKAGE = '@deepseek-ai/dsh'
const COMMUNITY_SUFFIX = /-community\.(?:0|[1-9]\d*)$/u
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

function readJson(root, rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'))
}

function fail(message) {
  throw new Error(message)
}

function sourceConstant(root, rel, name) {
  const text = readFileSync(join(root, rel), 'utf8')
  const match = text.match(new RegExp('\\b' + name + '\\s*=\\s*[\\'"]([^\\'"]+)[\\'"]', 'u'))
  if (!match?.[1]) fail('cannot read ' + name + ' from ' + rel)
  return match[1]
}

function assertReleaseTag(tag, label) {
  if (typeof tag !== 'string' || !RELEASE_TAG.test(tag)) {
    fail(label + ' has invalid release tag syntax: ' + String(tag))
  }
}

function expectedPublishedAssets(version) {
  return {
    linuxAppImage: 'dsh-community-' + version + '.AppImage',
    macosDmg: 'dsh-community-' + version + '.dmg',
    windowsSetup: 'DSH.Community.Setup.' + version + '.exe',
  }
}

function assertPublishedAssets(facts, publishedVersion) {
  const assets = facts.assets
  const publishedAssets = facts.publishedAssets ?? assets
  if (assets === undefined || publishedAssets === undefined) {
    fail('current-release has no published asset identity')
  }

  for (const key of ['linuxAppImage', 'macosDmg', 'windowsSetup']) {
    if (publishedAssets[key] !== assets[key]) {
      fail('current-release publishedAssets.' + key + ' disagrees with assets.' + key)
    }
  }

  const expected = expectedPublishedAssets(publishedVersion)
  for (const [key, value] of Object.entries(expected)) {
    if (assets[key] !== value) {
      fail(
        'current-release published asset ' + key + '=' + String(assets[key])
          + ', expected ' + value + ' for Published Latest',
      )
    }
  }
}

export function validateReleaseTag(tag, root = process.cwd()) {
  assertReleaseTag(tag, 'requested release tag')

  const rootManifest = readJson(root, 'package.json')
  const productVersion = rootManifest.version
  if (typeof productVersion !== 'string' || productVersion.length === 0) {
    fail('root package.json has no product version')
  }

  const expectedCandidateTag = 'v' + productVersion
  if (tag !== expectedCandidateTag) {
    fail('release tag ' + tag + ' does not match workspace candidate ' + expectedCandidateTag)
  }

  for (const rel of WORKSPACE_MANIFESTS) {
    const version = readJson(root, rel).version
    if (version !== productVersion) {
      fail(rel + ' version ' + String(version) + ' does not match ' + productVersion)
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
      'COMMUNITY_PRODUCT_VERSION ' + communityConstant
        + ' does not match package version ' + productVersion,
    )
  }

  const baseVersion = productVersion.replace(COMMUNITY_SUFFIX, '')
  if (baseVersion !== officialPin) {
    fail(
      'community product ' + productVersion + ' does not mirror official pin ' + officialPin,
    )
  }

  for (const rel of OFFICIAL_DEPENDENCY_MANIFESTS) {
    const manifest = readJson(root, rel)
    const dependency = manifest.dependencies?.[OFFICIAL_PACKAGE]
    if (dependency !== officialPin) {
      fail(
        rel + ' depends on ' + OFFICIAL_PACKAGE + '@' + String(dependency)
          + ', expected exact ' + officialPin,
      )
    }
  }

  const facts = readJson(root, 'docs/current-release.json')
  if (facts.officialKernel?.package !== OFFICIAL_PACKAGE) {
    fail('current-release official package is not ' + OFFICIAL_PACKAGE)
  }
  if (facts.officialKernel?.version !== officialPin) {
    fail(
      'current-release candidate core ' + String(facts.officialKernel?.version)
        + ' does not match ' + officialPin,
    )
  }
  if (facts.communityProduct?.version !== productVersion) {
    fail(
      'current-release candidate product ' + String(facts.communityProduct?.version)
        + ' does not match ' + productVersion,
    )
  }

  if (facts.candidateTag !== expectedCandidateTag) {
    fail(
      'current-release candidateTag ' + String(facts.candidateTag)
        + ' does not match workspace candidate ' + expectedCandidateTag,
    )
  }

  const publishedLatestTag = facts.communityProduct?.githubLatestTag
  assertReleaseTag(publishedLatestTag, 'current-release GitHub Latest')
  const publishedVersion = publishedLatestTag.slice(1)
  assertPublishedAssets(facts, publishedVersion)

  const expectedBadge =
    'DeepSeek Harness Community v' + productVersion
      + ' [Official Core: ' + OFFICIAL_PACKAGE + '@' + officialPin + ']'
  if (facts.dualBadge !== expectedBadge) {
    fail('current-release Dual-Badge does not match candidate product/core identity')
  }

  if (
    Array.isArray(facts.historicalIndependentTags)
    && facts.historicalIndependentTags.includes(tag)
  ) {
    fail('current candidate tag is incorrectly listed as historical: ' + tag)
  }
  if (
    Array.isArray(facts.historicalIndependentTags)
    && facts.historicalIndependentTags.includes(publishedLatestTag)
  ) {
    fail('Published Latest is incorrectly listed as historical: ' + publishedLatestTag)
  }

  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const marker = '## ' + productVersion
  if (!changelog.split(/\r?\n/u).some((line) => line.trim() === marker)) {
    fail('CHANGELOG.md has no exact section for candidate ' + productVersion)
  }

  return {
    tag,
    productVersion,
    officialPackage: OFFICIAL_PACKAGE,
    officialPin,
    publishedLatestTag,
    publishedVersion,
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
      'release identity verified: candidate ' + result.tag
        + ' -> ' + result.officialPackage + '@' + result.officialPin
        + '; Published Latest=' + result.publishedLatestTag
        + '; workspace manifests=' + result.workspaceManifestCount + '\n',
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write('release identity verification failed: ' + message + '\n')
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
