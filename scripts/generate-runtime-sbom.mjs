#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = resolve(repoRoot, 'apps/desktop/runtime-lock')
const manifest = JSON.parse(
  readFileSync(resolve(runtimeRoot, 'package.json'), 'utf8'),
)
const pin = manifest.dependencies?.['@deepseek-ai/dsh']

function fail(message) {
  throw new Error(message)
}

export function generateRuntimeSbom(outputPath) {
  if (typeof pin !== 'string' || pin.length === 0) {
    fail('runtime-lock manifest is missing exact @deepseek-ai/dsh pin')
  }

  const result = spawnSync(
    'npm',
    [
      'sbom',
      '--package-lock-only',
      '--sbom-format',
      'cyclonedx',
      '--sbom-type',
      'application',
    ],
    {
      cwd: runtimeRoot,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    },
  )
  if (result.error) fail(`npm sbom failed: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`npm sbom failed (status ${String(result.status)}): ${String(result.stderr).trim()}`)
  }

  let bom
  try {
    bom = JSON.parse(result.stdout)
  } catch {
    fail('npm sbom did not emit valid JSON')
  }
  if (bom?.bomFormat !== 'CycloneDX' || typeof bom?.specVersion !== 'string') {
    fail('npm sbom did not emit a CycloneDX document')
  }
  if (bom?.metadata?.component?.name !== 'dsh-community-official-runtime-lock') {
    fail(
      'SBOM root component does not match runtime-lock manifest: ' +
        JSON.stringify(bom?.metadata?.component ?? null),
    )
  }
  const official = Array.isArray(bom?.components)
    ? bom.components.find((component) => component?.name === '@deepseek-ai/dsh')
    : undefined
  if (!official || official.version !== pin) {
    fail(`SBOM does not contain exact @deepseek-ai/dsh@${pin}`)
  }

  const out = resolve(outputPath)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(bom, null, 2) + '\n')
  process.stdout.write(
    `official-runtime SBOM OK: CycloneDX ${bom.specVersion}, @deepseek-ai/dsh@${pin}, ${String(bom.components.length)} components -> ${out}\n`,
  )
  return { out, pin, componentCount: bom.components.length, specVersion: bom.specVersion }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const output = process.argv[2]
  if (!output) {
    process.stderr.write('usage: node scripts/generate-runtime-sbom.mjs <output.cdx.json>\n')
    process.exit(2)
  }
  try {
    generateRuntimeSbom(output)
  } catch (error) {
    process.stderr.write(`runtime SBOM generation failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
