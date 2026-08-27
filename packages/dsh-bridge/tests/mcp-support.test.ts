import { describe, it, expect } from 'vitest';
import { DshMcpBridge } from '../src/mcp-support.js';

describe('DshMcpBridge', () => {
  it('registers and retrieves MCP servers', () => {
    const bridge = new DshMcpBridge();
    bridge.register({
      name: 'sqlite',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sqlite']
    });

    const status = bridge.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.registeredServers).toBe(1);
    expect(status.servers).toContain('sqlite');

    const args = bridge.getLaunchArguments('sqlite');
    expect(args).toEqual(['npx', '-y', '@modelcontextprotocol/server-sqlite']);
  });

  it('unregisters an MCP server', () => {
    const bridge = new DshMcpBridge();
    bridge.register({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem']
    });
    expect(bridge.unregister('filesystem')).toBe(true);
    expect(bridge.getStatus().registeredServers).toBe(0);
  });
});
