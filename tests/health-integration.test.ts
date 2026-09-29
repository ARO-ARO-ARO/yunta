import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryConnectorRepository } from '../core/contracts-foundation/in-memory.ts';
import type {
  ManagedConnector,
  ManagedConnectorLifecycleState,
} from '../core/contracts-foundation/domain.ts';
import {
  InMemoryHealthEventPublisher,
  type HealthEvent,
} from '../core/health-integration/events.ts';
import { HealthIntegrationError } from '../core/health-integration/errors.ts';
import { InMemoryHealthRepository } from '../core/health-integration/in-memory-health-repository.ts';
import type {
  HealthCheckProviderRequest,
  HealthCheckProviderResult,
  HealthCheckRequest,
} from '../core/health-integration/models.ts';
import type { HealthCheckProvider } from '../core/health-integration/ports.ts';
import { HealthService } from '../core/health-integration/health-service.ts';
import { createTestConnectorRecord } from './fixtures/connector-record.ts';

const createdAt = '2026-09-25T12:00:00.000Z';

function managedConnector(
  lifecycleState: ManagedConnectorLifecycleState = 'CONNECTED',
): ManagedConnector {
  return {
    instanceId: 'managed-health-1',
    definitionRef: { id: 'mock.connector', version: '1.0' },
    lifecycleState,
    credentialRefs: [
      {
        credentialId: 'credential-1',
        providerId: 'test-provider',
        secretRef: 'test-provider://credential-1',
        revision: 1,
      },
    ],
    latestHealth: {
      observationId: 'legacy-health-1',
      connectorInstanceId: 'managed-health-1',
      timestamp: createdAt,
      status: 'HEALTHY',
      latencyMs: 1,
      probeType: 'ON_DEMAND',
      consecutiveFailures: 0,
    },
    securityRevision: 1,
    revision: 1,
    schemaVersion: 1,
    createdAt,
    updatedAt: createdAt,
    metadata: { private: 'must-not-leak' },
  };
}

class FixedClock {
  private index = 0;

  now(): string {
    this.index += 1;
    return `2026-09-25T12:00:${String(this.index).padStart(2, '0')}.000Z`;
  }
}

class SequenceIdGenerator {
  private index = 0;

  next(): string {
    this.index += 1;
    return `health-id-${this.index}`;
  }
}

class QueueProvider implements HealthCheckProvider {
  readonly providerId = 'test-health-provider';
  readonly requests: HealthCheckProviderRequest[] = [];
  private readonly results: Array<HealthCheckProviderResult | Error>;

  constructor(results: readonly (HealthCheckProviderResult | Error)[]) {
    this.results = [...results];
  }

  async check(request: HealthCheckProviderRequest): Promise<HealthCheckProviderResult> {
    this.requests.push(structuredClone(request));
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    if (!result) throw new Error('No test health result');
    return structuredClone(result);
  }
}

function observed(status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN') {
  return {
    outcome: 'OBSERVED' as const,
    status,
    observedAt: '2026-09-25T12:01:00.000Z',
    latencyMs: 12,
  };
}

function request(
  idempotencyKey = 'health-key-1',
  probeType: HealthCheckRequest['probeType'] = 'ON_DEMAND',
): HealthCheckRequest {
  return {
    checkId: 'check-1',
    idempotencyKey,
    connectorInstanceId: 'managed-health-1',
    probeType,
    correlationId: 'correlation-1',
  };
}

async function setup(
  results: readonly (HealthCheckProviderResult | Error)[] = [observed('HEALTHY')],
  lifecycleState: ManagedConnectorLifecycleState = 'CONNECTED',
) {
  const connectors = new InMemoryConnectorRepository();
  await connectors.saveDefinition(createTestConnectorRecord(createdAt));
  await connectors.saveManagedConnector(managedConnector(lifecycleState));
  const provider = new QueueProvider(results);
  const repository = new InMemoryHealthRepository();
  const publisher = new InMemoryHealthEventPublisher();
  const service = new HealthService(
    connectors,
    provider,
    repository,
    publisher,
    undefined,
    new FixedClock(),
    new SequenceIdGenerator(),
  );
  return { connectors, provider, repository, publisher, service };
}

async function assertCode(
  operation: Promise<unknown>,
  code: HealthIntegrationError['code'],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return error instanceof HealthIntegrationError && error.code === code;
  });
}

test('records a valid HEALTHY HealthSnapshot', async () => {
  const { service } = await setup([observed('HEALTHY')]);

  const snapshot = await service.observe(request());

  assert.equal(snapshot.status, 'HEALTHY');
  assert.equal(snapshot.sequence, 1);
  assert.equal(snapshot.consecutiveFailures, 0);
  assert.equal(snapshot.origin.providerId, 'test-health-provider');
  assert.equal(snapshot.connector.definitionRef.version, '1.0');
});

test('records DEGRADED as a valid non-failure health result', async () => {
  const { service } = await setup([observed('DEGRADED')]);

  const snapshot = await service.observe(request());

  assert.equal(snapshot.status, 'DEGRADED');
  assert.equal(snapshot.consecutiveFailures, 0);
});

test('records UNHEALTHY as a valid failure health result', async () => {
  const { service } = await setup([observed('UNHEALTHY')]);

  const snapshot = await service.observe(request());

  assert.equal(snapshot.status, 'UNHEALTHY');
  assert.equal(snapshot.consecutiveFailures, 1);
});

