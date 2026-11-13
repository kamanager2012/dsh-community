import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'
import {
  buildLoopbackPairingWarning,
  composeRemoteHostPatchYaml,
  detectLanIpv4Candidates,
  officialApiKeyPresent,
  readLiveControlEndpoint,
  removeOwnLiveControlEndpoint,
  renderTerminalQr,
  resolveOfficialDsh,
  waitForReadyFile,
  writeLiveControlEndpoint,
} from '@dsh-community/dsh-bridge'
import {
  BlindRelayServer,
  defaultRemoteConfigDir,
  defaultRemoteDshHome,
  openPersistentRemoteStores,
  SelfHostedSignalingServer,
  SelfHostedStunServer,
} from '@dsh-community/remote-adapter'

export { buildLoopbackPairingWarning, composeRemoteHostPatchYaml, detectLanIpv4Candidates }

export const COMMUNITY_REMOTE_HELP = `dsh-community remote — E2EE 远程宿主机与自托管信令/中继（官方 @deepseek-ai/dsh headless）

  dsh-community remote start [选项]     启动官方 DSH 远程宿主并签发配对码
    --host <ip>                         监听地址（默认 127.0.0.1；支持私有网段或 loopback）
    --port <n>                          监听端口（默认 0 自动分配）
    --mdns                              发布局域网 mDNS (_dsh-remote._tcp) 提示
    --qr                                启动后在终端输出可扫码 UTF-8 二维码
    --relay-url <ws(s)://...>           可选社区盲中继地址
    --relay-room <id>                   可选中继房间 ID
    --signaling-url <ws(s)://...>       可选 WebRTC 信令地址
    --signaling-room <id>               可选 WebRTC 信令房间 ID
    --stun <stun:host:port[,...]>       可选自建 STUN URL（支持逗号分隔多条）
    --session <id>                      恢复或新建指定官方会话 ID
    --new                               启动时新建一条官方会话
    --cwd <dir>                         工作目录（默认当前目录）
    --json                              输出单行 JSON 就绪信息

  dsh-community remote relay [选项]     运行自托管盲中继 BlindRelayServer（仅转发密文帧）
    --host <ip>                         绑定 IP 地址（默认 127.0.0.1）
    --port <n>                          TCP/WS 端口（默认 8787；0 为系统分配）
    --allow-wildcard                    显式允许 0.0.0.0 / :: 通配地址监听
    --host-secret <secret>              可选宿主注册鉴权密钥（或设 DSH_REMOTE_RELAY_HOST_SECRET）
    --max-rooms <n>                     最大房间数（默认 64）
    --max-frame-bytes <n>               单帧密文上限字节（默认 65536）
    --max-fps <n>                       单连接每秒帧率上限（默认 240）
    --json                              输出单行 JSON 就绪信息（不含任何密钥）

  dsh-community remote signaling [选项] 运行自托管 WebRTC 信令服务器（可选联动自建 STUN）
    --host <ip>                         绑定 IP 地址（默认 127.0.0.1）
    --port <n>                          TCP/WS 端口（默认 8788；0 为系统分配）
    --stun-host <ip>                    可选 STUN UDP 绑定 IP（默认复用 --host）
    --stun-port <n>                     可选同时拉起自建 STUN Server（UDP 端口，0 为自动分配）
    --allow-wildcard                    显式允许 0.0.0.0 / :: 通配地址监听
    --host-secret <secret>              可选宿主注册鉴权密钥（或设 DSH_REMOTE_SIGNALING_HOST_SECRET）
    --max-rooms <n>                     最大房间数（默认 64）
    --json                              输出单行 JSON 就绪信息（不含任何密钥）

  dsh-community remote devices [--json] 列出已配对/已吊销设备
  dsh-community remote revoke <id>      吊销指定设备信任关系
  dsh-community remote status [--json]  查看远程宿主身份指纹与持久存储状态
`

