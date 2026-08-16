import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodePng, writeAppIcons } from '../scripts/write-tray-icon.mjs'

function pngSize(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

describe('app icons', () => {
  it('encodes a 512 PNG so macOS electron-builder can convert icns', () => {
    expect(pngSize(encodePng(512))).toEqual({ width: 512, height: 512 })
    expect(pngSize(encodePng(32))).toEqual({ width: 32, height: 32 })
  })

  it('writes tray.png (32) and icon.png (512)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-icons-'))
    const written = writeAppIcons(dir)
    expect(pngSize(readFileSync(written.tray))).toEqual({ width: 32, height: 32 })
    expect(pngSize(readFileSync(written.icon))).toEqual({ width: 512, height: 512 })
  })
})
