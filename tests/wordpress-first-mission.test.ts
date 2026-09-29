import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { WordPressConnector, wordpressConfigurationFromEnvironment, type WordPressConnectionConfiguration } from '../connectors/wordpress.connector/connector.ts';
import { WordPressConnectorDefinition } from '../connectors/wordpress.connector/definition.ts';
import { ConnectorRegistry } from '../core/connector-registry/registry.ts';
import { InMemoryConnectorRepository } from '../core/contracts-foundation/in-memory.ts';
import type { ConnectorRecord, ManagedConnector } from '../core/contracts-foundation/domain.ts';
import { AuthorizationEvaluator } from '../core/execution-preparation/authorization-evaluator.ts';
import { CredentialReadinessChecker } from '../core/execution-preparation/credential-readiness-checker.ts';
import { ExecutionPreparationService } from '../core/execution-preparation/execution-preparation-service.ts';
import { StaticExecutionPreparationPolicy } from '../core/execution-preparation/policies.ts';
import { PreparationAudit } from '../core/execution-preparation/preparation-audit.ts';
import type { ExecutionPreparationResult, PreparationHealthSnapshot, StructuralReadinessSnapshot } from '../core/execution-preparation/models.ts';
import { InMemoryHealthRepository as B3HealthRepository } from '../core/health-integration/in-memory-health-repository.ts';
import { HealthService } from '../core/health-integration/health-service.ts';
import { InMemoryHealthEventPublisher } from '../core/health-integration/events.ts';
import { DefaultManagedCandidateCatalog } from '../core/managed-resolver/candidate-catalog.ts';
import { ManagedResolver } from '../core/managed-resolver/managed-resolver.ts';
import { StaticResolverPolicy } from '../core/managed-resolver/resolver-policy.ts';
import { PermissionEvaluator } from '../core/permission-engine/evaluator.ts';
import { RuntimeAssembler } from '../core/runtime-assembly/runtime-assembler.ts';
import { RuntimeAssemblyPolicy } from '../core/runtime-assembly/runtime-assembly-policy.ts';
import type { RuntimeCompatibilityProfile } from '../core/runtime-assembly/models.ts';
import { RuntimeValidator } from '../core/runtime-assembly/runtime-validator.ts';
import { SkillEngine } from '../core/skill-engine/engine.ts';
import { SkillRegistry } from '../core/skill-registry/registry.ts';
import { SkillResolver } from '../core/skill-resolver/resolver.ts';
import type { ConnectorExecutionRequest, ConnectorContext } from '../core/types/runtime-types.ts';
import { ArticleSkill } from '../skills/content.article.create/skill.ts';
import { InMemoryWordPressMissionAudit } from '../missions/wordpress-article-draft/audit.ts';
import {
  B3ManagedHealthAdapter,
  B3PreparationHealthAdapter,
  ManagedConnectorListAdapter,
  RuntimeAssemblyPreparationStructuralAdapter,
  RuntimeAssemblyManagedStructuralAdapter,
  WordPressCredentialReadinessAdapter,
  registerWordPressConnector,
} from '../missions/wordpress-article-draft/adapters.ts';
import { WordPressArticleExecution } from '../missions/wordpress-article-draft/execution.ts';
import { WordPressArticleDraftMission } from '../missions/wordpress-article-draft/mission.ts';
import { WordPressHealthProvider } from '../missions/wordpress-article-draft/wordpress-health-provider.ts';

interface TestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

const username = `wordpress-test-user-${randomUUID()}`;
const applicationPassword = randomUUID();

