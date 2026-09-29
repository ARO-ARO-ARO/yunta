import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import test from 'node:test';

const entrypoint = fileURLToPath(new URL('../entrypoints/mcp/stdio.ts', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const responseTimeoutMs = 5_000;
const wordpressEnvironmentVariables = [
  'WORDPRESS_BASE_URL',
  'WORDPRESS_USERNAME',
  'WORDPRESS_APPLICATION_PASSWORD',
  'YUNTA_ACTOR_ID',
  'YUNTA_AUDIT_PATH',
] as const;

interface PendingMessage {
  readonly resolve: (message: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface ServerHarness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  readonly protocolErrors: Error[];
  readonly stderr: string[];
  readonly stdoutLines: string[];
  nextMessage(): Promise<unknown>;
  send(message: unknown): void;
}

function withoutWordPressEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of wordpressEnvironmentVariables) delete environment[name];
  return environment;
}

function startServer(
  environment: NodeJS.ProcessEnv = withoutWordPressEnvironment(),
  cwd: string = repositoryRoot,
): ServerHarness {
  const child = spawn(process.execPath, [entrypoint], {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const protocolErrors: Error[] = [];
  const stderr: string[] = [];
  const stdoutLines: string[] = [];
  const messages: unknown[] = [];
  const pending: PendingMessage[] = [];
  const output = createInterface({ input: child.stdout });
  const exit = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));
  output.on('line', (line) => {
    stdoutLines.push(line);
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      const error = new Error(`Non-JSON stdout line: ${line}`);
      protocolErrors.push(error);
      const waiter = pending.shift();
      if (waiter) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
      return;
    }
    const waiter = pending.shift();
    if (waiter) {
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });
  child.once('exit', () => {
    while (pending.length > 0) {
      const waiter = pending.shift()!;
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('MCP server exited before responding'));
    }
  });

  return {
    child,
    exit,
    protocolErrors,
    stderr,
    stdoutLines,
    nextMessage(): Promise<unknown> {
      const message = messages.shift();
      if (message !== undefined) return Promise.resolve(message);
      return new Promise((resolve, reject) => {
        const waiter: PendingMessage = {
          resolve,
          reject,
          timeout: setTimeout(() => {
            const index = pending.indexOf(waiter);
            if (index >= 0) pending.splice(index, 1);
            reject(new Error('Timed out waiting for MCP response'));
          }, responseTimeoutMs),
        };
        pending.push(waiter);
      });
    },
    send(message: unknown): void {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function assertJsonRpcResponse(value: unknown, id: number): Record<string, unknown> {
  const response = asRecord(value);
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, id);
  return response;
}

async function waitForExit<T>(
  exit: Promise<T>,
  timeoutMs = responseTimeoutMs,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exit,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out waiting for MCP server exit')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function cleanShutdown(harness: ServerHarness): Promise<void> {
  harness.child.stdin.end();
  const result = await waitForExit(harness.exit);
  assert.equal(result.code, 0, harness.stderr.join(''));
  assert.equal(result.signal, null);
  assert.deepEqual(harness.protocolErrors, []);
  for (const line of harness.stderr.join('').split('\n').filter(Boolean)) {
    assert.equal(line, 'YUNTA MCP stdio transport error');
  }
  for (const line of harness.stdoutLines) {
    const message = asRecord(JSON.parse(line));
    assert.equal(message.jsonrpc, '2.0');
  }
}

async function forceCleanup(harness: ServerHarness): Promise<void> {
  if (harness.child.exitCode !== null || harness.child.signalCode !== null) return;
  harness.child.stdin.end();
  try {
    await waitForExit(harness.exit, 1_000);
  } catch {
    harness.child.kill();
    await waitForExit(harness.exit, 1_000).catch(() => undefined);
  }
}

function modernMeta(protocolVersion: string): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': { name: 'yunta-test-client', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

function assertWordPressToolList(value: unknown): void {
  const result = asRecord(value);
  const tools = result.tools;
  assert.equal(Array.isArray(tools), true);
  assert.equal((tools as unknown[]).length, 1);
  const tool = asRecord((tools as unknown[])[0]);
  assert.equal(tool.name, 'wordpress.create_draft');
  assert.equal(tool.title, 'Create WordPress draft');
  const inputSchema = asRecord(tool.inputSchema);
  assert.equal(inputSchema.type, 'object');
  assert.equal(inputSchema.additionalProperties, false);
  assert.deepEqual(inputSchema.required, ['title', 'contentHtml']);
  const properties = asRecord(inputSchema.properties);
  assert.deepEqual(Object.keys(properties).sort(), ['contentHtml', 'title']);
  assert.deepEqual(asRecord(properties.title), { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' });
  assert.deepEqual(asRecord(properties.contentHtml), { type: 'string', minLength: 1, maxLength: 65_536, pattern: '\\S' });
}

test('starts by absolute entrypoint from outside the checkout and lists the only tool over clean stdio', async () => {
  const externalCwd = await mkdtemp(join(tmpdir(), 'yunta-external-client-'));
  assert.equal(isAbsolute(entrypoint), true);
  const harness = startServer(withoutWordPressEnvironment(), externalCwd);
  let shutdownComplete = false;
  try {
    harness.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: { _meta: modernMeta('2026-07-28') },
    });
    const discovery = assertJsonRpcResponse(await harness.nextMessage(), 1);
    assert.deepEqual(asRecord(asRecord(discovery.result).capabilities).tools, { listChanged: false });

    harness.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: { _meta: modernMeta('2026-07-28') },
    });
    assertWordPressToolList(asRecord(assertJsonRpcResponse(await harness.nextMessage(), 2).result));

    await cleanShutdown(harness);
    shutdownComplete = true;
    assert.equal(harness.stdoutLines.length, 2);
  } finally {
    if (!shutdownComplete) await forceCleanup(harness);
    await rm(externalCwd, { recursive: true, force: true });
  }
});

