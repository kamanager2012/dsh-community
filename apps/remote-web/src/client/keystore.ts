import { sha256Hex } from '../crypto/bytes.ts'
import { generateX25519KeyPair } from '../crypto/x25519.ts'
import type { TrustedHostProfile } from './types.ts'

export interface ClientDeviceIdentity {
  readonly publicKey: Uint8Array
  readonly secretKey: Uint8Array
  readonly fingerprint: string
  readonly createdAt: number
}

const DB_NAME = 'dsh-remote-web-v1'
const DB_VERSION = 1
const STORE_IDENTITY = 'identity'
const STORE_HOSTS = 'hosts'
const IDENTITY_RECORD_KEY = 'client-keypair'

interface StoredIdentityRow {
  readonly id: string
  readonly publicKey: Uint8Array
  readonly secretKey: Uint8Array
  readonly fingerprint: string
  readonly createdAt: number
}

function cloneIdentity(identity: ClientDeviceIdentity): ClientDeviceIdentity {
  return {
    publicKey: new Uint8Array(identity.publicKey),
    secretKey: new Uint8Array(identity.secretKey),
    fingerprint: identity.fingerprint,
    createdAt: identity.createdAt,
  }
}

function isValidStoredIdentity(row: unknown): row is StoredIdentityRow {
  if (typeof row !== 'object' || row === null) return false
  const rec = row as Partial<StoredIdentityRow>
  return (
    rec.publicKey instanceof Uint8Array &&
    rec.secretKey instanceof Uint8Array &&
    rec.publicKey.byteLength === 32 &&
    rec.secretKey.byteLength === 32 &&
    typeof rec.fingerprint === 'string' &&
    rec.fingerprint.length > 0 &&
    typeof rec.createdAt === 'number' &&
    Number.isFinite(rec.createdAt)
  )
}

function toIdentity(
  row: Pick<StoredIdentityRow, 'publicKey' | 'secretKey' | 'fingerprint' | 'createdAt'>,
): ClientDeviceIdentity {
  return {
    publicKey: new Uint8Array(row.publicKey),
    secretKey: new Uint8Array(row.secretKey),
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  }
}

function sanitizeHostProfile(profile: TrustedHostProfile): TrustedHostProfile {
  return {
    hostFingerprint: profile.hostFingerprint.toLowerCase(),
    hostPublicKeyHex: profile.hostPublicKeyHex.toLowerCase(),
    label: profile.label,
    endpointUrl: profile.endpointUrl,
    ...(profile.relayUrl !== undefined ? { relayUrl: profile.relayUrl } : {}),
    ...(profile.relayRoomId !== undefined ? { relayRoomId: profile.relayRoomId } : {}),
    ...(profile.signalingUrl !== undefined ? { signalingUrl: profile.signalingUrl } : {}),
    ...(profile.signalingRoomId !== undefined ? { signalingRoomId: profile.signalingRoomId } : {}),
    ...(profile.stunUrls !== undefined ? { stunUrls: [...profile.stunUrls] } : {}),
    lastEpoch: profile.lastEpoch,
    pairedAt: profile.pairedAt,
    lastConnectedAt: profile.lastConnectedAt,
    ...(profile.preferredTransport !== undefined ? { preferredTransport: profile.preferredTransport } : {}),
  }
}

export class RemoteWebKeyStore {
  private memoryIdentity: ClientDeviceIdentity | undefined = undefined
  private readonly memoryHosts = new Map<string, TrustedHostProfile>()
  private dbPromise: Promise<IDBDatabase | undefined> | undefined = undefined
  private pendingIdentityPromise: Promise<ClientDeviceIdentity> | undefined = undefined
  private identityGeneration = 0

  constructor(private readonly useIndexedDb: boolean = typeof globalThis.indexedDB !== 'undefined') {}

  private openDb(): Promise<IDBDatabase | undefined> {
    if (!this.useIndexedDb || typeof globalThis.indexedDB === 'undefined') {
      return Promise.resolve(undefined)
    }
    if (this.dbPromise) {
      return this.dbPromise
    }
    this.dbPromise = new Promise<IDBDatabase | undefined>((resolve) => {
      try {
        const req = globalThis.indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE_IDENTITY)) {
            db.createObjectStore(STORE_IDENTITY, { keyPath: 'id' })
          }
          if (!db.objectStoreNames.contains(STORE_HOSTS)) {
            db.createObjectStore(STORE_HOSTS, { keyPath: 'hostFingerprint' })
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    })
    return this.dbPromise
  }

