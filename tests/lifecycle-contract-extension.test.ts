import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LifecycleContractError,
  type LifecycleContractErrorCode,
  type LifecycleTransitionCommand,
  type ManagedConnector,
} from '../core/contracts-foundation/domain.ts';
import { InMemoryConnectorRepository } from '../core/contracts-foundation/in-memory.ts';
import type { LifecycleConnectorRepository } from '../core/contracts-foundation/repositories.ts';

const createdAt = '2026-09-24T12:00:00.000Z';

function managedConnector(): ManagedConnector {
  return {
    instanceId: 'managed-lifecycle-1',
    definitionRef: { id: 'mock.connector', version: '1.0' },
    lifecycleState: 'REGISTERED',
    credentialRefs: [],
    securityRevision: 1,
    revision: 1,
    schemaVersion: 1,
    createdAt,
    updatedAt: createdAt,
    metadata: {},
  };
}

function command(
  transitionId: string,
  nextState: LifecycleTransitionCommand['nextState'],
  timestamp: string,
  securityRevisionIncrement: 0 | 1,
): LifecycleTransitionCommand {
  return {
    transitionId,
    instanceId: 'managed-lifecycle-1',
    nextState,
    actorId: 'operator-1',
    reason: `Move to ${nextState}`,
    timestamp,
    securityRevisionIncrement,
  };
}

async function repositoryWithConnector(): Promise<LifecycleConnectorRepository> {
  const repository: LifecycleConnectorRepository = new InMemoryConnectorRepository();
  await repository.saveManagedConnector(managedConnector());
  return repository;
}

async function assertLifecycleError(
  operation: Promise<unknown>,
  code: LifecycleContractErrorCode,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return error instanceof LifecycleContractError && error.code === code;
  });
}

test('accepts a valid LifecycleTransitionCommand and transitions REGISTERED to CONNECTED', async () => {
  const repository = await repositoryWithConnector();
  const result = await repository.transitionLifecycle(
    command('transition-1', 'CONNECTED', '2026-09-24T12:00:01.000Z', 0),
    1,
  );

  assert.equal(result.connector.lifecycleState, 'CONNECTED');
  assert.equal(result.connector.revision, 2);
  assert.equal(result.connector.securityRevision, 1);
  assert.deepEqual(result.historyEntry, {
    transitionId: 'transition-1',
    instanceId: 'managed-lifecycle-1',
    previousState: 'REGISTERED',
    nextState: 'CONNECTED',
    actorId: 'operator-1',
    reason: 'Move to CONNECTED',
    timestamp: '2026-09-24T12:00:01.000Z',
    revision: 2,
    securityRevision: 1,
  });
});

test('rejects REGISTERED to HEALTHY without partial changes', async () => {
  const repository = await repositoryWithConnector();

  await assertLifecycleError(
    repository.transitionLifecycle(
      command('transition-invalid', 'HEALTHY', '2026-09-24T12:00:01.000Z', 0),
      1,
    ),
    'INVALID_TRANSITION',
  );

  const connector = await repository.getManagedConnector('managed-lifecycle-1');
  assert.equal(connector?.lifecycleState, 'REGISTERED');
  assert.equal(connector?.revision, 1);
  assert.deepEqual(await repository.getLifecycleHistory('managed-lifecycle-1'), []);
});

test('allows DISABLED to REMOVED and keeps REMOVED terminal', async () => {
  const repository = await repositoryWithConnector();
  const disabled = await repository.transitionLifecycle(
    command('transition-disable', 'DISABLED', '2026-09-24T12:00:01.000Z', 1),
    1,
  );
  const removed = await repository.transitionLifecycle(
    command('transition-remove', 'REMOVED', '2026-09-24T12:00:02.000Z', 1),
    disabled.connector.revision,
  );

  assert.equal(removed.connector.lifecycleState, 'REMOVED');
  assert.equal(removed.connector.securityRevision, 3);
  await assertLifecycleError(
    repository.transitionLifecycle(
      command('transition-revive', 'REGISTERED', '2026-09-24T12:00:03.000Z', 1),
      removed.connector.revision,
    ),
    'TERMINAL_STATE',
  );
});

