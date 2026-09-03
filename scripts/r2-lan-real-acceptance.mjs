import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileDeviceTrustStore,
  FileHostIdentityStore,
  PairingCoordinator,
  PairingTokenRegistry,
  RemoteHostRuntime,
} from '../packages/remote-adapter/dist/index.js'

const hostAddress = process.env.R2_HOST_ADDRESS ?? '10.203.0.1'
const clientNetns = process.env.R2_CLIENT_NETNS ?? 'dsh-r2-client'
const evidencePath = process.env.R2_EVIDENCE_PATH ?? '/tmp/r2-real-evidence.json'
const tokenPath = process.env.R2_TOKEN_PATH ?? '/tmp/r2-real-token.txt'
const workDir = mkdtempSync(join(tmpdir(), 'dsh-r2-real-'))
const hostIdentityPath = join(workDir, 'host-identity.json')
const deviceTrustPath = join(workDir, 'device-trust.json')

const hostStore = new FileHostIdentityStore(hostIdentityPath)
const trustStore = new FileDeviceTrustStore(deviceTrustPath)
const tokenRegistry = new PairingTokenRegistry()
const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)
const calls = { followup: 0 }

const seams = {
  async listSessions() {
    return [{ id: 's1', title: 'R2_REAL_SESSION_MARKER' }]
  },
  async assertSession(sessionId) {
    if (sessionId !== 's1') throw new Error('missing session')
  },
  async followup(sessionId, prompt) {
    calls.followup += 1
    return { sessionId, prompt, turnId: 'real-turn-' + String(calls.followup) }
  },
  async respondApproval(callId, decision) {
    return { callId, decision }
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
  carrier: {
    enabled: true,
    host: hostAddress,
    port: 0,
    bounds: {
      maxConcurrentConnections: 4,
      maxInboundQueue: 8,
      maxOutboundQueue: 8,
      maxFrameBytes: 64 * 1024,
      maxHandshakeBytes: 1024,
      maxBufferedEventBytes: 256 * 1024,
      handshakeTimeoutMs: 300,
      idleTimeoutMs: 5_000,
    },
  },
})

const rssBefore = process.memoryUsage().rss
await runtime.start()
const host = await hostStore.loadOrCreate()
const initialFingerprint = host.identity.fingerprint
const tokenRecord = tokenRegistry.createToken({
  trustDomainId: host.identity.trustDomainId,
  hostGeneration: host.identity.generation,
  allowedCapabilities: ['observe', 'prompt'],
  ttlMs: 60_000,
})
writeFileSync(tokenPath, tokenRecord.token, { encoding: 'utf8', mode: 0o600 })

runtime.ingestSessionEventBatch('s1', {
  log: [
    { seq: 1, type: 'acceptance/event', data: { marker: 'R2_REAL_EVENT_1' } },
  ],
})

const child = spawn(
  'sudo',
  [
    'ip',
    'netns',
    'exec',
    clientNetns,
    'node',
    'scripts/r2-lan-real-client.mjs',
  ],
  {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'inherit'],
  },
)

const lines = createInterface({ input: child.stdout })
const iterator = lines[Symbol.asyncIterator]()

function send(value) {
  child.stdin.write(JSON.stringify(value) + '\n')
}

async function nextType(expected, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const next = await Promise.race([
      iterator.next(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout waiting for ' + expected)), remaining),
      ),
    ])
    if (next.done) throw new Error('client exited before ' + expected)
    const message = JSON.parse(next.value)
    if (message.type === expected) return message
  }
  throw new Error('timeout waiting for ' + expected)
}

send({
  endpointUrl: runtime.carrier.getEndpointUrl(),
  hostPublicKeyHex: Buffer.from(host.identity.publicKey).toString('hex'),
  token: tokenRecord.token,
})

const candidate = await nextType('candidate')
const pairingResult = await coordinator.confirmPairing({
  candidateId: candidate.candidateId,
  grantedCapabilities: ['observe', 'prompt'],
})
const authoritativeDeviceId = pairingResult.device.deviceId
if (candidate.deviceId !== authoritativeDeviceId) {
  throw new Error('client device fingerprint disagrees with Host authenticated identity')
}
send({ type: 'confirmed' })

const firstResume = await nextType('first-resume')
if (JSON.stringify(firstResume.seqs) !== JSON.stringify([1])) {
  throw new Error('first resume did not return seq 1')
}

runtime.ingestSessionEventBatch('s1', {
  log: [
    { seq: 1, type: 'acceptance/event', data: { marker: 'R2_REAL_EVENT_1' } },
    { seq: 2, type: 'acceptance/event', data: { marker: 'R2_REAL_EVENT_2' } },
  ],
})
send({ type: 'continue' })

const secondResume = await nextType('second-resume')
if (JSON.stringify(secondResume.seqs) !== JSON.stringify([2])) {
  throw new Error('second resume did not return only seq 2')
}
if (!(secondResume.epoch > firstResume.epoch)) {
  throw new Error('reconnect did not allocate a fresh epoch')
}

