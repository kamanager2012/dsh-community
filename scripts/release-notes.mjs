/**
 * Extract the CHANGELOG section for a tag like v0.1.3-preview.
 * Usage: node scripts/release-notes.mjs v0.1.3-preview
 */

import { readFileSync } from 'node:fs'

const tag = process.argv[2]
if (tag === undefined || !tag.startsWith('v')) {
  process.stderr.write('usage: node scripts/release-notes.mjs <vX.Y.Z[-preview]>\n')
  process.exit(2)
}

const version = tag.slice(1)
const text = readFileSync('CHANGELOG.md', 'utf8')
const marker = `## ${version}`
const start = text.indexOf(marker)
if (start === -1) {
  process.stderr.write(`CHANGELOG.md has no section for ${version}\n`)
  process.exit(1)
}
const end = text.indexOf('\n## ', start + marker.length)
const section = end === -1 ? text.slice(start) : text.slice(start, end)
process.stdout.write(section.trimEnd())
process.stdout.write('\n')
