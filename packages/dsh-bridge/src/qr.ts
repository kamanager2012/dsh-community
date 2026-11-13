/**
 * Zero-dependency ISO/IEC 18004 QR Code encoder (Byte mode, Versions 1..26, ECC L/M)
 * with both Unicode half-block terminal output and crisp inline SVG rendering.
 */

export type QrErrorCorrectionLevel = 'L' | 'M'

export interface QrMatrix {
  readonly version: number
  readonly size: number
  readonly eccLevel: QrErrorCorrectionLevel
  readonly maskId: number
  readonly modules: readonly (readonly boolean[])[]
}

export interface TerminalQrRenderOptions {
  readonly eccLevel?: QrErrorCorrectionLevel | undefined
  readonly quietZone?: number | undefined
  readonly ansiWhiteBackground?: boolean | undefined
}

export interface QrSvgRenderOptions {
  readonly eccLevel?: QrErrorCorrectionLevel | undefined
  readonly quietZone?: number | undefined
  readonly darkColor?: string | undefined
  readonly lightColor?: string | undefined
  readonly ariaLabel?: string | undefined
}

interface EccBlockSpec {
  readonly ecPerBlock: number
  readonly g1Blocks: number
  readonly g1Data: number
  readonly g2Blocks: number
  readonly g2Data: number
}

// ISO/IEC 18004 Table 9 block parameters for Versions 1..26 at ECC L and M.
const ECC_TABLE_L: readonly EccBlockSpec[] = [
  { ecPerBlock: 7, g1Blocks: 1, g1Data: 19, g2Blocks: 0, g2Data: 0 }, // V1
  { ecPerBlock: 10, g1Blocks: 1, g1Data: 34, g2Blocks: 0, g2Data: 0 }, // V2
  { ecPerBlock: 15, g1Blocks: 1, g1Data: 55, g2Blocks: 0, g2Data: 0 }, // V3
  { ecPerBlock: 20, g1Blocks: 1, g1Data: 80, g2Blocks: 0, g2Data: 0 }, // V4
  { ecPerBlock: 26, g1Blocks: 1, g1Data: 108, g2Blocks: 0, g2Data: 0 }, // V5
  { ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 0, g2Data: 0 }, // V6
  { ecPerBlock: 20, g1Blocks: 2, g1Data: 78, g2Blocks: 0, g2Data: 0 }, // V7
  { ecPerBlock: 24, g1Blocks: 2, g1Data: 97, g2Blocks: 0, g2Data: 0 }, // V8
  { ecPerBlock: 30, g1Blocks: 2, g1Data: 116, g2Blocks: 0, g2Data: 0 }, // V9
  { ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 2, g2Data: 69 }, // V10
  { ecPerBlock: 20, g1Blocks: 4, g1Data: 81, g2Blocks: 0, g2Data: 0 }, // V11
  { ecPerBlock: 24, g1Blocks: 2, g1Data: 92, g2Blocks: 2, g2Data: 93 }, // V12
  { ecPerBlock: 26, g1Blocks: 4, g1Data: 107, g2Blocks: 0, g2Data: 0 }, // V13
  { ecPerBlock: 30, g1Blocks: 3, g1Data: 115, g2Blocks: 1, g2Data: 116 }, // V14
  { ecPerBlock: 22, g1Blocks: 5, g1Data: 87, g2Blocks: 1, g2Data: 88 }, // V15
  { ecPerBlock: 24, g1Blocks: 5, g1Data: 98, g2Blocks: 1, g2Data: 99 }, // V16
  { ecPerBlock: 28, g1Blocks: 1, g1Data: 107, g2Blocks: 5, g2Data: 108 }, // V17
  { ecPerBlock: 30, g1Blocks: 5, g1Data: 120, g2Blocks: 1, g2Data: 121 }, // V18
  { ecPerBlock: 28, g1Blocks: 3, g1Data: 113, g2Blocks: 4, g2Data: 114 }, // V19
  { ecPerBlock: 28, g1Blocks: 3, g1Data: 107, g2Blocks: 5, g2Data: 108 }, // V20
  { ecPerBlock: 28, g1Blocks: 4, g1Data: 116, g2Blocks: 4, g2Data: 117 }, // V21
  { ecPerBlock: 28, g1Blocks: 2, g1Data: 111, g2Blocks: 7, g2Data: 112 }, // V22
  { ecPerBlock: 30, g1Blocks: 4, g1Data: 121, g2Blocks: 5, g2Data: 122 }, // V23
  { ecPerBlock: 30, g1Blocks: 6, g1Data: 117, g2Blocks: 4, g2Data: 118 }, // V24
  { ecPerBlock: 26, g1Blocks: 8, g1Data: 106, g2Blocks: 4, g2Data: 107 }, // V25
  { ecPerBlock: 28, g1Blocks: 10, g1Data: 114, g2Blocks: 2, g2Data: 115 }, // V26
]

