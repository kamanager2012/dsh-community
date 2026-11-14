import { execFile, spawn } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { RemoteProtocolError } from '../errors.js'
import type {
  GitChangedFileSummary,
  SessionRef,
  SessionWorkspaceSummary,
  WorkspaceGitDiffParams,
  WorkspaceGitDiffResult,
  WorkspaceGitStatusResult,
} from '../protocol.js'
import { sanitizeSubprocessEnv } from './types.js'

const execFileAsync = promisify(execFile)

const DEFAULT_MAX_DIFF_BYTES = 64 * 1024
const HARD_MAX_DIFF_BYTES = 256 * 1024
const MAX_STATUS_FILES = 500
const GIT_TIMEOUT_MS = 8000
const WORKSPACE_SUMMARY_TIMEOUT_MS = 1500
const WORKSPACE_SUMMARY_TTL_MS = 4000
const MAX_WORKSPACE_SUMMARY_CACHE = 128

async function runGit(
  cwd: string,
  args: readonly string[],
  maxBuffer = 2 * 1024 * 1024,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', ['-C', cwd, ...args], {
    env: sanitizeSubprocessEnv(),
    timeout: timeoutMs,
    maxBuffer,
    windowsHide: true,
    encoding: 'utf8',
  })
}

async function runGitBoundedDiff(
  cwd: string,
  args: readonly string[],
  maxBytes: number,
  options?: { allowExitOne?: boolean },
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const effectiveMaxBytes = Math.max(1, maxBytes)
  const captureCap = effectiveMaxBytes + 4
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      env: sanitizeSubprocessEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let collectedBytes = 0
    let stderrBytes = 0
    let streamTruncated = false
    let timedOut = false
    let settled = false
    let killEscalationTimer: NodeJS.Timeout | undefined

    const finishError = (err: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killEscalationTimer) clearTimeout(killEscalationTimer)
      rejectPromise(err)
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {}
    }, GIT_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled || streamTruncated) return
      const remaining = captureCap - collectedBytes
      if (remaining > 0) {
        const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
        stdoutChunks.push(slice)
        collectedBytes += slice.byteLength
      }
      if (collectedBytes >= captureCap || chunk.byteLength > remaining) {
        streamTruncated = true
        try {
          child.stdout?.destroy()
        } catch {}
        try {
          child.kill('SIGTERM')
        } catch {}
        killEscalationTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {}
        }, 250)
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 16 * 1024) return
      stderrChunks.push(chunk)
      stderrBytes += chunk.byteLength
    })

    child.once('error', (err) => {
      finishError(err)
    })

    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killEscalationTimer) clearTimeout(killEscalationTimer)

      if (timedOut) {
        rejectPromise(new RemoteProtocolError('INVALID_REQUEST', 'git diff timed out'))
        return
      }

      const allowExitOne = options?.allowExitOne === true
      const okCode = code === 0 || (allowExitOne && code === 1)
      if (!streamTruncated && !okCode) {
        const errMsg = Buffer.concat(stderrChunks).toString('utf8').trim() || `git diff exited with code ${code}`
        rejectPromise(new RemoteProtocolError('INVALID_REQUEST', errMsg))
        return
      }

      const rawBuf = Buffer.concat(stdoutChunks)
      const truncated = streamTruncated || rawBuf.byteLength > effectiveMaxBytes
      if (!truncated) {
        const text = rawBuf.toString('utf8')
        resolvePromise({ text, bytes: rawBuf.byteLength, truncated: false })
        return
      }

      let end = Math.min(effectiveMaxBytes, rawBuf.byteLength)
      while (end > 0 && (rawBuf[end]! & 0b1100_0000) === 0b1000_0000) {
        end -= 1
      }
      const sliced = rawBuf.subarray(0, end)
      resolvePromise({
        text: sliced.toString('utf8'),
        bytes: sliced.byteLength,
        truncated: true,
      })
    })
  })
}

