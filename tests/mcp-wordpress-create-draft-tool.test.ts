import assert from 'node:assert/strict';
import test from 'node:test';
import {
  callWordPressCreateDraft,
  mapWordPressDraftResult,
  type WordPressDraftInvoker,
} from '../entrypoints/mcp/wordpress-create-draft-tool.ts';
import type { WordPressDraftInvocationResult } from '../entrypoints/wordpress-draft/composition.ts';

const identifiers = {
  requestId: 'request-mcp-unit',
  correlationId: 'correlation-mcp-unit',
  executionId: 'execution-mcp-unit',
} as const;

test('maps a successful invocation to the minimal public WordPress output', () => {
  const result = mapWordPressDraftResult({
    ...identifiers,
    status: 'SUCCEEDED',
    output: { postId: 41, status: 'draft', resourceUrl: 'https://example.test/?p=41' },
  });

  assert.deepEqual(result, {
    content: [{
      type: 'text',
      text: '{"postId":41,"status":"draft","resourceUrl":"https://example.test/?p=41"}',
    }],
    structuredContent: { postId: 41, status: 'draft', resourceUrl: 'https://example.test/?p=41' },
  });
  assert.equal(JSON.stringify(result).includes('request-mcp-unit'), false);
  assert.equal(JSON.stringify(result).includes('execution-mcp-unit'), false);
});

for (const [status, reasonCode, expectedCode] of [
  ['DENIED', undefined, 'AUTHORIZATION_DENIED'],
  ['NOT_READY', undefined, 'EXECUTION_NOT_READY'],
  ['FAILED', 'WORDPRESS_UNAVAILABLE', 'WORDPRESS_UNAVAILABLE'],
  ['FAILED', 'EXECUTION_OUTCOME_AMBIGUOUS', 'EXECUTION_OUTCOME_AMBIGUOUS'],
  ['FAILED', 'UNSAFE_UNKNOWN_CODE', 'MISSION_ENTRYPOINT_FAILED'],
] as const) {
  test(`maps ${status} to the safe MCP error ${expectedCode}`, () => {
    const invocation = {
      ...identifiers,
      status,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    } as WordPressDraftInvocationResult;

    assert.deepEqual(mapWordPressDraftResult(invocation), {
      content: [{ type: 'text', text: expectedCode }],
      structuredContent: { status, code: expectedCode },
      isError: true,
    });
  });
}

test('passes only title and contentHtml to the existing invocation', async () => {
  let received: unknown;
  const invoke: WordPressDraftInvoker = async (input) => {
    received = input;
    return {
      ...identifiers,
      status: 'SUCCEEDED',
      output: { postId: 42, status: 'draft', resourceUrl: 'https://example.test/?p=42' },
    };
  };

  await callWordPressCreateDraft({ title: 'MCP title', contentHtml: '<p>MCP content.</p>' }, invoke);

  assert.deepEqual(received, { title: 'MCP title', contentHtml: '<p>MCP content.</p>' });
});

test('replaces thrown details with a stable safe MCP error', async () => {
  const secret = 'wordpress-unit-secret-not-for-output';
  const result = await callWordPressCreateDraft(
    { title: 'Failure', contentHtml: '<p>Sensitive input.</p>' },
    async () => { throw new Error(`Provider rejected ${secret}`); },
  );

  assert.deepEqual(result, {
    content: [{ type: 'text', text: 'MISSION_ENTRYPOINT_FAILED' }],
    structuredContent: { status: 'FAILED', code: 'MISSION_ENTRYPOINT_FAILED' },
    isError: true,
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes('Sensitive input'), false);
});

test('accepts exact Unicode/UTF-8 boundaries and rejects excess before invocation', async () => {
  let calls = 0;
  const invoke: WordPressDraftInvoker = async () => {
    calls += 1;
    return { ...identifiers, status: 'SUCCEEDED', output: { postId: 43, status: 'draft', resourceUrl: 'https://example.test/?p=43' } };
  };
  const valid = [
    { title: '🟢'.repeat(200), contentHtml: 'a'.repeat(65_536) },
    { title: 'x', contentHtml: 'é'.repeat(32_768) },
  ];
  for (const input of valid) assert.equal((await callWordPressCreateDraft(input, invoke)).isError, undefined);
  assert.equal(calls, 2);
  for (const input of [
    { title: '🟢'.repeat(201), contentHtml: 'valid' },
    { title: 'valid', contentHtml: 'a'.repeat(65_537) },
    { title: 'valid', contentHtml: 'é'.repeat(32_769) },
    { title: ' ', contentHtml: 'valid' },
  ]) {
    const result = await callWordPressCreateDraft(input, invoke);
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes(input.contentHtml), false);
  }
  assert.equal(calls, 2);
});

test('admits only one active call and releases the slot after the first truly finishes', async () => {
  let started = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const invoke: WordPressDraftInvoker = async () => {
    started += 1;
    await held;
    return { ...identifiers, status: 'SUCCEEDED', output: { postId: 44, status: 'draft', resourceUrl: 'https://example.test/?p=44' } };
  };
  const input = { title: 'one', contentHtml: 'two' };
  const first = callWordPressCreateDraft(input, invoke);
  assert.equal(started, 1);
  assert.deepEqual(await callWordPressCreateDraft(input, invoke), {
    content: [{ type: 'text', text: 'EXECUTION_NOT_READY' }],
    structuredContent: { status: 'NOT_READY', code: 'EXECUTION_NOT_READY' }, isError: true,
  });
  assert.equal(started, 1);
  release();
  assert.equal((await first).isError, undefined);
  assert.equal((await callWordPressCreateDraft(input, invoke)).isError, undefined);
  assert.equal(started, 2);
});

test('cancelled call before invocation never reaches the WordPress flow', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const result = await callWordPressCreateDraft({ title: 'one', contentHtml: 'two' }, async () => {
    called = true;
    throw new Error('should not run');
  }, controller.signal);
  assert.equal(result.isError, true);
  assert.equal(called, false);
});