const ECC_TABLE_M: readonly EccBlockSpec[] = [
  { ecPerBlock: 10, g1Blocks: 1, g1Data: 16, g2Blocks: 0, g2Data: 0 }, // V1
  { ecPerBlock: 16, g1Blocks: 1, g1Data: 28, g2Blocks: 0, g2Data: 0 }, // V2
  { ecPerBlock: 26, g1Blocks: 1, g1Data: 44, g2Blocks: 0, g2Data: 0 }, // V3
  { ecPerBlock: 18, g1Blocks: 2, g1Data: 32, g2Blocks: 0, g2Data: 0 }, // V4
  { ecPerBlock: 24, g1Blocks: 2, g1Data: 43, g2Blocks: 0, g2Data: 0 }, // V5
  { ecPerBlock: 16, g1Blocks: 4, g1Data: 27, g2Blocks: 0, g2Data: 0 }, // V6
  { ecPerBlock: 18, g1Blocks: 4, g1Data: 31, g2Blocks: 0, g2Data: 0 }, // V7
  { ecPerBlock: 22, g1Blocks: 2, g1Data: 38, g2Blocks: 2, g2Data: 39 }, // V8
  { ecPerBlock: 22, g1Blocks: 3, g1Data: 36, g2Blocks: 2, g2Data: 37 }, // V9
  { ecPerBlock: 26, g1Blocks: 4, g1Data: 43, g2Blocks: 1, g2Data: 44 }, // V10
  { ecPerBlock: 30, g1Blocks: 1, g1Data: 50, g2Blocks: 4, g2Data: 51 }, // V11
  { ecPerBlock: 22, g1Blocks: 6, g1Data: 36, g2Blocks: 2, g2Data: 37 }, // V12
  { ecPerBlock: 22, g1Blocks: 8, g1Data: 37, g2Blocks: 1, g2Data: 38 }, // V13
  { ecPerBlock: 24, g1Blocks: 4, g1Data: 40, g2Blocks: 5, g2Data: 41 }, // V14
  { ecPerBlock: 24, g1Blocks: 5, g1Data: 41, g2Blocks: 5, g2Data: 42 }, // V15
  { ecPerBlock: 28, g1Blocks: 7, g1Data: 45, g2Blocks: 3, g2Data: 46 }, // V16
  { ecPerBlock: 28, g1Blocks: 10, g1Data: 46, g2Blocks: 1, g2Data: 47 }, // V17
  { ecPerBlock: 26, g1Blocks: 9, g1Data: 43, g2Blocks: 4, g2Data: 44 }, // V18
  { ecPerBlock: 26, g1Blocks: 3, g1Data: 44, g2Blocks: 11, g2Data: 45 }, // V19
  { ecPerBlock: 26, g1Blocks: 3, g1Data: 41, g2Blocks: 13, g2Data: 42 }, // V20
  { ecPerBlock: 26, g1Blocks: 17, g1Data: 42, g2Blocks: 0, g2Data: 0 }, // V21
  { ecPerBlock: 28, g1Blocks: 17, g1Data: 46, g2Blocks: 0, g2Data: 0 }, // V22
  { ecPerBlock: 28, g1Blocks: 4, g1Data: 47, g2Blocks: 14, g2Data: 48 }, // V23
  { ecPerBlock: 28, g1Blocks: 6, g1Data: 45, g2Blocks: 14, g2Data: 46 }, // V24
  { ecPerBlock: 28, g1Blocks: 8, g1Data: 47, g2Blocks: 13, g2Data: 48 }, // V25
  { ecPerBlock: 28, g1Blocks: 19, g1Data: 46, g2Blocks: 4, g2Data: 47 }, // V26
]

