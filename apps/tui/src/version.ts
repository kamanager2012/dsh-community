import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

export function communityClientVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = require(join(here, '..', 'package.json')) as { version?: unknown }
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
}

export function formatClientIdentity(officialPackage: string, officialVersion: string): string {
  return `dsh-community ${communityClientVersion()}\nofficial ${officialPackage}@${officialVersion}\n`
}