/**
 * Compose check: for every catalog entry, run the OFFICIAL install chain in a
 * fresh DSH_HOME and assert the plugin composes as a profile layer.
 *
 *   dsh plugin --profile test add <name>@<version>
 *   dsh --profile test --dump-config   → must list the plugin
 *
 * Uses the catalog `testedDsh` unless `DSH_COMPOSE_RUNTIME` is set.
 *
 * The official runtime is STAGED ONCE per distinct runtime version into an
 * isolated dir (pnpm primary, npm fallback, `DSH_COMPOSE_PM` override) and its
 * bin is reused for every check. The previous `npx -y @deepseek-ai/dsh@…`
 * per call re-resolved and installed the full kernel tree (60+ subpackages)
 * each time — slow enough to blow per-call timeouts on CI runners, and npm's
 * resolver OOMs on that tree (`DSH_COMPOSE_BIN` still skips staging entirely
 * by pointing at a pre-installed official `dsh`).
 *
 * The official `plugin add` command itself forwards to pnpm inside the
 * profile directory, so a `pnpm` shim is put on PATH for child processes
 * (corepack ships with Node ≥22) when the runner has none.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CATALOG_PATH = fileURLToPath(new URL('../catalog.json', import.meta.url))
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
const failures = []

const STAGE_TIMEOUT_MS = 300_000

/** One staged runtime per distinct version; checks on the same testedDsh reuse it. */
const stagedRuntimes = new Map()
/** Runtimes whose staging failed — never retry them per-plugin. */
const failedRuntimes = new Map()

function pnpmAvailable(env = process.env) {
  try {
    execFileSync('pnpm', ['--version'], { stdio: 'ignore', timeout: 15_000, env })
    return true
  } catch {
    return false
  }
}

function pickPm() {
  return process.env.DSH_COMPOSE_PM?.trim() || (pnpmAvailable() ? 'pnpm' : 'npm')
}

/**
 * The official `dsh plugin … add` shells out to pnpm, and runtime staging is
 * also fastest with it. CI runners ship npm + yarn but not pnpm, so
 * synthesize a shim via corepack FIRST and prepend it to this process's PATH,
 * making `pnpm` visible to both our own staging calls and every child.
 * No-op when pnpm is already available. Returns extra child env (or {}).
 */
function ensurePnpmOnPath() {
  if (pnpmAvailable()) return {}
  const shimDir = mkdtempSync(join(tmpdir(), 'dsh-compose-pnpm-shim-'))
  execFileSync('corepack', ['enable', '--install-directory', shimDir], {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  })
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`
  return { PATH: process.env.PATH }
}

function stageRuntime(runtime) {
  const cached = stagedRuntimes.get(runtime)
  if (cached) return cached.bin
  const failed = failedRuntimes.get(runtime)
  if (failed) throw new Error(failed)
  const stage = mkdtempSync(join(tmpdir(), 'dsh-compose-runtime-'))
  writeFileSync(
    join(stage, 'package.json'),
    JSON.stringify({ name: 'dsh-compose-runtime', private: true }, null, 2) + '\n',
  )
  try {
    execFileSync(
      pickPm(),
      ['add', '--ignore-scripts', `@deepseek-ai/dsh@${runtime}`],
      {
        cwd: stage,
        encoding: 'utf8',
        timeout: STAGE_TIMEOUT_MS,
        // npm swallows SIGTERM and keeps running; without SIGKILL the timeout
        // never actually ends the call (observed as a 30-minute CI hang).
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  } catch (error) {
    const message = `${pickPm()} add @deepseek-ai/dsh@${runtime} failed (${error.message})`
    failedRuntimes.set(runtime, message)
    rmSync(stage, { recursive: true, force: true })
    throw new Error(message)
  }
  const manifest = JSON.parse(
    readFileSync(join(stage, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
  )
  const entry = { bin: join(stage, 'node_modules', '@deepseek-ai', 'dsh', manifest.bin.dsh) }
  stagedRuntimes.set(runtime, entry)
  return entry.bin
}

function run(bin, args, env, timeoutMs = 180_000) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  })
}

const NPM_NAME_RE = /^(@[a-z0-9-][a-z0-9-._]*\/)?[a-z0-9-][a-z0-9-._]*$/
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/

async function checkPlugin(plugin) {
  if (!NPM_NAME_RE.test(plugin.name)) {
    failures.push(`${plugin.name}: not a valid npm package name; refusing to compose`)
    return
  }
  for (const version of plugin.versions) {
    // Fresh DSH_HOME per VERSION, not per plugin: stale installs from an
    // earlier version must not leak into a later "fresh install" assertion.
    const home = mkdtempSync(join(tmpdir(), 'dsh-compose-'))
    let env = { ...process.env, ...pnpmEnv, DSH_HOME: home, CI: 'true' }
    try {
      if (!SEMVER_RE.test(version.version)) {
        failures.push(`${plugin.name}@${version.version}: invalid semver; refusing to compose`)
        continue
      }
      const spec = `${plugin.name}@${version.version}`
      const runtime = process.env.DSH_COMPOSE_RUNTIME?.trim() || version.testedDsh
      let bin = process.env.DSH_COMPOSE_BIN?.trim()
      if (!bin) {
        try {
          bin = stageRuntime(runtime)
        } catch (error) {
          failures.push(`${spec}: runtime @${runtime} staging failed (${error.message})`)
          continue
        }
      }
      try {
        run(bin, ['plugin', '--profile', 'test', 'add', spec], env)
      } catch (error) {
        failures.push(`${spec}: install failed (${error.message})\n${String(error.stdout ?? '')}${String(error.stderr ?? '')}`)
        continue
      }
      let dump
      try {
        dump = run(bin, ['--profile', 'test', '--dump-config'], env, 120_000)
      } catch (error) {
        failures.push(`${spec}: dump-config failed (${error.message})\n${String(error.stdout ?? '')}${String(error.stderr ?? '')}`)
        continue
      }
      if (!dump.includes(plugin.name)) {
        failures.push(`${spec}: installed but not listed in the composed profile`)
      } else {
        process.stdout.write(`OK  ${spec} composes on ${runtime}\n`)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
}

const plugins = catalog.plugins ?? []
// Put a pnpm on PATH before anything stages or installs (corepack shim when
// the host has none), so both runtime staging and `dsh plugin add` use it.
const pnpmEnv = ensurePnpmOnPath()
for (const plugin of plugins) {
  await checkPlugin(plugin)
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`compose OK: ${String(plugins.length)} plugins on the official install chain\n`)