export async function resolveGitRepoRoot(
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string> {
  const trimmed = cwd.trim()
  if (!trimmed || !isAbsolute(trimmed)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'session workspace path is unavailable')
  }
  const resolved = resolve(trimmed)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'session workspace directory does not exist')
  }
  let realCwd: string
  try {
    realCwd = realpathSync(resolved)
  } catch {
    throw new RemoteProtocolError('INVALID_REQUEST', 'failed to resolve session workspace directory')
  }
  try {
    const { stdout } = await runGit(realCwd, ['rev-parse', '--show-toplevel'], 2 * 1024 * 1024, timeoutMs)
    const rootRaw = stdout.trim()
    if (!rootRaw) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'session workspace is not inside a git repository')
    }
    return realpathSync(rootRaw)
  } catch (err) {
    if (err instanceof RemoteProtocolError) throw err
    throw new RemoteProtocolError('INVALID_REQUEST', 'session workspace is not inside a git repository')
  }
}

function assertSafeRepoRelativePath(repoRoot: string, rawPath: string): string {
  const normalized = rawPath.replace(/\\/gu, '/').trim()
  if (
    normalized.length === 0
    || normalized.length > 512
    || normalized.startsWith('-')
    || normalized.startsWith('/')
    || normalized.startsWith('~')
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || normalized.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
  ) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'invalid repository-relative file path')
  }
  const candidate = resolve(repoRoot, normalized)
  const rootPrefix = repoRoot.endsWith(sep) ? repoRoot : `${repoRoot}${sep}`
  if (!candidate.startsWith(rootPrefix)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'path escapes repository root')
  }
  // Verify existing path or parent directory canonical path to prevent symlink escape.
  let probePath = candidate
  while (!existsSync(probePath)) {
    const parent = dirname(probePath)
    if (parent === probePath) break
    probePath = parent
  }
  const canonicalProbe = realpathSync(probePath)
  if (canonicalProbe !== repoRoot && !canonicalProbe.startsWith(rootPrefix)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'canonical path escapes repository root')
  }
  return normalized
}

function parseBranchLine(header: string): {
  branch: string
  upstream?: string | undefined
  ahead: number
  behind: number
} {
  const stripped = header.startsWith('## ') ? header.slice(3).trim() : header.trim()
  if (stripped.startsWith('HEAD')) {
    return { branch: 'HEAD', ahead: 0, behind: 0 }
  }
  const noCommitsMatch = /^No commits yet on (.+)$/u.exec(stripped)
  if (noCommitsMatch?.[1]) {
    return { branch: noCommitsMatch[1].trim(), ahead: 0, behind: 0 }
  }

  let branchPart = stripped
  let ahead = 0
  let behind = 0
  const bracketMatch = /\s\[(.+)\]$/u.exec(stripped)
  if (bracketMatch) {
    branchPart = stripped.slice(0, bracketMatch.index)
    const aheadMatch = /ahead (\d+)/u.exec(bracketMatch[1] ?? '')
    const behindMatch = /behind (\d+)/u.exec(bracketMatch[1] ?? '')
    if (aheadMatch?.[1]) ahead = Number(aheadMatch[1])
    if (behindMatch?.[1]) behind = Number(behindMatch[1])
  }

  const dotsIdx = branchPart.indexOf('...')
  if (dotsIdx !== -1) {
    const branch = branchPart.slice(0, dotsIdx).trim()
    const upstream = branchPart.slice(dotsIdx + 3).trim()
    return {
      branch: branch || 'HEAD',
      ...(upstream ? { upstream } : {}),
      ahead,
      behind,
    }
  }
  return { branch: branchPart.trim() || 'HEAD', ahead, behind }
}

