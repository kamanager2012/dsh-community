import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

function crc32(buffer) {
  let crc = 0xffff_ffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb8_8320 & mask)
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crcInput = Buffer.concat([typeBytes, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcInput))
  return Buffer.concat([length, crcInput, crc])
}

export function encodePng(size) {
  const cx = (size - 1) / 2
  const inner = size * (11 / 32)
  const ring = size * (13 / 32)
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 3)
    raw[row] = 0
    for (let x = 0; x < size; x += 1) {
      const r = Math.hypot(x - cx, y - cx)
      const rgb = r < inner
        ? [0x2f, 0x6f, 0xed]
        : r < ring
          ? [0xd9, 0xde, 0xe8]
          : [0x10, 0x12, 0x18]
      const offset = row + 1 + x * 3
      raw[offset] = rgb[0]
      raw[offset + 1] = rgb[1]
      raw[offset + 2] = rgb[2]
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function writeAppIcons(resourceDir) {
  mkdirSync(resourceDir, { recursive: true })
  const tray = join(resourceDir, 'tray.png')
  const icon = join(resourceDir, 'icon.png')
  writeFileSync(tray, encodePng(32))
  writeFileSync(icon, encodePng(512))
  return { tray, icon }
}

const invoked = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invoked) {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../resources')
  const written = writeAppIcons(dir)
  process.stdout.write(`${written.tray}\n${written.icon}\n`)
}
