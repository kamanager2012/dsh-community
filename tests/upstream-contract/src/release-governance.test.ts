import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const helper = join(root, 'scripts/release-governance.mjs')
const tag = 'v0.2.2-rc.3-community.2'

function rule(include: string[], overrides: Record<string, unknown> = {}) {
  return {
    id: 101, target: 'tag', enforcement: 'active',
    conditions: { ref_name: { include, exclude: [] } },
    rules: [{ type: 'update' }, { type: 'deletion' }],
    bypass_actors: [],
    ...overrides,
  }
}

function run(rulesets: unknown) {
  const code = [
    'import { verifyTagProtection } from ' + JSON.stringify(helper),
    'const x = JSON.parse(process.env.DSH_TEST_RULESETS || "null")',
    'try { const ids = verifyTagProtection(x, ' + JSON.stringify(tag) + '); console.log("OK:" + ids.join(",")) }',
    'catch(e) { console.error(e.message); process.exitCode = 1 }',
  ].join('\n')
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, DSH_TEST_RULESETS: JSON.stringify(rulesets) },
  })
}

describe('GitHub protected-tag release governance', () => {
  it('requires active update/deletion protections for both the release and its attempt ref', () => {
    const r = run([rule(['refs/tags/v*', 'refs/tags/release-attempt-v*'])])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('OK:101,101')
  })

  it('can combine two independently protected tag rulesets', () => {
    const r = run([rule(['refs/tags/v*']), rule(['refs/tags/release-attempt-v*'], { id: 202 })])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('OK:101,202')
  })

  it('fails when the release-attempt ref can be deleted after a failed upload', () => {
    const r = run([rule(['refs/tags/v*'])])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('refs/tags/release-attempt-')
  })

  it('fails when a ruleset only restricts deletion but not tag movement', () => {
    const r = run([rule(['refs/tags/*'], { rules: [{ type: 'deletion' }] })])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('missing active update/deletion protection')
  })

  it('does not accept a disabled or evaluate-only policy', () => {
    const r = run([rule(['refs/tags/*'], { enforcement: 'evaluate' })])
    expect(r.status).toBe(1)
  })

  it('rejects visible bypass actors even if the ruleset otherwise covers both refs', () => {
    const r = run([rule(['refs/tags/*'], { bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5 }] })])
    expect(r.status).toBe(1)
  })

  it('rejects an explicit release-attempt exclusion', () => {
    const r = run([rule(['refs/tags/*'], { conditions: { ref_name: {
      include: ['refs/tags/*'], exclude: ['refs/tags/release-attempt-*'],
    } } })])
    expect(r.status).toBe(1)
  })

  it('fails closed when a covering ruleset excludes v* via a GitHub character class', () => {
    const r = run([rule(['refs/tags/*'], { conditions: { ref_name: {
      include: ['refs/tags/*'], exclude: ['refs/tags/v[0-9]*'],
    } } })])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('unsupported GitHub tag ruleset pattern')
    expect(r.stderr).toContain('refs/tags/v[0-9]*')
  })

  it('fails closed when a tag ruleset include uses unsupported fnmatch syntax', () => {
    const r = run([rule(['refs/tags/v[0-9]*', 'refs/tags/release-attempt-*'])])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('unsupported GitHub tag ruleset pattern')
  })

  it('fails closed on malformed exclusion structure rather than ignoring it', () => {
    const r = run([rule(['refs/tags/*'], { conditions: { ref_name: {
      include: ['refs/tags/*'], exclude: 'refs/tags/v*',
    } } })])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('missing or malformed tag ruleset include/exclude')
  })

  it('retains the extra create-only remote Git marker in the workflow after policy validation', () => {
    const yml = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
    expect(yml).toContain('node scripts/release-governance.mjs')
    expect(yml).toContain('gh api -X POST "repos/${GITHUB_REPOSITORY}/git/refs"')
    expect(yml).toContain('-f "ref=refs/tags/release-attempt-${TAG}"')
    expect(yml).not.toContain('gh release upload')
  })
})