// ISO/IEC 18004 Annex E alignment pattern center coordinates (index = version - 1).
const ALIGNMENT_COORDS: readonly (readonly number[])[] = [
  [], // V1
  [6, 18], // V2
  [6, 22], // V3
  [6, 26], // V4
  [6, 30], // V5
  [6, 34], // V6
  [6, 22, 38], // V7
  [6, 24, 42], // V8
  [6, 26, 46], // V9
  [6, 28, 50], // V10
  [6, 30, 54], // V11
  [6, 32, 58], // V12
  [6, 34, 62], // V13
  [6, 26, 46, 66], // V14
  [6, 26, 48, 70], // V15
  [6, 26, 50, 74], // V16
  [6, 30, 54, 78], // V17
  [6, 30, 56, 82], // V18
  [6, 30, 58, 86], // V19
  [6, 34, 62, 90], // V20
  [6, 28, 50, 72, 94], // V21
  [6, 26, 50, 74, 98], // V22
  [6, 30, 54, 78, 102], // V23
  [6, 28, 54, 80, 106], // V24
  [6, 32, 58, 84, 110], // V25
  [6, 30, 58, 86, 114], // V26
]

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x
    GF_EXP[i + 255] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) {
      x ^= 0x11d
    }
  }
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!
}

function buildRsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1)
    const root = GF_EXP[i]!
    for (let j = 0; j < poly.length; j += 1) {
      next[j]! ^= poly[j]!
      next[j + 1]! ^= gfMul(poly[j]!, root)
    }
    poly = next
  }
  return poly
}

function computeRsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = buildRsGenerator(ecCount)
  const buffer = new Uint8Array(data.length + ecCount)
  buffer.set(data, 0)
  for (let i = 0; i < data.length; i += 1) {
    const factor = buffer[i]!
    if (factor === 0) continue
    for (let j = 1; j < gen.length; j += 1) {
      buffer[i + j]! ^= gfMul(factor, gen[j]!)
    }
  }
  return buffer.slice(data.length)
}

function bchDigit(value: number): number {
  let v = value
  let digits = 0
  while (v !== 0) {
    digits += 1
    v >>>= 1
  }
  return digits
}

export function encodeFormatBits(eccLevel: QrErrorCorrectionLevel, maskId: number): number {
  // ISO 18004 format indicator bits: L = 01 (1), M = 00 (0)
  const eccBits = eccLevel === 'L' ? 0b01 : 0b00
  const data = (eccBits << 3) | (maskId & 0x7)
  let rem = data << 10
  const gen = 0x537
  while (bchDigit(rem) >= bchDigit(gen)) {
    rem ^= gen << (bchDigit(rem) - bchDigit(gen))
  }
  return ((data << 10) | rem) ^ 0x5412
}

export function encodeVersionBits(version: number): number {
  let rem = version << 12
  const gen = 0x1f25
  while (bchDigit(rem) >= bchDigit(gen)) {
    rem ^= gen << (bchDigit(rem) - bchDigit(gen))
  }
  return (version << 12) | rem
}

function totalDataCodewords(spec: EccBlockSpec): number {
  return spec.g1Blocks * spec.g1Data + spec.g2Blocks * spec.g2Data
}

function remainderBitsForVersion(version: number): number {
  if (version >= 2 && version <= 6) return 7
  if (version >= 14 && version <= 20) return 3
  if (version >= 21 && version <= 27) return 4
  return 0
}

function selectVersionAndEncodeData(
  payload: Uint8Array,
  eccLevel: QrErrorCorrectionLevel,
): { version: number; spec: EccBlockSpec; codewords: Uint8Array } {
  const table = eccLevel === 'L' ? ECC_TABLE_L : ECC_TABLE_M
  for (let i = 0; i < table.length; i += 1) {
    const version = i + 1
    const spec = table[i]!
    const capacity = totalDataCodewords(spec)
    const countBits = version <= 9 ? 8 : 16
    const headerBits = 4 + countBits
    const neededBits = headerBits + payload.length * 8
    if (neededBits <= capacity * 8) {
      const bits: number[] = []
      const pushBits = (val: number, width: number): void => {
        for (let b = width - 1; b >= 0; b -= 1) {
          bits.push((val >>> b) & 1)
        }
      }
      // Byte mode = 0100
      pushBits(0b0100, 4)
      pushBits(payload.length, countBits)
      for (const byte of payload) {
        pushBits(byte, 8)
      }
      // Terminator up to 4 zero bits
      const terminator = Math.min(4, capacity * 8 - bits.length)
      pushBits(0, terminator)
      // Byte alignment
      while (bits.length % 8 !== 0) {
        bits.push(0)
      }
      // Pad codewords alternating 0xEC and 0x11
      const padBytes = [0xec, 0x11]
      let padIdx = 0
      while (bits.length < capacity * 8) {
        pushBits(padBytes[padIdx % 2]!, 8)
        padIdx += 1
      }
      const codewords = new Uint8Array(capacity)
      for (let idx = 0; idx < capacity; idx += 1) {
        let byteVal = 0
        for (let bit = 0; bit < 8; bit += 1) {
          byteVal = (byteVal << 1) | bits[idx * 8 + bit]!
        }
        codewords[idx] = byteVal
      }
      return { version, spec, codewords }
    }
  }
  throw new Error(`QR payload (${payload.length} bytes) exceeds Version 26 capacity at ECC ${eccLevel}`)
}

