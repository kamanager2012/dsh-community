import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('frozen upstream candidate target', () => {
  it('advances explicitly from accepted 0.2.2-rc.1 to frozen 0.2.2-rc.2 with measured source evidence', () => {
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
    expect(watch.previousAccepted.version).toBe('0.2.2-rc.1')
    expect(watch.previousAccepted.disposition).toBe('PREVIOUS_ACCEPTED_BASELINE')
    expect(watch.previousAccepted.acceptedCommunityMain)
      .toBe('d66c3f0fd9c936d7aaad3da6b31181f410bd922e')

    expect(watch.frozenTarget.package).toBe('@deepseek-ai/dsh')
    expect(watch.frozenTarget.version).toBe('0.2.2-rc.2')
    expect(watch.frozenTarget.registryGate.status).toBe('PASS')
    expect(watch.frozenTarget.registryGate.command)
      .toBe('npm view @deepseek-ai/dsh@0.2.2-rc.2 version --registry=https://registry.npmjs.org/')
    expect(watch.frozenTarget.registryGate.runId).toBe(43334043848)
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
    expect(comparison.commitsBetweenReleaseMerges).toBe(1568)
    expect(comparison.changedFiles).toBe(4645)

    expect(comparison.readinessImplementation.verdict).toBe('UNCHANGED')
    expect(comparison.readinessImplementation.previousBlob)
      .toBe(comparison.readinessImplementation.targetBlob)

    expect(comparison.cliArgsImplementation.verdict).toBe('UNCHANGED')
    expect(comparison.cliArgsImplementation.previousBlob)
      .toBe(comparison.cliArgsImplementation.targetBlob)

    expect(comparison.cliReference.verdict).toBe('CHANGED')
    expect(comparison.cliReference.previousBlob)
      .not.toBe(comparison.cliReference.targetBlob)
  })
})
