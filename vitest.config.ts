import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@dsh-community/dsh-bridge': resolve(root, 'packages/dsh-bridge/src/index.ts'),
      '@dsh-community/shared-types': resolve(root, 'packages/shared-types/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/*/tests/**/*.test.ts',
      'apps/*/tests/**/*.test.ts',
      'tests/*/src/**/*.test.ts',
      'contracts/tests/**/*.test.ts',
    ],
    testTimeout: 30_000,
  },
})