function buildFinalBitStream(version: number, spec: EccBlockSpec, dataCodewords: Uint8Array): Uint8Array {
  const dataBlocks: Uint8Array[] = []
  const ecBlocks: Uint8Array[] = []
  let offset = 0

  for (let i = 0; i < spec.g1Blocks; i += 1) {
    const slice = dataCodewords.slice(offset, offset + spec.g1Data)
    offset += spec.g1Data
    dataBlocks.push(slice)
    ecBlocks.push(computeRsRemainder(slice, spec.ecPerBlock))
  }
  for (let i = 0; i < spec.g2Blocks; i += 1) {
    const slice = dataCodewords.slice(offset, offset + spec.g2Data)
    offset += spec.g2Data
    dataBlocks.push(slice)
    ecBlocks.push(computeRsRemainder(slice, spec.ecPerBlock))
  }

  const maxDataLen = Math.max(spec.g1Data, spec.g2Data)
  const interleavedBytes: number[] = []
  for (let col = 0; col < maxDataLen; col += 1) {
    for (const block of dataBlocks) {
      if (col < block.length) {
        interleavedBytes.push(block[col]!)
      }
    }
  }
  for (let col = 0; col < spec.ecPerBlock; col += 1) {
    for (const block of ecBlocks) {
      interleavedBytes.push(block[col]!)
    }
  }

  const remBits = remainderBitsForVersion(version)
  const bitStream = new Uint8Array(interleavedBytes.length * 8 + remBits)
  let bitPos = 0
  for (const b of interleavedBytes) {
    for (let shift = 7; shift >= 0; shift -= 1) {
      bitStream[bitPos++] = (b >>> shift) & 1
    }
  }
  return bitStream
}

function maskCondition(maskId: number, row: number, col: number): boolean {
  switch (maskId) {
    case 0:
      return (row + col) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (row + col) % 3 === 0
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
    default:
      throw new Error(`Invalid maskId: ${maskId}`)
  }
}

function createFunctionMaskTemplate(version: number): {
  size: number
  isFunction: boolean[][]
  modules: boolean[][]
} {
  const size = 17 + version * 4
  const isFunction = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  const modules = Array.from({ length: size }, () => Array<boolean>(size).fill(false))

  const setFunc = (r: number, c: number, dark: boolean): void => {
    if (r < 0 || r >= size || c < 0 || c >= size) return
    isFunction[r]![c] = true
    modules[r]![c] = dark
  }

  const placeFinderAndSeparator = (top: number, left: number): void => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = top + dr
        const c = left + dc
        if (r < 0 || r >= size || c < 0 || c >= size) continue
        const inFinder = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
        if (!inFinder) {
          setFunc(r, c, false)
        } else {
          const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3))
          setFunc(r, c, dist === 3 || dist <= 1)
        }
      }
    }
  }

  placeFinderAndSeparator(0, 0)
  placeFinderAndSeparator(0, size - 7)
  placeFinderAndSeparator(size - 7, 0)

  // Alignment patterns
  const centers = ALIGNMENT_COORDS[version - 1]!
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = 0; j < centers.length; j += 1) {
      const cr = centers[i]!
      const cc = centers[j]!
      const overlapsTopLeft = i === 0 && j === 0
      const overlapsTopRight = i === 0 && j === centers.length - 1
      const overlapsBottomLeft = i === centers.length - 1 && j === 0
      if (overlapsTopLeft || overlapsTopRight || overlapsBottomLeft) continue
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc))
          setFunc(cr + dr, cc + dc, dist === 2 || dist === 0)
        }
      }
    }
  }

  // Timing patterns
  for (let pos = 8; pos < size - 8; pos += 1) {
    setFunc(6, pos, pos % 2 === 0)
    setFunc(pos, 6, pos % 2 === 0)
  }

  // Dark module
  setFunc(size - 8, 8, true)

  // Reserve format info cells
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setFunc(8, i, false)
      setFunc(i, 8, false)
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setFunc(8, size - 1 - i, false)
  }
  for (let i = 0; i < 7; i += 1) {
    setFunc(size - 1 - i, 8, false)
  }

  // Reserve version info cells (V7+)
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        setFunc(i, size - 11 + j, false)
        setFunc(size - 11 + j, i, false)
      }
    }
  }

  return { size, isFunction, modules }
}

