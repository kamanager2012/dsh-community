import {
  recommendUpdate,
  runtimeSwitchAvailable,
  type RuntimeCatalog,
} from '@dsh-community/dsh-bridge'

export interface RuntimeView {
  readonly installed: string
  readonly latestTested: string
  readonly defaultPin: string
  readonly recommendation: 'stay' | 'offer-tested'
  readonly canSwitchToTested: boolean
  readonly officialHome: string
  readonly desktopRoot: string
  readonly catalogPath: string
  readonly isolated: boolean
}

export function buildRuntimeView(input: {
  readonly installed: string
  readonly catalog: RuntimeCatalog
  readonly officialHome: string
  readonly desktopRoot: string
  readonly catalogPath: string
  readonly isolated: boolean
}): RuntimeView {
  return {
    installed: input.installed,
    latestTested: input.catalog.latestTested,
    defaultPin: input.catalog.defaultPin,
    recommendation: recommendUpdate(input.catalog, input.installed),
    canSwitchToTested: runtimeSwitchAvailable(input.installed, input.catalog.latestTested),
    officialHome: input.officialHome,
    desktopRoot: input.desktopRoot,
    catalogPath: input.catalogPath,
    isolated: input.isolated,
  }
}

export function readLatestTested(raw: unknown, fallback: string): string {
  if (raw !== null && typeof raw === 'object') {
    const version = (raw as { version?: unknown }).version
    if (typeof version === 'string' && version.length > 0) return version
  }
  return fallback
}
