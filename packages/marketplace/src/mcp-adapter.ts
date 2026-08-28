/**
 * MCP (Model Context Protocol) Plugin Adapter for DSH
 * 
 * Translates standard MCP Servers (stdio / sse) into native DSH plugin configurations,
 * allowing official DeepSeek Harness to seamlessly load MCP-based tools.
 */

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'sse';
  url?: string;
}

export interface DshPluginDefinition {
  name: string;
  version: string;
  type: 'mcp-adapter';
  entrypoint: string;
  mcpConfig: McpServerConfig;
}

export function generateMcpDshPlugin(config: McpServerConfig): DshPluginDefinition {
  const sanitizedName = config.name.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  return {
    name: `dsh-mcp-${sanitizedName}`,
    version: '0.1.0',
    type: 'mcp-adapter',
    entrypoint: 'dist/adapter.js',
    mcpConfig: {
      ...config,
      args: config.args ?? [],
      env: config.env ?? {},
      transport: config.transport ?? 'stdio',
    }
  };
}
