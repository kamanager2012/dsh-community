import { describe, expect, it } from 'vitest'
import {
  normalizeStunUrlList,
  parseAndScrubRemoteHostEnv,
  resolveRemoteDefaultTransportEnv,
  validateWsEndpointUrl,
} from '../src/remote-env.js'

describe('remote-env unified relay/signaling/STUN defaults', () => {
  it('resolves DSH_REMOTE_DEFAULT_* fallbacks when explicit flags/vars are absent', () => {
    const res = resolveRemoteDefaultTransportEnv({
      DSH_REMOTE_DEFAULT_RELAY_URL: 'wss://relay.dsh.example/ws',
      DSH_REMOTE_DEFAULT_SIGNALING_URL: 'wss://signal.dsh.example/ws',
      DSH_REMOTE_DEFAULT_STUN_URLS: 'stun:stun1.dsh.example:3478, stun:stun2.dsh.example:3478',
    })
    expect(res.error).toBeUndefined()
    expect(res.relayUrl).toBe('wss://relay.dsh.example/ws')
    expect(res.signalingUrl).toBe('wss://signal.dsh.example/ws')
    expect(res.stunUrlsRaw).toBe('stun:stun1.dsh.example:3478, stun:stun2.dsh.example:3478')
    expect(res.stunUrls).toEqual(['stun:stun1.dsh.example:3478', 'stun:stun2.dsh.example:3478'])
  })

  it('prefers explicit values and DSH_REMOTE_* overrides over DSH_REMOTE_DEFAULT_*', () => {
    const res = resolveRemoteDefaultTransportEnv(
      {
        DSH_REMOTE_RELAY_URL: 'wss://env-relay.example/ws',
        DSH_REMOTE_DEFAULT_RELAY_URL: 'wss://default-relay.example/ws',
        DSH_REMOTE_DEFAULT_SIGNALING_URL: 'wss://default-sig.example/ws',
        DSH_REMOTE_DEFAULT_STUN_URLS: 'stun:default.example:3478',
      },
      {
        signalingUrl: 'wss://explicit-sig.example/ws',
      },
    )
    expect(res.error).toBeUndefined()
    expect(res.relayUrl).toBe('wss://env-relay.example/ws')
    expect(res.signalingUrl).toBe('wss://explicit-sig.example/ws')
    expect(res.stunUrls).toEqual(['stun:default.example:3478'])
  })

  it('enforces ws/wss and strict R3 stun-only (rejecting turn:/turns:/https:)', () => {
    expect(validateWsEndpointUrl('https://bad.example.com', 'Relay')).toContain('ws://')
    expect(normalizeStunUrlList('turn:relay.example.com:3478').ok).toBe(false)
    expect(normalizeStunUrlList('turns:relay.example.com:5349').ok).toBe(false)

    const badStun = resolveRemoteDefaultTransportEnv({
      DSH_REMOTE_DEFAULT_STUN_URLS: 'turn:forbidden-turn.example.com:3478',
    })
    expect(badStun.error).toContain('stun:host:port')

    const overriddenGood = resolveRemoteDefaultTransportEnv(
      {
        DSH_REMOTE_DEFAULT_STUN_URLS: 'turn:forbidden-turn.example.com:3478',
      },
      {
        stunUrls: 'stun:selfhosted.example:3478',
      },
    )
    expect(overriddenGood.error).toBeUndefined()
    expect(overriddenGood.stunUrls).toEqual(['stun:selfhosted.example:3478'])
  })

  it('populates parsed host carrier config from DSH_REMOTE_DEFAULT_* in parseAndScrubRemoteHostEnv', () => {
    const env: NodeJS.ProcessEnv = {
      DSH_REMOTE_DEFAULT_RELAY_URL: 'wss://relay.dsh.example/ws',
      DSH_REMOTE_DEFAULT_SIGNALING_URL: 'wss://signal.dsh.example/ws',
      DSH_REMOTE_DEFAULT_STUN_URLS: 'stun:stun.dsh.example:3478',
      DSH_REMOTE_RELAY_HOST_SECRET: 'host-secret',
    }
    const parsed = parseAndScrubRemoteHostEnv(env)
    expect(env.DSH_REMOTE_RELAY_HOST_SECRET).toBeUndefined()
    expect(parsed.relay).toEqual({
      enabled: true,
      relayUrl: 'wss://relay.dsh.example/ws',
      hostAuthSecret: 'host-secret',
    })
    expect(parsed.webrtc).toEqual({
      enabled: true,
      signalingUrl: 'wss://signal.dsh.example/ws',
      ice: { stunUrls: ['stun:stun.dsh.example:3478'] },
    })
  })
})
