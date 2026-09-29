import type { Connector } from '../../core/connector-sdk/connector.ts';
import { verifyConnectorAuthorization } from '../../core/permission-engine/evaluator.ts';
import type {
  ConnectorExecutionRequest,
  ConnectorExecutionResult,
  ConnectorStatus,
} from '../../core/types/runtime-types.ts';
import { WordPressConnectorDefinition } from './definition.ts';
import { networkFailureCategory, type FailureCategory } from '../../missions/wordpress-article-draft/failure-diagnostic.ts';

export interface WordPressConnectionConfiguration {
  readonly baseUrl: string;
  readonly username: string;
  readonly applicationPassword: string;
  readonly timeoutMs: number;
}

export interface WordPressArticleDraftInput {
  readonly title: string;
  readonly contentHtml: string;
}

export interface WordPressArticleDraftOutput {
  readonly postId: number;
  readonly status: 'draft';
  readonly resourceUrl: string;
}

export type WordPressFetch = (url: URL, init: RequestInit) => Promise<Response>;

export function isSafeWordPressUrl(value: string): boolean {
  try {
    const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
    if (!authority || authority.includes('@') || value.includes('#')) return false;
    const url = new URL(value);
    const literalLoopback = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i.test(value);
    return (
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && literalLoopback && (url.hostname === '127.0.0.1' || url.hostname === '[::1]'))) &&
      !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}

export function validWordPressDraftFields(input: WordPressArticleDraftInput): boolean {
  return (
    typeof input.title === 'string' && input.title.trim().length > 0 &&
    [...input.title].length <= 200 &&
    typeof input.contentHtml === 'string' && input.contentHtml.trim().length > 0 &&
    [...input.contentHtml].length <= 65_536 &&
    Buffer.byteLength(input.contentHtml, 'utf8') <= 65_536
  );
}

function defaultFetch(url: URL, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

function fail(code: string): ConnectorExecutionResult {
  return { status: 'FAILED', errors: [code] };
}

function isDraftInput(value: unknown): value is WordPressArticleDraftInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 2 &&
    validWordPressDraftFields(candidate as unknown as WordPressArticleDraftInput)
  );
}

function postEndpoint(baseUrl: string): URL {
  return new URL('/wp-json/wp/v2/posts', baseUrl);
}

function postVerificationEndpoint(baseUrl: string, postId: number): URL {
  return new URL(`/wp-json/wp/v2/posts/${postId}`, baseUrl);
}

function configurationIsSafe(configuration: WordPressConnectionConfiguration): boolean {
  try {
    return (
      isSafeWordPressUrl(configuration.baseUrl) &&
      configuration.username.trim().length > 0 &&
      configuration.applicationPassword.trim().length > 0 &&
      Number.isInteger(configuration.timeoutMs) &&
      configuration.timeoutMs > 0
    );
  } catch {
    return false;
  }
}

export function wordpressConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = 10_000,
): WordPressConnectionConfiguration {
  const baseUrl = environment.WORDPRESS_BASE_URL;
  const username = environment.WORDPRESS_USERNAME;
  const applicationPassword = environment.WORDPRESS_APPLICATION_PASSWORD;
  if (!baseUrl?.trim() || !username?.trim() || !applicationPassword?.trim()) {
    throw new Error('WordPress environment configuration is unavailable');
  }
  const configuration = { baseUrl, username, applicationPassword, timeoutMs };
  if (!configurationIsSafe(configuration)) {
    throw new Error('WordPress environment configuration is invalid');
  }
  return configuration;
}

export class WordPressConnector implements Connector {
  private readonly configuration: WordPressConnectionConfiguration;
  private readonly fetcher: WordPressFetch;
  private readonly signal: AbortSignal | undefined;
  private readonly onPostDispatch: (() => void) | undefined;
  private readonly onReadback: (() => void) | undefined;
  private readonly onFailure: ((category: FailureCategory) => void) | undefined;
  private connected = false;

  constructor(
    configuration: WordPressConnectionConfiguration,
    fetcher: WordPressFetch = defaultFetch,
    options: {
      readonly signal?: AbortSignal;
      readonly onPostDispatch?: () => void;
      readonly onReadback?: () => void;
      readonly onFailure?: (category: FailureCategory) => void;
    } = {},
  ) {
    if (!configurationIsSafe(configuration)) throw new Error('WordPress connector configuration is invalid');
    this.configuration = configuration;
    this.fetcher = fetcher;
    this.signal = options.signal;
    this.onPostDispatch = options.onPostDispatch;
    this.onReadback = options.onReadback;
    this.onFailure = options.onFailure;
  }

  id(): string {
    return WordPressConnectorDefinition.id;
  }

