import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleKey, type KeyHandlerDeps } from '../src/keys.js'
import { createStore } from '../src/store.js'
import {
  extractTrailingAtQuery,
  inspectLocalGitDiff,
  listLocalWorkspaceFiles,
  parseDiffCommandArgs,
  sliceUtf8BufferSafely,
} from '../src/workspace.js'

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'tui@example.com'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'TUI Test'], { cwd: dir, stdio: 'pipe' })
}

describe('TUI local /diff, @file completion, and safe workspace helpers', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  it('extracts trailing @file queries cleanly and ignores email-like mid-word @', () => {
    expect(extractTrailingAtQuery('')).toBeUndefined()
    expect(extractTrailingAtQuery('user@example.com')).toBeUndefined()
    expect(extractTrailingAtQuery('review @src/ui ')).toBeUndefined()
    expect(extractTrailingAtQuery('@')).toEqual({ query: '', atIndex: 0 })
    expect(extractTrailingAtQuery('read @src/main')).toEqual({ query: 'src/main', atIndex: 5 })
  })

  it('validates /diff arguments safely and inspects local git diff without ANSI injection', async () => {
    expect(parseDiffCommandArgs('')).toEqual({ staged: false })
    expect(parseDiffCommandArgs('--staged src/a.ts')).toEqual({ staged: true, path: 'src/a.ts' })
    expect(parseDiffCommandArgs('src/a.ts --cached')).toEqual({ staged: true, path: 'src/a.ts' })
    expect('error' in parseDiffCommandArgs('../secret')).toBe(true)
    expect('error' in parseDiffCommandArgs('/etc/passwd')).toBe(true)
    expect('error' in parseDiffCommandArgs('--unknown')).toBe(true)

    const base = mkdtempSync(join(tmpdir(), 'dsh-tui-diff-'))
    tempDirs.push(base)
    const repo = join(base, 'repo')
    const outside = join(base, 'outside')
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(outside, { recursive: true })

    initRepo(repo)
    writeFileSync(join(repo, '.gitignore'), 'ignored.log\n', 'utf8')
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const v = 1\n', 'utf8')
    writeFileSync(join(outside, 'secret.txt'), 'secret\n', 'utf8')
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'leak.txt'))
    execFileSync('git', ['add', '.gitignore', 'src/app.ts'], { cwd: repo, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'pipe' })

    // Unstaged change containing ANSI escape should be sanitized in diff output
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const v = "\x1b[2J2"\n', 'utf8')
    writeFileSync(join(repo, 'ignored.log'), 'ignore me\n', 'utf8')

    const unstaged = await inspectLocalGitDiff(repo, { path: 'src/app.ts' })
    expect(unstaged.ok).toBe(true)
    if (unstaged.ok) {
      expect(unstaged.output).toContain('Git Diff（unstaged · src/app.ts）')
      expect(unstaged.output).not.toContain('\x1b[2J')
    }

    execFileSync('git', ['add', 'src/app.ts'], { cwd: repo, stdio: 'pipe' })
    const staged = await inspectLocalGitDiff(repo, { staged: true })
    expect(staged.ok).toBe(true)
    if (staged.ok) {
      expect(staged.output).toContain('Git Diff（staged）')
      expect(staged.output).toContain('+export const v =')
    }

    const denied = await inspectLocalGitDiff(repo, { path: 'leak.txt' })
    expect(denied.ok).toBe(false)

    const listed = await listLocalWorkspaceFiles(repo, { query: 'app', bypassCache: true })
    expect(listed).toContain('src/app.ts')
    expect(listed).not.toContain('ignored.log')
    expect(listed).not.toContain('leak.txt')
  })

  it('handles @file arrow selection, Tab insertion, Esc dismissal, /diff dispatch, and async race safety', async () => {
    const store = createStore()
    let thinkingToggles = 0
    let cancels = 0
    const sent: string[] = []
    const diffs: string[] = []

    const deps: KeyHandlerDeps = {
      store,
      onSend: (t) => sent.push(t),
      onCancel: () => {
        cancels += 1
      },
      onExit: () => {},
      showHelp: () => {},
      toggleThinking: () => {
        thinkingToggles += 1
      },
      inspectDiff: (arg) => {
        diffs.push(arg)
      },
      completeAtFiles: (query) => {
        const corpus = ['apps/remote-web/src/client/timeline.ts', 'packages/tui/src/markdown.ts']
        return corpus.filter((f) => f.toLowerCase().includes(query.toLowerCase()))
      },
    }

    // Tab outside @file continues to toggle thinking
    handleKey(deps, '', { } as never)
    handleKey(deps, '\t', {})
    expect(thinkingToggles).toBe(1)

    // Typing @time populates matches; Esc dismisses without cancelling
    handleKey(deps, 'see @tim', {})
    expect(store.state.atCompletion?.matches).toEqual(['apps/remote-web/src/client/timeline.ts'])
    handleKey(deps, '', { escape: true })
    expect(store.state.atCompletion).toBeUndefined()
    expect(cancels).toBe(0)

    // Second Esc with menu closed triggers normal cancel
    handleKey(deps, '', { escape: true })
    expect(cancels).toBe(1)

    // Typing @ selects candidate via arrows and completes on Tab without toggling thinking
    handleKey(deps, ' @.', {}) // empty or reset cleanly: clear draft then type
    store.setDraft('')
    handleKey(deps, 'inspect @s', {})
    expect(store.state.atCompletion?.matches).toHaveLength(2)
    handleKey(deps, '', { downArrow: true })
    expect(store.state.atCompletion?.selectedIndex).toBe(1)
    handleKey(deps, '\t', {})
    expect(store.state.draft).toBe('inspect @packages/tui/src/markdown.ts ')
    expect(store.state.atCompletion).toBeUndefined()
    expect(thinkingToggles).toBe(1)

    // /diff command dispatches inspectDiff instead of onSend
    store.setDraft('')
    handleKey(deps, '/diff src/a.ts --staged', {})
    handleKey(deps, '', { return: true })
    expect(diffs).toEqual(['src/a.ts --staged'])
    expect(sent).toEqual([])

    // Async race guard: stale async lookup resolving after draft change is ignored
    let resolveSlow!: (v: string[]) => void
    const asyncDeps: KeyHandlerDeps = {
      ...deps,
      completeAtFiles: () =>
        new Promise<string[]>((resolve) => {
          resolveSlow = resolve
        }),
    }
    handleKey(asyncDeps, '@old', {})
    store.setDraft('different prompt')
    resolveSlow(['stale/file.ts'])
    await Promise.resolve()
    expect(store.state.atCompletion).toBeUndefined()

    // Stale query guard: typing another character before async lookup finishes clears prior query matches
    // so Tab cannot accept the older query's completion result
    const pendingResolvers = new Map<string, (v: string[]) => void>()
    const seqDeps: KeyHandlerDeps = {
      ...deps,
      completeAtFiles: (query) =>
        new Promise<string[]>((resolve) => {
          pendingResolvers.set(query, resolve)
        }),
    }
    store.setDraft('')
    handleKey(seqDeps, '@a', {})
    pendingResolvers.get('a')?.(['apple.ts'])
    await Promise.resolve()
    expect(store.state.atCompletion?.query).toBe('a')
    expect(store.state.atCompletion?.matches).toEqual(['apple.ts'])

    handleKey(seqDeps, 'b', {})
    expect(store.state.draft).toBe('@ab')
    expect(store.state.atCompletion).toBeUndefined()
    // Pressing Tab while @ab is still resolving triggers/awaits @ab rather than inserting @apple.ts
    handleKey(seqDeps, '\t', {})
    expect(store.state.draft).toBe('@ab')
    pendingResolvers.get('ab')?.(['abstract.ts'])
    await Promise.resolve()
    expect(store.state.draft).toBe('@abstract.ts ')
    expect(store.state.atCompletion).toBeUndefined()
  })

  it('translates Ink key.tab events into tab behavior for thinking toggle and @file completion', () => {
    const store = createStore()
    let thinkingToggles = 0
    const deps: KeyHandlerDeps = {
      store,
      onSend: () => {},
      onCancel: () => {},
      onExit: () => {},
      showHelp: () => {},
      toggleThinking: () => {
        thinkingToggles += 1
      },
      inspectDiff: () => {},
      completeAtFiles: (query) => ['src/index.ts'].filter((f) => f.includes(query)),
    }

    handleKey(deps, '', { tab: true })
    expect(thinkingToggles).toBe(1)

    handleKey(deps, 'read @ind', {})
    expect(store.state.atCompletion?.matches).toEqual(['src/index.ts'])

    handleKey(deps, '', { tab: true })
    expect(store.state.draft).toBe('read @src/index.ts ')
    expect(store.state.atCompletion).toBeUndefined()
    expect(thinkingToggles).toBe(1)
  })

  it('slices UTF-8 buffers without U+FFFD, rejects C1 control paths, and bounds huge git diffs', async () => {
    const buf = Buffer.from('ab🚀cd', 'utf8')
    for (let maxBytes = 0; maxBytes <= buf.length; maxBytes++) {
      expect(sliceUtf8BufferSafely(buf, maxBytes).text).not.toContain('\uFFFD')
    }
    expect(sliceUtf8BufferSafely(buf, 5)).toEqual({ text: 'ab', truncated: true })
    expect(sliceUtf8BufferSafely(buf, 6)).toEqual({ text: 'ab🚀', truncated: true })
    expect(sliceUtf8BufferSafely(buf, buf.length)).toEqual({ text: 'ab🚀cd', truncated: false })

    const base = mkdtempSync(join(tmpdir(), 'dsh-tui-bound-diff-'))
    tempDirs.push(base)
    initRepo(base)
    writeFileSync(join(base, 'big.txt'), 'init\n', 'utf8')
    execFileSync('git', ['add', 'big.txt'], { cwd: base, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: base, stdio: 'pipe' })

    const c1Denied = await inspectLocalGitDiff(base, { path: 'src/\u0085evil.ts' })
    expect(c1Denied.ok).toBe(false)

    writeFileSync(join(base, 'big.txt'), '🚀diff-line\n'.repeat(3000), 'utf8')
    const bounded = await inspectLocalGitDiff(base, { path: 'big.txt', maxBytes: 1025 })
    expect(bounded.ok).toBe(true)
    if (bounded.ok) {
      expect(bounded.output).not.toContain('\uFFFD')
      expect(Buffer.byteLength(bounded.output, 'utf8')).toBeLessThan(8192)
    }
  })

  it('coalesces @file completion lookups per input chunk and skips lookups cancelled by submit/space', async () => {
    const store = createStore()
    const queries: string[] = []
    const sent: string[] = []
    const deps: KeyHandlerDeps = {
      store,
      onSend: (text) => sent.push(text),
      onCancel: () => {},
      onExit: () => {},
      showHelp: () => {},
      toggleThinking: () => {},
      completeAtFiles: (q) => {
        queries.push(q)
        return [`${q}-match.ts`]
      },
    }

    // Pasting a 64-char @mention followed immediately by Enter must trigger 0 lookups.
    handleKey(deps, `@${'a'.repeat(64)}\r`)
    expect(sent).toEqual([`@${'a'.repeat(64)}`])
    expect(queries).toEqual([])

    // Pasting a multi-character @token triggers at most one coalesced lookup for the final query.
    handleKey(deps, 'inspect @src/ind')
    expect(queries).toEqual(['src/ind'])
    expect(store.state.atCompletion?.matches).toEqual(['src/ind-match.ts'])
  })

  it('applies @file completion limit after filtering deleted tracked files and deduplicates concurrent index loads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-deleted-rank-'))
    tempDirs.push(dir)
    initRepo(dir)

    for (let i = 0; i < 8; i++) {
      writeFileSync(join(dir, `a${i}.ts`), `export const a${i} = ${i}\n`, 'utf8')
    }
    writeFileSync(join(dir, 'z-valid.ts'), 'export const z = 1\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: dir, stdio: 'pipe' })

    // Simulate deleted tracked files remaining in `git ls-files --cached` ahead of z-valid.ts.
    for (let i = 0; i < 8; i++) {
      rmSync(join(dir, `a${i}.ts`))
    }

    const [first, second] = await Promise.all([
      listLocalWorkspaceFiles(dir, { query: '' }),
      listLocalWorkspaceFiles(dir, { query: '' }),
    ])
    expect(first).toEqual(['z-valid.ts'])
    expect(second).toEqual(['z-valid.ts'])
  })

  it('invalidates pending @file and Tab completion lookups when Escape is pressed before resolution', async () => {
    const store = createStore()
    let resolveLookup: ((matches: string[]) => void) | undefined
    let cancels = 0
    const deps: KeyHandlerDeps = {
      store,
      onSend: () => {},
      onCancel: () => {
        cancels += 1
      },
      onExit: () => {},
      showHelp: () => {},
      toggleThinking: () => {},
      completeAtFiles: () =>
        new Promise<string[]>((resolve) => {
          resolveLookup = resolve
        }),
    }

    // Escape pressed while async Tab lookup is pending (atCompletion still undefined)
    handleKey(deps, '@foo')
    handleKey(deps, '\t')
    handleKey(deps, '', { escape: true })
    expect(cancels).toBe(1)

    resolveLookup?.(['foo.ts'])
    await Promise.resolve()
    await Promise.resolve()

    expect(store.state.draft).toBe('@foo')
    expect(store.state.atCompletion).toBeUndefined()
  })
})
