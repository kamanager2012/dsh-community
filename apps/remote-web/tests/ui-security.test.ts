import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { InMemoryHostIdentityStore, computeFingerprint } from '@dsh-community/remote-adapter'
import { assessApprovalInputSecurity, isWindowFramed } from '../src/client/approval-input.ts'
import { parsePairingInput, validateStunOnlyUrls } from '../src/client/pairing.ts'
import { buildPromptSubmitSignature, estimateRpcEnvelopeBytes } from '../src/client/remote-client.ts'
import { SessionTimelineState } from '../src/client/timeline.ts'
import { MAX_NOISE_PLAINTEXT_BYTES, SAFE_GIT_DIFF_MAX_BYTES } from '../src/client/types.ts'
import {
  createBrowserWebRtcTransport,
  DataChannelFrameReassembler,
  encodeDataChannelChunks,
  type WebSocketLike,
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

  it('unwraps nested data.chunk deltas, merges reset recovery history chronologically, preserves question IDs, and bounds RPC envelope size', () => {
    const tl = new SessionTimelineState('dsh-nested')
    tl.applyEvent({ seq: 1, type: 'user/message', data: { message: { content: 'Explain E2EE' } } })
    tl.applyEvent({
      seq: 2,
      type: 'assistant/chunk',
      data: { chunk: { type: 'reasoning-delta', text: 'checking handshake ' }, text: 'checking handshake ' },
    })
    tl.applyEvent({
      seq: 3,
      type: 'assistant/chunk',
      data: { chunk: { type: 'text-delta', text: 'Noise IK ' } },
    })
    tl.applyEvent({
      seq: 4,
      type: 'assistant/chunk',
      data: { chunk: 'works!' },
    })

    const partial = tl.items[1] as Extract<(typeof tl.items)[number], { kind: 'assistant' }>
    expect(partial.thinkingText).toBe('checking handshake ')
    expect(partial.markdownText).toBe('Noise IK works!')
    expect(partial.finalized).toBe(false)

    // Replay reset occurs; newer durable history arrives at higher seqs while previous items stay in order
    tl.applyEvent({ seq: 5, type: 'user/message', data: { message: { content: 'Followup' } } })
    tl.applyResetRecoveryHistory(
      [
        { seq: 5, type: 'user/message', data: { message: { content: 'Followup' } } },
        { seq: 6, type: 'assistant/message', data: { message: { content: 'Durable answer' } } },
      ],
      true,
      5,
    )
    expect(tl.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const firstAssistant = tl.items[1] as Extract<(typeof tl.items)[number], { kind: 'assistant' }>
    const latestAssistant = tl.items[3] as Extract<(typeof tl.items)[number], { kind: 'assistant' }>
    expect(firstAssistant.finalized).toBe(true)
    expect(latestAssistant.markdownText).toBe('Durable answer')
    expect(latestAssistant.finalized).toBe(true)

    // Question ID preservation
    tl.applyEvent({
      seq: 7,
      type: 'question.request',
      data: {
        questionId: 'qreq-1',
        questions: [
          { id: 'env', header: 'Environment', question: 'Where to deploy?', multiSelect: true },
          { question: 'Confirm?' },
        ],
      },
    })
    expect(tl.pendingQuestions[0]?.questions?.[0]?.id).toBe('env')
    expect(tl.pendingQuestions[0]?.questions?.[1]?.id).toBe('q2')

    // Envelope limit enforcement
    const oversizedAttachment = {
      type: 'image',
      mediaType: 'image/png',
      dataBase64: 'A'.repeat(65_500),
    }
    expect(
      estimateRpcEnvelopeBytes('prompt.submit', { sessionId: 's1', prompt: 'hi', attachments: [oversizedAttachment] }),
    ).toBeGreaterThan(MAX_NOISE_PLAINTEXT_BYTES)
  })

  it('suppresses stale WebRTC DataChannel close/error callbacks during intentional transport.close()', async () => {
    const prevRtc = globalThis.RTCPeerConnection
    const createdChannels: Array<{
      readyState: string
      binaryType: string
      onopen: (() => void) | null
      onclose: (() => void) | null
      onerror: (() => void) | null
      onmessage: unknown
      close(): void
    }> = []
    class FakePeerConnection {
      onicecandidate: unknown = null
      onconnectionstatechange: unknown = null
      createDataChannel() {
        const ch = {
          readyState: 'connecting',
          binaryType: 'arraybuffer',
          onopen: null as (() => void) | null,
          onclose: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onmessage: null as unknown,
          close() {
            ch.readyState = 'closed'
            queueMicrotask(() => ch.onclose?.())
          },
        }
        createdChannels.push(ch)
        return ch
      }
      async createOffer() {
        return { type: 'offer', sdp: 'v=0' }
      }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      async addIceCandidate() {}
      close() {}
    }
    globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection
    try {
      const transport = createBrowserWebRtcTransport({
        signalingUrl: 'ws://127.0.0.1:9999',
        roomId: 'room-test-1234',
        webSocketFactory: () =>
          ({
            readyState: 0,
            binaryType: 'arraybuffer',
            send() {},
            close() {},
            onopen: null,
            onmessage: null,
            onerror: null,
            onclose: null,
          }) as unknown as WebSocketLike,
      })

      let closedFired = 0
      let errorFired = 0
      const connectPromise = transport.connect({
        onMessage: () => {},
        onError: () => {
          errorFired += 1
        },
        onClose: () => {
          closedFired += 1
        },
      })

      const dc = createdChannels[0]!
      const savedOnClose = dc.onclose
      dc.readyState = 'open'
      dc.onopen?.()
      await connectPromise

      transport.close()
      // Fire even if browser retains an earlier onclose reference asynchronously
      savedOnClose?.()
      await new Promise((r) => setTimeout(r, 15))
      expect(dc.onclose).toBeNull()
      expect(closedFired).toBe(0)
      expect(errorFired).toBe(0)
    } finally {
      globalThis.RTCPeerConnection = prevRtc
    }
  })

  it('reconciles streamed assistant text across tool/call without duplicating post-tool messages', () => {
    const tl = new SessionTimelineState('claude--tool')
    tl.applyEvent({ seq: 1, type: 'turn/start', data: {} })
    tl.applyEvent({
      seq: 2,
      type: 'assistant/chunk',
      data: { text: 'Checking config.ts first.', chunk: { type: 'text-delta', text: 'Checking config.ts first.' } },
    })
    tl.applyEvent({
      seq: 3,
      type: 'tool/call',
      data: { callId: 'call-1', toolName: 'Read', args: { file_path: 'config.ts' } },
    })
    tl.applyEvent({
      seq: 4,
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: 'Checking config.ts first.' } },
    })
    tl.applyEvent({
      seq: 5,
      type: 'tool/result',
      data: { callId: 'call-1', result: 'ok' },
    })
    tl.applyEvent({
      seq: 6,
      type: 'assistant/chunk',
      data: { text: 'Done.', chunk: { type: 'text-delta', text: 'Done.' } },
    })
    tl.applyEvent({
      seq: 7,
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: 'Done.' } },
    })

    const kinds = tl.items.map((it) => it.kind)
    expect(kinds).toEqual(['assistant', 'tool', 'assistant'])
    const first = tl.items[0] as Extract<(typeof tl.items)[number], { kind: 'assistant' }>
    const last = tl.items[2] as Extract<(typeof tl.items)[number], { kind: 'assistant' }>
    expect(first.markdownText).toBe('Checking config.ts first.')
    expect(first.finalized).toBe(true)
    expect(last.markdownText).toBe('Done.')
    expect(last.finalized).toBe(true)

    // Thinking-only pre-tool bubble + tool/result must NOT absorb the post-tool assistant/message
    const tlThinking = new SessionTimelineState('claude--think')
    tlThinking.applyEvent({
      seq: 1,
      type: 'assistant/chunk',
      data: { text: 'Let me think...', chunk: { type: 'reasoning-delta', text: 'Let me think...' } },
    })
    tlThinking.applyEvent({
      seq: 2,
      type: 'tool/call',
      data: { callId: 'call-2', toolName: 'Bash', args: { cmd: 'ls' } },
    })
    tlThinking.applyEvent({
      seq: 3,
      type: 'tool/result',
      data: { callId: 'call-2', result: 'a.txt' },
    })
    tlThinking.applyEvent({
      seq: 4,
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: 'Found a.txt.' } },
    })
    expect(tlThinking.items.map((it) => it.kind)).toEqual(['assistant', 'tool', 'assistant'])
    expect((tlThinking.items[0] as Extract<(typeof tlThinking.items)[number], { kind: 'assistant' }>).markdownText).toBe('')
    expect((tlThinking.items[2] as Extract<(typeof tlThinking.items)[number], { kind: 'assistant' }>).markdownText).toBe('Found a.txt.')
  })

  it('bounds git diff request size under Noise frame limit and keeps composer/question draft invariants', () => {
    // Even dense newlines, quotes, and backslashes in SAFE_GIT_DIFF_MAX_BYTES fit inside 65,519B plaintext frame
    const escapedLine = '+const v = "line\\n\\t\\\\value";\n'
    const diff = escapedLine.repeat(Math.floor(SAFE_GIT_DIFF_MAX_BYTES / Buffer.byteLength(escapedLine)))
    expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(SAFE_GIT_DIFF_MAX_BYTES)
    const rpcResponseJson = JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-diff-1',
      result: {
        sessionId: 'claude--s1',
        repoRoot: '/workspace/repo',
        branch: 'main',
        staged: false,
        diff,
        bytes: Buffer.byteLength(diff),
        truncated: true,
      },
    })
    expect(Buffer.byteLength(rpcResponseJson)).toBeLessThan(MAX_NOISE_PLAINTEXT_BYTES)

    const mainSrc = readFileSync(join(APP_ROOT, 'src/main.ts'), 'utf8')
    expect(mainSrc).toContain('maxBytes: SAFE_GIT_DIFF_MAX_BYTES')
    expect(mainSrc).toContain('syncComposerStatusControlsIfNeeded()')
    expect(mainSrc).toContain('questionCustomDrafts')
    expect(mainSrc).toContain('gitReviewGeneration')
    expect(mainSrc).not.toContain('state.draftBySession.set(sid, activeEl.value)')
  })

  it('preserves full streamed assistant text across >4,000 chunks when prependHistory rebuilds the timeline', () => {
    const tl = new SessionTimelineState('claude--long')
    tl.applyEvent({ seq: 5, type: 'turn/start', data: {} })
    const expectedParts: string[] = []
    for (let i = 0; i < 4_005; i += 1) {
      const token = i === 0 ? 'HEAD_TOKEN_' : i === 4_004 ? '_TAIL_TOKEN' : 'x'
      expectedParts.push(token)
      tl.applyEvent({
        seq: 10 + i,
        type: 'assistant/chunk',
        data: { text: token, chunk: { type: 'text-delta', text: token } },
      })
    }

    tl.prependHistory(
      [{ seq: 1, type: 'user/message', data: { message: { role: 'user', content: 'Earlier prompt' } } }],
      false,
      1,
    )

    expect(tl.items.map((it) => it.kind)).toEqual(['user', 'assistant'])
    const msg = tl.items[1] as Extract<(typeof tl.items)[number], { kind: 'assistant' }>
    expect(msg.markdownText).toBe(expectedParts.join(''))
    expect(msg.markdownText.startsWith('HEAD_TOKEN_')).toBe(true)
    expect(msg.markdownText.endsWith('_TAIL_TOKEN')).toBe(true)

    // Also verify non-chunk marathon sessions (>4,005 discrete messages) keep compacted baseline intact across prependHistory
    const big = new SessionTimelineState('claude--nonchunk')
    for (let i = 0; i < 4_005; i += 1) {
      big.applyEvent({
        seq: 10 + i,
        type: 'assistant/message',
        data: { message: { role: 'assistant', content: `msg-${i}` } },
      })
    }
    big.prependHistory(
      [{ seq: 2, type: 'user/message', data: { message: { role: 'user', content: 'Very old prompt' } } }],
      false,
      2,
    )
    expect(big.items.length).toBe(4_006)
    expect((big.items[0] as Extract<(typeof big.items)[number], { kind: 'user' }>).text).toBe('Very old prompt')
    expect((big.items[1] as Extract<(typeof big.items)[number], { kind: 'assistant' }>).markdownText).toBe('msg-0')
    expect((big.items[4_005] as Extract<(typeof big.items)[number], { kind: 'assistant' }>).markdownText).toBe('msg-4004')
  })

  it('preserves authoritative live status, todos, and approvals across prependHistory and reset recovery', () => {
    const tl = new SessionTimelineState('claude--live')
    tl.applyLiveStateSnapshot({
      status: 'running',
      model: { provider: 'anthropic', model: 'sonnet' },
      todos: [{ id: 't1', content: 'Keep shipping', status: 'in_progress' }],
      pendingApprovals: [
        {
          callId: 'appr-live-1',
          sessionId: 'claude--live',
          toolName: 'Bash',
        },
      ],
      pendingQuestions: [],
      oldestSeq: 50,
      latestSeq: 60,
      hasMoreHistory: true,
    })
    tl.applyEvent({
      seq: 60,
      type: 'assistant/chunk',
      data: { text: 'Working on it...', chunk: { type: 'text-delta', text: 'Working on it...' } },
    })

    // Older history ends an earlier turn with turn/end + approval/decision — must NOT clobber current live state!
    tl.prependHistory(
      [
        { seq: 10, type: 'turn/start', data: {} },
        { seq: 11, type: 'user/message', data: { message: { role: 'user', content: 'Old prompt' } } },
        { seq: 12, type: 'assistant/message', data: { message: { role: 'assistant', content: 'Old reply' } } },
        { seq: 13, type: 'turn/end', data: { usage: { inputTokens: 5, outputTokens: 2 } } },
      ],
      false,
      10,
    )

    expect(tl.status).toBe('running')
    expect(tl.todos).toHaveLength(1)
    expect(tl.pendingApprovals).toHaveLength(1)
    expect(tl.pendingApprovals[0]?.callId).toBe('appr-live-1')
    expect(tl.items.map((it) => it.kind)).toEqual(['user', 'assistant', 'assistant'])

    const mainSrc = readFileSync(join(APP_ROOT, 'src/main.ts'), 'utf8')
    expect(mainSrc).toContain('attachmentsBySession')
    expect(mainSrc).not.toContain('pendingAttachments')
    expect(mainSrc).toContain('qrScanGeneration')
    expect(mainSrc).toContain('needsInitialBackfill')
    expect(mainSrc).toContain('formatApprovalArgsText')
    expect(mainSrc).toContain('action-args')
    expect(mainSrc).toContain('action-context')
  })

  it('preserves approval args across live events, snapshot hydration, and history prepends', () => {
    const tl = new SessionTimelineState('claude--sec-appr')
    tl.applyEvent({
      seq: 10,
      type: 'approval.request',
      data: {
        callId: 'appr-bash-1',
        toolName: 'Bash',
        reason: 'Run build check',
        args: { command: 'rm -rf /tmp/demo && pnpm test' },
      },
    })
    expect(tl.pendingApprovals).toHaveLength(1)
    expect(tl.pendingApprovals[0]).toMatchObject({
      callId: 'appr-bash-1',
      toolName: 'Bash',
      reason: 'Run build check',
      args: { command: 'rm -rf /tmp/demo && pnpm test' },
      sessionId: 'claude--sec-appr',
    })

    // Snapshot with args retains it; snapshot without args enriches from matching tool item
    tl.applyEvent({
      seq: 11,
      type: 'tool/call',
      data: {
        callId: 'appr-acp-2',
        name: 'write_file',
        arguments: { path: 'src/index.ts', content: 'export const ok = true' },
      },
    })
    tl.applyLiveStateSnapshot({
      status: 'running',
      todos: [],
      pendingApprovals: [
        {
          callId: 'appr-bash-1',
          toolName: 'Bash',
          reason: 'Run build check',
          args: { command: 'rm -rf /tmp/demo && pnpm test' },
          sessionId: 'claude--sec-appr',
        },
        {
          callId: 'appr-acp-2',
          toolName: 'write_file',
          sessionId: 'claude--sec-appr',
        },
      ],
      pendingQuestions: [],
      oldestSeq: 10,
      latestSeq: 11,
      hasMoreHistory: false,
    })
    expect(tl.pendingApprovals[0]?.args).toEqual({ command: 'rm -rf /tmp/demo && pnpm test' })
    expect(typeof tl.pendingApprovals[1]?.args).toBe('string')
    expect(String(tl.pendingApprovals[1]?.args)).toContain('src/index.ts')

    const mainSrc = readFileSync(join(APP_ROOT, 'src/main.ts'), 'utf8')
    expect(mainSrc).toContain('pendingSubmitIdempotencyBySession')
    expect(mainSrc).toContain('idempotencyKey,')
  })

  it('folds agent/error notifications and structured MCP tool errors accurately', () => {
    const tl = new SessionTimelineState('codex--err')
    tl.applyEvent({
      seq: 1,
      type: 'tool/call',
      data: { callId: 'mcp-1', name: 'mcp_search', arguments: { q: 'foo' } },
    })
    tl.applyEvent({
      seq: 2,
      type: 'tool/result',
      data: { callId: 'mcp-1', result: null, error: { code: -32602, message: 'Invalid params' } },
    })
    tl.applyEvent({
      seq: 3,
      type: 'agent/error',
      data: { message: 'Model rate limit exceeded' },
    })

    const toolItem = tl.items[0] as Extract<(typeof tl.items)[number], { kind: 'tool' }>
    expect(toolItem.status).toBe('error')
    expect(toolItem.outputText).toContain('-32602')
    expect(toolItem.outputText).toContain('Invalid params')

    const noticeItem = tl.items[1] as Extract<(typeof tl.items)[number], { kind: 'notice' }>
    expect(noticeItem.isError).toBe(true)
    expect(noticeItem.text).toBe('Error: Model rate limit exceeded')
  })

  it('guards failed prompt/command restoration against host switches and restricts sw.js cache cleanup by prefix', async () => {
    const mainSrc = readFileSync(join(APP_ROOT, 'src/main.ts'), 'utf8')
    const fnStart = mainSrc.indexOf('async function handleSubmitPrompt()')
    const fnEnd = mainSrc.indexOf('async function handleImagePick(')
    expect(fnStart).toBeGreaterThan(-1)
    expect(fnEnd).toBeGreaterThan(fnStart)
    const submitFn = mainSrc.slice(fnStart, fnEnd)
    expect(submitFn).toContain('const captureResetGen = hostResetGeneration')
    expect((submitFn.match(/captureResetGen !== hostResetGeneration/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect((submitFn.match(/captureResetGen === hostResetGeneration/g) ?? []).length).toBeGreaterThanOrEqual(2)

    // Execute sw.js activate handler with a mocked CacheStorage containing both foreign and obsolete caches.
    const swSrc = readFileSync(join(APP_ROOT, 'public/sw.js'), 'utf8')
    const listeners = new Map<string, (ev: unknown) => void>()
    const storedCaches = new Set(['dsh-remote-web-shell-v0', 'dsh-remote-web-shell-v1', 'other-app-offline-v2'])
    const mockSelf = {
      location: { origin: 'https://example.test' },
      addEventListener: (type: string, cb: (ev: unknown) => void) => listeners.set(type, cb),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    }
    const mockCaches = {
      keys: async () => [...storedCaches],
      delete: async (k: string) => storedCaches.delete(k),
      open: async () => ({ addAll: async () => {}, put: async () => {} }),
      match: async () => undefined,
    }
    const runSw = new Function('self', 'caches', swSrc)
    runSw(mockSelf, mockCaches)
    let activatedPromise: Promise<unknown> | undefined
    listeners.get('activate')?.({
      waitUntil: (p: Promise<unknown>) => {
        activatedPromise = p
      },
    })
    expect(activatedPromise).toBeDefined()
    await activatedPromise
    expect([...storedCaches].sort()).toEqual(['dsh-remote-web-shell-v1', 'other-app-offline-v2'])
  })

  it('distinguishes live cursors from hydrated history and guards workspace refresh/attach against host switches', () => {
    const tl = new SessionTimelineState('sess-live-cursor')
    tl.applyEvent({
      seq: 100,
      type: 'assistant/chunk',
      data: { text: 'Live tail chunk' },
    })
    expect(tl.historyHydrated).toBe(false)
    expect(tl.highestSeq).toBe(100)
    expect(tl.oldestSeq).toBe(100)

    // Receiving a snapshot claiming oldestSeq=1 on initial attach must NOT clobber oldestSeq=100
    // or mark historyHydrated true before history 1-99 is actually loaded.
    tl.applyLiveStateSnapshot({
      status: 'running',
      todos: [],
      pendingApprovals: [],
      pendingQuestions: [],
      oldestSeq: 1,
      latestSeq: 100,
      hasMoreHistory: true,
    })
    expect(tl.historyHydrated).toBe(false)
    expect(tl.oldestSeq).toBe(100)

    tl.applyResetRecoveryHistory(
      [
        {
          seq: 21,
          type: 'user/message',
          data: { message: { role: 'user', content: 'Earlier prompt' } },
        },
      ],
      true,
      21,
    )
    expect(tl.historyHydrated).toBe(true)
    expect(tl.oldestSeq).toBe(21)

    const mainSrc = readFileSync(join(APP_ROOT, 'src/main.ts'), 'utf8')
    const refreshBlock = mainSrc.slice(
      mainSrc.indexOf('async function refreshWorkspaceData()'),
      mainSrc.indexOf('async function attachActiveSession('),
    )
    expect(refreshBlock).toContain('const captureResetGen = hostResetGeneration')
    expect((refreshBlock.match(/captureResetGen !== hostResetGeneration/g) ?? []).length).toBeGreaterThanOrEqual(2)

    const attachBlock = mainSrc.slice(
      mainSrc.indexOf('async function attachActiveSession('),
      mainSrc.indexOf('async function loadOlderHistory('),
    )
    expect(attachBlock).toContain('const wasHydrated = tl.historyHydrated')
    expect(attachBlock).toContain('const afterSeq = wasHydrated && tl.highestSeq > 0 ? tl.highestSeq : undefined')
    expect(attachBlock).toContain('tl.mergeReplayEvents(attached.events)')
    expect(attachBlock).toContain('captureResetGen !== hostResetGeneration')
  })

  it('displays 10KB untruncated tool inputs cleanly and fails closed whenever approval input is truncated or unavailable', () => {
    const tenKbCommand = { command: `echo ok && ${'a'.repeat(10_000)}` }
    const okAssessment = assessApprovalInputSecurity({
      callId: 'appr-10k',
      toolName: 'Bash',
      args: tenKbCommand,
    })
    expect(okAssessment.truncated).toBe(false)
    expect(okAssessment.allowBlocked).toBe(false)
    expect(okAssessment.formatted.text).toContain('a'.repeat(10_000))

    const hostFlagged = assessApprovalInputSecurity({
      callId: 'appr-flag',
      toolName: 'Write',
      args: { file_path: 'foo.ts' },
      argsTruncated: true,
    })
    expect(hostFlagged.truncated).toBe(true)
    expect(hostFlagged.allowBlocked).toBe(true)

    const hostMarked = assessApprovalInputSecurity({
      callId: 'appr-marker',
      toolName: 'Bash',
      args: { command: 'ls', _truncated: true, _originalBytes: 70_000 },
    })
    expect(hostMarked.truncated).toBe(true)
    expect(hostMarked.allowBlocked).toBe(true)

    const nestedStringMarked = assessApprovalInputSecurity({
      callId: 'appr-nested',
      toolName: 'Write',
      args: { content: 'prefix… [truncated, 18000 B total]' },
    })
    expect(nestedStringMarked.truncated).toBe(true)
    expect(nestedStringMarked.allowBlocked).toBe(true)

    const uiOverflow = assessApprovalInputSecurity({
      callId: 'appr-ui-cap',
      toolName: 'Write',
      args: { content: 'z'.repeat(70_000) },
    })
    expect(uiOverflow.formatted.truncated).toBe(true)
    expect(uiOverflow.allowBlocked).toBe(true)

    const emptyUnavailable = assessApprovalInputSecurity({
      callId: 'appr-empty',
      toolName: 'Bash',
    })
    expect(emptyUnavailable.unavailable).toBe(true)
    expect(emptyUnavailable.allowBlocked).toBe(true)

    const mainSrc = readFileSync(join(APP_ROOT, 'src/main.ts'), 'utf8')
    const cardBlock = mainSrc.slice(
      mainSrc.indexOf('function buildApprovalCard('),
      mainSrc.indexOf('function buildQuestionCard('),
    )
    expect(cardBlock).toContain('assessApprovalInputSecurity')
    expect(cardBlock).toContain('if (security.allowBlocked)')
    expect(cardBlock).toContain('allowBtn.disabled = true')
  })

  it('merges pre-attach live events chronologically with initial replay, preserves concurrent live events above history recovery, and enforces anti-framing', () => {
    // 1. Pre-attach chunk seq=3 followed by full replay 1..3 must reorder chronologically and merge chunk 2+3
    const tlPreAttach = new SessionTimelineState('sess-preattach-order')
    tlPreAttach.applyEvent({
      seq: 3,
      type: 'assistant/chunk',
      data: { text: 'world', chunk: { type: 'text-delta', text: 'world' } },
    })
    tlPreAttach.mergeReplayEvents([
      { seq: 1, type: 'user/message', data: { message: { role: 'user', content: 'Say hi' } } },
      { seq: 2, type: 'assistant/chunk', data: { text: 'hello ', chunk: { type: 'text-delta', text: 'hello ' } } },
      { seq: 3, type: 'assistant/chunk', data: { text: 'world', chunk: { type: 'text-delta', text: 'world' } } },
    ])
    expect(tlPreAttach.items.map((it) => it.kind)).toEqual(['user', 'assistant'])
    expect((tlPreAttach.items[0] as Extract<(typeof tlPreAttach.items)[number], { kind: 'user' }>).text).toBe('Say hi')
    expect(
      (tlPreAttach.items[1] as Extract<(typeof tlPreAttach.items)[number], { kind: 'assistant' }>).markdownText,
    ).toBe('hello world')
    expect(tlPreAttach.oldestSeq).toBe(1)
    expect(tlPreAttach.highestSeq).toBe(3)

    // 2. Concurrent live event seq=4 arriving while history recovery returns [1..3] must NOT be deleted
    const tlRecovery = new SessionTimelineState('sess-recovery-preserve')
    tlRecovery.applyEvent({ seq: 2, type: 'assistant/chunk', data: { text: 'stale-2' } })
    tlRecovery.applyEvent({ seq: 4, type: 'assistant/chunk', data: { text: 'Final live answer' } })
    tlRecovery.applyResetRecoveryHistory(
      [
        { seq: 1, type: 'user/message', data: { message: { role: 'user', content: 'Question' } } },
        { seq: 3, type: 'assistant/message', data: { message: { role: 'assistant', content: 'Prior turn' } } },
      ],
      false,
      1,
      { preserveAfterSeq: 2 },
    )
    expect(tlRecovery.highestSeq).toBe(4)
    expect(tlRecovery.items.map((it) => it.kind)).toEqual(['user', 'assistant', 'assistant'])
    expect(
      (tlRecovery.items[2] as Extract<(typeof tlRecovery.items)[number], { kind: 'assistant' }>).markdownText,
    ).toBe('Final live answer')

    // 3. Empty recovery response must still preserve live events arriving after recovery watermark
    const tlEmptyRecovery = new SessionTimelineState('sess-recovery-empty')
    const watermark = tlEmptyRecovery.highestSeq
    tlEmptyRecovery.applyEvent({ seq: 5, type: 'assistant/chunk', data: { text: 'Streamed during await' } })
    tlEmptyRecovery.applyResetRecoveryHistory([], false, null, { preserveAfterSeq: watermark })
    expect(tlEmptyRecovery.highestSeq).toBe(5)
    expect(tlEmptyRecovery.items).toHaveLength(1)

    // 4. Checked-in deployment headers + runtime frame guard enforce frame-ancestors 'none' & DENY
    const headersFile = readFileSync(join(APP_ROOT, 'public/_headers'), 'utf8')
    expect(headersFile).toContain("frame-ancestors 'none'")
    expect(headersFile).toContain('X-Frame-Options: DENY')
    expect(isWindowFramed({ self: {} as Window, top: {} as Window, frameElement: null, location: {} } as unknown as Window)).toBe(true)
    const framedAssessment = assessApprovalInputSecurity(
      { callId: 'appr-framed', toolName: 'Bash', args: { command: 'echo hi' } },
      undefined,
      true,
    )
    expect(framedAssessment.allowBlocked).toBe(true)
  })

  it('preserves/enriches structured pendingQuestions, deduplicates coalesced chunks on replay, includes mode in submit signature, and blocks reason-only approvals', () => {
    // 1a. Snapshot hydration preserves structured pending questions already received live
    const tlQ1 = new SessionTimelineState('sess-q-preserve')
    tlQ1.applyEvent({
      seq: 1,
      type: 'question.request',
      data: {
        questionId: 'qreq-1',
        questions: [{ id: 'target_env', question: 'Deploy target?', options: [{ label: 'staging' }, { label: 'prod' }] }],
      },
    })
    tlQ1.applyLiveStateSnapshot({
      status: 'running',
      todos: [],
      pendingApprovals: [],
      pendingQuestions: [{ questionId: 'qreq-1', prompt: 'Deploy target?', sessionId: 'sess-q-preserve' }],
    })
    expect(tlQ1.pendingQuestions[0]?.questions?.[0]?.id).toBe('target_env')
    expect(tlQ1.pendingQuestions[0]?.questions?.[0]?.options?.map((o) => o.label)).toEqual(['staging', 'prod'])

    // 1b. Replay question.request enriches a prompt-only snapshot item after snapshot hydration
    const tlQ2 = new SessionTimelineState('sess-q-enrich')
    tlQ2.applyLiveStateSnapshot({
      status: 'running',
      todos: [],
      pendingApprovals: [],
      pendingQuestions: [{ questionId: 'qreq-2', prompt: 'Choose mode', sessionId: 'sess-q-enrich' }],
    })
    tlQ2.mergeReplayEvents([
      {
        seq: 2,
        type: 'question.request',
        data: {
          questionId: 'qreq-2',
          questions: [{ id: 'custom_id', question: 'Choose mode', options: [{ label: 'fast' }, { label: 'safe' }] }],
        },
      },
    ])
    expect(tlQ2.pendingQuestions[0]?.questions?.[0]?.id).toBe('custom_id')
    expect(tlQ2.pendingQuestions[0]?.questions?.[0]?.options?.map((o) => o.label)).toEqual(['fast', 'safe'])

    // 2. Overlapping replay after >4000 chunk coalescing must NOT duplicate assistant characters
    const tlChunk = new SessionTimelineState('sess-coalesce-dedup')
    for (let seq = 1; seq <= 4_005; seq += 1) {
      tlChunk.applyEvent({
        seq,
        type: 'assistant/chunk',
        data: { text: 'x', chunk: { type: 'text-delta', text: 'x' } },
      })
    }
    const replayOverlap = []
    for (let seq = 3_906; seq <= 4_005; seq += 1) {
      replayOverlap.push({
        seq,
        type: 'assistant/chunk',
        data: { text: 'x', chunk: { type: 'text-delta', text: 'x' } },
      })
    }
    tlChunk.mergeReplayEvents(replayOverlap)
    expect(tlChunk.items).toHaveLength(1)
    expect((tlChunk.items[0] as Extract<(typeof tlChunk.items)[number], { kind: 'assistant' }>).markdownText).toHaveLength(4_005)

    // 3. Submission idempotency signature distinguishes steer vs followup modes
    expect(buildPromptSubmitSignature('steer', 'retry me', [])).not.toBe(
      buildPromptSubmitSignature('followup', 'retry me', []),
    )
    const mainSrc = readFileSync(join(APP_ROOT, 'src/main.ts'), 'utf8')
    expect(mainSrc).toContain('buildPromptSubmitSignature(mode, promptText, attachments)')

    // 4. Reason-only, summary-only, and empty-object approvals fail closed (Allow blocked)
    const reasonOnly = assessApprovalInputSecurity({
      callId: 'appr-reason-only',
      toolName: 'bash',
      reason: 'Inspect workspace via bash',
    })
    expect(reasonOnly.unavailable).toBe(true)
    expect(reasonOnly.allowBlocked).toBe(true)

    const summaryOnly = assessApprovalInputSecurity({
      callId: 'appr-summary-only',
      toolName: 'write_file',
      summary: 'Update config file',
    })
    expect(summaryOnly.unavailable).toBe(true)
    expect(summaryOnly.allowBlocked).toBe(true)

    const emptyObj = assessApprovalInputSecurity({
      callId: 'appr-empty-obj',
      toolName: 'bash',
      args: {},
      reason: 'Run shell command',
    })
    expect(emptyObj.unavailable).toBe(true)
    expect(emptyObj.allowBlocked).toBe(true)
  })
})
