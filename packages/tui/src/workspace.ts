import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { stripUnsafeTerminalControls } from './markdown.js'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 5000
const FILE_LIST_CACHE_TTL_MS = 3000
const MAX_CACHED_ROOTS = 8
const MAX_FALLBACK_WALK_DEPTH = 8
const MAX_FALLBACK_WALK_ENTRIES = 10_000
const DEFAULT_TUI_DIFF_MAX_BYTES = 16 * 1024
const FALLBACK_SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.turbo', 'dist'])

const fileIndexCache = new Map<string, { readonly expiresAt: number; readonly files: readonly string[] }>()
const fileIndexInFlight = new Map<string, Promise<readonly string[]>>()

export interface AtFileQueryMatch {
  readonly query: string
  readonly atIndex: number
}

/**
 * Detects an active `@file` mention token at the trailing edge of `draft`
 * (when `@` appears at index 0 or immediately after whitespace, with no trailing whitespace).
 */
export function extractTrailingAtQuery(draft: string): AtFileQueryMatch | undefined {
  let i = draft.length
  while (i > 0) {
    const ch = draft[i - 1]!
    if (/\s/u.test(ch)) return undefined
    if (ch === '@') {
      const atIndex = i - 1
      if (atIndex === 0 || /\s/u.test(draft[atIndex - 1]!)) {
        return { query: draft.slice(i), atIndex }
      }
      return undefined
    }
    i -= 1
  }
  return undefined
}

function rankMatch(relPath: string, queryLower: string): number {
  const pathLower = relPath.toLowerCase()
  const base = basename(pathLower)
  if (base === queryLower) return 0
  if (base.startsWith(queryLower)) return 1
  if (base.includes(queryLower)) return 2
  if (pathLower.startsWith(queryLower)) return 3
  if (pathLower.includes(queryLower)) return 4
  return 5
}

function rankMatchingFiles(
  files: readonly string[],
  query: string,
): string[] {
  const q = query.trim().toLowerCase()
  const matched =
    q === ''
      ? [...files]
      : files.filter((f) => {
          const lower = f.toLowerCase()
          return lower.includes(q)
        })

  if (q !== '') {
    matched.sort((a, b) => {
      const diff = rankMatch(a, q) - rankMatch(b, q)
      if (diff !== 0) return diff
      if (a.length !== b.length) return a.length - b.length
      return a.localeCompare(b, 'en')
    })
  } else {
    matched.sort((a, b) => a.localeCompare(b, 'en'))
  }
  return matched
}

export function rankAndFilterFiles(
  files: readonly string[],
  query: string,
  limit = 8,
): string[] {
  return rankMatchingFiles(files, query).slice(0, Math.max(1, limit))
}

function resolveSafeRootDir(cwd: string): string | undefined {
  const trimmed = cwd.trim()
  if (!trimmed || !isAbsolute(trimmed)) return undefined
  const abs = resolve(trimmed)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return undefined
  try {
    return realpathSync(abs)
  } catch {
    return undefined
  }
}

function assertSafeRelativePath(rootReal: string, rawPath: string): string | undefined {
  const normalized = rawPath.replace(/\\/gu, '/').trim()
  if (
    normalized.length === 0
    || normalized.length > 512
    || normalized.startsWith('-')
    || normalized.startsWith('/')
    || normalized.startsWith('~')
    || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
    || normalized.split('/').some((seg) => seg === '..' || seg === '.' || seg === '.git' || seg === '')
  ) {
    return undefined
  }
  const candidate = resolve(rootReal, normalized)
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
  if (!candidate.startsWith(prefix)) return undefined

  let probe = candidate
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe || parent.length < rootReal.length) break
    probe = parent
  }
  try {
    const realProbe = realpathSync(probe)
    if (realProbe !== rootReal && !realProbe.startsWith(prefix)) return undefined
  } catch {
    return undefined
  }
  return normalized
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
  })
  return stdout
}

export function sliceUtf8BufferSafely(buf: Buffer, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  if (buf.byteLength <= maxBytes) {
    return { text: buf.toString('utf8'), truncated: false }
  }
  if (maxBytes <= 0) {
    return { text: '', truncated: true }
  }
  let end = maxBytes
  // Scan back past continuation bytes (10xxxxxx) to inspect the trailing character's lead byte.
  let probe = end - 1
  while (probe > 0 && end - probe <= 4 && (buf[probe]! & 0b1100_0000) === 0b1000_0000) {
    probe -= 1
  }
  const lead = buf[probe]!
  if ((lead & 0b1100_0000) === 0b1100_0000) {
    const seqLen =
      (lead & 0b1110_0000) === 0b1100_0000
        ? 2
        : (lead & 0b1111_0000) === 0b1110_0000
          ? 3
          : (lead & 0b1111_1000) === 0b1111_0000
            ? 4
            : 1
    if (probe + seqLen > maxBytes) {
      end = probe
    }
  }
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true }
}

