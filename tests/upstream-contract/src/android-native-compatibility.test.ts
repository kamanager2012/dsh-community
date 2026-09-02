import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')

describe('Android G2 native compatibility', () => {
  it('keeps native addon candidates separate from unresolved runtime semantics', () => {
    const state = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/native-compatibility.json'), 'utf8'),
    ) as {
      officialDsh?: string
      nativeProbe?: string
      portableDependencyAudit?: string
      sandboxProbe?: string
      androidCompositionPatch?: string
      appUidPreflight?: string
      ripgrepSeamAudit?: string
      providerSeams?: {
        subprocess?: { status?: string; terminalInspectorHook?: string; shippedPresetExposure?: string[] }
        fsSearch?: {
          status?: string
          searchCoreGitBlob?: string
          resolverSignature?: string
          communityAdapterDecision?: string
          allowedUnlockConditions?: string[]
        }
        sandbox?: {
          status?: string
          providerModule?: string
          officialLauncherVersion?: string
          enforcementRequirement?: string
          sourceMutationAllowed?: boolean
          appUidPreflight?: string
          appUidEvidence?: string
        }
      }
      components?: Array<{
        id?: string
        version?: string
        status?: string
        upstreamCommit?: string
        sourceMutationAllowed?: boolean
        fallback?: { package?: string; version?: string; emnapiVersion?: string }
        upstreamBinaryProvenance?: {
          microsoftPrebuiltTag?: string
          microsoftCommit?: string
          microsoftPatchBlobSha?: string
          upstreamRipgrepTag?: string
          upstreamCommit?: string
          upstreamTagVerified?: boolean
        }
      }>
      semanticBlockers?: Array<{ id?: string; status?: string; severity?: string }>
    }

    expect(state.officialDsh).toBe('0.1.2-alpha.4')
    expect(state.nativeProbe).toBe('scripts/android-native-addon-probe.sh')
    expect(state.portableDependencyAudit).toBe('scripts/audit-android-portable-deps.mjs')
    expect(state.sandboxProbe).toBe('scripts/android-sandbox-landlock-probe.sh')
    expect(state.androidCompositionPatch).toBe('apps/android/nodejs-project/src/main/js/android.cordis.patch.yml')
    expect(state.appUidPreflight).toBe('apps/android/nodejs-project/src/main/js/android-app-uid-preflight.cjs')
    expect(state.ripgrepSeamAudit).toBe('scripts/audit-android-ripgrep-seam.mjs')
    expect(state.providerSeams?.subprocess).toMatchObject({
      status: 'PUBLIC_PROVIDER_SEAM_AVAILABLE_PTY_ANDROID_PROVIDER_STILL_REQUIRED',
      terminalInspectorHook: 'TEST_ONLY_NOT_ACCEPTED_FOR_PRODUCTION',
      shippedPresetExposure: ['standard', 'minimal', 'ptc', 'cordis'],
    })
    expect(state.providerSeams?.fsSearch).toMatchObject({
      status: 'NO_EXPLICIT_RG_PATH_SEAM_ALPHA4',
      searchCoreGitBlob: '60ea042d4f31f0e9c856536b8b34e2687482eec7',
      resolverSignature: 'resolveRgPath()',
      communityAdapterDecision: 'REJECTED_TO_PRESERVE_OFFICIAL_TOOL_AUTHORITY',
      allowedUnlockConditions: [
        'upstream Android @vscode/ripgrep platform package',
        'explicit official tool-fs-search executable-path seam',
      ],
    })
    expect(state.providerSeams?.sandbox).toMatchObject({
      status: 'COMMUNITY_PROVIDER_WIRED_NDK_AND_APP_UID_PROBE_REQUIRED',
      providerModule: 'apps/android/nodejs-project/src/main/js/android-sandbox-provider.mjs',
      officialLauncherVersion: '0.1.1',
      enforcementRequirement: 'full',
      sourceMutationAllowed: false,
      appUidPreflight: 'apps/android/nodejs-project/src/main/js/android-app-uid-preflight.cjs',
      appUidEvidence: 'NOT_RUN',
    })

    const components = new Map((state.components ?? []).map(item => [item.id, item]))
    expect(components.get('node-pty')).toMatchObject({
      version: '1.2.0-beta.15',
      upstreamCommit: '8f218f6c194be81d98b1eeea344b150e83445824',
      status: 'CROSS_BUILD_PROBE_REQUIRED',
      sourceMutationAllowed: false,
    })
    expect(components.get('koffi')).toMatchObject({
      version: '3.1.6',
      status: 'CROSS_BUILD_PROBE_REQUIRED',
      sourceMutationAllowed: false,
    })
    expect(components.get('sharp')).toMatchObject({
      version: '0.35.4',
      status: 'LOCKED_WASM_FALLBACK_MATERIALIZATION_AND_DEVICE_PROBE_REQUIRED',
      fallback: {
        package: '@img/sharp-wasm32',
        version: '0.35.4',
        emnapiVersion: '1.11.3',
      },
    })
    expect(components.get('ripgrep')).toMatchObject({
      version: '1.18.0',
      status: 'UPSTREAM_PATH_SEAM_OR_ANDROID_PACKAGE_REQUIRED',
      upstreamBinaryProvenance: {
        microsoftPrebuiltTag: 'v15.0.1',
        microsoftCommit: '67202aaafb17aecd9b5b7046d5b7baa92b05237a',
        microsoftPatchBlobSha: 'd7afb314f6171c129c33140de5feeb73f1a161d8',
        upstreamRipgrepTag: '15.0.0',
        upstreamCommit: '3a612f88b805e14aef45bfa43e25a54abc6297fc',
        upstreamTagVerified: true,
      },
    })

    const blockers = new Map((state.semanticBlockers ?? []).map(item => [item.id, item]))
    expect(blockers.get('subprocess-terminal-inspector')).toMatchObject({
      status: 'PUBLIC_PROVIDER_OR_UPSTREAM_ANDROID_PTY_REQUIRED',
      severity: 'HARD',
    })
    expect(blockers.get('sandbox-platform-chain')).toMatchObject({
      status: 'COMMUNITY_PROVIDER_WIRED_NDK_AND_APP_UID_PROBE_REQUIRED',
      severity: 'HARD',
    })
    expect(blockers.get('posix-hardlink-publication')).toMatchObject({
      status: 'APP_UID_PREFLIGHT_WIRED_REAL_DEVICE_REQUIRED',
      severity: 'HARD',
    })
  })

  it('keeps the manual addon probe syntactically valid, network-free, and patch-free', () => {
    const probePath = resolve(ROOT, 'scripts/android-native-addon-probe.sh')
    const syntax = spawnSync('bash', ['-n', probePath], { cwd: ROOT, encoding: 'utf8' })
    expect(syntax.status).toBe(0)
    expect(syntax.stderr).toBe('')

    const probe = readFileSync(probePath, 'utf8')

    expect(probe).toContain('EXPECTED_DSH="0.1.2-alpha.4"')
    expect(probe).toContain('EXPECTED_NODE_PTY="1.2.0-beta.15"')
    expect(probe).toContain('EXPECTED_KOFFI="3.1.6"')
    expect(probe).toContain('EXPECTED_SHARP_WASM="0.35.4"')
    expect(probe).toContain('EXPECTED_EMNAPI="1.11.3"')
    expect(probe).toContain('EXPECTED_NODE_COMMIT="f8fe6858549f75a4b4e9633abf39dd2038dbf496"')
    expect(probe).toContain('npm rebuild node-pty --build-from-source')
    expect(probe).toContain('android.toolchain.cmake')
    expect(probe).toContain('KOFFI_DEVICE_OK')
    expect(probe).toContain('NODE_PTY_DEVICE_OK')
    expect(probe).toContain('SHARP_WASM_DEVICE_OK')
    expect(probe).toContain('sharp WASM materialization gap')
    expect(probe).toContain('Node Android carrier has not been built')

    expect(probe).not.toMatch(/\bcurl\b|\bwget\b/u)
    expect(probe).not.toMatch(/^\s*(?:git\s+apply|patch\s|sed\s+-i)/mu)
  })

  it('audits portable dependency provenance from the frozen runtime lock without network access', () => {
    const auditPath = resolve(ROOT, 'scripts/audit-android-portable-deps.mjs')
    const result = spawnSync(process.execPath, [auditPath], { cwd: ROOT, encoding: 'utf8' })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')

    const audit = JSON.parse(result.stdout) as {
      sourceLock?: string
      sharp?: {
        version?: string
        status?: string
        wasmPackage?: { name?: string; version?: string; optionalInLock?: boolean }
        emnapi?: { version?: string }
      }
      sandbox?: {
        status?: string
        package?: { name?: string; version?: string; integrity?: string }
        sourcePathInPackage?: string
      }
      ripgrep?: {
        wrapperVersion?: string
        status?: string
        androidPackagesPresent?: string[]
        wrapperResolutionContract?: string
        upstreamBinaryProvenance?: {
          microsoftPrebuiltTag?: string
          microsoftPatchBlobSha?: string
          upstreamRipgrepTag?: string
          upstreamCommit?: string
          upstreamTagVerified?: boolean
        }
        forbiddenShortcuts?: string[]
        seamAudit?: string
        officialSearchCoreGitBlob?: string
      }
    }

    expect(audit.sourceLock).toBe('apps/desktop/runtime-lock/package-lock.json')
    expect(audit.sharp).toMatchObject({
      version: '0.35.4',
      status: 'LOCKED_WASM_FALLBACK_MATERIALIZATION_AND_DEVICE_PROBE_REQUIRED',
      wasmPackage: {
        name: '@img/sharp-wasm32',
        version: '0.35.4',
        optionalInLock: true,
      },
      emnapi: { version: '1.11.3' },
    })
    expect(audit.sandbox).toMatchObject({
      status: 'OFFICIAL_LANDLOCK_SOURCE_NDK_AND_APP_UID_PROBE_REQUIRED',
      package: {
        name: '@deepseek-ai/node-addon-landlock-run',
        version: '0.1.1',
        integrity: 'sha512-aHGhlQJEutfobKM/4K59SERbT7RmQdD2oMKzD8Bne/Ps7TeT8AweCN+dpdfuxQhMNbFcJMymrgPnID0WYQ30Tw==',
      },
      sourcePathInPackage: 'src/main.c',
    })
    expect(audit.ripgrep).toMatchObject({
      wrapperVersion: '1.18.0',
      status: 'UPSTREAM_PATH_SEAM_OR_ANDROID_PACKAGE_REQUIRED',
      androidPackagesPresent: [],
      seamAudit: 'scripts/audit-android-ripgrep-seam.mjs',
      officialSearchCoreGitBlob: '60ea042d4f31f0e9c856536b8b34e2687482eec7',
      wrapperResolutionContract: '@vscode/ripgrep-${process.platform}-${arch}',
      upstreamBinaryProvenance: {
        microsoftPrebuiltTag: 'v15.0.1',
        microsoftPatchBlobSha: 'd7afb314f6171c129c33140de5feeb73f1a161d8',
        upstreamRipgrepTag: '15.0.0',
        upstreamCommit: '3a612f88b805e14aef45bfa43e25a54abc6297fc',
        upstreamTagVerified: true,
      },
    })
    expect(audit.ripgrep?.forbiddenShortcuts).toContain('publish a fake package under the @vscode scope')
    expect(audit.ripgrep?.forbiddenShortcuts).toContain('spoof process.pkg to force the single-file sidecar path')
    expect(audit.ripgrep?.forbiddenShortcuts).toContain(
      'copy/fork official glob/grep implementation solely to replace binary resolution',
    )
  })

})
