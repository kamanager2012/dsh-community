import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import {
  BlindRelayServer,
  SelfHostedSignalingServer,
  SelfHostedStunServer,
} from '../packages/remote-adapter/dist/index.js'

const wanAddress = process.env.R4_WAN_ADDRESS ?? '10.211.0.1'
const hostNetns = process.env.R4_HOST_NETNS ?? 'dsh-r4-host'
const hostBindIp = process.env.R4_HOST_BIND_IP ?? '10.211.0.11'
const clientNetns = process.env.R4_CLIENT_NETNS ?? 'dsh-r4-client'
const clientBindIp = process.env.R4_CLIENT_BIND_IP ?? '10.211.0.22'
const evidencePath = process.env.R4_EVIDENCE_PATH ?? '/tmp/r4-relay-evidence.json'
const pairingTokenPath = process.env.R4_PAIRING_TOKEN_PATH ?? '/tmp/r4-pairing-token.txt'
const secretsPath = process.env.R4_SECRETS_PATH ?? '/tmp/r4-secrets.txt'

function spawnNetnsScript(netns, scriptPath) {
  const child = spawn('sudo', ['ip', 'netns', 'exec', netns, process.execPath, scriptPath], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const rl = createInterface({ input: child.stdout })
  const iterator = rl[Symbol.asyncIterator]()
  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })

  return {
    send(value) {
      child.stdin.write(JSON.stringify(value) + '\n')
    },
    async nextType(expected, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now())
        const next = await Promise.race([
          iterator.next(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`timeout waiting for ${expected} in ${netns}`)), remaining),
          ),
        ])
        if (next.done) throw new Error(`process in ${netns} exited before ${expected}`)
        const message = JSON.parse(next.value)
        if (message.type === expected) return message
      }
      throw new Error(`timeout waiting for ${expected} in ${netns}`)
    },
    async waitExit() {
      const code = await exitPromise
      rl.close()
      if (code !== 0) {
        throw new Error(`process ${scriptPath} in ${netns} exited with code ${String(code)}`)
      }
    },
    kill() {
      try {
        child.kill('SIGKILL')
      } catch {}
    },
  }
}

const relayObservations = []
const relayHostSecret = randomBytes(16).toString('hex')
const relayClientToken = randomBytes(16).toString('hex')
const webrtcHostSecret = randomBytes(16).toString('hex')
const webrtcJoinToken = randomBytes(16).toString('hex')

const stunServer = new SelfHostedStunServer({
  enabled: true,
  host: wanAddress,
  port: 0,
})
const sigServer = new SelfHostedSignalingServer({
  enabled: true,
  host: wanAddress,
  port: 0,
  hostAuthSecret: webrtcHostSecret,
})
const relayServer = new BlindRelayServer({
  enabled: true,
  host: wanAddress,
  port: 0,
  hostAuthSecret: relayHostSecret,
  onBlindFrame: (obs) => {
    relayObservations.push({
      direction: obs.direction,
      bytes: obs.payload.byteLength,
      payloadBuf: Buffer.from(obs.payload),
    })
  },
})

await stunServer.start()
await sigServer.start()
await relayServer.start()

const stunUrl = stunServer.getStunUrl()
const signalingUrl = sigServer.getEndpointUrl()
const relayUrl = relayServer.getEndpointUrl()
if (!stunUrl || !signalingUrl || !relayUrl) {
  throw new Error('R4 infrastructure failed to start')
}

let hostProc
let clientProc

