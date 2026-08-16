import { describe, expect, it } from 'vitest'
import { resolveHostLaunchPaths } from '../src/paths.ts'

describe('resolveHostLaunchPaths', () => {
  it('uses a real Node in development, not the Electron binary', () => {
    const paths = resolveHostLaunchPaths({
      isPackaged: false,
      from: import.meta.url,
      env: { ...process.env, DSH_DESKTOP_NODE_EXECUTABLE: '/usr/bin/node' },
      execPath: '/opt/Electron',
      resourcesPath: '/tmp/resources',
      homedir: '/home/dev',
      cwd: '/tmp/project',
    })
    expect(paths.nodeExecutable).toBe('/usr/bin/node')
    expect(paths.electronRunAsNode).toBe(false)
    expect(paths.cliEntry).toMatch(/@deepseek-ai\/dsh\/lib\/bin\.js$/)
  })

  it('prefers a real Node over Electron-as-node when packaged', () => {
    const realNode = process.execPath
    const paths = resolveHostLaunchPaths({
      isPackaged: true,
      from: import.meta.url,
      env: { ...process.env, DSH_DESKTOP_NODE_EXECUTABLE: realNode },
      execPath: '/opt/Electron',
      resourcesPath: '/tmp/does-not-exist-resources',
      homedir: '/home/dev',
      cwd: '/tmp/project',
    })
    expect(paths.nodeExecutable).toBe(realNode)
    expect(paths.electronRunAsNode).toBe(false)
    expect(paths.cwd).toBe('/home/dev')
    expect(paths.env.NODE_PATH).toMatch(/host\/node_modules/)
  })

  it('falls back to Electron-as-node when no real Node is available', () => {
    const paths = resolveHostLaunchPaths({
      isPackaged: true,
      from: import.meta.url,
      env: { ...process.env, PATH: '/nonexistent-bin' },
      execPath: '/opt/Electron',
      resourcesPath: '/tmp/does-not-exist-resources',
      homedir: '/home/dev',
      cwd: '/tmp/project',
    })
    expect(paths.nodeExecutable).toBe('/opt/Electron')
    expect(paths.electronRunAsNode).toBe(true)
    expect(paths.env.NODE_PATH).toMatch(/host\/node_modules/)
  })
})