export function formatPairingQrBlock(deepLink: string, isTty: boolean): string {
  if (deepLink.trim().length === 0) return ''
  try {
    return `\n${renderTerminalQr(deepLink, { eccLevel: 'L', quietZone: 2, ansiWhiteBackground: isTty })}`
  } catch {
    return ''
  }
}

interface StartFlags {
  readonly host: string
  readonly port: string
  readonly mdns: boolean
  readonly qr: boolean
  readonly relayUrl?: string | undefined
  readonly relayRoom?: string | undefined
  readonly signalingUrl?: string | undefined
  readonly signalingRoom?: string | undefined
  readonly stunUrl?: string | undefined
  readonly sessionId?: string | undefined
  readonly cwd: string
  readonly json: boolean
}

function takeFlagValue(args: readonly string[], index: number, flag: string): { value: string; nextIndex: number } {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`选项 ${flag} 缺少参数值`)
  }
  return { value, nextIndex: index + 1 }
}

function parsePortValue(raw: string, flag: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`选项 ${flag} 端口号无效: ${raw}`)
  }
  return port
}

function parsePositiveIntValue(raw: string, flag: string): number {
  const val = Number(raw)
  if (!Number.isSafeInteger(val) || val < 1) {
    throw new Error(`选项 ${flag} 必须为正整数: ${raw}`)
  }
  return val
}

function parseStartFlags(args: readonly string[], defaultCwd: string): StartFlags {
  let host = '127.0.0.1'
  let port = '0'
  let mdns = false
  let qr = false
  let relayUrl: string | undefined
  let relayRoom: string | undefined
  let signalingUrl: string | undefined
  let signalingRoom: string | undefined
  let stunUrl: string | undefined
  let sessionId: string | undefined
  let cwd = defaultCwd
  let json = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    const readVal = (): string => {
      const res = takeFlagValue(args, i, arg)
      i = res.nextIndex
      return res.value
    }
    if (arg === '--host') host = readVal()
    else if (arg === '--port') port = String(parsePortValue(readVal(), '--port'))
    else if (arg === '--mdns') mdns = true
    else if (arg === '--qr') qr = true
    else if (arg === '--relay-url') relayUrl = readVal()
    else if (arg === '--relay-room') relayRoom = readVal()
    else if (arg === '--signaling-url') signalingUrl = readVal()
    else if (arg === '--signaling-room') signalingRoom = readVal()
    else if (arg === '--stun') stunUrl = readVal()
    else if (arg === '--session') sessionId = readVal()
    else if (arg === '--new') sessionId = 'auto'
    else if (arg === '--cwd') cwd = readVal()
    else if (arg === '--json') json = true
    else throw new Error(`未知参数: ${arg}`)
  }

  return {
    host,
    port,
    mdns,
    qr,
    relayUrl,
    relayRoom,
    signalingUrl,
    signalingRoom,
    stunUrl,
    sessionId,
    cwd,
    json,
  }
}

interface RelayFlags {
  readonly host: string
  readonly port: number
  readonly allowWildcard: boolean
  readonly hostSecret?: string | undefined
  readonly maxRooms?: number | undefined
  readonly maxFrameBytes?: number | undefined
  readonly maxFps?: number | undefined
  readonly json: boolean
}

function parseRelayFlags(args: readonly string[], env: NodeJS.ProcessEnv): RelayFlags {
  let host = '127.0.0.1'
  let port = 8787
  let allowWildcard = false
  let hostSecret = env.DSH_REMOTE_RELAY_HOST_SECRET?.trim() || undefined
  let maxRooms: number | undefined
  let maxFrameBytes: number | undefined
  let maxFps: number | undefined
  let json = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    const readVal = (): string => {
      const res = takeFlagValue(args, i, arg)
      i = res.nextIndex
      return res.value
    }
    if (arg === '--host') host = readVal()
    else if (arg === '--port') port = parsePortValue(readVal(), '--port')
    else if (arg === '--allow-wildcard') allowWildcard = true
    else if (arg === '--host-secret') hostSecret = readVal()
    else if (arg === '--max-rooms') maxRooms = parsePositiveIntValue(readVal(), '--max-rooms')
    else if (arg === '--max-frame-bytes') maxFrameBytes = parsePositiveIntValue(readVal(), '--max-frame-bytes')
    else if (arg === '--max-fps') maxFps = parsePositiveIntValue(readVal(), '--max-fps')
    else if (arg === '--json') json = true
    else throw new Error(`未知参数: ${arg}`)
  }

  return { host, port, allowWildcard, hostSecret, maxRooms, maxFrameBytes, maxFps, json }
}

