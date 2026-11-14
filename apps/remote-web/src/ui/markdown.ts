const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function isSafeLinkUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed, 'https://dsh-community.local')
    // Reject protocol-relative // urls unless normalized under https and not targeting arbitrary host via trick
    if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
      return false
    }
    return true
  } catch {
    return false
  }
}

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
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'fn',
  'func',
  'function',
  'if',
  'impl',
  'import',
  'in',
  'interface',
  'let',
  'match',
  'mut',
  'new',
  'null',
  'pub',
  'readonly',
  'return',
  'self',
  'static',
  'struct',
  'switch',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'use',
  'val',
  'var',
  'void',
  'while',
  'yield',
])

function isCodeWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 // _
  )
}

function isHexDigitCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 70) || // A-F
    (code >= 97 && code <= 102) // a-f
  )
}

function findClosingQuote(text: string, start: number, quote: string): number {
  for (let j = start + 1; j < text.length; j += 1) {
    const ch = text[j]!
    if (ch === '\\') {
      j += 1
      continue
    }
    if (ch === quote) {
      return j
    }
  }
  return -1
}

function appendHighlightedCodeLine(doc: Document, parent: HTMLElement, text: string): void {
  // Single-pass O(n) token classifier without regex backtracking bombs or HTML injection.
  // Once an opener scans to EOF without a closing delimiter, mark that delimiter exhausted
  // so subsequent unclosed openers skip redundant tail scans.
  let cursor = 0
  let i = 0
  let blockCommentExhausted = false
  let doubleQuoteExhausted = false
  let singleQuoteExhausted = false
  let backtickExhausted = false

  const emitToken = (start: number, end: number, cls: string): void => {
    if (start > cursor) {
      parent.appendChild(doc.createTextNode(text.slice(cursor, start)))
    }
    const el = doc.createElement('span')
    el.className = cls
    el.textContent = text.slice(start, end)
    parent.appendChild(el)
    cursor = end
    i = end
  }

  while (i < text.length) {
    const ch = text[i]!

    if ((ch === '/' && text[i + 1] === '/') || ch === '#') {
      const nl = text.indexOf('\n', i + 1)
      const end = nl === -1 ? text.length : nl
      emitToken(i, end, 'tok-comment')
      continue
    }

    if (ch === '/' && text[i + 1] === '*') {
      if (!blockCommentExhausted) {
        const close = text.indexOf('*/', i + 2)
        if (close !== -1) {
          emitToken(i, close + 2, 'tok-comment')
          continue
        }
        blockCommentExhausted = true
      }
      i += 1
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const exhausted =
        ch === '"'
          ? doubleQuoteExhausted
          : ch === "'"
            ? singleQuoteExhausted
            : backtickExhausted
      if (!exhausted) {
        const close = findClosingQuote(text, i, ch)
        if (close !== -1) {
          emitToken(i, close + 1, 'tok-str')
          continue
        }
        if (ch === '"') doubleQuoteExhausted = true
        else if (ch === "'") singleQuoteExhausted = true
        else backtickExhausted = true
      }
      i += 1
      continue
    }

    const code = ch.charCodeAt(0)
    if (isCodeWordChar(code) && (i === 0 || !isCodeWordChar(text.charCodeAt(i - 1)))) {
      if (code >= 48 && code <= 57) {
        let end = i
        if (
          ch === '0' &&
          text[i + 1] === 'x' &&
          i + 2 < text.length &&
          isHexDigitCode(text.charCodeAt(i + 2))
        ) {
          end = i + 2
          while (end < text.length && isHexDigitCode(text.charCodeAt(end))) {
            end += 1
          }
        } else {
          while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) {
            end += 1
          }
          if (
            end < text.length &&
            text[end] === '.' &&
            end + 1 < text.length &&
            text.charCodeAt(end + 1) >= 48 &&
            text.charCodeAt(end + 1) <= 57
          ) {
            end += 1
            while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) {
              end += 1
            }
          }
        }
        if (end === text.length || !isCodeWordChar(text.charCodeAt(end))) {
          emitToken(i, end, 'tok-num')
          continue
        }
        while (end < text.length && isCodeWordChar(text.charCodeAt(end))) {
          end += 1
        }
        i = end
        continue
      }

      let end = i + 1
      while (end < text.length && isCodeWordChar(text.charCodeAt(end))) {
        end += 1
      }
      if (CODE_KEYWORDS.has(text.slice(i, end))) {
        emitToken(i, end, 'tok-kw')
      } else {
        i = end
      }
      continue
    }

    i += 1
  }

  if (cursor < text.length) {
    parent.appendChild(doc.createTextNode(text.slice(cursor)))
  }
}

