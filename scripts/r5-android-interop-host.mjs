#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BlindRelayServer,
  createPairingBootstrapDescriptor,
  InMemoryDeviceTrustStore,
  InMemoryHostIdentityStore,
  PairingCoordinator,
  PairingTokenRegistry,
  RemoteHostRuntime,
  WorkspaceUploadManager,
} from '../packages/remote-adapter/dist/index.js'

const SESSION_ID = 's-r5-android-interop'
const PROMPT_MARKER = 'DSH_R5_ANDROID_SECRET_PROMPT_42'

const hostIdentityStore = new InMemoryHostIdentityStore()
const trustStore = new InMemoryDeviceTrustStore()
const tokenRegistry = new PairingTokenRegistry()
const pairingCoordinator = new PairingCoordinator(hostIdentityStore, trustStore, tokenRegistry)
const workspaceRoot = mkdtempSync(join(tmpdir(), 'dsh-r5-interop-ws-'))
const uploadManager = new WorkspaceUploadManager()

function cleanupInteropWorkspace() {
  try {
    uploadManager.disposeAll()
  } catch {}
  try {
    rmSync(workspaceRoot, { recursive: true, force: true })
  } catch {}
}
process.on('exit', cleanupInteropWorkspace)

const calls = {
  followup: 0,
  approval: 0,
  question: 0,
  rename: 0,
  createSession: 0,
  abortTurn: 0,
  modelList: 0,
  modelSelect: 0,
  history: 0,
  search: 0,
  fork: 0,
  commandList: 0,
  commandExecute: 0,
  skillList: 0,
  uploadOpen: 0,
  uploadChunk: 0,
  uploadCommit: 0,
  uploadAbort: 0,
  uploadedFilesCount: 0,
  uploadedBytesTotal: 0,
  lastUploadedPath: null,
  lastUploadedSha256: null,
  blindFramesAudited: 0,
  plaintextLeaks: 0,
  lastSeqIngested: 0,
  lastPromptAttachments: 0,
  lastPromptImageNames: [],
  lastSelectedModel: null,
  lastSelectedReasoningEffort: null,
  sessionTitle: 'Android R5 Interop Session',
  extraSessions: [],
  recordedEvents: [],
}

function recordAndIngestEvent(sessionId, type, data) {
  calls.lastSeqIngested += 1
  const event = {
    seq: calls.lastSeqIngested,
    type,
    data,
  }
  calls.recordedEvents.push({ sessionId, ...event })
  runtime.ingestSessionEventBatch(sessionId, {
    log: [event],
  })
  return event
}

