/**
 * Desktop-owned version pins. This file does not live under ~/.dsh.
 * Recommend latest tested (contract CI), never "whatever npm latest is".
 */

export interface RuntimeCatalog {
  readonly latestTested: string
  readonly defaultPin: string
  readonly projects: Readonly<Record<string, string>>
}

export function emptyRuntimeCatalog(pin: string): RuntimeCatalog {
  return {
    latestTested: pin,
    defaultPin: pin,
    projects: {},
  }
}

export function resolveRuntimePin(catalog: RuntimeCatalog, projectId?: string): string {
  if (projectId !== undefined && catalog.projects[projectId] !== undefined) {
    return catalog.projects[projectId]
  }
  return catalog.defaultPin
}

export function recommendUpdate(catalog: RuntimeCatalog, installed: string): 'stay' | 'offer-tested' {
  return installed === catalog.latestTested ? 'stay' : 'offer-tested'
}

export function parseRuntimeCatalog(raw: unknown): RuntimeCatalog | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.latestTested !== 'string' || typeof value.defaultPin !== 'string') return undefined
  const projects: Record<string, string> = {}
  if (value.projects !== undefined && value.projects !== null && typeof value.projects === 'object') {
    for (const [key, pin] of Object.entries(value.projects as Record<string, unknown>)) {
      if (typeof pin === 'string' && pin.length > 0) projects[key] = pin
    }
  }
  return {
    latestTested: value.latestTested,
    defaultPin: value.defaultPin,
    projects,
  }
}

/** Contract CI owns latestTested. A stored catalog cannot override it. */
export function hydrateCatalog(
  stored: RuntimeCatalog | undefined,
  latestTested: string,
  installed: string,
): RuntimeCatalog {
  const base = stored ?? emptyRuntimeCatalog(installed)
  return {
    latestTested,
    defaultPin: base.defaultPin.length > 0 ? base.defaultPin : installed,
    projects: base.projects,
  }
}

export function pinDefault(catalog: RuntimeCatalog, version: string): RuntimeCatalog {
  return { ...catalog, defaultPin: version }
}

/**
 * This workspace currently ships one official artifact.
 * Multi-rc staging is later; do not pretend we can switch.
 */
export function runtimeSwitchAvailable(installed: string, target: string): boolean {
  return installed === target
}
