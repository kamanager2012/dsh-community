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
      components?: Array<{
        id?: string
        version?: string
        status?: string
        upstreamCommit?: string
        sourceMutationAllowed?: boolean
      }>
      semanticBlockers?: Array<{ id?: string; status?: string; severity?: string }>
    }

    expect(state.officialDsh).toBe('0.1.2-alpha.4')
    expect(state.nativeProbe).toBe('scripts/android-native-addon-probe.sh')

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
    expect(components.get('sharp')?.status).toBe('WASM_FALLBACK_PROBE_REQUIRED')
    expect(components.get('ripgrep')?.status).toBe('ANDROID_BINARY_PACKAGING_REQUIRED')

    const blockers = new Map((state.semanticBlockers ?? []).map(item => [item.id, item]))
    expect(blockers.get('subprocess-terminal-inspector')).toMatchObject({
      status: 'UPSTREAM_OR_ADAPTER_REQUIRED',
      severity: 'HARD',
    })
    expect(blockers.get('sandbox-platform-chain')).toMatchObject({
      status: 'ANDROID_RUNNER_OR_UPSTREAM_REQUIRED',
      severity: 'HARD',
    })
    expect(blockers.get('posix-hardlink-publication')).toMatchObject({
      status: 'APP_PRIVATE_FS_PROBE_REQUIRED',
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
    expect(probe).toContain('EXPECTED_NODE_COMMIT="f8fe6858549f75a4b4e9633abf39dd2038dbf496"')
    expect(probe).toContain('npm rebuild node-pty --build-from-source')
    expect(probe).toContain('android.toolchain.cmake')
    expect(probe).toContain('KOFFI_DEVICE_OK')
    expect(probe).toContain('NODE_PTY_DEVICE_OK')
    expect(probe).toContain('Node Android carrier has not been built')

    expect(probe).not.toMatch(/\bcurl\b|\bwget\b/u)
    expect(probe).not.toMatch(/^\s*(?:git\s+apply|patch\s|sed\s+-i)/mu)
  })
})
