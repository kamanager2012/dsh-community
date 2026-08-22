import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** electron-builder product executables under an unpacked release output dir. */
export function packagedReleaseCandidates(releaseDir: string): string[] {
  const macApp = join('DSH Community.app', 'Contents', 'MacOS', 'DSH Community')
  return [
    join(releaseDir, 'linux-unpacked', 'dsh-community'),
    join(releaseDir, 'win-unpacked', 'DSH Community.exe'),
    join(releaseDir, 'mac-arm64', macApp),
    join(releaseDir, 'mac', macApp),
  ]
}

/** Product binaries sitting next to the running executable inside a bundle. */
export function siblingExecutableCandidates(exeDir: string): string[] {
  return [join(exeDir, 'dsh-community'), join(exeDir, 'DSH Community.exe')]
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * A packaged desktop build must run without the pnpm workspace. Probe the
 * bundle layout first (binaries next to the running executable), then the
 * source tree's apps/desktop/release output.
 */
export function findPackagedDesktopExecutable(input: {
  readonly execPath: string
  readonly repoRoot?: string
}): string | undefined {
  const exeDir = dirname(input.execPath)
  const candidates = [
    ...siblingExecutableCandidates(exeDir),
    ...(input.repoRoot === undefined
      ? []
      : packagedReleaseCandidates(join(input.repoRoot, 'apps', 'desktop', 'release'))),
  ]
  return candidates.find((candidate) => isFile(candidate))
}

/** Actionable failure for `dsh-community desktop` without a package or workspace. */
export function desktopSourceRequiredMessage(detail: string): string {
  return [
    'dsh-community desktop 需要源码 checkout（pnpm workspace），当前环境没有。',
    '可选：',
    '  1. 在仓库根目录 pnpm install 后重试；',
    '  2. 直接运行打包产物，例如 apps/desktop/release/linux-unpacked/dsh-community。',
    `（${detail}）`,
  ].join('\n')
}