function configuration(baseUrl: string, timeoutMs = 100): WordPressConnectionConfiguration {
  return { baseUrl, username, applicationPassword, timeoutMs };
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

async function connectorRequest(
  connector: WordPressConnector,
  registry: ConnectorRegistry,
  input: unknown = { title: 'Cómo elegir una cámara', contentHtml: '<p>Contenido para principiantes.</p>' },
): Promise<ConnectorExecutionRequest> {
  const evaluator = new PermissionEvaluator(registry);
  const context: ConnectorContext = {
    executionId: 'wordpress-execution-1',
    connectorId: connector.id(),
    capability: 'content.create',
    metadata: {},
    timestamp: new Date().toISOString(),
  };
  return {
    connector: { id: connector.id(), version: connector.version() },
    capability: 'content.create',
    input,
    context,
    authorization: evaluator.authorizeConnector({
      actor: { id: 'wordpress-editor', permissions: ['content.write', 'connector.execute'], status: 'ACTIVE' },
      skill: ArticleSkill,
      capability: 'content.create',
      connector: WordPressConnectorDefinition,
      context,
    }),
  };
}

async function executableConnector(baseUrl: string, timeoutMs?: number): Promise<{
  readonly connector: WordPressConnector;
  readonly registry: ConnectorRegistry;
}> {
  const connector = new WordPressConnector(configuration(baseUrl, timeoutMs));
  const registry = new ConnectorRegistry();
  registerWordPressConnector(registry, connector);
  await connector.connect();
  return { connector, registry };
}

test('defines wordpress.connector@1.0 with only content.create', () => {
  assert.equal(WordPressConnectorDefinition.id, 'wordpress.connector');
  assert.equal(WordPressConnectorDefinition.version, '1.0');
  assert.deepEqual(WordPressConnectorDefinition.capabilities.map((capability) => capability.id), ['content.create']);
  assert.equal(WordPressConnectorDefinition.capabilities[0]?.riskLevel, 'LOW');
});

test('accepts HTTPS and literal HTTP loopback, but rejects unsafe target URLs', () => {
  for (const baseUrl of ['https://wordpress.example.test', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
    assert.equal(wordpressConfigurationFromEnvironment({
      WORDPRESS_BASE_URL: baseUrl, WORDPRESS_USERNAME: username, WORDPRESS_APPLICATION_PASSWORD: applicationPassword,
    }).baseUrl, baseUrl);
  }
  for (const baseUrl of [
    'http://wordpress.example.test', 'http://localhost:8080', 'http://127.0.0.2', 'http://127.1', 'http://[0:0:0:0:0:0:0:1]',
    'https://user:password@wordpress.example.test', 'https://@wordpress.example.test',
    'https://wordpress.example.test/#fragment', 'https://wordpress.example.test/#',
  ]) {
    assert.throws(() => wordpressConfigurationFromEnvironment({
      WORDPRESS_BASE_URL: baseUrl, WORDPRESS_USERNAME: username, WORDPRESS_APPLICATION_PASSWORD: applicationPassword,
    }), /WordPress environment configuration is invalid/);
  }
});

test('rejects out-of-range WordPress draft fields before POST', async () => {
  let posts = 0;
  const wordpress = await server((_request, response) => {
    posts += 1;
    writeJson(response, 500, {});
  });
  try {
    const { connector, registry } = await executableConnector(wordpress.baseUrl);
    for (const input of [
      { title: 'a'.repeat(201), contentHtml: 'body' },
      { title: 'title', contentHtml: 'a'.repeat(65_537) },
      { title: 'title', contentHtml: 'é'.repeat(32_769) },
      { title: ' ', contentHtml: 'body' },
    ]) {
      assert.deepEqual(await connector.execute(await connectorRequest(connector, registry, input)), {
        status: 'FAILED', errors: ['WORDPRESS_INVALID_REQUEST'],
      });
    }
    assert.equal(posts, 0);
  } finally {
    await wordpress.close();
  }
});

test('does not follow authenticated redirects on health, POST, or verification GET', async () => {
  for (const stage of ['health', 'post', 'verification'] as const) {
    let redirected = 0;
    let posts = 0;
    const wordpress = await server((request, response) => {
      if (request.url === '/elsewhere') {
        redirected += 1;
        return writeJson(response, 200, {});
      }
      if (request.url === '/wp-json/wp/v2/users/me') {
        if (stage === 'health') { response.writeHead(302, { Location: '/elsewhere' }); return response.end(); }
        return writeJson(response, 200, { id: 1 });
      }
      if (request.url === '/wp-json/wp/v2/posts') {
        posts += 1;
        if (stage === 'post') { response.writeHead(302, { Location: '/elsewhere' }); return response.end(); }
        return writeJson(response, 201, { id: 24, status: 'draft', link: 'https://example.test/?p=24' });
      }
      if (stage === 'verification') { response.writeHead(302, { Location: '/elsewhere' }); return response.end(); }
      writeJson(response, 404, {});
    });
    try {
      if (stage === 'health') {
        const result = await new WordPressHealthProvider(configuration(wordpress.baseUrl)).check({
          checkId: 'redirect-health', connectorInstanceId: 'wordpress-managed-1',
          definitionRef: { id: 'wordpress.connector', version: '1.0' },
          probeType: 'ON_DEMAND', requestedAt: new Date().toISOString(), correlationId: 'redirect-health',
        });
        assert.equal(result.outcome, 'OBSERVED');
        if (result.outcome === 'OBSERVED') assert.equal(result.status, 'UNKNOWN');
      } else {
        const { connector, registry } = await executableConnector(wordpress.baseUrl);
        assert.deepEqual(await connector.execute(await connectorRequest(connector, registry)), {
          status: 'FAILED', errors: ['EXECUTION_OUTCOME_AMBIGUOUS'],
        });
      }
      assert.equal(posts, stage === 'health' ? 0 : 1);
      assert.equal(redirected, 0);
    } finally {
      await wordpress.close();
    }
  }
});

test('treats nonconfirming verification and unsafe resource URLs as ambiguous', async () => {
  for (const [verification, link] of [
    [{ id: 42, status: 'publish' }, 'https://example.test/?p=42'],
    [{ id: 42, status: 'draft' }, 'http://external.example.test/?p=42'],
    [{ id: 42, status: 'draft' }, 'https://user:password@example.test/?p=42'],
    [{ id: 42, status: 'draft' }, 'not-a-url'],
    [{ id: 42, status: 'draft' }, `https://example.test/?password=${applicationPassword}`],
  ] as const) {
    let posts = 0;
    const wordpress = await server((request, response) => {
      if (request.url === '/wp-json/wp/v2/posts') {
        posts += 1;
        return writeJson(response, 201, { id: 42, status: 'draft', link });
      }
      writeJson(response, 200, verification);
    });
    try {
      const { connector, registry } = await executableConnector(wordpress.baseUrl);
      const result = await connector.execute(await connectorRequest(connector, registry));
      assert.deepEqual(result, { status: 'FAILED', errors: ['EXECUTION_OUTCOME_AMBIGUOUS'] });
      assert.equal(JSON.stringify(result).includes(link), false);
      assert.equal(posts, 1);
    } finally {
      await wordpress.close();
    }
  }
});

test('creates a WordPress content draft with an exact POST payload', async () => {
  let received: { method?: string; path?: string; authorization?: string; body?: unknown } = {};
  const wordpress = await server((request, response) => {
    if (request.method === 'GET' && request.url === '/wp-json/wp/v2/posts/42') {
      writeJson(response, 200, { id: 42, status: 'draft' });
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      received = {
        ...(request.method === undefined ? {} : { method: request.method }),
        ...(request.url === undefined ? {} : { path: request.url }),
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
        body: JSON.parse(body),
      };
      writeJson(response, 201, { id: 42, status: 'draft', link: 'https://example.test/?p=42' });
    });
  });
  try {
    const { connector, registry } = await executableConnector(wordpress.baseUrl);
    const result = await connector.execute(await connectorRequest(connector, registry));

    assert.deepEqual(result, {
      status: 'SUCCEEDED',
      output: { postId: 42, status: 'draft', resourceUrl: 'https://example.test/?p=42' },
      errors: [],
    });
    assert.equal(received.method, 'POST');
    assert.equal(received.path, '/wp-json/wp/v2/posts');
    assert.deepEqual(received.body, {
      title: 'Cómo elegir una cámara',
      content: '<p>Contenido para principiantes.</p>',
      status: 'draft',
    });
    assert.match(received.authorization ?? '', /^Basic /);
    assert.equal(JSON.stringify(result).includes(applicationPassword), false);
    assert.equal(JSON.stringify(result).includes(received.authorization ?? ''), false);
  } finally {
    await wordpress.close();
  }
});

test('rejects caller input that attempts to control post status', async () => {
  const wordpress = await server((_request, response) => writeJson(response, 500, {}));
  try {
    const { connector, registry } = await executableConnector(wordpress.baseUrl);
    const result = await connector.execute(await connectorRequest(connector, registry, {
      title: 'Cómo elegir una cámara',
      contentHtml: '<p>Contenido.</p>',
      status: 'publish',
    }));

    assert.deepEqual(result, { status: 'FAILED', errors: ['WORDPRESS_INVALID_REQUEST'] });
  } finally {
    await wordpress.close();
  }
});

for (const [status, error] of [
  [401, 'WORDPRESS_UNAUTHORIZED'],
  [403, 'WORDPRESS_UNAUTHORIZED'],
  [500, 'EXECUTION_OUTCOME_AMBIGUOUS'],
] as const) {
  test(`normalizes WordPress HTTP ${status}`, async () => {
    const wordpress = await server((_request, response) => writeJson(response, status, { unsafe: applicationPassword }));
    try {
      const { connector, registry } = await executableConnector(wordpress.baseUrl);
      const result = await connector.execute(await connectorRequest(connector, registry));

      assert.deepEqual(result, { status: 'FAILED', errors: [error] });
      assert.equal(JSON.stringify(result).includes(applicationPassword), false);
    } finally {
      await wordpress.close();
    }
  });
}

test('normalizes a timeout without exposing request configuration', async () => {
  const connector = new WordPressConnector(
    configuration('https://wordpress-timeout.test', 5),
    async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  );
  const registry = new ConnectorRegistry();
  registry.register(WordPressConnectorDefinition, connector);
  await connector.connect();

  const result = await connector.execute(await connectorRequest(connector, registry));

  assert.deepEqual(result, { status: 'FAILED', errors: ['EXECUTION_OUTCOME_AMBIGUOUS'] });
  assert.equal(JSON.stringify(result).includes(applicationPassword), false);
});

test('normalizes a malformed 201 response', async () => {
  const wordpress = await server((_request, response) => writeJson(response, 201, { id: 'invalid', status: 'publish' }));
  try {
    const { connector, registry } = await executableConnector(wordpress.baseUrl);
    const result = await connector.execute(await connectorRequest(connector, registry));

    assert.deepEqual(result, { status: 'FAILED', errors: ['EXECUTION_OUTCOME_AMBIGUOUS'] });
  } finally {
    await wordpress.close();
  }
});

for (const [status, expected] of [
  [200, 'HEALTHY'],
  [401, 'UNHEALTHY'],
  [403, 'UNHEALTHY'],
  [500, 'UNKNOWN'],
] as const) {
  test(`maps WordPress health HTTP ${status} to ${expected}`, async () => {
    let path = '';
    const wordpress = await server((request, response) => {
      path = request.url ?? '';
      writeJson(response, status, { unsafe: applicationPassword });
    });
    try {
      const provider = new WordPressHealthProvider(configuration(wordpress.baseUrl));
      const result = await provider.check({
        checkId: 'health-check-1',
        connectorInstanceId: 'wordpress-managed-1',
        definitionRef: { id: 'wordpress.connector', version: '1.0' },
        probeType: 'ON_DEMAND',
        requestedAt: new Date().toISOString(),
        correlationId: 'health-correlation-1',
      });

      assert.equal(result.outcome, 'OBSERVED');
      if (result.outcome === 'OBSERVED') assert.equal(result.status, expected);
      assert.equal(path, '/wp-json/wp/v2/users/me');
      assert.equal(JSON.stringify(result).includes(applicationPassword), false);
    } finally {
      await wordpress.close();
    }
  });
}

test('maps health timeout to UNKNOWN', async () => {
  const provider = new WordPressHealthProvider(
    configuration('https://wordpress-timeout.test', 5),
    async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  );

  const result = await provider.check({
    checkId: 'health-check-1',
    connectorInstanceId: 'wordpress-managed-1',
    definitionRef: { id: 'wordpress.connector', version: '1.0' },
    probeType: 'ON_DEMAND',
    requestedAt: new Date().toISOString(),
    correlationId: 'health-correlation-1',
  });

  assert.equal(result.outcome, 'OBSERVED');
  if (result.outcome === 'OBSERVED') assert.equal(result.status, 'UNKNOWN');
});

test('projects B2 runtime data without secret-bearing credential fields', async () => {
  const adapter = new RuntimeAssemblyPreparationStructuralAdapter({
    assemble: async () => ({
      instanceId: 'wordpress-managed-1',
      definition: {
        id: 'wordpress.connector', version: '1.0', name: 'WordPress', description: 'Drafts', type: 'WORDPRESS', status: 'ACTIVE',
        capabilities: [{ id: 'content.create', description: 'Draft', inputSchema: {}, outputSchema: {}, riskLevel: 'LOW' }],
      },
      managedConnector: { definitionRef: { id: 'wordpress.connector', version: '1.0' }, schemaVersion: 1, revision: 1, securityRevision: 1, createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z' },
      lifecycle: { state: 'CONNECTED', readiness: 'STRUCTURALLY_READY' },
      compatibility: { connectorApiVersion: '1', minimumRuntimeVersion: '1', capabilitySchemaVersion: '1', definitionSchemaVersion: '1' },
      permissions: ['connector.execute'],
      credentials: { requirement: 'OPTIONAL', references: [], availability: 'NOT_VERIFIED' },
      operationalMetadata: { assembledAt: '2026-09-26T00:00:00.000Z', connectorRecordSchemaVersion: 1, connectorRecordRevision: 1, definitionChecksum: 'checksum-1', healthValidation: 'NOT_PERFORMED', credentialAvailability: 'NOT_VERIFIED', consistencyCheck: 'VERIFIED_BY_REREAD' },
    }),
  });

  const result = await adapter.inspect('wordpress-managed-1');

  assert.equal(result?.instanceId, 'wordpress-managed-1');
  assert.equal(JSON.stringify(result).includes('secretRef'), false);
  assert.equal('runtime' in (result ?? {}), false);
});

test('stores allowlisted mission audit events without secrets', async () => {
  const audit = new InMemoryWordPressMissionAudit();
  const requested = await audit.recordRequested({
    eventType: 'ExecutionPreparationRequested', requestId: 'request-1', correlationId: 'correlation-1', executionId: 'execution-1', actorId: 'actor-1', capability: 'content.create', operation: 'EXECUTE_CONNECTOR',
    reference: { instanceId: 'wordpress-managed-1', definitionRef: { id: 'wordpress.connector', version: '1.0' }, expectedRevision: 1, expectedSecurityRevision: 1 }, occurredAt: new Date().toISOString(),
  });
  await audit.recordExecution({
    eventType: 'ArticleDraftCreated', eventId: 'execution-event-1', executionId: 'execution-1', correlationId: 'correlation-1', connectorInstanceId: 'wordpress-managed-1', connectorRef: { id: 'wordpress.connector', version: '1.0' }, preparationOutcomeEventId: requested.eventId, postId: 42, status: 'draft', timestamp: new Date().toISOString(),
  });

  const serialized = JSON.stringify([audit.listPreparation(), audit.listExecution()]);
  assert.equal(serialized.includes(applicationPassword), false);
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes('contentHtml'), false);
});

const missionTime = '2026-09-26T12:00:10.000Z';
const runtimeCompatibility: RuntimeCompatibilityProfile = {
  runtimeProtocolVersion: '1.4.1',
  connectorApiVersion: '1',
  capabilitySchemaVersion: '1',
  definitionSchemaVersion: '1',
  connectorRecordSchemaVersion: 1,
  managedConnectorSchemaVersion: 1,
};

class MissionClock {
  now(): string {
    return missionTime;
  }
}

class MissionIds {
  private index = 0;

  next(): string {
    this.index += 1;
    return `mission-health-${this.index}`;
  }
}

function wordpressRecord(): ConnectorRecord {
  return {
    schemaVersion: 1,
    recordRevision: 1,
    definition: structuredClone(WordPressConnectorDefinition),
    compatibility: {
      connectorApiVersion: '1',
      minimumRuntimeVersion: '1.0',
      capabilitySchemaVersion: '1',
      definitionSchemaVersion: '1',
    },
    createdAt: missionTime,
    updatedAt: missionTime,
    checksum: 'wordpress-connector-checksum-1',
  };
}

function wordpressManagedConnector(): ManagedConnector {
  return {
    instanceId: 'wordpress-managed-1',
    definitionRef: { id: 'wordpress.connector', version: '1.0' },
    lifecycleState: 'CONNECTED',
    credentialRefs: [{
      credentialId: 'wordpress-credential-1',
      providerId: 'wordpress.application-password',
      secretRef: 'env://WORDPRESS_APPLICATION_PASSWORD',
      revision: 1,
    }],
    securityRevision: 1,
    revision: 1,
    schemaVersion: 1,
    createdAt: missionTime,
    updatedAt: missionTime,
    metadata: {},
  };
}

function authorizationIssuer(registry: ConnectorRegistry) {
  const evaluator = new PermissionEvaluator(registry);
  const actor = { id: 'pipo-1', permissions: ['content.write', 'connector.execute'], status: 'ACTIVE' } as const;
  return {
    issue(input: { readonly executionId: string; readonly capability: string; readonly connector: { readonly id: string; readonly version: string } }) {
      const context: ConnectorContext = {
        executionId: input.executionId,
        connectorId: input.connector.id,
        capability: input.capability,
        metadata: {},
        timestamp: missionTime,
      };
      return evaluator.authorizeConnector({
        actor,
        skill: ArticleSkill,
        capability: input.capability,
        connector: WordPressConnectorDefinition,
        context,
      });
    },
    context(input: { readonly executionId: string; readonly capability: string; readonly connectorId: string }): ConnectorContext {
      return {
        executionId: input.executionId,
        connectorId: input.connectorId,
        capability: input.capability,
        metadata: {},
        timestamp: missionTime,
      };
    },
  };
}

async function fullMissionFixture(baseUrl: string): Promise<{
  readonly mission: WordPressArticleDraftMission;
  readonly audit: InMemoryWordPressMissionAudit;
  readonly registry: ConnectorRegistry;
}> {
  const repository = new InMemoryConnectorRepository();
  await repository.saveDefinition(wordpressRecord());
  await repository.saveManagedConnector(wordpressManagedConnector());
  const runtime = new RuntimeAssembler(
    repository,
    new RuntimeValidator(),
    new RuntimeAssemblyPolicy(),
    runtimeCompatibility,
    new MissionClock(),
  );
  const healthRepository = new B3HealthRepository();
  const provider = new WordPressHealthProvider(configuration(baseUrl));
  const health = new HealthService(
    repository,
    provider,
    healthRepository,
    new InMemoryHealthEventPublisher(),
    undefined,
    new MissionClock(),
    new MissionIds(),
  );
  await health.observe({
    checkId: 'wordpress-health-1',
    idempotencyKey: 'wordpress-health-key-1',
    connectorInstanceId: 'wordpress-managed-1',
    probeType: 'ON_DEMAND',
    correlationId: 'wordpress-health-correlation-1',
  });
  const managedResolver = new ManagedResolver(
    new DefaultManagedCandidateCatalog(
      new ManagedConnectorListAdapter(repository),
      new RuntimeAssemblyManagedStructuralAdapter(runtime),
      new B3ManagedHealthAdapter(healthRepository),
    ),
    new StaticResolverPolicy({
      policyId: 'wordpress-managed-policy', revision: 1, minimumHealth: 'DEGRADED',
      maxHealthAgeMs: 60_000, maximumFutureSkewMs: 1_000, instancePriorities: {},
      tieStrategy: 'STABLE_INSTANCE_ID', maxConsistencyRetries: 0,
    }),
    undefined,
    new MissionClock(),
  );
  const audit = new InMemoryWordPressMissionAudit();
  const structural = new RuntimeAssemblyPreparationStructuralAdapter(runtime);
  const preparation = new ExecutionPreparationService(
    structural,
    new B3PreparationHealthAdapter(healthRepository),
    new AuthorizationEvaluator(
      {
        read: async (input) => ({
          actorActive: input.actorId === 'pipo-1',
          actorPermissions: ['content.write', 'connector.execute'],
          skillActive: input.skillRef.id === ArticleSkill.id && input.skillRef.version === ArticleSkill.version,
          skillCapability: ArticleSkill.capability,
          skillPermissions: ArticleSkill.permissions,
          explicitDeny: false,
          approvalGranted: false,
          evaluatedAt: missionTime,
        }),
      },
      new StaticExecutionPreparationPolicy({
        policyId: 'wordpress-preparation-policy', revision: 1, maxHealthAgeMs: 60_000,
        maximumFutureSkewMs: 1_000, maxPreparationTtlMs: 30_000, maxAuthorizationAgeMs: 30_000,
      }),
    ),
    new CredentialReadinessChecker(
      new WordPressCredentialReadinessAdapter(
        { connectorInstanceId: 'wordpress-managed-1', credentialId: 'wordpress-credential-1', providerId: 'wordpress.application-password', revision: 1, purpose: 'EXECUTE_CONNECTOR' },
        { isConfigured: () => true },
      ),
    ),
    new PreparationAudit(audit),
    new StaticExecutionPreparationPolicy({
      policyId: 'wordpress-preparation-policy', revision: 1, maxHealthAgeMs: 60_000,
      maximumFutureSkewMs: 1_000, maxPreparationTtlMs: 30_000, maxAuthorizationAgeMs: 30_000,
    }),
    undefined,
    new MissionClock(),
  );
  const registry = new ConnectorRegistry();
  const connector = new WordPressConnector(configuration(baseUrl));
  registerWordPressConnector(registry, connector);
  const skillRegistry = new SkillRegistry();
  skillRegistry.register(ArticleSkill);
  const executionFactory = {
    create: (resolution: import('../core/managed-resolver/models.ts').ManagedResolution) => new WordPressArticleExecution(
      registry,
      structural,
      new B3PreparationHealthAdapter(healthRepository),
      resolution,
      authorizationIssuer(registry),
      audit,
      new MissionClock(),
    ),
  };
  return {
    mission: new WordPressArticleDraftMission(
      new SkillEngine(new SkillResolver(skillRegistry)),
      managedResolver,
      runtime,
      preparation,
      executionFactory,
    ),
    audit,
    registry,
  };
}

test('runs the complete B4-B5 WordPress draft mission once against a local server', async () => {
  let postCount = 0;
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
        assert.deepEqual(JSON.parse(body), {
          title: 'Cómo elegir una cámara',
          content: '<p>Texto para principiantes.</p>',
          status: 'draft',
        });
        writeJson(response, 201, { id: 77, status: 'draft', link: 'https://example.test/?p=77' });
      });
      return;
    }
    if (request.url === '/wp-json/wp/v2/posts/77') {
      writeJson(response, 200, { id: 77, status: 'draft' });
      return;
    }
    writeJson(response, 404, {});
  });
  try {
    const fixture = await fullMissionFixture(wordpress.baseUrl);
    const result = await fixture.mission.run({
      actorId: 'pipo-1', correlationId: 'wordpress-mission-correlation-1',
      title: 'Cómo elegir una cámara', contentHtml: '<p>Texto para principiantes.</p>',
    });

    assert.equal(result.status, 'SUCCEEDED');
    if (result.status !== 'SUCCEEDED') assert.fail('Mission should succeed');
    assert.equal(result.preparation.status, 'READY');
    assert.equal(result.preparation.referenceAssessment.reference.definitionRef.id, 'wordpress.connector');
    assert.equal(result.output.postId, 77);
    assert.equal(result.output.status, 'draft');
    assert.equal(postCount, 1);
    assert.equal(Object.isFrozen(result), true);
    const audit = JSON.stringify([fixture.audit.listPreparation(), fixture.audit.listExecution()]);
    assert.equal(audit.includes(applicationPassword), false);
    assert.equal(audit.includes('Authorization'), false);
    assert.equal(audit.includes('contentHtml'), false);
  } finally {
    await wordpress.close();
  }
});

