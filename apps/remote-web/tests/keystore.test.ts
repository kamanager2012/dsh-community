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
      const ops: Array<() => Promise<void> | void> = []
      const tx = {
        oncomplete: null as ((ev: Event) => void) | null,
        onerror: null as ((ev: Event) => void) | null,
        onabort: null as ((ev: Event) => void) | null,
        objectStore(requestedStore: string) {
          if (requestedStore !== storeName) {
            throw new Error(`Unexpected store: ${requestedStore}`)
          }
          return {
            get(key: IDBValidKey) {
              const req: {
                result: unknown
                onsuccess: ((ev: Event) => void) | null
                onerror: ((ev: Event) => void) | null
              } = {
                result: undefined,
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
                onsuccess: ((ev: Event) => void) | null
                onerror: ((ev: Event) => void) | null
              } = {
                result: undefined,
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
              const keyField = storeName === 'identity' ? 'id' : 'hostFingerprint'
              const key = String(value[keyField] ?? '')
              ops.push(() => {
                writeCounts.set(storeName, (writeCounts.get(storeName) ?? 0) + 1)
                store.set(key, cloneRecord(value))
              })
              return {}
            },
            delete(key: IDBValidKey) {
              ops.push(() => {
                store.delete(String(key))
              })
              return {}
            },
          }
        },
      } as unknown as IDBTransaction

      const runOps = async (): Promise<void> => {
        // Yield once so caller attaches request/transaction handlers synchronously after tx creation.
        await Promise.resolve()
        for (let i = 0; i < ops.length; i += 1) {
          await ops[i]!()
        }
        tx.oncomplete?.(new Event('complete'))
      }

      if (mode === 'readwrite') {
        const next = rwTail.then(runOps, runOps)
        rwTail = next.catch(() => {})
      } else {
        void runOps()
      }

      return tx
    },
  } as unknown as IDBDatabase

  const indexedDBMock = {
    open(): IDBOpenDBRequest {
      const req: {
        result: IDBDatabase | undefined
        onupgradeneeded: ((ev: IDBVersionChangeEvent) => void) | null
        onsuccess: ((ev: Event) => void) | null
        onerror: ((ev: Event) => void) | null
      } = {
        result: undefined,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      }
      queueMicrotask(() => {
        req.result = fakeDb
        req.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent)
        req.onsuccess?.(new Event('success'))
      })
      return req as unknown as IDBOpenDBRequest
    },
  } as unknown as IDBFactory

  return { indexedDBMock, tables, writeCounts }
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
})
