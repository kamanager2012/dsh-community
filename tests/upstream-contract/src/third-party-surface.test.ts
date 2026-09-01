import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Product rule, machine-enforced:
 *   第三方 harness 产品只可参考思路/方法,严禁直接挂载、依赖或复制。
 *
 * The distribution may depend ONLY on:
 *   - official @deepseek-ai/* packages
 *   - our own workspace packages (@dsh-community/*)
 *   - generic UI/utility libraries reviewed and pinned in
 *     THIRD_PARTY_RUNTIME_ALLOWLIST (ink, react…)
 *
 * Enforced on four surfaces:
 *   1. raw forbidden-pattern scan over every manifest/composition/config file
 *   2. parsed runtime dependencies (dependencies/peerDependencies/
 *      optionalDependencies) of every workspace package.json — devDependencies
 *      are build-time only and out of scope; tests/fixtures are out of scope
 *   3. `name:` rows in cordis patch ymls
 *   4. any scoped npm name (@scope/pkg) appearing anywhere in the config surface
 *
 * Any third-party dsh.bundle / harness-family package fails CI. Reading
 * third-party source for reference is allowed; shipping it is not.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * Metadata-only config may name third-party packages because its job is to
 * describe/review them. It must never be treated as a runtime composition
 * surface. Marketplace-specific schema and install-chain tests cover it.
 */
const METADATA_ONLY_CONFIG_PATHS = new Set([
  join('packages', 'marketplace', 'catalog.json'),
  join('apps', 'desktop', 'runtime-lock', 'package-lock.json'),
])

/** Third-party packages that are harness products or harness surface implementations. */
const FORBIDDEN_PACKAGE_PATTERNS = [
  /@deepseek-harness-tui\//u,
  /^dsh-tui$/u,
  /@dsh-community\/dsh-tui/u,
]

/** Only runtime manifests/composition/config rows count; tests/docs and registry metadata may discuss third-party packages. */
const SCAN_EXTENSION = /\.(json|yml|yaml)$/u

/**
 * Reviewed third-party libraries allowed as RUNTIME dependencies.
 * This list IS the review checklist: a dependency missing from it fails CI,
 * and removing the last real use of an entry also fails CI (stale entry).
 * New entries require conscious review of their transitive install surface.
 */
const THIRD_PARTY_RUNTIME_ALLOWLIST = ['ink', 'ink-spinner', 'react']

/** Type-only packages: compile-time inputs, fully erased from runtime bundles. */
const TYPES_ONLY_PREFIX = '@types/'

const OFFICIAL_SCOPE = '@deepseek-ai/'
const WORKSPACE_SCOPE = '@dsh-community/'

/** Runtime-installed sections only. devDependencies never ship in dist bundles. */
const RUNTIME_DEP_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

type DepSection = (typeof RUNTIME_DEP_SECTIONS)[number]

type ManifestDeps = Partial<Record<DepSection, Record<string, string>>>

type DepCategory = 'official' | 'workspace' | 'types-only' | 'foreign'

/** npm package-name shape; anything else in a dep slot is malformed, not just foreign. */
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

/** Scoped npm names embedded anywhere in config/patch content. */
const SCOPED_NAME_RE = /@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/gu

/** YAML `name:` row inside patch/composition files (JSON `"name":` cannot match). */
const PATCH_NAME_ROW_RE = /^[ \t]*(?:-[ \t]*)?name:[ \t]*['"]?([^'"\n#]+?)['"]?[ \t]*$/gmu

function classifyName(name: string): DepCategory {
  if (name.startsWith(WORKSPACE_SCOPE)) return 'workspace'
  if (name.startsWith(OFFICIAL_SCOPE)) return 'official'
  if (name.startsWith(TYPES_ONLY_PREFIX)) return 'types-only'
  return 'foreign'
}

function isForbidden(name: string): boolean {
  return FORBIDDEN_PACKAGE_PATTERNS.some((pattern) => pattern.test(name))
}

function walk(dir: string, into: string[]): void {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name === 'dist' || name.name === 'release' || name.name === 'runtime-stage' || name.name === 'runtime-host' || name.name === '.pack-root') continue
    const full = join(dir, name.name)
    if (name.isDirectory()) walk(full, into)
    else if (name.isFile() && SCAN_EXTENSION.test(name.name)) into.push(full)
  }
}

function scanSurfaceFiles(): string[] {
  const files: string[] = []
  walk(join(root, 'apps'), files)
  walk(join(root, 'packages'), files)
  walk(join(root, 'contracts'), files)
  return files.filter((file) => !METADATA_ONLY_CONFIG_PATHS.has(relative(root, file))).sort()
}

/** Every pnpm-workspace member manifest (packages/*, apps/*, tests/*) plus the root. */
function collectManifestPaths(): string[] {
  const paths = [join(root, 'package.json')]
  for (const group of ['packages', 'apps', 'tests']) {
    const dir = join(root, group)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = join(dir, entry.name, 'package.json')
      if (existsSync(manifest)) paths.push(manifest)
    }
  }
  return paths.sort()
}

interface DepRef {
  manifest: string
  section: DepSection
  name: string
}

