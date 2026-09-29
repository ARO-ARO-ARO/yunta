import type { HealthCheckProvider } from '../../core/health-integration/ports.ts';
import type {
  HealthCheckProviderRequest,
  HealthCheckProviderResult,
} from '../../core/health-integration/models.ts';
import type {
  WordPressConnectionConfiguration,
  WordPressFetch,
} from '../../connectors/wordpress.connector/connector.ts';
import { networkFailureCategory } from './failure-diagnostic.ts';

function defaultFetch(url: URL, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

function usersMeEndpoint(baseUrl: string): URL {
  return new URL('/wp-json/wp/v2/users/me', baseUrl);
}

export class WordPressHealthProvider implements HealthCheckProvider {
  readonly providerId = 'wordpress.health.v1';
  private readonly configuration: WordPressConnectionConfiguration;
  private readonly fetcher: WordPressFetch;

  constructor(configuration: WordPressConnectionConfiguration, fetcher: WordPressFetch = defaultFetch) {
    this.configuration = configuration;
    this.fetcher = fetcher;
  }

  async check(_request: HealthCheckProviderRequest): Promise<HealthCheckProviderResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.configuration.timeoutMs);
    try {
      const credentials = Buffer.from(
        `${this.configuration.username}:${this.configuration.applicationPassword}`,
      ).toString('base64');
      const response = await this.fetcher(usersMeEndpoint(this.configuration.baseUrl), {
        method: 'GET',
        redirect: 'error',
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      return {
        outcome: 'OBSERVED',
        status:
          response.status === 200
            ? 'HEALTHY'
            : response.status === 401 || response.status === 403
              ? 'UNHEALTHY'
              : 'UNKNOWN',
        observedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        ...(response.status === 200 ? {} : { details: {
          code: response.status === 401 || response.status === 403 ? 'HEALTH_AUTHENTICATION' : 'HEALTH_HTTP',
          retryable: response.status !== 401 && response.status !== 403,
        } }),
      };
    } catch (error) {
      const category = networkFailureCategory(error, controller.signal.aborted);
      return {
        outcome: 'OBSERVED',
        status: 'UNKNOWN',
        observedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        details: {
          code: category === 'TIMEOUT' ? 'HEALTH_TIMEOUT' : category === 'NETWORK' ? 'HEALTH_NETWORK' : 'HEALTH_UNKNOWN',
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
