import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { officialApiKeyPresent, resolveOfficialDsh } from '@dsh-community/dsh-bridge'
import {
  defaultRemoteConfigDir,
  defaultRemoteDshHome,
  openPersistentRemoteStores,
} from '@dsh-community/remote-adapter'

export const COMMUNITY_REMOTE_HELP = `dsh-community remote — E2EE 远程宿主机（跑官方 @deepseek-ai/dsh headless）

  dsh-community remote start [选项]     启动官方 DSH 远程宿主并签发配对码
    --host <ip>                         监听地址（默认 127.0.0.1；支持私有网段或 loopback）
    --port <n>                          监听端口（默认 0 自动分配）
    --mdns                              发布局域网 mDNS (_dsh-remote._tcp) 提示
    --relay-url <ws(s)://...>           可选社区盲中继地址
    --relay-room <id>                   可选中继房间 ID
    --signaling-url <ws(s)://...>       可选 WebRTC 信令地址
    --stun <stun:host:port>             可选自建 STUN URL
    --session <id>                      恢复或新建指定官方会话 ID
    --new                               启动时新建一条官方会话
    --cwd <dir>                         工作目录（默认当前目录）
    --json                              输出单行 JSON 就绪信息

  dsh-community remote devices [--json] 列出已配对/已吊销设备
  dsh-community remote revoke <id>      吊销指定设备信任关系
  dsh-community remote status [--json]  查看远程宿主身份指纹与持久存储状态
`

export function composeRemoteHostPatchYaml(options: {
  readonly pluginUrl: string
  readonly workspaceRoot: string
}): string {
  return [
    '- id: hmr',
    '  disabled: true',
    '- id: headless-startup',
    '  disabled: true',
    '- id: headless-runner',
    '  disabled: true',
    '- id: sandbox-policy',
    '  inject: []',
    '  config:',
    '    mode: workspace-write',
    `    workspaceRoot: ${JSON.stringify(options.workspaceRoot)}`,
    '    additionalWritableRoots: []',
    '- id: approval',
    '  config:',
    '    policy: ask',
    '- insert:',
    '    - id: dsh-community-remote',
    `      name: ${JSON.stringify(options.pluginUrl)}`,
    '',
  ].join('\n')
}

interface StartFlags {
  readonly host: string
  readonly port: string
  readonly mdns: boolean
  readonly relayUrl?: string | undefined
  readonly relayRoom?: string | undefined
  readonly signalingUrl?: string | undefined
  readonly stunUrl?: string | undefined
  readonly sessionId?: string | undefined
  readonly cwd: string
  readonly json: boolean
}

function parseStartFlags(args: readonly string[], defaultCwd: string): StartFlags {
  let host = '127.0.0.1'
  let port = '0'
  let mdns = false
  let relayUrl: string | undefined
  let relayRoom: string | undefined
  let signalingUrl: string | undefined
  let stunUrl: string | undefined
  let sessionId: string | undefined
  let cwd = defaultCwd
  let json = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    const nextVal = (): string => {
      const v = args[i + 1]
      if (v === undefined || v.startsWith('-')) {
        throw new Error(`选项 ${arg} 缺少参数值`)
      }
      i += 1
      return v
    }
    if (arg === '--host') host = nextVal()
    else if (arg === '--port') port = nextVal()
    else if (arg === '--mdns') mdns = true
    else if (arg === '--relay-url') relayUrl = nextVal()
    else if (arg === '--relay-room') relayRoom = nextVal()
    else if (arg === '--signaling-url') signalingUrl = nextVal()
    else if (arg === '--stun') stunUrl = nextVal()
    else if (arg === '--session') sessionId = nextVal()
    else if (arg === '--new') sessionId = 'auto'
    else if (arg === '--cwd') cwd = nextVal()
    else if (arg === '--json') json = true
    else throw new Error(`未知参数: ${arg}`)
  }

  return {
    host,
    port,
    mdns,
    relayUrl,
    relayRoom,
    signalingUrl,
    stunUrl,
    sessionId,
    cwd,
    json,
  }
}

async function waitForReadyFile(filePath: string, timeoutMs = 25_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, 'utf8').trim()
      if (raw.length > 0) return JSON.parse(raw) as Record<string, unknown>
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('等待官方 DSH 远程宿主就绪超时')
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

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      for (const line of text.split('\n')) {
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
    })

    let controlUrl = ''
    try {
      const ready = await waitForReadyFile(readyFile)
      controlUrl = String(ready.controlUrl ?? '')
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(ready)}\n`)
      } else {
        process.stdout.write(
          [
            `dsh-community remote 已就绪`,
            `  主机指纹: ${String(ready.hostFingerprint ?? '')}`,
            `  LAN 地址: ${String(ready.lanUrl ?? '')}`,
            `  配置目录: ${String(ready.configDir ?? '')}`,
            `  配对链接: ${String(ready.deepLink ?? '')}`,
            `  配对 JSON: ${String(ready.pairingJson ?? '')}`,
            `交互命令: confirm <candidateId> | devices | revoke <deviceId> | qr | quit`,
          ].join('\n') + '\n',
        )
      }
    } catch (err) {
      if (child.exitCode === null) child.kill('SIGTERM')
      rmSync(tmpDir, { recursive: true, force: true })
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }

    const requestShutdown = async (): Promise<void> => {
      if (controlUrl) {
        await fetch(`${controlUrl}/shutdown`, {
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
            const res = await fetch(`${controlUrl}/pairing/confirm`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${controlToken}`,
              },
              body: JSON.stringify({ candidateId: arg }),
            })
            process.stdout.write(`${await res.text()}\n`)
          } else if (cmd === 'devices') {
            const res = await fetch(`${controlUrl}/devices`, {
              headers: { authorization: `Bearer ${controlToken}` },
            })
            process.stdout.write(`${await res.text()}\n`)
          } else if (cmd === 'revoke' && arg) {
            const res = await fetch(`${controlUrl}/devices/revoke`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${controlToken}`,
              },
              body: JSON.stringify({ deviceId: arg }),
            })
            process.stdout.write(`${await res.text()}\n`)
          } else if (cmd === 'qr') {
            const res = await fetch(`${controlUrl}/pairing-token`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${controlToken}`,
              },
              body: '{}',
            })
            const data = (await res.json()) as { deepLink?: string; pairingJson?: string }
            process.stdout.write(`新配对链接：${data.deepLink ?? ''}\n`)
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
    rmSync(tmpDir, { recursive: true, force: true })
    return exitCode
  }

  process.stderr.write(`未知 remote 子命令: ${sub}\n${COMMUNITY_REMOTE_HELP}`)
  return 2
}
