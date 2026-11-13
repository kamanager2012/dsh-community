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

    const instrTestPath = join(
      ANDROID_ROOT,
      'app/src/androidTest/java/org/dsh/community/android/RemoteClientInstrumentationTest.kt',
    )
    expect(existsSync(instrTestPath), 'RemoteClientInstrumentationTest.kt').toBe(true)
    const instrKotlin = readFileSync(instrTestPath, 'utf8')
    expect(instrKotlin).toContain('AndroidKeyStore')
    expect(instrKotlin).toContain('RemoteSessionService')
    expect(instrKotlin).toContain('dsh-remote://pair')
    expect(instrKotlin).toContain('dshPairingInput')

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
    expect(manifest).toContain('android:launchMode="singleTop"')
    expect(manifest).toContain('android:scheme="dsh-remote"')
    expect(manifest).toContain('android:host="pair"')
    expect(manifest).toContain('.service.RemoteSessionService')
    expect(manifest).toContain('foregroundServiceType="dataSync"')
    expect(manifest).not.toContain('RuntimeService')

    const gradleApp = readFileSync(join(ANDROID_ROOT, 'app/build.gradle.kts'), 'utf8')
    expect(gradleApp).not.toContain('webkit')
    expect(gradleApp).toContain('junit:junit')
    expect(gradleApp).toContain('androidx.test.runner.AndroidJUnitRunner')
    expect(gradleApp).toContain('androidx.test.ext:junit')

    const layout = readFileSync(join(ANDROID_ROOT, 'app/src/main/res/layout/activity_main.xml'), 'utf8')
    expect(layout).not.toContain('WebView')
    expect(layout).toContain('btn_approve')
    expect(layout).toContain('btn_reject')
    expect(layout).toContain('btn_send_prompt')
    expect(layout).toContain('ll_session_chips')
    expect(layout).toContain('tv_assistant_stream')
  })

  it('provides live Kotlin-vs-Node E2EE interop host, R6 ADB runner, fail-closed gate, and CI acceptance workflow', () => {
    expect(existsSync(join(ROOT, 'scripts/r5-android-interop-host.mjs'))).toBe(true)
    const r6RunnerPath = join(ROOT, 'scripts/accept-android-r6-device.mjs')
    expect(existsSync(r6RunnerPath)).toBe(true)
    const r6Runner = readFileSync(r6RunnerPath, 'utf8')
    expect(r6Runner).toContain('ro.product.cpu.abi')
    expect(r6Runner).toContain('ro.kernel.qemu')
    expect(r6Runner).toContain('isPhysicalArm64')
    expect(r6Runner).toContain('arm64RealDeviceSmoke')

    const realityGate = JSON.parse(
      readFileSync(join(ANDROID_ROOT, 'evidence/reality-gate.json'), 'utf8'),
    ) as { status: string; apk: { arm64RealDeviceSmoke: boolean } }
    expect(realityGate.status).toBe('NOT_RUN')
    expect(realityGate.apk.arm64RealDeviceSmoke).toBe(false)

    const workflowPath = join(ROOT, '.github/workflows/android-remote-acceptance.yml')
    expect(existsSync(workflowPath)).toBe(true)
    const wf = readFileSync(workflowPath, 'utf8')
    expect(wf).toContain('DSH_ANDROID_REQUIRE_LIVE_INTEROP')
    expect(wf).toContain('testDebugUnitTest')
    expect(wf).toContain('assembleDebug')
    expect(wf).toContain('assembleDebugAndroidTest')
    expect(wf).toContain('android-emulator-r6')
    expect(wf).toContain('accept-android-r6-device.mjs')
    expect(wf).toContain('libnode')
    expect(wf).toContain('deepseek-ai')
  })
})
