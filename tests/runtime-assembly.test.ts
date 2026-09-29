import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryConnectorRepository } from '../core/contracts-foundation/in-memory.ts';
import type {
  ConnectorRecord,
  CredentialReference,
  ManagedConnector,
  ManagedConnectorLifecycleState,
} from '../core/contracts-foundation/domain.ts';
import { RuntimeAssembler } from '../core/runtime-assembly/runtime-assembler.ts';
import { RuntimeAssemblyError } from '../core/runtime-assembly/errors.ts';
import type { RuntimeCompatibilityProfile } from '../core/runtime-assembly/models.ts';
import type { RuntimeAssemblyRepository } from '../core/runtime-assembly/ports.ts';
import { RuntimeAssemblyPolicy } from '../core/runtime-assembly/runtime-assembly-policy.ts';
import { RuntimeValidator } from '../core/runtime-assembly/runtime-validator.ts';
import { createTestConnectorRecord } from './fixtures/connector-record.ts';

const createdAt = '2026-09-24T12:00:00.000Z';
const compatibility: RuntimeCompatibilityProfile = {
  runtimeProtocolVersion: '1.4.1',
  connectorApiVersion: '1',
  capabilitySchemaVersion: '1',
  definitionSchemaVersion: '1',
  connectorRecordSchemaVersion: 1,
  managedConnectorSchemaVersion: 1,
};

const credentialReferences: readonly CredentialReference[] = [
  {
    credentialId: 'credential-1',
    providerId: 'test-provider',
    secretRef: 'test-provider://credential-1',
    revision: 1,
  },
];

function managedConnector(
  lifecycleState: ManagedConnectorLifecycleState = 'CONNECTED',
  credentialRefs: readonly CredentialReference[] = credentialReferences,
): ManagedConnector {
  return {
    instanceId: 'managed-runtime-assembly-1',
    definitionRef: { id: 'mock.connector', version: '1.0' },
    lifecycleState,
    credentialRefs,
    latestHealth: {
      observationId: 'health-1',
      connectorInstanceId: 'managed-runtime-assembly-1',
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
    metadata: { internal: 'must-not-appear' },
  };
}

class FixedClock {
  now(): string {
    return '2026-09-25T00:00:00.000Z';
  }
}

async function setup(
  lifecycleState: ManagedConnectorLifecycleState = 'CONNECTED',
  credentialRefs: readonly CredentialReference[] = credentialReferences,
  policy = new RuntimeAssemblyPolicy(),
  record: ConnectorRecord = createTestConnectorRecord(createdAt),
) {
  const repository = new InMemoryConnectorRepository();
  await repository.saveDefinition(record);
  await repository.saveManagedConnector(managedConnector(lifecycleState, credentialRefs));
  const assembler = new RuntimeAssembler(
    repository,
    new RuntimeValidator(),
    policy,
    compatibility,
    new FixedClock(),
  );
  return { assembler, repository };
}

async function assertCode(
  operation: Promise<unknown>,
  code: RuntimeAssemblyError['code'],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return error instanceof RuntimeAssemblyError && error.code === code;
  });
}

function functionsIn(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value === 'function') return 1;
  if (typeof value !== 'object' || value === null || seen.has(value)) return 0;
  seen.add(value);
  return Object.values(value).reduce((count, entry) => count + functionsIn(entry, seen), 0);
}

test('assembles an exact CONNECTED ManagedConnector as a structural runtime', async () => {
  const { assembler } = await setup();

  const runtime = await assembler.assemble({ instanceId: 'managed-runtime-assembly-1' });

  assert.equal(runtime.instanceId, 'managed-runtime-assembly-1');
  assert.equal(runtime.definition.id, 'mock.connector');
  assert.equal(runtime.definition.version, '1.0');
  assert.equal(runtime.lifecycle.state, 'CONNECTED');
  assert.equal(runtime.lifecycle.readiness, 'STRUCTURALLY_READY');
  assert.deepEqual(runtime.permissions, ['connector.execute']);
  assert.equal(runtime.credentials.requirement, 'REQUIRED');
  assert.equal(runtime.credentials.availability, 'NOT_VERIFIED');
  assert.equal(runtime.operationalMetadata.assembledAt, '2026-09-25T00:00:00.000Z');
});

test('rejects a ManagedConnector that does not exist', async () => {
  const { assembler } = await setup();

  await assertCode(assembler.assemble({ instanceId: 'missing-runtime' }), 'RUNTIME_NOT_FOUND');
});

test('rejects a missing exact ConnectorDefinition', async () => {
  const repository = new InMemoryConnectorRepository();
  await repository.saveManagedConnector(managedConnector());
  const assembler = new RuntimeAssembler(
    repository,
    new RuntimeValidator(),
    new RuntimeAssemblyPolicy(),
    compatibility,
    new FixedClock(),
  );

  await assertCode(
    assembler.assemble({ instanceId: 'managed-runtime-assembly-1' }),
    'INVALID_DEFINITION',
  );
});

test('rejects incompatible ConnectorRecord compatibility', async () => {
  const record = createTestConnectorRecord(createdAt);
  record.compatibility.minimumRuntimeVersion = '2.0';
  const { assembler } = await setup('CONNECTED', credentialReferences, new RuntimeAssemblyPolicy(), record);

  await assertCode(
    assembler.assemble({ instanceId: 'managed-runtime-assembly-1' }),
    'INCOMPATIBLE_VERSION',
  );
});

