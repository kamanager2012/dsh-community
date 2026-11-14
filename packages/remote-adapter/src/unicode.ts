/**
 * Replaces unpaired UTF-16 surrogates with U+FFFD so truncated previews,
 * search snippets, and session titles always remain valid Unicode strings.
 */
export function sanitizeLoneSurrogates(input: string): string {
  if (input.length === 0) return input
  let hasLone = false
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1
      } else {
        hasLone = true
        break
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      hasLone = true
      break
    }
  }
  if (!hasLone) return input

  let out = ''
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input.slice(i, i + 2)
        i += 1
      } else {
        out += '\uFFFD'
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\uFFFD'
    } else {
      out += input[i]!
    }
  }
  return out
}

/**
 * Truncates `input` at a Unicode code-point boundary (`maxCodePoints >= 1`),
 * never splitting UTF-16 surrogate pairs.
 */
export function truncateByCodePoints(
  input: string,
  maxCodePoints: number,
  ellipsis = '…',
): string {
  const clean = sanitizeLoneSurrogates(input)
  if (maxCodePoints <= 0) return ellipsis
  if (clean.length <= maxCodePoints) return clean
  const cps = Array.from(clean)
  if (cps.length <= maxCodePoints) return clean
  return `${cps.slice(0, maxCodePoints).join('')}${ellipsis}`
}

/**
 * Extracts a bounded search snippet around a UTF-16 match range `[matchCharIndex, matchCharIndex + matchCharLength)`
 * using Unicode code-point boundaries so surrogate pairs around window edges stay intact.
 */
export function extractCodePointSnippet(
  input: string,
  matchCharIndex: number,
  matchCharLength: number,
  beforeCodePoints = 24,
  afterCodePoints = 48,
): string {
  const clean = sanitizeLoneSurrogates(input)
  const boundedStartUtf16 = Math.max(0, Math.min(clean.length, matchCharIndex))
  const boundedEndUtf16 = Math.max(boundedStartUtf16, Math.min(clean.length, matchCharIndex + matchCharLength))

  const cps = Array.from(clean)
  let utf16Cursor = 0
  let matchStartCp = 0
  let matchEndCp = cps.length
  let foundStart = false

  for (let cpIdx = 0; cpIdx < cps.length; cpIdx += 1) {
    const step = cps[cpIdx]!.length
    if (!foundStart && utf16Cursor + step > boundedStartUtf16) {
      matchStartCp = cpIdx
      foundStart = true
    }
    if (utf16Cursor + step >= boundedEndUtf16) {
      matchEndCp = cpIdx + 1
      break
    }
    utf16Cursor += step
  }

  const startCp = Math.max(0, matchStartCp - Math.max(0, beforeCodePoints))
  const endCp = Math.min(cps.length, matchEndCp + Math.max(0, afterCodePoints))
  const body = cps.slice(startCp, endCp).join('')
  return `${startCp > 0 ? '…' : ''}${body}${endCp < cps.length ? '…' : ''}`
}
