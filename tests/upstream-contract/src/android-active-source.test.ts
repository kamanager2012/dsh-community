import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')

describe('active Android endpoint source contract', () => {
  it('pins the exact official runtime and keeps the embedded Web host loopback-only', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/nodejs-project/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies?.['@deepseek-ai/dsh']).toBe('0.1.2-alpha.4')
    expect(pkg.dependencies?.['@deepseek-ai/dsh-sandbox']).toBe('0.1.2-alpha.4')
    expect(pkg.dependencies?.['@deepseek-ai/dsh-subprocess']).toBe('0.1.2-alpha.4')
    expect(pkg.dependencies?.['@deepseek-ai/dsh-subprocess-local']).toBe('0.1.2-alpha.4')
    expect(pkg.dependencies?.['@deepseek-ai/dsh-timeout']).toBe('0.1.2-alpha.4')
    expect(pkg.dependencies?.['node-pty']).toBe('1.2.0-beta.15')

    const bootstrap = readFileSync(
      resolve(ROOT, 'apps/android/nodejs-project/src/main/js/main.js'),
      'utf8',
    )
    expect(bootstrap).toContain("'--host', '127.0.0.1'")
    expect(bootstrap).toContain("'--no-open'")
    expect(bootstrap).toContain("'--patch', ANDROID_PATCH")
    expect(bootstrap).toContain("path.join(__dirname, 'android.cordis.patch.yml')")
    expect(bootstrap).toContain('DSH_ANDROID_LANDLOCK_RUN')
    expect(bootstrap).toContain("require('./android-app-uid-preflight.cjs')")
    expect(bootstrap).toContain('APP_UID_PREFLIGHT_OK')
    expect(bootstrap).toContain('async function main()')
    expect(bootstrap).toContain('await runAndroidAppUidPreflight')
    expect(bootstrap.indexOf('const appUidPreflight = await runAndroidAppUidPreflight('))
      .toBeLessThan(bootstrap.indexOf('const child = spawn('))
    expect(bootstrap).not.toMatch(/HOST:\s*['"]0\.0\.0\.0['"]/u)
  })

  it('fails loud while the Android runtime substrate is blocked', () => {
    const state = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/runtime-substrate.json'), 'utf8'),
    ) as {
      status?: string
      endpointState?: string
      stockNodejsMobile?: { latestObserved?: string; compatibleWithOfficialDsh?: boolean }
    }
    expect(state.status).toBe('BLOCKED')
    expect(state.endpointState).toBe('ACTIVE_SOURCE_UNVERIFIED')
    expect(state.stockNodejsMobile?.latestObserved).toBe('18.20.4')
    expect(state.stockNodejsMobile?.compatibleWithOfficialDsh).toBe(false)

    const rootGradle = readFileSync(resolve(ROOT, 'apps/android/build.gradle.kts'), 'utf8')
    const appGradle = readFileSync(resolve(ROOT, 'apps/android/app/build.gradle.kts'), 'utf8')
    expect(rootGradle).not.toContain('com.github.nodejs-mobile')
    expect(appGradle).not.toContain('com.github.nodejs-mobile')

    const app = readFileSync(
      resolve(ROOT, 'apps/android/app/src/main/java/org/dsh/community/android/DshApp.kt'),
      'utf8',
    )
    expect(app).toContain('RUNTIME_SUBSTRATE_READY = false')

    const service = readFileSync(
      resolve(ROOT, 'apps/android/app/src/main/java/org/dsh/community/android/RuntimeService.kt'),
      'utf8',
    )
    expect(service).toContain('"DSH_ANDROID_APP_DATA_DIR" to filesDir.absolutePath')
    expect(service).toContain('"DSH_ANDROID_CACHE_DIR" to cacheDir.absolutePath')
    expect(service).toContain('verifiedRuntimeEnvironment()')

    const doc = readFileSync(resolve(ROOT, 'docs/android-endpoint.md'), 'utf8')
    expect(doc).toContain('[UNVERIFIED]')
    expect(doc).toContain('BLOCKED')
    expect(doc).toMatch(/Reality Gate/u)
  })
})
