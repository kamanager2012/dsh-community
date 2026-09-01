import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('current-release human index consistency', () => {
  it('renders Candidate, Published Latest, assets, and evidence from the machine facts', () => {
    const facts = JSON.parse(
      readFileSync(join(repoRoot, 'docs/current-release.json'), 'utf8'),
    ) as {
      officialKernel: { package: string; version: string }
      communityProduct: { version: string; githubLatestTag: string }
      candidateTag: string
      dualBadge: string
      publishedAssets: {
        linuxAppImage: string
        macosDmg: string
        windowsSetup: string
      }
      publishedReleaseEvidence: {
        releaseId: number
        publishedAt: string
      }
      evidence: {
        userLoop: { status: string }
        pluginRegistryLastVerified: { testedDsh: string }
      }
    }

    const human = readFileSync(join(repoRoot, 'docs/current-release.md'), 'utf8')

    expect(human).toContain(
      `| Candidate official kernel | \`${facts.officialKernel.package}@${facts.officialKernel.version}\` |`,
    )
    expect(human).toContain(
      `| Candidate community product | \`${facts.communityProduct.version}\` |`,
    )
    expect(human).toContain(`| Candidate tag | \`${facts.candidateTag}\` |`)
    expect(human).toContain(
      `| GitHub Latest | [\`${facts.communityProduct.githubLatestTag}\`](https://github.com/kamanager2012/dsh-community/releases/latest) |`,
    )
    expect(human).toContain(
      `| Candidate Dual-Badge | \`${facts.dualBadge}\` |`,
    )
    expect(human).toContain('release ID \`' + facts.publishedReleaseEvidence.releaseId + '\`')
    expect(human).toContain('published \`' + facts.publishedReleaseEvidence.publishedAt + '\`')
    expect(human).toMatch(
      new RegExp(
        '\\| Full user loop \\| \\[\\`?' + facts.evidence.userLoop.status + '\\`?\\]',
        'u',
      ),
    )
    expect(human).toContain(
      `| Plugin \`testedDsh\` | \`${facts.evidence.pluginRegistryLastVerified.testedDsh}\``,
    )

    for (const asset of [
      facts.publishedAssets.linuxAppImage,
      facts.publishedAssets.macosDmg,
      facts.publishedAssets.windowsSetup,
    ]) {
      expect(human).toContain(`- \`${asset}\``)
    }
  })
})
