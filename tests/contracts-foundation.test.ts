import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSecretLease,
  type AuditEnvelope,
  type CredentialDefinition,
  type CredentialReference,
  type HealthObservation,
  type ManagedConnector,
} from '../core/contracts-foundation/domain.ts';
import {
  InMemoryAuditRepository,
  InMemoryConnectorRepository,
  InMemoryCredentialManager,
  InMemoryHealthRepository,
} from '../core/contracts-foundation/in-memory.ts';
import {
  TestConnectorCompatibility,
  createTestConnectorRecord,
} from './fixtures/connector-record.ts';

const createdAt = '2026-09-24T12:00:00.000Z';

function managedConnector(): ManagedConnector {
  return {
    instanceId: 'managed-mock-1',
    definitionRef: { id: 'mock.connector', version: '1.0' },
    lifecycleState: 'REGISTERED',
    credentialRefs: [
      {
        credentialId: 'credential-1',
        providerId: 'test-provider',
        secretRef: 'test-provider://credential-1',
        revision: 1,
      },
    ],
    securityRevision: 1,
    revision: 1,
    schemaVersion: 1,
    createdAt,
    updatedAt: createdAt,
    metadata: { environment: 'test' },
  };
}

function credentialDefinition(): CredentialDefinition {
  return {
    id: 'credential-1',
    connectorInstanceId: 'managed-mock-1',
    providerId: 'test-provider',
    secretRef: 'test-provider://credential-1',
    purpose: 'connector-authentication',
    status: 'ACTIVE',
    createdAt,
    updatedAt: createdAt,
    revision: 1,
    metadata: { rotationPolicy: 'manual' },
  };
}

function auditEnvelope(sequence: number): AuditEnvelope {
  return {
    eventId: `event-${sequence}`,
    eventType: 'ConnectorExecuted',
    schemaVersion: 1,
    executionId: 'execution-1',
    sequence,
    timestamp: `2026-09-24T12:00:0${4 - sequence}.000Z`,
    actorId: 'actor-1',
    connectorInstanceId: 'managed-mock-1',
    connectorRef: { id: 'mock.connector', version: '1.0' },
    payload: { sequence },
    correlationId: 'correlation-1',
  };
}

test('accepts a valid ManagedConnector and preserves its snapshot', async () => {
  const repository = new InMemoryConnectorRepository();
  const connector = managedConnector();
  const metadata = connector.metadata as Record<string, unknown>;

  const saved = await repository.saveManagedConnector(connector);
  metadata.environment = 'changed';
  const loaded = await repository.getManagedConnector(connector.instanceId);

  assert.equal(saved.instanceId, 'managed-mock-1');
  assert.equal(saved.lifecycleState, 'REGISTERED');
  assert.equal(loaded?.metadata.environment, '[REDACTED]');
});

test('validates ConnectorRecord schemaVersion and adapts v1.4.0 mock metadata', async () => {
  const repository = new InMemoryConnectorRepository();
  const record = createTestConnectorRecord(createdAt);

  await repository.saveDefinition(record);
  assert.deepEqual(
    await repository.getLatestCompatible('mock.connector', TestConnectorCompatibility),
    record,
  );
  await assert.rejects(
    repository.saveDefinition({ ...record, schemaVersion: 0 }),
    /ConnectorRecord is invalid/,
  );
});

test('keeps CredentialReference free from secret material', () => {
  const reference: CredentialReference = {
    credentialId: 'credential-1',
    providerId: 'test-provider',
    secretRef: 'test-provider://credential-1',
    revision: 1,
  };

  assert.deepEqual(Object.keys(reference).sort(), [
    'credentialId',
    'providerId',
    'revision',
    'secretRef',
  ]);
  assert.equal('material' in reference, false);
  assert.equal('secret' in reference, false);
});

