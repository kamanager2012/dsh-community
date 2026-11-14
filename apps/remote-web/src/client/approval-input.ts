import type { PendingApprovalSnapshot } from './types.ts'

export const MAX_APPROVAL_ARGS_CHARS = 65_536

const TRUNCATION_MARKER_REGEX =
  /(?:… \[truncated(?:, \d+ B total)?\]$|^\[truncated nested value\]$|^… \(\+\d+ items omitted\)$)/u

export interface FormattedApprovalArgs {
  readonly text: string
  readonly truncated: boolean
}

export interface ApprovalInputSecurityAssessment {
  readonly formatted: FormattedApprovalArgs
  readonly truncated: boolean
  readonly unavailable: boolean
  readonly allowBlocked: boolean
  readonly blockReason?: string | undefined
}

export function hasTruncatedApprovalMarker(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === undefined || value === null) return false
  if (typeof value === 'string') {
    return TRUNCATION_MARKER_REGEX.test(value)
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasTruncatedApprovalMarker(item, depth + 1))
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (obj._truncated === true || typeof obj._omittedKeys === 'number') {
      return true
    }
    return Object.values(obj).some((child) => hasTruncatedApprovalMarker(child, depth + 1))
  }
  return false
}

export function formatApprovalArgsDetailed(rawArgs: unknown): FormattedApprovalArgs {
  if (rawArgs === undefined || rawArgs === null) {
    return { text: '', truncated: false }
  }
  let text: string
  if (typeof rawArgs === 'string') {
    text = rawArgs
  } else {
    try {
      text = JSON.stringify(rawArgs, null, 2) ?? ''
    } catch {
      text = String(rawArgs)
    }
  }
  const trimmed = text.trim()
  if (trimmed.length <= MAX_APPROVAL_ARGS_CHARS) {
    return { text: trimmed, truncated: false }
  }
  return {
    text: `${trimmed.slice(0, MAX_APPROVAL_ARGS_CHARS)}\n… (truncated, ${trimmed.length} chars total)`,
    truncated: true,
  }
}

export function isWindowFramed(win?: Window | undefined): boolean {
  const target = win ?? (typeof window !== 'undefined' ? window : undefined)
  if (!target) return false
  try {
    if (target.self !== target.top) return true
  } catch {
    return true
  }
  try {
    if (target.frameElement !== null) return true
  } catch {
    return true
  }
  try {
    const ancestors = (target.location as Location & { readonly ancestorOrigins?: { readonly length: number } }).ancestorOrigins
    if (ancestors && ancestors.length > 0) return true
  } catch {
    return true
  }
  return false
}

function hasMaterialApprovalArgs(value: unknown, formattedText: string): boolean {
  if (formattedText.length === 0) return false
  if (formattedText === '{}' || formattedText === '[]') return false
  if (Array.isArray(value)) return value.length > 0
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0
  }
  return true
}

export function assessApprovalInputSecurity(
  approval: PendingApprovalSnapshot,
  matchedToolArgsText?: string,
  framed = isWindowFramed(),
): ApprovalInputSecurityAssessment {
  const effectiveRawArgs = approval.args !== undefined ? approval.args : matchedToolArgsText
  const formatted = formatApprovalArgsDetailed(effectiveRawArgs)
  if (framed) {
    return {
      formatted,
      truncated: false,
      unavailable: false,
      allowBlocked: true,
      blockReason:
        'Embedded frame execution blocked by anti-clickjacking policy. Open in a top-level tab.',
    }
  }
  const truncated =
    approval.argsTruncated === true ||
    formatted.truncated ||
    hasTruncatedApprovalMarker(effectiveRawArgs) ||
    hasTruncatedApprovalMarker(approval.reason) ||
    hasTruncatedApprovalMarker(approval.summary)
  const unavailable = !hasMaterialApprovalArgs(effectiveRawArgs, formatted.text)

  if (truncated) {
    return {
      formatted,
      truncated: true,
      unavailable,
      allowBlocked: true,
      blockReason:
        'Full tool input is truncated on remote display. Inspect and approve directly on host, or reject here.',
    }
  }
  if (unavailable) {
    return {
      formatted,
      truncated: false,
      unavailable: true,
      allowBlocked: true,
      blockReason:
        'Tool input details are unavailable from host. Inspect on host before approving, or reject here.',
    }
  }
  return {
    formatted,
    truncated: false,
    unavailable: false,
    allowBlocked: false,
  }
}
