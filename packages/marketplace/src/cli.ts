/**
 * Plain-text marketplace CLI: list / info / install / audit / mcp-wrap.
 * No UI toolkit on purpose — the Desktop shell and the TUI both reuse this entrypoint.
 */
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { parseCatalog, needsInstallConfirmation, type PluginSecurity } from './catalog.js'
import { defaultCachePath, fetchCatalog } from './client.js'
import { classifyPlugin, searchPlugins } from './compat.js'
import { installPlugin } from './install.js'
import { auditPluginSecurity } from './audit.js'
import { generateMcpDshPlugin, type McpServerConfig } from './mcp-adapter.js'

/** 契约验证线:与插件注册表(dsh-community-plugins)当前 testedDsh 对齐。 */
export const DSH_TESTED_VERSION = '0.1.1-rc.2'

/** npm 包名与 semver 的最小格式门禁:catalog 数据进官方 CLI argv 前必须通过。 */
const NPM_NAME_RE = /^(@[a-z0-9-][a-z0-9-._]*\/)?[a-z0-9-][a-z0-9-._]*$/
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/

function printSecurity(security: PluginSecurity): void {
  console.log(`  风险 ${security.risk}  确认门 ${security.requiresConfirmation ? '需要' : '不需要'}  人工复核 ${security.manualReviewStatus} (${security.lastReviewedAt})`)
  console.log(`     网络: ${security.network}`)
  console.log(`     外传: ${security.dataEgress}`)
  console.log(`     凭据: ${security.credentials}`)
  console.log(`     文件: ${security.filesystem}`)
  console.log(`     进程: ${security.processExecution}`)
  console.log(`     持久化: ${security.persistence}`)
  console.log(`     依据: ${security.manualReviewNote}`)
}

async function defaultConfirm(prompt: string): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(prompt, resolve)
    })
    return /^\s*y(es)?\s*$/i.test(answer)
  } finally {
    rl.close()
  }
}