const seams = {
  async listSessions() {
    return [{ id: SESSION_ID, title: calls.sessionTitle }, ...calls.extraSessions]
  },
  async assertSession(sessionId) {
    if (sessionId !== SESSION_ID && !calls.extraSessions.some((s) => s.id === sessionId)) {
      throw new Error(`session not found: ${sessionId}`)
    }
  },
  async createSession(params) {
    calls.createSession += 1
    const created = {
      id: `sess-r5-${calls.createSession}`,
      title: params?.title || `Created Session ${calls.createSession}`,
    }
    calls.extraSessions.push(created)
    return created
  },
  async renameSession(sessionId, title) {
    await seams.assertSession(sessionId)
    calls.rename += 1
    if (sessionId === SESSION_ID) {
      calls.sessionTitle = title
    } else {
      const target = calls.extraSessions.find((s) => s.id === sessionId)
      if (target) target.title = title
    }
    recordAndIngestEvent(sessionId, 'session/title', { title })
    return { id: sessionId, title }
  },
  async followup(sessionId, prompt, options) {
    await seams.assertSession(sessionId)
    calls.followup += 1
    const attachments = Array.isArray(options?.attachments) ? options.attachments : []
    calls.lastPromptAttachments += attachments.length
    if (attachments.length > 0) {
      calls.lastPromptImageNames = attachments.map((a) => a.name || a.mediaType)
    }
    recordAndIngestEvent(sessionId, 'assistant.delta', {
      sessionId,
      echo: prompt,
      turn: calls.followup,
      mode: options?.mode || 'followup',
      attachmentsCount: attachments.length,
    })
    return {
      sessionId,
      prompt,
      attachmentsCount: attachments.length,
      turnId: `t-r5-${calls.followup}`,
    }
  },
  async abortTurn(sessionId) {
    await seams.assertSession(sessionId)
    calls.abortTurn += 1
    return { aborted: true, sessionId }
  },
  async listModels(_sessionId) {
    calls.modelList += 1
    return {
      current: calls.lastSelectedModel
        ? {
            provider: calls.lastSelectedModel.provider,
            model: calls.lastSelectedModel.model,
            reasoningEffort: calls.lastSelectedReasoningEffort || 'medium',
          }
        : {
            provider: 'deepseek',
            model: 'deepseek-reasoner',
            reasoningEffort: 'medium',
          },
      models: [
        {
          provider: 'deepseek',
          providerName: 'DeepSeek',
          model: 'deepseek-chat',
          name: 'DeepSeek Chat',
          supportsImageInput: false,
          reasoningEfforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' },
          ],
          defaultReasoningEffort: 'low',
          contextWindow: 65536,
        },
        {
          provider: 'deepseek',
          providerName: 'DeepSeek',
          model: 'deepseek-reasoner',
          name: 'DeepSeek Reasoner',
          supportsImageInput: true,
          reasoningEfforts: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ],
          defaultReasoningEffort: 'medium',
          contextWindow: 131072,
        },
      ],
    }
  },
  async selectModel(sessionId, selection) {
    await seams.assertSession(sessionId)
    calls.modelSelect += 1
    calls.lastSelectedModel = {
      provider: selection.provider,
      model: selection.model,
    }
    calls.lastSelectedReasoningEffort = selection.reasoningEffort || null
    recordAndIngestEvent(sessionId, 'session.model', {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    })
    return {
      ok: true,
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort || null,
    }
  },
  async respondApproval(callId, decision) {
    calls.approval += 1
    recordAndIngestEvent(SESSION_ID, 'approval.resolved', { callId, decision })
    return { callId, decision }
  },
  async respondQuestion(questionId, answer) {
    calls.question += 1
    return { questionId, answer }
  },
  async getSessionHistory(params) {
    await seams.assertSession(params.sessionId)
    calls.history += 1
    const all = calls.recordedEvents.filter((e) => e.sessionId === params.sessionId)
    const beforeSeq = typeof params.beforeSeq === 'number' ? params.beforeSeq : Number.MAX_SAFE_INTEGER
    const filtered = all.filter((e) => e.seq < beforeSeq)
    const limit = typeof params.limit === 'number' ? Math.max(1, Math.min(200, params.limit)) : 50
    const slice = filtered.slice(-limit)
    return {
      sessionId: params.sessionId,
      events: slice.map(({ seq, type, data }) => ({ seq, type, data })),
      hasMore: filtered.length > slice.length,
      oldestSeq: slice.length > 0 ? slice[0].seq : null,
      latestSeq: slice.length > 0 ? slice[slice.length - 1].seq : null,
      source: 'live',
    }
  },
  async searchSessions(params) {
    calls.search += 1
    const q = params.query.trim().toLowerCase()
    const hits = []
    for (const session of await seams.listSessions()) {
      if (params.sessionId && session.id !== params.sessionId) continue
      if ((session.title || '').toLowerCase().includes(q)) {
        hits.push({
          sessionId: session.id,
          title: session.title,
          seq: Math.max(1, calls.lastSeqIngested),
          type: 'session/title',
          snippet: `Matched title: ${session.title}`,
        })
      }
    }
    return {
      query: params.query,
      hits,
      hasMore: false,
    }
  },
  async forkSession(params) {
    await seams.assertSession(params.sessionId)
    calls.fork += 1
    const forked = {
      id: `fork-${params.sessionId}-${calls.fork}`,
      title: params.title || `Fork ${calls.fork} of ${params.sessionId}`,
    }
    calls.extraSessions.push(forked)
    return forked
  },
  async listCommands(_sessionId) {
    calls.commandList += 1
    return [
      {
        name: '/status',
        description: 'Show runtime diagnostics',
        inputHint: '',
        acceptsAttachments: false,
      },
      {
        name: '/review',
        description: 'Review current diff',
        inputHint: '[scope]',
        acceptsAttachments: true,
      },
    ]
  },
  async executeCommand(sessionId, command) {
    await seams.assertSession(sessionId)
    calls.commandExecute += 1
    return {
      ok: true,
      commandId: `cmd-${calls.commandExecute}`,
      output: `Executed ${command} in ${sessionId}`,
    }
  },
  async listSkills(_sessionId) {
    calls.skillList += 1
    return [
      {
        name: 'refactor',
        description: 'Safe incremental refactor',
        source: 'builtin',
      },
    ]
  },
  async openWorkspaceUpload(deviceId, params) {
    await seams.assertSession(params.sessionId)
    calls.uploadOpen += 1
    return uploadManager.open({
      deviceId,
      sessionId: params.sessionId,
      workspaceRoot,
      filename: params.filename,
      sizeBytes: params.sizeBytes,
      chunkBytes: params.chunkBytes,
      sha256: params.sha256,
      conflictPolicy: params.conflictPolicy,
    })
  },
  async appendWorkspaceUploadChunk(deviceId, params) {
    calls.uploadChunk += 1
    return uploadManager.appendChunk({
      deviceId,
      uploadId: params.uploadId,
      offset: params.offset,
      dataBase64: params.dataBase64,
    })
  },
  async commitWorkspaceUpload(deviceId, params) {
    calls.uploadCommit += 1
    const result = uploadManager.commit({
      deviceId,
      uploadId: params.uploadId,
      sha256: params.sha256,
    })
    calls.uploadedFilesCount += 1
    calls.uploadedBytesTotal += result.bytesWritten
    calls.lastUploadedPath = result.relativePath
    calls.lastUploadedSha256 = result.sha256
    return result
  },
  async abortWorkspaceUpload(deviceId, params) {
    calls.uploadAbort += 1
    return uploadManager.abort({
      deviceId,
      uploadId: params.uploadId,
    })
  },
}