async function resolveGitWorktreeIdentity(
  repoRoot: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<{
  readonly commonRepoRoot: string
  readonly isWorktree: boolean
  readonly worktreeName: string
}> {
  const worktreeName = basename(repoRoot) || repoRoot
  try {
    const { stdout } = await runGit(repoRoot, ['rev-parse', '--git-common-dir'], 256 * 1024, timeoutMs)
    const rawCommon = stdout.trim()
    if (!rawCommon) {
      return { commonRepoRoot: repoRoot, isWorktree: false, worktreeName }
    }
    const resolvedGitCommon = resolve(repoRoot, rawCommon)
    let canonicalGitCommon = resolvedGitCommon
    try {
      canonicalGitCommon = realpathSync(resolvedGitCommon)
    } catch {}
    const commonRepoRoot =
      basename(canonicalGitCommon) === '.git' ? dirname(canonicalGitCommon) : canonicalGitCommon
    return {
      commonRepoRoot,
      isWorktree: commonRepoRoot !== repoRoot,
      worktreeName,
    }
  } catch {
    return { commonRepoRoot: repoRoot, isWorktree: false, worktreeName }
  }
}

function parsePorcelainStatusZ(
  stdout: string,
  maxFiles: number,
): {
  readonly branch: string
  readonly upstream?: string | undefined
  readonly ahead: number
  readonly behind: number
  readonly files: GitChangedFileSummary[]
  readonly totalEntries: number
  readonly truncated: boolean
} {
  const tokens = stdout.split('\0')
  let branch = 'HEAD'
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  let startIdx = 0

  const first = tokens[0] ?? ''
  if (first.startsWith('## ')) {
    const parsedBranch = parseBranchLine(first)
    branch = parsedBranch.branch
    upstream = parsedBranch.upstream
    ahead = parsedBranch.ahead
    behind = parsedBranch.behind
    startIdx = 1
  }

  const files: GitChangedFileSummary[] = []
  let totalEntries = 0
  let truncated = false
  for (let i = startIdx; i < tokens.length; i += 1) {
    const entry = tokens[i]
    if (!entry || entry.length < 4) continue
    totalEntries += 1
    const indexStatus = entry[0] ?? ' '
    const worktreeStatus = entry[1] ?? ' '
    let origPath: string | undefined
    if ((indexStatus === 'R' || indexStatus === 'C') && i + 1 < tokens.length) {
      origPath = tokens[i + 1] || undefined
      i += 1
    }
    if (files.length >= maxFiles) {
      truncated = true
      continue
    }
    const path = entry.slice(3)
    const untracked = indexStatus === '?' && worktreeStatus === '?'
    files.push({
      path,
      ...(origPath !== undefined ? { origPath } : {}),
      indexStatus,
      worktreeStatus,
      staged: !untracked && indexStatus !== ' ',
      unstaged: !untracked && worktreeStatus !== ' ',
      untracked,
    })
  }

  return { branch, upstream, ahead, behind, files, totalEntries, truncated }
}

const workspaceSummaryCache = new Map<
  string,
  { readonly expiresAt: number; readonly value: SessionWorkspaceSummary | undefined }
>()
const workspaceSummaryInFlight = new Map<string, Promise<SessionWorkspaceSummary | undefined>>()

/**
 * Inspects compact Git repo/worktree metadata for a session workspace directory.
 * Returns `undefined` for missing/non-git directories and caches results briefly
 * so `session.list` stays responsive across dozens of sessions.
 */
export async function inspectSessionWorkspaceSummary(
  cwd: string,
  options?: { readonly forceRefresh?: boolean | undefined },
): Promise<SessionWorkspaceSummary | undefined> {
  const trimmed = cwd.trim()
  if (!trimmed || !isAbsolute(trimmed)) return undefined
  const resolved = resolve(trimmed)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return undefined

  let cacheKey = resolved
  try {
    cacheKey = realpathSync(resolved)
  } catch {
    return undefined
  }

  const now = Date.now()
  if (options?.forceRefresh !== true) {
    const cached = workspaceSummaryCache.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      workspaceSummaryCache.delete(cacheKey)
      workspaceSummaryCache.set(cacheKey, cached)
      return cached.value
    }
  }

  const inflight = workspaceSummaryInFlight.get(cacheKey)
  if (inflight) return inflight

  const probe = (async (): Promise<SessionWorkspaceSummary | undefined> => {
    try {
      const repoRoot = await resolveGitRepoRoot(cacheKey, WORKSPACE_SUMMARY_TIMEOUT_MS)
      const [identity, statusOut] = await Promise.all([
        resolveGitWorktreeIdentity(repoRoot, WORKSPACE_SUMMARY_TIMEOUT_MS),
        runGit(
          repoRoot,
          ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=normal'],
          512 * 1024,
          WORKSPACE_SUMMARY_TIMEOUT_MS,
        ),
      ])
      const parsed = parsePorcelainStatusZ(statusOut.stdout, MAX_STATUS_FILES)
      const summary: SessionWorkspaceSummary = {
        repoRoot,
        commonRepoRoot: identity.commonRepoRoot,
        worktreeName: identity.worktreeName,
        ...(identity.isWorktree ? { isWorktree: true } : {}),
        branch: parsed.branch,
        dirty: parsed.totalEntries > 0,
        ...(parsed.totalEntries > 0 ? { changedFiles: parsed.totalEntries } : {}),
        ...(parsed.ahead > 0 ? { ahead: parsed.ahead } : {}),
        ...(parsed.behind > 0 ? { behind: parsed.behind } : {}),
      }
      if (workspaceSummaryCache.size >= MAX_WORKSPACE_SUMMARY_CACHE) {
        const oldestKey = workspaceSummaryCache.keys().next().value
        if (oldestKey !== undefined) workspaceSummaryCache.delete(oldestKey)
      }
      workspaceSummaryCache.set(cacheKey, {
        expiresAt: Date.now() + WORKSPACE_SUMMARY_TTL_MS,
        value: summary,
      })
      return summary
    } catch {
      if (workspaceSummaryCache.size >= MAX_WORKSPACE_SUMMARY_CACHE) {
        const oldestKey = workspaceSummaryCache.keys().next().value
        if (oldestKey !== undefined) workspaceSummaryCache.delete(oldestKey)
      }
      workspaceSummaryCache.set(cacheKey, {
        expiresAt: Date.now() + WORKSPACE_SUMMARY_TTL_MS,
        value: undefined,
      })
      return undefined
    } finally {
      workspaceSummaryInFlight.delete(cacheKey)
    }
  })()

  workspaceSummaryInFlight.set(cacheKey, probe)
  return probe
}

