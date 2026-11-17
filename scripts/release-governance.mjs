#!/usr/bin/env node
/**
 * Tag protection gate for the interval BEFORE GitHub publishes an immutable
 * release. Repository immutability begins at publication; during the Draft
 * upload, active tag rulesets must prevent updates and deletions of BOTH the
 * user-facing release tag and the independent create-only attempt marker.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const REPO = /^kamanager2012\/dsh-community$/u

// GitHub ruleset patterns support fnmatch constructs beyond our narrow
// matcher. An unknown exclusion MUST fail closed; treating it as false would
// incorrectly claim that a release tag is protected when GitHub excludes it.
function assertSupportedTagPatterns(rs) {
  const names = rs.conditions?.ref_name
  if (!names || !Array.isArray(names.include) || !Array.isArray(names.exclude)) {
    throw new Error('missing or malformed tag ruleset include/exclude conditions')
  }
  for (const pattern of [...names.include, ...names.exclude]) {
    if (pattern === '~ALL') continue
    if (typeof pattern !== 'string' || !/^refs\/tags\/[A-Za-z0-9.\-_/*?]+$/u.test(pattern)) {
      throw new Error('unsupported GitHub tag ruleset pattern: ' + String(pattern))
    }
  }
}

function patternMatches(pattern, ref) {
  if (pattern === '~ALL') return true
  // Call only after assertSupportedTagPatterns has validated both include AND
  // exclude lists of all active tag rulesets, not merely matching includes.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]')
  return new RegExp('^' + escaped + '$', 'u').test(ref)
}

function applies(rule, ref) {
  const names = rule.conditions?.ref_name
  if (!names || !Array.isArray(names.include) || names.include.length === 0) return false
  if (!names.include.some((name) => patternMatches(name, ref))) return false
  if (Array.isArray(names.exclude) && names.exclude.some((name) => patternMatches(name, ref))) return false
  return true
}

export function verifyTagProtection(rulesets, tag) {
  if (!TAG.test(tag ?? '')) throw new Error('invalid protected release tag')
  if (!Array.isArray(rulesets)) throw new Error('GitHub tag ruleset data missing')
  // Validate every ACTIVE tag ruleset before calculating coverage. A matching
  // include with an unrecognized exclusion could otherwise bypass protection.
  for (const rs of rulesets) {
    if (rs.target === 'tag' && rs.enforcement === 'active') {
      assertSupportedTagPatterns(rs)
    }
  }
  const refs = ['refs/tags/' + tag, 'refs/tags/release-attempt-' + tag]
  const matchedIds = []
  for (const ref of refs) {
    const match = rulesets.find((rs) => {
      if (rs.target !== 'tag' || rs.enforcement !== 'active' || !applies(rs, ref)) return false
      const types = new Set(Array.isArray(rs.rules) ? rs.rules.map((r) => r.type) : [])
      if (!types.has('update') || !types.has('deletion')) return false
      // A missing bypass-actor field is UNKNOWN, not proof of no bypass.
      // Fail closed until GitHub confirms an explicit empty actor list.
      if (!Array.isArray(rs.bypass_actors) || rs.bypass_actors.length !== 0) return false
      return true
    })
    if (!match) throw new Error('missing active update/deletion protection for ' + ref)
    matchedIds.push(match.id)
  }
  return matchedIds
}

async function githubJson(repo, path, token) {
  const response = await fetch('https://api.github.com/repos/' + repo + '/' + path, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'dsh-release-governance-gate',
    },
  })
  if (!response.ok) throw new Error('GitHub API policy read failed (' + response.status + ')')
  return response.json()
}

export async function verifyReleaseGovernance({ repo, tag, token }) {
  if (!REPO.test(repo ?? '')) throw new Error('unexpected release repository')
  if (!TAG.test(tag ?? '')) throw new Error('invalid release tag')
  if (typeof token !== 'string' || token.length < 10) throw new Error('GitHub token required for policy verification')
  const summaries = await githubJson(repo, 'rulesets?includes_parents=true&per_page=100', token)
  if (!Array.isArray(summaries) || summaries.length >= 100) {
    throw new Error('ruleset list missing or paginated; cannot assert effective policy')
  }
  const ids = summaries.filter((rs) => rs.target === 'tag' && rs.enforcement === 'active')
  const detail = []
  for (const rs of ids) {
    if (!Number.isInteger(rs.id)) throw new Error('invalid tag ruleset id')
    detail.push(await githubJson(repo, 'rulesets/' + rs.id + '?includes_parents=true', token))
  }
  const matched = verifyTagProtection(detail, tag)

  const markerName = 'release-attempt-' + tag
  const markerResponse = await fetch('https://api.github.com/repos/' + repo + '/git/ref/tags/' + markerName, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'dsh-release-governance-gate',
    },
  })
  if (markerResponse.status === 200) throw new Error('release attempt already recorded; cut a new tag')
  if (markerResponse.status !== 404) {
    throw new Error('cannot verify release attempt marker absence (' + markerResponse.status + ')')
  }
  return { tag, protectedRefs: matched, marker: 'refs/tags/' + markerName }
}

async function main() {
  const [tag, repo] = process.argv.slice(2)
  try {
    const result = await verifyReleaseGovernance({
      tag, repo, token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    })
    process.stdout.write('release tag protections and unused attempt marker verified: ' + result.tag + '\n')
  } catch (error) {
    process.stderr.write('release governance rejected: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main()