test('makes SecretLease non-persistible', async () => {
  const lease = createSecretLease(
    'credential-1',
    { token: 'never-persist-this' },
    '2026-09-24T12:01:00.000Z',
    createdAt,
  );
  const audit = new InMemoryAuditRepository();

  assert.throws(() => structuredClone(lease));
  await assert.rejects(
    audit.append({ ...auditEnvelope(1), payload: { lease } }),
    /SecretLease cannot be persisted/,
  );
  await assert.rejects(
    audit.append({ ...auditEnvelope(1), eventId: 'event-secret', payload: { token: 'secret' } }),
    /Secret material cannot be persisted/,
  );
  const sanitized = await audit.append({
    ...auditEnvelope(1),
    eventId: 'event-sanitized',
    payload: { apiCredential: 'secret', nested: { value: 'public-looking' } },
  });
  assert.deepEqual(sanitized.payload, {
    apiCredential: '[REDACTED]',
    nested: { value: '[REDACTED]' },
  });
});

test('keeps AuditEnvelope sequence ordered and reconstructable as a stream', async () => {
  const audit = new InMemoryAuditRepository();

  await audit.append(auditEnvelope(1));
  await audit.appendBatch([auditEnvelope(2), auditEnvelope(3)]);

  assert.deepEqual(
    (await audit.findByExecution('execution-1')).map((event) => event.sequence),
    [1, 2, 3],
  );
  assert.deepEqual(
    (await audit.findByConnector('mock.connector', '1.0')).map((event) => event.eventId),
    ['event-1', 'event-2', 'event-3'],
  );

  const streamed: number[] = [];
  for await (const event of await audit.readStream('execution-1')) {
    streamed.push(event.sequence);
  }
  assert.deepEqual(streamed, [1, 2, 3]);
  await assert.rejects(audit.append({ ...auditEnvelope(3), eventId: 'event-duplicate' }));
});

test('fulfills repository contracts with asynchronous InMemory adapters', async () => {
  const connectors = new InMemoryConnectorRepository();
  const credentials = new InMemoryCredentialManager();
  const health = new InMemoryHealthRepository();
  const record = createTestConnectorRecord(createdAt);
  const connector = managedConnector();
  const credential = credentialDefinition();

  await connectors.saveDefinition(record);
  await connectors.saveManagedConnector(connector);
  const connected = await connectors.transitionLifecycle(
    connector.instanceId,
    {
      nextState: 'CONNECTED',
      reason: 'Contract test',
      occurredAt: '2026-09-24T12:00:01.000Z',
    },
    connector.revision,
  );
  assert.equal(connected.revision, 2);
  assert.equal(
    (await connectors.listManagedConnectors({ definitionId: 'mock.connector' })).length,
    1,
  );
  await assert.rejects(
    connectors.saveManagedConnector(
      { ...connected, metadata: { environment: 'stale-write' } },
      connector.revision,
    ),
    /revision conflict/,
  );
  const removed = await connectors.markRemoved(connector.instanceId, connected.revision);
  await assert.rejects(
    connectors.saveManagedConnector(
      { ...removed, lifecycleState: 'REGISTERED' },
      removed.revision,
    ),
    /is removed/,
  );

  await credentials.register(credential);
  const lease = await credentials.acquireLease(connector.credentialRefs[0]!, 'execution-1');
  assert.equal(lease.credentialId, credential.id);
  lease.dispose();
  const rotated = await credentials.rotate(credential.id, {
    secretRef: 'test-provider://credential-1-v2',
    occurredAt: '2026-09-24T12:00:02.000Z',
  }, credential.revision);
  assert.equal(rotated.revision, 2);
  await assert.rejects(
    credentials.rotate(credential.id, {
      secretRef: 'test-provider://credential-1-v3',
      occurredAt: '2026-09-24T12:00:02.500Z',
    }, credential.revision),
    /cannot rotate/,
  );
  const revoked = await credentials.revoke(
    credential.id,
    'Contract test revocation',
    '2026-09-24T12:00:03.000Z',
    rotated.revision,
  );
  assert.equal(revoked.status, 'REVOKED');
  assert.deepEqual(await credentials.evaluateExpiration('2026-09-26T12:00:00.000Z'), []);

  const observation: HealthObservation = {
    observationId: 'health-1',
    connectorInstanceId: connector.instanceId,
    timestamp: '2026-09-24T12:00:04.000Z',
    status: 'HEALTHY',
    latencyMs: 12,
    probeType: 'ON_DEMAND',
    consecutiveFailures: 0,
  };
  await health.append(observation);
  assert.deepEqual(await health.getLatest(connector.instanceId), observation);
  assert.equal((await health.findHistory(connector.instanceId)).length, 1);
});
