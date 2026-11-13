import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const workspace = resolve(appRoot, '../..')

const alias = {
  '@dsh-community/dsh-bridge': resolve(workspace, 'packages/dsh-bridge/src/index.ts'),
  '@dsh-community/remote-adapter/stores': resolve(workspace, 'packages/remote-adapter/src/stores.ts'),
  '@dsh-community/shared-types': resolve(workspace, 'packages/shared-types/src/index.ts'),
}

const common = {
  absWorkingDir: appRoot,
  bundle: true,
  platform: 'node',
  format: 'esm',
  sourcemap: true,
  external: ['electron'],
  alias,
}

function findNearestPackageJson(startDir, packageName) {
  let cur = realpathSync(startDir)
  for (;;) {
    const candidate = join(cur, 'node_modules', packageName, 'package.json')
    if (existsSync(candidate)) return realpathSync(candidate)
    const parent = dirname(cur)
    if (parent === cur) {
      throw new Error(`Missing runtime dependency '${packageName}' starting from ${startDir}`)
    }
    cur = parent
  }
}

function collectRuntimeClosure(rootPackageJson) {
  const closure = new Map()
  const walk = (pkgJsonPath) => {
    const realPkg = realpathSync(pkgJsonPath)
    const pkg = JSON.parse(readFileSync(realPkg, 'utf8'))
    if (closure.has(pkg.name)) return
    const dir = dirname(realPkg)
    closure.set(pkg.name, dir)
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      walk(findNearestPackageJson(dir, dep))
    }
  }
  walk(rootPackageJson)
  return closure
}

async function stageRemoteBundle() {
  const remoteOut = join(appRoot, 'remote-bundle')
  await rm(remoteOut, { recursive: true, force: true })
  await mkdir(remoteOut, { recursive: true })

  // Also remove stale root dist/remote-cordis-plugin.mjs* if present from earlier builds.
  await rm(join(appRoot, 'dist', 'remote-cordis-plugin.mjs'), { force: true })
  await rm(join(appRoot, 'dist', 'remote-cordis-plugin.mjs.map'), { force: true })

  await esbuild.build({
    ...common,
    entryPoints: [resolve(workspace, 'packages/remote-adapter/src/cordis-plugin.ts')],
    outfile: join(remoteOut, 'cordis-plugin.mjs'),
    external: ['electron', 'sodium-native'],
    banner: {
      js: "import { createRequire as __dshCreateRequire } from 'node:module'; const require = __dshCreateRequire(import.meta.url);",
    },
  })

  // Keep native prebuilds (sodium-native) outside app.asar alongside the standalone
  // Cordis plugin so require-addon locates N-API bindings cleanly at runtime.
  const remoteAdapterDir = resolve(workspace, 'packages/remote-adapter')
  const noisePkg = findNearestPackageJson(remoteAdapterDir, 'noise-handshake')
  const sodiumUniversalPkg = findNearestPackageJson(dirname(noisePkg), 'sodium-universal')
  const sodiumNativePkg = findNearestPackageJson(dirname(sodiumUniversalPkg), 'sodium-native')
  const closure = collectRuntimeClosure(sodiumNativePkg)

  const targetPrebuild = `${process.platform}-${process.arch}`
  const nodeModulesDir = join(remoteOut, 'node_modules')
  await mkdir(nodeModulesDir, { recursive: true })

  for (const [pkgName, srcDir] of closure) {
    const destDir = join(nodeModulesDir, pkgName)
    await cp(srcDir, destDir, {
      recursive: true,
      dereference: true,
      filter: (src) => {
        const rel = relative(srcDir, src).replace(/\\/gu, '/')
        if (rel === '' || !rel.startsWith('prebuilds/')) return true
        const [, archDir, fileName] = rel.split('/')
        if (archDir !== undefined && archDir !== '' && archDir !== targetPrebuild) return false
        if (fileName !== undefined && fileName !== '' && !fileName.endsWith('.node')) return false
        return true
      },
    })
  }
}

await Promise.all([
  esbuild.build({
    ...common,
    entryPoints: ['src/main.ts'],
    outfile: 'dist/main.js',
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/preload.ts'],
    outfile: 'dist/preload.js',
  }),
  stageRemoteBundle(),
])
