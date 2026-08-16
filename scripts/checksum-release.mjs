/**
 * Write <asset>.sha256 sidecar files for release assets.
 * Usage: node scripts/checksum-release.mjs <file-or-glob...>
 */

import { createHash } from 'node:crypto'
import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

function expand(input) {
  if (input.includes('*') || input.includes('?') || input.includes('[')) {
    return globSync(input, { windowsPathsNoEscape: true })
  }
  return [input]
}

const files = process.argv.slice(2).flatMap(expand)
if (files.length === 0) {
  process.stderr.write('usage: node scripts/checksum-release.mjs <file-or-glob...>\n')
  process.exit(2)
}

for (const file of files) {
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  writeFileSync(`${file}.sha256`, `${digest}  ${basename(file)}\n`)
  process.stdout.write(`${digest}  ${file}\n`)
}
