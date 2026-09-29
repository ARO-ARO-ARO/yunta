import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagedResolverError } from '../core/managed-resolver/errors.ts';
import { ManagedResolver } from '../core/managed-resolver/managed-resolver.ts';
import type {
  ManagedConnectorCandidate,
  ManagedResolution,
  ResolutionRequest,
} from '../core/managed-resolver/models.ts';
import type { ManagedCandidateCatalog, ManagedResolverClock } from '../core/managed-resolver/ports.ts';
import { StaticResolverPolicy, type ResolverPolicy } from '../core/managed-resolver/resolver-policy.ts';

const now = '2026-09-26T12:00:10.000Z';
const healthAt = '2026-09-26T12:00:05.000Z';
const updatedAt = '2026-09-26T12:00:00.000Z';

class FixedClock implements ManagedResolverClock {
  now(): string {
    return now;
  }
}

class TestCatalog implements ManagedCandidateCatalog {
  readonly listCalls: number[] = [];
  readonly getCalls: string[] = [];
  private readonly candidates: readonly ManagedConnectorCandidate[];
  private readonly revalidated: Readonly<Record<string, ManagedConnectorCandidate | undefined>>;

  constructor(
    candidates: readonly ManagedConnectorCandidate[],
    revalidated: Readonly<Record<string, ManagedConnectorCandidate | undefined>> = {},
  ) {
    this.candidates = candidates;
    this.revalidated = revalidated;
  }

  async list(): Promise<readonly ManagedConnectorCandidate[]> {
    this.listCalls.push(1);
    return structuredClone(this.candidates);
  }

  async get(instanceId: string): Promise<ManagedConnectorCandidate | undefined> {
    this.getCalls.push(instanceId);
    const value = Object.prototype.hasOwnProperty.call(this.revalidated, instanceId)
      ? this.revalidated[instanceId]
      : this.candidates.find((candidate) => candidate.instanceId === instanceId);
    return value === undefined ? undefined : structuredClone(value);
  }
}

function policy(overrides: Partial<ResolverPolicy> = {}): ResolverPolicy {
  return new StaticResolverPolicy({
    policyId: 'managed-resolver-policy',
    revision: 1,
    minimumHealth: 'DEGRADED',
    maxHealthAgeMs: 10_000,
    maximumFutureSkewMs: 1_000,
    instancePriorities: {},
    tieStrategy: 'STABLE_INSTANCE_ID',
    maxConsistencyRetries: 0,
    ...overrides,
  });
}

function candidate(
  instanceId: string,
  options: {
    readonly capability?: string;
    readonly definitionId?: string;
    readonly version?: string;
    readonly definitionStatus?: 'ACTIVE' | 'DEGRADED';
    readonly lifecycle?: ManagedConnectorCandidate['lifecycle']['state'];
    readonly revision?: number;
    readonly securityRevision?: number;
    readonly checksum?: string;
    readonly compatibility?: 'COMPATIBLE' | 'INCOMPATIBLE';
    readonly health?: ManagedConnectorCandidate['health'];
  } = {},
): ManagedConnectorCandidate {
  return {
    instanceId,
    definitionRef: {
      id: options.definitionId ?? 'mock.connector',
      version: options.version ?? '1.0',
    },
    capabilities: [{ id: options.capability ?? 'content.create', riskLevel: 'LOW' }],
    definitionStatus: options.definitionStatus ?? 'ACTIVE',
    lifecycle: {
      state: options.lifecycle ?? 'CONNECTED',
      revision: options.revision ?? 1,
      securityRevision: options.securityRevision ?? 1,
      updatedAt,
    },
    compatibility: {
      status: options.compatibility ?? 'COMPATIBLE',
      definitionChecksum: options.checksum ?? 'checksum-1',
      connectorRecordRevision: 1,
    },
    ...(options.health === undefined
      ? {
          health: {
            observationId: `${instanceId}-health-1`,
            sequence: 1,
            status: 'HEALTHY',
            recordedAt: healthAt,
          },
        }
      : { health: options.health }),
    policyPriority: 0,
  };
}

function request(overrides: Partial<ResolutionRequest> = {}): ResolutionRequest {
  return {
    requestId: 'resolution-1',
    correlationId: 'correlation-1',
    capability: 'content.create',
    ...overrides,
  };
}

