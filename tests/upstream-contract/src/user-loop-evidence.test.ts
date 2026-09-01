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

  it('tests an immutable release checkout without replacing the evidence runner', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('path: release-src')
    expect(workflow).toContain('release-src/apps/tui/dist/bin.js')
    expect(workflow).toContain('scripts/e2e/user-loop.py')
    expect(workflow).toContain('permissions:\n  contents: read')
  })

  it('does not upgrade release facts before a real successful run exists', () => {
    const facts = JSON.parse(readFileSync(currentReleasePath, 'utf8')) as {
      evidence?: {
        userLoop?: {
          status?: string
          workflow?: string
          note?: string
        }
      }
    }
    expect(facts.evidence?.userLoop?.status).toBe('UNVERIFIED')
    expect(facts.evidence?.userLoop?.workflow).toBe('.github/workflows/user-loop-evidence.yml')
    expect(facts.evidence?.userLoop?.note).toMatch(/no successful exact-release run/i)
  })
})
