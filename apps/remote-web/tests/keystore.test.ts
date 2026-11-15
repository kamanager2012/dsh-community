import { afterEach, describe, expect, it } from 'vitest'
import { RemoteWebKeyStore } from '../src/client/keystore.ts'

interface FakeStoreRecord {
  id?: string
  hostFingerprint?: string
  [key: string]: unknown
}

function cloneRecord<T>(value: T): T {
  if (value === undefined || value === null) return value
  if (value instanceof Uint8Array) {
    return new Uint8Array(value) as T
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = v instanceof Uint8Array ? new Uint8Array(v) : v
    }
    return out as T
  }
  return value
}

function createSerializedIndexedDbMock(options?: {
  readonly onReadonlyIdentityGet?: () => Promise<void> | void
  readonly failOpenError?: Error
}) {
  const tables = new Map<string, Map<string, FakeStoreRecord>>([
    ['identity', new Map()],
    ['hosts', new Map()],
  ])
  const writeCounts = new Map<string, number>([
    ['identity', 0],
    ['hosts', 0],
  ])
  let rwTail: Promise<void> = Promise.resolve()
  let nextTxFailure:
    | { readonly kind: 'error' | 'abort'; readonly error?: Error; readonly throwSyncInPut?: boolean }
    | undefined

  const fakeDb = {
    objectStoreNames: {
      contains(name: string): boolean {
        return tables.has(name)
      },
    },
    createObjectStore(name: string): unknown {
      if (!tables.has(name)) {
        tables.set(name, new Map())
      }
      return {}
    },
    transaction(storeName: string, mode: IDBTransactionMode = 'readonly'): IDBTransaction {
      const store = tables.get(storeName)
      if (!store) {
        throw new Error(`Missing object store: ${storeName}`)
      }
      const txFailure = mode === 'readwrite' ? nextTxFailure : undefined
      if (txFailure) {
        nextTxFailure = undefined
      }
      const ops: Array<() => Promise<void> | void> = []
      const tx = {
        error: null as DOMException | Error | null,
        oncomplete: null as ((ev: Event) => void) | null,
        onerror: null as ((ev: Event) => void) | null,
        onabort: null as ((ev: Event) => void) | null,
        abort() {
          if (tx.error === null && txFailure?.error) {
            tx.error = txFailure.error
          }
        },
        objectStore(requestedStore: string) {
          if (requestedStore !== storeName) {
            throw new Error(`Unexpected store: ${requestedStore}`)
          }
          return {
            get(key: IDBValidKey) {
              const req: {
                result: unknown
                error: Error | null
                onsuccess: ((ev: Event) => void) | null
                onerror: ((ev: Event) => void) | null
              } = {
                result: undefined,
                error: null,
                onsuccess: null,
                onerror: null,
              }
              ops.push(async () => {
                if (
                  mode === 'readonly' &&
                  storeName === 'identity' &&
                  options?.onReadonlyIdentityGet
                ) {
                  await options.onReadonlyIdentityGet()
                }
                const existing = store.get(String(key))
                req.result = cloneRecord(existing)
                req.onsuccess?.(new Event('success'))
              })
              return req
            },
            getAll() {
              const req: {
                result: unknown
                error: Error | null
                onsuccess: ((ev: Event) => void) | null
                onerror: ((ev: Event) => void) | null
              } = {
                result: undefined,
                error: null,
                onsuccess: null,
                onerror: null,
              }
              ops.push(() => {
                req.result = [...store.values()].map((item) => cloneRecord(item))
                req.onsuccess?.(new Event('success'))
              })
              return req
            },
            put(value: FakeStoreRecord) {
              if (txFailure?.throwSyncInPut) {
                throw txFailure.error ?? new Error('QuotaExceededError')
              }
              const keyField = storeName === 'identity' ? 'id' : 'hostFingerprint'
              const key = String(value[keyField] ?? '')
              ops.push(() => {
                if (txFailure) return
                writeCounts.set(storeName, (writeCounts.get(storeName) ?? 0) + 1)
                store.set(key, cloneRecord(value))
              })
              return {}
            },
            delete(key: IDBValidKey) {
              ops.push(() => {
                if (txFailure) return
                store.delete(String(key))
              })
              return {}
            },
          }
        },
      }

      const runOps = async (): Promise<void> => {
        // Yield once so caller attaches request/transaction handlers synchronously after tx creation.
        await Promise.resolve()
        const snapshot = new Map([...store.entries()].map(([k, v]) => [k, cloneRecord(v)]))
        try {
          for (let i = 0; i < ops.length; i += 1) {
            await ops[i]!()
          }
        } catch (err) {
          store.clear()
          for (const [k, v] of snapshot) store.set(k, v)
          tx.error = err instanceof Error ? err : new Error(String(err))
          tx.onabort?.(new Event('abort'))
          return
        }
        if (txFailure) {
          store.clear()
          for (const [k, v] of snapshot) store.set(k, v)
          tx.error = txFailure.error ?? new Error(`IndexedDB simulated ${txFailure.kind}`)
          if (txFailure.kind === 'abort') {
            tx.onabort?.(new Event('abort'))
          } else {
            tx.onerror?.(new Event('error'))
          }
          return
        }
        tx.oncomplete?.(new Event('complete'))
      }

      if (mode === 'readwrite') {
        const next = rwTail.then(runOps, runOps)
        rwTail = next.catch(() => {})
      } else {
        void runOps()
      }

      return tx as unknown as IDBTransaction
    },
  } as unknown as IDBDatabase

  const indexedDBMock = {
    open(): IDBOpenDBRequest {
      const req: {
        result: IDBDatabase | undefined
        error: Error | null
        onupgradeneeded: ((ev: IDBVersionChangeEvent) => void) | null
        onsuccess: ((ev: Event) => void) | null
        onerror: ((ev: Event) => void) | null
        onblocked: ((ev: Event) => void) | null
      } = {
        result: undefined,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      }
      queueMicrotask(() => {
        if (options?.failOpenError) {
          req.error = options.failOpenError
          req.onerror?.(new Event('error'))
          return
        }
        req.result = fakeDb
        req.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent)
        req.onsuccess?.(new Event('success'))
      })
      return req as unknown as IDBOpenDBRequest
    },
  } as unknown as IDBFactory

  return {
    indexedDBMock,
    tables,
    writeCounts,
    failNextReadWriteTx(
      kind: 'error' | 'abort',
      error = new Error(kind === 'abort' ? 'Transaction aborted' : 'QuotaExceededError'),
      throwSyncInPut = false,
    ) {
      nextTxFailure = { kind, error, throwSyncInPut }
    },
  }
}