function resolver(
  candidates: readonly ManagedConnectorCandidate[],
  policyOverrides: Partial<ResolverPolicy> = {},
  revalidated: Readonly<Record<string, ManagedConnectorCandidate | undefined>> = {},
): { resolver: ManagedResolver; catalog: TestCatalog } {
  const catalog = new TestCatalog(candidates, revalidated);
  return {
    resolver: new ManagedResolver(catalog, policy(policyOverrides), undefined, new FixedClock()),
    catalog,
  };
}

async function assertCode(
  operation: Promise<unknown>,
  code: ManagedResolverError['code'],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return error instanceof ManagedResolverError && error.code === code;
  });
}

function functionsIn(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value === 'function') return 1;
  if (typeof value !== 'object' || value === null || seen.has(value)) return 0;
  seen.add(value);
  return Object.values(value).reduce((count, entry) => count + functionsIn(entry, seen), 0);
}

test('resolves a candidate that has the exact capability', async () => {
  const { resolver: managedResolver } = resolver([candidate('managed-1')]);

  const result = await managedResolver.resolve(request());

  assert.equal(result.selected.instanceId, 'managed-1');
  assert.equal(result.selected.definitionRef.version, '1.0');
});

test('returns NO_MATCH when the catalog has no candidates', async () => {
  const { resolver: managedResolver } = resolver([]);

  await assertCode(managedResolver.resolve(request()), 'NO_MATCH');
});

test('selects HEALTHY over DEGRADED among multiple candidates', async () => {
  const { resolver: managedResolver } = resolver([
    candidate('managed-degraded', {
      health: {
        observationId: 'health-degraded',
        sequence: 1,
        status: 'DEGRADED',
        recordedAt: healthAt,
      },
    }),
    candidate('managed-healthy'),
  ]);

  assert.equal((await managedResolver.resolve(request())).selected.instanceId, 'managed-healthy');
});

test('uses instance ID as the default deterministic tie breaker', async () => {
  const { resolver: managedResolver } = resolver([candidate('managed-z'), candidate('managed-a')]);

  assert.equal((await managedResolver.resolve(request())).selected.instanceId, 'managed-a');
});

test('selects the same candidate when catalog order changes', async () => {
  const first = resolver([candidate('managed-z'), candidate('managed-a')]);
  const second = resolver([candidate('managed-a'), candidate('managed-z')]);

  const firstResult = await first.resolver.resolve(request());
  const secondResult = await second.resolver.resolve(request());

  assert.equal(firstResult.selected.instanceId, secondResult.selected.instanceId);
});

test('rejects an exactly constrained DISABLED connector', async () => {
  const { resolver: managedResolver } = resolver([candidate('managed-1', { lifecycle: 'DISABLED' })]);

  await assertCode(
    managedResolver.resolve(request({ constraints: { instanceId: 'managed-1' } })),
    'DISABLED_CONNECTOR',
  );
});

test('rejects an exactly constrained REMOVED connector', async () => {
  const { resolver: managedResolver } = resolver([candidate('managed-1', { lifecycle: 'REMOVED' })]);

  await assertCode(
    managedResolver.resolve(request({ constraints: { instanceId: 'managed-1' } })),
    'TERMINAL_CONNECTOR',
  );
});

test('rejects a REGISTERED connector', async () => {
  const { resolver: managedResolver } = resolver([candidate('managed-1', { lifecycle: 'REGISTERED' })]);

  await assertCode(managedResolver.resolve(request()), 'NO_MATCH');
});

test('rejects health that does not satisfy policy', async () => {
  const { resolver: managedResolver } = resolver([
    candidate('managed-1', {
      health: {
        observationId: 'health-unknown',
        sequence: 1,
        status: 'UNHEALTHY',
        recordedAt: healthAt,
      },
    }),
  ]);

  await assertCode(managedResolver.resolve(request()), 'UNHEALTHY_CONNECTOR');
});

test('rejects stale B3 health', async () => {
  const { resolver: managedResolver } = resolver([
    candidate('managed-1', {
      health: {
        observationId: 'health-stale',
        sequence: 1,
        status: 'HEALTHY',
        recordedAt: '2026-09-26T11:59:00.000Z',
      },
    }),
  ]);

  await assertCode(managedResolver.resolve(request()), 'STALE_HEALTH');
});

test('rejects a required version that is not exact', async () => {
  const { resolver: managedResolver } = resolver([candidate('managed-1', { version: '1.0' })]);

  await assertCode(managedResolver.resolve(request({ requiredVersion: '2.0' })), 'VERSION_CONFLICT');
});

test('matches capability IDs case-sensitively', async () => {
  const { resolver: managedResolver } = resolver([candidate('managed-1', { capability: 'Content.Create' })]);

  await assertCode(managedResolver.resolve(request()), 'NO_MATCH');
});