async function runGitDiffBounded(
  cwd: string,
  args: readonly string[],
  maxBytes: number,
  allowExitCode1 = false,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let collected = 0
    let errText = ''
    let streamTruncated = false
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      rejectPromise(new Error('git diff timed out'))
    }, GIT_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      if (collected >= maxBytes + 4) {
        if (!streamTruncated) {
          streamTruncated = true
          child.kill('SIGKILL')
        }
        return
      }
      const need = maxBytes + 4 - collected
      const slice = chunk.byteLength > need ? chunk.subarray(0, need) : chunk
      chunks.push(slice)
      collected += slice.byteLength
      if (collected >= maxBytes + 4) {
        streamTruncated = true
        child.kill('SIGKILL')
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (errText.length < 1024) {
        errText += chunk.toString('utf8')
      }
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(err)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!streamTruncated && code !== 0 && !(allowExitCode1 && code === 1)) {
        rejectPromise(new Error(errText.trim() || `git diff exited with code ${String(code)}`))
        return
      }
      const rawBuf = Buffer.concat(chunks)
      // Sanitize whole lines before byte slicing? Keep safe ASCII/UTF-8 slicing after stripUnsafeTerminalControls!
      const cleanText = stripUnsafeTerminalControls(sliceUtf8BufferSafely(rawBuf, maxBytes).text)
      const sliced = sliceUtf8BufferSafely(Buffer.from(cleanText, 'utf8'), maxBytes)
      resolvePromise({
        text: sliced.text.trimEnd(),
        truncated: streamTruncated || rawBuf.byteLength > maxBytes || sliced.truncated,
      })
    })
  })
}

function walkFilesNonGit(rootReal: string): string[] {
  const out: string[] = []
  let visited = 0
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootReal, depth: 0 }]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.depth > MAX_FALLBACK_WALK_DEPTH) continue
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_FALLBACK_WALK_ENTRIES) return out
      if (entry.isSymbolicLink() || FALLBACK_SKIP_DIRS.has(entry.name)) continue
      const abs = join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (current.depth + 1 <= MAX_FALLBACK_WALK_DEPTH) {
          stack.push({ dir: abs, depth: current.depth + 1 })
        }
        continue
      }
      if (!entry.isFile()) continue
      const rel = relative(rootReal, abs).replace(/\\/gu, '/')
      if (rel && !rel.startsWith('..') && !rel.split('/').includes('.git')) {
        out.push(rel)
      }
    }
  }
  return out
}

async function loadWorkspaceFileIndex(
  realRoot: string,
  bypassCache: boolean,
): Promise<readonly string[]> {
  if (!bypassCache) {
    const cached = fileIndexCache.get(realRoot)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.files
    }
    const existing = fileIndexInFlight.get(realRoot)
    if (existing) {
      return existing
    }
  }

  const loadPromise = (async (): Promise<readonly string[]> => {
    let files: string[] = []
    let usedGit = false
    try {
      await runGit(realRoot, ['rev-parse', '--show-toplevel'])
      const stdout = await runGit(realRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      usedGit = true
      const seen = new Set<string>()
      for (const raw of stdout.split('\0')) {
        if (!raw) continue
        const norm = raw.replace(/\\/gu, '/')
        if (
          norm.startsWith('/')
          || norm.startsWith('..')
          || norm.split('/').some((seg) => seg === '..' || seg === '.' || seg === '.git' || seg === '')
        ) {
          continue
        }
        if (!seen.has(norm)) {
          seen.add(norm)
          files.push(norm)
        }
      }
    } catch {
      usedGit = false
    }
    if (!usedGit) {
      files = walkFilesNonGit(realRoot)
    }
    if (fileIndexCache.size >= MAX_CACHED_ROOTS) {
      const oldest = fileIndexCache.keys().next().value
      if (oldest !== undefined) fileIndexCache.delete(oldest)
    }
    fileIndexCache.set(realRoot, { expiresAt: Date.now() + FILE_LIST_CACHE_TTL_MS, files })
    return files
  })()

  if (!bypassCache) {
    fileIndexInFlight.set(realRoot, loadPromise)
  }
  try {
    return await loadPromise
  } finally {
    if (!bypassCache && fileIndexInFlight.get(realRoot) === loadPromise) {
      fileIndexInFlight.delete(realRoot)
    }
  }
}