function assertSafeToolError(value: unknown, id: number, code: string): void {
  const response = assertJsonRpcResponse(value, id);
  const result = asRecord(response.result);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { status: 'FAILED', code });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function localServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ readonly baseUrl: string; close(): Promise<void> }> {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('Test server address is unavailable');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      instance.close((error) => error ? reject(error) : resolve());
    }),
  };
}

test('serves modern MCP discovery, validation, and controlled failure over pure stdio', async () => {
  const harness = startServer();
  let shutdownComplete = false;
  try {
    harness.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: { _meta: modernMeta('1900-01-01') },
    });
    const unsupported = assertJsonRpcResponse(await harness.nextMessage(), 1);
    const unsupportedError = asRecord(unsupported.error);
    assert.equal(unsupportedError.code, -32022);
    assert.deepEqual(asRecord(unsupportedError.data).supported, ['2026-07-28']);

    harness.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'server/discover',
      params: { _meta: modernMeta('2026-07-28') },
    });
    const discovery = assertJsonRpcResponse(await harness.nextMessage(), 2);
    const discoveryResult = asRecord(discovery.result);
    assert.deepEqual(discoveryResult.supportedVersions, ['2026-07-28']);
    assert.deepEqual(asRecord(discoveryResult.capabilities).tools, { listChanged: false });
    const serverInfo = asRecord(asRecord(discoveryResult._meta)['io.modelcontextprotocol/serverInfo']);
    assert.deepEqual(serverInfo, { name: 'yunta', version: '0.1.0' });

    harness.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: { _meta: modernMeta('2026-07-28') },
    });
    const list = assertJsonRpcResponse(await harness.nextMessage(), 3);
    const listResult = asRecord(list.result);
    assert.equal(listResult.resultType, 'complete');
    assertWordPressToolList(listResult);

    harness.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'wordpress.create_draft',
        arguments: { title: 'Invalid', contentHtml: '<p>Invalid.</p>', status: 'publish' },
        _meta: modernMeta('2026-07-28'),
      },
    });
    const additionalInput = assertJsonRpcResponse(await harness.nextMessage(), 4);
    assert.equal(asRecord(additionalInput.result).isError, true);

    harness.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'wordpress.create_draft',
        arguments: { title: '   ', contentHtml: '<p>Invalid.</p>' },
        _meta: modernMeta('2026-07-28'),
      },
    });
    const blankInput = assertJsonRpcResponse(await harness.nextMessage(), 5);
    assert.equal(asRecord(blankInput.result).isError, true);

    harness.send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'wordpress.create_draft',
        arguments: { title: 'Missing configuration', contentHtml: '<p>Controlled failure.</p>' },
        _meta: modernMeta('2026-07-28'),
      },
    });
    assertSafeToolError(await harness.nextMessage(), 6, 'MISSION_ENTRYPOINT_FAILED');

    harness.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
      params: { _meta: modernMeta('2026-07-28') },
    });
    assertWordPressToolList(asRecord(assertJsonRpcResponse(await harness.nextMessage(), 7).result));

    const sensitiveProperty = 'sensitive-caller-input-not-for-output';
    harness.send({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: {
        name: 'wordpress.create_draft',
        arguments: { title: 'invalid', contentHtml: 'valid', [sensitiveProperty]: 'value' },
        _meta: modernMeta('2026-07-28'),
      },
    });
    const unsafeKey = asRecord(assertJsonRpcResponse(await harness.nextMessage(), 8).result);
    assert.equal(unsafeKey.isError, true);
    assert.equal(JSON.stringify(unsafeKey).includes(sensitiveProperty), false);

    await cleanShutdown(harness);
    shutdownComplete = true;
    assert.equal(harness.stdoutLines.length, 8);
    assert.equal(harness.stdoutLines.join('\n').includes('Controlled failure.'), false);
  } finally {
    if (!shutdownComplete) await forceCleanup(harness);
  }
});

