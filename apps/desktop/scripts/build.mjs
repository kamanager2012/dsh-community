import { existsSync, realpathSync } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const workspace = resolve(appRoot, '../..')

const alias = {
  '@dsh-community/dsh-bridge': resolve(workspace, 'packages/dsh-bridge/src/index.ts'),
  '@dsh-community/remote-adapter/remote-env': resolve(workspace, 'packages/remote-adapter/src/remote-env.ts'),
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

// Keep prebuilds/ without any directory named `node_modules` so electron-builder
// extraResources never drops runtime files via its top-level node_modules filter.
const sodiumBindingPlugin = {
  name: 'sodium-native-prebuild',
  setup(build) {
    build.onLoad({ filter: /[/\\]sodium-native[/\\]binding\.js$/ }, () => ({
      contents:
        "module.exports = __dshLoadAddon('./prebuilds/' + process.platform + '-' + process.arch + '/sodium-native.node');",
      loader: 'js',
    }))
  },
}

const mainBannerJs = [
  "import { createRequire as __dshCreateRequire } from 'node:module';",
  "import { existsSync as __dshExistsSync } from 'node:fs';",
  "import { dirname as __dshDirname, join as __dshJoin } from 'node:path';",
  "import { fileURLToPath as __dshFileURLToPath } from 'node:url';",
  'const require = __dshCreateRequire(import.meta.url);',
  'const __dshMainDir = __dshDirname(__dshFileURLToPath(import.meta.url));',
  'const __dshLoadAddon = (relPath) => {',
  "  const candidates = [process.resourcesPath ? __dshJoin(process.resourcesPath, 'remote', relPath) : '', __dshJoin(__dshMainDir, '..', 'remote-bundle', relPath)].filter(Boolean);",
  '  for (const candidate of candidates) { if (__dshExistsSync(candidate)) return require(candidate); }',
  '  throw new Error(`Missing sodium-native.node for desktop main (checked: ${candidates.join(", ")})`);',
  '};',
].join(' ')

function resolvePackageDir(startDir, packageName) {
  let cur = realpathSync(startDir)
  for (;;) {
    const candidate = join(cur, 'node_modules', packageName, 'package.json')
    if (existsSync(candidate)) return dirname(realpathSync(candidate))
    const parent = dirname(cur)
    if (parent === cur) {
      throw new Error(`Missing dependency '${packageName}' starting from ${startDir}`)
    }
    cur = parent
  }
}

async function stageRemoteBundle(outputRoot = appRoot) {
  const remoteOut = join(outputRoot, 'remote-bundle')
  await rm(remoteOut, { recursive: true, force: true })
  await mkdir(remoteOut, { recursive: true })

  // Remove stale legacy output if present from earlier builds.
  await rm(join(outputRoot, 'dist', 'remote-cordis-plugin.mjs'), { force: true })
  await rm(join(outputRoot, 'dist', 'remote-cordis-plugin.mjs.map'), { force: true })

  const targetPrebuild = `${process.platform}-${process.arch}`
  const remoteAdapterDir = resolve(workspace, 'packages/remote-adapter')
  const noiseDir = resolvePackageDir(remoteAdapterDir, 'noise-handshake')
  const sodiumUniversalDir = resolvePackageDir(noiseDir, 'sodium-universal')
  const sodiumNativeDir = resolvePackageDir(sodiumUniversalDir, 'sodium-native')
  const addonSource = join(sodiumNativeDir, 'prebuilds', targetPrebuild, 'sodium-native.node')
  if (!existsSync(addonSource)) {
    throw new Error(`Missing sodium-native prebuild at ${addonSource}`)
  }

  const standaloneBannerJs = [
    "import { createRequire as __dshCreateRequire } from 'node:module';",
    'const require = __dshCreateRequire(import.meta.url);',
    'const __dshLoadAddon = (relPath) => require(relPath);',
  ].join(' ')

  await Promise.all([
    esbuild.build({
      ...common,
      entryPoints: [resolve(workspace, 'packages/remote-adapter/src/cordis-plugin.ts')],
      outfile: join(remoteOut, 'cordis-plugin.mjs'),
      plugins: [sodiumBindingPlugin],
      banner: { js: standaloneBannerJs },
    }),
    esbuild.build({
      ...common,
      entryPoints: [resolve(workspace, 'packages/remote-adapter/src/standalone-cli.ts')],
      outfile: join(remoteOut, 'standalone-cli.mjs'),
      plugins: [sodiumBindingPlugin],
      banner: { js: standaloneBannerJs },
    }),
  ])

  const prebuildDest = join(remoteOut, 'prebuilds', targetPrebuild)
  await mkdir(prebuildDest, { recursive: true })
  await cp(addonSource, join(prebuildDest, 'sodium-native.node'))
}

export async function buildDesktopBundles(outputRoot = appRoot) {
  const distDir = join(outputRoot, 'dist')
  await mkdir(distDir, { recursive: true })
  await Promise.all([
    esbuild.build({
      ...common,
      entryPoints: ['src/main.ts'],
      outfile: join(distDir, 'main.js'),
      plugins: [sodiumBindingPlugin],
      banner: {
        js: mainBannerJs,
      },
    }),
    esbuild.build({
      ...common,
      format: 'cjs',
      entryPoints: ['src/preload.ts'],
      outfile: join(distDir, 'preload.js'),
    }),
    stageRemoteBundle(outputRoot),
  ])
}

const isEntrypoint =
  process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isEntrypoint) {
  await buildDesktopBundles()
}
