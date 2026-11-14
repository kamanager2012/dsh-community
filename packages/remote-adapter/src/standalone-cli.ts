import { MultiAgentRemoteHost } from './backends/standalone-host.js'
import type { BridgeControlServerHandle, PairingIssueResult } from './cordis-host.js'
import {
  emitPairingRequestStderr,
  parseAndScrubRemoteHostEnv,
  parseRequestedEngines,
  publishReadyPayload,
} from './remote-env.js'

/**
 * Standalone CLI entrypoint for running the Multi-Agent E2EE Remote Host
 * (Claude Code, Codex CLI, OpenCode ACP) without Cordis or DEEPSEEK_API_KEY.
 */
export async function runStandaloneMultiAgentHost(): Promise<void> {
  const parsed = parseAndScrubRemoteHostEnv(process.env)
  const engines = parseRequestedEngines(parsed.enginesRaw, {
    defaultWhenUnset: ['claude', 'codex', 'opencode'],
    autoEngines: ['claude', 'codex', 'opencode'],
    excludeDsh: true,
  })
  const defaultEngine =
    parsed.defaultEngine && parsed.defaultEngine !== 'dsh' && engines.includes(parsed.defaultEngine)
      ? parsed.defaultEngine
      : undefined

  const host = new MultiAgentRemoteHost({
    engines,
    ...(defaultEngine !== undefined ? { defaultEngine } : {}),
    configDir: parsed.configDir,
    dshHome: parsed.dshHome,
    cwd: parsed.cwd,
    carrier: parsed.carrier,
    ...(parsed.relay !== undefined ? { relay: parsed.relay } : {}),
    ...(parsed.webrtc !== undefined ? { webrtc: parsed.webrtc } : {}),
    ...(parsed.pairingTtlMs !== undefined ? { pairingTtlMs: parsed.pairingTtlMs } : {}),
    ...(parsed.autoConfirmCapabilities !== undefined
      ? { autoConfirmCapabilities: parsed.autoConfirmCapabilities }
      : {}),
    onPairingCandidate: (candidate) => emitPairingRequestStderr(candidate, parsed.autoConfirmCapabilities),
    env: process.env,
  })

  let controlServer: BridgeControlServerHandle | undefined
  let stopping = false
  const shutdown = async (exitCode = 0): Promise<void> => {
    if (stopping) return
    stopping = true
    await controlServer?.close().catch(() => {})
    controlServer = undefined
    await host.stop().catch(() => {})
    process.exit(exitCode)
  }

  process.once('SIGINT', () => {
    void shutdown(0)
  })
  process.once('SIGTERM', () => {
    void shutdown(0)
  })

  await host.start()

  let initialSessionId: string | undefined
  if (parsed.initialSessionEnv !== undefined) {
    if (parsed.initialSessionEnv === 'auto') {
      const availableEngines = (await host.listEngines()).filter(
        (engine) => engine.available && engine.capabilities.createSession,
      )
      const preferred =
        (defaultEngine ? availableEngines.find((e) => e.id === defaultEngine) : undefined) ??
        availableEngines[0]
      if (preferred) {
        const created = await host.createSession({ engine: preferred.id, cwd: parsed.cwd })
        initialSessionId = created.id
      }
    } else {
      const existing = (await host.listSessions()).some((s) => s.id === parsed.initialSessionEnv)
      if (existing) {
        initialSessionId = parsed.initialSessionEnv
      }
    }
  }

  if (parsed.controlPort !== undefined) {
    controlServer = await host.createControlServer({
      port: parsed.controlPort,
      ...(parsed.controlToken !== undefined ? { controlToken: parsed.controlToken } : {}),
      onShutdown: () => {
        void shutdown(0)
      },
    })
  }

  let issuedPairing: PairingIssueResult | undefined
  if (parsed.issuePairingOnStart) {
    issuedPairing = await host.issuePairingDescriptor()
  }

  const [identity, engineDescriptors] = await Promise.all([
    host.stores.hostIdentityStore.getPublicIdentity(),
    host.listEngines(),
  ])
  const readyPayload = {
    mode: 'multi-agent-standalone',
    configDir: host.stores.configDir,
    dshHome: parsed.dshHome,
    hostFingerprint: identity.fingerprint,
    lanUrl: host.runtime.carrier.getEndpointUrl(),
    engines: engineDescriptors,
    ...(parsed.relayUrl !== undefined ? { relayUrl: parsed.relayUrl } : {}),
    ...(host.runtime.relay?.getRoomId() !== undefined
      ? { relayRoomId: host.runtime.relay.getRoomId() }
      : {}),
    ...(parsed.signalingUrl !== undefined ? { signalingUrl: parsed.signalingUrl } : {}),
    ...(host.runtime.webrtc?.getRoomId() !== undefined
      ? { signalingRoomId: host.runtime.webrtc.getRoomId() }
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

const isMain =
  typeof process.argv[1] === 'string' &&
  /(?:^|[\\/])standalone-cli\.(?:mjs|js|ts)$/.test(process.argv[1])

if (isMain) {
  void runStandaloneMultiAgentHost().catch((err: unknown) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err)
    process.stderr.write(`dsh-community standalone host failed to start: ${message}\n`)
    process.exit(1)
  })
}