/** Query the public registry for a package's published integrity digest. */
function npmDistIntegrity(packageName: string, version: string): string | undefined {
  const result = spawnSync('npm', ['view', `${packageName}@${version}`, 'dist.integrity'], {
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) return undefined
  return result.stdout.trim() === '' ? undefined : result.stdout.trim()
}

export interface MarketplaceCliOptions {
  args: string[]
  /** Official profile plugins are installed into (default: dsh-community-tui). */
  profile?: string
  /** Override the tested-DSH line. */
  testedDsh?: string
  fetchImpl?: typeof fetch
  homeDir?: string
  /** Injectable registry digest lookup (tests); defaults to `npm view <pkg>@<ver> dist.integrity`. */
  npmViewIntegrity?: (packageName: string, version: string) => string | undefined
  /** Injectable official installer (tests); defaults to spawnSync dsh plugin add. */
  install?: (options: { profile: string; packageName: string; version: string }) => { status: number | null }
  /** High-risk install confirmation. Tests inject this; default is stdin y/N when TTY. */
  confirm?: (prompt: string) => Promise<boolean> | boolean
}

export async function runMarketplaceCli(options: MarketplaceCliOptions): Promise<number> {
  const [command, ...rest] = options.args.filter((arg) => arg !== '--')
  const commandName = command ?? 'list'
  const fetchImpl = options.fetchImpl ?? fetch
  const homeDir = options.homeDir ?? homedir()
  const { catalog, source } = await fetchCatalog({
    fetchImpl,
    cachePath: defaultCachePath(homeDir),
  })
  if (source === 'cache') console.warn('[marketplace] 使用本地缓存')

  const testedDsh = options.testedDsh ?? DSH_TESTED_VERSION
  const classified = catalog.plugins.map(plugin => classifyPlugin(plugin, testedDsh))

  switch (commandName) {
    case 'list': {
      console.log(`社区市场 · 已验证线 ${testedDsh} · ${catalog.plugins.length} 个插件`)
      for (const item of classified) {
        const mark = item.latest.status === 'tested' ? '' : ' ⚠未验证'
        const risk = item.latest.entry.security?.risk
        const riskMark = risk !== undefined && risk !== 'low' ? ` [${risk}]` : ''
        console.log(`  ${item.plugin.name}  [${item.plugin.category}]  ${item.plugin.description.slice(0, 60)}${mark}${riskMark}`)
      }
      return 0
    }
    case 'search': {
      const query = rest.join(' ')
      const hits = searchPlugins(classified, query)
      if (hits.length === 0) {
        console.log(`没有匹配 "${query}" 的插件`)
        return 1
      }
      for (const item of hits) {
        console.log(`  ${item.plugin.name}  ${item.plugin.description.slice(0, 80)}`)
      }
      return 0
    }
    case 'audit': {
      const name = rest[0]
      if (!name) {
        console.error('用法: marketplace audit <plugin-name>')
        return 1
      }
      const item = classified.find(entry => entry.plugin.name === name)
      if (item === undefined) {
        console.error(`catalog 里没有 ${name};先跑 marketplace list`)
        return 1
      }
      const registry = item.latest.entry.security
      if (registry !== undefined) {
        console.log(`注册表安全披露: ${item.plugin.name}@${item.latest.entry.version}`)
        printSecurity(registry)
        return 0
      }
      const report = auditPluginSecurity(item.plugin.name, item.plugin.description)
      console.log(`本地启发式(注册表无 security): ${report.packageName}`)
      console.log(`  风险等级: [${report.riskLevel.toUpperCase()}]`)
      console.log(`  声明能力: ${report.declaredCapabilities.join(', ')}`)
      for (const f of report.findings) {
        console.log(`   - ${f}`)
      }
      return 0
    }
    case 'mcp-wrap': {
      const name = rest[0]
      const cmd = rest[1]
      if (!name || !cmd) {
        console.error('用法: marketplace mcp-wrap <name> <command> [args...]')
        return 1
      }
      const mcpConfig: McpServerConfig = {
        name,
        command: cmd,
        args: rest.slice(2),
      }
      const def = generateMcpDshPlugin(mcpConfig)
      console.log(`✓ 已生成 DSH MCP 插件适配定义: ${def.name}`)
      console.log(JSON.stringify(def, null, 2))
      return 0
    }
    case 'info': {
      const name = rest[0]
      const item = classified.find(entry => entry.plugin.name === name)
      if (item === undefined) {
        console.error(`catalog 里没有 ${name ?? '(空)'};先跑 marketplace list 看名字`)
        return 1
      }
      console.log(`${item.plugin.name}  [${item.plugin.category}]  作者: ${item.plugin.author}`)
      console.log(`  ${item.plugin.description}`)
      console.log(`  仓库: ${item.plugin.repo}`)
      for (const version of item.plugin.versions) {
        const mark = version.testedDsh === testedDsh ? '' : '(未验证)'
        const facts = [
          version.integrity !== undefined ? `digest ${version.integrity.slice(0, 18)}…` : undefined,
          version.provenance === true ? 'provenance ✓' : undefined,
        ].filter((fact) => fact !== undefined)
        console.log(`  ${version.version}  验证线 ${version.testedDsh} ${mark}${version.notes !== undefined ? ` — ${version.notes}` : ''}`)
        if (facts.length > 0) console.log(`     ${facts.join('  ·  ')}`)
        if (version.security !== undefined) printSecurity(version.security)
      }
      return 0
    }
    case 'install': {
      const yes = rest.includes('--yes')
      const target = rest.find((arg) => !arg.startsWith('--'))
      if (target === undefined) {
        console.error('用法: marketplace install [--yes] <name>[@version]')
        return 1
      }
      const at = target.lastIndexOf('@')
      const packageName = at > 0 ? target.slice(0, at) : target
      const version = at > 0 ? target.slice(at + 1) : undefined
      if (!NPM_NAME_RE.test(packageName) || (version !== undefined && !SEMVER_RE.test(version))) {
        console.error(`非法的包名或版本号:${target}`)
        return 1
      }
      const item = classified.find(entry => entry.plugin.name === packageName)
      if (item === undefined) {
        console.error(`catalog 里没有 ${packageName};先跑 marketplace list`)
        return 1
      }
      const resolvedVersion = version ?? item.latest.entry.version
      if (item.latest.status === 'untested' && version === undefined) {
        console.warn(`⚠ ${packageName} 最新版未在 ${testedDsh} 上验证;用 @${item.latest.entry.version} 明确指定仍可安装`)
      }
      const entry = item.plugin.versions.find(v => v.version === resolvedVersion)
      if (entry?.integrity === undefined) {
        console.log('注册表未记录 digest;请自行核对:npm view ' + packageName + '@' + resolvedVersion + ' dist.integrity')
      } else {
        console.log(`注册表 digest: ${entry.integrity}`)
        const published = (options.npmViewIntegrity ?? npmDistIntegrity)(packageName, resolvedVersion)
        if (published === entry.integrity) {
          console.log('digest 核对一致 ✓(npm dist.integrity)')
        } else if (published === undefined) {
          console.warn('⚠ 无法从 npm 取到 dist.integrity 自动核对;安装前请手动比对上面命令的输出')
        } else {
          console.error(`✗ digest 不匹配:注册表 ${entry.integrity} vs npm ${published};拒绝安装(包内容可能与验证记录不一致)`)
          return 1
        }
      }
      if (entry?.provenance === true) console.log('npm provenance: ✓ 发布证明存在')
      if (entry?.security !== undefined) printSecurity(entry.security)
      if (needsInstallConfirmation(entry?.security)) {
        if (!yes) {
          const ok = await Promise.resolve((options.confirm ?? defaultConfirm)(
            `插件 ${packageName}@${resolvedVersion} 风险 ${entry?.security?.risk}，安装需确认。输入 y 继续: `,
          ))
          if (!ok) {
            console.error(`拒绝安装:注册表要求确认(risk=${entry?.security?.risk})。非交互环境请加 --yes`)
            return 1
          }
        }
      }
      const install = options.install ?? ((opts) => installPlugin(opts))
      const { status } = await Promise.resolve(install({ profile: options.profile ?? 'dsh-community-tui', packageName, version: resolvedVersion }))
      return status ?? 1
    }
    default: {
      console.error(`未知命令 ${commandName};可用: list / search <词> / info <name> / audit <name> / mcp-wrap <name> <cmd> / install [--yes] <name>[@version]`)
      return 1
    }
  }
}

/** Re-exported so callers can validate a catalog file directly. */
export { parseCatalog }
