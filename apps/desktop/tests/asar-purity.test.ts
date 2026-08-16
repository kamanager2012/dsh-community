import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The packaged asar must never carry the official runtime. The runtime ships
 * as resources/host (extraResources) so upstream stays outside the carrier;
 * this test asserts the built archive agrees, when a build exists.
 */

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const candidates = [
  join(desktop, 'release/linux-unpacked/resources/app.asar'),
  join(desktop, 'release/win-unpacked/resources/app.asar'),
  join(desktop, 'release/mac/DSH Community.app/Contents/Resources/app.asar'),
]
const asarPath = candidates.find((path) => existsSync(path))

describe.skipIf(asarPath === undefined)('packaged asar vendor=0', () => {
  it('contains no @deepseek-ai or node_modules entries', () => {
    const require = createRequire(join(desktop, 'package.json'))
    const asar = require('@electron/asar') as {
      listPackage: (path: string) => string[]
    }
    const entries = asar.listPackage(asarPath ?? '')
    expect(entries.length).toBeGreaterThan(0)
    const leaked = entries.filter((entry) =>
      entry.includes('@deepseek-ai') || entry.includes('node_modules'),
    )
    expect(leaked).toEqual([])
  })
})
