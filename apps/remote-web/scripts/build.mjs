import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const distDir = join(appRoot, 'dist')
const publicDir = join(appRoot, 'public')

await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })

await esbuild.build({
  absWorkingDir: appRoot,
  entryPoints: [join(appRoot, 'src/main.ts')],
  outfile: join(distDir, 'app.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022', 'safari16'],
  sourcemap: true,
  logLevel: 'info',
})

await cp(publicDir, distDir, { recursive: true })