test('serves legacy initialize, tool calls, and controlled failure over pure stdio', async () => {
  const harness = startServer();
  let shutdownComplete = false;
  try {
    harness.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'yunta-legacy-test-client', version: '1.0.0' },
      },
    });
    const initialization = assertJsonRpcResponse(await harness.nextMessage(), 1);
    const initializationResult = asRecord(initialization.result);
    assert.equal(initializationResult.protocolVersion, '2025-11-25');
    assert.deepEqual(initializationResult.serverInfo, { name: 'yunta', version: '0.1.0' });
    assert.deepEqual(asRecord(initializationResult.capabilities).tools, { listChanged: false });

    harness.send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });
    harness.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    const list = assertJsonRpcResponse(await harness.nextMessage(), 2);
    assertWordPressToolList(asRecord(list.result));

    harness.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'wordpress.create_draft',
        arguments: { title: 'Legacy failure', contentHtml: '<p>Controlled legacy failure.</p>' },
      },
    });
    assertSafeToolError(await harness.nextMessage(), 3, 'MISSION_ENTRYPOINT_FAILED');

    harness.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: {},
    });
    assertWordPressToolList(asRecord(assertJsonRpcResponse(await harness.nextMessage(), 4).result));

    await cleanShutdown(harness);
    shutdownComplete = true;
    assert.equal(harness.stdoutLines.length, 4);
    assert.equal(harness.stdoutLines.join('\n').includes('Controlled legacy failure.'), false);
  } finally {
    if (!shutdownComplete) await forceCleanup(harness);
  }
});

