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

const CODE_KEYWORD_RE =
  /\b(?:async|await|break|case|catch|class|const|continue|default|else|enum|export|extends|false|finally|for|from|fn|func|function|if|impl|import|in|interface|let|match|mut|new|null|pub|readonly|return|self|static|struct|switch|throw|true|try|type|typeof|undefined|use|val|var|void|while|yield)\b/g
const CODE_COMMENT_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*$)/gm
const CODE_STRING_RE = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g
const CODE_NUMBER_RE = /\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b/g

function appendHighlightedCodeLine(doc: Document, parent: HTMLElement, text: string): void {
  // Deterministic token classification without regex backtracking bombs or HTML injection
  interface Span {
    start: number
    end: number
    cls: string
  }
  const spans: Span[] = []

  const collect = (re: RegExp, cls: string): void => {
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      if (match[0].length === 0) break
      spans.push({ start: match.index, end: match.index + match[0].length, cls })
    }
  }

  collect(CODE_COMMENT_RE, 'tok-comment')
  collect(CODE_STRING_RE, 'tok-str')
  collect(CODE_KEYWORD_RE, 'tok-kw')
  collect(CODE_NUMBER_RE, 'tok-num')

  spans.sort((a, b) => a.start - b.start || b.end - a.end)

  let cursor = 0
  for (const sp of spans) {
    if (sp.start < cursor) continue
    if (sp.start > cursor) {
      parent.appendChild(doc.createTextNode(text.slice(cursor, sp.start)))
    }
    const el = doc.createElement('span')
    el.className = sp.cls
    el.textContent = text.slice(sp.start, sp.end)
    parent.appendChild(el)
    cursor = sp.end
  }
  if (cursor < text.length) {
    parent.appendChild(doc.createTextNode(text.slice(cursor)))
  }
}

function appendInlineMarkdown(doc: Document, parent: HTMLElement, text: string): void {
  const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*\n]+\*|\[([^\]\n]+)\]\(([^)\s]+)\))/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > cursor) {
      parent.appendChild(doc.createTextNode(text.slice(cursor, match.index)))
    }
    const tok = match[0]
    if (tok.startsWith('`') && tok.endsWith('`')) {
      const code = doc.createElement('code')
      code.className = 'md-inline-code'
      code.textContent = tok.slice(1, -1)
      parent.appendChild(code)
    } else if (tok.startsWith('**') && tok.endsWith('**')) {
      const strong = doc.createElement('strong')
      appendInlineMarkdown(doc, strong, tok.slice(2, -2))
      parent.appendChild(strong)
    } else if (tok.startsWith('~~') && tok.endsWith('~~')) {
      const del = doc.createElement('del')
      appendInlineMarkdown(doc, del, tok.slice(2, -2))
      parent.appendChild(del)
    } else if (tok.startsWith('*') && tok.endsWith('*')) {
      const em = doc.createElement('em')
      appendInlineMarkdown(doc, em, tok.slice(1, -1))
      parent.appendChild(em)
    } else if (tok.startsWith('[') && match[2] !== undefined && match[3] !== undefined) {
      const label = match[2]
      const href = match[3]
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
    }
    cursor = match.index + tok.length
  }

  if (cursor < text.length) {
    parent.appendChild(doc.createTextNode(text.slice(cursor)))
  }
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  return /^\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?\|?$/.test(trimmed)
}

export function renderMarkdown(doc: Document, source: string): HTMLElement {
  const root = doc.createElement('div')
  root.className = 'md-root'
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
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ''))
        i += 1
      }
      const bq = doc.createElement('blockquote')
      const inner = renderMarkdown(doc, quoteLines.join('\n'))
      while (inner.firstChild) {
        bq.appendChild(inner.firstChild)
      }
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
        curTrim.startsWith('>') ||
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

  return root
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
