/** Official env name. We only test presence — never log the value. */
export const OFFICIAL_API_KEY_ENV = 'DEEPSEEK_API_KEY'

export function officialApiKeyPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[OFFICIAL_API_KEY_ENV]
  return typeof value === 'string' && value.trim() !== ''
}

export interface DistributionPreflight {
  readonly officialPackage: string
  readonly officialVersion: string
  readonly officialBin: string
  readonly officialHome: string
  readonly sessionCount: number
  readonly apiKeyPresent: boolean
  readonly tty: boolean
}

export function formatPreflightReport(report: DistributionPreflight): string {
  const lines = [
    'dsh-community 自检（不启动对话，也不打印密钥）',
    '',
    `  官方包     ${report.officialPackage}@${report.officialVersion}`,
    `  官方 bin   ${report.officialBin}`,
    `  数据目录   ${report.officialHome}`,
    `  对话       ${String(report.sessionCount)} 条`,
    `  交互终端   ${report.tty ? '是' : '否 — 列表可用，开聊要 TTY'}`,
    `  API 密钥   ${report.apiKeyPresent ? '已设置' : `未设置 ${OFFICIAL_API_KEY_ENV}`}`,
    '',
  ]
  if (!report.apiKeyPresent) {
    lines.push(`对话前请设置：export ${OFFICIAL_API_KEY_ENV}=...`)
    lines.push('')
  }
  if (!report.tty) {
    lines.push('没有 TTY 时：dsh-community-tui --list-sessions')
    lines.push('')
  }
  return lines.join('\n')
}
