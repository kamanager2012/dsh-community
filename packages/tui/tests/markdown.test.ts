import { describe, expect, it } from 'vitest'
import { renderMarkdownToAnsi, stripUnsafeTerminalControls } from '../src/markdown.js'

const ESC = '\x1b'

describe('TUI pure-TS ANSI markdown renderer', () => {
  it('strips untrusted CSI and OSC escape sequences to prevent terminal injection', () => {
    const raw = `Hello ${ESC}[2J${ESC}[31mevil${ESC}[0m and ${ESC}]8;;https://bad.example${ESC}\\click${ESC}]8;;${ESC}\\ world`
    expect(stripUnsafeTerminalControls(raw)).toBe('Hello evil and click world')

    const rendered = renderMarkdownToAnsi(`Try ${ESC}[2J**safe** output`)
    expect(rendered).not.toContain('[2J')
    expect(rendered).toContain(`${ESC}[1msafe${ESC}[22m`)
  })

  it('renders headings, inline spans, preserves snake_case identifiers, and terminates styles per line', () => {
    const md = [
      '# Title Line',
      '',
      'Use `my_func_name` with snake_case_var and *italic_words* plus **bold** and ~~old~~.',
      '- [x] Checked item with [link](https://example.com)',
      '> Quoted `code *not italic*` line',
    ].join('\n')

    const out = renderMarkdownToAnsi(md)
    const lines = out.split('\n')
    expect(lines[0]).toContain(`${ESC}[1m${ESC}[36mTitle Line${ESC}[0m`)
    expect(lines[2]).toContain(`${ESC}[36mmy_func_name${ESC}[0m`)
    expect(lines[2]).toContain('snake_case_var')
    expect(lines[2]).not.toContain(`${ESC}[3mcase`)
    expect(lines[2]).toContain(`${ESC}[3mitalic_words${ESC}[23m`)
    expect(lines[2]).toContain(`${ESC}[1mbold${ESC}[22m`)
    expect(lines[2]).toContain(`${ESC}[9mold${ESC}[29m`)
    expect(lines[3]).toContain('☑')
    expect(lines[3]).toContain(`${ESC}[4mlink${ESC}[24m`)
    expect(lines[4]).toContain(`${ESC}[36mcode *not italic*${ESC}[0m`)

    for (const line of lines) {
      if (line.includes(ESC)) {
        expect(line.endsWith(`${ESC}[0m`)).toBe(true)
      }
    }
  })

  it('renders complete and streaming unclosed fenced code blocks without hanging on unclosed delimiters', () => {
    const complete = ['```ts', 'const x = 42 // answer', '```'].join('\n')
    const outComplete = renderMarkdownToAnsi(complete)
    expect(outComplete).toContain('ts')
    expect(outComplete).toContain(`${ESC}[36mconst${ESC}[0m`)
    expect(outComplete).toContain(`${ESC}[35m42${ESC}[0m`)
    expect(outComplete).toContain(`${ESC}[90m// answer${ESC}[0m`)
    expect(outComplete).toContain('└')

    const streamingOpen = ['```py', 'def greet():', '  return "hi"'].join('\n')
    const outStreaming = renderMarkdownToAnsi(streamingOpen)
    expect(outStreaming).toContain('py')
    expect(outStreaming).toContain(`${ESC}[36mdef${ESC}[0m`)
    expect(outStreaming).toContain(`${ESC}[32m"hi"${ESC}[0m`)

    // Regression guard: closed italic followed immediately by unclosed * must terminate cleanly
    const tricky = '*hello**unclosed'
    expect(renderMarkdownToAnsi(tricky)).toContain(`${ESC}[3mhello${ESC}[23m*unclosed`)
  })
})