test('calls the existing WordPress flow against a local server', async () => {
  let healthGets = 0;
  let posts = 0;
  let verificationGets = 0;
  let postBody: unknown;
  const contentHtml = '<p>MCP local content must not reach stdout.</p>';
  const applicationPassword = 'mcp-local-password-not-for-output';
  const wordpress = await localServer((request, response) => {
    if (request.method === 'GET' && request.url === '/wp-json/wp/v2/users/me') {
      healthGets += 1;
      writeJson(response, 200, { id: 1 });
      return;
    }
    if (request.method === 'POST' && request.url === '/wp-json/wp/v2/posts') {
      posts += 1;
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        postBody = JSON.parse(body);
        writeJson(response, 201, { id: 903, status: 'draft', link: 'https://example.test/?p=903' });
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/wp-json/wp/v2/posts/903') {
      verificationGets += 1;
      writeJson(response, 200, { id: 903, status: 'draft' });
      return;
    }
    writeJson(response, 404, {});
  });
  const directory = await mkdtemp(join(tmpdir(), 'yunta-mcp-wordpress-'));
  const harness = startServer({
    ...withoutWordPressEnvironment(),
    WORDPRESS_BASE_URL: wordpress.baseUrl,
    WORDPRESS_USERNAME: 'mcp-local-user',
    WORDPRESS_APPLICATION_PASSWORD: applicationPassword,
    YUNTA_ACTOR_ID: 'mcp-local-actor',
    YUNTA_AUDIT_PATH: join(directory, 'mission-audit.jsonl'),
  });
  let shutdownComplete = false;
  try {
    harness.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: { _meta: modernMeta('2026-07-28') },
    });
    await harness.nextMessage();
    harness.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'wordpress.create_draft',
        arguments: { title: 'MCP local article', contentHtml },
        _meta: modernMeta('2026-07-28'),
      },
    });

    const call = assertJsonRpcResponse(await harness.nextMessage(), 2);
    const result = asRecord(call.result);
    assert.equal(result.resultType, 'complete');
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      postId: 903,
      status: 'draft',
      resourceUrl: 'https://example.test/?p=903',
    });
    assert.equal(healthGets, 1);
    assert.equal(posts, 1);
    assert.equal(verificationGets, 1);
    assert.deepEqual(postBody, {
      title: 'MCP local article',
      content: contentHtml,
      status: 'draft',
    });

    await cleanShutdown(harness);
    shutdownComplete = true;
    const output = harness.stdoutLines.join('\n');
    assert.equal(output.includes(applicationPassword), false);
    assert.equal(output.includes(contentHtml), false);
    assert.equal(output.includes('MCP local article'), false);
  } finally {
    if (!shutdownComplete) await forceCleanup(harness);
    await wordpress.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('two concurrent MCP calls admit at most one draft POST', async () => {
  let posts = 0;
  let healthGets = 0;
  let releasePost!: () => void;
  const held = new Promise<void>((resolve) => { releasePost = resolve; });
  let sawPost!: () => void;
  const arrived = new Promise<void>((resolve) => { sawPost = resolve; });
  const wordpress = await localServer((request, response) => {
    if (request.url === '/wp-json/wp/v2/users/me') {
      healthGets += 1;
      return writeJson(response, 200, { id: 1 });
    }
    if (request.url === '/wp-json/wp/v2/posts') {
      posts += 1;
      sawPost();
      void held.then(() => writeJson(response, 201, { id: 906, status: 'draft', link: 'https://example.test/?p=906' }));
      return;
    }
    writeJson(response, 200, { id: 906, status: 'draft' });
  });
  const directory = await mkdtemp(join(tmpdir(), 'yunta-mcp-concurrent-'));
  const harness = startServer({
    ...withoutWordPressEnvironment(),
    WORDPRESS_BASE_URL: wordpress.baseUrl,
    WORDPRESS_USERNAME: 'local-user',
    WORDPRESS_APPLICATION_PASSWORD: 'local-password',
    YUNTA_ACTOR_ID: 'local-actor',
    YUNTA_AUDIT_PATH: join(directory, 'audit.jsonl'),
  });
  let shutdownComplete = false;
  try {
    harness.send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: modernMeta('2026-07-28') } });
    await harness.nextMessage();
    const call = (id: number) => ({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'wordpress.create_draft', arguments: { title: 'Concurrent', contentHtml: 'one' }, _meta: modernMeta('2026-07-28') },
    });
    harness.send(call(2));
    await arrived;
    harness.send(call(3));
    const rejected = assertJsonRpcResponse(await harness.nextMessage(), 3);
    assert.deepEqual(asRecord(rejected.result).structuredContent, { status: 'NOT_READY', code: 'EXECUTION_NOT_READY' });
    assert.equal(posts, 1);
    assert.equal(healthGets, 1);
    releasePost();
    const completed = assertJsonRpcResponse(await harness.nextMessage(), 2);
    assert.deepEqual(asRecord(completed.result).structuredContent, { postId: 906, status: 'draft', resourceUrl: 'https://example.test/?p=906' });
    await cleanShutdown(harness);
    shutdownComplete = true;
  } finally {
    releasePost();
    if (!shutdownComplete) await forceCleanup(harness);
    await wordpress.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('stdio rejects a message larger than 256 KiB without exposing its contents', async () => {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: repositoryRoot,
    env: withoutWordPressEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  const exit = new Promise<number | null>((resolve) => child.once('close', resolve));
  child.stdin.end(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'wordpress.create_draft', arguments: { title: 'oversized', contentHtml: 'x'.repeat(262_145) } },
  })}\n`);
  assert.equal(await waitForExit(exit), 0);
  assert.equal(stdout, '');
  assert.equal(stderr.trim(), 'YUNTA MCP stdio transport error');
});

test('cancellation after POST does not cause another POST and leaves audit evidence', async () => {
  let posts = 0;
  let releasePost!: () => void;
  const held = new Promise<void>((resolve) => { releasePost = resolve; });
  let sawPost!: () => void;
  const arrived = new Promise<void>((resolve) => { sawPost = resolve; });
  const wordpress = await localServer((request, response) => {
    if (request.url === '/wp-json/wp/v2/users/me') return writeJson(response, 200, { id: 1 });
    if (request.url === '/wp-json/wp/v2/posts') {
      posts += 1;
      sawPost();
      void held.then(() => writeJson(response, 201, { id: 907, status: 'draft', link: 'https://example.test/?p=907' }));
      return;
    }
    writeJson(response, 200, { id: 907, status: 'draft' });
  });
  const directory = await mkdtemp(join(tmpdir(), 'yunta-mcp-cancel-'));
  const auditPath = join(directory, 'audit.jsonl');
  const harness = startServer({
    ...withoutWordPressEnvironment(), WORDPRESS_BASE_URL: wordpress.baseUrl,
    WORDPRESS_USERNAME: 'local-user', WORDPRESS_APPLICATION_PASSWORD: 'local-password',
    YUNTA_ACTOR_ID: 'local-actor', YUNTA_AUDIT_PATH: auditPath,
  });
  let shutdownComplete = false;
  try {
    harness.send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: modernMeta('2026-07-28') } });
    await harness.nextMessage();
    harness.send({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'wordpress.create_draft', arguments: { title: 'Cancelled after dispatch', contentHtml: 'safe' }, _meta: modernMeta('2026-07-28') },
    });
    await arrived;
    harness.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    releasePost();
    harness.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: modernMeta('2026-07-28') } });
    assertWordPressToolList(asRecord(assertJsonRpcResponse(await harness.nextMessage(), 3).result));
    await cleanShutdown(harness);
    shutdownComplete = true;
    const audit = await readFile(auditPath, 'utf8');
    assert.equal(posts, 1);
    assert.equal(audit.includes('ArticleDraftCreated'), true);
    assert.equal(audit.includes('local-password'), false);
  } finally {
    releasePost();
    if (!shutdownComplete) await forceCleanup(harness);
    await wordpress.close();
    await rm(directory, { recursive: true, force: true });
  }
});