  private async readFromDb<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    const db = await this.openDb()
    if (!db) return undefined
    return new Promise<T | undefined>((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readonly')
        const req = tx.objectStore(storeName).get(key)
        req.onsuccess = () => resolve(req.result as T | undefined)
        req.onerror = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    })
  }

  private async readAllHostsFromDb(): Promise<TrustedHostProfile[] | undefined> {
    const db = await this.openDb()
    if (!db) return undefined
    return new Promise<TrustedHostProfile[] | undefined>((resolve) => {
      try {
        const tx = db.transaction(STORE_HOSTS, 'readonly')
        const req = tx.objectStore(STORE_HOSTS).getAll()
        req.onsuccess = () => resolve((req.result as TrustedHostProfile[] | undefined) ?? [])
        req.onerror = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    })
  }

  private async putInDb(storeName: string, value: unknown): Promise<void> {
    const db = await this.openDb()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite')
        tx.objectStore(storeName).put(value)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
      } catch {
        resolve()
      }
    })
  }

  private async deleteFromDb(storeName: string, key: IDBValidKey): Promise<void> {
    const db = await this.openDb()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite')
        tx.objectStore(storeName).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
      } catch {
        resolve()
      }
    })
  }

  private async generateIdentity(): Promise<ClientDeviceIdentity> {
    const generated = generateX25519KeyPair()
    const fingerprint = await sha256Hex(generated.publicKey)
    return {
      publicKey: generated.publicKey,
      secretKey: generated.secretKey,
      fingerprint,
      createdAt: Date.now(),
    }
  }

  private async getOrInsertIdentityInDb(candidate: ClientDeviceIdentity): Promise<ClientDeviceIdentity> {
    const db = await this.openDb()
    if (!db) return candidate
    const candidateRow: StoredIdentityRow = {
      id: IDENTITY_RECORD_KEY,
      publicKey: new Uint8Array(candidate.publicKey),
      secretKey: new Uint8Array(candidate.secretKey),
      fingerprint: candidate.fingerprint,
      createdAt: candidate.createdAt,
    }
    return new Promise<ClientDeviceIdentity>((resolve) => {
      let settled = false
      const finish = (identity: ClientDeviceIdentity): void => {
        if (settled) return
        settled = true
        resolve(identity)
      }
      try {
        // Perform the existence check and conditional insert synchronously inside a single
        // readwrite IndexedDB transaction so concurrent tabs serialize and never overwrite a
        // peer tab's newly created client identity.
        const tx = db.transaction(STORE_IDENTITY, 'readwrite')
        const store = tx.objectStore(STORE_IDENTITY)
        const req = store.get(IDENTITY_RECORD_KEY)
        let chosen: ClientDeviceIdentity = candidate
        req.onsuccess = () => {
          const existing = req.result
          if (isValidStoredIdentity(existing)) {
            chosen = toIdentity(existing)
            return
          }
          chosen = candidate
          try {
            store.put(candidateRow)
          } catch {
            // Let tx error/abort handler resolve safely.
          }
        }
        req.onerror = () => {
          // Wait for tx completion or abort.
        }
        tx.oncomplete = () => finish(chosen)
        tx.onerror = () => finish(chosen)
        tx.onabort = () => finish(chosen)
      } catch {
        finish(candidate)
      }
    })
  }

  async getOrCreateClientKeyPair(): Promise<ClientDeviceIdentity> {
    if (this.memoryIdentity) {
      return cloneIdentity(this.memoryIdentity)
    }
    if (this.pendingIdentityPromise) {
      return this.pendingIdentityPromise.then((identity) => cloneIdentity(identity))
    }

    const startGeneration = this.identityGeneration
    const pending = (async (): Promise<ClientDeviceIdentity> => {
      const existing = await this.readFromDb<StoredIdentityRow>(STORE_IDENTITY, IDENTITY_RECORD_KEY)
      let resolved: ClientDeviceIdentity
      if (isValidStoredIdentity(existing)) {
        resolved = toIdentity(existing)
      } else {
        const candidate = await this.generateIdentity()
        resolved = await this.getOrInsertIdentityInDb(candidate)
      }
      if (this.identityGeneration === startGeneration) {
        this.memoryIdentity = cloneIdentity(resolved)
        return cloneIdentity(this.memoryIdentity)
      }
      return this.memoryIdentity ? cloneIdentity(this.memoryIdentity) : cloneIdentity(resolved)
    })()

    this.pendingIdentityPromise = pending
    try {
      return await pending
    } finally {
      if (this.pendingIdentityPromise === pending) {
        this.pendingIdentityPromise = undefined
      }
    }
  }

  async rotateClientKeyPair(): Promise<ClientDeviceIdentity> {
    const rotationGeneration = ++this.identityGeneration
    this.pendingIdentityPromise = undefined
    const created = await this.generateIdentity()
    if (this.identityGeneration === rotationGeneration) {
      this.memoryIdentity = cloneIdentity(created)
    }
    await this.putInDb(STORE_IDENTITY, {
      id: IDENTITY_RECORD_KEY,
      publicKey: new Uint8Array(created.publicKey),
      secretKey: new Uint8Array(created.secretKey),
      fingerprint: created.fingerprint,
      createdAt: created.createdAt,
    } satisfies StoredIdentityRow)
    return cloneIdentity(created)
  }

  async listTrustedHosts(): Promise<TrustedHostProfile[]> {
    const rows = await this.readAllHostsFromDb()
    if (rows) {
      this.memoryHosts.clear()
      for (const host of rows) {
        this.memoryHosts.set(host.hostFingerprint, host)
      }
    }
    return [...this.memoryHosts.values()].sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
  }

  async getTrustedHost(fingerprint: string): Promise<TrustedHostProfile | undefined> {
    const key = fingerprint.toLowerCase()
    const db = await this.openDb()
    if (!db) {
      return this.memoryHosts.get(key)
    }
    const row = await this.readFromDb<TrustedHostProfile>(STORE_HOSTS, key)
    if (row) {
      this.memoryHosts.set(key, row)
    } else {
      this.memoryHosts.delete(key)
    }
    return row
  }

  async saveTrustedHost(
    profile: TrustedHostProfile,
    options?: { readonly allowEpochReset?: boolean | undefined },
  ): Promise<void> {
    // Strip any accidental token-like extras and normalize key
    const sanitized = sanitizeHostProfile(profile)
    const db = await this.openDb()
    if (!db) {
      const mem = this.memoryHosts.get(sanitized.hostFingerprint)
      if (mem && sanitized.lastEpoch < mem.lastEpoch && options?.allowEpochReset !== true) {
        throw new Error(
          `Epoch rollback blocked (${sanitized.lastEpoch} < ${mem.lastEpoch}); fresh pairing confirmation required`,
        )
      }
      this.memoryHosts.set(sanitized.hostFingerprint, sanitized)
      return
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settleOk = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      const settleErr = (err: Error): void => {
        if (settled) return
        settled = true
        reject(err)
      }
      try {
        const tx = db.transaction(STORE_HOSTS, 'readwrite')
        const store = tx.objectStore(STORE_HOSTS)
        const req = store.get(sanitized.hostFingerprint)
        let rollbackError: Error | undefined
        req.onsuccess = () => {
          const existing = req.result as TrustedHostProfile | undefined
          if (
            existing &&
            sanitized.lastEpoch < existing.lastEpoch &&
            options?.allowEpochReset !== true
          ) {
            this.memoryHosts.set(sanitized.hostFingerprint, existing)
            rollbackError = new Error(
              `Epoch rollback blocked (${sanitized.lastEpoch} < ${existing.lastEpoch}); fresh pairing confirmation required`,
            )
            return
          }
          try {
            store.put(sanitized)
          } catch {
            // Fall through to tx completion/error.
          }
        }
        req.onerror = () => {
          // Wait for tx completion/error.
        }
        tx.oncomplete = () => {
          if (rollbackError) {
            settleErr(rollbackError)
            return
          }
          this.memoryHosts.set(sanitized.hostFingerprint, sanitized)
          settleOk()
        }
        tx.onerror = () => {
          if (rollbackError) {
            settleErr(rollbackError)
            return
          }
          this.memoryHosts.set(sanitized.hostFingerprint, sanitized)
          settleOk()
        }
        tx.onabort = () => {
          if (rollbackError) {
            settleErr(rollbackError)
            return
          }
          this.memoryHosts.set(sanitized.hostFingerprint, sanitized)
          settleOk()
        }
      } catch {
        this.memoryHosts.set(sanitized.hostFingerprint, sanitized)
        settleOk()
      }
    })
  }

  async updateHostEpoch(
    hostFingerprint: string,
    epoch: number,
    options?: {
      readonly allowReset?: boolean | undefined
      readonly profilePatch?: Partial<TrustedHostProfile> | undefined
    },
  ): Promise<TrustedHostProfile | undefined> {
    const key = hostFingerprint.toLowerCase()
    const buildUpdated = (existing: TrustedHostProfile): TrustedHostProfile =>
      sanitizeHostProfile({
        ...existing,
        ...(options?.profilePatch ?? {}),
        hostFingerprint: key,
        lastEpoch: epoch,
        lastConnectedAt: Date.now(),
      })

    const db = await this.openDb()
    if (!db) {
      const existing = this.memoryHosts.get(key)
      if (!existing) return undefined
      if (epoch < existing.lastEpoch && options?.allowReset !== true) {
        throw new Error(
          `Epoch rollback blocked (${epoch} < ${existing.lastEpoch}); fresh pairing confirmation required`,
        )
      }
      const updated = buildUpdated(existing)
      this.memoryHosts.set(key, updated)
      return updated
    }

    return new Promise<TrustedHostProfile | undefined>((resolve, reject) => {
      let settled = false
      const settleOk = (val: TrustedHostProfile | undefined): void => {
        if (settled) return
        settled = true
        resolve(val)
      }
      const settleErr = (err: Error): void => {
        if (settled) return
        settled = true
        reject(err)
      }
      try {
        // Atomic cross-tab compare-and-write inside a single readwrite IDB transaction so
        // another tab's higher epoch cannot be overwritten by a stale tab-local cache.
        const tx = db.transaction(STORE_HOSTS, 'readwrite')
        const store = tx.objectStore(STORE_HOSTS)
        const req = store.get(key)
        let rollbackError: Error | undefined
        let updated: TrustedHostProfile | undefined
        req.onsuccess = () => {
          const existing = req.result as TrustedHostProfile | undefined
          if (!existing) {
            updated = undefined
            return
          }
          if (epoch < existing.lastEpoch && options?.allowReset !== true) {
            this.memoryHosts.set(key, existing)
            rollbackError = new Error(
              `Epoch rollback blocked (${epoch} < ${existing.lastEpoch}); fresh pairing confirmation required`,
            )
            return
          }
          updated = buildUpdated(existing)
          try {
            store.put(updated)
          } catch {
            // Handled cleanly on tx completion/error.
          }
        }
        req.onerror = () => {
          // Wait for tx completion/error.
        }
        tx.oncomplete = () => {
          if (rollbackError) {
            settleErr(rollbackError)
            return
          }
          if (updated) {
            this.memoryHosts.set(key, updated)
          }
          settleOk(updated)
        }
        tx.onerror = () => {
          if (rollbackError) {
            settleErr(rollbackError)
            return
          }
          if (updated) {
            this.memoryHosts.set(key, updated)
          }
          settleOk(updated)
        }
        tx.onabort = () => {
          if (rollbackError) {
            settleErr(rollbackError)
            return
          }
          if (updated) {
            this.memoryHosts.set(key, updated)
          }
          settleOk(updated)
        }
      } catch {
        const mem = this.memoryHosts.get(key)
        if (!mem) {
          settleOk(undefined)
          return
        }
        if (epoch < mem.lastEpoch && options?.allowReset !== true) {
          settleErr(
            new Error(
              `Epoch rollback blocked (${epoch} < ${mem.lastEpoch}); fresh pairing confirmation required`,
            ),
          )
          return
        }
        const fallbackUpdated = buildUpdated(mem)
        this.memoryHosts.set(key, fallbackUpdated)
        settleOk(fallbackUpdated)
      }
    })
  }

  async forgetHost(hostFingerprint: string): Promise<void> {
    const key = hostFingerprint.toLowerCase()
    this.memoryHosts.delete(key)
    await this.deleteFromDb(STORE_HOSTS, key)
  }
}
