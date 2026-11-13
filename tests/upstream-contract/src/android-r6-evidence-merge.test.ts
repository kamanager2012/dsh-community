import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const MERGE_SCRIPT_PATH = resolve(ROOT, 'scripts/merge-android-r6-evidence.mjs')
const GRADLE_APP_PATH = resolve(ROOT, 'apps/android/app/build.gradle.kts')

const {
  REQUIRED_REMOTE_GATES,
  mergeAndroidR6Evidence,
  validateArm64RealDeviceReport,
  validateX86_64EmulatorReport,
} = (await import(pathToFileURL(MERGE_SCRIPT_PATH).href)) as {
  REQUIRED_REMOTE_GATES: string[]
  mergeAndroidR6Evidence: (arm64: Record<string, unknown>, emu: Record<string, unknown>) => Record<string, unknown>
  validateArm64RealDeviceReport: (report: Record<string, unknown>) => void
  validateX86_64EmulatorReport: (report: Record<string, unknown>) => void
}

function makeAllPassGates(): Record<string, string> {
  return Object.fromEntries(REQUIRED_REMOTE_GATES.map((g) => [g, 'PASS']))
}

function makeArm64Report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    architecture: 'remote-only',
    asOf: '2026-11-13',
    status: 'PASS',
    officialHostTarget: '0.2.2-rc.2',
    embeddedNodeRemoved: true,
    device: {
      abi: 'arm64-v8a',
      sdk: '35',
      manufacturer: 'QUALCOMM',
      model: 'Snapdragon Device',
      roKernelQemu: '0',
      isEmulator: false,
      isPhysicalArm64: true,
      isX86_64Emulator: false,
    },
    pairedDeviceId: 'dev_arm64_test',
    apk: {
      sha256: 'a'.repeat(64),
      entryCount: 412,
      containsNodeRuntime: false,
      containsOfficialDsh: false,
      arm64RealDeviceSmoke: true,
      x86_64EmulatorSmoke: false,
    },
    remoteAcceptance: makeAllPassGates(),
    ...overrides,
  }
}

function makeEmulatorReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    architecture: 'remote-only',
    asOf: '2026-11-13',
    status: 'EMULATOR_PASS_NOT_PHYSICAL_ARM64',
    officialHostTarget: '0.2.2-rc.2',
    embeddedNodeRemoved: true,
    device: {
      abi: 'x86_64',
      sdk: '34',
      manufacturer: 'Google',
      model: 'sdk_gphone64_x86_64',
      roKernelQemu: '1',
      isEmulator: true,
      isPhysicalArm64: false,
      isX86_64Emulator: true,
    },
    pairedDeviceId: 'dev_emu_test',
    apk: {
      sha256: 'b'.repeat(64),
      entryCount: 420,
      containsNodeRuntime: false,
      containsOfficialDsh: false,
      arm64RealDeviceSmoke: false,
      x86_64EmulatorSmoke: true,
    },
    remoteAcceptance: makeAllPassGates(),
    ...overrides,
  }
}

