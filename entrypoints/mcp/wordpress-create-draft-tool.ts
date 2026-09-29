import {
  fromJsonSchema,
  type CallToolResult,
  type McpServer,
} from '@modelcontextprotocol/server';
import {
  invokeWordPressArticleDraft,
  type WordPressDraftInvocationResult,
} from '../wordpress-draft/composition.ts';

export interface WordPressCreateDraftToolInput {
  readonly title: string;
  readonly contentHtml: string;
}

interface WordPressCreateDraftToolOutput {
  readonly postId: number;
  readonly status: 'draft';
  readonly resourceUrl: string;
}

export type WordPressDraftInvoker = (
  input: WordPressCreateDraftToolInput,
  options?: { readonly signal?: AbortSignal },
) => Promise<WordPressDraftInvocationResult>;

let active = false;

const inputSchema = fromJsonSchema<WordPressCreateDraftToolInput>({
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    contentHtml: { type: 'string', minLength: 1, maxLength: 65_536, pattern: '\\S' },
  },
  required: ['title', 'contentHtml'],
});

// The SDK validates before invoking the callback; replace validator details that could echo a caller-supplied key.
const safeInputSchema = {
  '~standard': {
    ...inputSchema['~standard'],
    async validate(data: unknown) {
      const result = await inputSchema['~standard'].validate(data);
      return result.issues ? { issues: [{ message: 'Invalid WordPress draft input' }] } : result;
    },
  },
};

const outputSchema = fromJsonSchema<WordPressCreateDraftToolOutput>({
  type: 'object',
  additionalProperties: false,
  properties: {
    postId: { type: 'integer', minimum: 1 },
    status: { const: 'draft' },
    resourceUrl: { type: 'string', minLength: 1 },
  },
  required: ['postId', 'status', 'resourceUrl'],
});

const safeFailureCodes = new Set([
  'PREPARATION_NOT_READY',
  'PREPARATION_EXPIRED',
  'EXECUTION_REFERENCE_CONFLICT',
  'EXECUTION_HEALTH_CONFLICT',
  'EXECUTION_CONNECTOR_UNAVAILABLE',
  'EXECUTION_ALREADY_ATTEMPTED',
  'WORDPRESS_EXECUTION_NOT_AUTHORIZED',
  'WORDPRESS_NOT_CONNECTED',
  'WORDPRESS_INVALID_REQUEST',
  'WORDPRESS_UNAUTHORIZED',
  'WORDPRESS_UNAVAILABLE',
  'WORDPRESS_TIMEOUT',
  'WORDPRESS_REQUEST_REJECTED',
  'WORDPRESS_INVALID_RESPONSE',
  'WORDPRESS_REQUEST_FAILED',
  'WORDPRESS_VERIFICATION_FAILED',
  'EXECUTION_OUTCOME_AMBIGUOUS',
]);

function errorResult(status: 'DENIED' | 'NOT_READY' | 'FAILED', code: string): CallToolResult {
  return {
    content: [{ type: 'text', text: code }],
    structuredContent: { status, code },
    isError: true,
  };
}

export function mapWordPressDraftResult(result: WordPressDraftInvocationResult): CallToolResult {
  if (result.status === 'SUCCEEDED') {
    const output: WordPressCreateDraftToolOutput = {
      postId: result.output.postId,
      status: 'draft',
      resourceUrl: result.output.resourceUrl,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  }
  if (result.status === 'DENIED') return errorResult('DENIED', 'AUTHORIZATION_DENIED');
  if (result.status === 'NOT_READY') return errorResult('NOT_READY', 'EXECUTION_NOT_READY');
  const code = result.reasonCode && safeFailureCodes.has(result.reasonCode)
    ? result.reasonCode
    : 'MISSION_ENTRYPOINT_FAILED';
  return errorResult('FAILED', code);
}

export async function callWordPressCreateDraft(
  input: WordPressCreateDraftToolInput,
  invoke: WordPressDraftInvoker = invokeWordPressArticleDraft,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  if (active) return errorResult('NOT_READY', 'EXECUTION_NOT_READY');
  if (signal?.aborted) return errorResult('NOT_READY', 'EXECUTION_NOT_READY');
  if (
    [...input.title].length > 200 || [...input.contentHtml].length > 65_536 ||
    Buffer.byteLength(input.contentHtml, 'utf8') > 65_536 ||
    !input.title.trim() || !input.contentHtml.trim()
  ) return errorResult('FAILED', 'WORDPRESS_INVALID_REQUEST');
  active = true;
  try {
    return mapWordPressDraftResult(await invoke(
      { title: input.title, contentHtml: input.contentHtml },
      signal === undefined ? {} : { signal },
    ));
  } catch {
    return errorResult('FAILED', 'MISSION_ENTRYPOINT_FAILED');
  } finally {
    active = false;
  }
}

export function registerWordPressCreateDraftTool(
  server: McpServer,
  invoke: WordPressDraftInvoker = invokeWordPressArticleDraft,
): void {
  server.registerTool(
    'wordpress.create_draft',
    {
      title: 'Create WordPress draft',
      description: 'Creates and verifies a WordPress article draft.',
      inputSchema: safeInputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input, ctx) => callWordPressCreateDraft(input, invoke, ctx.mcpReq.signal),
  );
}
