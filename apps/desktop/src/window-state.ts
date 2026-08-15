export interface WindowState {
  readonly x?: number
  readonly y?: number
  readonly width: number
  readonly height: number
}

const MIN_WIDTH = 880
const MIN_HEIGHT = 560
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 840

export const DEFAULT_WINDOW_STATE: WindowState = {
  width: DEFAULT_WIDTH,
  height: DEFAULT_HEIGHT,
}

export function parseWindowState(raw: unknown): WindowState | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.width !== 'number' || typeof value.height !== 'number') return undefined
  const state: WindowState = {
    width: Math.round(value.width),
    height: Math.round(value.height),
    ...(typeof value.x === 'number' ? { x: Math.round(value.x) } : {}),
    ...(typeof value.y === 'number' ? { y: Math.round(value.y) } : {}),
  }
  return isPlausibleWindowState(state) ? state : undefined
}

export function isPlausibleWindowState(state: WindowState): boolean {
  return state.width >= MIN_WIDTH
    && state.height >= MIN_HEIGHT
    && state.width <= 10_000
    && state.height <= 10_000
}

export function windowStateFromBounds(bounds: { x: number; y: number; width: number; height: number }): WindowState {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  }
}
