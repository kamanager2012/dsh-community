import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveOfficialDsh } from '@dsh-community/dsh-bridge'

/** Isolated DSH_HOME so contract dumps never race on the user's ~/.dsh. */
export function runOfficial(args: string[]): string {
  const install = resolveOfficialDsh({ from: import.meta.url })
  const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-community-contract-'))
  return execFileSync(process.execPath, [install.binPath, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, DSH_HOME: isolatedHome },
  })
}
