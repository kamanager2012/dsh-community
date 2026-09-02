import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('frozen upstream candidate target', () => {
  it('advances explicitly from accepted alpha.3 to frozen alpha.4 with measured source evidence', () => {
    const watch = JSON.parse(
      readFileSync(
        join(repoRoot, 'contracts/compatibility/upstream-candidate-watch.json'),
        'utf8',
      ),
    ) as {
      schemaVersion: number
      previousAccepted: {
        package: string
        version: string
        upstreamReleaseCommit: string
        upstreamMergeCommit: string
        releasedAt: string
        acceptedCommunityMain: string
        disposition: string
      }
      frozenTarget: {
        package: string
        version: string
        upstreamReleaseCommit: string
        upstreamMergeCommit: string
        releasedAt: string
        registryGate: {
          status: string
          command: string
          runId: number
        }
        comparisonFromPrevious: {
          commitsBetweenReleaseMerges: number
          changedFiles: number
          readinessImplementation: {
            previousBlob: string
            targetBlob: string
            verdict: string
          }
          cliArgsImplementation: {
            previousBlob: string
            targetBlob: string
            verdict: string
          }
          cliReference: {
            previousBlob: string
            targetBlob: string
            verdict: string
          }
        }
      }
      policy: {
        candidateAdvancement: string
        rule: string
      }
    }

    expect(watch.schemaVersion).toBe(2)
    expect(watch.previousAccepted.package).toBe('@deepseek-ai/dsh')
    expect(watch.previousAccepted.version).toBe('0.1.2-alpha.3')
    expect(watch.previousAccepted.disposition).toBe('PREVIOUS_ACCEPTED_BASELINE')
    expect(watch.previousAccepted.acceptedCommunityMain)
      .toBe('4e30f8198b50a3ce88ff66fb39e848f3f05ade58')

    expect(watch.frozenTarget.package).toBe('@deepseek-ai/dsh')
    expect(watch.frozenTarget.version).toBe('0.1.2-alpha.4')
    expect(watch.frozenTarget.registryGate.status).toBe('PASS')
    expect(watch.frozenTarget.registryGate.command)
      .toBe('npm view @deepseek-ai/dsh@0.1.2-alpha.4 version')
    expect(watch.frozenTarget.registryGate.runId).toBe(33574740829)
    expect(watch.policy.candidateAdvancement).toBe('EXPLICIT_ONLY')

    for (const sha of [
      watch.previousAccepted.upstreamReleaseCommit,
      watch.previousAccepted.upstreamMergeCommit,
      watch.previousAccepted.acceptedCommunityMain,
      watch.frozenTarget.upstreamReleaseCommit,
      watch.frozenTarget.upstreamMergeCommit,
    ]) {
      expect(sha).toMatch(/^[0-9a-f]{40}$/u)
    }

    expect(Date.parse(watch.frozenTarget.releasedAt)).toBeGreaterThan(
      Date.parse(watch.previousAccepted.releasedAt),
    )

    const comparison = watch.frozenTarget.comparisonFromPrevious
    expect(comparison.commitsBetweenReleaseMerges).toBe(297)
    expect(comparison.changedFiles).toBe(300)

    expect(comparison.readinessImplementation.verdict).toBe('IDENTICAL')
    expect(comparison.readinessImplementation.previousBlob)
      .toBe(comparison.readinessImplementation.targetBlob)

    expect(comparison.cliArgsImplementation.verdict).toBe('IDENTICAL')
    expect(comparison.cliArgsImplementation.previousBlob)
      .toBe(comparison.cliArgsImplementation.targetBlob)

    expect(comparison.cliReference.verdict).toBe('CHANGED')
    expect(comparison.cliReference.previousBlob)
      .not.toBe(comparison.cliReference.targetBlob)
  })
})
