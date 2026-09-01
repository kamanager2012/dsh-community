#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_REPOSITORY = 'kamanager2012/dsh-community'
const DEFAULT_LATEST_API = 'https://api.github.com/repos/' + DEFAULT_REPOSITORY + '/releases/latest'
const LATEST_ELIGIBLE_TAG = /^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/u
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u
const PUBLISHED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u

function fail(message) {
  throw new Error(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function expectedPrimaryNames(tag) {
  if (!LATEST_ELIGIBLE_TAG.test(tag)) {
    fail('GitHub Latest tag is not Latest-eligible under repository policy: ' + String(tag))
  }
  const version = tag.slice(1)
  return {
    linuxAppImage: 'dsh-community-' + version + '.AppImage',
    macosDmg: 'dsh-community-' + version + '.dmg',
    windowsSetup: 'DSH.Community.Setup.' + version + '.exe',
  }
}

function immutableCandidateSnapshot(facts) {
  return JSON.stringify({
    officialKernel: facts.officialKernel,
    communityVersion: facts.communityProduct?.version,
    candidateTag: facts.candidateTag,
    dualBadge: facts.dualBadge,
    evidence: facts.evidence,
  })
}

export function syncPublishedLatestFacts(facts, release) {
  if (!release || typeof release !== 'object') {
    fail('GitHub Latest response is not an object')
  }
  if (release.draft === true || release.prerelease === true) {
    fail('GitHub Latest must be a published non-prerelease release')
  }
  if (typeof release.tag_name !== 'string') {
    fail('GitHub Latest tag_name is missing')
  }
  const names = expectedPrimaryNames(release.tag_name)
  const expectedUrl =
    'https://github.com/' + DEFAULT_REPOSITORY + '/releases/tag/' + release.tag_name
  if (release.html_url !== expectedUrl) {
    fail('GitHub Latest URL does not match repository/tag identity')
  }
  if (!Number.isInteger(release.id) || release.id <= 0) {
    fail('GitHub Latest release id is invalid')
  }
  if (typeof release.published_at !== 'string' || !PUBLISHED_AT_RE.test(release.published_at)) {
    fail('GitHub Latest published_at is invalid')
  }

  const assets = new Map()
  for (const asset of Array.isArray(release.assets) ? release.assets : []) {
    if (assets.has(asset.name)) {
      fail('GitHub Latest contains duplicate asset name ' + String(asset.name))
    }
    assets.set(asset.name, asset)
  }

  const primaryAssets = {}
  for (const [key, name] of Object.entries(names)) {
    const asset = assets.get(name)
    if (!asset) {
      fail('GitHub Latest is missing required primary asset ' + name)
    }
    if (!Number.isInteger(asset.id) || asset.id <= 0) {
      fail('GitHub Latest asset id is invalid for ' + name)
    }
    if (typeof asset.digest !== 'string' || !DIGEST_RE.test(asset.digest)) {
      fail('GitHub Latest asset digest is invalid for ' + name)
    }
    primaryAssets[key] = {
      name,
      assetId: asset.id,
      digest: asset.digest,
    }
  }

  const beforeCandidate = immutableCandidateSnapshot(facts)
  const next = structuredClone(facts)
  next.schemaVersion = Math.max(2, Number(next.schemaVersion) || 0)
  next.asOf = release.published_at.slice(0, 10)
  next.communityProduct = {
    ...next.communityProduct,
    githubLatestTag: release.tag_name,
  }

  const note = next.publishedAssets?.note
    ?? next.assets?.note
    ?? 'Use the exact names on the GitHub Release page.'
  next.assets = { ...names, note }
  next.publishedAssets = { ...names, note }
  next.publishedReleaseEvidence = {
    releaseId: release.id,
    tag: release.tag_name,
    url: release.html_url,
    publishedAt: release.published_at,
    primaryAssets,
  }

  if (immutableCandidateSnapshot(next) !== beforeCandidate) {
    fail('Published Latest sync attempted to mutate Candidate/plugin/User-Loop state')
  }
  return next
}

async function fetchLatestRelease() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-community-published-latest-sync',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN
  }
  const response = await fetch(DEFAULT_LATEST_API, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    fail('GitHub Latest query failed with HTTP ' + response.status)
  }
  return response.json()
}

function parseArgs(args) {
  let fixturePath
  let write = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--write') {
      write = true
      continue
    }
    if (arg === '--fixture') {
      if (fixturePath !== undefined || i + 1 >= args.length) {
        fail('invalid --fixture usage')
      }
      fixturePath = args[i + 1]
      i += 1
      continue
    }
    fail('unknown argument: ' + arg)
  }
  return { fixturePath, write }
}

async function main() {
  try {
    const { fixturePath, write } = parseArgs(process.argv.slice(2))
    const factsPath = join(process.cwd(), 'docs/current-release.json')
    const facts = readJson(factsPath)
    const release = fixturePath
      ? readJson(resolve(process.cwd(), fixturePath))
      : await fetchLatestRelease()
    const next = syncPublishedLatestFacts(facts, release)
    const before = JSON.stringify(facts, null, 2) + '\n'
    const after = JSON.stringify(next, null, 2) + '\n'

    if (before === after) {
      process.stdout.write(
        'Published Latest sync: no changes (' + next.communityProduct.githubLatestTag + ')\n',
      )
      return
    }

    if (!write) {
      process.stdout.write(
        'Published Latest sync required: '
          + String(facts.communityProduct?.githubLatestTag)
          + ' -> ' + next.communityProduct.githubLatestTag
          + '; re-run with --write after review\n',
      )
      process.exitCode = 3
      return
    }

    writeFileSync(factsPath, after)
    process.stdout.write(
      'Published Latest synced: ' + next.communityProduct.githubLatestTag
        + ' releaseId=' + next.publishedReleaseEvidence.releaseId + '\n',
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write('Published Latest sync failed: ' + message + '\n')
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
