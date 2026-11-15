/**
 * Build a user-facing GitHub Release title or body for a release tag such as
 * v0.2.2-rc.3 or v0.2.2-rc.2-community.1.
 *
 * Usage:
 *   node scripts/release-notes.mjs <vX.Y.Z[-prerelease]>
 *   node scripts/release-notes.mjs --title <vX.Y.Z[-prerelease]>
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_REPOSITORY = 'kamanager2012/dsh-community'
const RELEASE_TAG_RE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u
const LATEST_ELIGIBLE_TAG_RE = /^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/u
const MODULE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function capitalizeFirst(value) {
  if (!value) return value
  return value[0].toUpperCase() + value.slice(1)
}

export function classifyReleaseTag(tag) {
  const match = typeof tag === 'string' ? RELEASE_TAG_RE.exec(tag) : null
  if (!match) {
    throw new Error('release tag must look like vX.Y.Z[-prerelease]: ' + String(tag))
  }
  return {
    tag,
    version: match[1],
    isLatestEligible: LATEST_ELIGIBLE_TAG_RE.test(tag),
  }
}

export function resolveOfficialCoreVersion(_repoRoot, fallbackVersion) {
  return fallbackVersion.replace(/-community\.(?:0|[1-9]\d*)$/u, '')
}

export function extractChangelogSection(changelogText, version) {
  const headingRe = new RegExp(`^## ${escapeRegExp(version)}(?:\\s|$).*`, 'mu')
  const match = headingRe.exec(changelogText)
  if (!match) {
    throw new Error(`CHANGELOG.md has no section for ${version}`)
  }
  const sectionStart = match.index
  const afterHeading = sectionStart + match[0].length
  const nextHeadingOffset = changelogText.slice(afterHeading).search(/\n## /u)
  const section = nextHeadingOffset === -1
    ? changelogText.slice(sectionStart)
    : changelogText.slice(sectionStart, afterHeading + nextHeadingOffset)
  return section.trim()
}

export function normalizeChangelogBody(section, isLatestEligible) {
  const lines = section.replaceAll('\r\n', '\n').split('\n')
  const withoutHeading = lines[0]?.startsWith('## ') ? lines.slice(1) : lines
  let body = withoutHeading.join('\n').trim()

  if (isLatestEligible && body) {
    body = body
      .replace(
        /^This is a reviewed \*\*Candidate Source\*\*[^\n]*?Published Latest remains `[^`]+`(?:[;,][^\S\n]*|\.\s*)/iu,
        '',
      )
      .replace(
        /(?:GitHub )?Published Latest remains `[^`]+` until `[^`]+` release workflows publish(?:[;,][^\S\n]*|\.\s*)/iu,
        '',
      )
      .trim()

    if (/^[a-z]/u.test(body)) {
      body = capitalizeFirst(body)
    }
  }

  return body
}

export function renderReleaseTitle(tag, coreVersion, isLatestEligible) {
  if (isLatestEligible) {
    return `${tag} — Official Core @deepseek-ai/dsh@${coreVersion}`
  }
  return `${tag} — Community Pre-release (@deepseek-ai/dsh@${coreVersion})`
}

export function renderReleaseNotes({
  tag,
  changelogText,
  repoRoot = MODULE_REPO_ROOT,
  repository = DEFAULT_REPOSITORY,
}) {
  const { version, isLatestEligible } = classifyReleaseTag(tag)
  const coreVersion = resolveOfficialCoreVersion(repoRoot, version)
  const rawSection = extractChangelogSection(changelogText, version)
  const changelogBody = normalizeChangelogBody(rawSection, isLatestEligible)

  const appImageName = `dsh-community-${version}.AppImage`
  const sbomName = `dsh-community-${version}-official-runtime.cdx.json`
  const channelLabel = isLatestEligible
    ? 'Complementary Edition Latest Release'
    : 'Complementary Edition Pre-release'
  const baseDownloadUrl = `https://github.com/${repository}/releases/download/${tag}`
  const certIdentity = `https://github.com/${repository}/.github/workflows/release.yml@refs/tags/${tag}`

  const lines = [
    `# DeepSeek Harness Community \`${version}\``,
    '',
    `> **Dual-Badge**: \`DeepSeek Harness Community v${version} [Official Core: @deepseek-ai/dsh@${coreVersion}]\`  `,
    `> **Channel**: ${channelLabel} · **Session Truth**: Shared \`~/.dsh\` across Official Web, Official Win/macOS Desktop, WSL/Linux Terminal, and Linux AppImage`,
    '',
  ]

  if (!isLatestEligible) {
    lines.push(
      `> **Pre-release notice**: This build is a GitHub **Pre-release** and does not displace [\`releases/latest\`](https://github.com/${repository}/releases/latest).`,
      '',
    )
  }

  if (changelogBody) {
    lines.push('## What\'s Changed', '', changelogBody, '')
  }

  lines.push(
    '## Choose Your Surface & Quick Start',
    '',
    '| Surface | How to Run / Download | Scope |',
    '|---|---|---|',
    `| **Linux Desktop (AppImage)** | Download [\`${appImageName}\`](${baseDownloadUrl}/${appImageName}) below | Complementary Linux GUI absent upstream |`,
    '| **WSL / Linux Terminal & Remote CLI** | From source: `pnpm install && pnpm start` or `dsh-community remote start` | Primary Linux / WSL TUI & multi-agent E2EE host |',
    `| **Official Web & Win / macOS Desktop** | [\`deepseek-ai/deepseek-harness\`](https://github.com/deepseek-ai/deepseek-harness) (\`npx @deepseek-ai/dsh@${coreVersion} web\`) | Upstream surfaces (Win \`.exe\` / macOS \`.dmg\` retired here after \`v0.1.1-rc.2\`) |`,
    '| **Android Remote Client** | Source under `apps/android` | `[UNVERIFIED]` — omitted from GitHub Release binaries until R6 real-device acceptance passes |',
    '',
    '### Launch Linux AppImage',
    '',
    '```sh',
    `chmod +x ${appImageName}`,
    `./${appImageName}`,
    '```',
    '',
    `First launch extracts the embedded official \`@deepseek-ai/dsh@${coreVersion}\` runtime once into user data; all conversations stay in \`~/.dsh\`.`,
    '',
    '## Release Assets & Verification (SHA-256 + Keyless Cosign)',
    '',
    'Every release publishes 8 signed files (`.AppImage`, official-runtime CycloneDX `.cdx.json` SBOM, `.sha256` sidecars, and `.sigstore.json` keyless Sigstore bundles):',
    '',
    '```sh',
    '# 1. Verify SHA-256 checksums',
    `sha256sum -c ${appImageName}.sha256 ${sbomName}.sha256`,
    '',
    '# 2. Verify Keyless Cosign signature (requires cosign >= v2.4)',
    'cosign verify-blob \\',
    `  --bundle ${appImageName}.sigstore.json \\`,
    '  --certificate-oidc-issuer https://token.actions.githubusercontent.com \\',
    `  --certificate-identity "${certIdentity}" \\`,
    `  ${appImageName}`,
    '```',
    '',
    '## Verification Boundaries & Docs',
    '',
    '- **Boundaries**: `artifact-smoke` checks SHA-256 checksums, keyless Cosign signatures across all 8 assets, Linux AppImage extraction, and CLI startup; `Full user loop` and `Android` real-device acceptance remain `[UNVERIFIED]` until explicitly promoted.',
    `- **Docs**: [Current Release Facts](https://github.com/${repository}/blob/main/docs/current-release.md) · [Machine Facts (\`current-release.json\`)](https://github.com/${repository}/blob/main/docs/current-release.json) · [Release & Signing Guide](https://github.com/${repository}/blob/main/docs/release.md#artifact-signing-keyless) · [Handbook](https://kamanager2012.github.io/dsh-community/)`,
  )

  return lines.join('\n') + '\n'
}

export function parseCliArgs(argv) {
  let titleOnly = false
  let repoRoot = process.cwd()
  let tag
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--title') {
      titleOnly = true
    } else if (arg === '--repo-root') {
      repoRoot = argv[i + 1]
      if (!repoRoot) {
        throw new Error('missing path after --repo-root')
      }
      i += 1
    } else if (tag === undefined && !arg.startsWith('-')) {
      tag = arg
    } else {
      throw new Error(`unexpected argument: ${arg}`)
    }
  }
  if (!tag || !tag.startsWith('v')) {
    return null
  }
  return { tag, titleOnly, repoRoot: resolve(repoRoot) }
}

function runCli() {
  let parsed
  try {
    parsed = parseCliArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
  if (!parsed) {
    process.stderr.write('usage: node scripts/release-notes.mjs [--title] [--repo-root <dir>] <vX.Y.Z[-prerelease]>\n')
    process.exit(2)
  }

  try {
    const { tag, titleOnly, repoRoot } = parsed
    const { version, isLatestEligible } = classifyReleaseTag(tag)
    if (titleOnly) {
      const coreVersion = resolveOfficialCoreVersion(repoRoot, version)
      process.stdout.write(renderReleaseTitle(tag, coreVersion, isLatestEligible) + '\n')
      return
    }

    const changelogPath = join(repoRoot, 'CHANGELOG.md')
    const changelogText = readFileSync(changelogPath, 'utf8')
    process.stdout.write(renderReleaseNotes({ tag, changelogText, repoRoot }))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli()
}
