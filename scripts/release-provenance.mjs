#!/usr/bin/env node
/**
 * Fail-closed Git provenance gate for local candidate tagging and tagged CI.
 * No GitHub token, write access, or changes to Git refs are required here.
 *
 *   node scripts/release-provenance.mjs candidate <tag> <remote>
 *   node scripts/release-provenance.mjs tagged <tag> <remote> <GITHUB_SHA>
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const SHA_RE = /^[a-f0-9]{40}$/u

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error('git ' + args[0] + ' failed (exit ' + String(result.status) + ')')
  }
  return result.stdout.trim()
}

function parseRefRows(text) {
  if (!text) return []
  return text.split('\n').map((line) => {
    const match = /^([a-f0-9]{40})\t([^\s]+)$/u.exec(line)
    if (!match) throw new Error('unexpected git ls-remote response')
    return { sha: match[1], ref: match[2] }
  })
}

function getRemoteMain(remote, cwd) {
  const output = git(['ls-remote', '--refs', remote, 'refs/heads/main'], cwd)
  const rows = parseRefRows(output).filter((row) => row.ref === 'refs/heads/main')
  if (rows.length !== 1) throw new Error('remote main ref must exist exactly once')
  return rows[0].sha
}

function remoteTag(remote, tag, cwd) {
  const ref = 'refs/tags/' + tag
  const output = git(['ls-remote', '--tags', remote, ref, ref + '^{}'], cwd)
  const refs = parseRefRows(output)
  if (refs.some((row) => row.ref !== ref && row.ref !== ref + '^{}')) {
    throw new Error('unexpected tag reference from remote')
  }
  const direct = refs.filter((row) => row.ref === ref)
  const peeled = refs.filter((row) => row.ref === ref + '^{}')
  if (direct.length > 1 || peeled.length > 1) throw new Error('ambiguous remote tag reference')
  if (peeled.length && !direct.length) throw new Error('peeled tag without its ref')
  return { present: direct.length === 1, commit: peeled[0]?.sha ?? direct[0]?.sha }
}

export function verifyReleaseProvenance({ mode, tag, remote = 'origin', cwd = process.cwd(), expectedCommit }) {
  if (mode !== 'candidate' && mode !== 'tagged') throw new Error('unknown verification mode')
  if (!TAG_RE.test(tag ?? '')) throw new Error('invalid release tag')
  if (typeof remote !== 'string' || remote.trim() === '') throw new Error('missing Git remote')
  const head = git(['rev-parse', '--verify', 'HEAD'], cwd).toLowerCase()
  if (!SHA_RE.test(head)) throw new Error('local HEAD is not an exact commit SHA')
  const main = getRemoteMain(remote, cwd)
  if (main !== head) {
    throw new Error('reviewed remote main ' + main + ' differs from candidate HEAD ' + head)
  }

  const tagState = remoteTag(remote, tag, cwd)
  if (mode === 'candidate') {
    const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)
    if (branch !== 'main') throw new Error('release candidate must be on local main')
    const local = spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/tags/' + tag], { cwd, encoding: 'utf8' })
    if (local.error || (local.status !== 0 && local.status !== 1)) {
      throw new Error('cannot determine whether a local release tag already exists')
    }
    if (local.status === 0 || tagState.present) throw new Error('release tag already exists; never reuse it')
  } else {
    if (!SHA_RE.test(expectedCommit ?? '')) throw new Error('tagged verification requires full GITHUB_SHA')
    if (expectedCommit.toLowerCase() !== head) throw new Error('tagged workflow checkout SHA does not match GITHUB_SHA')
    if (!tagState.present || tagState.commit !== head) {
      throw new Error('release tag no longer points to reviewed main commit')
    }
  }
  return { mode, tag, head, remoteMain: main, remoteTag: tagState.commit ?? null }
}

function main() {
  const [mode, tag, remote, expectedCommit] = process.argv.slice(2)
  try {
    const result = verifyReleaseProvenance({ mode, tag, remote, expectedCommit })
    process.stdout.write('release provenance verified: ' + result.mode + ' ' + result.tag + ' => ' + result.head + '\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write('release provenance rejected: ' + message + '\n')
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