test('rejects a stale expectedRevision without state, history, or event side effects', async () => {
  const repository = await repositoryWithConnector();

  await assertLifecycleError(
    repository.transitionLifecycle(
      command('transition-stale', 'CONNECTED', '2026-09-24T12:00:01.000Z', 0),
      2,
    ),
    'REVISION_CONFLICT',
  );

  const connector = await repository.getManagedConnector('managed-lifecycle-1');
  assert.equal(connector?.revision, 1);
  assert.deepEqual(await repository.getLifecycleHistory('managed-lifecycle-1'), []);
});

test('rejects duplicate transitionId without creating another history entry', async () => {
  const repository = await repositoryWithConnector();
  const first = await repository.transitionLifecycle(
    command('transition-duplicate', 'CONNECTED', '2026-09-24T12:00:01.000Z', 0),
    1,
  );

  await assertLifecycleError(
    repository.transitionLifecycle(
      command('transition-duplicate', 'HEALTHY', '2026-09-24T12:00:02.000Z', 0),
      first.connector.revision,
    ),
    'DUPLICATE_TRANSITION',
  );

  assert.equal((await repository.getLifecycleHistory('managed-lifecycle-1')).length, 1);
});

test('enforces securityRevision policy for operational and security transitions', async () => {
  const repository = await repositoryWithConnector();
  const connected = await repository.transitionLifecycle(
    command('transition-connected', 'CONNECTED', '2026-09-24T12:00:01.000Z', 0),
    1,
  );
  const healthy = await repository.transitionLifecycle(
    command('transition-healthy', 'HEALTHY', '2026-09-24T12:00:02.000Z', 0),
    connected.connector.revision,
  );
  const disabled = await repository.transitionLifecycle(
    command('transition-disabled', 'DISABLED', '2026-09-24T12:00:03.000Z', 1),
    healthy.connector.revision,
  );
  const enabled = await repository.transitionLifecycle(
    command('transition-enabled', 'REGISTERED', '2026-09-24T12:00:04.000Z', 1),
    disabled.connector.revision,
  );

  assert.equal(healthy.connector.securityRevision, 1);
  assert.equal(disabled.connector.securityRevision, 2);
  assert.equal(enabled.connector.securityRevision, 3);
  await assertLifecycleError(
    repository.transitionLifecycle(
      command('transition-policy', 'DISABLED', '2026-09-24T12:00:05.000Z', 0),
      enabled.connector.revision,
    ),
    'SECURITY_REVISION_POLICY_VIOLATION',
  );
});

test('returns ordered defensive lifecycle history snapshots', async () => {
  const repository = await repositoryWithConnector();
  const connected = await repository.transitionLifecycle(
    command('transition-history-1', 'CONNECTED', '2026-09-24T12:00:01.000Z', 0),
    1,
  );
  await repository.transitionLifecycle(
    command('transition-history-2', 'DEGRADED', '2026-09-24T12:00:02.000Z', 0),
    connected.connector.revision,
  );

  const history = await repository.getLifecycleHistory('managed-lifecycle-1');
  assert.deepEqual(
    history.map((entry) => entry.revision),
    [2, 3],
  );
  history[0]!.reason = 'mutated';
  const reread = await repository.getLifecycleHistory('managed-lifecycle-1');
  assert.equal(reread[0]?.reason, 'Move to CONNECTED');
});

test('retains the v1.4.1-A legacy transition signature', async () => {
  const repository = await repositoryWithConnector();

  const connector = await repository.transitionLifecycle(
    'managed-lifecycle-1',
    {
      nextState: 'CONNECTED',
      reason: 'Legacy transition',
      occurredAt: '2026-09-24T12:00:01.000Z',
    },
    1,
  );

  assert.equal(connector.lifecycleState, 'CONNECTED');
  assert.equal(connector.revision, 2);
  assert.deepEqual(await repository.getLifecycleHistory('managed-lifecycle-1'), []);
});
