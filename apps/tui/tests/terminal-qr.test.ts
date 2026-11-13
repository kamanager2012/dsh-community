import { describe, expect, it } from 'vitest'
import { createPairingBootstrapDescriptor, encodePairingDeepLink } from '@dsh-community/remote-adapter'
import {
  encodeFormatBits,
  encodeQrMatrix,
  encodeVersionBits,
  gfMul,
  renderTerminalQr,
} from '../src/terminal-qr.js'

const GF_EXP = new Uint8Array(512)
{
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x
    GF_EXP[i + 255] = x
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
}

function popcount(n: number): number {
  let x = n >>> 0
  let count = 0
  while (x !== 0) {
    count += x & 1
    x >>>= 1
  }
  return count
}

function parseRenderedQr(rendered: string, expectedQuiet: number): boolean[][] {
  const cleanLines = rendered
    .split('\n')
    .map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ''))
    .filter((line) => line.length > 0)

  const width = cleanLines[0]!.length
  for (const line of cleanLines) {
    expect(line.length).toBe(width)
  }

  const size = width - expectedQuiet * 2
  expect((size - 17) % 4).toBe(0)

  // Verify quiet zone borders on top/bottom/left/right
  const fullRows: boolean[][] = []
  for (const line of cleanLines) {
    const topRow: boolean[] = []
    const botRow: boolean[] = []
    for (const ch of line) {
      if (ch === '█') {
        topRow.push(true)
        botRow.push(true)
      } else if (ch === '▀') {
        topRow.push(true)
        botRow.push(false)
      } else if (ch === '▄') {
        topRow.push(false)
        botRow.push(true)
      } else if (ch === ' ') {
        topRow.push(false)
        botRow.push(false)
      } else {
        throw new Error(`Unexpected QR character: ${JSON.stringify(ch)}`)
      }
    }
    fullRows.push(topRow, botRow)
  }

  const totalHeight = width
  for (let r = 0; r < totalHeight; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const inQuiet =
        r < expectedQuiet ||
        r >= totalHeight - expectedQuiet ||
        c < expectedQuiet ||
        c >= width - expectedQuiet
      if (inQuiet) {
        expect(fullRows[r]![c], `quiet module (${r},${c}) must be light`).toBe(false)
      }
    }
  }

  return fullRows
    .slice(expectedQuiet, expectedQuiet + size)
    .map((row) => row.slice(expectedQuiet, expectedQuiet + size))
}