test('requires credentials by default', async () => {
  const { assembler } = await setup('CONNECTED', []);

  await assertCode(
    assembler.assemble({ instanceId: 'managed-runtime-assembly-1' }),
    'MISSING_REFERENCE',
  );
});

test('allows an empty credential list only for an exact OPTIONAL policy reference', async () => {
  const optionalPolicy = new RuntimeAssemblyPolicy([{ id: 'mock.connector', version: '1.0' }]);
  const { assembler } = await setup('CONNECTED', [], optionalPolicy);

  const runtime = await assembler.assemble({ instanceId: 'managed-runtime-assembly-1' });

  assert.equal(runtime.credentials.requirement, 'OPTIONAL');
  assert.deepEqual(runtime.credentials.references, []);
  assert.equal(
    new RuntimeAssemblyPolicy([{ id: 'mock.connector', version: '2.0' }]).credentialRequirementFor({
      id: 'mock.connector',
      version: '1.0',
    }),
    'REQUIRED',
  );
});

test('excludes arbitrary metadata and recorded health from the runtime', async () => {
  const record = createTestConnectorRecord(createdAt);
  record.definition.metadata = { privateConfiguration: 'must-not-appear' };
  const { assembler } = await setup('CONNECTED', credentialReferences, new RuntimeAssemblyPolicy(), record);

  const runtime = await assembler.assemble({ instanceId: 'managed-runtime-assembly-1' });

  assert.equal('metadata' in runtime.definition, false);
  assert.equal('health' in runtime.definition, false);
  assert.equal('metadata' in runtime.managedConnector, false);
  assert.equal('latestHealth' in runtime.managedConnector, false);
});

test('contains no SDK, resolver, execution result, or executable function', async () => {
  const { assembler } = await setup();

  const runtime = await assembler.assemble({ instanceId: 'managed-runtime-assembly-1' });

  assert.equal('connector' in runtime, false);
  assert.equal('resolver' in runtime, false);
  assert.equal('execution' in runtime, false);
  assert.equal('result' in runtime, false);
  assert.equal(functionsIn(runtime), 0);
});

test('returns deeply frozen defensive snapshots', async () => {
  const { assembler, repository } = await setup();

  const runtime = await assembler.assemble({ instanceId: 'managed-runtime-assembly-1' });
  const schema = runtime.definition.capabilities[0]!.inputSchema as Record<string, unknown>;

  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.permissions), true);
  assert.equal(Object.isFrozen(runtime.definition.capabilities), true);
  assert.equal(Object.isFrozen(schema), true);
  assert.throws(() => (runtime.permissions as string[]).push('mutated'), TypeError);
  assert.throws(() => {
    schema.mutated = true;
  }, TypeError);
  assert.equal((await repository.getManagedConnector('managed-runtime-assembly-1'))?.metadata.internal, '[REDACTED]');
});

test('rejects REGISTERED and DISABLED lifecycle states', async () => {
  const registered = await setup('REGISTERED');
  const disabled = await setup('DISABLED');

  await assertCode(
    registered.assembler.assemble({ instanceId: 'managed-runtime-assembly-1' }),
    'INVALID_LIFECYCLE',
  );
  await assertCode(
    disabled.assembler.assemble({ instanceId: 'managed-runtime-assembly-1' }),
    'INVALID_LIFECYCLE',
  );
});

test('rejects REMOVED as a terminal connector', async () => {
  const { assembler } = await setup('REMOVED');

  await assertCode(
    assembler.assemble({ instanceId: 'managed-runtime-assembly-1' }),
    'TERMINAL_CONNECTOR',
  );
});

test('accepts DEGRADED and HEALTHY as structural lifecycle states without health probing', async () => {
  const degraded = await setup('DEGRADED');
  const healthy = await setup('HEALTHY');

  assert.equal(
    (await degraded.assembler.assemble({ instanceId: 'managed-runtime-assembly-1' })).lifecycle.state,
    'DEGRADED',
  );
  assert.equal(
    (await healthy.assembler.assemble({ instanceId: 'managed-runtime-assembly-1' })).lifecycle.state,
    'HEALTHY',
  );
});

test('rejects concurrent state changes with RUNTIME_CONFLICT', async () => {
  const record = createTestConnectorRecord(createdAt);
  const initial = managedConnector();
  const changed = managedConnector();
  changed.revision = 2;
  let initialRead = true;
  const repository: RuntimeAssemblyRepository = {
    async getManagedConnector(): Promise<ManagedConnector> {
      const value = initialRead ? initial : changed;
      initialRead = false;
      return structuredClone(value);
    },
    async getDefinition(): Promise<ConnectorRecord> {
      return structuredClone(record);
    },
  };
  const assembler = new RuntimeAssembler(
    repository,
    new RuntimeValidator(),
    new RuntimeAssemblyPolicy(),
    compatibility,
    new FixedClock(),
  );

  await assertCode(
    assembler.assemble({ instanceId: 'managed-runtime-assembly-1' }),
    'RUNTIME_CONFLICT',
  );
});
