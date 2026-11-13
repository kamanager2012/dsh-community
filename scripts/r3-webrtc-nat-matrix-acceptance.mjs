import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
// @ts-ignore package-local runtime dependency path is intentional for this evidence script
import dhModule from '../packages/remote-adapter/node_modules/noise-handshake/dh.js'
import {
  SelfHostedSignalingServer,
  SelfHostedStunServer,
} from '../packages/remote-adapter/dist/index.js'

const dh = dhModule?.default ?? dhModule

const wanAddress = process.env.R3_WAN_ADDRESS ?? '10.210.0.1'
const hostNetns = process.env.R3_HOST_NETNS ?? 'dsh-r3-host'
const hostBindIp = process.env.R3_HOST_BIND_IP ?? '10.210.1.2'
const hostNatWanIp = process.env.R3_HOST_NAT_WAN_IP ?? '10.210.0.11'
const clientNetns = process.env.R3_CLIENT_NETNS ?? 'dsh-r3-client'
const clientBindIp = process.env.R3_CLIENT_BIND_IP ?? '10.210.2.2'
const blockedClientNetns = process.env.R3_BLOCKED_CLIENT_NETNS ?? 'dsh-r3-sym'
const blockedClientBindIp = process.env.R3_BLOCKED_CLIENT_BIND_IP ?? '10.210.3.2'
const evidencePath = process.env.R3_EVIDENCE_PATH ?? '/tmp/r3-webrtc-evidence.json'
const pairingTokenPath = process.env.R3_PAIRING_TOKEN_PATH ?? '/tmp/r3-pairing-token.txt'

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
    async nextType(expected, timeoutMs = 12_000) {
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

const stunServer = new SelfHostedStunServer({
  enabled: true,
  host: wanAddress,
  port: 0,
})
await stunServer.start()
const stunUrl = stunServer.getStunUrl()
if (!stunUrl) throw new Error('STUN server failed to bind')

const hostAuthSecret = randomBytes(16).toString('hex')
const joinToken = randomBytes(16).toString('hex')

let activeHostProc = undefined
let activeClientProc = undefined

try {
  // ---------------------------------------------------------------------------
  // Case A: Dual-NAT (dsh-r3-host <-> NAT-A <-> WAN <-> NAT-B <-> dsh-r3-client)
  // Full pairing -> resume -> reconnect -> live event -> idempotency -> approval -> revocation
  // ---------------------------------------------------------------------------
  const sigA = new SelfHostedSignalingServer({
    enabled: true,
    host: wanAddress,
    port: 0,
    hostAuthSecret,
  })
  await sigA.start()
  const sigAUrl = sigA.getEndpointUrl()
  if (!sigAUrl) throw new Error('signaling A failed to start')

  const hostA = spawnNetnsScript(hostNetns, 'scripts/r3-webrtc-nat-host.mjs')
  activeHostProc = hostA
  const clientA = spawnNetnsScript(clientNetns, 'scripts/r3-webrtc-nat-client.mjs')
  activeClientProc = clientA

  hostA.send({
    hostBindIp,
    signalingUrl: sigAUrl,
    roomId: 'r3-dual-nat-a',
    hostAuthSecret,
    joinToken,
    stunUrl,
    iceConnectTimeoutMs: 8000,
  })
  const hostAReady = await hostA.nextType('ready')
  writeFileSync(pairingTokenPath, hostAReady.token, { encoding: 'utf8', mode: 0o600 })

  clientA.send({
    mode: 'full',
    clientBindIp,
    hostPublicKeyHex: hostAReady.hostPublicKeyHex,
    signalingUrl: sigAUrl,
    roomId: 'r3-dual-nat-a',
    joinToken,
    stunUrl,
    token: hostAReady.token,
    iceConnectTimeoutMs: 8000,
  })

  const candidate = await clientA.nextType('candidate')
  const selectedPair = candidate.iceDiagnostics?.selectedPair
  if (!selectedPair) {
    throw new Error('Case A: WebRTC selectedPair was undefined')
  }
  if (selectedPair.remoteAddress !== hostNatWanIp) {
    throw new Error(
      `Case A: expected remote NAT WAN IP ${hostNatWanIp}, got ${String(selectedPair.remoteAddress)} (type=${String(selectedPair.remoteType)})`,
    )
  }
  if (selectedPair.remoteType === 'host') {
    throw new Error('Case A: remote ICE candidate type must be srflx/prflx behind NAT, not host')
  }

  hostA.send({ type: 'confirm-pairing', candidateId: candidate.candidateId })
  const pairingConfirmed = await hostA.nextType('pairing-confirmed')
  const authoritativeDeviceId = pairingConfirmed.deviceId
  if (candidate.deviceId !== authoritativeDeviceId) {
    throw new Error('Case A: device fingerprint mismatch between client and host')
  }
  clientA.send({ type: 'confirmed' })

  const firstResume = await clientA.nextType('first-resume')
  if (JSON.stringify(firstResume.seqs) !== JSON.stringify([1])) {
    throw new Error(`Case A: expected firstResume [1], got ${JSON.stringify(firstResume.seqs)}`)
  }

  hostA.send({
    type: 'ingest-events',
    sessionId: 's1',
    events: [
      { seq: 1, type: 'acceptance/event', data: { marker: 'R3_REAL_EVENT_1' } },
      { seq: 2, type: 'acceptance/event', data: { marker: 'R3_REAL_EVENT_2' } },
    ],
  })
  await hostA.nextType('ingested')
  clientA.send({ type: 'continue' })

  const secondResume = await clientA.nextType('second-resume')
  if (JSON.stringify(secondResume.seqs) !== JSON.stringify([2])) {
    throw new Error(`Case A: expected secondResume [2], got ${JSON.stringify(secondResume.seqs)}`)
  }
  if (!(secondResume.epoch > firstResume.epoch)) {
    throw new Error('Case A: reconnect did not advance monotonic connectionEpoch')
  }

  await clientA.nextType('ready-live')
  hostA.send({
    type: 'ingest-events',
    sessionId: 's1',
    events: [
      { seq: 1, type: 'acceptance/event', data: { marker: 'R3_REAL_EVENT_1' } },
      { seq: 2, type: 'acceptance/event', data: { marker: 'R3_REAL_EVENT_2' } },
      { seq: 3, type: 'acceptance/event', data: { marker: 'R3_REAL_EVENT_3' } },
    ],
  })
  await hostA.nextType('ingested')
  const liveEvent = await clientA.nextType('live-event')
  if (liveEvent.seq !== 3 || liveEvent.marker !== 'R3_REAL_EVENT_3') {
    throw new Error('Case A: live event marker mismatch')
  }

  const dedupe = await clientA.nextType('dedupe')
  if (JSON.stringify(dedupe.firstMutation) !== JSON.stringify(dedupe.secondMutation)) {
    throw new Error('Case A: idempotent prompt replay result diverged across WebRTC reconnect')
  }
  const rpcOk = await clientA.nextType('rpc-ok')
  if (
    rpcOk.approvalResult?.decision !== 'approved' ||
    rpcOk.approvalResult?.callId !== 'R3_REAL_APPROVAL_MARKER'
  ) {
    throw new Error('Case A: approval decision RPC did not succeed')
  }

  await clientA.nextType('ready-revoke')
  hostA.send({ type: 'revoke', deviceId: authoritativeDeviceId })
  const hostRevoke = await hostA.nextType('revoked')
  if (!hostRevoke.applied) throw new Error('Case A: host revocation failed')

  const clientRevoked = await clientA.nextType('revoked')
  if (!clientRevoked.activeClosed || !clientRevoked.denied) {
    throw new Error(
      `Case A: revocation incomplete: activeClosed=${String(clientRevoked.activeClosed)}, denied=${String(clientRevoked.denied)}`,
    )
  }

  hostA.send({ type: 'stop', verifyRevokedDeviceId: authoritativeDeviceId })
  const hostAStopped = await hostA.nextType('stopped')
  if (!hostAStopped.fingerprintPersisted || !hostAStopped.revokedPersisted) {
    throw new Error('Case A: host persistence verification failed')
  }
  if (hostAStopped.followupCalls !== 1 || hostAStopped.approvalCalls !== 1) {
    throw new Error(
      `Case A: unexpected seam call counts followup=${hostAStopped.followupCalls} approval=${hostAStopped.approvalCalls}`,
    )
  }
  await Promise.all([hostA.waitExit(), clientA.waitExit()])
  await sigA.stop()
  activeHostProc = undefined
  activeClientProc = undefined

  // ---------------------------------------------------------------------------
  // Case B: Dual-NAT Signaling-Shutdown Independence
  // Shut down signaling completely while WebRTC P2P DataChannel stays open & functional
  // ---------------------------------------------------------------------------
  const sigB = new SelfHostedSignalingServer({
    enabled: true,
    host: wanAddress,
    port: 0,
    hostAuthSecret,
  })
  await sigB.start()
  const sigBUrl = sigB.getEndpointUrl()
  if (!sigBUrl) throw new Error('signaling B failed to start')

  const preRaw = dh.generateKeyPair()
  const prePubHex = Buffer.from(preRaw.publicKey).toString('hex')
  const preSecHex = Buffer.from(preRaw.secretKey).toString('hex')

  const hostB = spawnNetnsScript(hostNetns, 'scripts/r3-webrtc-nat-host.mjs')
  activeHostProc = hostB
  const clientB = spawnNetnsScript(clientNetns, 'scripts/r3-webrtc-nat-client.mjs')
  activeClientProc = clientB

  hostB.send({
    hostBindIp,
    signalingUrl: sigBUrl,
    roomId: 'r3-dual-nat-post-sig',
    hostAuthSecret,
    joinToken,
    stunUrl,
    preTrustedPublicKeysHex: [prePubHex],
    iceConnectTimeoutMs: 6000,
  })
  const hostBReady = await hostB.nextType('ready')

  clientB.send({
    mode: 'post-signaling',
    clientBindIp,
    clientPublicKeyHex: prePubHex,
    clientSecretKeyHex: preSecHex,
    hostPublicKeyHex: hostBReady.hostPublicKeyHex,
    signalingUrl: sigBUrl,
    roomId: 'r3-dual-nat-post-sig',
    joinToken,
    stunUrl,
    iceConnectTimeoutMs: 6000,
  })
  const connectedB = await clientB.nextType('connected')
  if (connectedB.iceDiagnostics?.selectedPair?.remoteAddress !== hostNatWanIp) {
    throw new Error('Case B: post-signaling WebRTC session did not traverse NAT-A external IP')
  }

  await sigB.stop()
  if (sigB.isListening()) {
    throw new Error('Case B: signaling server still listening after stop')
  }

  clientB.send({ type: 'signaling-stopped' })
  hostB.send({
    type: 'ingest-events',
    sessionId: 's1',
    events: [
      { seq: 1, type: 'acceptance/event', data: { marker: 'R3_REAL_EVENT_1' } },
      { seq: 2, type: 'acceptance/event', data: { marker: 'R3_POST_SIG_EVENT_MARKER' } },
    ],
  })
  await hostB.nextType('ingested')
  const postSigOk = await clientB.nextType('post-signaling-ok')
  if (postSigOk.liveSeq !== 2 || postSigOk.liveMarker !== 'R3_POST_SIG_EVENT_MARKER') {
    throw new Error('Case B: P2P live event failed after signaling server shutdown')
  }

  hostB.send({ type: 'stop' })
  await hostB.nextType('stopped')
  await Promise.all([hostB.waitExit(), clientB.waitExit()])
  activeHostProc = undefined
  activeClientProc = undefined

  // ---------------------------------------------------------------------------
  // Case C: Blocked P2P UDP / firewall fail-closed isolation
  // Client behind NAT-C can reach WAN signaling & STUN, P2P UDP is firewalled
  // ---------------------------------------------------------------------------
  const sigC = new SelfHostedSignalingServer({
    enabled: true,
    host: wanAddress,
    port: 0,
    hostAuthSecret,
  })
  await sigC.start()
  const sigCUrl = sigC.getEndpointUrl()
  if (!sigCUrl) throw new Error('signaling C failed to start')

  const blockedRaw = dh.generateKeyPair()
  const blockedPubHex = Buffer.from(blockedRaw.publicKey).toString('hex')
  const blockedSecHex = Buffer.from(blockedRaw.secretKey).toString('hex')

  const hostC = spawnNetnsScript(hostNetns, 'scripts/r3-webrtc-nat-host.mjs')
  activeHostProc = hostC
  const clientC = spawnNetnsScript(blockedClientNetns, 'scripts/r3-webrtc-nat-client.mjs')
  activeClientProc = clientC

  hostC.send({
    hostBindIp,
    signalingUrl: sigCUrl,
    roomId: 'r3-blocked-udp',
    hostAuthSecret,
    joinToken,
    stunUrl,
    preTrustedPublicKeysHex: [blockedPubHex],
    iceConnectTimeoutMs: 1200,
  })
  const hostCReady = await hostC.nextType('ready')

  clientC.send({
    mode: 'expect-blocked',
    clientBindIp: blockedClientBindIp,
    clientPublicKeyHex: blockedPubHex,
    clientSecretKeyHex: blockedSecHex,
    hostPublicKeyHex: hostCReady.hostPublicKeyHex,
    signalingUrl: sigCUrl,
    roomId: 'r3-blocked-udp',
    joinToken,
    stunUrl,
    iceConnectTimeoutMs: 1200,
  })

  const blockedResult = await clientC.nextType('blocked-result', 6000)
  if (!blockedResult.failed || blockedResult.openAfterFailure) {
    throw new Error('Case C: UDP-blocked client did not fail closed cleanly')
  }

  hostC.send({ type: 'wait-active-connections-zero', timeoutMs: 2500 })
  const activeAfterBlocked = await hostC.nextType('active-connections', 4000)
  if (activeAfterBlocked.count !== 0) {
    throw new Error(
      `Case C: host retained ${String(activeAfterBlocked.count)} half-open WebRTC connections after ICE timeout`,
    )
  }

  hostC.send({ type: 'stop' })
  const hostCStopped = await hostC.nextType('stopped')
  await Promise.all([hostC.waitExit(), clientC.waitExit()])
  await sigC.stop()
  activeHostProc = undefined
  activeClientProc = undefined

  const stunStats = stunServer.getStats()
  if (stunStats.responsesSent < 4) {
    throw new Error(`expected at least 4 STUN binding responses, got ${stunStats.responsesSent}`)
  }

  const evidence = {
    schemaVersion: 1,
    commitSha: process.env.GITHUB_SHA ?? 'LOCAL',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    topology: {
      wanAddress,
      hostNetns,
      hostBindIp,
      hostNatWanIp,
      clientNetns,
      clientBindIp,
      blockedClientNetns,
      blockedClientBindIp,
    },
    stunStats,
    caseA_dualNat: {
      selectedPair,
      deviceId: authoritativeDeviceId,
      firstEpoch: firstResume.epoch,
      secondEpoch: secondResume.epoch,
      firstResumeSeqs: firstResume.seqs,
      secondResumeSeqs: secondResume.seqs,
      liveStreamSeq: liveEvent.seq,
      liveStreamMarker: liveEvent.marker,
      officialFollowupCalls: hostAStopped.followupCalls,
      officialApprovalCalls: hostAStopped.approvalCalls,
      activeRevokedChannelTerminated: clientRevoked.activeClosed,
      revokedReconnectDenied: clientRevoked.denied,
      reconnectDelaysMs: clientRevoked.reconnectDelays,
      rssGrowthBytes: hostAStopped.rssGrowthBytes,
    },
    caseB_postSignalingIndependence: {
      selectedPair: connectedB.iceDiagnostics?.selectedPair,
      postSignalingPromptTurnId: postSigOk.promptResult?.turnId,
      postSignalingPromptOk: Boolean(postSigOk.promptResult?.turnId),
      postSignalingLiveSeq: postSigOk.liveSeq,
      postSignalingLiveMarker: postSigOk.liveMarker,
    },
    caseC_blockedUdpFailClosed: {
      clientFailedCleanly: blockedResult.failed,
      hostActiveConnectionsAfterTimeout: activeAfterBlocked.count,
      rssGrowthBytes: hostCStopped.rssGrowthBytes,
    },
    providerCalls: 0,
  }

  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
  console.log('R3_WEBRTC_ACCEPTANCE_OK ' + evidencePath)
} finally {
  activeHostProc?.kill()
  activeClientProc?.kill()
  await stunServer.stop().catch(() => {})
}
