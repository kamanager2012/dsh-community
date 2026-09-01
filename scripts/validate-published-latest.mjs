#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_REPOSITORY = 'kamanager2012/dsh-community'
const DEFAULT_LATEST_API = 'https://api.github.com/repos/' + DEFAULT_REPOSITORY + '/releases/latest'
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u

function fail(message) {
  throw new Error(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function expectedPrimaryAssets(facts) {
  const source = facts.publishedAssets ?? facts.assets
  if (!source) fail('current-release has no published asset names')
  return {
    linuxAppImage: source.linuxAppImage,
    macosDmg: source.macosDmg,
    windowsSetup: source.windowsSetup,
  }
}

export function validatePublishedLatestFacts(facts, release) {
  const expectedTag = facts.communityProduct?.githubLatestTag
  if (typeof expectedTag !== 'string' || expectedTag.length === 0) {
    fail('current-release GitHub Latest tag is missing')
  }

  const evidence = facts.publishedReleaseEvidence
  if (!evidence || typeof evidence !== 'object') {
    fail('current-release has no publishedReleaseEvidence')
  }

  if (evidence.tag !== expectedTag) {
    fail('publishedReleaseEvidence tag does not match GitHub Latest')
  }
  if (release.tag_name !== expectedTag) {
    fail('GitHub Latest tag ' + String(release.tag_name) + ' does not match current-release ' + expectedTag)
  }
  if (release.draft === true) {
    fail('GitHub Latest unexpectedly resolves to a draft release')
  }
  if (Number(release.id) !== Number(evidence.releaseId)) {
    fail('GitHub Latest release id does not match publishedReleaseEvidence')
  }
  if (release.html_url !== evidence.url) {
    fail('GitHub Latest URL does not match publishedReleaseEvidence')
  }
  if (release.published_at !== evidence.publishedAt) {
    fail('GitHub Latest published_at does not match publishedReleaseEvidence')
  }

  const actualAssets = new Map(
    Array.isArray(release.assets)
      ? release.assets.map((asset) => [asset.name, asset])
      : [],
  )
  const expectedNames = expectedPrimaryAssets(facts)
  const evidenceAssets = evidence.primaryAssets

  for (const [key, name] of Object.entries(expectedNames)) {
    if (typeof name !== 'string' || name.length === 0) {
      fail('published asset name missing for ' + key)
    }
    const recorded = evidenceAssets?.[key]
    if (!recorded) {
      fail('publishedReleaseEvidence missing primary asset ' + key)
    }
    if (recorded.name !== name) {
      fail('publishedReleaseEvidence asset name drift for ' + key)
    }
    if (!Number.isInteger(recorded.assetId) || recorded.assetId <= 0) {
      fail('publishedReleaseEvidence asset id invalid for ' + key)
    }
    if (typeof recorded.digest !== 'string' || !DIGEST_RE.test(recorded.digest)) {
      fail('publishedReleaseEvidence digest invalid for ' + key)
    }

    const actual = actualAssets.get(name)
    if (!actual) {
      fail('GitHub Latest is missing published asset ' + name)
    }
    if (Number(actual.id) !== recorded.assetId) {
      fail('GitHub asset id drift for ' + name)
    }
    if (actual.digest !== recorded.digest) {
      fail('GitHub asset digest drift for ' + name)
    }
  }

  return {
    tag: expectedTag,
    releaseId: evidence.releaseId,
    publishedAt: evidence.publishedAt,
    primaryAssetCount: Object.keys(expectedNames).length,
  }
}

async function fetchLatestRelease() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-community-published-latest-validator',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN
  }
  const response = await fetch(DEFAULT_LATEST_API, { headers })
  if (!response.ok) {
    fail('GitHub Latest query failed with HTTP ' + response.status)
  }
  return response.json()
}

async function main() {
  const args = process.argv.slice(2)
  let fixturePath
  if (args.length === 2 && args[0] === '--fixture') {
    fixturePath = args[1]
  } else if (args.length !== 0) {
    process.stderr.write('usage: node scripts/validate-published-latest.mjs [--fixture release.json]\n')
    process.exitCode = 2
    return
  }

  try {
    const facts = readJson(join(process.cwd(), 'docs/current-release.json'))
    const release = fixturePath
      ? readJson(resolve(process.cwd(), fixturePath))
      : await fetchLatestRelease()
    const result = validatePublishedLatestFacts(facts, release)
    process.stdout.write(
      'Published Latest verified: ' + result.tag
        + ' releaseId=' + result.releaseId
        + ' primaryAssets=' + result.primaryAssetCount
        + ' publishedAt=' + result.publishedAt + '\n',
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write('Published Latest verification failed: ' + message + '\n')
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