/**
 * Attaches cached Git branch/worktree summaries onto `SessionRef`s with valid `cwd`s.
 * Deduplicates by directory and caps unique directory probes so `session.list` remains bounded.
 */
export async function enrichSessionsWithWorkspaceSummaries(
  sessions: readonly SessionRef[],
  options?: { readonly maxProbeDirs?: number | undefined; readonly forceRefresh?: boolean | undefined },
): Promise<readonly SessionRef[]> {
  if (sessions.length === 0) return sessions
  const maxProbeDirs = options?.maxProbeDirs ?? 16
  const uniqueCwds: string[] = []
  const seenCwds = new Set<string>()
  const prioritized = [...sessions].sort((a, b) => {
    const aRunning = a.status === 'running' ? 1 : 0
    const bRunning = b.status === 'running' ? 1 : 0
    if (aRunning !== bRunning) return bRunning - aRunning
    return (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0)
  })
  for (const s of prioritized) {
    const cwd = s.cwd?.trim()
    if (!cwd || seenCwds.has(cwd)) continue
    seenCwds.add(cwd)
    uniqueCwds.push(cwd)
    if (uniqueCwds.length >= maxProbeDirs) break
  }
  if (uniqueCwds.length === 0) return sessions

  const resolvedByCwd = new Map<string, SessionWorkspaceSummary | undefined>()
  await Promise.allSettled(
    uniqueCwds.map(async (cwd) => {
      const summary = await inspectSessionWorkspaceSummary(cwd, {
        ...(options?.forceRefresh !== undefined ? { forceRefresh: options.forceRefresh } : {}),
      })
      resolvedByCwd.set(cwd, summary)
    }),
  )

  let anyAdded = false
  const out = sessions.map((s) => {
    const cwd = s.cwd?.trim()
    const summary = cwd ? resolvedByCwd.get(cwd) : undefined
    if (summary === undefined) return s
    anyAdded = true
    return {
      ...s,
      workspace: summary,
    }
  })
  return anyAdded ? out : sessions
}

export async function inspectWorkspaceGitStatus(
  sessionId: string,
  cwd: string,
): Promise<WorkspaceGitStatusResult> {
  const repoRoot = await resolveGitRepoRoot(cwd)
  const [identity, { stdout }] = await Promise.all([
    resolveGitWorktreeIdentity(repoRoot),
    runGit(repoRoot, [
      'status',
      '--porcelain=v1',
      '-z',
      '-b',
      '--untracked-files=all',
    ]),
  ])

  const parsed = parsePorcelainStatusZ(stdout, MAX_STATUS_FILES)

  return {
    sessionId,
    repoRoot,
    commonRepoRoot: identity.commonRepoRoot,
    ...(identity.isWorktree ? { isWorktree: true } : {}),
    worktreeName: identity.worktreeName,
    branch: parsed.branch,
    ...(parsed.upstream !== undefined ? { upstream: parsed.upstream } : {}),
    ahead: parsed.ahead,
    behind: parsed.behind,
    clean: parsed.files.length === 0,
    files: parsed.files,
    truncated: parsed.truncated,
  }
}

