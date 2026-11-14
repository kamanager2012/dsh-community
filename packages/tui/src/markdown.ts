/**
 * Pure TypeScript Markdown-to-ANSI SGR renderer for the terminal UI.
 * Sanitizes untrusted control sequences before styling and closes SGR
 * attributes at the end of every output line so Ink wrapping never bleeds.
 */

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const BOLD_OFF = '\x1b[22m'
const DIM = '\x1b[2m'
const ITALIC = '\x1b[3m'
const ITALIC_OFF = '\x1b[23m'
const UNDERLINE = '\x1b[4m'
const UNDERLINE_OFF = '\x1b[24m'
const STRIKE = '\x1b[9m'
const STRIKE_OFF = '\x1b[29m'
const FG_CYAN = '\x1b[36m'
const FG_GREEN = '\x1b[32m'
const FG_YELLOW = '\x1b[33m'
const FG_MAGENTA = '\x1b[35m'
const FG_GRAY = '\x1b[90m'

const CODE_KEYWORDS = new Set([
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'interface',
  'let',
  'new',
  'null',
  'of',
  'readonly',
  'return',
  'static',
  'switch',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'def',
  'elif',
  'None',
  'True',
  'False',
  'fn',
  'impl',
  'pub',
  'struct',
  'enum',
  'match',
])

/**
 * Removes raw ANSI/OSC escape sequences and dangerous C0/C1 terminal controls
 * from untrusted model or repository text before terminal rendering.
 */
export function stripUnsafeTerminalControls(raw: string): string {
  return raw
    .replace(/\r\n?/gu, '\n')
    // Strip OSC/CSI/single-ESC sequences if present in untrusted text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/gu, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\x1b[^\n]?/gu, '')
    // Strip remaining non-printable C0/C1 control characters except \n and \t
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, '')
    .replace(/\t/gu, '  ')
}

function highlightCodeLine(line: string, lang: string): string {
  const lowerLang = lang.toLowerCase()
  const supportsHashComment =
    lowerLang === 'py'
    || lowerLang === 'python'
    || lowerLang === 'sh'
    || lowerLang === 'bash'
    || lowerLang === 'zsh'
    || lowerLang === 'yaml'
    || lowerLang === 'yml'
    || lowerLang === 'toml'

  let out = ''
  let i = 0
  while (i < line.length) {
    // Line comments: // or # (for shell/python/yaml)
    if (
      (line[i] === '/' && line[i + 1] === '/')
      || (supportsHashComment && line[i] === '#' && (i === 0 || /\s/u.test(line[i - 1]!)))
    ) {
      out += `${FG_GRAY}${line.slice(i)}${RESET}`
      break
    }

    // String literal
    const ch = line[i]!
    if (ch === '"' || ch === '\'' || ch === '`') {
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\' && j + 1 < line.length) {
          j += 2
          continue
        }
        if (line[j] === ch) {
          j += 1
          break
        }
        j += 1
      }
      out += `${FG_GREEN}${line.slice(i, j)}${RESET}`
      i = j
      continue
    }

    // Numeric literal
    if (/[0-9]/u.test(ch) && (i === 0 || !/[A-Za-z0-9_]/u.test(line[i - 1]!))) {
      let j = i + 1
      while (j < line.length && /[0-9a-fA-FxXoObB_.]/u.test(line[j]!)) j += 1
      out += `${FG_MAGENTA}${line.slice(i, j)}${RESET}`
      i = j
      continue
    }

    // Identifier / keyword
    if (/[A-Za-z_]/u.test(ch)) {
      let j = i + 1
      while (j < line.length && /[A-Za-z0-9_]/u.test(line[j]!)) j += 1
      const word = line.slice(i, j)
      out += CODE_KEYWORDS.has(word) ? `${FG_CYAN}${word}${RESET}` : word
      i = j
      continue
    }

    out += ch
    i += 1
  }
  return out
}

function renderInlineSegment(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    // Markdown link [label](url)
    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1)
      if (closeBracket > i + 1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2)
        if (closeParen > closeBracket + 2) {
          const label = text.slice(i + 1, closeBracket)
          const href = text.slice(closeBracket + 2, closeParen)
          out += `${UNDERLINE}${renderInlineSegment(label)}${UNDERLINE_OFF} ${FG_GRAY}(${href})${RESET}`
          i = closeParen + 1
          continue
        }
      }
    }

    // Bold **...** or __...__
    if (
      (text[i] === '*' && text[i + 1] === '*')
      || (text[i] === '_' && text[i + 1] === '_')
    ) {
      const delim = text.slice(i, i + 2)
      const end = text.indexOf(delim, i + 2)
      if (end > i + 2) {
        out += `${BOLD}${renderInlineSegment(text.slice(i + 2, end))}${BOLD_OFF}`
        i = end + 2
        continue
      }
    }

    // Strikethrough ~~...~~
    if (text[i] === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2)
      if (end > i + 2) {
        out += `${STRIKE}${renderInlineSegment(text.slice(i + 2, end))}${STRIKE_OFF}`
        i = end + 2
        continue
      }
    }

    // Italic *...* or boundary-safe _..._ (never break snake_case_identifiers)
    if (text[i] === '*' || text[i] === '_') {
      const marker = text[i]!
      const prev = i > 0 ? text[i - 1]! : ''
      const next = text[i + 1] ?? ''
      const wordChar = /[A-Za-z0-9]/u
      const validOpen =
        next !== ''
        && !/\s/u.test(next)
        && (marker === '*' || !wordChar.test(prev))
      if (validOpen) {
        let search = i + 1
        let matchedItalic = false
        while (search < text.length) {
          const idx = text.indexOf(marker, search)
          if (idx === -1) break
          const beforeClose = text[idx - 1] ?? ''
          const afterClose = text[idx + 1] ?? ''
          if (
            idx > i + 1
            && !/\s/u.test(beforeClose)
            && (marker === '*' || !wordChar.test(afterClose))
          ) {
            out += `${ITALIC}${renderInlineSegment(text.slice(i + 1, idx))}${ITALIC_OFF}`
            i = idx + 1
            matchedItalic = true
            break
          }
          search = idx + 1
        }
        if (matchedItalic) continue
      }
    }

    out += text[i]
    i += 1
  }
  return out
}

