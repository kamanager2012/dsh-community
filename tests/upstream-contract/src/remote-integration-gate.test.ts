import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('remote integration gate', () => {
  it('keeps upgrade-branch push free of Actions and blocks PR fan-out until final acceptance', () => {
    const gate = JSON.parse(
      read('contracts/compatibility/remote-integration-gate.json'),
    ) as {
      safeRemoteOperation: { operation: string; actionsExpected: number }
      blockedUntilFinalAcceptance: { workflows: string[] }
      manualOnly: string[]
      releaseOnly: string[]
      nextRequiredRemoteInput: { localAcceptedCommit: string }
    }

    expect(gate.safeRemoteOperation.operation).toBe('push-to-non-main-branch')
    expect(gate.safeRemoteOperation.actionsExpected).toBe(0)
    expect(gate.nextRequiredRemoteInput.localAcceptedCommit).toMatch(/^[0-9a-f]{40}$/u)

    const workflowFiles = new Map([
      ['ci', '.github/workflows/ci.yml'],
      ['dependency-audit', '.github/workflows/dependency-audit.yml'],
      ['linux-macos-package-smoke', '.github/workflows/linux-macos-package-smoke.yml'],
      ['windows-package-smoke', '.github/workflows/windows-package-smoke.yml'],
      ['runtime-lock-verify', '.github/workflows/runtime-lock-verify.yml'],
      ['runtime-sbom-smoke', '.github/workflows/runtime-sbom-smoke.yml'],
      ['artifact-action-smoke', '.github/workflows/artifact-action-smoke.yml'],
    ])

    for (const name of gate.blockedUntilFinalAcceptance.workflows) {
      const path = workflowFiles.get(name)
      expect(path, name).toBeDefined()
      expect(read(path!), path).toMatch(/\bpull_request:/u)
    }

    expect(read('.github/workflows/ci.yml')).toMatch(/push:\s*\n\s*branches: \[main, master\]/u)
    expect(read('.github/workflows/release.yml')).toMatch(/push:\s*\n\s*tags: \['v\*'\]/u)
    expect(read('.github/workflows/user-loop-evidence.yml')).not.toMatch(/\bpull_request:/u)
  })
})