function appendInlineMarkdown(doc: Document, parent: HTMLElement, text: string, depth = 0): void {
  if (depth > 4) {
    parent.appendChild(doc.createTextNode(text))
    return
  }

  let cursor = 0
  let i = 0
  let backtickExhausted = false
  let doubleStarExhausted = false
  let strikeExhausted = false
  let singleStarFailUntil = -1
  let bracketFailUntil = -1
  let destFailUntil = -1

  const flushPlain = (end: number): void => {
    if (end > cursor) {
      parent.appendChild(doc.createTextNode(text.slice(cursor, end)))
    }
  }

  while (i < text.length) {
    const ch = text[i]!

    if (ch === '`' && !backtickExhausted) {
      const close = text.indexOf('`', i + 1)
      if (close > i + 1) {
        flushPlain(i)
        const code = doc.createElement('code')
        code.className = 'md-inline-code'
        code.textContent = text.slice(i + 1, close)
        parent.appendChild(code)
        i = close + 1
        cursor = i
        continue
      }
      if (close === -1) {
        backtickExhausted = true
      }
      i += 1
      continue
    }

    if (ch === '*' && text[i + 1] === '*' && !doubleStarExhausted) {
      const close = text.indexOf('**', i + 2)
      if (close > i + 2) {
        flushPlain(i)
        const strong = doc.createElement('strong')
        appendInlineMarkdown(doc, strong, text.slice(i + 2, close), depth + 1)
        parent.appendChild(strong)
        i = close + 2
        cursor = i
        continue
      }
      if (close === -1) {
        doubleStarExhausted = true
      }
      i += 1
      continue
    }

    if (ch === '~' && text[i + 1] === '~' && !strikeExhausted) {
      const close = text.indexOf('~~', i + 2)
      if (close > i + 2) {
        flushPlain(i)
        const del = doc.createElement('del')
        appendInlineMarkdown(doc, del, text.slice(i + 2, close), depth + 1)
        parent.appendChild(del)
        i = close + 2
        cursor = i
        continue
      }
      if (close === -1) {
        strikeExhausted = true
      }
      i += 1
      continue
    }

    if (ch === '*' && i > singleStarFailUntil) {
      let scan = i + 1
      while (scan < text.length && text[scan] !== '*' && text[scan] !== '\n') {
        scan += 1
      }
      if (scan < text.length && text[scan] === '*' && scan > i + 1) {
        flushPlain(i)
        const em = doc.createElement('em')
        appendInlineMarkdown(doc, em, text.slice(i + 1, scan), depth + 1)
        parent.appendChild(em)
        i = scan + 1
        cursor = i
        continue
      }
      singleStarFailUntil = scan
      i += 1
      continue
    }

    if (ch === '[' && i > bracketFailUntil) {
      let closeBracket = i + 1
      while (closeBracket < text.length && text[closeBracket] !== ']' && text[closeBracket] !== '\n') {
        closeBracket += 1
      }
      if (
        closeBracket < text.length &&
        text[closeBracket] === ']' &&
        closeBracket > i + 1 &&
        text[closeBracket + 1] === '('
      ) {
        const destStart = closeBracket + 2
        if (destStart > destFailUntil) {
          let closeParen = destStart
          while (
            closeParen < text.length &&
            text[closeParen] !== ')' &&
            !/\s/u.test(text[closeParen]!)
          ) {
            closeParen += 1
          }
          if (closeParen < text.length && text[closeParen] === ')' && closeParen > destStart) {
            flushPlain(i)
            const label = text.slice(i + 1, closeBracket)
            const href = text.slice(destStart, closeParen)
            if (isSafeLinkUrl(href)) {
              const a = doc.createElement('a')
              a.href = href
              a.target = '_blank'
              a.rel = 'noopener noreferrer'
              a.textContent = label
              parent.appendChild(a)
            } else {
              parent.appendChild(doc.createTextNode(`${label} (${href})`))
            }
            i = closeParen + 1
            cursor = i
            continue
          }
          if (
            (closeParen === text.length || /\s/u.test(text[closeParen]!)) &&
            closeParen > destFailUntil
          ) {
            destFailUntil = closeParen
          }
        }
      }
      if (closeBracket > bracketFailUntil) {
        bracketFailUntil = closeBracket
      }
      i += 1
      continue
    }

    i += 1
  }

  flushPlain(text.length)
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  return /^\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?\|?$/.test(trimmed)
}