function renderInlineMarkdown(line: string): string {
  // Split out backtick code spans first so markers inside `...` are left verbatim
  let out = ''
  let i = 0
  let plainStart = 0
  while (i < line.length) {
    if (line[i] === '`') {
      let ticks = 1
      while (line[i + ticks] === '`') ticks += 1
      const delim = '`'.repeat(ticks)
      const closeIdx = line.indexOf(delim, i + ticks)
      if (closeIdx !== -1) {
        if (i > plainStart) {
          out += renderInlineSegment(line.slice(plainStart, i))
        }
        const codeText = line.slice(i + ticks, closeIdx)
        out += `${FG_CYAN}${codeText}${RESET}`
        i = closeIdx + ticks
        plainStart = i
        continue
      }
    }
    i += 1
  }
  if (plainStart < line.length) {
    out += renderInlineSegment(line.slice(plainStart))
  }
  return out
}

export function renderMarkdownToAnsi(markdown: string): string {
  const safe = stripUnsafeTerminalControls(markdown)
  if (safe === '') return ''

  const lines = safe.split('\n')
  const rendered: string[] = []
  let fenceChar: '`' | '~' | undefined = undefined
  let fenceLen = 0
  let fenceLang = ''

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/u.exec(trimmed)

    if (fenceChar === undefined) {
      if (fenceMatch) {
        const marker = fenceMatch[1]!
        fenceChar = marker[0] as '`' | '~'
        fenceLen = marker.length
        fenceLang = fenceMatch[2]!.trim().split(/\s+/u, 1)[0] ?? ''
        const label = fenceLang ? ` ${fenceLang} ` : ' code '
        rendered.push(`${DIM}${FG_CYAN}┌─${label}──────────────${RESET}`)
        continue
      }
    } else {
      if (
        fenceMatch
        && fenceMatch[1]![0] === fenceChar
        && fenceMatch[1]!.length >= fenceLen
        && fenceMatch[2]!.trim() === ''
      ) {
        rendered.push(`${DIM}${FG_CYAN}└──────────────────────${RESET}`)
        fenceChar = undefined
        fenceLen = 0
        fenceLang = ''
        continue
      }
      rendered.push(`${DIM}│${RESET} ${highlightCodeLine(rawLine, fenceLang)}${RESET}`)
      continue
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(trimmed)) {
      rendered.push(`${FG_GRAY}────────────────────────${RESET}`)
      continue
    }

    // Heading (# through ######)
    const headingMatch = /^(#{1,6})\s+(.+)$/u.exec(rawLine)
    if (headingMatch) {
      const level = headingMatch[1]!.length
      const color = level <= 2 ? FG_CYAN : FG_YELLOW
      rendered.push(`${BOLD}${color}${renderInlineMarkdown(headingMatch[2]!.trim())}${RESET}`)
      continue
    }

    // Blockquote (> ...)
    const quoteMatch = /^\s*>\s?(.*)$/u.exec(rawLine)
    if (quoteMatch) {
      rendered.push(`${FG_GRAY}│${RESET} ${ITALIC}${renderInlineMarkdown(quoteMatch[1]!)}${RESET}`)
      continue
    }

    // Task checklist item (- [x] / - [ ])
    const taskMatch = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/u.exec(rawLine)
    if (taskMatch) {
      const checked = taskMatch[2]!.toLowerCase() === 'x'
      const mark = checked ? `${FG_GREEN}☑${RESET}` : `${FG_GRAY}☐${RESET}`
      rendered.push(`${taskMatch[1]}${mark} ${renderInlineMarkdown(taskMatch[3]!)}${RESET}`)
      continue
    }

    // Unordered bullet (- / * / +)
    const bulletMatch = /^(\s*)[-*+]\s+(.*)$/u.exec(rawLine)
    if (bulletMatch) {
      rendered.push(`${bulletMatch[1]}${FG_CYAN}•${RESET} ${renderInlineMarkdown(bulletMatch[2]!)}${RESET}`)
      continue
    }

    // Ordered list (1. ...)
    const orderedMatch = /^(\s*)(\d+)\.\s+(.*)$/u.exec(rawLine)
    if (orderedMatch) {
      rendered.push(
        `${orderedMatch[1]}${FG_CYAN}${orderedMatch[2]}.${RESET} ${renderInlineMarkdown(orderedMatch[3]!)}${RESET}`,
      )
      continue
    }

    // Markdown table separator row
    if (/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/u.test(rawLine)) {
      rendered.push(`${FG_GRAY}${rawLine.trim()}${RESET}`)
      continue
    }

    // Markdown table content row
    if (/^\s*\|.*\|\s*$/u.test(rawLine)) {
      const cells = rawLine
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => renderInlineMarkdown(c.trim()))
      rendered.push(`${FG_GRAY}│${RESET} ${cells.join(` ${FG_GRAY}│${RESET} `)} ${FG_GRAY}│${RESET}`)
      continue
    }

    if (rawLine === '') {
      rendered.push('')
      continue
    }

    rendered.push(`${renderInlineMarkdown(rawLine)}${RESET}`)
  }

  return rendered.join('\n')
}