describe('Android R6 Qualcomm arm64 signing & evidence merge contract', () => {
  it('configures env/Gradle-property release signing and opt-in ABI filtering fail-closed without embedded secrets', () => {
    const gradle = readFileSync(GRADLE_APP_PATH, 'utf8')
    expect(gradle).toContain('DSH_ANDROID_KEYSTORE_PATH')
    expect(gradle).toContain('DSH_ANDROID_KEYSTORE_PASSWORD')
    expect(gradle).toContain('DSH_ANDROID_KEY_ALIAS')
    expect(gradle).toContain('DSH_ANDROID_KEY_PASSWORD')
    expect(gradle).toContain('DSH_ANDROID_SIGNING_REQUIRED')
    expect(gradle).toContain('DSH_ANDROID_ABI_FILTERS')
    expect(gradle).toContain('dshAbiFilters')
    expect(gradle).toContain('Partial Android release signing configuration detected')
    expect(gradle).toContain('arm64-v8a')
    expect(gradle).not.toContain('storePassword = "')
    expect(gradle).not.toContain('keyPassword = "')
  })

  it('merges physical arm64-v8a acceptance with CI x86_64 emulator verification without mutating inputs', () => {
    const arm64 = makeArm64Report()
    const emulator = makeEmulatorReport()
    const merged = mergeAndroidR6Evidence(arm64, emulator)

    expect(merged.status).toBe('PASS')
    const apk = merged.apk as Record<string, unknown>
    expect(apk.arm64RealDeviceSmoke).toBe(true)
    expect(apk.x86_64EmulatorSmoke).toBe(true)
    expect(apk.containsNodeRuntime).toBe(false)
    expect(apk.containsOfficialDsh).toBe(false)
    expect(apk.sha256).toBe('a'.repeat(64))
    expect(apk.emulatorSha256).toBe('b'.repeat(64))

    // Inputs must remain unmutated
    expect((arm64.apk as Record<string, unknown>).x86_64EmulatorSmoke).toBe(false)
  })

  it('rejects emulator spoofing, QEMU flags, missing gates, and runtime violations fail-closed', () => {
    expect(() => validateArm64RealDeviceReport(makeEmulatorReport())).toThrow()
    expect(() =>
      validateArm64RealDeviceReport(
        makeArm64Report({
          device: {
            abi: 'arm64-v8a',
            roKernelQemu: '1',
            isPhysicalArm64: true,
            isX86_64Emulator: false,
          },
        }),
      ),
    ).toThrow(/roKernelQemu/)
    expect(() =>
      validateArm64RealDeviceReport(
        makeArm64Report({
          apk: {
            sha256: 'a'.repeat(64),
            containsNodeRuntime: true,
            containsOfficialDsh: false,
            arm64RealDeviceSmoke: true,
          },
        }),
      ),
    ).toThrow(/containsNodeRuntime/)
    expect(() =>
      validateArm64RealDeviceReport(
        makeArm64Report({
          remoteAcceptance: {
            ...makeAllPassGates(),
            backgroundBattery: 'NOT_RUN',
          },
        }),
      ),
    ).toThrow(/backgroundBattery/)
    expect(() =>
      validateX86_64EmulatorReport(
        makeEmulatorReport({
          apk: {
            sha256: 'b'.repeat(64),
            containsNodeRuntime: false,
            containsOfficialDsh: false,
            x86_64EmulatorSmoke: false,
          },
        }),
      ),
    ).toThrow(/x86_64EmulatorSmoke/)
  })

  it('runs merge CLI cleanly and advertises --emulator-report in R6 runner help', () => {
    const helpMerge = execFileSync('node', [MERGE_SCRIPT_PATH, '--help'], { encoding: 'utf8' })
    expect(helpMerge).toContain('--arm64')
    expect(helpMerge).toContain('--emulator')

    const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-r6-merge-test-'))
    try {
      const arm64Path = join(tmpDir, 'arm64.json')
      const emuPath = join(tmpDir, 'emulator.json')
      const outPath = join(tmpDir, 'merged.json')
      execFileSync(
        'node',
        [
          '-e',
          `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[1], process.argv[2]); writeFileSync(process.argv[3], process.argv[4]);`,
          arm64Path,
          JSON.stringify(makeArm64Report()),
          emuPath,
          JSON.stringify(makeEmulatorReport()),
        ],
        { encoding: 'utf8' },
      )
      execFileSync(
        'node',
        [MERGE_SCRIPT_PATH, '--arm64', arm64Path, '--emulator', emuPath, '--out', outPath],
        { encoding: 'utf8' },
      )
      const written = JSON.parse(readFileSync(outPath, 'utf8')) as {
        status: string
        apk: { arm64RealDeviceSmoke: boolean; x86_64EmulatorSmoke: boolean }
      }
      expect(written.status).toBe('PASS')
      expect(written.apk.arm64RealDeviceSmoke).toBe(true)
      expect(written.apk.x86_64EmulatorSmoke).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
