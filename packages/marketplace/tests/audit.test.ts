import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { auditPluginSecurity } from '../src/audit.ts'
import { generateMcpDshPlugin } from '../src/mcp-adapter.ts'

describe('security audit & mcp adapter', () => {
  it('detects high-risk shell capabilities', () => {
    const report = auditPluginSecurity('@dsh/terminal-tool', 'Executes arbitrary shell commands via exec')
    assert.equal(report.riskLevel, 'high')
    assert.ok(report.declaredCapabilities.includes('shell:exec'))
  })

  it('rates standard sandboxed plugins as low risk', () => {
    const report = auditPluginSecurity('@dsh/calc-tool', 'A simple math calculator')
    assert.equal(report.riskLevel, 'low')
    assert.ok(report.declaredCapabilities.includes('standard:sandboxed'))
  })

  it('generates standard DSH MCP adapter definition', () => {
    const def = generateMcpDshPlugin({
      name: 'SQLite-Server',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sqlite']
    })
    assert.equal(def.name, 'dsh-mcp-sqlite-server')
    assert.equal(def.type, 'mcp-adapter')
    assert.equal(def.mcpConfig.command, 'npx')
  })
})