  version(): string {
    return WordPressConnectorDefinition.version;
  }

  capabilities() {
    return structuredClone(WordPressConnectorDefinition.capabilities);
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async healthCheck(): Promise<ConnectorStatus> {
    return 'ACTIVE';
  }

  async execute(request: ConnectorExecutionRequest): Promise<ConnectorExecutionResult> {
    if (
      !verifyConnectorAuthorization(request.authorization) ||
      request.authorization.decision !== 'ALLOW' ||
      request.authorization.connector.id !== this.id() ||
      request.authorization.connector.version !== this.version() ||
      request.authorization.capability !== 'content.create' ||
      request.authorization.executionId !== request.context.executionId
    ) {
      return fail('WORDPRESS_EXECUTION_NOT_AUTHORIZED');
    }
    if (!this.connected) return fail('WORDPRESS_NOT_CONNECTED');
    if (
      request.connector.id !== this.id() ||
      request.connector.version !== this.version() ||
      request.capability !== 'content.create' ||
      request.context.connectorId !== this.id() ||
      request.context.capability !== request.capability ||
      !request.context.executionId.trim() ||
      Number.isNaN(Date.parse(request.context.timestamp)) ||
      !isDraftInput(request.input)
    ) {
      return fail('WORDPRESS_INVALID_REQUEST');
    }
    if (this.signal?.aborted) return fail('PREPARATION_NOT_READY');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.configuration.timeoutMs);
    try {
      const credentials = Buffer.from(
        `${this.configuration.username}:${this.configuration.applicationPassword}`,
      ).toString('base64');
      if (this.signal?.aborted) return fail('PREPARATION_NOT_READY');
      this.onPostDispatch?.();
      const response = await this.fetcher(postEndpoint(this.configuration.baseUrl), {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          title: request.input.title,
          content: request.input.contentHtml,
          status: 'draft',
        }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) return this.failure('WORDPRESS_UNAUTHORIZED', 'AUTHENTICATION');
      if (response.status >= 500) return this.failure('EXECUTION_OUTCOME_AMBIGUOUS', 'HTTP');
      if (response.status !== 201) return this.failure('WORDPRESS_REQUEST_REJECTED', 'HTTP');
      const body: unknown = await response.json().catch(() => undefined);
      if (body === undefined) return this.failure('EXECUTION_OUTCOME_AMBIGUOUS', 'VALIDATION');
      if (!this.isDraftResponse(body)) return this.failure('EXECUTION_OUTCOME_AMBIGUOUS', 'VALIDATION');
      this.onReadback?.();
      const verification = await this.fetcher(postVerificationEndpoint(this.configuration.baseUrl, body.id), {
        method: 'GET',
        redirect: 'error',
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (verification.status !== 200) return this.failure('EXECUTION_OUTCOME_AMBIGUOUS', 'HTTP');
      const verifiedBody: unknown = await verification.json().catch(() => undefined);
      if (!this.isVerifiedDraft(verifiedBody, body.id)) return this.failure('EXECUTION_OUTCOME_AMBIGUOUS', 'VALIDATION');
      if (!this.safeResourceUrl(body.link)) return this.failure('EXECUTION_OUTCOME_AMBIGUOUS', 'VALIDATION');
      return {
        status: 'SUCCEEDED',
        output: {
          postId: body.id,
          status: 'draft',
          resourceUrl: body.link,
        } satisfies WordPressArticleDraftOutput,
        errors: [],
      };
    } catch (error) {
      // A request error after dispatching the POST cannot prove whether WordPress created the draft.
      return this.failure('EXECUTION_OUTCOME_AMBIGUOUS', networkFailureCategory(error, controller.signal.aborted));
    } finally {
      clearTimeout(timeout);
    }
  }

  private failure(code: string, category: FailureCategory): ConnectorExecutionResult {
    this.onFailure?.(category);
    return fail(code);
  }

  private isDraftResponse(value: unknown): value is { id: number; status: 'draft'; link: string } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return (
      Number.isInteger(candidate.id) &&
      (candidate.id as number) > 0 &&
      candidate.status === 'draft' &&
      typeof candidate.link === 'string' &&
      candidate.link.trim().length > 0
    );
  }

  private isVerifiedDraft(value: unknown, postId: number): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return candidate.id === postId && candidate.status === 'draft';
  }

  private safeResourceUrl(value: string): boolean {
    if (!isSafeWordPressUrl(value)) return false;
    try {
      const decoded = decodeURIComponent(value);
      return ![value, decoded].some((candidate) =>
        candidate.includes(this.configuration.applicationPassword) ||
        candidate.includes(`${this.configuration.username}:${this.configuration.applicationPassword}`));
    } catch {
      return false;
    }
  }
}