function readyArtifacts(overrides: {
  readonly status?: ExecutionPreparationResult['status'];
  readonly expiresAt?: string;
  readonly revision?: number;
  readonly securityRevision?: number;
  readonly health?: Partial<PreparationHealthSnapshot>;
} = {}): {
  readonly preparation: ExecutionPreparationResult;
  readonly resolution: import('../core/managed-resolver/models.ts').ManagedResolution;
  readonly structural: StructuralReadinessSnapshot;
  readonly health: PreparationHealthSnapshot;
} {
  const revision = overrides.revision ?? 1;
  const securityRevision = overrides.securityRevision ?? 1;
  const health: PreparationHealthSnapshot = {
    observationId: 'health-execution-1', sequence: 1, status: 'HEALTHY', recordedAt: missionTime,
    definitionRef: { id: 'wordpress.connector', version: '1.0' }, ...overrides.health,
  };
  const resolution = {
    requestId: 'execution-1', capability: 'content.create',
    selected: { instanceId: 'wordpress-managed-1', definitionRef: { id: 'wordpress.connector', version: '1.0' }, expectedRevision: revision, expectedSecurityRevision: securityRevision },
    healthEvidence: { observationId: health.observationId, sequence: health.sequence, status: health.status === 'DEGRADED' ? 'DEGRADED' : 'HEALTHY', recordedAt: health.recordedAt },
    policy: { policyId: 'wordpress-policy', revision: 1 }, resolvedAt: missionTime, validUntil: '2026-09-26T12:01:00.000Z',
  } as const;
  const preparation: ExecutionPreparationResult = {
    requestId: 'prepare-execution-1', correlationId: 'execution-correlation-1', executionId: 'execution-1', status: overrides.status ?? 'READY', capability: 'content.create', operation: 'EXECUTE_CONNECTOR',
    referenceAssessment: { reference: resolution.selected, status: 'VALIDATED' },
    structuralEvidence: { lifecycleState: 'CONNECTED', connectorRecordRevision: 1, definitionChecksum: 'checksum-1' },
    permissions: { status: 'SATISFIED', requiredCount: 2, missingCount: 0 }, credentials: { status: 'READY', credentials: [] },
    authorization: { decision: 'ALLOW', expiresAt: '2026-09-26T12:01:00.000Z' }, reasons: [],
    audit: { requestedEventId: 'request-event-1', outcomeEventId: 'outcome-event-1' }, preparedAt: missionTime,
    expiresAt: overrides.expiresAt ?? '2026-09-26T12:01:00.000Z',
  };
  const structural: StructuralReadinessSnapshot = {
    instanceId: 'wordpress-managed-1', definitionRef: { id: 'wordpress.connector', version: '1.0' }, lifecycle: { state: 'CONNECTED', updatedAt: missionTime }, revision, securityRevision,
    capabilities: [{ id: 'content.create', riskLevel: 'LOW' }], permissions: ['connector.execute'], credentialRequirement: 'OPTIONAL', credentialReferences: [], connectorRecordRevision: 1, definitionChecksum: 'checksum-1',
  };
  return { preparation, resolution, structural, health };
}

