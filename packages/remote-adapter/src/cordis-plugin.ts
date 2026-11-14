import { createConfiguredExternalBackends } from './backends/standalone-host.js'
import {
  createBridgeControlServer,
  OfficialHostCordisBridge,
  type BridgeControlServerHandle,
  type OfficialCordisContextLike,
  type PairingIssueResult,
} from './cordis-host.js'
import {
  emitPairingRequestStderr,
  parseAndScrubRemoteHostEnv,
  parseRequestedEngines,
  publishReadyPayload,
} from './remote-env.js'

export const name = 'dsh-community-remote'

export const inject = ['agents', 'userQuestions', 'agentDefaultModel', 'sessions'] as const

export function apply(ctx: OfficialCordisContextLike): () => void {
  const parsed = parseAndScrubRemoteHostEnv(process.env)
  const externalEngines = parseRequestedEngines(parsed.enginesRaw, {
    defaultWhenUnset: [],
    autoEngines: ['claude', 'codex', 'opencode'],
    excludeDsh: true,
  })
  const extraBackends =
    externalEngines.length > 0
      ? createConfiguredExternalBackends({
          engines: externalEngines,
          defaultCwd: parsed.cwd,
          env: process.env,
        })
      : []

  let controlServer: BridgeControlServerHandle | undefined
  let stopping = false

  const bridge = new OfficialHostCordisBridge({
    ctx,
    configDir: parsed.configDir,
    dshHome: parsed.dshHome,
    cwd: parsed.cwd,
    carrier: parsed.carrier,
    ...(extraBackends.length > 0 ? { extraBackends } : {}),
    ...(parsed.defaultEngine !== undefined ? { defaultEngine: parsed.defaultEngine } : {}),
    ...(parsed.relay !== undefined ? { relay: parsed.relay } : {}),
    ...(parsed.webrtc !== undefined ? { webrtc: parsed.webrtc } : {}),
    ...(parsed.pairingTtlMs !== undefined ? { pairingTtlMs: parsed.pairingTtlMs } : {}),
    ...(parsed.autoConfirmCapabilities !== undefined
      ? { autoConfirmCapabilities: parsed.autoConfirmCapabilities }
      : {}),
    onPairingCandidate: (candidate) => emitPairingRequestStderr(candidate, parsed.autoConfirmCapabilities),
  })

  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await controlServer?.close().catch(() => {})
    controlServer = undefined
    await bridge.stop().catch(() => {})
  }

  const boot = async (): Promise<void> => {
    await bridge.start()

    let initialSessionId: string | undefined
    if (parsed.initialSessionEnv !== undefined) {
      if (parsed.initialSessionEnv === 'auto') {
        const created = await bridge.createSession({
          cwd: parsed.cwd,
          ...(parsed.defaultEngine !== undefined ? { engine: parsed.defaultEngine } : {}),
        })
        initialSessionId = created.id
      } else {
        const existing = (await bridge.listSessions()).some((s) => s.id === parsed.initialSessionEnv)
        if (existing) {
          await bridge.ensureLiveAgent(parsed.initialSessionEnv)
          initialSessionId = parsed.initialSessionEnv
        } else {
          const created = await bridge.createSession({
            sessionId: parsed.initialSessionEnv,
            cwd: parsed.cwd,
            ...(parsed.defaultEngine !== undefined ? { engine: parsed.defaultEngine } : {}),
          })
          initialSessionId = created.id
        }
      }
    }

    if (parsed.controlPort !== undefined) {
      controlServer = await createBridgeControlServer(bridge, {
        port: parsed.controlPort,
        ...(parsed.controlToken !== undefined ? { controlToken: parsed.controlToken } : {}),
        onShutdown: () => {
          process.exit(0)
        },
      })
    }

    let issuedPairing: PairingIssueResult | undefined
    if (parsed.issuePairingOnStart) {
      issuedPairing = await bridge.issuePairingDescriptor()
    }

    const [identity, engines] = await Promise.all([
      bridge.stores.hostIdentityStore.getPublicIdentity(),
      bridge.listEngines(),
    ])
    const readyPayload = {
      configDir: bridge.stores.configDir,
      dshHome: parsed.dshHome,
      hostFingerprint: identity.fingerprint,
      lanUrl: bridge.runtime.carrier.getEndpointUrl(),
      engines,
      ...(parsed.relayUrl !== undefined ? { relayUrl: parsed.relayUrl } : {}),
      ...(bridge.runtime.relay?.getRoomId() !== undefined
        ? { relayRoomId: bridge.runtime.relay.getRoomId() }
        : {}),
      ...(parsed.signalingUrl !== undefined ? { signalingUrl: parsed.signalingUrl } : {}),
      ...(bridge.runtime.webrtc?.getRoomId() !== undefined
        ? { signalingRoomId: bridge.runtime.webrtc.getRoomId() }
        : {}),
      ...(parsed.stunUrls !== undefined && parsed.stunUrls.length > 0
        ? { stunUrls: parsed.stunUrls }
        : {}),
      ...(initialSessionId !== undefined ? { sessionId: initialSessionId } : {}),
      ...(controlServer !== undefined
        ? { controlUrl: controlServer.url, controlToken: controlServer.controlToken }
        : {}),
      ...(issuedPairing !== undefined
        ? {
            pairingJson: issuedPairing.pairingJson,
            deepLink: issuedPairing.deepLink,
            expiresAt: issuedPairing.expiresAt,
          }
        : {}),
    }

    publishReadyPayload(parsed.readyFile, parsed.emitReadyStdout, readyPayload)
  }

  void boot().catch((err: unknown) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err)
    process.stderr.write(`dsh-community-remote failed to start: ${message}\n`)
    process.exitCode = 1
  })

  return () => {
    void shutdown()
  }
}