function collectRuntimeDeps(): DepRef[] {
  const refs: DepRef[] = []
  for (const manifest of collectManifestPaths()) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as ManifestDeps & { name?: string }
    for (const section of RUNTIME_DEP_SECTIONS) {
      for (const name of Object.keys(pkg[section] ?? {})) {
        refs.push({ manifest: relative(root, manifest), section, name })
      }
    }
  }
  return refs
}

describe('third-party harness products are reference-only, never shipped', () => {
  it('keeps marketplace registry metadata outside the runtime composition sweep', () => {
    const catalogPath = join(root, 'packages', 'marketplace', 'catalog.json')
    expect(existsSync(catalogPath)).toBe(true)
    expect(scanSurfaceFiles()).not.toContain(catalogPath)

    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as { plugins?: unknown[] }
    expect(catalog.plugins?.length ?? 0).toBeGreaterThan(0)
  })

  it('keeps generated runtime dependency resolution metadata out of the composition sweep', () => {
    const lockPath = join(root, 'apps', 'desktop', 'runtime-lock', 'package-lock.json')
    const manifestPath = join(root, 'apps', 'desktop', 'runtime-lock', 'package.json')
    expect(existsSync(lockPath)).toBe(true)
    expect(existsSync(manifestPath)).toBe(true)
    expect(scanSurfaceFiles()).not.toContain(lockPath)
    expect(scanSurfaceFiles()).toContain(manifestPath)

    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      packages?: Record<string, unknown>
    }
    expect(Object.keys(lock.packages ?? {}).length).toBeGreaterThan(500)
  })

  it('no manifest or composition row mounts a third-party TUI/harness package', () => {
    const files = scanSurfaceFiles()
    const hits: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of FORBIDDEN_PACKAGE_PATTERNS) {
        if (pattern.test(text)) hits.push(`${file}: ${String(pattern)}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('collects the expected workspace manifests (anti-rot guard on the sweep itself)', () => {
    const manifests = collectManifestPaths()
    const rel = manifests.map((m) => relative(root, m))
    // The TUI/Desktop runtime surface this rule protects must actually be swept.
    for (const required of ['package.json', join('apps', 'tui', 'package.json'), join('apps', 'desktop', 'package.json')]) {
      expect(rel, `manifest sweep lost ${required}`).toContain(required)
    }
    expect(manifests.length).toBeGreaterThanOrEqual(7)
  })

  it('every runtime dependency classifies as official / workspace / reviewed allowlist', () => {
    const refs = collectRuntimeDeps()
    expect(refs.length).toBeGreaterThan(0)
    const violations: string[] = []
    for (const ref of refs) {
      if (!NPM_NAME_RE.test(ref.name)) {
        violations.push(`${ref.manifest} [${ref.section}] "${ref.name}" is not a valid npm package name`)
        continue
      }
      if (isForbidden(ref.name)) {
        violations.push(`${ref.manifest} [${ref.section}] ${ref.name} is a forbidden harness product`)
        continue
      }
      const category = classifyName(ref.name)
      if (category === 'official' || category === 'workspace') continue
      if (category === 'foreign' && !THIRD_PARTY_RUNTIME_ALLOWLIST.includes(ref.name)) {
        violations.push(
          `${ref.manifest} [${ref.section}] ${ref.name} is an unreviewed third-party runtime dependency; review its install surface, then add it to THIRD_PARTY_RUNTIME_ALLOWLIST or remove it`,
        )
      }
    }
    expect(violations).toEqual([])
  })

  it('the third-party runtime review list matches repo reality exactly', () => {
    const actual = [...new Set(collectRuntimeDeps().map(({ name }) => name))]
      .filter((name) => NPM_NAME_RE.test(name) && !isForbidden(name) && classifyName(name) === 'foreign')
      .sort()
    expect(actual).toEqual([...THIRD_PARTY_RUNTIME_ALLOWLIST].sort())
  })

  it('TUI/Desktop app manifests carry zero third-party runtime dependencies', () => {
    const appRefs = collectRuntimeDeps().filter((ref) => /^apps[/\\]/u.test(ref.manifest))
    const foreign = appRefs.filter((ref) => classifyName(ref.name) === 'foreign')
    expect(
      foreign.map((ref) => `${ref.manifest} [${ref.section}] ${ref.name}`),
      'app bundles may mount official and own-workspace code only; generic libraries belong to the tui-surface layer',
    ).toEqual([])
  })

  it('patch composition rows mount official or own-workspace packages only', () => {
    const files = scanSurfaceFiles().filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    const hits: { file: string; name: string }[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(PATCH_NAME_ROW_RE)) {
        const name = (match[1] ?? '').trim()
        if (name !== '') hits.push({ file: relative(root, file), name })
      }
    }
    expect(hits.length, 'patch name-row scan found nothing; extraction rotted').toBeGreaterThan(0)
    const violations = hits.filter(({ name }) => classifyName(name) !== 'official' && classifyName(name) !== 'workspace')
    expect(violations, JSON.stringify(violations)).toEqual([])
  })

  it('every scoped npm name referenced across the config surface is official, ours, or type-only', () => {
    const files = [...scanSurfaceFiles(), join(root, 'package.json')]
    const violations: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(SCOPED_NAME_RE)) {
        const name = match[0]
        const category = classifyName(name)
        if (isForbidden(name) || category === 'foreign') {
          violations.push(`${relative(root, file)}: ${name}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
