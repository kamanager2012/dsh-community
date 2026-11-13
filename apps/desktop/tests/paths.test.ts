import { describe, expect, it } from 'vitest'
import { isCompatibleNodeVersion, resolveHostLaunchPaths } from '../src/paths.ts'

describe('isCompatibleNodeVersion', () => {
  it('accepts Node >= 22.15.0 and rejects older distro Node versions', () => {
    expect(isCompatibleNodeVersion('v22.15.0\n')).toBe(true)
    expect(isCompatibleNodeVersion('v22.23.2')).toBe(true)
    expect(isCompatibleNodeVersion('v24.0.0')).toBe(true)
    expect(isCompatibleNodeVersion('22.16.1')).toBe(true)

    expect(isCompatibleNodeVersion('v22.14.9')).toBe(false)
    expect(isCompatibleNodeVersion('v20.19.0')).toBe(false)
    expect(isCompatibleNodeVersion('v18.20.4')).toBe(false)
    expect(isCompatibleNodeVersion('')).toBe(false)
    expect(isCompatibleNodeVersion('not-a-version')).toBe(false)
  })
})

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

  it('prefers a compatible real Node (>= 22.15.0) over Electron-as-node when packaged', () => {
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
    expect(paths.env.NODE_PATH).toMatch(/node_modules/)

    const probedPaths = resolveHostLaunchPaths({
      isPackaged: true,
      from: import.meta.url,
      env: { ...process.env, DSH_DESKTOP_NODE_EXECUTABLE: '' },
      execPath: '/opt/Electron',
      resourcesPath: '/tmp/does-not-exist-resources',
      homedir: '/home/dev',
      cwd: '/tmp/project',
      probeNodeVersion: () => 'v22.15.0\n',
    })
    expect(probedPaths.nodeExecutable).toBe('node')
    expect(probedPaths.electronRunAsNode).toBe(false)
  })

  it('falls back to Electron-as-node when system Node is missing or older than 22.15.0', () => {
    const missingPaths = resolveHostLaunchPaths({
      isPackaged: true,
      from: import.meta.url,
      env: { ...process.env, PATH: '/nonexistent-bin', DSH_DESKTOP_NODE_EXECUTABLE: '' },
      execPath: '/opt/Electron',
      resourcesPath: '/tmp/does-not-exist-resources',
      homedir: '/home/dev',
      cwd: '/tmp/project',
    })
    expect(missingPaths.nodeExecutable).toBe('/opt/Electron')
    expect(missingPaths.electronRunAsNode).toBe(true)
    expect(missingPaths.env.NODE_PATH).toMatch(/node_modules/)

    const oldDistroPaths = resolveHostLaunchPaths({
      isPackaged: true,
      from: import.meta.url,
      env: { ...process.env, DSH_DESKTOP_NODE_EXECUTABLE: '' },
      execPath: '/opt/Electron',
      resourcesPath: '/tmp/does-not-exist-resources',
      homedir: '/home/dev',
      cwd: '/tmp/project',
      probeNodeVersion: () => 'v20.18.1\n',
    })
    expect(oldDistroPaths.nodeExecutable).toBe('/opt/Electron')
    expect(oldDistroPaths.electronRunAsNode).toBe(true)
  })
})
