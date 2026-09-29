import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import { createYuntaMcpServer } from './server.ts';

const writeDiagnostic = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

export function serveYuntaMcpStdio(): StdioServerHandle {
  return serveStdio(createYuntaMcpServer, {
    legacy: 'serve',
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 256 * 1024 }),
    onerror: () => writeDiagnostic('YUNTA MCP stdio transport error'),
  });
}

if (import.meta.main) {
  try {
    serveYuntaMcpStdio();
  } catch {
    writeDiagnostic('YUNTA MCP stdio startup failed');
    process.exitCode = 1;
  }
}
