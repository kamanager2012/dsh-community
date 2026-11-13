/**
 * Lightweight persistent identity & trusted-device store helpers for
 * `@dsh-community/remote-adapter`. Separated from carrier/WebRTC runtime modules
 * so UI shells can query/revoke trust state without loading P2P stacks.
 */

import { chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { FileDeviceTrustStore } from './crypto/file-device-trust.js'
import { FileHostIdentityStore } from './crypto/file-host-identity.js'
import { RemoteProtocolError } from './errors.js'

export interface PersistentRemoteStores {
  readonly configDir: string
  readonly hostIdentityPath: string
  readonly trustedDevicesPath: string
  readonly hostIdentityStore: FileHostIdentityStore
  readonly trustStore: FileDeviceTrustStore
}

export function defaultRemoteDshHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const fromEnv = env.DSH_HOME?.trim()
  if (fromEnv && fromEnv.length > 0) {
    return resolve(fromEnv)
  }
  return resolve(home, '.dsh')
}

export function defaultRemoteConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.DSH_REMOTE_CONFIG_DIR?.trim()
  if (override && override.length > 0) {
    return resolve(override)
  }
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || join(home, 'AppData', 'Roaming')
    return resolve(appData, 'dsh-community', 'remote')
  }
  const xdgConfig = env.XDG_CONFIG_HOME?.trim()
  const base = xdgConfig && xdgConfig.length > 0 ? resolve(xdgConfig) : resolve(home, '.config')
  return resolve(base, 'dsh-community', 'remote')
}

function canonicalizePathWithExistingAncestor(targetPath: string): string {
  const resolved = resolve(targetPath)
  try {
    return realpathSync(resolved)
  } catch {
    const parent = dirname(resolved)
    if (parent !== resolved) {
      try {
        return join(realpathSync(parent), resolved.slice(parent.length + 1))
      } catch {
        return resolved
      }
    }
    return resolved
  }
}

/**
 * Enforces `docs/remote-host-client.md` storage isolation: Community OS Remote state
 * (`host-identity.json`, `trusted-devices.json`) must never reside inside official `DSH_HOME`.
 */
export function assertOutsideOfficialDshHome(
  configDir: string,
  dshHome: string = defaultRemoteDshHome(),
): string {
  if (!isAbsolute(configDir)) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      `remote configDir must be an absolute path: ${configDir}`,
    )
  }
  const canonicalConfig = canonicalizePathWithExistingAncestor(configDir)
  const canonicalDshHome = canonicalizePathWithExistingAncestor(dshHome)
  if (
    canonicalConfig === canonicalDshHome ||
    canonicalConfig.startsWith(canonicalDshHome + sep)
  ) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      `community remote configDir '${canonicalConfig}' must remain strictly outside official DSH_HOME '${canonicalDshHome}'`,
    )
  }
  return canonicalConfig
}

export function openPersistentRemoteStores(options: {
  readonly configDir?: string | undefined
  readonly dshHome?: string | undefined
  readonly clock?: (() => number) | undefined
} = {}): PersistentRemoteStores {
  const dshHome = options.dshHome ?? defaultRemoteDshHome()
  const rawConfigDir = options.configDir ?? defaultRemoteConfigDir()
  const configDir = assertOutsideOfficialDshHome(rawConfigDir, dshHome)
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    chmodSync(configDir, 0o700)
  }

  const hostIdentityPath = join(configDir, 'host-identity.json')
  const trustedDevicesPath = join(configDir, 'trusted-devices.json')

  const storeClock = options.clock ? { clock: options.clock } : undefined
  const hostIdentityStore = new FileHostIdentityStore(hostIdentityPath, storeClock)
  FileDeviceTrustStore.recover(trustedDevicesPath)
  const trustStore = new FileDeviceTrustStore(trustedDevicesPath, storeClock)

  return {
    configDir,
    hostIdentityPath,
    trustedDevicesPath,
    hostIdentityStore,
    trustStore,
  }
}