function writeFormatAndVersionBits(
  modules: boolean[][],
  size: number,
  version: number,
  eccLevel: QrErrorCorrectionLevel,
  maskId: number,
): void {
  const formatBits = encodeFormatBits(eccLevel, maskId)
  for (let i = 0; i < 15; i += 1) {
    const bit = ((formatBits >>> i) & 1) === 1
    if (i < 6) {
      modules[i]![8] = bit
    } else if (i < 8) {
      modules[i + 1]![8] = bit
    } else {
      modules[size - 15 + i]![8] = bit
    }
    if (i < 8) {
      modules[8]![size - 1 - i] = bit
    } else if (i < 9) {
      modules[8]![7] = bit
    } else {
      modules[8]![14 - i] = bit
    }
  }

  if (version >= 7) {
    const verBits = encodeVersionBits(version)
    for (let i = 0; i < 18; i += 1) {
      const bit = ((verBits >>> i) & 1) === 1
      const a = Math.floor(i / 3)
      const b = i % 3
      modules[a]![size - 11 + b] = bit
      modules[size - 11 + b]![a] = bit
    }
  }
}

function evaluatePenalty(modules: readonly (readonly boolean[])[], size: number): number {
  let penalty = 0

  for (let r = 0; r < size; r += 1) {
    let runColor = modules[r]![0]!
    let runLen = 1
    for (let c = 1; c < size; c += 1) {
      const cur = modules[r]![c]!
      if (cur === runColor) {
        runLen += 1
      } else {
        if (runLen >= 5) penalty += runLen - 2
        runColor = cur
        runLen = 1
      }
    }
    if (runLen >= 5) penalty += runLen - 2
  }
  for (let c = 0; c < size; c += 1) {
    let runColor = modules[0]![c]!
    let runLen = 1
    for (let r = 1; r < size; r += 1) {
      const cur = modules[r]![c]!
      if (cur === runColor) {
        runLen += 1
      } else {
        if (runLen >= 5) penalty += runLen - 2
        runColor = cur
        runLen = 1
      }
    }
    if (runLen >= 5) penalty += runLen - 2
  }

  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r]![c]!
      if (modules[r]![c + 1] === v && modules[r + 1]![c] === v && modules[r + 1]![c + 1] === v) {
        penalty += 3
      }
    }
  }

  const matchPattern = (get: (i: number) => boolean): number => {
    let count = 0
    for (let start = 0; start <= size - 11; start += 1) {
      const forward =
        get(start) &&
        !get(start + 1) &&
        get(start + 2) &&
        get(start + 3) &&
        get(start + 4) &&
        !get(start + 5) &&
        get(start + 6) &&
        !get(start + 7) &&
        !get(start + 8) &&
        !get(start + 9) &&
        !get(start + 10)
      const backward =
        !get(start) &&
        !get(start + 1) &&
        !get(start + 2) &&
        !get(start + 3) &&
        get(start + 4) &&
        !get(start + 5) &&
        get(start + 6) &&
        get(start + 7) &&
        get(start + 8) &&
        !get(start + 9) &&
        get(start + 10)
      if (forward) count += 40
      if (backward) count += 40
    }
    return count
  }
  for (let i = 0; i < size; i += 1) {
    penalty += matchPattern((idx) => modules[i]![idx]!)
    penalty += matchPattern((idx) => modules[idx]![i]!)
  }

  let darkCount = 0
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r]![c]) darkCount += 1
    }
  }
  const total = size * size
  const percentDiff = Math.abs((darkCount * 100) / total - 50)
  penalty += Math.floor(percentDiff / 5) * 10

  return penalty
}