await nextType('ready-live')
runtime.ingestSessionEventBatch('s1', {
  log: [
    { seq: 1, type: 'acceptance/event', data: { marker: 'R2_REAL_EVENT_1' } },
    { seq: 2, type: 'acceptance/event', data: { marker: 'R2_REAL_EVENT_2' } },
    { seq: 3, type: 'acceptance/event', data: { marker: 'R2_REAL_EVENT_3' } },
  ],
})
const liveEvent = await nextType('live-event')
if (liveEvent.seq !== 3 || liveEvent.marker !== 'R2_REAL_EVENT_3') {
  throw new Error('live stream event was not delivered from official event bridge')
}

const dedupe = await nextType('dedupe')
if (JSON.stringify(dedupe.firstMutation) !== JSON.stringify(dedupe.secondMutation)) {
  throw new Error('idempotent mutation result changed across reconnect')
}
if (calls.followup !== 1) {
  throw new Error('official followup was duplicated across reconnect')
}

await nextType('ready-revoke')
const revokeApplied = trustStore.revokeSync(authoritativeDeviceId)
if (!revokeApplied) throw new Error('Host failed to apply authoritative device revocation')
const revokedRecord = trustStore.getSync(authoritativeDeviceId)
if (!revokedRecord || revokedRecord.revokedAt === undefined) {
  throw new Error('Host trust state is not durably revoked before reconnect test')
}
const revoked = await nextType('revoked')
if (revoked.activeClosed !== true) {
  throw new Error('revocation did not terminate the active authenticated channel')
}
if (revoked.denied !== true) {
  throw new Error('revoked device established a new authenticated connection')
}
if (
  !Array.isArray(revoked.reconnectDelays) ||
  revoked.reconnectDelays.length > 2 ||
  revoked.reconnectDelays.some((delay) => delay > 40)
) {
  throw new Error('reconnect backoff was not bounded')
}

await nextType('stalled-open')
const stalledConnectionsOpenAtPeak = runtime.carrier.getActiveConnectionCount()
if (stalledConnectionsOpenAtPeak > 4) {
  throw new Error(
    'Host exceeded maxConcurrentConnections: ' + String(stalledConnectionsOpenAtPeak),
  )
}
send({ type: 'stalled-check' })
await nextType('stalled-done')

const stalledDeadline = Date.now() + 1500
while (
  runtime.carrier.getActiveConnectionCount() !== 0 &&
  Date.now() < stalledDeadline
) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
const stalledConnectionsRemainingAfterTimeout = runtime.carrier.getActiveConnectionCount()
if (stalledConnectionsRemainingAfterTimeout !== 0) {
  throw new Error(
    'Host retained stalled connections after handshake timeout: ' +
      String(stalledConnectionsRemainingAfterTimeout),
  )
}

const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code) => resolve(code))
})
if (exitCode !== 0) throw new Error('isolated client exited with code ' + String(exitCode))

await runtime.stop()

const reopenedHostStore = new FileHostIdentityStore(hostIdentityPath)
const reopenedHost = await reopenedHostStore.loadOrCreate()
if (reopenedHost.identity.fingerprint !== initialFingerprint) {
  throw new Error('Host fingerprint changed across process-store recreation')
}
const reopenedTrustStore = new FileDeviceTrustStore(deviceTrustPath)
const persistedDevice = reopenedTrustStore.getSync(authoritativeDeviceId)
if (!persistedDevice || persistedDevice.revokedAt === undefined) {
  throw new Error('revoked device state did not persist across store recreation')
}

const rssAfter = process.memoryUsage().rss
const rssGrowthBytes = Math.max(0, rssAfter - rssBefore)
if (rssGrowthBytes > 64 * 1024 * 1024) {
  throw new Error('stalled-client acceptance grew Host RSS by more than 64 MiB')
}

const evidence = {
  schemaVersion: 1,
  commitSha: process.env.GITHUB_SHA ?? 'LOCAL',
  os: {
    platform: process.platform,
    release: process.version,
    arch: process.arch,
  },
  hostAddress,
  clientNetns,
  hostFingerprint: initialFingerprint,
  deviceId: authoritativeDeviceId,
  firstEpoch: firstResume.epoch,
  secondEpoch: secondResume.epoch,
  firstResumeSeqs: firstResume.seqs,
  secondResumeSeqs: secondResume.seqs,
  liveStreamSeq: liveEvent.seq,
  liveStreamMarker: liveEvent.marker,
  officialFollowupCalls: calls.followup,
  activeRevokedChannelTerminated: revoked.activeClosed,
  revokedReconnectDenied: revoked.denied,
  reconnectDelaysMs: revoked.reconnectDelays,
  stalledConnectionsOpenAtPeak,
  stalledConnectionsRemainingAfterTimeout,
  rssGrowthBytes,
  providerCalls: 0,
}
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
console.log('R2_REAL_ACCEPTANCE_OK ' + evidencePath)