export async function listLocalWorkspaceFiles(
  cwd: string,
  options?: { readonly query?: string; readonly limit?: number; readonly bypassCache?: boolean },
): Promise<string[]> {
  const realRoot = resolveSafeRootDir(cwd)
  if (!realRoot) return []

  const allFiles = await loadWorkspaceFileIndex(realRoot, options?.bypassCache === true)
  const limit = Math.max(1, options?.limit ?? 8)
  const ranked = rankMatchingFiles(allFiles, options?.query ?? '')
  const verified: string[] = []
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
  for (const rel of ranked) {
    if (!assertSafeRelativePath(realRoot, rel)) continue
    try {
      const abs = join(realRoot, rel)
      if (lstatSync(abs).isSymbolicLink()) {
        const canonical = realpathSync(abs)
        if (canonical !== realRoot && !canonical.startsWith(prefix)) continue
      }
    } catch {
      continue
    }
    verified.push(rel)
    if (verified.length >= limit) break
  }
  return verified
}

export function parseDiffCommandArgs(
  argText: string,
): { readonly staged: boolean; readonly path?: string } | { readonly error: string } {
  const tokens = argText.trim().split(/\s+/u).filter(Boolean)
  let staged = false
  let path: string | undefined

  for (const tok of tokens) {
    if (tok === '--staged' || tok === '--cached') {
      staged = true
      continue
    }
    if (tok.startsWith('-')) {
      return { error: `不支持的 /diff 参数：${tok}（可用 /diff [path] [--staged]）` }
    }
    if (path !== undefined) {
      return { error: '最多只能指定一个相对文件路径（例如 /diff src/index.ts --staged）' }
    }
    if (
      tok.startsWith('/')
      || tok.startsWith('~')
      || /[\u0000-\u001f\u007f]/u.test(tok)
      || tok.split(/[\\/]+/u).some((seg) => seg === '..' || seg === '')
    ) {
      return { error: `不安全的路径参数：${tok}` }
    }
    path = tok
  }
  return { staged, ...(path !== undefined ? { path } : {}) }
}

export async function inspectLocalGitDiff(
  cwd: string,
  options?: { readonly path?: string; readonly staged?: boolean; readonly maxBytes?: number },
): Promise<{ readonly ok: true; readonly output: string } | { readonly ok: false; readonly error: string }> {
  const realCwd = resolveSafeRootDir(cwd)
  if (!realCwd) {
    return { ok: false, error: '当前工作目录不可用' }
  }

  let repoRoot: string
  try {
    repoRoot = realpathSync((await runGit(realCwd, ['rev-parse', '--show-toplevel'])).trim())
  } catch {
    return { ok: false, error: '当前目录不在 Git 仓库中' }
  }

  let safePath: string | undefined
  if (options?.path !== undefined) {
    const baseRelative =
      realCwd === repoRoot
        ? options.path
        : join(relative(repoRoot, realCwd), options.path).replace(/\\/gu, '/')
    safePath = assertSafeRelativePath(repoRoot, baseRelative)
    if (!safePath) {
      return { ok: false, error: `路径超出仓库安全边界：${options.path}` }
    }
  }

  const staged = options?.staged === true
  const maxBytes = Math.min(Math.max(512, options?.maxBytes ?? DEFAULT_TUI_DIFF_MAX_BYTES), 64 * 1024)

  try {
    const statusOut = stripUnsafeTerminalControls(
      await runGit(repoRoot, ['status', '--short', '--branch', ...(safePath ? ['--', safePath] : [])]),
    ).trim()
    const diffArgs = [
      'diff',
      ...(staged ? ['--staged'] : []),
      '--no-color',
      '--no-ext-diff',
      ...(safePath ? ['--', safePath] : []),
    ]
    let diffRes = await runGitDiffBounded(repoRoot, diffArgs, maxBytes)

    if (!staged && safePath && diffRes.text === '') {
      try {
        const untrackedOut = await runGit(repoRoot, [
          'ls-files',
          '--others',
          '--exclude-standard',
          '--',
          safePath,
        ])
        if (untrackedOut.trim() !== '' && existsSync(join(repoRoot, safePath))) {
          diffRes = await runGitDiffBounded(
            repoRoot,
            ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', safePath],
            maxBytes,
            true,
          )
        }
      } catch {}
    }

    const truncated = diffRes.truncated
    const diffOut = truncated
      ? `${diffRes.text}\n…（diff 已按 ${maxBytes} 字节截断）`
      : diffRes.text

    const header = `Git Diff（${staged ? 'staged' : 'unstaged'}${safePath ? ` · ${safePath}` : ''}${truncated ? ' · truncated' : ''}）`
    const body = diffOut || '(无 diff 内容)'
    return {
      ok: true,
      output: [header, statusOut || '(clean)', '---', body].join('\n'),
    }
  } catch (err) {
    return {
      ok: false,
      error: `Git diff 查询失败：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
