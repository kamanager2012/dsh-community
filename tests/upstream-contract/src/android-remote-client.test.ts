import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const ANDROID_ROOT = resolve(ROOT, 'apps/android')

function walkFiles(dir: string, into: string[] = []): string[] {
  if (!existsSync(dir)) return into
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'build' || entry.name === '.gradle') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, into)
    else if (entry.isFile()) into.push(full)
  }
  return into
}

describe('Android R5 pure thin Remote Client contract', () => {
  it('removes embedded Node/DSH runtime packaging completely', () => {
    expect(existsSync(join(ANDROID_ROOT, 'nodejs-project'))).toBe(false)
    expect(existsSync(join(ANDROID_ROOT, 'runtime-substrate.json'))).toBe(false)
    expect(existsSync(join(ANDROID_ROOT, 'native-blockers.json'))).toBe(false)
    expect(existsSync(join(ANDROID_ROOT, 'native-compatibility.json'))).toBe(false)

    const files = walkFiles(ANDROID_ROOT)
    for (const file of files) {
      if (file.endsWith('.md') || file.endsWith('reality-gate.json')) continue
      expect(file.toLowerCase()).not.toContain('libnode')
      expect(file.toLowerCase()).not.toContain('nodejs-mobile')
      const content = readFileSync(file, 'utf8')
      expect(content, file).not.toContain('com.github.nodejs-mobile')
      expect(content, file).not.toContain('@deepseek-ai/dsh')
    }
  })

  it('wires Keystore identity, Noise IK crypto, ordered failover, foreground service, and native remote UI', () => {
    const mainJava = join(ANDROID_ROOT, 'app/src/main/java/org/dsh/community/android')
    const testJava = join(ANDROID_ROOT, 'app/src/test/java/org/dsh/community/android')

    for (const rel of [
      'DshApp.kt',
      'MainActivity.kt',
      'crypto/Blake2b.kt',
      'crypto/Curve25519.kt',
      'crypto/ChaCha20Poly1305.kt',
      'crypto/NoiseIkClient.kt',
      'crypto/DeviceIdentityStore.kt',
      'protocol/JsonCodec.kt',
      'protocol/RemoteProtocol.kt',
      'transport/PairingQrParser.kt',
      'transport/BinaryWebSocketClient.kt',
      'transport/RemoteTransports.kt',
      'transport/FailoverRemoteSession.kt',
      'transport/LanMdnsDiscoverer.kt',
      'service/RemoteSessionService.kt',
    ]) {
      expect(existsSync(join(mainJava, rel)), rel).toBe(true)
    }

    for (const rel of [
      'CryptoPrimitivesTest.kt',
      'DeviceIdentityStoreTest.kt',
      'PairingQrParserAndMdnsTest.kt',
      'FailoverAndProtocolTest.kt',
      'LiveNodeInteropTest.kt',
    ]) {
      expect(existsSync(join(testJava, rel)), rel).toBe(true)
    }

    const appKotlin = readFileSync(join(mainJava, 'DshApp.kt'), 'utf8')
    expect(appKotlin).toContain('REMOTE_CLIENT_MODE = true')
    expect(appKotlin).toContain('EMBEDDED_NODE_RUNTIME = false')
    expect(appKotlin).toContain('REAL_DEVICE_ACCEPTANCE_READY = false')

    const keystoreKotlin = readFileSync(join(mainJava, 'crypto/DeviceIdentityStore.kt'), 'utf8')
    expect(keystoreKotlin).toContain('AndroidKeyStore')
    expect(keystoreKotlin).toContain('AES/GCM/NoPadding')
    expect(keystoreKotlin).toContain('noBackupFilesDir')

    const manifest = readFileSync(join(ANDROID_ROOT, 'app/src/main/AndroidManifest.xml'), 'utf8')
    expect(manifest).toContain('android:allowBackup="false"')
    expect(manifest).toContain('.service.RemoteSessionService')
    expect(manifest).toContain('foregroundServiceType="dataSync"')
    expect(manifest).not.toContain('RuntimeService')

    const gradleApp = readFileSync(join(ANDROID_ROOT, 'app/build.gradle.kts'), 'utf8')
    expect(gradleApp).not.toContain('webkit')
    expect(gradleApp).toContain('junit:junit')

    const layout = readFileSync(join(ANDROID_ROOT, 'app/src/main/res/layout/activity_main.xml'), 'utf8')
    expect(layout).not.toContain('WebView')
    expect(layout).toContain('btn_approve')
    expect(layout).toContain('btn_reject')
    expect(layout).toContain('btn_send_prompt')
  })

  it('provides live Kotlin-vs-Node E2EE interop host and CI acceptance workflow', () => {
    expect(existsSync(join(ROOT, 'scripts/r5-android-interop-host.mjs'))).toBe(true)
    const workflowPath = join(ROOT, '.github/workflows/android-remote-acceptance.yml')
    expect(existsSync(workflowPath)).toBe(true)
    const wf = readFileSync(workflowPath, 'utf8')
    expect(wf).toContain('DSH_ANDROID_REQUIRE_LIVE_INTEROP')
    expect(wf).toContain('testDebugUnitTest')
    expect(wf).toContain('assembleDebug')
    expect(wf).toContain('libnode')
    expect(wf).toContain('deepseek-ai')
  })
})
