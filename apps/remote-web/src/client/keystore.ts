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

function checkEpochAdvance(
  incomingEpoch: number,
  storedEpoch: number,
  allowReset: boolean | undefined,
): Error | undefined {
  if (allowReset === true) return undefined
  if (storedEpoch > 0 && incomingEpoch <= storedEpoch) {
    const cmp = incomingEpoch < storedEpoch ? '<' : '<='
    return new Error(
      `Epoch rollback blocked (${incomingEpoch} ${cmp} ${storedEpoch}); fresh pairing confirmation required`,
    )
  }
  return undefined
}

function formatIdbError(action: string, error?: unknown): Error {
  if (error instanceof Error) {
    return new Error(`${action}: ${error.message}`)
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return new Error(`${action}: ${String((error as { message?: unknown }).message)}`)
  }
  return new Error(`${action}${error !== undefined ? `: ${String(error)}` : ''}`)
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
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
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
        req.onsuccess = () => {
          const db = req.result
          db.onversionchange = () => {
            if (this.dbPromise === pending) {
              this.dbPromise = undefined
            }
            try {
              db.close?.()
            } catch {}
          }
          resolve(db)
        }
        req.onerror = () => {
          if (this.dbPromise === pending) {
            this.dbPromise = undefined
          }
          reject(formatIdbError('IndexedDB open failed', req.error))
        }
        req.onblocked = () => {
          if (this.dbPromise === pending) {
            this.dbPromise = undefined
          }
          reject(new Error('IndexedDB open blocked by another connection'))
        }
      } catch (err) {
        if (this.dbPromise === pending) {
          this.dbPromise = undefined
        }
        reject(formatIdbError('IndexedDB open failed', err))
      }
    })
    this.dbPromise = pending
    return pending
  }

  private async runReadTx<T>(
    storeName: string,
    action: string,
    createReq: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T | undefined> {
    const db = await this.openDb()
    if (!db) return undefined
    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false
      const settleOk = (val: T | undefined): void => {
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
        const tx = db.transaction(storeName, 'readonly')
        const req = createReq(tx.objectStore(storeName))
        tx.onerror = () => settleErr(formatIdbError(action, tx.error))
        tx.onabort = () => settleErr(formatIdbError(`${action} (aborted)`, tx.error))
        req.onsuccess = () => settleOk(req.result)
        req.onerror = () => settleErr(formatIdbError(action, req.error ?? tx.error))
      } catch (err) {
        settleErr(formatIdbError(action, err))
      }
    })
  }

  private async runWriteTx<T = unknown>(
    storeName: string,
    action: string,
    exec: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<void> {
    const db = await this.openDb()
    if (!db) return
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
        const tx = db.transaction(storeName, 'readwrite')
        tx.oncomplete = () => settleOk()
        tx.onerror = () => settleErr(formatIdbError(action, tx.error))
        tx.onabort = () => settleErr(formatIdbError(`${action} (aborted)`, tx.error))
        const req = exec(tx.objectStore(storeName))
        if (req && typeof req === 'object') {
          req.onerror = () => settleErr(formatIdbError(action, req.error ?? tx.error))
        }
      } catch (err) {
        settleErr(formatIdbError(action, err))
      }
    })
  }

  private async readFromDb<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    return this.runReadTx<T | undefined>(storeName, `IndexedDB read failed (${storeName})`, (store) =>
      store.get(key),
    )
  }

  private async readAllHostsFromDb(): Promise<TrustedHostProfile[] | undefined> {
    const res = await this.runReadTx<TrustedHostProfile[]>(
      STORE_HOSTS,
      'IndexedDB readAll failed (hosts)',
      (store) => store.getAll(),
    )
    if (res === undefined && (!this.useIndexedDb || typeof globalThis.indexedDB === 'undefined')) {
      return undefined
    }
    return res ?? []
  }

  private async putInDb(storeName: string, value: unknown): Promise<void> {
    await this.runWriteTx(storeName, `IndexedDB write failed (${storeName})`, (store) => store.put(value))
  }

  private async deleteFromDb(storeName: string, key: IDBValidKey): Promise<void> {
    await this.runWriteTx(storeName, `IndexedDB delete failed (${storeName})`, (store) => store.delete(key))
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
    return new Promise<ClientDeviceIdentity>((resolve, reject) => {
      let settled = false
      const settleOk = (identity: ClientDeviceIdentity): void => {
        if (settled) return
        settled = true
        resolve(identity)
      }
      const settleErr = (err: Error): void => {
        if (settled) return
        settled = true
        reject(err)
      }
      try {
        // Perform the existence check and conditional insert synchronously inside a single
        // readwrite IndexedDB transaction so concurrent tabs serialize and never overwrite a
        // peer tab's newly created client identity.
        const tx = db.transaction(STORE_IDENTITY, 'readwrite')
        const store = tx.objectStore(STORE_IDENTITY)
        const req = store.get(IDENTITY_RECORD_KEY)
        let chosen: ClientDeviceIdentity = candidate
        let writeAttempted = false
        req.onsuccess = () => {
          const existing = req.result
          if (isValidStoredIdentity(existing)) {
            chosen = toIdentity(existing)
            return
          }
          chosen = candidate
          writeAttempted = true
          try {
            const putReq = store.put(candidateRow)
            if (putReq && typeof putReq === 'object') {
              putReq.onerror = () =>
                settleErr(formatIdbError('IndexedDB identity persist failed', putReq.error ?? tx.error))
            }
          } catch (err) {
            try {
              tx.abort?.()
            } catch {}
            settleErr(formatIdbError('IndexedDB identity persist failed', err))
          }
        }
        req.onerror = () => {
          settleErr(formatIdbError('IndexedDB identity read failed', req.error ?? tx.error))
        }
        tx.oncomplete = () => settleOk(chosen)
        tx.onerror = () =>
          settleErr(
            formatIdbError(
              writeAttempted ? 'IndexedDB identity persist failed' : 'IndexedDB identity transaction failed',
              tx.error,
            ),
          )
        tx.onabort = () =>
          settleErr(
            formatIdbError(
              writeAttempted ? 'IndexedDB identity persist aborted' : 'IndexedDB identity transaction aborted',
              tx.error,
            ),
          )
      } catch (err) {
        settleErr(formatIdbError('IndexedDB identity transaction failed', err))
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
    await this.putInDb(STORE_IDENTITY, {
      id: IDENTITY_RECORD_KEY,
      publicKey: new Uint8Array(created.publicKey),
      secretKey: new Uint8Array(created.secretKey),
      fingerprint: created.fingerprint,
      createdAt: created.createdAt,
    } satisfies StoredIdentityRow)
    if (this.identityGeneration === rotationGeneration) {
      this.memoryIdentity = cloneIdentity(created)
    }
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
      const rollbackErr = mem
        ? checkEpochAdvance(sanitized.lastEpoch, mem.lastEpoch, options?.allowEpochReset)
        : undefined
      if (rollbackErr) {
        throw rollbackErr
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
        let committedExisting: TrustedHostProfile | undefined
        req.onsuccess = () => {
          const existing = req.result as TrustedHostProfile | undefined
          const err = existing
            ? checkEpochAdvance(sanitized.lastEpoch, existing.lastEpoch, options?.allowEpochReset)
            : undefined
          if (existing && err) {
            committedExisting = existing
            rollbackError = err
            return
          }
          try {
            const putReq = store.put(sanitized)
            if (putReq && typeof putReq === 'object') {
              putReq.onerror = () =>
                settleErr(formatIdbError('IndexedDB trusted host save failed', putReq.error ?? tx.error))
            }
          } catch (putErr) {
            rollbackError = formatIdbError('IndexedDB trusted host save failed', putErr)
            try {
              tx.abort?.()
            } catch {}
            settleErr(rollbackError)
          }
        }
        req.onerror = () => {
          settleErr(formatIdbError('IndexedDB trusted host read failed', req.error ?? tx.error))
        }
        tx.oncomplete = () => {
          if (rollbackError) {
            if (committedExisting) {
              this.memoryHosts.set(sanitized.hostFingerprint, committedExisting)
            }
            settleErr(rollbackError)
            return
          }
          this.memoryHosts.set(sanitized.hostFingerprint, sanitized)
          settleOk()
        }
        tx.onerror = () => {
          settleErr(rollbackError ?? formatIdbError('IndexedDB trusted host save failed', tx.error))
        }
        tx.onabort = () => {
          settleErr(rollbackError ?? formatIdbError('IndexedDB trusted host save aborted', tx.error))
        }
      } catch (err) {
        settleErr(formatIdbError('IndexedDB trusted host save failed', err))
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
      const err = checkEpochAdvance(epoch, existing.lastEpoch, options?.allowReset)
      if (err) {
        throw err
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
        let committedExisting: TrustedHostProfile | undefined
        let updated: TrustedHostProfile | undefined
        req.onsuccess = () => {
          const existing = req.result as TrustedHostProfile | undefined
          if (!existing) {
            updated = undefined
            return
          }
          const err = checkEpochAdvance(epoch, existing.lastEpoch, options?.allowReset)
          if (err) {
            committedExisting = existing
            rollbackError = err
            return
          }
          updated = buildUpdated(existing)
          try {
            const putReq = store.put(updated)
            if (putReq && typeof putReq === 'object') {
              putReq.onerror = () =>
                settleErr(formatIdbError('IndexedDB epoch update failed', putReq.error ?? tx.error))
            }
          } catch (putErr) {
            rollbackError = formatIdbError('IndexedDB epoch update failed', putErr)
            try {
              tx.abort?.()
            } catch {}
            settleErr(rollbackError)
          }
        }
        req.onerror = () => {
          settleErr(formatIdbError('IndexedDB host epoch read failed', req.error ?? tx.error))
        }
        tx.oncomplete = () => {
          if (rollbackError) {
            if (committedExisting) {
              this.memoryHosts.set(key, committedExisting)
            }
            settleErr(rollbackError)
            return
          }
          if (updated) {
            this.memoryHosts.set(key, updated)
          }
          settleOk(updated)
        }
        tx.onerror = () => {
          settleErr(rollbackError ?? formatIdbError('IndexedDB epoch update failed', tx.error))
        }
        tx.onabort = () => {
          settleErr(rollbackError ?? formatIdbError('IndexedDB epoch update aborted', tx.error))
        }
      } catch (err) {
        settleErr(formatIdbError('IndexedDB epoch update failed', err))
      }
    })
  }

  async forgetHost(hostFingerprint: string): Promise<void> {
    const key = hostFingerprint.toLowerCase()
    await this.deleteFromDb(STORE_HOSTS, key)
    this.memoryHosts.delete(key)
  }
}