function decodeAndVerifyQrMatrix(modules: readonly (readonly boolean[])[], eccLevel: 'L' | 'M'): string {
  const size = modules.length
  const version = (size - 17) / 4

  // Verify 3 finder patterns + dark module + timing patterns
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    for (let dr = 0; dr < 7; dr += 1) {
      for (let dc = 0; dc < 7; dc += 1) {
        const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3))
        expect(modules[top + dr]![left + dc]).toBe(dist === 3 || dist <= 1)
      }
    }
  }
  expect(modules[size - 8]![8]).toBe(true)
  for (let p = 8; p < size - 8; p += 1) {
    expect(modules[6]![p]).toBe(p % 2 === 0)
    expect(modules[p]![6]).toBe(p % 2 === 0)
  }

  // Decode BOTH copies of Format Information
  let fmtA = 0
  let fmtB = 0
  for (let i = 0; i < 15; i += 1) {
    const bitA = i < 6 ? modules[i]![8]! : i < 8 ? modules[i + 1]![8]! : modules[size - 15 + i]![8]!
    const bitB = i < 8 ? modules[8]![size - 1 - i]! : i < 9 ? modules[8]![7]! : modules[8]![14 - i]!
    if (bitA) fmtA |= 1 << i
    if (bitB) fmtB |= 1 << i
  }
  expect(fmtA).toBe(fmtB)

  let detectedMask = -1
  for (let mask = 0; mask < 8; mask += 1) {
    if (encodeFormatBits(eccLevel, mask) === fmtA) {
      detectedMask = mask
      break
    }
  }
  expect(detectedMask).toBeGreaterThanOrEqual(0)

  if (version >= 7) {
    let verA = 0
    let verB = 0
    for (let i = 0; i < 18; i += 1) {
      const a = Math.floor(i / 3)
      const b = i % 3
      if (modules[a]![size - 11 + b]) verA |= 1 << i
      if (modules[size - 11 + b]![a]) verB |= 1 << i
    }
    const expectedVer = encodeVersionBits(version)
    expect(popcount(verA ^ expectedVer)).toBe(0)
    expect(popcount(verB ^ expectedVer)).toBe(0)
  }

  // Identify function modules independently using alignment positions for verification
  const template = encodeQrMatrix('', eccLevel)
  void template
  const isFunc = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  for (let r = 0; r <= 8; r += 1) {
    for (let c = 0; c <= 8; c += 1) isFunc[r]![c] = true
    for (let c = size - 8; c < size; c += 1) isFunc[r]![c] = true
  }
  for (let r = size - 8; r < size; r += 1) {
    for (let c = 0; c <= 8; c += 1) isFunc[r]![c] = true
  }
  for (let p = 8; p < size - 8; p += 1) {
    isFunc[6]![p] = true
    isFunc[p]![6] = true
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        isFunc[i]![size - 11 + j] = true
        isFunc[size - 11 + j]![i] = true
      }
    }
  }
  // Mark alignment patterns from version > 1 (detecting centers mathematically per ISO 18004)
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    const step = version === 32 ? 26 : Math.ceil((size - 13) / (numAlign * 2 - 2)) * 2
    const coords = [6]
    for (let pos = size - 7; coords.length < numAlign; pos -= step) {
      coords.splice(1, 0, pos)
    }
    for (let i = 0; i < coords.length; i += 1) {
      for (let j = 0; j < coords.length; j += 1) {
        if ((i === 0 && j === 0) || (i === 0 && j === coords.length - 1) || (i === coords.length - 1 && j === 0)) {
          continue
        }
        const cr = coords[i]!
        const cc = coords[j]!
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            const dist = Math.max(Math.abs(dr), Math.abs(dc))
            expect(modules[cr + dr]![cc + dc]).toBe(dist === 2 || dist === 0)
            isFunc[cr + dr]![cc + dc] = true
          }
        }
      }
    }
  }

  const maskFn = (r: number, c: number): boolean => {
    switch (detectedMask) {
      case 0:
        return (r + c) % 2 === 0
      case 1:
        return r % 2 === 0
      case 2:
        return c % 3 === 0
      case 3:
        return (r + c) % 3 === 0
      case 4:
        return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
      case 5:
        return ((r * c) % 2) + ((r * c) % 3) === 0
      case 6:
        return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
      case 7:
        return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
      default:
        throw new Error(`Invalid mask ${detectedMask}`)
    }
  }

  const bits: number[] = []
  let upward = true
  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) rightCol = 5
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step
      for (let dc = 0; dc < 2; dc += 1) {
        const c = rightCol - dc
        if (!isFunc[r]![c]) {
          const val = modules[r]![c]!
          bits.push((maskFn(r, c) ? !val : val) ? 1 : 0)
        }
      }
    }
    upward = !upward
  }

  const rawCodewords: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0
    for (let k = 0; k < 8; k += 1) b = (b << 1) | bits[i + k]!
    rawCodewords.push(b)
  }

  // ISO Table 9 lookup for Versions 1..26 ECC L
  const ECC_L_SPEC: Record<number, readonly [number, number, number, number, number]> = {
    1: [7, 1, 19, 0, 0],
    2: [10, 1, 34, 0, 0],
    3: [15, 1, 55, 0, 0],
    4: [20, 1, 80, 0, 0],
    5: [26, 1, 108, 0, 0],
    6: [18, 2, 68, 0, 0],
    7: [20, 2, 78, 0, 0],
    8: [24, 2, 97, 0, 0],
    9: [30, 2, 116, 0, 0],
    10: [18, 2, 68, 2, 69],
    11: [20, 4, 81, 0, 0],
    12: [24, 2, 92, 2, 93],
    13: [26, 4, 107, 0, 0],
    14: [30, 3, 115, 1, 116],
    15: [22, 5, 87, 1, 88],
    16: [24, 5, 98, 1, 99],
    17: [28, 1, 107, 5, 108],
    18: [30, 5, 120, 1, 121],
    19: [28, 3, 113, 4, 114],
    20: [28, 3, 107, 5, 108],
    21: [28, 4, 116, 4, 117],
    22: [28, 2, 111, 7, 112],
    23: [30, 4, 121, 5, 122],
    24: [30, 6, 117, 4, 118],
    25: [26, 8, 106, 4, 107],
    26: [28, 10, 114, 2, 115],
  }
  const ECC_M_SPEC: Record<number, readonly [number, number, number, number, number]> = {
    1: [10, 1, 16, 0, 0],
    2: [16, 1, 28, 0, 0],
    3: [26, 1, 44, 0, 0],
    4: [18, 2, 32, 0, 0],
    5: [24, 2, 43, 0, 0],
    6: [16, 4, 27, 0, 0],
    7: [18, 4, 31, 0, 0],
    8: [22, 2, 38, 2, 39],
    14: [24, 4, 40, 5, 41],
    21: [26, 17, 42, 0, 0],
  }
  const spec = eccLevel === 'L' ? ECC_L_SPEC[version] : ECC_M_SPEC[version]
  if (spec) {
    const [ecPerBlock, g1b, g1d, g2b, g2d] = spec
    const totalBlocks = g1b + g2b
    const dataBlocks: number[][] = Array.from({ length: totalBlocks }, () => [])
    const ecBlocks: number[][] = Array.from({ length: totalBlocks }, () => [])
    let cursor = 0
    for (let col = 0; col < Math.max(g1d, g2d); col += 1) {
      for (let blk = 0; blk < totalBlocks; blk += 1) {
        const blkLen = blk < g1b ? g1d : g2d
        if (col < blkLen) {
          dataBlocks[blk]!.push(rawCodewords[cursor++]!)
        }
      }
    }
    for (let col = 0; col < ecPerBlock; col += 1) {
      for (let blk = 0; blk < totalBlocks; blk += 1) {
        ecBlocks[blk]!.push(rawCodewords[cursor++]!)
      }
    }
    expect(cursor).toBe(rawCodewords.length)

    // Verify all Reed-Solomon syndromes == 0 for every block
    for (let blk = 0; blk < totalBlocks; blk += 1) {
      const fullCodeword = [...dataBlocks[blk]!, ...ecBlocks[blk]!]
      for (let rootIdx = 0; rootIdx < ecPerBlock; rootIdx += 1) {
        const root = GF_EXP[rootIdx]!
        let evalVal = 0
        for (const coeff of fullCodeword) {
          evalVal = gfMul(evalVal, root) ^ coeff
        }
        expect(evalVal, `RS syndrome block ${blk} root ${rootIdx}`).toBe(0)
      }
    }

    const orderedData = dataBlocks.flat()
    const dataBits: number[] = []
    for (const byteVal of orderedData) {
      for (let shift = 7; shift >= 0; shift -= 1) {
        dataBits.push((byteVal >>> shift) & 1)
      }
    }

    const readBits = (offset: number, count: number): number => {
      let out = 0
      for (let i = 0; i < count; i += 1) {
        out = (out << 1) | dataBits[offset + i]!
      }
      return out
    }
    expect(readBits(0, 4)).toBe(0b0100) // Byte mode
    const countBits = version <= 9 ? 8 : 16
    const len = readBits(4, countBits)
    const outBytes = new Uint8Array(len)
    for (let i = 0; i < len; i += 1) {
      outBytes[i] = readBits(4 + countBits + i * 8, 8)
    }
    return Buffer.from(outBytes).toString('utf8')
  }

  throw new Error(`Add ECC lookup if testing version ${version}`)
}

