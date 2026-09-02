import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('remote integration gate', () => {
  it('keeps alpha.4 branch staging cheap and blocks PR fan-out until final acceptance', () => {
    const gate = JSON.parse(
      read('contracts/compatibility/remote-integration-gate.json'),
    ) as {
      schemaVersion: number
      safeRemoteOperation: { operation: string; actionsExpected: number }
      blockedUntilFinalAcceptance: { workflows: string[] }
      manualOnly: string[]
      releaseOnly: string[]
      acceptedBaseline: {
        commit: string
        branch: string
        origin: string
        registryGateRunId: number
        lockContractGeneratorRunId: number
      }
      finalAcceptance: {
        status: string
        version: string
        runId: number
        jobId: number
        runHeadCommit: string
        runtimeDshEntries: number
        providerCalls: number
      }
    }

    expect(gate.schemaVersion).toBe(3)
    expect(gate.safeRemoteOperation.operation).toBe('push-to-non-main-branch')
    expect(gate.safeRemoteOperation.actionsExpected).toBe(0)
    expect(gate.acceptedBaseline.commit)
      .toBe('a8e61282858dbd7a9f0d521fe85c3c119a2a0f1d')
    expect(gate.acceptedBaseline.branch).toBe('upgrade/dsh-0.1.2-alpha.4')
    expect(gate.acceptedBaseline.origin).toBe('remote-generated-baseline')
    expect(gate.acceptedBaseline.registryGateRunId).toBe(33574740829)
    expect(gate.acceptedBaseline.lockContractGeneratorRunId).toBe(33575142240)
    expect(gate.finalAcceptance.status).toBe('PASS')
    expect(gate.finalAcceptance.version).toBe('0.1.2-alpha.4')
    expect(gate.finalAcceptance.runId).toBe(33576016696)
    expect(gate.finalAcceptance.jobId).toBe(100080034357)
    expect(gate.finalAcceptance.runHeadCommit)
      .toBe('6babf377b22426a1d29d0bbe27c82f62bb2a88dc')
    expect(gate.finalAcceptance.runtimeDshEntries).toBe(214)
    expect(gate.finalAcceptance.providerCalls).toBe(0)

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

    expect(read('.github/workflows/ci.yml'))
      .toMatch(/push:\s*\n\s*branches: \[main, master\]/u)
    expect(read('.github/workflows/release.yml'))
      .toMatch(/push:\s*\n\s*tags: \['v\*'\]/u)
    expect(read('.github/workflows/user-loop-evidence.yml'))
      .not.toMatch(/\bpull_request:/u)
  })
})
