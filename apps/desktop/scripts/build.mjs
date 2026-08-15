import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const workspace = resolve(appRoot, '../..')

const alias = {
  '@dsh-community/dsh-bridge': resolve(workspace, 'packages/dsh-bridge/src/index.ts'),
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
])
