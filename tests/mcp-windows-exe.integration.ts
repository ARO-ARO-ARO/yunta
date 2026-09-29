import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditProtectedRoots, DurableWordPressMissionAudit } from '../entrypoints/wordpress-draft/durable-audit.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = join(root, 'dist', 'YUNTA.exe');
const secret = 'windows-exe-test-password-never-logged';
const content = '<p>Windows exe private draft content.</p>';
const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'windows-exe-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

function request(id: number, method: string, params: Record<string, unknown> = {}): object {
  return { jsonrpc: '2.0', id, method, params };
}

function call(id: number, title = 'Test draft'): object {
  return request(id, 'tools/call', { name: 'wordpress.create_draft', arguments: { title, contentHtml: content } });
}

function launch(binary: string, cwd: string, vars: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...vars, PATH: '' };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  for (const name of ['WORDPRESS_BASE_URL', 'WORDPRESS_USERNAME', 'WORDPRESS_APPLICATION_PASSWORD', 'YUNTA_ACTOR_ID', 'YUNTA_AUDIT_PATH']) {
    if (!(name in vars)) delete env[name];
  }
  const child = spawn(binary, [], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  const lines: string[] = [];
  const messages: unknown[] = [];
  const waiters: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
  let protocolError: Error | undefined;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line);
    try {
      const value: unknown = JSON.parse(line);
      assert.equal(typeof value, 'object');
      assert.equal((value as Record<string, unknown>).jsonrpc, '2.0');
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value);
      else messages.push(value);
    } catch (error) {
      protocolError = error as Error;
      waiters.shift()?.reject(protocolError);
    }
  });
  const closed = new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  return {
    child, lines, get stderr() { return stderr; }, get protocolError() { return protocolError; },
    send(value: object) { child.stdin.write(`${JSON.stringify(value)}\n`); },
    async receive(id: number): Promise<Record<string, any>> {
      let timeout: NodeJS.Timeout | undefined;
      const next = messages.shift() ?? await Promise.race([
        new Promise<unknown>((resolve, reject) => waiters.push({ resolve, reject })),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`MCP response ${id} timed out: ${stderr}`)), 10_000); }),
      ]).finally(() => { if (timeout) clearTimeout(timeout); });
      assert.equal((next as Record<string, unknown>).id, id);
      return next as Record<string, any>;
    },
    async stop() {
      child.stdin.end();
      let timeout: NodeJS.Timeout | undefined;
      const code = await Promise.race([closed, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Exe did not exit on EOF')), 10_000);
      })]).finally(() => { if (timeout) clearTimeout(timeout); });
      assert.equal(code, 0, stderr);
      assert.equal(protocolError, undefined);
    },
    kill() { child.kill(); child.stdin.destroy(); },
  };
}

async function withMock(handler: (url: string, method: string, respond: (status: number, body: object) => void, body: string) => void) {
  const http = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => handler(req.url ?? '', req.method ?? '', (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    }, body));
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No mock port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((done) => http.close(() => done())) };
}

function environment(baseUrl: string, auditPath: string): NodeJS.ProcessEnv {
  return { WORDPRESS_BASE_URL: baseUrl, WORDPRESS_USERNAME: 'local-user', WORDPRESS_APPLICATION_PASSWORD: secret,
    YUNTA_ACTOR_ID: 'local-actor', YUNTA_AUDIT_PATH: auditPath };
}

test('SEA audit roots protect its distribution directory and an enclosing checkout', () => {
  const roots = auditProtectedRoots(executable, true);
  assert.ok(roots.includes(dirname(executable)));
  assert.ok(roots.includes(resolve(root)));
  const portable = join(tmpdir(), 'yunta-portable-folder', 'YUNTA.exe');
  assert.ok(auditProtectedRoots(portable, true).includes(dirname(portable)));
  assert.throws(() => new DurableWordPressMissionAudit(join(root, 'audit.jsonl')));
});

