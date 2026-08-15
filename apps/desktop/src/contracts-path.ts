import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function resolveLatestTestedPath(input: {
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly workspaceRoot: string
}): string | undefined {
  const candidates = input.isPackaged
    ? [join(input.resourcesPath, 'contracts', 'latest-tested.json')]
    : [
      join(input.workspaceRoot, 'contracts/compatibility/latest-tested.json'),
      join(input.resourcesPath, 'contracts', 'latest-tested.json'),
    ]
  return candidates.find((path) => existsSync(path))
}
