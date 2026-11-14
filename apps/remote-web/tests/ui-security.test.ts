import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { InMemoryHostIdentityStore, computeFingerprint } from '@dsh-community/remote-adapter'
import { parsePairingInput, validateStunOnlyUrls } from '../src/client/pairing.ts'
import { SessionTimelineState } from '../src/client/timeline.ts'
import {
  DataChannelFrameReassembler,
  encodeDataChannelChunks,
} from '../src/client/transports.ts'
import { bytesToHex, sha256Hex, utf8Encode } from '../src/crypto/bytes.ts'
import { isSafeLinkUrl, renderMarkdown, renderUnifiedDiff } from '../src/ui/markdown.ts'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

interface FakeElement {
  tagName: string
  className: string
  textContent: string
  href?: string
  rel?: string
  target?: string
  type?: string
  children: Array<FakeElement | { nodeType: 3; textContent: string }>
  appendChild(child: unknown): unknown
  append(...kids: unknown[]): void
  addEventListener(): void
  readonly firstChild: unknown
  readonly classList: { add(c: string): void }
}

function createMinimalDoc(): Document {
  const makeEl = (tag: string): FakeElement => {
    const el: FakeElement = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      children: [],
      appendChild(child: unknown) {
        el.children.push(child as FakeElement)
        return child
      },
      append(...kids: unknown[]) {
        for (const k of kids) el.children.push(k as FakeElement)
      },
      addEventListener() {},
      get firstChild() {
        return el.children[0] ?? null
      },
      classList: {
        add(c: string) {
          el.className = el.className ? `${el.className} ${c}` : c
        },
      },
    }
    return el
  }
  return {
    createElement: (tag: string) => makeEl(tag),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
  } as unknown as Document
}

function collectTagsAndLinks(node: unknown, tags: string[], hrefs: string[]): void {
  if (!node || typeof node !== 'object') return
  const el = node as FakeElement
  if (el.tagName) {
    tags.push(el.tagName)
    if (el.tagName === 'A' && el.href) hrefs.push(el.href)
  }
  if (Array.isArray(el.children)) {
    for (const c of el.children) collectTagsAndLinks(c, tags, hrefs)
  }
}

