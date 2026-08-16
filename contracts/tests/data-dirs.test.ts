import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hostProcessEnv,
  ISOLATED_DESKTOP_ENV,
  OFFICIAL_DSH_HOME_DIR,
  OFFICIAL_DSH_HOME_ENV,
  resolveDesktopAppLayout,
  resolveEffectiveOfficialHome,
  resolveOfficialDshHome,
} from '@dsh-community/dsh-bridge'

describe('official data vs desktop data', () => {
  it('defaults official home to ~/.dsh and does not rewrite DSH_HOME', () => {
    expect(resolveOfficialDshHome({}, '/home/dev')).toBe(join('/home/dev', OFFICIAL_DSH_HOME_DIR))
    expect(resolveOfficialDshHome({ [OFFICIAL_DSH_HOME_ENV]: '/custom/dsh' }, '/home/dev')).toBe('/custom/dsh')
    const env = hostProcessEnv({
      env: { [OFFICIAL_DSH_HOME_ENV]: '/already/shared' },
      homedir: '/home/dev',
      desktopUserData: '/tmp/desktop-app',
    })
    expect(env[OFFICIAL_DSH_HOME_ENV]).toBe('/already/shared')
  })

  it('keeps desktop files out of ~/.dsh', () => {
    const layout = resolveDesktopAppLayout('/tmp/desktop-app')
    expect(layout.runtimeVersions).toBe('/tmp/desktop-app/runtime-versions.json')
    expect(layout.windowState.startsWith('/tmp/desktop-app/')).toBe(true)
    expect(layout.root).not.toContain('/.dsh/')
  })

  it('only isolates official home when explicitly requested', () => {
    const isolated = hostProcessEnv({
      env: { [ISOLATED_DESKTOP_ENV]: '1' },
      homedir: '/home/dev',
      desktopUserData: '/tmp/desktop-app',
    })
    expect(isolated[OFFICIAL_DSH_HOME_ENV]).toBe('/tmp/desktop-app/isolated-dsh')
  })

  it('lists the isolated official home when Desktop asks for isolation', () => {
    const fromSetting = resolveEffectiveOfficialHome({
      env: {},
      homedir: '/home/dev',
      desktopUserData: '/tmp/desktop-app',
      isolated: true,
    })
    expect(fromSetting).toBe('/tmp/desktop-app/isolated-dsh')
    const shared = resolveEffectiveOfficialHome({
      env: {},
      homedir: '/home/dev',
      desktopUserData: '/tmp/desktop-app',
    })
    expect(shared).toBe(join('/home/dev', OFFICIAL_DSH_HOME_DIR))
    const child = hostProcessEnv({
      env: {},
      homedir: '/home/dev',
      desktopUserData: '/tmp/desktop-app',
      isolated: true,
    })
    expect(child[OFFICIAL_DSH_HOME_ENV]).toBe('/tmp/desktop-app/isolated-dsh')
  })
})
