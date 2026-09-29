import { McpServer } from '@modelcontextprotocol/server';
import { registerWordPressCreateDraftTool } from './wordpress-create-draft-tool.ts';

export function createYuntaMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'yunta', version: '0.1.0' },
    { capabilities: { tools: { listChanged: false } } },
  );
  registerWordPressCreateDraftTool(server);
  return server;
}