test('portable Windows exe serves MCP without Node on PATH or checkout beside it', async () => {
  const external = await mkdtemp(join(tmpdir(), 'yunta-portable-'));
  const binary = join(external, 'YUNTA.exe');
  await copyFile(executable, binary);
  assert.deepEqual(await readdir(external), ['YUNTA.exe']);
  const server = launch(binary, external);
  try {
    server.send(request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
    const init = await server.receive(1);
    assert.deepEqual(init.result.serverInfo, { name: 'yunta', version: '0.1.0' });
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    server.send(request(2, 'tools/list'));
    const listed = await server.receive(2);
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ['wordpress.create_draft']);
    server.send(call(3));
    assert.deepEqual((await server.receive(3)).result.structuredContent, { status: 'FAILED', code: 'MISSION_ENTRYPOINT_FAILED' });
    server.send(request(4, 'tools/call', { name: 'wordpress.create_draft', arguments: { title: 'x', contentHtml: content, status: 'publish' } }));
    assert.equal((await server.receive(4)).result.isError, true);
    await server.stop();
    assert.deepEqual(await readdir(external), ['YUNTA.exe']);
    assert.equal(server.lines.length, 4);
    assert.equal(server.stderr, '');

    const protectedAudit = launch(binary, external, environment('http://127.0.0.1:1', join(external, 'audit.jsonl')));
    try {
      protectedAudit.send(request(1, 'server/discover', { _meta: meta }));
      await protectedAudit.receive(1);
      protectedAudit.send(request(2, 'tools/call', { name: 'wordpress.create_draft', arguments: { title: 'Protected', contentHtml: content }, _meta: meta }));
      assert.deepEqual((await protectedAudit.receive(2)).result.structuredContent, { status: 'FAILED', code: 'MISSION_ENTRYPOINT_FAILED' });
      await protectedAudit.stop();
      assert.deepEqual(await readdir(external), ['YUNTA.exe']);
    } finally { protectedAudit.kill(); }
  } finally {
    server.kill();
    await rm(external, { recursive: true, force: true });
  }
});