try {
  hostProc = spawnNetnsScript(hostNetns, 'scripts/r4-relay-failover-host.mjs')
  clientProc = spawnNetnsScript(clientNetns, 'scripts/r4-relay-failover-client.mjs')

  hostProc.send({
    hostBindIp,
    stunUrl,
    signalingUrl,
    webrtcRoomId: 'r4-webrtc-room-01',
    hostAuthSecret: webrtcHostSecret,
    webrtcJoinToken,
    iceConnectTimeoutMs: 2500,
    relayUrl,
    relayRoomId: 'r4-blind-relay-room-01',
    relayHostSecret,
    relayClientToken,
  })
  const hostReady = await hostProc.nextType('ready')
  writeFileSync(pairingTokenPath, hostReady.token, { encoding: 'utf8', mode: 0o600 })
  writeFileSync(secretsPath, [relayHostSecret, relayClientToken].join('\n'), {
    encoding: 'utf8',
    mode: 0o600,
  })

  clientProc.send({
    hostPublicKeyHex: hostReady.hostPublicKeyHex,
    token: hostReady.token,
    lanEndpointUrl: hostReady.lanEndpointUrl,
    stunUrl,
    signalingUrl,
    webrtcRoomId: hostReady.webrtcRoomId,
    webrtcJoinToken,
    clientBindIp,
    iceConnectTimeoutMs: 2500,
    relayUrl,
    relayRoomId: hostReady.relayRoomId,
    relayClientToken,
  })

  const candidate = await clientProc.nextType('candidate')
  if (candidate.initialTransport !== 'relay') {
    throw new Error(`expected failover to select relay when LAN+P2P blocked, got ${String(candidate.initialTransport)}`)
  }
  if (!candidate.unauthRejected) {
    throw new Error('expected unauthenticated channel RPC before pairing confirmation to fail')
  }
  const firstPassKinds = candidate.initialHistory.map((item) => [item.kind, item.status])
  if (
    firstPassKinds.length !== 3 ||
    firstPassKinds[0][0] !== 'lan' ||
    firstPassKinds[0][1] !== 'failed' ||
    firstPassKinds[1][0] !== 'webrtc' ||
    firstPassKinds[1][1] !== 'failed' ||
    firstPassKinds[2][0] !== 'relay' ||
    firstPassKinds[2][1] !== 'connected'
  ) {
    throw new Error(`unexpected initial failover sequence: ${JSON.stringify(firstPassKinds)}`)
  }

  hostProc.send({ type: 'confirm-pairing', candidateId: candidate.candidateId })
  const paired = await hostProc.nextType('pairing-confirmed')
  clientProc.send({ type: 'confirmed' })

  const afterSync = await clientProc.nextType('after-first-sync')
  if (afterSync.transportAfterAuth !== 'relay') {
    throw new Error('expected relay after auth reconnect')
  }
  if (JSON.stringify(afterSync.seqs1) !== JSON.stringify([1])) {
    throw new Error(`expected initial resume [1], got ${JSON.stringify(afterSync.seqs1)}`)
  }

  hostProc.send({
    type: 'ingest-events',
    sessionId: 's1',
    events: [
      { seq: 2, type: 'acceptance/event', data: { marker: 'R4_REAL_EVENT_2' } },
      { seq: 3, type: 'acceptance/event', data: { marker: 'R4_REAL_EVENT_3' } },
    ],
  })
  await hostProc.nextType('ingested')
  clientProc.send({ type: 'resume-now' })

  await clientProc.nextType('ready-for-live-event')
  hostProc.send({
    type: 'ingest-events',
    sessionId: 's1',
    events: [{ seq: 4, type: 'acceptance/live', data: { marker: 'R4_REAL_EVENT_4' } }],
  })
  await hostProc.nextType('ingested')

  const preRevoke = await clientProc.nextType('awaiting-revoke')
  if (preRevoke.transportAfterResume !== 'relay') {
    throw new Error('expected relay after reconnectAndResume')
  }
  if (!(preRevoke.epoch2 > afterSync.epoch1)) {
    throw new Error(`expected monotonic epoch increase, got ${afterSync.epoch1} -> ${preRevoke.epoch2}`)
  }
  if (JSON.stringify(preRevoke.seqs2) !== JSON.stringify([2, 3])) {
    throw new Error(`expected resumed seqs [2, 3], got ${JSON.stringify(preRevoke.seqs2)}`)
  }
  if (preRevoke.liveSeq !== 4 || preRevoke.liveMarker !== 'R4_REAL_EVENT_4') {
    throw new Error(`unexpected live event payload: ${JSON.stringify(preRevoke)}`)
  }

  hostProc.send({ type: 'status' })
  const status = await hostProc.nextType('status')
  if (status.followupCalls !== 1 || status.approvalCalls !== 1) {
    throw new Error(`idempotency failed on real host: ${JSON.stringify(status)}`)
  }

  hostProc.send({ type: 'revoke', deviceId: paired.deviceId })
  const revoked = await hostProc.nextType('revoked')
  clientProc.send({ type: 'revoked' })

  const done = await clientProc.nextType('done')
  if (done.openAfterRevoke !== false || !done.postRevokeRejected || done.openAfterPostRevokeAttempt !== false) {
    throw new Error(`revocation check failed: ${JSON.stringify(done)}`)
  }
  await clientProc.waitExit()

  hostProc.send({ type: 'wait-active-connections-zero', timeoutMs: 3000 })
  const zeroCheck = await hostProc.nextType('active-connections')
  if (zeroCheck.count !== 0) {
    throw new Error(`expected 0 active relay connections after revocation, got ${zeroCheck.count}`)
  }

  hostProc.send({ type: 'stop', verifyRevokedDeviceId: paired.deviceId })
  const stopped = await hostProc.nextType('stopped')
  await hostProc.waitExit()

  if (!stopped.fingerprintPersisted || !stopped.revokedPersisted) {
    throw new Error(`persistence failed: ${JSON.stringify(stopped)}`)
  }

  // Assert BlindRelayServer observed zero plaintext application content in relayed payloads
  const forbiddenPlaintexts = [
    'R4_REAL_SESSION_MARKER',
    'R4_REAL_EVENT_1',
    'R4_REAL_EVENT_2',
    'R4_REAL_EVENT_3',
    'R4_REAL_EVENT_4',
    'R4_REAL_PROMPT_MARKER',
    'R4_REAL_APPROVAL_MARKER',
    'R4_REAL_APPROVAL_RESULT',
    hostReady.token,
    candidate.deviceId,
  ]
  for (const obs of relayObservations) {
    const utf8 = obs.payloadBuf.toString('utf8')
    const hex = obs.payloadBuf.toString('hex')
    for (const secret of forbiddenPlaintexts) {
      if (utf8.includes(secret) || hex.includes(Buffer.from(secret, 'utf8').toString('hex'))) {
        throw new Error(`BlindRelayServer observed plaintext leakage of ${secret}`)
      }
    }
  }

  const evidence = {
    topology: `${hostNetns}(${hostBindIp}) <-[LAN & P2P UDP BLOCKED]-> ${clientNetns}(${clientBindIp}) -> WAN Relay(${wanAddress})`,
    relayStats: relayServer.getStats(),
    stunStats: stunServer.getStats(),
    signalingStats: sigServer.getStats(),
    blindFramesAudited: relayObservations.length,
    failoverHistory: preRevoke.failoverHistory,
    activeTransportAfterAuth: afterSync.transportAfterAuth,
    activeTransportAfterResume: preRevoke.transportAfterResume,
    epoch1: afterSync.epoch1,
    epoch2: preRevoke.epoch2,
    seqs1: afterSync.seqs1,
    seqs2: preRevoke.seqs2,
    liveSeq: preRevoke.liveSeq,
    followupCalls: stopped.followupCalls,
    approvalCalls: stopped.approvalCalls,
    revokedApplied: revoked.applied,
    openAfterRevoke: done.openAfterRevoke,
    postRevokeRejected: done.postRevokeRejected,
    activeConnectionsAfterRevoke: zeroCheck.count,
    fingerprintPersisted: stopped.fingerprintPersisted,
    revokedPersisted: stopped.revokedPersisted,
    hostRssGrowthBytes: stopped.rssGrowthBytes,
  }
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8')
  process.stdout.write(JSON.stringify({ ok: true, evidence }) + '\n')
} finally {
  hostProc?.kill()
  clientProc?.kill()
  await relayServer.stop()
  await sigServer.stop()
  await stunServer.stop()
}
