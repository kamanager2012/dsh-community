export {
  assertPinnedVersion,
  OFFICIAL_DSH_BIN_NAME,
  OFFICIAL_DSH_BIN_REL,
  OFFICIAL_DSH_PACKAGE,
  PINNED_DSH_VERSION,
  unpinningAllowed,
} from './pin.js'
export {
  resolveOfficialDsh,
  type OfficialDshInstall,
  type ResolveOfficialDshOptions,
} from './resolve-bin.js'
export {
  createReadinessParser,
  DEFAULT_READINESS_TIMEOUT_MS,
  parseReadinessLine,
  READINESS_PREFIX,
  type ReadinessParser,
} from './readiness.js'
export {
  adaptNodeChild,
  officialWebArgv,
  spawnOfficialWeb,
  type HostChild,
  type SpawnOfficialWebOptions,
} from './spawn-web.js'
export {
  createWebSupervisor,
  type WebSupervisor,
  type WebSupervisorOptions,
} from './supervisor.js'
export {
  createOfficialHost,
  type HostPhase,
  type HostSnapshot,
  type OfficialHost,
  type OfficialHostOptions,
} from './host-runtime.js'
export {
  communityUiContract,
  DESKTOP_SURFACE,
  TUI_SURFACE,
  type CommunitySurface,
  type CommunityUiRole,
} from './ui-contract.js'
export {
  hostProcessEnv,
  isolatedDesktopRequested,
  isolationRequested,
  ISOLATED_DESKTOP_ENV,
  OFFICIAL_DSH_HOME_DIR,
  OFFICIAL_DSH_HOME_ENV,
  resolveDesktopAppLayout,
  resolveEffectiveOfficialHome,
  resolveOfficialDshHome,
  type DesktopAppLayout,
} from './data-dirs.js'
export {
  dumpUsesOfficialSessionRoot,
  formatOfficialSessionMtime,
  listOfficialSessions,
  officialSessionRoot,
  OFFICIAL_SESSION_DIR,
  OFFICIAL_SESSION_FILES,
  type OfficialSessionRef,
} from './session-store.js'
export {
  emptyRuntimeCatalog,
  hydrateCatalog,
  parseRuntimeCatalog,
  pinDefault,
  recommendUpdate,
  resolveRuntimePin,
  runtimeSwitchAvailable,
  type RuntimeCatalog,
} from './runtime-catalog.js'
export {
  formatPreflightReport,
  officialApiKeyPresent,
  OFFICIAL_API_KEY_ENV,
  type DistributionPreflight,
} from './preflight.js'
export {
  COMMUNITY_PLUGIN_CATALOG_REPO,
  COMMUNITY_PLUGIN_CATALOG_URL,
  fetchPluginCatalog,
  formatPluginCatalog,
  HANDBOOK_REPO,
  officialPluginAddCommand,
  parsePluginCatalog,
  type CatalogPlugin,
  type PluginCatalog,
} from './plugin-catalog.js'