test('exe creates and verifies exactly one mock WordPress draft with private audit and claims', async () => {
  const calls: string[] = [];
  let postBody: unknown;
  const mock = await withMock((url, method, respond, body) => {
    calls.push(`${method} ${url}`);
    if (url.endsWith('/users/me')) return respond(200, { id: 1 });
    if (url.endsWith('/posts') && method === 'POST') {
      postBody = JSON.parse(body);
      return respond(201, { id: 903, status: 'draft', link: 'https://example.test/?p=903' });
    }
    return respond(200, { id: 903, status: 'draft' });
  });
  const dir = await mkdtemp(join(tmpdir(), 'yunta-exe-audit-'));
  const audit = join(dir, 'audit.jsonl');
  const server = launch(executable, root, environment(mock.baseUrl, audit));
  try {
    server.send(request(1, 'server/discover', { _meta: meta }));
    await server.receive(1);
    server.send(request(2, 'tools/call', { name: 'wordpress.create_draft', arguments: { title: 'Private title', contentHtml: content }, _meta: meta }));
    assert.deepEqual((await server.receive(2)).result.structuredContent, { postId: 903, status: 'draft', resourceUrl: 'https://example.test/?p=903' });
    await server.stop();
    assert.deepEqual(calls, ['GET /wp-json/wp/v2/users/me', 'POST /wp-json/wp/v2/posts', 'GET /wp-json/wp/v2/posts/903']);
    assert.deepEqual(postBody, { title: 'Private title', content, status: 'draft' });
    const auditText = await readFile(audit, 'utf8');
    const files = await readdir(dir);
    assert.ok(files.some((file) => file.endsWith('.claim')));
    assert.ok(auditText.includes('ArticleDraftCreated'));
    for (const privateValue of [secret, content, 'Private title']) {
      assert.ok(!auditText.includes(privateValue));
      assert.ok(!server.lines.join('').includes(privateValue));
      assert.ok(!server.stderr.includes(privateValue));
    }
  } finally {
    server.kill();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('exe records a safe health failure before POST against local WordPress only', async () => {
  const calls: string[] = [];
  const mock = await withMock((url, method, respond) => {
    calls.push(`${method} ${url}`);
    respond(503, { password: secret });
  });
  const dir = await mkdtemp(join(tmpdir(), 'yunta-exe-health-'));
  const audit = join(dir, 'audit.jsonl');
  const server = launch(executable, root, environment(mock.baseUrl, audit));
  try {
    server.send(request(1, 'server/discover', { _meta: meta }));
    await server.receive(1);
    server.send(request(2, 'tools/call', { name: 'wordpress.create_draft', arguments: { title: 'Private', contentHtml: content }, _meta: meta }));
    assert.deepEqual((await server.receive(2)).result.structuredContent, { status: 'FAILED', code: 'MISSION_ENTRYPOINT_FAILED' });
    await server.stop();
    assert.deepEqual(calls, ['GET /wp-json/wp/v2/users/me']);
    const text = await readFile(audit, 'utf8');
    const events = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(events.map((event) => event.eventType), ['MissionRequested', 'MissionResult']);
    assert.equal(events[1]?.failureStage, 'HEALTH_CHECK');
    assert.equal(events[1]?.failureCategory, 'HTTP');
    assert.equal(events[1]?.failureCode, 'HEALTH_HTTP');
    for (const value of [secret, 'Authorization', 'Basic ', content, 'Private']) {
      assert.ok(!text.includes(value));
      assert.ok(!server.lines.join('').includes(value));
    }
  } finally {
    server.kill();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('exe rejects audit paths in its checkout and preserves ambiguous outcome after POST', async () => {
  let posts = 0;
  const mock = await withMock((url, method, respond) => {
    if (url.endsWith('/users/me')) return respond(200, { id: 1 });
    if (method === 'POST') {
      posts++;
      return respond(201, { id: 904, status: 'draft', link: 'https://example.test/?p=904' });
    }
    return respond(500, {});
  });
  const dir = await mkdtemp(join(tmpdir(), 'yunta-exe-ambiguous-'));
  const server = launch(executable, root, environment(mock.baseUrl, join(root, 'unsafe-audit.jsonl')));
  try {
    server.send(request(1, 'server/discover', { _meta: meta }));
    await server.receive(1);
    server.send(request(2, 'tools/call', { name: 'wordpress.create_draft', arguments: { title: 'Protected', contentHtml: content }, _meta: meta }));
    assert.deepEqual((await server.receive(2)).result.structuredContent, { status: 'FAILED', code: 'MISSION_ENTRYPOINT_FAILED' });
    assert.equal(posts, 0);
    await server.stop();
  } finally { server.kill(); }
  const valid = launch(executable, root, environment(mock.baseUrl, join(dir, 'audit.jsonl')));
  try {
    valid.send(request(1, 'server/discover', { _meta: meta }));
    await valid.receive(1);
    valid.send(request(2, 'tools/call', { name: 'wordpress.create_draft', arguments: { title: 'Ambiguous', contentHtml: content }, _meta: meta }));
    assert.deepEqual((await valid.receive(2)).result.structuredContent, { status: 'FAILED', code: 'EXECUTION_OUTCOME_AMBIGUOUS' });
    assert.equal(posts, 1);
    await valid.stop();
    const events = (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const result = events.at(-1);
    assert.equal(result?.failureStage, 'READBACK');
    assert.equal(result?.failureCategory, 'HTTP');
    assert.equal(result?.reasonCode, 'EXECUTION_OUTCOME_AMBIGUOUS');
    assert.ok(!JSON.stringify(events).includes(secret));
  } finally {
    valid.kill();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('exe rejects a concurrent draft while the first POST is pending', async () => {
  let posts = 0;
  let arrived!: () => void;
  const postArrived = new Promise<void>((resolve) => { arrived = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const mock = await withMock((url, method, respond) => {
    if (url.endsWith('/users/me')) return respond(200, { id: 1 });
    if (method === 'POST') {
      posts++;
      arrived();
      void held.then(() => respond(201, { id: 905, status: 'draft', link: 'https://example.test/?p=905' }));
      return;
    }
    return respond(200, { id: 905, status: 'draft' });
  });
  const dir = await mkdtemp(join(tmpdir(), 'yunta-exe-concurrent-'));
  const server = launch(executable, root, environment(mock.baseUrl, join(dir, 'audit.jsonl')));
  try {
    server.send(request(1, 'server/discover', { _meta: meta }));
    await server.receive(1);
    server.send(request(2, 'tools/call', { name: 'wordpress.create_draft', arguments: { title: 'First', contentHtml: content }, _meta: meta }));
    await postArrived;
    server.send(request(3, 'tools/call', { name: 'wordpress.create_draft', arguments: { title: 'Second', contentHtml: content }, _meta: meta }));
    assert.deepEqual((await server.receive(3)).result.structuredContent, { status: 'NOT_READY', code: 'EXECUTION_NOT_READY' });
    release();
    assert.equal((await server.receive(2)).result.structuredContent.postId, 905);
    assert.equal(posts, 1);
    await server.stop();
  } finally {
    release();
    server.kill();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});
