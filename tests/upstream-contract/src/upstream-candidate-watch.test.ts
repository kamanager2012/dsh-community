import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('frozen upstream candidate target', () => {
  it('keeps alpha.3 as this upgrade cycle and records alpha.4 as a separate successor', () => {
    const watch = JSON.parse(
      readFileSync(
        join(repoRoot, 'contracts/compatibility/upstream-candidate-watch.json'),
        'utf8',
      ),
    ) as {
      schemaVersion: number
      frozenTarget: {
        package: string
        version: string
        upstreamReleaseCommit: string
        upstreamMergeCommit: string
        releasedAt: string
      }
      newerObserved: {
        version: string
        upstreamReleaseCommit: string
        upstreamMergeCommit: string
        releasedAt: string
        disposition: string
        comparison: {
          commitsBetweenReleaseMerges: number
          changedFiles: number
          readinessImplementation: {
            alpha3Blob: string
            alpha4Blob: string
            verdict: string
          }
          cliArgsImplementation: {
            alpha3Blob: string
            alpha4Blob: string
            verdict: string
          }
          cliReference: {
            alpha3Blob: string
            alpha4Blob: string
            verdict: string
          }
        }
      }
      policy: {
        candidateAdvancement: string
        rule: string
      }
    }

    expect(watch.schemaVersion).toBe(1)
    expect(watch.frozenTarget.package).toBe('@deepseek-ai/dsh')
    expect(watch.frozenTarget.version).toBe('0.1.2-alpha.3')
    expect(watch.newerObserved.version).toBe('0.1.2-alpha.4')
    expect(watch.newerObserved.disposition).toBe('NEXT_UPGRADE_CYCLE')
    expect(watch.policy.candidateAdvancement).toBe('EXPLICIT_ONLY')

    for (const sha of [
      watch.frozenTarget.upstreamReleaseCommit,
      watch.frozenTarget.upstreamMergeCommit,
      watch.newerObserved.upstreamReleaseCommit,
      watch.newerObserved.upstreamMergeCommit,
    ]) {
      expect(sha).toMatch(/^[0-9a-f]{40}$/u)
    }

    expect(Date.parse(watch.newerObserved.releasedAt)).toBeGreaterThan(
      Date.parse(watch.frozenTarget.releasedAt),
    )
    expect(watch.newerObserved.comparison.commitsBetweenReleaseMerges).toBeGreaterThan(0)
    expect(watch.newerObserved.comparison.changedFiles).toBeGreaterThan(0)

    expect(watch.newerObserved.comparison.readinessImplementation.verdict).toBe('IDENTICAL')
    expect(watch.newerObserved.comparison.readinessImplementation.alpha3Blob).toBe(
      watch.newerObserved.comparison.readinessImplementation.alpha4Blob,
    )
    expect(watch.newerObserved.comparison.cliArgsImplementation.verdict).toBe('IDENTICAL')
    expect(watch.newerObserved.comparison.cliArgsImplementation.alpha3Blob).toBe(
      watch.newerObserved.comparison.cliArgsImplementation.alpha4Blob,
    )
    expect(watch.newerObserved.comparison.cliReference.verdict).toBe('CHANGED')
    expect(watch.newerObserved.comparison.cliReference.alpha3Blob).not.toBe(
      watch.newerObserved.comparison.cliReference.alpha4Blob,
    )
  })
})
