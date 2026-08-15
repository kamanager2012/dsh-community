/**
 * Plain-text marketplace CLI: list / info / install. No UI toolkit on
 * purpose — the Desktop shell and the TUI both reuse this entrypoint.
 */
import { homedir } from 'node:os'
import { PINNED_DSH_VERSION, resolveOfficialDsh } from '@dsh-community/dsh-bridge'
import { parseCatalog } from './catalog.js'
import { defaultCachePath, fetchCatalog } from './client.js'
import { classifyPlugin, searchPlugins } from './compat.js'
import { installPlugin } from './install.js'

export interface MarketplaceCliOptions {
  args: string[]
  /** Official profile plugins are installed into. */
  profile: string
  /** Override the tested-DSH line (defaults to the dsh-bridge pin). */
  testedDsh?: string
  fetchImpl?: typeof fetch
  homeDir?: string
}

export async function runMarketplaceCli(options: MarketplaceCliOptions): Promise<number> {
  const [command, ...rest] = options.args
  const commandName = command ?? 'list'
  const fetchImpl = options.fetchImpl ?? fetch
  const homeDir = options.homeDir ?? homedir()
  const { catalog, source } = await fetchCatalog({
    fetchImpl,
    cachePath: defaultCachePath(homeDir),
  })
  if (source === 'cache') console.warn('[marketplace] 使用本地缓存')

  const testedDsh = options.testedDsh ?? PINNED_DSH_VERSION
  const classified = catalog.plugins.map(plugin => classifyPlugin(plugin, testedDsh))

  switch (commandName) {
    case 'list': {
      console.log(`社区市场 · 已验证线 ${testedDsh} · ${catalog.plugins.length} 个插件`)
      for (const item of classified) {
        const mark = item.latest.status === 'tested' ? '' : ' ⚠未验证'
        console.log(`  ${item.plugin.name}  [${item.plugin.category}]  ${item.plugin.description.slice(0, 60)}${mark}`)
      }
      return 0
    }
    case 'search': {
      const query = rest.join(' ') ?? ''
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
        console.log(`  ${version.version}  验证线 ${version.testedDsh} ${mark}${version.notes !== undefined ? ` — ${version.notes}` : ''}`)
      }
      return 0
    }
    case 'install': {
      const target = rest[0]
      if (target === undefined) {
        console.error('用法: marketplace install <name>[@version]')
        return 1
      }
      const at = target.lastIndexOf('@')
      const packageName = at > 0 ? target.slice(0, at) : target
      const version = at > 0 ? target.slice(at + 1) : undefined
      const item = classified.find(entry => entry.plugin.name === packageName)
      if (item === undefined) {
        console.error(`catalog 里没有 ${packageName};先跑 marketplace list`)
        return 1
      }
      const resolvedVersion = version ?? item.latest.entry.version
      if (item.latest.status === 'untested' && version === undefined) {
        console.warn(`⚠ ${packageName} 最新版未在 ${testedDsh} 上验证;用 @${item.latest.entry.version} 明确指定仍可安装`)
      }
      const { binPath } = resolveOfficialDsh({ from: import.meta.url })
      const { status } = installPlugin({ dshBinPath: binPath, profile: options.profile, packageName, version: resolvedVersion })
      return status ?? 1
    }
    default: {
      console.error(`未知命令 ${commandName};可用: list / search <词> / info <name> / install <name>[@version]`)
      return 1
    }
  }
}

/** Re-exported so the TUI bin can validate a catalog file directly. */
export { parseCatalog }
