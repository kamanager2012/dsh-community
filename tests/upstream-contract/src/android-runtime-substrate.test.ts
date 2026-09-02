import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')

describe('Android runtime substrate evidence', () => {
  it('keeps Node 22 cross-build as a candidate, not a promoted runtime', () => {
    const state = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/runtime-substrate.json'), 'utf8'),
    ) as {
      status?: string
      candidate?: {
        id?: string
        status?: string
        upstreamPlatformSupport?: string
        androidApi?: number
        architectures?: string[]
        manualProbe?: string
      }
    }

    expect(state.status).toBe('BLOCKED')
    expect(state.candidate?.id).toBe('official-node-v22.19.0-android-crossbuild')
    expect(state.candidate?.status).toBe('PROBE_REQUIRED')
    expect(state.candidate?.upstreamPlatformSupport).toBe('UNSUPPORTED')
    expect(state.candidate?.androidApi).toBe(26)
    expect(state.candidate?.architectures).toEqual(['arm64', 'x86_64'])
    expect(state.candidate?.manualProbe).toBe('scripts/android-node22-probe.sh')
  })

  it('tracks the second-layer native DSH closure explicitly', () => {
    const blockers = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/native-blockers.json'), 'utf8'),
    ) as {
      fullWebProfile?: string
      standaloneSdkMinimal?: string
      blockers?: Array<{ id?: string; severity?: string }>
    }

    expect(blockers.fullWebProfile).toBe('BLOCKED')
    expect(blockers.standaloneSdkMinimal).toBe('BLOCKED')

    const byId = new Map((blockers.blockers ?? []).map((item) => [item.id, item.severity]))
    expect(byId.get('subprocess-local')).toBe('HARD')
    expect(byId.get('attachment-local')).toBe('HARD')
    expect(byId.get('sandbox-local')).toBe('HARD')
    expect(byId.get('fs-search')).toBe('FEATURE_BLOCKER')
  })

  it('pins the manual carrier probe to exact Node 22.19.0 and a real Android execution check', () => {
    const probe = readFileSync(resolve(ROOT, 'scripts/android-node22-probe.sh'), 'utf8')
    expect(probe).toContain('NODE_VERSION="22.19.0"')
    expect(probe).toContain('ANDROID_API="${ANDROID_API:-26}"')
    expect(probe).toContain('process.versions.node')
    expect(probe).toContain('process.platform !== "android"')
    expect(probe).toContain('adb')
    expect(probe).not.toMatch(/curl\s|wget\s/u)
  })
})
