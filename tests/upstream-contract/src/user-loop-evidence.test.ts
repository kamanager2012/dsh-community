import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflowPath = join(repoRoot, '.github/workflows/user-loop-evidence.yml')
const currentReleasePath = join(repoRoot, 'docs/current-release.json')

describe('real user-loop evidence workflow', () => {
  it('is manual-only because it consumes a real model credential', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s*schedule:/mu)
    expect(workflow).not.toMatch(/^\s*push:/mu)
    expect(workflow).not.toMatch(/^\s*pull_request:/mu)
    expect(workflow).toContain('DEEPSEEK_API_KEY')
    expect(workflow).toContain('This workflow never falls back to a mock')
  })

  it('keeps repository and model credentials out of install/build steps', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    const jobHeader = workflow.slice(
      workflow.indexOf('  linux-terminal:'),
      workflow.indexOf('    steps:'),
    )
    expect(jobHeader).toContain("if: ${{ github.ref == 'refs/heads/main' }}")
    expect(jobHeader).not.toContain('\n    env:')

    expect(workflow.match(/secrets\.DEEPSEEK_API_KEY/gu)?.length).toBe(2)
    expect(workflow.match(/github\.token/gu)?.length).toBe(1)

    const untrustedBuildWindow = workflow.slice(
      workflow.indexOf('      - name: Checkout evidence runner'),
      workflow.indexOf('      - name: Run real new -> answer -> resume -> answer loop'),
    )
    expect(untrustedBuildWindow).not.toContain('DEEPSEEK_API_KEY')
    expect(untrustedBuildWindow).not.toContain('GH_TOKEN')
  })

  it('records the exact Git commit that was actually tested', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('git -C release-src rev-parse HEAD')
    expect(workflow).toContain('EVIDENCE_COMMIT: ${{ steps.identity.outputs.commit }}')
    expect(workflow).toContain('--commit "$EVIDENCE_COMMIT"')
    expect(workflow).toContain('steps.identity.outputs.commit')

    const runner = readFileSync(
      join(repoRoot, 'scripts/e2e/user-loop.py'),
      'utf8',
    )
    expect(runner).toContain('parser.add_argument("--commit"')
    expect(runner).toContain('"releaseCommit": args.commit')
    expect(runner).toContain('full lowercase 40-character Git SHA')
  })
  it('tests an immutable release checkout without replacing the evidence runner', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('path: release-src')
    expect(workflow).toContain('release-src/apps/tui/dist/bin.js')
    expect(workflow).toContain('scripts/e2e/user-loop.py')
    expect(workflow).toContain('permissions:\n  contents: read')
  })

  it('records verified exact-release user-loop PASS evidence in current-release.json', () => {
    const facts = JSON.parse(readFileSync(currentReleasePath, 'utf8')) as {
      evidence?: {
        userLoop?: {
          status?: string
          workflow?: string
          note?: string
        }
      }
    }
    expect(facts.evidence?.userLoop?.status).toBe('PASS')
    expect(facts.evidence?.userLoop?.workflow).toBe('.github/workflows/user-loop-evidence.yml')
    expect(facts.evidence?.userLoop?.note).toMatch(/actions\/runs\/\d+/)
  })

  it('verifies two-way cross-surface session handoff between dsh-community TUI, official dsh headless, AppImage runtime/GUI, and full lifecycle recovery', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('Download and extract published Linux AppImage runtime archive')
    expect(workflow).toContain('--appimage-archive "$APPIMAGE_ARCHIVE"')
    expect(workflow).toContain('--appimage-apprun "$APPIMAGE_APPRUN"')
    expect(workflow).toContain('xvfb-run')

    const runner = readFileSync(
      join(repoRoot, 'scripts/e2e/user-loop.py'),
      'utf8',
    )
    expect(runner).toContain('def run_official_headless_turn(')
    expect(runner).toContain('def verify_missing_key_refusal_and_recovery(')
    expect(runner).toContain('def verify_interrupted_extract_recovery(')
    expect(runner).toContain('def verify_version_upgrade_recovery(')
    expect(runner).toContain('def verify_offline_handling(')
    expect(runner).toContain('def verify_appimage_gui_session_and_lifecycle(')
    expect(runner).toContain('ensureOfficialHostExtracted')
    expect(runner).toContain('apps/desktop/src/host-extract.ts#ensureOfficialHostExtracted')
    expect(runner).toContain('"--appimage-archive"')
    expect(runner).toContain('"--appimage-apprun"')
    expect(runner).toContain('"--profile", "headless"')
    expect(runner).toContain('"--session-id", session_id')
    expect(runner).toContain('"officialHeadlessHandoff": third')
    expect(runner).toContain('"appimageBundledRuntimeHandoff"')
    expect(runner).toContain('"linux-appimage-electron-gui"')
    expect(runner).toContain('desktopSnapshotAndRenderVerified')
    expect(runner).toContain('button[data-go="marketplace"]')
    expect(runner).toContain('在线抓取失败，展示最近一次缓存。')
    expect(runner).toContain('turns["resumeAfterOfficialHandoff"] = fourth')
    expect(runner).toContain('"crossSurfaceVerified": True')
    expect(runner).toContain('"lifecycleRecovery": lifecycle_recovery')
  })

  it('executes real upgrade recovery and offline catalog fallback verification against repository modules', () => {
    const script = [
      'import importlib.util, json',
      'spec = importlib.util.spec_from_file_location("user_loop", "scripts/e2e/user-loop.py")',
      'mod = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(mod)',
      'upgrade = mod.verify_version_upgrade_recovery()',
      'offline = mod.verify_offline_handling()',
      'print(json.dumps({"upgrade": upgrade, "offline": offline}))',
    ].join('\n')
    const result = spawnSync('python3', ['-B', '-c', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(result.status, result.stderr || result.stdout).toBe(0)
    const parsed = JSON.parse(result.stdout.trim()) as {
      upgrade: {
        fromVersion: string
        toVersion: string
        priorInstallRecommendation: string
        postUpgradeRecommendation: string
        tuiProfileUpgradedInPlace: boolean
        existingSessionsPreserved: boolean
      }
      offline: {
        tuiOfflineFailClosed: boolean
        marketplaceClientCacheFallback: boolean
        marketplaceCliCacheFallback: boolean
        desktopSnapshotAndRenderVerified: boolean
        cachedPluginCount: number
      }
    }
    expect(parsed.upgrade.fromVersion).toBe('0.2.2-rc.2')
    expect(parsed.upgrade.toVersion).toBeTruthy()
    expect(parsed.upgrade.priorInstallRecommendation).toBe('offer-tested')
    expect(parsed.upgrade.postUpgradeRecommendation).toBe('stay')
    expect(parsed.upgrade.tuiProfileUpgradedInPlace).toBe(true)
    expect(parsed.upgrade.existingSessionsPreserved).toBe(true)

    expect(parsed.offline.tuiOfflineFailClosed).toBe(true)
    expect(parsed.offline.marketplaceClientCacheFallback).toBe(true)
    expect(parsed.offline.marketplaceCliCacheFallback).toBe(true)
    expect(parsed.offline.desktopSnapshotAndRenderVerified).toBe(true)
    expect(parsed.offline.cachedPluginCount).toBeGreaterThanOrEqual(9)
  })
})