class StaticStructuralReader {
  value: StructuralReadinessSnapshot | undefined;

  constructor(value: StructuralReadinessSnapshot | undefined) {
    this.value = value;
  }

  async inspect(): Promise<StructuralReadinessSnapshot | undefined> {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
}

class StaticHealthReader {
  value: PreparationHealthSnapshot | undefined;

  constructor(value: PreparationHealthSnapshot | undefined) {
    this.value = value;
  }

  async getLatest(): Promise<PreparationHealthSnapshot | undefined> {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
}

function directExecutor(
  connector: WordPressConnector,
  artifacts = readyArtifacts(),
  structural = new StaticStructuralReader(artifacts.structural),
  health = new StaticHealthReader(artifacts.health),
): { readonly executor: WordPressArticleExecution; readonly audit: InMemoryWordPressMissionAudit; readonly registry: ConnectorRegistry } {
  const registry = new ConnectorRegistry();
  registerWordPressConnector(registry, connector);
  const audit = new InMemoryWordPressMissionAudit();
  return {
    executor: new WordPressArticleExecution(registry, structural, health, artifacts.resolution, authorizationIssuer(registry), audit, new MissionClock()),
    audit,
    registry,
  };
}

for (const [name, mutate, expected] of [
  ['health changes before execution', (artifacts: ReturnType<typeof readyArtifacts>, health: StaticHealthReader) => { health.value = { ...artifacts.health, observationId: 'health-execution-2', sequence: 2 }; }, 'EXECUTION_HEALTH_CONFLICT'],
  ['managed revision changes before execution', (artifacts: ReturnType<typeof readyArtifacts>, _health: StaticHealthReader, structural?: StaticStructuralReader) => { if (structural) structural.value = { ...artifacts.structural, revision: 2 }; }, 'EXECUTION_REFERENCE_CONFLICT'],
  ['security revision changes before execution', (artifacts: ReturnType<typeof readyArtifacts>, _health: StaticHealthReader, structural?: StaticStructuralReader) => { if (structural) structural.value = { ...artifacts.structural, securityRevision: 2 }; }, 'EXECUTION_REFERENCE_CONFLICT'],
] as const) {
  test(`rejects execution when ${name}`, async () => {
    const wordpress = await server((request, response) => {
      if (request.method === 'GET') return writeJson(response, 200, { id: 88, status: 'draft' });
      writeJson(response, 201, { id: 88, status: 'draft', link: 'https://example.test/?p=88' });
    });
    try {
      const connector = new WordPressConnector(configuration(wordpress.baseUrl));
      const artifacts = readyArtifacts();
      const structural = new StaticStructuralReader(artifacts.structural);
      const health = new StaticHealthReader(artifacts.health);
      mutate(artifacts, health, structural);
      const { executor } = directExecutor(connector, artifacts, structural, health);
      const result = await executor.execute(artifacts.preparation, { title: 'Cómo elegir una cámara', contentHtml: '<p>Texto.</p>' });

      assert.deepEqual(result, { status: 'FAILED', reasonCode: expected });
    } finally {
      await wordpress.close();
    }
  });
}

test('rejects expired, DENIED, and NOT_READY preparations without POST', async () => {
  let posts = 0;
  const wordpress = await server((request, response) => {
    if (request.url === '/wp-json/wp/v2/posts') posts += 1;
    writeJson(response, 201, { id: 88, status: 'draft', link: 'https://example.test/?p=88' });
  });
  try {
    for (const artifacts of [
      readyArtifacts({ expiresAt: missionTime }),
      readyArtifacts({ status: 'DENIED' }),
      readyArtifacts({ status: 'NOT_READY' }),
    ]) {
      const { executor } = directExecutor(new WordPressConnector(configuration(wordpress.baseUrl)), artifacts);
      const result = await executor.execute(artifacts.preparation, { title: 'Cómo elegir una cámara', contentHtml: '<p>Texto.</p>' });
      assert.equal(result.status, 'FAILED');
    }
    assert.equal(posts, 0);
  } finally {
    await wordpress.close();
  }
});

test('records a safe failure and disconnects when the connector execution fails', async () => {
  const wordpress = await server((_request, response) => writeJson(response, 500, { unsafe: applicationPassword }));
  try {
    const connector = new WordPressConnector(configuration(wordpress.baseUrl));
    const { executor, audit, registry } = directExecutor(connector);
    const result = await executor.execute(readyArtifacts().preparation, { title: 'Cómo elegir una cámara', contentHtml: '<p>Texto.</p>' });

    assert.deepEqual(result, { status: 'FAILED', reasonCode: 'EXECUTION_OUTCOME_AMBIGUOUS' });
    assert.equal(audit.listExecution()[0]?.eventType, 'ArticleDraftCreationFailed');
    const retry = await connector.execute(await connectorRequest(connector, registry));
    assert.deepEqual(retry, { status: 'FAILED', errors: ['WORDPRESS_NOT_CONNECTED'] });
    assert.equal(JSON.stringify(audit.listExecution()).includes(applicationPassword), false);
  } finally {
    await wordpress.close();
  }
});

test('preserves an ambiguous connector outcome in execution and audit', async () => {
  const providerDetail = 'ambiguous-provider-detail-not-for-output';
  const connector = new WordPressConnector(
    configuration('https://wordpress-ambiguous.test'),
    async () => { throw new Error(providerDetail); },
  );
  const { executor, audit } = directExecutor(connector);

  const result = await executor.execute(
    readyArtifacts().preparation,
    { title: 'Ambiguous article', contentHtml: '<p>Ambiguous content.</p>' },
  );

  assert.deepEqual(result, { status: 'FAILED', reasonCode: 'EXECUTION_OUTCOME_AMBIGUOUS' });
  const event = audit.listExecution()[0];
  assert.ok(event?.eventType === 'ArticleDraftCreationFailed');
  assert.equal(event.reasonCode, 'EXECUTION_OUTCOME_AMBIGUOUS');
  assert.equal(JSON.stringify({ result, audit: audit.listExecution() }).includes(providerDetail), false);
  assert.equal(JSON.stringify(audit.listExecution()).includes('Ambiguous content.'), false);
});

test('executes at most once and returns immutable success output', async () => {
  let posts = 0;
  const wordpress = await server((request, response) => {
    if (request.url === '/wp-json/wp/v2/posts') posts += 1;
    if (request.method === 'GET') return writeJson(response, 200, { id: 99, status: 'draft' });
    writeJson(response, 201, { id: 99, status: 'draft', link: 'https://example.test/?p=99' });
  });
  try {
    const { executor } = directExecutor(new WordPressConnector(configuration(wordpress.baseUrl)));
    const artifacts = readyArtifacts();
    const first = await executor.execute(artifacts.preparation, { title: 'Cómo elegir una cámara', contentHtml: '<p>Texto.</p>' });
    const second = await executor.execute(artifacts.preparation, { title: 'Cómo elegir una cámara', contentHtml: '<p>Texto.</p>' });

    assert.equal(first.status, 'SUCCEEDED');
    assert.deepEqual(second, { status: 'FAILED', reasonCode: 'EXECUTION_ALREADY_ATTEMPTED' });
    assert.equal(posts, 1);
    assert.equal(Object.isFrozen(first), true);
    if (first.status === 'SUCCEEDED') assert.equal(Object.isFrozen(first.output), true);
  } finally {
    await wordpress.close();
  }
});
