import { execFile } from 'node:child_process'
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const buildScriptPath = join(desktopDir, 'scripts/build.mjs')

const { buildDesktopBundles } = (await import(pathToFileURL(buildScriptPath).href)) as {
  buildDesktopBundles: (outputRoot?: string) => Promise<void>
}

describe('desktop ESM bundles CJS/sodium-native interop', () => {
  it('bundles dist/main.js without CJS require("assert") or require-addon crashes in dev and packaged layouts', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundle-test-'))
    try {
      const buildOut = join(sandbox, 'build-out')
      await buildDesktopBundles(buildOut)

      const mainJsPath = join(buildOut, 'dist', 'main.js')
      const preloadJsPath = join(buildOut, 'dist', 'preload.js')
      const pluginPath = join(buildOut, 'remote-bundle', 'cordis-plugin.mjs')
      const mainSource = readFileSync(mainJsPath, 'utf8')
      const preloadSource = readFileSync(preloadJsPath, 'utf8')
      const pluginSource = readFileSync(pluginPath, 'utf8')

      expect(mainSource).toContain('const require = __dshCreateRequire(import.meta.url);')
      expect(mainSource).not.toContain('require-addon/lib/node.js')
      expect(mainSource).not.toContain('__filename')
      expect(pluginSource).not.toContain('__filename')
      expect(preloadSource).not.toMatch(/^\s*import\s+/mu)

      // Electron executes sandboxed preload scripts via CommonJS-style function wrapper;
      // verify preload.js loads without ESM syntax and exposes window.dshCommunity.
      let exposedName = ''
      let exposedApi: Record<string, unknown> | undefined
      const sandboxPreload = new Function('require', 'module', 'exports', preloadSource) as (
        req: (id: string) => unknown,
        mod: { exports: Record<string, unknown> },
        exp: Record<string, unknown>,
      ) => void
      const cjsMod = { exports: {} }
      sandboxPreload(
        (id) => {
          if (id !== 'electron') throw new Error(`Unexpected sandbox require in preload: ${id}`)
          return {
            contextBridge: {
              exposeInMainWorld: (name: string, api: Record<string, unknown>) => {
                exposedName = name
                exposedApi = api
              },
            },
            ipcRenderer: { invoke: () => Promise.resolve() },
          }
        },
        cjsMod,
        cjsMod.exports,
      )
      expect(exposedName).toBe('dshCommunity')
      expect(typeof exposedApi?.showRemote).toBe('function')
      expect(typeof exposedApi?.remoteStart).toBe('function')

      writeFileSync(join(buildOut, 'package.json'), '{"type":"module"}\n')

      const fakePackagedRes = join(sandbox, 'packaged-resources')
      const fakeAppRoot = join(fakePackagedRes, 'app-asar-extracted')
      const fakeAppDist = join(fakeAppRoot, 'dist')
      mkdirSync(fakeAppDist, { recursive: true })
      writeFileSync(join(fakeAppRoot, 'package.json'), '{"type":"module"}\n')
      copyFileSync(mainJsPath, join(fakeAppDist, 'main.js'))
      cpSync(join(buildOut, 'remote-bundle'), join(fakePackagedRes, 'remote'), { recursive: true })

      const runnerScript = `
        import { registerHooks } from 'node:module';
        import { pathToFileURL } from 'node:url';

        const electronStub = \`
          const noop = () => {};
          export const app = {
            requestSingleInstanceLock: () => false,
            quit: noop,
            exit: noop,
            setName: noop,
            setPath: noop,
            getVersion: () => '0.2.2-rc.2',
            isPackaged: false,
            on: noop,
            once: noop,
            whenReady: () => new Promise(() => {}),
            getPath: () => '/tmp',
          };
          export const clipboard = { writeText: noop };
          export const ipcMain = { handle: noop, on: noop };
          export const Menu = { buildFromTemplate: () => ({}) };
          export const nativeImage = { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }) };
          export const Notification = class {};
          export const session = {};
          export const Tray = class {};
          export const BrowserWindow = class {};
          export const WebContentsView = class {};
          export const shell = { openExternal: noop };
        \`;

        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier === 'electron') return { url: 'electron:stub', shortCircuit: true };
            return nextResolve(specifier, context);
          },
          load(url, context, nextLoad) {
            if (url === 'electron:stub') return { format: 'module', source: electronStub, shortCircuit: true };
            return nextLoad(url, context);
          },
        });

        await import(pathToFileURL(process.argv[1]).href);
        Object.defineProperty(process, 'resourcesPath', { value: process.argv[2], configurable: true });
        await import(pathToFileURL(process.argv[3]).href);
        const remotePlugin = await import(pathToFileURL(process.argv[4]).href);
        if (remotePlugin.name !== 'dsh-community-remote' || typeof remotePlugin.apply !== 'function') {
          throw new Error('cordis-plugin.mjs missing expected Cordis plugin exports');
        }
        process.stdout.write('BUNDLE_BOOT_OK\\n');
      `

      const { stdout } = await execFileAsync(process.execPath, [
        '--input-type=module',
        '-e',
        runnerScript,
        mainJsPath,
        fakePackagedRes,
        join(fakeAppDist, 'main.js'),
        pluginPath,
      ])
      expect(stdout).toContain('BUNDLE_BOOT_OK')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