const relayServer = new BlindRelayServer({
  enabled: true,
  host: '127.0.0.1',
  port: 0,
  maxOpaquePayloadBytes: 65_536,
  maxFramesPerSecond: 200,
  onBlindFrame: (obs) => {
    calls.blindFramesAudited += 1
    const text = Buffer.from(obs.payload).toString('utf8')
    if (
      text.includes(PROMPT_MARKER) ||
      text.includes(SESSION_ID) ||
      text.includes('jsonrpc') ||
      text.includes('prompt.submit') ||
      text.includes('approval.respond') ||
      text.includes('workspace.upload') ||
      text.includes('session.fork')
    ) {
      calls.plaintextLeaks += 1
    }
  },
})

await relayServer.start()
const relayUrl = relayServer.getEndpointUrl()
if (!relayUrl) {
  throw new Error('BlindRelayServer did not yield an endpoint URL')
}
const hostKeyPair = await hostIdentityStore.loadOrCreate()
const hostFingerprint = hostKeyPair.identity.fingerprint
const relayRoomId = `room_${hostFingerprint.slice(0, 24)}`

const runtime = new RemoteHostRuntime({
  seams,
  trustStore,
  hostIdentityStore,
  pairingCoordinator,
  carrier: {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
  },
  relay: {
    enabled: true,
    relayUrl,
    roomId: relayRoomId,
  },
})

await runtime.start()

const lanUrl = runtime.carrier.getEndpointUrl()
if (!lanUrl) {
  throw new Error('HostLanCarrier did not yield an endpoint URL')
}
const bootstrap = tokenRegistry.createToken({
  ttlMs: 120_000,
  allowedCapabilities: ['observe', 'prompt', 'approve', 'answer-question'],
  hostGeneration: hostKeyPair.identity.generation,
  trustDomainId: hostKeyPair.identity.trustDomainId,
})

