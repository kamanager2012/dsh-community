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

async function stageRemoteBundle() {
  const remoteOut = join(appRoot, 'remote-bundle')
  await rm(remoteOut, { recursive: true, force: true })
  await mkdir(remoteOut, { recursive: true })

  // Remove stale legacy output if present from earlier builds.
  await rm(join(appRoot, 'dist', 'remote-cordis-plugin.mjs'), { force: true })
  await rm(join(appRoot, 'dist', 'remote-cordis-plugin.mjs.map'), { force: true })

  const targetPrebuild = `${process.platform}-${process.arch}`
  const remoteAdapterDir = resolve(workspace, 'packages/remote-adapter')
  const noiseDir = resolvePackageDir(remoteAdapterDir, 'noise-handshake')
  const sodiumUniversalDir = resolvePackageDir(noiseDir, 'sodium-universal')
  const sodiumNativeDir = resolvePackageDir(sodiumUniversalDir, 'sodium-native')
  const addonSource = join(sodiumNativeDir, 'prebuilds', targetPrebuild, 'sodium-native.node')
  if (!existsSync(addonSource)) {
    throw new Error(`Missing sodium-native prebuild at ${addonSource}`)
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

  await esbuild.build({
    ...common,
    entryPoints: [resolve(workspace, 'packages/remote-adapter/src/cordis-plugin.ts')],
    outfile: join(remoteOut, 'cordis-plugin.mjs'),
    plugins: [sodiumBindingPlugin],
    banner: {
      js: [
        "import { createRequire as __dshCreateRequire } from 'node:module';",
        'const require = __dshCreateRequire(import.meta.url);',
        'const __dshLoadAddon = (relPath) => require(relPath);',
      ].join(' '),
    },
  })

  const prebuildDest = join(remoteOut, 'prebuilds', targetPrebuild)
  await mkdir(prebuildDest, { recursive: true })
  await cp(addonSource, join(prebuildDest, 'sodium-native.node'))
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
