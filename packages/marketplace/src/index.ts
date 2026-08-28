export {
  parseCatalog,
  needsInstallConfirmation,
  PLUGIN_CATEGORIES,
  type PluginCatalog,
  type PluginCategory,
  type PluginEntry,
  type PluginVersion,
  type PluginSecurity,
} from './catalog.js'
export { DEFAULT_REGISTRY_URL, defaultCachePath, fetchCatalog, type FetchCatalogOptions, type FetchCatalogResult } from './client.js'
export { classifyPlugin, classifyVersion, searchPlugins, type ClassifiedPlugin, type ClassifiedVersion, type VersionStatus } from './compat.js'
export { installPlugin, installPluginArgv, type InstallPluginOptions, type InstallPluginResult } from './install.js'
export { DSH_TESTED_VERSION, runMarketplaceCli, type MarketplaceCliOptions } from './cli.js'
