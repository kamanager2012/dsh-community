/**
 * Write <asset>.sha256 sidecar files for release assets.
 * Usage: node scripts/checksum-release.mjs <file...>
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) {
  process.stderr.write('usage: node scripts/checksum-release.mjs <file...>\n')
  process.exit(2)
}

for (const file of files) {
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  writeFileSync(`${file}.sha256`, `${digest}  ${file.split('/').pop()}\n`)
  process.stdout.write(`${digest}  ${file}\n`)
}
