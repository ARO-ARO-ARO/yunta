import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runWordPressDraftCli } from '../entrypoints/wordpress-draft/cli.ts';
import { invokeWordPressArticleDraft } from '../entrypoints/wordpress-draft/composition.ts';

interface TestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function server(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('Test server address is unavailable');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve())),
  };
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function auditEnvironment(baseUrl: string): Promise<{
  readonly environment: NodeJS.ProcessEnv;
  readonly directory: string;
  readonly auditPath: string;
  readonly applicationPassword: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'yunta-wordpress-entrypoint-'));
  const applicationPassword = 'wordpress-entrypoint-password-not-for-audit';
  return {
    directory,
    auditPath: join(directory, 'mission-audit.jsonl'),
    applicationPassword,
    environment: {
      WORDPRESS_BASE_URL: baseUrl,
      WORDPRESS_USERNAME: 'wordpress-entrypoint-user',
      WORDPRESS_APPLICATION_PASSWORD: applicationPassword,
      YUNTA_ACTOR_ID: 'wordpress-entrypoint-actor',
      YUNTA_AUDIT_PATH: join(directory, 'mission-audit.jsonl'),
    },
  };
}

async function auditEvents(path: string): Promise<readonly Record<string, unknown>[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('runs the CLI through mission, B4, B2, B3, B5, and the controlled WordPress connector', async () => {
  let postCount = 0;
  let postBody: unknown;
  const wordpress = await server((request, response) => {
    if (request.url === '/wp-json/wp/v2/users/me') {
      writeJson(response, 200, { id: 1 });
      return;
    }
    if (request.url === '/wp-json/wp/v2/posts') {
      postCount += 1;
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        postBody = JSON.parse(body);
        writeJson(response, 201, { id: 901, status: 'draft', link: 'https://example.test/?p=901' });
      });
      return;
    }
    if (request.url === '/wp-json/wp/v2/posts/901') {
      writeJson(response, 200, { id: 901, status: 'draft' });
      return;
    }
    writeJson(response, 404, {});
  });
  const fixture = await auditEnvironment(wordpress.baseUrl);
  try {
    const output: string[] = [];
    const code = await runWordPressDraftCli([
      '--title', 'Entrypoint article',
      '--content-html', '<p>Controlled entrypoint content.</p>',
      '--request-id', 'request-entrypoint-1',
      '--correlation-id', 'correlation-entrypoint-1',
    ], fixture.environment, (line) => output.push(line));

    assert.equal(code, 0);
    assert.equal(postCount, 1);
    assert.deepEqual(postBody, {
      title: 'Entrypoint article',
      content: '<p>Controlled entrypoint content.</p>',
      status: 'draft',
    });
    const result = JSON.parse(output.join('')) as Record<string, unknown>;
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.requestId, 'request-entrypoint-1');
    assert.equal(result.correlationId, 'correlation-entrypoint-1');
    assert.equal(typeof result.executionId, 'string');
    assert.deepEqual(result.output, { postId: 901, status: 'draft', resourceUrl: 'https://example.test/?p=901' });
    assert.equal(JSON.stringify(result).includes(fixture.applicationPassword), false);

    const events = await auditEvents(fixture.auditPath);
    assert.deepEqual(events.map((event) => event.eventType), [
      'MissionRequested',
      'ExecutionPreparationRequested',
      'ExecutionPreparationApproved',
      'ArticleDraftCreated',
      'MissionResult',
    ]);
    assert.ok(events.every((event) => event.requestId === 'request-entrypoint-1'));
    assert.ok(events.every((event) => event.correlationId === 'correlation-entrypoint-1'));
    assert.ok(events.slice(1).every((event) => event.executionId === result.executionId));
    const audit = JSON.stringify(events);
    assert.equal(audit.includes(fixture.applicationPassword), false);
    assert.equal(audit.includes('Authorization'), false);
    assert.equal(audit.includes('Controlled entrypoint content.'), false);
  } finally {
    await wordpress.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('propagates mission failures through a safe CLI result without provider data', async () => {
  const wordpress = await server((_request, response) => writeJson(response, 500, {
    password: 'provider-password-not-for-output',
  }));
  const fixture = await auditEnvironment(wordpress.baseUrl);
  try {
    const output: string[] = [];
    const code = await runWordPressDraftCli([
      '--title', 'Unavailable article',
      '--content-html', '<p>Unavailable.</p>',
      '--request-id', 'request-entrypoint-failure',
    ], fixture.environment, (line) => output.push(line));

    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(output.join('')), { status: 'FAILED', code: 'MISSION_ENTRYPOINT_FAILED' });
    const audit = await readFile(fixture.auditPath, 'utf8');
    assert.equal(audit.includes(fixture.applicationPassword), false);
    assert.equal(audit.includes('provider-password-not-for-output'), false);
    assert.equal(audit.includes('<p>Unavailable.</p>'), false);
  } finally {
    await wordpress.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('claims request IDs durably and prevents duplicate entrypoint execution', async () => {
  let postCount = 0;
  const wordpress = await server((request, response) => {
    if (request.url === '/wp-json/wp/v2/users/me') return writeJson(response, 200, { id: 1 });
    if (request.url === '/wp-json/wp/v2/posts') {
      postCount += 1;
      request.resume();
      request.on('end', () => writeJson(response, 201, { id: 902, status: 'draft', link: 'https://example.test/?p=902' }));
      return;
    }
    if (request.url === '/wp-json/wp/v2/posts/902') return writeJson(response, 200, { id: 902, status: 'draft' });
    writeJson(response, 404, {});
  });
  const fixture = await auditEnvironment(wordpress.baseUrl);
  try {
    const first: string[] = [];
    const second: string[] = [];
    const argumentsList = [
      '--title', 'Exactly once',
      '--content-html', '<p>Exactly once.</p>',
      '--request-id', 'request-entrypoint-once',
    ];
    assert.equal(await runWordPressDraftCli(argumentsList, fixture.environment, (line) => first.push(line)), 0);
    assert.equal(await runWordPressDraftCli(argumentsList, fixture.environment, (line) => second.push(line)), 1);
    assert.equal(postCount, 1);
    assert.equal(JSON.parse(first.join('')).status, 'SUCCEEDED');
    assert.deepEqual(JSON.parse(second.join('')), { status: 'FAILED', code: 'DUPLICATE_REQUEST' });
  } finally {
    await wordpress.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects secret-like CLI options without writing their value', async () => {
  const output: string[] = [];
  const code = await runWordPressDraftCli([
    '--title', 'Rejected',
    '--content-html', '<p>Rejected.</p>',
    '--password', 'cli-password-not-for-output',
  ], {}, (line) => output.push(line));

  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(output.join('')), { status: 'FAILED', code: 'MISSION_ENTRYPOINT_FAILED' });
  assert.equal(output.join('').includes('cli-password-not-for-output'), false);
});

test('keeps legacy resolver and WordPress protocol logic out of the CLI boundary', async () => {
  const [cli, composition] = await Promise.all([
    readFile(new URL('../entrypoints/wordpress-draft/cli.ts', import.meta.url), 'utf8'),
    readFile(new URL('../entrypoints/wordpress-draft/composition.ts', import.meta.url), 'utf8'),
  ]);

  assert.equal(cli.includes('ConnectorResolver'), false);
  assert.equal(composition.includes('ConnectorResolver'), false);
  assert.equal(cli.includes('/wp-json/'), false);
  assert.equal(cli.includes('WordPressConnector'), false);
});

test('rejects invalid input and unsafe audit paths before claiming or checking health', async () => {
  let requests = 0;
  const wordpress = await server((_request, response) => {
    requests += 1;
    writeJson(response, 500, {});
  });
  const fixture = await auditEnvironment(wordpress.baseUrl);
  try {
    for (const [input, path] of [
      [{ title: 'x'.repeat(201), contentHtml: 'valid' }, fixture.auditPath],
      [{ title: 'valid', contentHtml: 'é'.repeat(32_769) }, fixture.auditPath],
      [{ title: 'valid', contentHtml: 'valid' }, 'relative-audit.jsonl'],
      [{ title: 'valid', contentHtml: 'valid' }, join(process.cwd(), 'local-audit.jsonl')],
      [{ title: 'valid', contentHtml: 'valid' }, join(fixture.directory, fixture.applicationPassword, 'audit.jsonl')],
    ] as const) {
      await assert.rejects(invokeWordPressArticleDraft(input, {
        environment: { ...fixture.environment, YUNTA_AUDIT_PATH: path },
      }));
    }
    await mkdir(fixture.auditPath);
    await assert.rejects(invokeWordPressArticleDraft({ title: 'valid', contentHtml: 'valid' }, {
      environment: fixture.environment,
    }));
    assert.equal(requests, 0);
    assert.deepEqual(await readdir(fixture.directory), ['mission-audit.jsonl']);
  } finally {
    await wordpress.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('cancellation during health prevents any draft POST', async () => {
  const wordpress = await server((_request, response) => writeJson(response, 200, { id: 1 }));
  const fixture = await auditEnvironment(wordpress.baseUrl);
  let posts = 0;
  const controller = new AbortController();
  try {
    await assert.rejects(invokeWordPressArticleDraft({ title: 'cancelled', contentHtml: 'valid' }, {
      environment: fixture.environment,
      signal: controller.signal,
      fetcher: async (url, init) => {
        if (init.method === 'POST') posts += 1;
        if (url.pathname.endsWith('/users/me')) controller.abort();
        return fetch(url, init);
      },
    }));
    assert.equal(posts, 0);
  } finally {
    await wordpress.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('audit failure after a possible POST becomes ambiguous without a retry', async () => {
  let posts = 0;
  const wordpress = await server((request, response) => {
    if (request.url === '/wp-json/wp/v2/users/me') return writeJson(response, 200, { id: 1 });
    if (request.url === '/wp-json/wp/v2/posts') {
      posts += 1;
      return writeJson(response, 201, { id: 905, status: 'draft', link: 'https://example.test/?p=905' });
    }
    writeJson(response, 200, { id: 905, status: 'draft' });
  });
  const fixture = await auditEnvironment(wordpress.baseUrl);
  try {
    const result = await invokeWordPressArticleDraft({ title: 'ambiguous audit', contentHtml: 'valid' }, {
      environment: fixture.environment,
      fetcher: async (url, init) => {
        const result = await fetch(url, init);
        if (init.method === 'POST') {
          await rm(fixture.auditPath);
          await mkdir(fixture.auditPath);
        }
        return result;
      },
    });
    assert.equal(result.status, 'FAILED');
    if (result.status === 'FAILED') assert.equal(result.reasonCode, 'EXECUTION_OUTCOME_AMBIGUOUS');
    assert.equal(posts, 1);
  } finally {
    await wordpress.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('configuration failure records a safe pre-POST stage without making a request', async () => {
  const fixture = await auditEnvironment('https://user:credential@example.test');
  let requests = 0;
  try {
    await assert.rejects(invokeWordPressArticleDraft({ title: 'private title', contentHtml: '<p>private html</p>' }, {
      environment: fixture.environment,
      fetcher: async () => { requests++; throw new Error('must not request'); },
    }));
    assert.equal(requests, 0);
    const events = await auditEvents(fixture.auditPath);
    assert.deepEqual(events.map((event) => event.eventType), ['MissionRequested', 'MissionResult']);
    assert.equal(events[1]?.reasonCode, 'MISSION_FAILED');
    assert.equal(events[1]?.failureStage, 'CONFIGURATION');
    assert.equal(events[1]?.failureCategory, 'CONFIGURATION');
    assert.equal(events[1]?.failureCode, 'CONFIGURATION_FAILED');
    assert.equal(typeof events[1]?.elapsedMs, 'number');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('health timeout records its stage, category and bounded code before any POST', async () => {
  const fixture = await auditEnvironment('http://127.0.0.1:1');
  let gets = 0;
  let posts = 0;
  try {
    await assert.rejects(invokeWordPressArticleDraft({ title: 'private title', contentHtml: '<p>private html</p>' }, {
      environment: fixture.environment,
      fetcher: async (_url, init) => {
        if (init.method !== 'GET') { posts++; throw new Error('unexpected POST'); }
        gets++;
        await new Promise<void>((_resolve, reject) => init.signal?.addEventListener('abort',
          () => reject(new Error(`sensitive ${fixture.applicationPassword} <p>private html</p>`)), { once: true }));
        throw new Error('request aborted');
      },
    }));
    assert.equal(gets, 1);
    assert.equal(posts, 0);
    const events = await auditEvents(fixture.auditPath);
    assert.deepEqual(events.map((event) => event.eventType), ['MissionRequested', 'MissionResult']);
    assert.equal(events[1]?.reasonCode, 'MISSION_FAILED');
    assert.equal(events[1]?.failureStage, 'HEALTH_CHECK');
    assert.equal(events[1]?.failureCategory, 'TIMEOUT');
    assert.equal(events[1]?.failureCode, 'HEALTH_TIMEOUT');
    assert.ok(Number(events[1]?.elapsedMs) >= 9_000);
    const text = JSON.stringify(events);
    for (const value of [fixture.applicationPassword, 'Authorization', 'Basic ', '<p>private html</p>', 'private title']) {
      assert.equal(text.includes(value), false);
    }
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('health HTTP failure remains distinguishable from connector execution with no POST', async () => {
  const fixture = await auditEnvironment('http://127.0.0.1:1');
  let posts = 0;
  try {
    await assert.rejects(invokeWordPressArticleDraft({ title: 'test', contentHtml: 'private' }, {
      environment: fixture.environment,
      fetcher: async (_url, init) => {
        if (init.method === 'POST') posts++;
        return new Response(null, { status: 503 });
      },
    }));
    assert.equal(posts, 0);
    const result = (await auditEvents(fixture.auditPath)).at(-1);
    assert.equal(result?.failureStage, 'HEALTH_CHECK');
    assert.equal(result?.failureCategory, 'HTTP');
    assert.equal(result?.failureCode, 'HEALTH_HTTP');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('connector rejection and readback failure retain distinct stages and no sensitive data', async () => {
  for (const scenario of [
    { readback: false, expectedStage: 'CONNECTOR_EXECUTION', expectedCategory: 'AUTHENTICATION' },
    { readback: true, expectedStage: 'READBACK', expectedCategory: 'HTTP' },
  ] as const) {
    const fixture = await auditEnvironment('http://127.0.0.1:1');
    let posts = 0;
    let readbacks = 0;
    try {
      const result = await invokeWordPressArticleDraft({ title: 'private title', contentHtml: '<p>private html</p>' }, {
        environment: fixture.environment,
        fetcher: async (url, init) => {
          if (url.pathname.endsWith('/users/me')) return Response.json({ id: 1 });
          if (init.method === 'POST') {
            posts++;
            return scenario.readback
              ? Response.json({ id: 906, status: 'draft', link: 'https://example.test/?p=906' }, { status: 201 })
              : Response.json({ password: fixture.applicationPassword }, { status: 403 });
          }
          readbacks++;
          return Response.json({ password: fixture.applicationPassword }, { status: 503 });
        },
      });
      assert.equal(result.status, 'FAILED');
      if (result.status === 'FAILED') assert.equal(result.reasonCode,
        scenario.readback ? 'EXECUTION_OUTCOME_AMBIGUOUS' : 'WORDPRESS_UNAUTHORIZED');
      assert.equal(posts, 1);
      assert.equal(readbacks, scenario.readback ? 1 : 0);
      const events = await auditEvents(fixture.auditPath);
      const auditResult = events.at(-1);
      assert.equal(auditResult?.failureStage, scenario.expectedStage);
      assert.equal(auditResult?.failureCategory, scenario.expectedCategory);
      assert.equal(auditResult?.failureCode, `${scenario.expectedStage}_FAILED`);
      const text = JSON.stringify(events);
      for (const value of [fixture.applicationPassword, 'Authorization', 'Basic ', '<p>private html</p>', 'private title']) {
        assert.equal(text.includes(value), false);
      }
    } finally { await rm(fixture.directory, { recursive: true, force: true }); }
  }
});