describe('RemoteWebKeyStore atomic client identity', () => {
  const originalIndexedDb = globalThis.indexedDB

  afterEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: originalIndexedDb,
      configurable: true,
      writable: true,
    })
  })

  it('deduplicates concurrent in-process getOrCreateClientKeyPair calls without IndexedDB', async () => {
    const store = new RemoteWebKeyStore(false)
    const [a, b, c] = await Promise.all([
      store.getOrCreateClientKeyPair(),
      store.getOrCreateClientKeyPair(),
      store.getOrCreateClientKeyPair(),
    ])
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(b.fingerprint).toBe(c.fingerprint)
    expect(a.publicKey).toEqual(b.publicKey)
    expect(a.secretKey).toEqual(c.secretKey)
  })

  it('serializes concurrent tabs via readwrite IndexedDB transaction without overwriting the first writer', async () => {
    let readonlyChecks = 0
    let releaseReadonlyBarrier!: () => void
    const readonlyBarrier = new Promise<void>((resolve) => {
      releaseReadonlyBarrier = resolve
    })

    const mock = createSerializedIndexedDbMock({
      onReadonlyIdentityGet: async () => {
        readonlyChecks += 1
        if (readonlyChecks === 2) {
          releaseReadonlyBarrier()
        }
        // Force both tabs to observe an empty store before either runs its readwrite tx.
        await readonlyBarrier
      },
    })
    Object.defineProperty(globalThis, 'indexedDB', {
      value: mock.indexedDBMock,
      configurable: true,
      writable: true,
    })

    const tab1 = new RemoteWebKeyStore(true)
    const tab2 = new RemoteWebKeyStore(true)
    const [id1, id2] = await Promise.all([
      tab1.getOrCreateClientKeyPair(),
      tab2.getOrCreateClientKeyPair(),
    ])

    expect(mock.writeCounts.get('identity')).toBe(1)
    expect(id1.fingerprint).toBe(id2.fingerprint)
    expect(id1.publicKey).toEqual(id2.publicKey)
    expect(id1.secretKey).toEqual(id2.secretKey)

    // Subsequent tab sees the persisted identity immediately.
    const tab3 = new RemoteWebKeyStore(true)
    const id3 = await tab3.getOrCreateClientKeyPair()
    expect(id3.fingerprint).toBe(id1.fingerprint)
    expect(mock.writeCounts.get('identity')).toBe(1)
  })

  it('repairs malformed stored identity atomically and persists explicit rotation', async () => {
    const mock = createSerializedIndexedDbMock()
    mock.tables.get('identity')!.set('client-keypair', {
      id: 'client-keypair',
      publicKey: new Uint8Array(4),
      secretKey: new Uint8Array(4),
      fingerprint: 'corrupt',
      createdAt: 1,
    })
    Object.defineProperty(globalThis, 'indexedDB', {
      value: mock.indexedDBMock,
      configurable: true,
      writable: true,
    })

    const tab1 = new RemoteWebKeyStore(true)
    const tab2 = new RemoteWebKeyStore(true)
    const [id1, id2] = await Promise.all([
      tab1.getOrCreateClientKeyPair(),
      tab2.getOrCreateClientKeyPair(),
    ])
    expect(mock.writeCounts.get('identity')).toBe(1)
    expect(id1.fingerprint).toBe(id2.fingerprint)
    expect(id1.publicKey.byteLength).toBe(32)

    const rotated = await tab1.rotateClientKeyPair()
    expect(rotated.fingerprint).not.toBe(id1.fingerprint)
    expect(mock.writeCounts.get('identity')).toBe(2)
    const reloaded = await new RemoteWebKeyStore(true).getOrCreateClientKeyPair()
    expect(reloaded.fingerprint).toBe(rotated.fingerprint)
  })

  it('prevents a tab with stale cached host epoch from overwriting a peer tab higher epoch', async () => {
    const mock = createSerializedIndexedDbMock()
    Object.defineProperty(globalThis, 'indexedDB', {
      value: mock.indexedDBMock,
      configurable: true,
      writable: true,
    })

    const fp = 'aa'.repeat(32)
    const baseProfile = {
      hostFingerprint: fp,
      hostPublicKeyHex: 'bb'.repeat(32),
      label: 'Dev Host',
      endpointUrl: 'ws://127.0.0.1:4555',
      lastEpoch: 100,
      pairedAt: 1000,
      lastConnectedAt: 1000,
      preferredTransport: 'lan' as const,
    }

    const tab1 = new RemoteWebKeyStore(true)
    const tab2 = new RemoteWebKeyStore(true)
    await tab1.saveTrustedHost(baseProfile)

    // Both tabs warm their local memoryHosts at epoch 100
    expect((await tab1.getTrustedHost(fp))?.lastEpoch).toBe(100)
    expect((await tab2.getTrustedHost(fp))?.lastEpoch).toBe(100)

    // Tab 2 connects to live host at epoch 102 and atomically patches transport
    const updatedByTab2 = await tab2.updateHostEpoch(fp, 102, {
      profilePatch: { preferredTransport: 'relay' },
    })
    expect(updatedByTab2?.lastEpoch).toBe(102)
    expect(updatedByTab2?.preferredTransport).toBe('relay')

    // Tab 1 (whose local memory previously held 100) tries to accept a stale clone at 101 or replay 102:
    // both updateHostEpoch and saveTrustedHost must fail closed and leave 102 intact in IDB.
    await expect(tab1.updateHostEpoch(fp, 101)).rejects.toThrow(/Epoch rollback blocked \(101 < 102\)/)
    await expect(tab1.updateHostEpoch(fp, 102)).rejects.toThrow(/Epoch rollback blocked \(102 <= 102\)/)
    await expect(
      tab1.saveTrustedHost({ ...baseProfile, lastEpoch: 101 }),
    ).rejects.toThrow(/Epoch rollback blocked \(101 < 102\)/)
    await expect(
      tab1.saveTrustedHost({ ...baseProfile, lastEpoch: 102 }),
    ).rejects.toThrow(/Epoch rollback blocked \(102 <= 102\)/)

    expect((await tab1.getTrustedHost(fp))?.lastEpoch).toBe(102)
    expect((await tab2.getTrustedHost(fp))?.lastEpoch).toBe(102)

    // Explicit allowReset overrides cleanly when user confirms epoch reset.
    const resetRes = await tab1.updateHostEpoch(fp, 5, { allowReset: true })
    expect(resetRes?.lastEpoch).toBe(5)
    expect((await tab2.getTrustedHost(fp))?.lastEpoch).toBe(5)
  })

  it('fails closed without mutating memory state when IndexedDB write/delete/open errors or aborts', async () => {
    const failOpenMock = createSerializedIndexedDbMock({
      failOpenError: new Error('SecurityError: IndexedDB disabled'),
    })
    Object.defineProperty(globalThis, 'indexedDB', {
      value: failOpenMock.indexedDBMock,
      configurable: true,
      writable: true,
    })
    const brokenStore = new RemoteWebKeyStore(true)
    await expect(brokenStore.getOrCreateClientKeyPair()).rejects.toThrow(/IndexedDB open failed/i)

    const mock = createSerializedIndexedDbMock()
    Object.defineProperty(globalThis, 'indexedDB', {
      value: mock.indexedDBMock,
      configurable: true,
      writable: true,
    })

    const store = new RemoteWebKeyStore(true)
    const initialId = await store.getOrCreateClientKeyPair()
    const fp = 'cc'.repeat(32)
    const initialHost = {
      hostFingerprint: fp,
      hostPublicKeyHex: 'dd'.repeat(32),
      label: 'Primary Host',
      endpointUrl: 'ws://127.0.0.1:4666',
      lastEpoch: 10,
      pairedAt: 1000,
      lastConnectedAt: 1000,
      preferredTransport: 'lan' as const,
    }
    await store.saveTrustedHost(initialHost)

    // 1. Key rotation QuotaExceededError -> rejects & preserves previous memory + IDB identity
    mock.failNextReadWriteTx('error', new Error('QuotaExceededError: disk full'))
    await expect(store.rotateClientKeyPair()).rejects.toThrow(/QuotaExceededError/)
    expect((await store.getOrCreateClientKeyPair()).fingerprint).toBe(initialId.fingerprint)
    expect((await new RemoteWebKeyStore(true).getOrCreateClientKeyPair()).fingerprint).toBe(
      initialId.fingerprint,
    )

    // 2. Host save abort -> rejects & does not pollute memoryHosts or IDB
    const fp2 = 'ee'.repeat(32)
    mock.failNextReadWriteTx('abort', new Error('AbortError: quota exceeded'))
    await expect(
      store.saveTrustedHost({ ...initialHost, hostFingerprint: fp2, label: 'Aborted Host' }),
    ).rejects.toThrow(/AbortError/)
    expect(await store.getTrustedHost(fp2)).toBeUndefined()
    expect((await store.listTrustedHosts()).map((h) => h.hostFingerprint)).toEqual([fp])

    // 3. Epoch update sync throw/abort -> rejects & preserves old epoch in memory and on reload
    mock.failNextReadWriteTx('abort', new Error('QuotaExceededError'), true)
    await expect(store.updateHostEpoch(fp, 25)).rejects.toThrow(/QuotaExceededError/)
    expect((await store.getTrustedHost(fp))?.lastEpoch).toBe(10)
    expect((await new RemoteWebKeyStore(true).getTrustedHost(fp))?.lastEpoch).toBe(10)

    // 4. forgetHost error -> rejects & preserves host in memory and on reload
    mock.failNextReadWriteTx('error', new Error('UnknownError: delete failed'))
    await expect(store.forgetHost(fp)).rejects.toThrow(/delete failed/)
    expect((await store.listTrustedHosts()).map((h) => h.hostFingerprint)).toEqual([fp])
    expect((await new RemoteWebKeyStore(true).getTrustedHost(fp))?.hostFingerprint).toBe(fp)
  })
})