export function encodeQrMatrix(text: string, eccLevel: QrErrorCorrectionLevel = 'L'): QrMatrix {
  const payload = new Uint8Array(Buffer.from(text, 'utf8'))
  const { version, spec, codewords } = selectVersionAndEncodeData(payload, eccLevel)
  const bitStream = buildFinalBitStream(version, spec, codewords)
  const template = createFunctionMaskTemplate(version)
  const size = template.size

  const rawModules = template.modules.map((row) => [...row])
  let bitIdx = 0
  let upward = true
  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) rightCol = 5
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step
      for (let dc = 0; dc < 2; dc += 1) {
        const c = rightCol - dc
        if (!template.isFunction[r]![c]) {
          rawModules[r]![c] = bitIdx < bitStream.length ? bitStream[bitIdx]! === 1 : false
          bitIdx += 1
        }
      }
    }
    upward = !upward
  }
  if (bitIdx !== bitStream.length) {
    throw new Error(`QR placement mismatch: placed ${bitIdx} of ${bitStream.length} bits`)
  }

  let bestMask = 0
  let bestPenalty = Number.POSITIVE_INFINITY
  let bestModules: boolean[][] | undefined

  for (let maskId = 0; maskId < 8; maskId += 1) {
    const candidate = rawModules.map((row, r) =>
      row.map((val, c) => (template.isFunction[r]![c] ? val : maskCondition(maskId, r, c) ? !val : val)),
    )
    writeFormatAndVersionBits(candidate, size, version, eccLevel, maskId)
    const score = evaluatePenalty(candidate, size)
    if (score < bestPenalty) {
      bestPenalty = score
      bestMask = maskId
      bestModules = candidate
    }
  }

  return {
    version,
    size,
    eccLevel,
    maskId: bestMask,
    modules: bestModules!,
  }
}

/**
 * Renders a QR matrix into Unicode half-block characters (`█`, `▀`, `▄`, ` `)
 * with a crisp quiet zone so terminal users can scan directly from mobile cameras.
 */
export function renderTerminalQr(text: string, options: TerminalQrRenderOptions = {}): string {
  const eccLevel = options.eccLevel ?? 'L'
  const quiet = Math.max(1, options.quietZone ?? 2)
  const ansiWhiteBackground = options.ansiWhiteBackground ?? false
  const qr = encodeQrMatrix(text, eccLevel)
  const totalSize = qr.size + quiet * 2

  const isDark = (r: number, c: number): boolean => {
    const mr = r - quiet
    const mc = c - quiet
    if (mr < 0 || mr >= qr.size || mc < 0 || mc >= qr.size) {
      return false
    }
    return qr.modules[mr]![mc]!
  }

  const lines: string[] = []
  for (let r = 0; r < totalSize; r += 2) {
    let rowStr = ansiWhiteBackground ? '\u001b[107;30m' : ''
    for (let c = 0; c < totalSize; c += 1) {
      const top = isDark(r, c)
      const bottom = r + 1 < totalSize ? isDark(r + 1, c) : false
      if (top && bottom) {
        rowStr += '█'
      } else if (top) {
        rowStr += '▀'
      } else if (bottom) {
        rowStr += '▄'
      } else {
        rowStr += ' '
      }
    }
    if (ansiWhiteBackground) {
      rowStr += '\u001b[0m'
    }
    lines.push(rowStr)
  }
  return lines.join('\n')
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/u

function safeSvgColor(raw: string | undefined, fallback: string): string {
  return raw !== undefined && HEX_COLOR_RE.test(raw) ? raw : fallback
}

function escapeXmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Renders a QR matrix as a CSP-safe inline `<svg>` document fragment using run-length
 * merged `<path>` geometry and zero inline `style=` attributes.
 */
export function renderQrSvg(text: string, options: QrSvgRenderOptions = {}): string {
  const eccLevel = options.eccLevel ?? 'L'
  const quiet = Math.max(2, Math.floor(options.quietZone ?? 4))
  const darkColor = safeSvgColor(options.darkColor, '#101218')
  const lightColor = safeSvgColor(options.lightColor, '#ffffff')
  const label = escapeXmlAttr(options.ariaLabel ?? 'Remote Pairing QR Code')
  const qr = encodeQrMatrix(text, eccLevel)
  const totalSize = qr.size + quiet * 2

  const segments: string[] = []
  for (let r = 0; r < qr.size; r += 1) {
    const row = qr.modules[r]!
    let c = 0
    while (c < qr.size) {
      if (!row[c]) {
        c += 1
        continue
      }
      const start = c
      while (c < qr.size && row[c]) {
        c += 1
      }
      const runLen = c - start
      segments.push(`M${String(start + quiet)} ${String(r + quiet)}h${String(runLen)}v1h-${String(runLen)}z`)
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(totalSize)} ${String(totalSize)}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${String(totalSize)}" height="${String(totalSize)}" fill="${lightColor}"/><path d="${segments.join('')}" fill="${darkColor}"/></svg>`
}
