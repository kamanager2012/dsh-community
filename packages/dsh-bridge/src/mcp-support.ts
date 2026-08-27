/**
 * DSH Community Bridge — Model Context Protocol (MCP) Runtime Support
 * 
 * Facilitates loading and routing standard MCP servers into the DSH runtime session.
 */

export interface McpServerTarget {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'sse';
  url?: string;
}

export interface McpBridgeStatus {
  enabled: boolean;
  registeredServers: number;
  servers: string[];
}

export class DshMcpBridge {
  private servers: Map<string, McpServerTarget> = new Map();

  public register(server: McpServerTarget): void {
    this.servers.set(server.name, server);
  }

  public unregister(name: string): boolean {
    return this.servers.delete(name);
  }

  public getStatus(): McpBridgeStatus {
    return {
      enabled: true,
      registeredServers: this.servers.size,
      servers: Array.from(this.servers.keys()),
    };
  }

  public getLaunchArguments(serverName: string): string[] {
    const s = this.servers.get(serverName);
    if (!s) return [];
    return [s.command, ...(s.args ?? [])];
  }
}