interface SignalingFlags {
  readonly host: string
  readonly port: number
  readonly stunHost?: string | undefined
  readonly stunPort?: number | undefined
  readonly allowWildcard: boolean
  readonly hostSecret?: string | undefined
  readonly maxRooms?: number | undefined
  readonly json: boolean
}

function parseSignalingFlags(args: readonly string[], env: NodeJS.ProcessEnv): SignalingFlags {
  let host = '127.0.0.1'
  let port = 8788
  let stunHost: string | undefined
  let stunPort: number | undefined
  let allowWildcard = false
  let hostSecret = env.DSH_REMOTE_SIGNALING_HOST_SECRET?.trim() || undefined
  let maxRooms: number | undefined
  let json = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    const readVal = (): string => {
      const res = takeFlagValue(args, i, arg)
      i = res.nextIndex
      return res.value
    }
    if (arg === '--host') host = readVal()
    else if (arg === '--port') port = parsePortValue(readVal(), '--port')
    else if (arg === '--stun-host') stunHost = readVal()
    else if (arg === '--stun-port') stunPort = parsePortValue(readVal(), '--stun-port')
    else if (arg === '--allow-wildcard') allowWildcard = true
    else if (arg === '--host-secret') hostSecret = readVal()
    else if (arg === '--max-rooms') maxRooms = parsePositiveIntValue(readVal(), '--max-rooms')
    else if (arg === '--json') json = true
    else throw new Error(`未知参数: ${arg}`)
  }

  return { host, port, stunHost, stunPort, allowWildcard, hostSecret, maxRooms, json }
}

async function waitForShutdownSignal(stopFn: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    const onSignal = (): void => {
      if (settled) return
      settled = true
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      void stopFn().finally(resolve)
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  })
}

async function fetchControl(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  })
}

