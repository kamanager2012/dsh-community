#!/usr/bin/env node
/**
 * Merges a physical arm64-v8a Android hardware R6 acceptance report with a CI KVM x86_64
 * emulator R6 acceptance report under strict fail-closed validation matching
 * `scripts/verify-android-release-ready.mjs`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXPECTED_HOST_TARGET = '0.2.2-rc.2'
export const REQUIRED_REMOTE_GATES = [
  'pairing',
  'sessionListAndAttach',
  'promptStreaming',
  'approvalIdempotency',
  'carrierFailover',
  'backgroundBattery',
  'deviceRevoke',
]

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertCommonReportShape(report, label) {
  if (!isPlainObject(report)) {
    throw new Error(`${label}: expected JSON object`)
  }
  if (report.schemaVersion !== 2) {
    throw new Error(`${label}: expected schemaVersion=2, got ${String(report.schemaVersion)}`)
  }
  if (report.architecture !== 'remote-only') {
    throw new Error(`${label}: expected architecture='remote-only', got ${String(report.architecture)}`)
  }
  if (report.officialHostTarget !== EXPECTED_HOST_TARGET) {
    throw new Error(
      `${label}: expected officialHostTarget='${EXPECTED_HOST_TARGET}', got ${String(report.officialHostTarget)}`,
    )
  }
  if (report.embeddedNodeRemoved !== true) {
    throw new Error(`${label}: embeddedNodeRemoved must be true`)
  }
  if (!isPlainObject(report.device)) {
    throw new Error(`${label}: device metadata object missing`)
  }
  if (!isPlainObject(report.apk)) {
    throw new Error(`${label}: apk evidence object missing`)
  }
  if (report.apk.containsNodeRuntime !== false) {
    throw new Error(`${label}: apk.containsNodeRuntime must be false`)
  }
  if (report.apk.containsOfficialDsh !== false) {
    throw new Error(`${label}: apk.containsOfficialDsh must be false`)
  }
  if (typeof report.apk.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(report.apk.sha256)) {
    throw new Error(`${label}: invalid apk.sha256 digest`)
  }
  if (!isPlainObject(report.remoteAcceptance)) {
    throw new Error(`${label}: remoteAcceptance gate summary missing`)
  }
  for (const gate of REQUIRED_REMOTE_GATES) {
    if (report.remoteAcceptance[gate] !== 'PASS') {
      throw new Error(
        `${label}: remoteAcceptance.${gate} must equal 'PASS' (got ${String(report.remoteAcceptance[gate])})`,
      )
    }
  }
}

export function validateArm64RealDeviceReport(report) {
  assertCommonReportShape(report, 'arm64 real-device report')
  if (report.status !== 'PASS') {
    throw new Error(`arm64 real-device report: expected status='PASS', got ${String(report.status)}`)
  }
  if (report.device.isPhysicalArm64 !== true) {
    throw new Error('arm64 real-device report: device.isPhysicalArm64 must be true')
  }
  if (report.device.isX86_64Emulator !== false) {
    throw new Error('arm64 real-device report: device.isX86_64Emulator must be false')
  }
  if (report.device.abi !== 'arm64-v8a') {
    throw new Error(
      `arm64 real-device report: expected device.abi='arm64-v8a', got ${String(report.device.abi)}`,
    )
  }
  if (report.device.roKernelQemu === '1') {
    throw new Error('arm64 real-device report: device.roKernelQemu=\'1\' indicates an emulator')
  }
  if (report.apk.arm64RealDeviceSmoke !== true) {
    throw new Error('arm64 real-device report: apk.arm64RealDeviceSmoke must be true')
  }
}

export function validateX86_64EmulatorReport(report) {
  assertCommonReportShape(report, 'x86_64 emulator report')
  if (report.status !== 'EMULATOR_PASS_NOT_PHYSICAL_ARM64' && report.status !== 'PASS') {
    throw new Error(
      `x86_64 emulator report: expected status='EMULATOR_PASS_NOT_PHYSICAL_ARM64' or 'PASS', got ${String(report.status)}`,
    )
  }
  if (report.device.isX86_64Emulator !== true) {
    throw new Error('x86_64 emulator report: device.isX86_64Emulator must be true')
  }
  if (report.device.isPhysicalArm64 === true) {
    throw new Error('x86_64 emulator report: device.isPhysicalArm64 cannot be true on emulator evidence')
  }
  if (report.apk.x86_64EmulatorSmoke !== true) {
    throw new Error('x86_64 emulator report: apk.x86_64EmulatorSmoke must be true')
  }
}

export function mergeAndroidR6Evidence(arm64Report, emulatorReport) {
  validateArm64RealDeviceReport(arm64Report)
  validateX86_64EmulatorReport(emulatorReport)

  const mergedApk = {
    ...structuredClone(arm64Report.apk),
    containsNodeRuntime: false,
    containsOfficialDsh: false,
    arm64RealDeviceSmoke: true,
    x86_64EmulatorSmoke: true,
    emulatorSha256: emulatorReport.apk.sha256,
  }

  return {
    ...structuredClone(arm64Report),
    status: 'PASS',
    apk: mergedApk,
    emulatorVerification: {
      asOf: typeof emulatorReport.asOf === 'string' ? emulatorReport.asOf : null,
      status: emulatorReport.status,
      device: structuredClone(emulatorReport.device),
      apkSha256: emulatorReport.apk.sha256,
    },
    notes:
      'Physical arm64-v8a Android hardware acceptance passed and merged with x86_64 KVM emulator verification.',
  }
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node scripts/merge-android-r6-evidence.mjs --arm64 <path> --emulator <path> [--out <path>]',
      '',
      'Options:',
      '  --arm64 <path>     Physical arm64-v8a device acceptance JSON (status=PASS)',
      '  --emulator <path>  CI x86_64 emulator acceptance JSON (x86_64EmulatorSmoke=true)',
      '  --out <path>       Optional output path (prints to stdout when omitted)',
      '  -h, --help         Show help',
      '',
    ].join('\n'),
  )
}

function parseCliArgs(argv) {
  let arm64Path
  let emulatorPath
  let outPath
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      printHelp()
      process.exit(0)
    }
    const readValue = () => {
      const val = argv[i + 1]
      if (!val || val.startsWith('-')) {
        throw new Error(`Missing value for option ${arg}`)
      }
      i += 1
      return resolve(val)
    }
    if (arg === '--arm64') {
      arm64Path = readValue()
    } else if (arg === '--emulator') {
      emulatorPath = readValue()
    } else if (arg === '--out') {
      outPath = readValue()
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  if (!arm64Path || !emulatorPath) {
    throw new Error('Both --arm64 and --emulator paths are required')
  }
  return { arm64Path, emulatorPath, outPath }
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (err) {
    throw new Error(
      `Failed to read ${label} JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function runCli() {
  const { arm64Path, emulatorPath, outPath } = parseCliArgs(process.argv.slice(2))
  const arm64Report = readJsonFile(arm64Path, 'arm64')
  const emulatorReport = readJsonFile(emulatorPath, 'emulator')
  const merged = mergeAndroidR6Evidence(arm64Report, emulatorReport)
  const serialized = `${JSON.stringify(merged, null, 2)}\n`
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, serialized, 'utf8')
    process.stderr.write(`[r6-merge] Merged arm64 + x86_64 R6 evidence written to ${outPath}\n`)
  } else {
    process.stdout.write(serialized)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli()
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
