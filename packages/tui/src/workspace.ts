import { execFile } from 'node:child_process'
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

export function rankAndFilterFiles(
  files: readonly string[],
  query: string,
  limit = 8,
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
  return matched.slice(0, Math.max(1, limit))
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
    || /[\u0000-\u001f\u007f]/u.test(normalized)
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

export async function listLocalWorkspaceFiles(
  cwd: string,
  options?: { readonly query?: string; readonly limit?: number; readonly bypassCache?: boolean },
): Promise<string[]> {
  const realRoot = resolveSafeRootDir(cwd)
  if (!realRoot) return []

  const now = Date.now()
  const cached = !options?.bypassCache ? fileIndexCache.get(realRoot) : undefined
  let allFiles: readonly string[]
  if (cached && cached.expiresAt > now) {
    allFiles = cached.files
  } else {
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
    allFiles = files
    if (fileIndexCache.size >= MAX_CACHED_ROOTS) {
      const oldest = fileIndexCache.keys().next().value
      if (oldest !== undefined) fileIndexCache.delete(oldest)
    }
    fileIndexCache.set(realRoot, { expiresAt: now + FILE_LIST_CACHE_TTL_MS, files: allFiles })
  }

  const ranked = rankAndFilterFiles(allFiles, options?.query ?? '', options?.limit ?? 8)
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
    let diffOut = stripUnsafeTerminalControls(await runGit(repoRoot, diffArgs)).trimEnd()

    if (!staged && safePath && diffOut === '') {
      try {
        const untrackedOut = await runGit(repoRoot, [
          'ls-files',
          '--others',
          '--exclude-standard',
          '--',
          safePath,
        ])
        if (untrackedOut.trim() !== '' && existsSync(join(repoRoot, safePath))) {
          try {
            await runGit(repoRoot, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', safePath])
          } catch (diffErr: unknown) {
            const stdout = (diffErr as { stdout?: unknown })?.stdout
            if (typeof stdout === 'string' && stdout.trim() !== '') {
              diffOut = stripUnsafeTerminalControls(stdout).trimEnd()
            }
          }
        }
      } catch {}
    }

    let truncated = false
    if (Buffer.byteLength(diffOut, 'utf8') > maxBytes) {
      const sliced = Buffer.from(diffOut, 'utf8').subarray(0, maxBytes)
      // Step back at continuation bytes so multi-byte UTF-8 doesn't split
      let end = sliced.byteLength
      while (end > 0 && (sliced[end - 1]! & 0b1100_0000) === 0b1000_0000) {
        end -= 1
      }
      diffOut = `${sliced.subarray(0, end).toString('utf8')}\n…（diff 已按 ${maxBytes} 字节截断）`
      truncated = true
    }

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
