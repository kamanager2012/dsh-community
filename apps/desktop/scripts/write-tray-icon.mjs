import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const size = 32

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

function pixel(x, y) {
  const dx = x - 15.5
  const dy = y - 15.5
  const r = Math.hypot(dx, dy)
  if (r < 11) return [0x2f, 0x6f, 0xed]
  if (r < 13) return [0xd9, 0xde, 0xe8]
  return [0x10, 0x12, 0x18]
}

const raw = Buffer.alloc(size * (1 + size * 3))
for (let y = 0; y < size; y += 1) {
  const row = y * (1 + size * 3)
  raw[row] = 0
  for (let x = 0; x < size; x += 1) {
    const [red, green, blue] = pixel(x, y)
    const offset = row + 1 + x * 3
    raw[offset] = red
    raw[offset + 1] = green
    raw[offset + 2] = blue
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(size, 0)
ihdr.writeUInt32BE(size, 4)
ihdr[8] = 8
ihdr[9] = 2

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../resources/tray.png')
await mkdir(dirname(out), { recursive: true })
createWriteStream(out).end(png)
console.log(out)
