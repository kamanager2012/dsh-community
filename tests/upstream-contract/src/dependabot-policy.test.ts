import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const dependabot = readFileSync(join(repoRoot, '.github/dependabot.yml'), 'utf8')

describe('Dependabot maintenance policy', () => {
  it('keeps automatic version updates below semver-major', () => {
    const majorIgnores = dependabot.match(/version-update:semver-major/gu) ?? []
    expect(majorIgnores).toHaveLength(2)
    expect(dependabot).toMatch(/package-ecosystem: npm[\s\S]*?update-types:\n\s+- minor\n\s+- patch/u)
    expect(dependabot).toMatch(/package-ecosystem: github-actions[\s\S]*?update-types:\n\s+- minor\n\s+- patch/u)
    expect(dependabot).not.toMatch(/^\s+- major\s*$/mu)
  })
})