test('honors an exact instance constraint', async () => {
  const { resolver: managedResolver } = resolver([candidate('managed-a'), candidate('managed-b')]);

  assert.equal(
    (await managedResolver.resolve(request({ constraints: { instanceId: 'managed-b' } }))).selected
      .instanceId,
    'managed-b',
  );
});

test('honors an exact definition constraint', async () => {
  const { resolver: managedResolver } = resolver([
    candidate('managed-a', { definitionId: 'alpha.connector' }),
    candidate('managed-b', { definitionId: 'beta.connector' }),
  ]);

  assert.equal(
    (await managedResolver.resolve(request({ constraints: { definitionId: 'beta.connector' } }))).selected
      .instanceId,
    'managed-b',
  );
});

test('applies instance priority from policy', async () => {
  const { resolver: managedResolver } = resolver(
    [candidate('managed-a'), candidate('managed-b')],
    { instancePriorities: { 'managed-b': 10 } },
  );

  assert.equal((await managedResolver.resolve(request())).selected.instanceId, 'managed-b');
});

test('rejects top-ranked ties when policy requires it', async () => {
  const { resolver: managedResolver } = resolver(
    [candidate('managed-a'), candidate('managed-b')],
    { tieStrategy: 'REJECT_AMBIGUOUS' },
  );

  await assertCode(managedResolver.resolve(request()), 'AMBIGUOUS_MATCH');
});

test('does not expose credentials, secret references, or metadata', async () => {
  const { resolver: managedResolver } = resolver([candidate('managed-1')]);

  const result = await managedResolver.resolve(request());
  const serialized = JSON.stringify(result);

  assert.equal('credentials' in result, false);
  assert.equal(serialized.includes('secretRef'), false);
  assert.equal(serialized.includes('metadata'), false);
});

test('does not expose SDK objects or functions', async () => {
  const { resolver: managedResolver } = resolver([candidate('managed-1')]);

  const result = await managedResolver.resolve(request());

  assert.equal('connector' in result, false);
  assert.equal('sdk' in result, false);
  assert.equal(functionsIn(result), 0);
});

test('does not return a legacy resolver or a runtime', async () => {
  const { resolver: managedResolver } = resolver([candidate('managed-1')]);

  const result = await managedResolver.resolve(request());

  assert.equal('resolver' in result, false);
  assert.equal('runtime' in result, false);
  assert.equal('definition' in result, false);
});

test('does not execute or return execution results', async () => {
  const { catalog, resolver: managedResolver } = resolver([candidate('managed-1')]);

  const result = await managedResolver.resolve(request());

  assert.equal(catalog.listCalls.length, 1);
  assert.equal(catalog.getCalls.length, 1);
  assert.equal('execution' in result, false);
  assert.equal('result' in result, false);
});

test('returns RESOLUTION_CONFLICT when managed revision changes during revalidation', async () => {
  const initial = candidate('managed-1');
  const changed = candidate('managed-1', { revision: 2 });
  const { resolver: managedResolver } = resolver([initial], {}, { 'managed-1': changed });

  await assertCode(managedResolver.resolve(request()), 'RESOLUTION_CONFLICT');
});

test('returns RESOLUTION_CONFLICT when security revision changes during revalidation', async () => {
  const initial = candidate('managed-1');
  const changed = candidate('managed-1', { securityRevision: 2 });
  const { resolver: managedResolver } = resolver([initial], {}, { 'managed-1': changed });

  await assertCode(managedResolver.resolve(request()), 'RESOLUTION_CONFLICT');
});

test('returns RESOLUTION_CONFLICT when health sequence changes during revalidation', async () => {
  const initial = candidate('managed-1');
  const changed = candidate('managed-1', {
    health: {
      observationId: 'managed-1-health-2',
      sequence: 2,
      status: 'HEALTHY',
      recordedAt: healthAt,
    },
  });
  const { resolver: managedResolver } = resolver([initial], {}, { 'managed-1': changed });

  await assertCode(managedResolver.resolve(request()), 'RESOLUTION_CONFLICT');
});

test('returns a deeply immutable ManagedResolution', async () => {
  const { resolver: managedResolver } = resolver([candidate('managed-1')]);

  const result: ManagedResolution = await managedResolver.resolve(request());

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.selected), true);
  assert.equal(Object.isFrozen(result.selected.definitionRef), true);
  assert.throws(() => {
    (result.selected.definitionRef as { id: string }).id = 'mutated';
  }, TypeError);
});