const MAX_MARKDOWN_BLOCK_DEPTH = 16

export function renderMarkdown(doc: Document, source: string): HTMLElement {
  const root = doc.createElement('div')
  root.className = 'md-root'
  renderMarkdownBlock(doc, source, 0, root)
  return root
}

function renderMarkdownBlock(
  doc: Document,
  source: string,
  depth: number,
  root: HTMLElement,
): void {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    if (!trimmed) {
      i += 1
      continue
    }

    // Fenced code block
    const fenceMatch = /^```([^\s`]*)/.exec(trimmed)
    if (fenceMatch) {
      const lang = fenceMatch[1] || 'text'
      i += 1
      const codeLines: string[] = []
      while (i < lines.length && !/^```/.test(lines[i]!.trim())) {
        codeLines.push(lines[i]!)
        i += 1
      }
      if (i < lines.length && /^```/.test(lines[i]!.trim())) {
        i += 1
      }

      const wrapper = doc.createElement('div')
      wrapper.className = 'md-code-block'
      const header = doc.createElement('div')
      header.className = 'md-code-header'
      const langBadge = doc.createElement('span')
      langBadge.className = 'md-code-lang'
      langBadge.textContent = lang
      const copyBtn = doc.createElement('button')
      copyBtn.type = 'button'
      copyBtn.className = 'btn-ghost btn-xs'
      copyBtn.textContent = 'Copy'
      const codeText = codeLines.join('\n')
      copyBtn.addEventListener('click', () => {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          void navigator.clipboard.writeText(codeText).then(() => {
            copyBtn.textContent = 'Copied'
            setTimeout(() => {
              copyBtn.textContent = 'Copy'
            }, 1500)
          })
        }
      })
      header.append(langBadge, copyBtn)

      const pre = doc.createElement('pre')
      const codeEl = doc.createElement('code')
      appendHighlightedCodeLine(doc, codeEl, codeText)
      pre.appendChild(codeEl)
      wrapper.append(header, pre)
      root.appendChild(wrapper)
      continue
    }

    // Horizontal rule
    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      root.appendChild(doc.createElement('hr'))
      i += 1
      continue
    }

    // Headings
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (headingMatch) {
      const level = Math.min(6, Math.max(1, headingMatch[1]!.length))
      const h = doc.createElement(`h${level}`)
      appendInlineMarkdown(doc, h, headingMatch[2]!)
      root.appendChild(h)
      i += 1
      continue
    }

    // Blockquote
    if (depth < MAX_MARKDOWN_BLOCK_DEPTH && trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ''))
        i += 1
      }
      const bq = doc.createElement('blockquote')
      renderMarkdownBlock(doc, quoteLines.join('\n'), depth + 1, bq)
      root.appendChild(bq)
      continue
    }

    // GFM Pipe Table
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const headers = splitTableRow(line)
      i += 2
      const tableWrap = doc.createElement('div')
      tableWrap.className = 'md-table-wrap'
      const table = doc.createElement('table')
      const thead = doc.createElement('thead')
      const trHead = doc.createElement('tr')
      for (const h of headers) {
        const th = doc.createElement('th')
        appendInlineMarkdown(doc, th, h)
        trHead.appendChild(th)
      }
      thead.appendChild(trHead)
      table.appendChild(thead)

      const tbody = doc.createElement('tbody')
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim().length > 0) {
        const cells = splitTableRow(lines[i]!)
        const tr = doc.createElement('tr')
        for (let c = 0; c < headers.length; c += 1) {
          const td = doc.createElement('td')
          appendInlineMarkdown(doc, td, cells[c] ?? '')
          tr.appendChild(td)
        }
        tbody.appendChild(tr)
        i += 1
      }
      table.appendChild(tbody)
      tableWrap.appendChild(table)
      root.appendChild(tableWrap)
      continue
    }

    // Lists (ordered & unordered)
    const ulMatch = /^[-*+]\s+(.+)$/.exec(trimmed)
    const olMatch = /^\d+\.\s+(.+)$/.exec(trimmed)
    if (ulMatch || olMatch) {
      const isOrdered = Boolean(olMatch)
      const list = doc.createElement(isOrdered ? 'ol' : 'ul')
      while (i < lines.length) {
        const cur = lines[i]!.trim()
        const m = isOrdered ? /^\d+\.\s+(.+)$/.exec(cur) : /^[-*+]\s+(.+)$/.exec(cur)
        if (!m) break
        const li = doc.createElement('li')
        const itemText = m[1]!
        const taskMatch = /^\[( |x|X)\]\s+(.+)$/.exec(itemText)
        if (taskMatch) {
          const box = doc.createElement('span')
          const checked = taskMatch[1]!.toLowerCase() === 'x'
          box.className = checked ? 'todo-box done' : 'todo-box'
          box.textContent = checked ? '[x] ' : '[ ] '
          li.appendChild(box)
          appendInlineMarkdown(doc, li, taskMatch[2]!)
        } else {
          appendInlineMarkdown(doc, li, itemText)
        }
        list.appendChild(li)
        i += 1
      }
      root.appendChild(list)
      continue
    }

    // Paragraph (stop before next block token)
    const paraLines: string[] = []
    while (i < lines.length) {
      const cur = lines[i]!
      const curTrim = cur.trim()
      if (
        !curTrim ||
        curTrim.startsWith('```') ||
        (depth < MAX_MARKDOWN_BLOCK_DEPTH && curTrim.startsWith('>')) ||
        /^(#{1,6})\s+/.test(curTrim) ||
        /^[-*+]\s+/.test(curTrim) ||
        /^\d+\.\s+/.test(curTrim) ||
        /^(?:---|\*\*\*|___)\s*$/.test(curTrim)
      ) {
        break
      }
      paraLines.push(cur)
      i += 1
    }
    const p = doc.createElement('p')
    appendInlineMarkdown(doc, p, paraLines.join('\n'))
    root.appendChild(p)
  }
}