const descriptor = createPairingBootstrapDescriptor({
  protocolVersion: 1,
  hostPublicKey: hostKeyPair.identity.publicKey,
  bootstrapToken: bootstrap.token,
  endpointUrl: lanUrl,
  expiresAt: bootstrap.expiresAt,
  signalingUrl: 'ws://127.0.0.1:9/signaling-unavailable',
  signalingRoomId: relayRoomId,
  stunUrls: ['stun:127.0.0.1:3478'],
  relayUrl,
  relayRoomId,
})

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

const controlServer = createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'GET' && reqUrl.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          followupCalls: calls.followup,
          approvalCalls: calls.approval,
          questionCalls: calls.question,
          renameCalls: calls.rename,
          createSessionCalls: calls.createSession,
          abortTurnCalls: calls.abortTurn,
          modelListCalls: calls.modelList,
          modelSelectCalls: calls.modelSelect,
          historyCalls: calls.history,
          searchCalls: calls.search,
          forkCalls: calls.fork,
          commandListCalls: calls.commandList,
          commandExecuteCalls: calls.commandExecute,
          skillListCalls: calls.skillList,
          uploadOpenCalls: calls.uploadOpen,
          uploadChunkCalls: calls.uploadChunk,
          uploadCommitCalls: calls.uploadCommit,
          uploadAbortCalls: calls.uploadAbort,
          uploadedFilesCount: calls.uploadedFilesCount,
          uploadedBytesTotal: calls.uploadedBytesTotal,
          lastUploadedPath: calls.lastUploadedPath,
          lastUploadedSha256: calls.lastUploadedSha256,
          lastPromptAttachments: calls.lastPromptAttachments,
          lastPromptImageNames: calls.lastPromptImageNames,
          lastSelectedReasoningEffort: calls.lastSelectedReasoningEffort,
          sessionTitle: calls.sessionTitle,
          blindFramesAudited: calls.blindFramesAudited,
          plaintextLeaks: calls.plaintextLeaks,
          lastSeqIngested: calls.lastSeqIngested,
        }),
      )
      return
    }
    if (req.method === 'POST' && reqUrl.pathname === '/confirm-pairing') {
      const body = await readJsonBody(req)
      const confirmed = await pairingCoordinator.confirmPairing({
        candidateId: body.candidateId,
        grantedCapabilities: ['observe', 'prompt', 'approve', 'answer-question'],
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, deviceId: confirmed.device.deviceId }))
      return
    }
    if (req.method === 'POST' && reqUrl.pathname === '/emit-event') {
      const body = await readJsonBody(req)
      const ev = recordAndIngestEvent(
        SESSION_ID,
        body.type || 'approval.request',
        body.data || { callId: 'call-r5-1', tool: 'shell' },
      )
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, seq: ev.seq }))
      return
    }
    if (req.method === 'POST' && reqUrl.pathname === '/drop-lan') {
      await runtime.carrier.stop()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method === 'POST' && reqUrl.pathname === '/revoke') {
      const body = await readJsonBody(req)
      trustStore.revokeSync(body.deviceId)
      runtime.carrier.disconnectDevice?.(body.deviceId)
      runtime.relay?.disconnectDevice?.(body.deviceId)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method === 'POST' && reqUrl.pathname === '/shutdown') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      await Promise.allSettled([runtime.stop(), relayServer.stop()])
      cleanupInteropWorkspace()
      controlServer.close()
      process.exit(0)
    }
    res.writeHead(404)
    res.end('not found')
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  }
})

await new Promise((resolve) => controlServer.listen(0, '127.0.0.1', resolve))
const controlAddr = controlServer.address()
const controlUrl = `http://127.0.0.1:${controlAddr.port}`

process.stdout.write(
  'READY ' +
    JSON.stringify({
      controlUrl,
      lanUrl,
      relayUrl,
      relayRoomId,
      sessionId: SESSION_ID,
      promptMarker: PROMPT_MARKER,
      pairingJson: JSON.stringify(descriptor),
    }) +
    '\n',
)
