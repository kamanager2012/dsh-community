import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')

describe('Android runtime substrate evidence', () => {
  it('keeps Node 22 cross-build as a candidate, not a promoted runtime', () => {
    const state = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/runtime-substrate.json'), 'utf8'),
    ) as {
      status?: string
      carrierPackaging?: string
      nativeCompatibility?: string
      nativeAddonProbe?: string
      sandboxProbe?: string
      androidCompositionPatch?: string
      appUidPreflight?: string
      evidenceBackingValidator?: string
      evidenceRecordCreator?: string
      evidenceRecords?: string
      ptyProvider?: string
      ptyProviderProbe?: string
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
        shellProbe?: { script?: string; status?: string; releaseEvidence?: boolean }
        apkEmbedded?: {
          buildScript?: string
          status?: string
          buildMode?: string
          runtimeLoadMode?: string
          releaseEvidence?: boolean
        }
      }
    }

    expect(state.status).toBe('BLOCKED')
    expect(state.carrierPackaging).toBe('apps/android/carrier-packaging.json')
    expect(state.nativeCompatibility).toBe('apps/android/native-compatibility.json')
    expect(state.nativeAddonProbe).toBe('scripts/android-native-addon-probe.sh')
    expect(state.sandboxProbe).toBe('scripts/android-sandbox-landlock-probe.sh')
    expect(state.androidCompositionPatch).toBe('apps/android/nodejs-project/src/main/js/android.cordis.patch.yml')
    expect(state.appUidPreflight).toBe('apps/android/nodejs-project/src/main/js/android-app-uid-preflight.cjs')
    expect(state.evidenceBackingValidator).toBe('scripts/validate-android-evidence-backing.mjs')
    expect(state.evidenceRecordCreator).toBe('scripts/create-android-evidence-record.mjs')
    expect(state.evidenceRecords).toBe('apps/android/evidence/records')
    expect(state.ptyProvider).toBe('apps/android/nodejs-project/src/main/js/android-subprocess-provider.mjs')
    expect(state.ptyProviderProbe).toBe('apps/android/nodejs-project/src/main/js/android-pty-provider-device-probe.mjs')
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
    expect(state.candidate?.shellProbe).toEqual({
      script: 'scripts/android-node22-probe.sh',
      status: 'PROBE_REQUIRED',
      releaseEvidence: false,
    })
    expect(state.candidate?.apkEmbedded).toEqual({
      buildScript: 'scripts/android-node22-apk-carrier-probe.sh',
      status: 'SHARED_BUILD_AND_JNI_APP_UID_PROBE_REQUIRED',
      buildMode: 'OFFICIAL_NODE_SHARED',
      runtimeLoadMode: 'JNI_EMBEDDER',
      releaseEvidence: true,
    })
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

  it('pins the adb-shell carrier probe to exact Node 22.19.0 as preliminary evidence only', () => {
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

  it('separates the APK shared carrier from the adb-shell executable probe', () => {
    const contract = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/carrier-packaging.json'), 'utf8'),
    ) as {
      shellProbe?: { releaseEvidence?: boolean; artifact?: string }
      apkEmbedded?: {
        status?: string
        buildScript?: string
        buildMode?: string
        artifact?: string
        packagingSurface?: string
        runtimeLoadMode?: string
        executionContext?: string
        releaseEvidence?: boolean
      }
      wxBoundary?: { executableFromWritableAppHome?: string }
    }
    const probePath = resolve(ROOT, 'scripts/android-node22-apk-carrier-probe.sh')
    const syntax = spawnSync('bash', ['-n', probePath], { cwd: ROOT, encoding: 'utf8' })
    expect(syntax.status).toBe(0)
    expect(syntax.stderr).toBe('')
    const probe = readFileSync(probePath, 'utf8')

    expect(contract.shellProbe).toMatchObject({
      artifact: 'out/Release/node',
      releaseEvidence: false,
    })
    expect(contract.apkEmbedded).toMatchObject({
      status: 'SHARED_BUILD_AND_JNI_APP_UID_PROBE_REQUIRED',
      buildScript: 'scripts/android-node22-apk-carrier-probe.sh',
      buildMode: 'OFFICIAL_NODE_SHARED',
      artifact: 'out/Release/lib.target/libnode.so',
      packagingSurface: 'APK_NATIVE_LIBRARY',
      runtimeLoadMode: 'JNI_EMBEDDER',
      executionContext: 'APK_APP_UID',
      releaseEvidence: true,
    })
    expect(contract.wxBoundary?.executableFromWritableAppHome).toBe('FORBIDDEN')
    expect(probe).toContain('NODE_SOURCE_COMMIT="f8fe6858549f75a4b4e9633abf39dd2038dbf496"')
    expect(probe).toContain('--shared')
    expect(probe).toContain('lib.target/libnode.so')
    expect(probe).toContain('APK_SHARED_BUILD_OK')
    expect(probe).toContain('NEXT_REQUIRED=APK_JNI_APP_UID_LOAD')
    expect(probe).toContain('shared-carrier probe requires a fresh Node checkout/build tree')
    expect(probe).not.toMatch(/\bcurl\b|\bwget\b/u)
    expect(probe).not.toMatch(/^\s*(?:git\s+apply|patch\s|sed\s+-i)/mu)
  })
})