export function renderUnifiedDiff(doc: Document, diffText: string): HTMLElement {
  const container = doc.createElement('div')
  container.className = 'diff-root'

  if (!diffText.trim()) {
    const empty = doc.createElement('div')
    empty.className = 'empty-muted'
    empty.textContent = 'No diff lines for the selected filter.'
    container.appendChild(empty)
    return container
  }

  const lines = diffText.replace(/\r\n?/g, '\n').split('\n')
  let currentFileCard: HTMLElement | undefined = undefined
  let currentLinesContainer: HTMLElement | undefined = undefined

  const ensureCard = (title: string): HTMLElement => {
    const card = doc.createElement('section')
    card.className = 'diff-file-card'
    const header = doc.createElement('div')
    header.className = 'diff-file-header'
    header.textContent = title
    const body = doc.createElement('div')
    body.className = 'diff-file-body'
    card.append(header, body)
    container.appendChild(card)
    currentFileCard = card
    currentLinesContainer = body
    return body
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const parts = line.slice('diff --git '.length).split(' b/')
      const title = parts[1] ? parts[1] : line.slice('diff --git '.length)
      ensureCard(title)
      continue
    }

    const body = currentLinesContainer ?? (currentFileCard ? currentLinesContainer : ensureCard('Patch'))!
    const row = doc.createElement('div')
    row.className = 'diff-line'
    if (line.startsWith('@@')) {
      row.classList.add('diff-hunk')
    } else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) {
      row.classList.add('diff-meta')
    } else if (line.startsWith('+')) {
      row.classList.add('diff-add')
    } else if (line.startsWith('-')) {
      row.classList.add('diff-del')
    } else {
      row.classList.add('diff-ctx')
    }
    row.textContent = line || ' '
    body.appendChild(row)
  }

  return container
}
