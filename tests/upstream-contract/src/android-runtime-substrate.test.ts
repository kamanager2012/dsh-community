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
      nativeCompatibility?: string
      nativeAddonProbe?: string
      sandboxProbe?: string
      androidCompositionPatch?: string
      appUidPreflight?: string
      ptyProvider?: string
      packageClosure?: {
        status?: string
        audit?: string
        profileOnlyMitigation?: string
      }
      candidate?: {
        id?: string
        status?: string
        upstreamPlatformSupport?: string
        androidApi?: number
        architectures?: string[]
        manualProbe?: string
        sourceTag?: string
        tagObjectSha?: string
        sourceCommit?: string
        tagSignatureVerifiedByGitHub?: boolean
      }
    }

    expect(state.status).toBe('BLOCKED')
    expect(state.nativeCompatibility).toBe('apps/android/native-compatibility.json')
    expect(state.nativeAddonProbe).toBe('scripts/android-native-addon-probe.sh')
    expect(state.sandboxProbe).toBe('scripts/android-sandbox-landlock-probe.sh')
    expect(state.androidCompositionPatch).toBe('apps/android/nodejs-project/src/main/js/android.cordis.patch.yml')
    expect(state.appUidPreflight).toBe('apps/android/nodejs-project/src/main/js/android-app-uid-preflight.cjs')
    expect(state.ptyProvider).toBe('apps/android/nodejs-project/src/main/js/android-subprocess-provider.mjs')
    expect(state.packageClosure?.status).toBe('BLOCKED')
    expect(state.packageClosure?.audit).toBe('scripts/audit-android-official-cli-closure.mjs')
    expect(state.packageClosure?.profileOnlyMitigation).toBe('INEFFECTIVE')
    expect(state.candidate?.id).toBe('official-node-v22.19.0-android-crossbuild')
    expect(state.candidate?.status).toBe('PROBE_REQUIRED')
    expect(state.candidate?.upstreamPlatformSupport).toBe('UNSUPPORTED')
    expect(state.candidate?.androidApi).toBe(26)
    expect(state.candidate?.architectures).toEqual(['arm64', 'x86_64'])
    expect(state.candidate?.manualProbe).toBe('scripts/android-node22-probe.sh')
    expect(state.candidate?.sourceTag).toBe('v22.19.0')
    expect(state.candidate?.tagObjectSha).toBe('a9d4750074c7b5439c61daa28ea9afb5dc28e43e')
    expect(state.candidate?.sourceCommit).toBe('f8fe6858549f75a4b4e9633abf39dd2038dbf496')
    expect(state.candidate?.tagSignatureVerifiedByGitHub).toBe(true)
  })

  it('tracks the second-layer native DSH closure explicitly', () => {
    const blockers = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/native-blockers.json'), 'utf8'),
    ) as {
      fullWebProfile?: string
      standaloneSdkMinimal?: string
      blockers?: Array<{ id?: string; severity?: string; status?: string }>
    }

    expect(blockers.fullWebProfile).toBe('BLOCKED')
    expect(blockers.standaloneSdkMinimal).toBe('BLOCKED')

    const byId = new Map((blockers.blockers ?? []).map((item) => [item.id, item]))
    expect(byId.get('subprocess-local')?.severity).toBe('HARD')
    expect(byId.get('attachment-local')?.severity).toBe('HARD')
    expect(byId.get('sandbox-local')?.severity).toBe('HARD')
    expect(byId.get('fs-search')?.severity).toBe('FEATURE_BLOCKER')
    for (const blocker of blockers.blockers ?? []) expect(blocker.status).toBe('OPEN')
  })

  it('pins the manual carrier probe to exact Node 22.19.0 and a real Android execution check', () => {
    const probe = readFileSync(resolve(ROOT, 'scripts/android-node22-probe.sh'), 'utf8')
    expect(probe).toContain('NODE_VERSION="22.19.0"')
    expect(probe).toContain('NODE_TAG_OBJECT="a9d4750074c7b5439c61daa28ea9afb5dc28e43e"')
    expect(probe).toContain('NODE_SOURCE_COMMIT="f8fe6858549f75a4b4e9633abf39dd2038dbf496"')
    expect(probe).toContain('rev-parse "refs/tags/$NODE_SOURCE_TAG"')
    expect(probe).toContain('rev-parse HEAD')
    expect(probe).toContain('ANDROID_API="${ANDROID_API:-26}"')
    expect(probe).toContain('process.versions.node')
    expect(probe).toContain('process.platform !== "android"')
    expect(probe).toContain('adb')
    expect(probe).not.toMatch(/curl\s|wget\s/u)
  })
})