test('records UNKNOWN as a valid failure health result', async () => {
  const { service } = await setup([observed('UNKNOWN')]);

  const snapshot = await service.observe(request());

  assert.equal(snapshot.status, 'UNKNOWN');
  assert.equal(snapshot.consecutiveFailures, 1);
});

test('normalizes a FAILED provider response to UNKNOWN and emits HealthCheckFailed', async () => {
  const { publisher, service } = await setup([
    {
      outcome: 'FAILED',
      code: 'PROBE_TIMEOUT',
      retryable: true,
      observedAt: '2026-09-25T12:01:00.000Z',
      latencyMs: 50,
    },
  ]);

  const snapshot = await service.observe(request());
  const events = publisher.list();

  assert.equal(snapshot.status, 'UNKNOWN');
  assert.deepEqual(snapshot.details, { code: 'PROBE_TIMEOUT', retryable: true });
  assert.deepEqual(events.map((event) => event.eventType), ['HealthObserved', 'HealthCheckFailed']);
});

test('normalizes a provider exception to UNKNOWN without leaking its message', async () => {
  const { publisher, service } = await setup([new Error('provider token must not leak')]);

  const snapshot = await service.observe(request());
  const events = publisher.list();

  assert.equal(snapshot.status, 'UNKNOWN');
  assert.deepEqual(snapshot.details, { code: 'PROVIDER_UNAVAILABLE', retryable: true });
  assert.equal(JSON.stringify(events).includes('provider token must not leak'), false);
});

test('keeps history in descending sequence order instead of timestamp order', async () => {
  const { service } = await setup([
    observed('HEALTHY'),
    { ...observed('DEGRADED'), observedAt: '2020-01-01T00:00:00.000Z' },
    observed('UNHEALTHY'),
  ]);

  await service.observe(request('key-1'));
  await service.observe(request('key-2'));
  await service.observe(request('key-3'));
  const history = await service.history('managed-health-1', { limit: 10 });

  assert.deepEqual(history.items.map((snapshot) => snapshot.sequence), [3, 2, 1]);
  assert.equal((await service.latest('managed-health-1'))?.sequence, 3);
});

test('returns the existing snapshot for an idempotent retry without another provider call', async () => {
  const { provider, publisher, service } = await setup([observed('HEALTHY')]);

  const first = await service.observe(request());
  const second = await service.observe(request());

  assert.equal(first.observationId, second.observationId);
  assert.equal(provider.requests.length, 1);
  assert.equal(publisher.list().length, 1);
});

test('rejects REGISTERED and DISABLED health checks', async () => {
  const registered = await setup([observed('HEALTHY')], 'REGISTERED');
  const disabled = await setup([observed('HEALTHY')], 'DISABLED');

  await assertCode(registered.service.observe(request()), 'HEALTH_CHECK_NOT_ALLOWED');
  await assertCode(disabled.service.observe(request()), 'HEALTH_CHECK_NOT_ALLOWED');
  assert.equal(registered.provider.requests.length, 0);
  assert.equal(disabled.provider.requests.length, 0);
});

test('rejects REMOVED health checks as terminal', async () => {
  const { provider, service } = await setup([observed('HEALTHY')], 'REMOVED');

  await assertCode(service.observe(request()), 'CONNECTOR_TERMINAL');
  assert.equal(provider.requests.length, 0);
});

test('does not mutate lifecycle, revision, or latestHealth', async () => {
  const { connectors, service } = await setup([observed('HEALTHY')]);
  const before = await connectors.getManagedConnector('managed-health-1');

  await service.observe(request());
  const after = await connectors.getManagedConnector('managed-health-1');

  assert.deepEqual(after, before);
});

test('passes the provider only an allowlisted request without credentials or SDK handles', async () => {
  const { provider, service } = await setup([observed('HEALTHY')]);

  await service.observe(request());

  const providerRequest = provider.requests[0]!;
  assert.deepEqual(Object.keys(providerRequest).sort(), [
    'checkId',
    'connectorInstanceId',
    'correlationId',
    'definitionRef',
    'probeType',
    'requestedAt',
  ]);
  assert.equal('credentials' in providerRequest, false);
  assert.equal('secretRef' in providerRequest, false);
  assert.equal('connector' in providerRequest, false);
});

test('returns immutable snapshots and emits secret-free events', async () => {
  const { publisher, service } = await setup([observed('HEALTHY'), observed('DEGRADED')]);

  const snapshot = await service.observe(request('key-1'));
  await service.observe(request('key-2'));
  const events: HealthEvent[] = publisher.list();

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.connector), true);
  assert.throws(() => {
    (snapshot.connector.definitionRef as { id: string }).id = 'mutated';
  }, TypeError);
  assert.deepEqual(events.map((event) => event.eventType), [
    'HealthObserved',
    'HealthObserved',
    'HealthChanged',
  ]);
  assert.equal(JSON.stringify(events).includes('secretRef'), false);
  assert.equal(JSON.stringify(events).includes('must-not-leak'), false);
});

test('rejects a missing ManagedConnector without invoking the provider', async () => {
  const { provider, publisher, repository } = await setup([observed('HEALTHY')]);
  const service = new HealthService(
    { getManagedConnector: async () => undefined },
    provider,
    repository,
    publisher,
    undefined,
    new FixedClock(),
    new SequenceIdGenerator(),
  );

  await assertCode(service.observe(request()), 'CONNECTOR_NOT_FOUND');
  assert.equal(provider.requests.length, 0);
});
