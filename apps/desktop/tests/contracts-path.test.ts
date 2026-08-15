import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveLatestTestedPath } from '../src/contracts-path.ts'

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('latest-tested path', () => {
  it('finds the workspace contract file in development', () => {
    const path = resolveLatestTestedPath({
      isPackaged: false,
      resourcesPath: '/missing',
      workspaceRoot,
    })
    expect(path).toBe(join(workspaceRoot, 'contracts/compatibility/latest-tested.json'))
  })
})