async function resolveCurrentBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await runGit(repoRoot, ['symbolic-ref', '--short', 'HEAD'])
    const branch = stdout.trim()
    if (branch) return branch
  } catch {}
  try {
    const { stdout } = await runGit(repoRoot, ['rev-parse', '--short', 'HEAD'])
    const rev = stdout.trim()
    if (rev) return rev
  } catch {}
  return 'HEAD'
}

export async function inspectWorkspaceGitDiff(
  params: WorkspaceGitDiffParams,
  cwd: string,
): Promise<WorkspaceGitDiffResult> {
  const repoRoot = await resolveGitRepoRoot(cwd)
  const branch = await resolveCurrentBranch(repoRoot)
  const staged = params.staged === true
  const maxBytes = Math.min(
    HARD_MAX_DIFF_BYTES,
    Math.max(1024, params.maxBytes ?? DEFAULT_MAX_DIFF_BYTES),
  )

  const safePath =
    params.path !== undefined ? assertSafeRepoRelativePath(repoRoot, params.path) : undefined

  const gitArgs = ['diff', '--no-ext-diff']
  if (staged) gitArgs.push('--cached')
  if (safePath !== undefined) {
    gitArgs.push('--', safePath)
  }

  let bounded = await runGitBoundedDiff(repoRoot, gitArgs, maxBytes)

  // If requesting an unstaged single-file diff for a new untracked regular file, synthesize unified diff safely.
  if (bounded.bytes === 0 && !staged && safePath !== undefined) {
    const targetAbs = join(repoRoot, safePath)
    if (existsSync(targetAbs) && statSync(targetAbs).isFile()) {
      try {
        const untrackedCheck = await runGit(repoRoot, [
          'ls-files',
          '--others',
          '--exclude-standard',
          '--',
          safePath,
        ])
        if (untrackedCheck.stdout.trim() === safePath) {
          bounded = await runGitBoundedDiff(
            repoRoot,
            ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', safePath],
            maxBytes,
            { allowExitOne: true },
          )
        }
      } catch {}
    }
  } else if (!staged && safePath === undefined && !bounded.truncated) {
    // Include bounded untracked file previews in unfiltered unstaged diffs so "all files" matches status.
    try {
      const untrackedList = await runGit(repoRoot, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ])
      const untrackedPaths = untrackedList.stdout.split('\0').filter((p) => p.length > 0)
      if (untrackedPaths.length > 0) {
        const parts: string[] = bounded.text ? [bounded.text] : []
        let usedBytes = bounded.bytes
        let combinedTruncated = false

        for (const rawRel of untrackedPaths) {
          let verifiedPath: string
          try {
            verifiedPath = assertSafeRepoRelativePath(repoRoot, rawRel)
          } catch {
            continue
          }
          const absTarget = join(repoRoot, verifiedPath)
          if (!existsSync(absTarget) || !statSync(absTarget).isFile()) continue

          const sepBytes = parts.length > 0 ? 1 : 0
          const remainingBudget = maxBytes - usedBytes - sepBytes
          if (remainingBudget <= 0) {
            combinedTruncated = true
            break
          }

          const preview = await runGitBoundedDiff(
            repoRoot,
            ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', verifiedPath],
            remainingBudget,
            { allowExitOne: true },
          )
          if (preview.bytes === 0) continue

          parts.push(preview.text)
          usedBytes += sepBytes + preview.bytes
          if (preview.truncated || usedBytes >= maxBytes) {
            combinedTruncated = true
            if (usedBytes >= maxBytes) break
          }
        }

        if (parts.length > (bounded.text ? 1 : 0) || combinedTruncated) {
          const text = parts.join('\n')
          bounded = {
            text,
            bytes: Buffer.byteLength(text, 'utf8'),
            truncated: combinedTruncated,
          }
        }
      }
    } catch {}
  }

  return {
    sessionId: params.sessionId,
    repoRoot,
    branch,
    staged,
    ...(safePath !== undefined ? { path: safePath } : {}),
    diff: bounded.text,
    bytes: bounded.bytes,
    truncated: bounded.truncated,
  }
}
