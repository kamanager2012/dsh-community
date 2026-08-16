import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Product rule, machine-enforced:
 *   第三方 harness 产品只可参考思路/方法,严禁直接挂载、依赖或复制。
 *
 * The distribution may depend ONLY on:
 *   - official @deepseek-ai/* packages
 *   - our own workspace packages (@dsh-community/*)
 *   - generic UI/utility libraries (ink, chalk, react, electron…)
 *
 * Any third-party dsh.bundle / harness-family package in manifests or in
 * profile/patch rows fails CI. Reading third-party source for reference is
 * allowed; shipping it is not.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Third-party packages that are harness products or harness surface implementations. */
const FORBIDDEN_PACKAGE_PATTERNS = [
  /@deepseek-harness-tui\//u,
  /^dsh-tui$/u,
  /@dsh-community\/dsh-tui/u,
]

/** Only manifests and composition rows count; tests/docs may discuss them. */
const SCAN_EXTENSION = /\.(json|yml|yaml)$/u

function walk(dir: string, into: string[]): void {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name === 'dist' || name.name === 'release' || name.name === 'runtime-stage' || name.name === 'runtime-host' || name.name === '.pack-root') continue
    const full = join(dir, name.name)
    if (name.isDirectory()) walk(full, into)
    else if (name.isFile() && SCAN_EXTENSION.test(name.name)) into.push(full)
  }
}

describe('third-party harness products are reference-only, never shipped', () => {
  it('no manifest or composition row mounts a third-party TUI/harness package', () => {
    const files: string[] = []
    walk(join(root, 'apps'), files)
    walk(join(root, 'packages'), files)
    walk(join(root, 'contracts'), files)
    const hits: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of FORBIDDEN_PACKAGE_PATTERNS) {
        if (pattern.test(text)) hits.push(`${file}: ${String(pattern)}`)
      }
    }
    expect(hits).toEqual([])
  })
})
