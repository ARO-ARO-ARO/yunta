import { serveYuntaMcpStdio } from './stdio.ts';

// SEA executes a bundled CommonJS script, where import.meta.main is unavailable.
try {
  serveYuntaMcpStdio();
} catch {
  process.stderr.write('YUNTA MCP stdio startup failed\n');
  process.exitCode = 1;
}