describe('remote-web pairing security, safe Markdown/Diff DOM, and CSP hygiene', () => {
  it('enforces R3 STUN-only ICE URLs, fingerprint binding, expiry, and forbidden fields in pairing parser', async () => {
    const kp = (await new InMemoryHostIdentityStore().loadOrCreate()).identity
    const pubHex = bytesToHex(kp.publicKey)
    const fp = await sha256Hex(kp.publicKey)
    expect(fp).toBe(computeFingerprint(kp.publicKey))

    const validObj = {
      protocolVersion: 1,
      hostPublicKeyHex: pubHex,
      hostFingerprint: fp,
      bootstrapToken: 'tok-valid-1234',
      endpointUrl: 'ws://127.0.0.1:9001',
      expiresAt: Date.now() + 60_000,
      stunUrls: ['stun:127.0.0.1:3478'],
    }
    const parsed = await parsePairingInput(JSON.stringify(validObj))
    expect(parsed.hostFingerprint).toBe(fp)

    // Also parse web URL with `#pair=`
    const b64url = Buffer.from(JSON.stringify(validObj), 'utf8').toString('base64url')
    const viaHashUrl = await parsePairingInput(`https://relay.example.com/app/#pair=${b64url}`)
    expect(viaHashUrl.bootstrapToken).toBe('tok-valid-1234')

    // Reject expired link
    await expect(
      parsePairingInput(JSON.stringify({ ...validObj, expiresAt: Date.now() - 1000 })),
    ).rejects.toThrow(/expired/i)

    // Reject hostFingerprint mismatch
    await expect(
      parsePairingInput(JSON.stringify({ ...validObj, hostFingerprint: '0'.repeat(64) })),
    ).rejects.toThrow(/does not match/i)

    // Reject forbidden credential/session fields
    await expect(
      parsePairingInput(JSON.stringify({ ...validObj, sessionId: 'leak' })),
    ).rejects.toThrow(/Forbidden field/i)

    // Reject TURN/TURNS URLs (R3)
    expect(() => validateStunOnlyUrls(['turn:turn.example.com:3478'])).toThrow(/only self-owned stun:/i)
    await expect(
      parsePairingInput(JSON.stringify({ ...validObj, stunUrls: ['turns:relay.example.com'] })),
    ).rejects.toThrow(/stun:/i)
  })

  it('blocks XSS script injection and javascript:/data: URLs in Markdown and parses unified diffs safely', () => {
    expect(isSafeLinkUrl('https://github.com/kamanager2012/dsh-community')).toBe(true)
    expect(isSafeLinkUrl('mailto:test@example.com')).toBe(true)
    expect(isSafeLinkUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeLinkUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeLinkUrl('vbscript:msgbox(1)')).toBe(false)

    const doc = createMinimalDoc()
    const rendered = renderMarkdown(
      doc,
      [
        '# Report',
        '<script>alert(1)</script>',
        'Look [bad](javascript:alert(1)) and [good](https://example.org) and ![x](data:text/html,foo)',
        '',
        '| Col A | Col B |',
        '| --- | --- |',
        '| `ok` | **bold** |',
        '',
        '```ts',
        'const x = 42',
        '```',
      ].join('\n'),
    )
    const tags: string[] = []
    const hrefs: string[] = []
    collectTagsAndLinks(rendered, tags, hrefs)

    expect(tags).not.toContain('SCRIPT')
    expect(tags).not.toContain('IMG')
    expect(tags).toContain('TABLE')
    expect(tags).toContain('PRE')
    expect(hrefs).toEqual(['https://example.org'])

    const diffTree = renderUnifiedDiff(
      doc,
      'diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
    )
    const diffTags: string[] = []
    collectTagsAndLinks(diffTree, diffTags, [])
    expect(diffTags).toContain('SECTION')
    expect((diffTree as unknown as FakeElement).children.length).toBe(1)
    void utf8Encode
  })

  it('uses zero innerHTML in src/ and maintains strict CSP + zero inline scripts in public/index.html', () => {
    for (const file of walkFiles(join(APP_ROOT, 'src'))) {
      const content = readFileSync(file, 'utf8')
      expect(content).not.toMatch(/\binnerHTML\b/)
      expect(content).not.toMatch(/\bouterHTML\b/)
      expect(content).not.toMatch(/\binsertAdjacentHTML\b/)
    }

    const html = readFileSync(join(APP_ROOT, 'public/index.html'), 'utf8')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("default-src 'self'")
    expect(html).toContain("script-src 'self'")
    expect(html).toContain("object-src 'none'")
    expect(html).not.toMatch(/onclick=/i)
    expect(html).not.toMatch(/style=/i)
    // Only external module reference <script type="module" src="./app.js"></script>, never inline code
    const scriptMatches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    expect(scriptMatches.length).toBe(1)
    expect(scriptMatches[0]![2]!.trim()).toBe('')

    expect(existsSync(join(APP_ROOT, 'public/sw.js'))).toBe(true)
    expect(existsSync(join(APP_ROOT, 'public/manifest.webmanifest'))).toBe(true)
    expect(existsSync(join(APP_ROOT, 'public/styles.css'))).toBe(true)
  })

  it('chunks and reassembles WebRTC DataChannel frames cleanly and enforces maxFrameBytes', () => {
    const small = utf8Encode('small-frame')
    const smallChunks = encodeDataChannelChunks(small, 16)
    expect(smallChunks.length).toBe(1)
    const reassembler = new DataChannelFrameReassembler(128)
    expect(Buffer.from(reassembler.push(smallChunks[0]!)!).toString('utf8')).toBe('small-frame')

    const large = new Uint8Array(64)
    large.fill(0x5a)
    const multi = encodeDataChannelChunks(large, 20)
    expect(multi.length).toBe(4)
    let out: Uint8Array | undefined
    for (const c of multi) {
      out = reassembler.push(c)
    }
    expect(out?.byteLength).toBe(64)

    const huge = new Uint8Array(200)
    const hugeChunks = encodeDataChannelChunks(huge, 50)
    expect(() => {
      for (const c of hugeChunks) reassembler.push(c)
    }).toThrow(/maxFrameBytes/i)
  })

  it('folds streaming deltas, tool calls, todos, aborts, and deduplicated history cleanly in SessionTimelineState', () => {
    const tl = new SessionTimelineState('dsh-s1')
    tl.applyEvent({ seq: 10, type: 'turn/start', data: {} })
    tl.applyEvent({ seq: 11, type: 'reasoning-delta', data: { delta: 'step1 ' } })
    tl.applyEvent({ seq: 12, type: 'assistant/chunk', data: { delta: 'Hello ' } })
    tl.applyEvent({ seq: 13, type: 'assistant/message', data: { message: { content: 'Hello World' } } })
    tl.applyEvent({ seq: 14, type: 'tool/call', data: { callId: 't1', name: 'bash', arguments: { cmd: 'ls' } } })
    tl.applyEvent({ seq: 15, type: 'tool/result', data: { callId: 't1', result: 'ok' } })
    tl.applyEvent({ seq: 16, type: 'todo/write', data: { todos: [{ content: 'Verify tests', status: 'completed' }] } })
    tl.applyEvent({ seq: 17, type: 'turn/end', data: { reason: { kind: 'aborted' } } })

    expect(tl.status).toBe('idle')
    expect(tl.todos).toHaveLength(1)
    expect(tl.items.map((i) => i.kind)).toEqual(['assistant', 'tool', 'notice'])
    const assistant = tl.items[0] as Extract<(typeof tl.items)[number], { kind: 'assistant' }>
    expect(assistant.thinkingText).toBe('step1 ')
    expect(assistant.markdownText).toBe('Hello World')

    tl.prependHistory(
      [
        { seq: 1, type: 'user/message', data: { message: { content: 'First' } } },
        { seq: 10, type: 'turn/start', data: {} }, // duplicate seq:10 ignored cleanly
      ],
      false,
      1,
    )
    expect(tl.items[0]?.kind).toBe('user')
  })
})