describe('terminal-qr ISO/IEC 18004 encoder', () => {
  it('encodes V1, V4, V7, V10, V14, and V21 payloads across ECC L/M with zero RS syndrome and exact byte roundtrip', () => {
    const cases: Array<{ text: string; ecc: 'L' | 'M' }> = [
      { text: 'dsh-remote://v1', ecc: 'L' }, // V1
      { text: 'dsh-remote://pair?data=' + 'A'.repeat(40), ecc: 'L' }, // V4
      { text: 'dsh-remote://pair?data=' + 'B'.repeat(120), ecc: 'L' }, // V7 (version bits)
      { text: 'dsh-remote://pair?data=' + 'C'.repeat(230), ecc: 'L' }, // V10 (16-bit char count + mixed G1/G2)
      { text: 'dsh-remote://pair?data=' + 'D'.repeat(420), ecc: 'L' }, // V14 (3 remainder bits)
      { text: 'dsh-remote://pair?data=' + 'E'.repeat(880), ecc: 'L' }, // V21 (4 remainder bits + 5 alignment coords)
      { text: 'dsh-remote://v1m', ecc: 'M' }, // V1 ECC M
      { text: 'dsh-remote://pair?data=' + 'M'.repeat(100), ecc: 'M' }, // V7 ECC M
    ]

    for (const { text, ecc } of cases) {
      const rendered = renderTerminalQr(text, { eccLevel: ecc, quietZone: 2, ansiWhiteBackground: false })
      const matrix = parseRenderedQr(rendered, 2)
      expect(decodeAndVerifyQrMatrix(matrix, ecc)).toBe(text)
    }
  })

  it('encodes a realistic full multi-carrier dsh-remote://pair deep link cleanly', () => {
    const descriptor = createPairingBootstrapDescriptor({
      protocolVersion: 1,
      hostPublicKey: new Uint8Array(32).fill(7),
      bootstrapToken: 'boot-token-1234567890abcdef',
      endpointUrl: 'ws://192.168.1.42:49152',
      expiresAt: 1_800_000_000_000,
      signalingUrl: 'ws://192.168.1.42:8788',
      signalingRoomId: 'room-sig-12345678',
      stunUrls: ['stun:192.168.1.42:3478'],
      relayUrl: 'ws://192.168.1.42:8787',
      relayRoomId: 'room-rel-12345678',
    })
    const deepLink = encodePairingDeepLink(descriptor)

    const ansiRendered = renderTerminalQr(deepLink, {
      eccLevel: 'L',
      quietZone: 2,
      ansiWhiteBackground: true,
    })
    expect(ansiRendered).toContain('\u001b[107;30m')
    expect(ansiRendered).toContain('\u001b[0m')

    const matrix = parseRenderedQr(ansiRendered, 2)
    expect(decodeAndVerifyQrMatrix(matrix, 'L')).toBe(deepLink)
  })
})