export async function runRemoteCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  explicitDshHome?: string,
): Promise<number> {
  const sub = args[0]
  if (sub === undefined || sub === '-h' || sub === '--help' || sub === 'help') {
    process.stdout.write(COMMUNITY_REMOTE_HELP)
    return 0
  }

  const dshHome = explicitDshHome ?? defaultRemoteDshHome(env, homedir())
  const configDir = defaultRemoteConfigDir(env, homedir())

  if (sub === 'devices') {
    const asJson = args.includes('--json')
    const stores = openPersistentRemoteStores({ configDir, dshHome })
    const list = await stores.trustStore.list()
    const payload = list.map((d) => ({
      deviceId: d.deviceId,
      displayName: d.displayName,
      capabilities: [...d.grantedCapabilities],
      pairedAt: d.pairedAt,
      lastSeenAt: d.lastSeenAt,
      ...(d.revokedAt !== undefined ? { revokedAt: d.revokedAt } : {}),
    }))
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ configDir: stores.configDir, devices: payload })}\n`)
    } else if (payload.length === 0) {
      process.stdout.write(`无已配对设备（配置目录：${stores.configDir}）\n`)
    } else {
      for (const item of payload) {
        const status = item.revokedAt !== undefined ? 'REVOKED' : 'ACTIVE'
        process.stdout.write(
          `${status}\t${item.deviceId}\t${item.displayName}\t[${item.capabilities.join(',')}]\n`,
        )
      }
    }
    return 0
  }

  if (sub === 'revoke') {
    const targetId = args[1]
    if (!targetId || targetId.startsWith('-')) {
      process.stderr.write('用法：dsh-community remote revoke <deviceId>\n')
      return 2
    }
    const stores = openPersistentRemoteStores({ configDir, dshHome })
    const live = readLiveControlEndpoint(stores.configDir)
    if (live) {
      try {
        const res = await fetchControl(`${live.controlUrl}/devices/revoke`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${live.controlToken}`,
          },
          body: JSON.stringify({ deviceId: targetId }),
        })
        if (res.ok) {
          const body = (await res.json()) as { revoked?: boolean }
          if (!body.revoked) {
            process.stderr.write(`未找到可吊销设备：${targetId}\n`)
            return 1
          }
          process.stdout.write(`已吊销设备：${targetId}（在线会话已断开）\n`)
          return 0
        }
      } catch {
        // Fallback to offline durable trust store below when live control is unreachable
      }
    }
    const revoked = await stores.trustStore.revoke(targetId)
    if (!revoked) {
      process.stderr.write(`未找到可吊销设备：${targetId}\n`)
      return 1
    }
    process.stdout.write(`已吊销设备：${targetId}\n`)
    return 0
  }

  if (sub === 'status') {
    const asJson = args.includes('--json')
    const stores = openPersistentRemoteStores({ configDir, dshHome })
    const devices = await stores.trustStore.list()
    let hostFingerprint: string | undefined
    if (existsSync(stores.hostIdentityPath)) {
      hostFingerprint = (await stores.hostIdentityStore.getPublicIdentity()).fingerprint
    }
    const summary = {
      configDir: stores.configDir,
      dshHome,
      hostIdentityInitialized: hostFingerprint !== undefined,
      ...(hostFingerprint !== undefined ? { hostFingerprint } : {}),
      activeDevices: devices.filter((d) => d.revokedAt === undefined).length,
      revokedDevices: devices.filter((d) => d.revokedAt !== undefined).length,
    }
    if (asJson) {
      process.stdout.write(`${JSON.stringify(summary)}\n`)
    } else {
      process.stdout.write(
        [
          `Remote 配置目录：${summary.configDir}`,
          `官方 DSH_HOME：${summary.dshHome}`,
          `主机指纹：${summary.hostFingerprint ?? '尚未初始化（首次 start 时生成）'}`,
          `信任设备：${summary.activeDevices} 个生效，${summary.revokedDevices} 个已吊销`,
        ].join('\n') + '\n',
      )
    }
    return 0
  }

  if (sub === 'start') {
    let flags: StartFlags
    try {
      flags = parseStartFlags(args.slice(1), process.cwd())
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 2
    }

    if (!officialApiKeyPresent(env)) {
      process.stderr.write('请先设置 DEEPSEEK_API_KEY 再启动 dsh-community remote start\n')
      return 2
    }

    const req = createRequire(import.meta.url)
    const pluginEntry = req.resolve('@dsh-community/remote-adapter/cordis-plugin')
    const pluginUrl = pathToFileURL(pluginEntry).href
    const install = resolveOfficialDsh({ from: import.meta.url })
    const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-community-remote-'))
    const patchFile = join(tmpDir, 'remote-host.patch.yml')
    const readyFile = join(tmpDir, 'ready.json')
    const controlToken = randomBytes(24).toString('hex')

    writeFileSync(
      patchFile,
      composeRemoteHostPatchYaml({ pluginUrl, workspaceRoot: flags.cwd }),
      'utf8',
    )

    const child = spawn(
      process.execPath,
      [install.binPath, '--profile', 'headless', '--patch', patchFile],
      {
        cwd: flags.cwd,
        env: {
          ...env,
          DSH_HOME: dshHome,
          DSH_REMOTE_DSH_HOME: dshHome,
          DSH_REMOTE_CONFIG_DIR: configDir,
          DSH_REMOTE_CWD: flags.cwd,
          DSH_REMOTE_LAN_HOST: flags.host,
          DSH_REMOTE_LAN_PORT: flags.port,
          ...(flags.mdns ? { DSH_REMOTE_ENABLE_MDNS: '1' } : {}),
          ...(flags.relayUrl ? { DSH_REMOTE_RELAY_URL: flags.relayUrl } : {}),
          ...(flags.relayRoom ? { DSH_REMOTE_RELAY_ROOM_ID: flags.relayRoom } : {}),
          ...(flags.signalingUrl ? { DSH_REMOTE_SIGNALING_URL: flags.signalingUrl } : {}),
          ...(flags.signalingRoom ? { DSH_REMOTE_SIGNALING_ROOM_ID: flags.signalingRoom } : {}),
          ...(flags.stunUrl ? { DSH_REMOTE_STUN_URLS: flags.stunUrl } : {}),
          ...(flags.sessionId ? { DSH_REMOTE_INITIAL_SESSION_ID: flags.sessionId } : {}),
          DSH_REMOTE_CONTROL_PORT: '0',
          DSH_REMOTE_CONTROL_TOKEN: controlToken,
          DSH_REMOTE_READY_FILE: readyFile,
          DSH_REMOTE_ISSUE_PAIRING: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    child.stdout.resume()

    const stderrDecoder = new StringDecoder('utf8')
    let stderrLineBuffer = ''
    const handleStderrLine = (line: string): void => {
      if (line.startsWith('DSH_REMOTE_PAIRING_REQUEST ')) {
        try {
          const reqInfo = JSON.parse(line.slice('DSH_REMOTE_PAIRING_REQUEST '.length)) as {
            candidateId: string
            displayName: string
            deviceId: string
          }
          process.stdout.write(
            `\n收到配对请求：${reqInfo.displayName} (${reqInfo.deviceId})\n输入 confirm ${reqInfo.candidateId} 授权此设备。\n`,
          )
        } catch {}
      } else if (line.trim().length > 0 && !flags.json) {
        process.stderr.write(`${line}\n`)
      }
    }

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrLineBuffer += typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk)
      for (;;) {
        const nl = stderrLineBuffer.indexOf('\n')
        if (nl === -1) break
        const line = stderrLineBuffer.slice(0, nl).replace(/\r$/u, '')
        stderrLineBuffer = stderrLineBuffer.slice(nl + 1)
        handleStderrLine(line)
      }
    })
    child.stderr.on('close', () => {
      stderrLineBuffer += stderrDecoder.end()
      const trailing = stderrLineBuffer.replace(/\r$/u, '')
      stderrLineBuffer = ''
      if (trailing.length > 0) handleStderrLine(trailing)
    })

    let controlUrl = ''
    let resolvedConfigDir = ''
    try {
      const ready = await waitForReadyFile(readyFile, child)
      controlUrl = String(ready.controlUrl ?? '')
      resolvedConfigDir = typeof ready.configDir === 'string' ? ready.configDir : ''
      if (controlUrl && resolvedConfigDir) {
        try {
          writeLiveControlEndpoint(resolvedConfigDir, {
            pid: process.pid,
            controlUrl,
            controlToken,
          })
        } catch {}
      }
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(ready)}\n`)
      } else {
        const lines = [
          `dsh-community remote 已就绪`,
          `  主机指纹: ${String(ready.hostFingerprint ?? '')}`,
          `  LAN 地址: ${String(ready.lanUrl ?? '')}`,
        ]
        if (ready.signalingUrl) lines.push(`  WebRTC 信令: ${String(ready.signalingUrl)}`)
        if (Array.isArray(ready.stunUrls) && ready.stunUrls.length > 0) {
          lines.push(`  STUN 地址: ${ready.stunUrls.join(', ')}`)
        }
        if (ready.relayUrl) lines.push(`  盲中继地址: ${String(ready.relayUrl)}`)
        lines.push(
          `  配置目录: ${String(ready.configDir ?? '')}`,
          `  配对链接: ${String(ready.deepLink ?? '')}`,
          `  配对 JSON: ${String(ready.pairingJson ?? '')}`,
          ...((() => {
            const warning = buildLoopbackPairingWarning(ready)
            return warning ? [warning] : []
          })()),
          ...(flags.qr && typeof ready.deepLink === 'string' && ready.deepLink.length > 0
            ? [formatPairingQrBlock(ready.deepLink, Boolean(process.stdout.isTTY))]
            : []),
          `交互命令: confirm <candidateId> | devices | revoke <deviceId> | qr | quit`,
        )
        process.stdout.write(`${lines.join('\n')}\n`)
      }
    } catch (err) {
      if (child.exitCode === null) child.kill('SIGTERM')
      rmSync(tmpDir, { recursive: true, force: true })
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }

    const requestShutdown = async (): Promise<void> => {
      if (controlUrl) {
        await fetchControl(`${controlUrl}/shutdown`, {
          method: 'POST',
          headers: { authorization: `Bearer ${controlToken}` },
        }).catch(() => {})
      } else if (child.exitCode === null) {
        child.kill('SIGTERM')
      }
    }

    const onSignal = (): void => {
      void requestShutdown()
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)

    let rl: ReturnType<typeof createInterface> | undefined
    if (process.stdin.isTTY && controlUrl) {
      rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
      rl.on('line', async (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        const [cmd, arg] = trimmed.split(/\s+/, 2)
        try {
          if (cmd === 'confirm' && arg) {
            const res = await fetchControl(`${controlUrl}/pairing/confirm`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${controlToken}`,
              },
              body: JSON.stringify({ candidateId: arg }),
            })
            process.stdout.write(`${await res.text()}\n`)
          } else if (cmd === 'devices') {
            const res = await fetchControl(`${controlUrl}/devices`, {
              headers: { authorization: `Bearer ${controlToken}` },
            })
            process.stdout.write(`${await res.text()}\n`)
          } else if (cmd === 'revoke' && arg) {
            const res = await fetchControl(`${controlUrl}/devices/revoke`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${controlToken}`,
              },
              body: JSON.stringify({ deviceId: arg }),
            })
            process.stdout.write(`${await res.text()}\n`)
          } else if (cmd === 'qr') {
            const res = await fetchControl(`${controlUrl}/pairing-token`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${controlToken}`,
              },
              body: '{}',
            })
            const data = (await res.json()) as { deepLink?: string; pairingJson?: string }
            const deepLink = data.deepLink ?? ''
            process.stdout.write(`新配对链接：${deepLink}\n`)
            const qrBlock = formatPairingQrBlock(deepLink, Boolean(process.stdout.isTTY))
            if (qrBlock.length > 0) {
              process.stdout.write(`${qrBlock}\n`)
            }
          } else if (cmd === 'quit' || cmd === 'exit') {
            await requestShutdown()
          }
        } catch (err) {
          process.stderr.write(`控制命令失败: ${err instanceof Error ? err.message : String(err)}\n`)
        }
      })
    }

    const exitCode = await new Promise<number>((resolveExit) => {
      child.once('exit', (code) => resolveExit(code ?? 0))
    })
    rl?.close()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (resolvedConfigDir) {
      removeOwnLiveControlEndpoint(resolvedConfigDir)
    }
    rmSync(tmpDir, { recursive: true, force: true })
    return exitCode
  }

  if (sub === 'relay') {
    let flags: RelayFlags
    try {
      flags = parseRelayFlags(args.slice(1), env)
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 2
    }

    const relay = new BlindRelayServer({
      enabled: true,
      host: flags.host,
      port: flags.port,
      allowWildcardHost: flags.allowWildcard,
      ...(flags.hostSecret !== undefined ? { hostAuthSecret: flags.hostSecret } : {}),
      ...(flags.maxRooms !== undefined ? { maxRooms: flags.maxRooms } : {}),
      ...(flags.maxFrameBytes !== undefined ? { maxOpaquePayloadBytes: flags.maxFrameBytes } : {}),
      ...(flags.maxFps !== undefined ? { maxFramesPerSecond: flags.maxFps } : {}),
    })
    try {
      await relay.start()
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }

    const bound = relay.getBoundAddress()
    const endpointUrl = relay.getEndpointUrl() ?? ''
    const healthzUrl = endpointUrl.replace(/^ws:/u, 'http:') + '/healthz'
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({
          kind: 'blind-relay',
          host: bound?.host ?? flags.host,
          port: bound?.port ?? flags.port,
          endpointUrl,
          healthzUrl,
          authRequired: flags.hostSecret !== undefined && flags.hostSecret.length > 0,
        })}\n`,
      )
    } else {
      process.stdout.write(
        [
          `dsh-community 盲中继 (BlindRelayServer) 已监听`,
          `  WS 地址: ${endpointUrl}`,
          `  健康检查: ${healthzUrl}`,
          `  宿主鉴权: ${flags.hostSecret ? '已启用 (hostAuthSecret)' : '未启用'}`,
          `按 Ctrl+C / SIGTERM 优雅关闭。`,
        ].join('\n') + '\n',
      )
    }

    await waitForShutdownSignal(() => relay.stop())
    return 0
  }

  if (sub === 'signaling') {
    let flags: SignalingFlags
    try {
      flags = parseSignalingFlags(args.slice(1), env)
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 2
    }

    const signaling = new SelfHostedSignalingServer({
      enabled: true,
      host: flags.host,
      port: flags.port,
      allowWildcardHost: flags.allowWildcard,
      ...(flags.hostSecret !== undefined ? { hostAuthSecret: flags.hostSecret } : {}),
      ...(flags.maxRooms !== undefined ? { maxRooms: flags.maxRooms } : {}),
    })
    const stun =
      flags.stunPort !== undefined
        ? new SelfHostedStunServer({
            enabled: true,
            host: flags.stunHost ?? flags.host,
            port: flags.stunPort,
          })
        : undefined

    try {
      await signaling.start()
      if (stun) {
        await stun.start()
      }
    } catch (err) {
      await Promise.allSettled([signaling.stop(), stun ? stun.stop() : Promise.resolve()])
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }

    const bound = signaling.getBoundAddress()
    const endpointUrl = signaling.getEndpointUrl() ?? ''
    const healthzUrl = endpointUrl.replace(/^ws:/u, 'http:') + '/healthz'
    const stunUrl = stun?.getStunUrl()
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({
          kind: 'webrtc-signaling',
          host: bound?.host ?? flags.host,
          port: bound?.port ?? flags.port,
          endpointUrl,
          healthzUrl,
          authRequired: flags.hostSecret !== undefined && flags.hostSecret.length > 0,
          ...(stunUrl !== undefined ? { stunUrl } : {}),
        })}\n`,
      )
    } else {
      const lines = [
        `dsh-community WebRTC 信令 (SelfHostedSignalingServer) 已监听`,
        `  WS 地址: ${endpointUrl}`,
        `  健康检查: ${healthzUrl}`,
        `  宿主鉴权: ${flags.hostSecret ? '已启用 (hostAuthSecret)' : '未启用'}`,
      ]
      if (stunUrl) {
        lines.push(`  STUN 地址: ${stunUrl}`)
      }
      lines.push(`按 Ctrl+C / SIGTERM 优雅关闭。`)
      process.stdout.write(`${lines.join('\n')}\n`)
    }

    await waitForShutdownSignal(async () => {
      await Promise.allSettled([signaling.stop(), stun ? stun.stop() : Promise.resolve()])
    })
    return 0
  }

  process.stderr.write(`未知 remote 子命令: ${sub}\n${COMMUNITY_REMOTE_HELP}`)
  return 2
}
