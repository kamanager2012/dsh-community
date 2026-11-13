import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileDeviceTrustStore,
  FileHostIdentityStore,
  PairingCoordinator,
  PairingTokenRegistry,
  RemoteHostRuntime,
} from '../packages/remote-adapter/dist/index.js'

const input = createInterface({ input: process.stdin })
const iterator = input[Symbol.asyncIterator]()

async function readCommand() {
  const next = await iterator.next()
  if (next.done) throw new Error('host controller stdin closed')
  return JSON.parse(next.value)
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

const config = await readCommand()
const workDir = mkdtempSync(join(tmpdir(), 'dsh-r3-host-'))
const hostIdentityPath = join(workDir, 'host-identity.json')
const deviceTrustPath = join(workDir, 'device-trust.json')

const hostStore = new FileHostIdentityStore(hostIdentityPath)
const trustStore = new FileDeviceTrustStore(deviceTrustPath)
const tokenRegistry = new PairingTokenRegistry()
const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)

const calls = {
  followup: 0,
  approval: 0,
}

const seams = {
  async listSessions() {
    return [{ id: 's1', title: 'R3_REAL_SESSION_MARKER' }]
  },
  async assertSession(sessionId) {
    if (sessionId !== 's1') throw new Error('missing session')
  },
  async followup(sessionId, prompt) {
    calls.followup += 1
    return { sessionId, prompt, turnId: 'r3-turn-' + String(calls.followup) }
  },
  async respondApproval(callId, decision) {
    calls.approval += 1
    return { callId, decision, audit: 'R3_REAL_APPROVAL_RESULT' }
  },
  async respondQuestion(questionId, answer) {
    return { questionId, answer }
  },
}

const runtime = new RemoteHostRuntime({
  seams,
  trustStore,
  hostIdentityStore: hostStore,
  pairingCoordinator: coordinator,
  coreOptions: { replayCapacity: 16, replayByteCapacity: 64 * 1024 },
  carrier: { enabled: false },
  webrtc: {
    enabled: true,
    signalingUrl: config.signalingUrl,
    roomId: config.roomId,
    hostAuthSecret: config.hostAuthSecret,
    joinToken: config.joinToken,
    iceConnectTimeoutMs: config.iceConnectTimeoutMs ?? 5000,
    ice: {
      stunUrls: config.stunUrl ? [config.stunUrl] : undefined,
      iceInterfaceAddresses: config.hostBindIp ? { udp4: config.hostBindIp } : undefined,
      iceStunGatherTimeoutSec: 2,
    },
    bounds: {
      maxConcurrentConnections: 4,
      maxInboundQueue: 16,
      maxOutboundQueue: 16,
      maxFrameBytes: 64 * 1024,
      maxHandshakeBytes: 2048,
      maxBufferedEventBytes: 256 * 1024,
      handshakeTimeoutMs: 2500,
      idleTimeoutMs: 15_000,
    },
  },
})

const rssBefore = process.memoryUsage().rss
await runtime.start()

const host = await hostStore.loadOrCreate()
const tokenRecord = tokenRegistry.createToken({
  trustDomainId: host.identity.trustDomainId,
  hostGeneration: host.identity.generation,
  allowedCapabilities: ['observe', 'prompt', 'approve'],
  ttlMs: 60_000,
})

if (Array.isArray(config.preTrustedPublicKeysHex)) {
  for (const hex of config.preTrustedPublicKeysHex) {
    trustStore.trustSync({
      staticPublicKey: new Uint8Array(Buffer.from(hex, 'hex')),
      displayName: 'R3 pre-trusted probe client',
      grantedCapabilities: ['observe', 'prompt', 'approve'],
      trustDomainId: host.identity.trustDomainId,
    })
  }
}

runtime.ingestSessionEventBatch('s1', {
  log: [{ seq: 1, type: 'acceptance/event', data: { marker: 'R3_REAL_EVENT_1' } }],
})

emit({
  type: 'ready',
  hostPublicKeyHex: Buffer.from(host.identity.publicKey).toString('hex'),
  fingerprint: host.identity.fingerprint,
  token: tokenRecord.token,
  roomId: runtime.webrtc?.getRoomId(),
})

try {
  while (true) {
    const cmd = await readCommand()
    if (cmd.type === 'confirm-pairing') {
      const pairingResult = await coordinator.confirmPairing({
        candidateId: cmd.candidateId,
        grantedCapabilities: ['observe', 'prompt', 'approve'],
      })
      emit({
        type: 'pairing-confirmed',
        deviceId: pairingResult.device.deviceId,
      })
      continue
    }

    if (cmd.type === 'ingest-events') {
      runtime.ingestSessionEventBatch(cmd.sessionId, { log: cmd.events })
      emit({ type: 'ingested' })
      continue
    }

    if (cmd.type === 'revoke') {
      const applied = trustStore.revokeSync(cmd.deviceId)
      const record = trustStore.getSync(cmd.deviceId)
      emit({
        type: 'revoked',
        applied,
        revokedAt: record?.revokedAt ?? null,
      })
      continue
    }

    if (cmd.type === 'wait-active-connections-zero') {
      const deadline = Date.now() + (cmd.timeoutMs ?? 3000)
      while ((runtime.webrtc?.getActiveConnectionCount() ?? 0) !== 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      emit({
        type: 'active-connections',
        count: runtime.webrtc?.getActiveConnectionCount() ?? 0,
      })
      continue
    }

    if (cmd.type === 'status') {
      emit({
        type: 'status',
        activeWebRtcConnections: runtime.webrtc?.getActiveConnectionCount() ?? 0,
        followupCalls: calls.followup,
        approvalCalls: calls.approval,
      })
      continue
    }

    if (cmd.type === 'stop') {
      await runtime.stop()
      const reopenedHost = await new FileHostIdentityStore(hostIdentityPath).loadOrCreate()
      const fingerprintPersisted = reopenedHost.identity.fingerprint === host.identity.fingerprint
      let revokedPersisted = true
      if (typeof cmd.verifyRevokedDeviceId === 'string') {
        const reopenedTrust = new FileDeviceTrustStore(deviceTrustPath)
        const rec = reopenedTrust.getSync(cmd.verifyRevokedDeviceId)
        revokedPersisted = rec !== undefined && rec.revokedAt !== undefined
      }
      const rssAfter = process.memoryUsage().rss
      emit({
        type: 'stopped',
        fingerprintPersisted,
        revokedPersisted,
        rssGrowthBytes: Math.max(0, rssAfter - rssBefore),
        followupCalls: calls.followup,
        approvalCalls: calls.approval,
      })
      break
    }

    throw new Error('unknown host controller command: ' + String(cmd.type))
  }
} finally {
  await runtime.stop().catch(() => {})
  input.close()
  rmSync(workDir, { recursive: true, force: true })
}
