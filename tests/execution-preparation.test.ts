import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorizationEvaluator } from '../core/execution-preparation/authorization-evaluator.ts';
import { CredentialReadinessChecker } from '../core/execution-preparation/credential-readiness-checker.ts';
import { ExecutionPreparationService } from '../core/execution-preparation/execution-preparation-service.ts';
import type {
  AuthorizationAssessment,
  CredentialReadiness,
  ExecutionPreparationRequest,
  PermissionEvaluation,
  PreparationHealthSnapshot,
  StructuralReadinessSnapshot,
} from '../core/execution-preparation/models.ts';
import type {
  AuthorizationEvaluatorPort,
  CredentialReadinessAuthority,
  CredentialReadinessCheckerPort,
  ExecutionPreparationAuditPort,
  ExecutionPreparationClock,
  LatestPreparationHealthReader,
  StructuralReadinessReader,
} from '../core/execution-preparation/ports.ts';
import { StaticExecutionPreparationPolicy, type ExecutionPreparationPolicy } from '../core/execution-preparation/policies.ts';
import { PreparationAudit } from '../core/execution-preparation/preparation-audit.ts';

const now = '2026-09-26T12:00:10.000Z';
const updatedAt = '2026-09-26T12:00:00.000Z';
const healthAt = '2026-09-26T12:00:05.000Z';

class FixedClock implements ExecutionPreparationClock {
  now(): string {
    return now;
  }
}

class SequenceStructuralReader implements StructuralReadinessReader {
  private index = 0;
  readonly reads: string[] = [];
  private readonly snapshots: readonly StructuralReadinessSnapshot[];

  constructor(snapshots: readonly StructuralReadinessSnapshot[]) {
    this.snapshots = snapshots;
  }

  async inspect(instanceId: string): Promise<StructuralReadinessSnapshot | undefined> {
    this.reads.push(instanceId);
    const snapshot = this.snapshots[Math.min(this.index, this.snapshots.length - 1)];
    this.index += 1;
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  }
}

class SequenceHealthReader implements LatestPreparationHealthReader {
  private index = 0;
  readonly reads: string[] = [];
  private readonly snapshots: readonly PreparationHealthSnapshot[];

  constructor(snapshots: readonly PreparationHealthSnapshot[]) {
    this.snapshots = snapshots;
  }

  async getLatest(instanceId: string): Promise<PreparationHealthSnapshot | undefined> {
    this.reads.push(instanceId);
    const snapshot = this.snapshots[Math.min(this.index, this.snapshots.length - 1)];
    this.index += 1;
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  }
}

class FixedAuthorizationEvaluator implements AuthorizationEvaluatorPort {
  private readonly authorization: AuthorizationAssessment;
  private readonly permissions: PermissionEvaluation;

  constructor(
    decision: AuthorizationAssessment['decision'] = 'ALLOW',
    permissions: PermissionEvaluation = {
      status: 'SATISFIED',
      requiredCount: 1,
      missingCount: 0,
      evaluatedAt: now,
    },
    expiresAt = '2026-09-26T12:00:50.000Z',
  ) {
    this.authorization = {
      evaluationId: 'authorization-1',
      decision,
      policy: { id: 'authorization-policy', revision: 1 },
      evaluatedAt: now,
      notBefore: now,
      expiresAt,
    };
    this.permissions = permissions;
  }

  async evaluate(): Promise<{ readonly authorization: AuthorizationAssessment; readonly permissions: PermissionEvaluation }> {
    return { authorization: structuredClone(this.authorization), permissions: structuredClone(this.permissions) };
  }
}

class FixedCredentialChecker implements CredentialReadinessCheckerPort {
  readonly checks: number[] = [];
  private readonly result: CredentialReadiness;

  constructor(result: CredentialReadiness = { status: 'NOT_REQUIRED', checkedAt: now, credentials: [] }) {
    this.result = result;
  }

  async check(): Promise<CredentialReadiness> {
    this.checks.push(1);
    return structuredClone(this.result);
  }
}

class SafeAuditPort implements ExecutionPreparationAuditPort {
  readonly requested: unknown[] = [];
  readonly outcomes: unknown[] = [];
  failOutcome = false;

  async recordRequested(event: Parameters<ExecutionPreparationAuditPort['recordRequested']>[0]): Promise<{ readonly eventId: string }> {
    this.requested.push(structuredClone(event));
    return { eventId: 'requested-event-1' };
  }

  async recordOutcome(event: Parameters<ExecutionPreparationAuditPort['recordOutcome']>[0]): Promise<{ readonly eventId: string }> {
    if (this.failOutcome) throw new Error('audit failure');
    this.outcomes.push(structuredClone(event));
    return { eventId: 'outcome-event-1' };
  }
}

function policy(overrides: Partial<ExecutionPreparationPolicy> = {}): ExecutionPreparationPolicy {
  return new StaticExecutionPreparationPolicy({
    policyId: 'preparation-policy',
    revision: 1,
    maxHealthAgeMs: 10_000,
    maximumFutureSkewMs: 1_000,
    maxPreparationTtlMs: 5_000,
    maxAuthorizationAgeMs: 10_000,
    ...overrides,
  });
}

function structural(
  overrides: Partial<StructuralReadinessSnapshot> & {
    readonly lifecycle?: Partial<StructuralReadinessSnapshot['lifecycle']>;
  } = {},
): StructuralReadinessSnapshot {
  return {
    instanceId: 'managed-1',
    definitionRef: { id: 'mock.connector', version: '1.0' },
    lifecycle: { state: 'CONNECTED', updatedAt, ...overrides.lifecycle },
    revision: 1,
    securityRevision: 1,
    capabilities: [{ id: 'content.create', riskLevel: 'LOW' }],
    permissions: ['connector.execute'],
    credentialRequirement: 'OPTIONAL',
    credentialReferences: [],
    connectorRecordRevision: 1,
    definitionChecksum: 'checksum-1',
    ...overrides,
  };
}

function health(overrides: Partial<PreparationHealthSnapshot> = {}): PreparationHealthSnapshot {
  return {
    observationId: 'health-1',
    sequence: 1,
    status: 'HEALTHY',
    recordedAt: healthAt,
    definitionRef: { id: 'mock.connector', version: '1.0' },
    ...overrides,
  };
}

function preparationRequest(
  snapshot: StructuralReadinessSnapshot,
  latest: PreparationHealthSnapshot,
  overrides: Partial<ExecutionPreparationRequest> = {},
): ExecutionPreparationRequest {
  return {
    requestId: 'preparation-1',
    correlationId: 'correlation-1',
    managedResolution: {
      requestId: 'resolution-1',
      capability: 'content.create',
      selected: {
        instanceId: snapshot.instanceId,
        definitionRef: { id: snapshot.definitionRef.id, version: snapshot.definitionRef.version },
        expectedRevision: snapshot.revision,
        expectedSecurityRevision: snapshot.securityRevision,
      },
      healthEvidence: {
        observationId: latest.observationId,
        sequence: latest.sequence,
        status: latest.status === 'DEGRADED' ? 'DEGRADED' : 'HEALTHY',
        recordedAt: latest.recordedAt,
      },
      policy: { policyId: 'managed-policy', revision: 1 },
      resolvedAt: '2026-09-26T12:00:06.000Z',
      validUntil: '2026-09-26T12:00:30.000Z',
    },
    capability: 'content.create',
    operation: 'EXECUTE_CONNECTOR',
    actor: { actorId: 'actor-1' },
    context: { executionId: 'execution-1', planId: 'plan-1', skillRef: { id: 'skill-1', version: '1.0' } },
    ...overrides,
  };
}

function setup(options: {
  readonly structuralSnapshots?: readonly StructuralReadinessSnapshot[];
  readonly healthSnapshots?: readonly PreparationHealthSnapshot[];
  readonly authorizationEvaluator?: AuthorizationEvaluatorPort;
  readonly credentialChecker?: CredentialReadinessCheckerPort;
  readonly policy?: ExecutionPreparationPolicy;
} = {}) {
  const structuralSnapshots = options.structuralSnapshots ?? [structural()];
  const healthSnapshots = options.healthSnapshots ?? [health()];
  const structuralReader = new SequenceStructuralReader(structuralSnapshots);
  const healthReader = new SequenceHealthReader(healthSnapshots);
  const auditPort = new SafeAuditPort();
  const service = new ExecutionPreparationService(
    structuralReader,
    healthReader,
    options.authorizationEvaluator ?? new FixedAuthorizationEvaluator(),
    options.credentialChecker ?? new FixedCredentialChecker(),
    new PreparationAudit(auditPort),
    options.policy ?? policy(),
    undefined,
    new FixedClock(),
  );
  return { service, auditPort, structuralReader, healthReader, structural: structuralSnapshots[0]!, health: healthSnapshots[0]! };
}

test('returns READY for a fully prepared managed resolution', async () => {
  const fixture = setup();

  const result = await fixture.service.prepare(preparationRequest(fixture.structural, fixture.health));

  assert.equal(result.status, 'READY');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.audit.requestedEventId, 'requested-event-1');
});

test('returns NOT_READY for a missing credential', async () => {
  const snapshot = structural({
    credentialRequirement: 'REQUIRED',
    credentialReferences: [{ credentialId: 'credential-1', providerId: 'provider-1', revision: 1 }],
  });
  const checker = new CredentialReadinessChecker({
    inspect: async () => ({ exists: false, ownershipMatches: false, referenceMatches: false, purposeMatches: false, status: 'REGISTERED' }),
  });
  const fixture = setup({ structuralSnapshots: [snapshot], credentialChecker: checker });

  const result = await fixture.service.prepare(preparationRequest(snapshot, fixture.health));

  assert.equal(result.status, 'NOT_READY');
  assert.deepEqual(result.reasons, ['CREDENTIAL_NOT_READY']);
});

test('returns DENIED when authorization denies', async () => {
  const fixture = setup({ authorizationEvaluator: new FixedAuthorizationEvaluator('DENY') });

  const result = await fixture.service.prepare(preparationRequest(fixture.structural, fixture.health));

  assert.equal(result.status, 'DENIED');
  assert.deepEqual(result.reasons, ['AUTHORIZATION_DENIED']);
});

test('denies a missing combined skill or connector permission', async () => {
  const authorization = new AuthorizationEvaluator(
    {
      read: async () => ({
        actorActive: true,
        actorPermissions: ['content.write'],
        skillActive: true,
        skillCapability: 'content.create',
        skillPermissions: ['content.write'],
        explicitDeny: false,
        approvalGranted: false,
        evaluatedAt: now,
      }),
    },
    policy(),
  );
  const fixture = setup({ authorizationEvaluator: authorization });

  const result = await fixture.service.prepare(preparationRequest(fixture.structural, fixture.health));

  assert.equal(result.status, 'DENIED');
  assert.equal(result.permissions.status, 'MISSING');
});

test('never prepares a REMOVED connector', async () => {
  const snapshot = structural({ lifecycle: { state: 'REMOVED', updatedAt } });
  const fixture = setup({ structuralSnapshots: [snapshot] });

  const result = await fixture.service.prepare(preparationRequest(snapshot, fixture.health));

  assert.equal(result.status, 'NOT_READY');
  assert.deepEqual(result.reasons, ['INVALID_LIFECYCLE']);
});

test('never prepares an invalid lifecycle state', async () => {
  const snapshot = structural({ lifecycle: { state: 'REGISTERED', updatedAt } });
  const fixture = setup({ structuralSnapshots: [snapshot] });

  const result = await fixture.service.prepare(preparationRequest(snapshot, fixture.health));

  assert.equal(result.status, 'NOT_READY');
  assert.deepEqual(result.reasons, ['INVALID_LIFECYCLE']);
});

test('returns NOT_READY on a final runtime consistency conflict', async () => {
  const initial = structural();
  const changed = structural({ connectorRecordRevision: 2 });
  const fixture = setup({ structuralSnapshots: [initial, changed] });

  const result = await fixture.service.prepare(preparationRequest(initial, fixture.health));

  assert.equal(result.status, 'NOT_READY');
  assert.deepEqual(result.reasons, ['RUNTIME_CONFLICT']);
});

test('returns NOT_READY for an expired authorization', async () => {
  const fixture = setup({ authorizationEvaluator: new FixedAuthorizationEvaluator('ALLOW', undefined, now) });

  const result = await fixture.service.prepare(preparationRequest(fixture.structural, fixture.health));

  assert.equal(result.status, 'NOT_READY');
  assert.deepEqual(result.reasons, ['AUTHORIZATION_EXPIRED']);
});

test('returns NOT_READY when B3 health sequence changes', async () => {
  const initial = health();
  const changed = health({ observationId: 'health-2', sequence: 2 });
  const fixture = setup({ healthSnapshots: [initial, changed] });

  const result = await fixture.service.prepare(preparationRequest(fixture.structural, initial));

  assert.equal(result.status, 'NOT_READY');
  assert.deepEqual(result.reasons, ['HEALTH_CONFLICT']);
});

test('returns NOT_READY for stale B3 health', async () => {
  const snapshot = structural({ lifecycle: { state: 'CONNECTED', updatedAt: '2026-09-26T11:00:00.000Z' } });
  const stale = health({ recordedAt: '2026-09-26T11:59:00.000Z' });
  const fixture = setup({ structuralSnapshots: [snapshot], healthSnapshots: [stale] });

  const result = await fixture.service.prepare(preparationRequest(snapshot, stale));

  assert.equal(result.status, 'NOT_READY');
  assert.deepEqual(result.reasons, ['HEALTH_EXPIRED']);
});

test('returns NOT_READY for a capability mismatch', async () => {
  const fixture = setup();
  const request = preparationRequest(fixture.structural, fixture.health, { capability: 'content.delete' });

  const result = await fixture.service.prepare(request);

  assert.equal(result.status, 'NOT_READY');
  assert.deepEqual(result.reasons, ['REFERENCE_CONFLICT']);
});

test('returns NOT_READY for a definition mismatch', async () => {
  const fixture = setup();
  const initial = preparationRequest(fixture.structural, fixture.health);
  const request: ExecutionPreparationRequest = {
    ...initial,
    managedResolution: {
      ...initial.managedResolution,
      selected: {
        ...initial.managedResolution.selected,
        definitionRef: { id: 'other.connector', version: '1.0' },
      },
    },
  };

  const result = await fixture.service.prepare(request);

  assert.equal(result.status, 'NOT_READY');
  assert.deepEqual(result.reasons, ['REFERENCE_CONFLICT']);
});

test('returns NOT_READY for a managed revision mismatch', async () => {
  const fixture = setup();
  const initial = preparationRequest(fixture.structural, fixture.health);
  const request: ExecutionPreparationRequest = {
    ...initial,
    managedResolution: {
      ...initial.managedResolution,
      selected: { ...initial.managedResolution.selected, expectedRevision: 2 },
    },
  };

  const result = await fixture.service.prepare(request);

  assert.equal(result.status, 'NOT_READY');
  assert.deepEqual(result.reasons, ['REFERENCE_CONFLICT']);
});

test('returns NOT_READY for a security revision mismatch', async () => {
  const fixture = setup();
  const initial = preparationRequest(fixture.structural, fixture.health);
  const request: ExecutionPreparationRequest = {
    ...initial,
    managedResolution: {
      ...initial.managedResolution,
      selected: { ...initial.managedResolution.selected, expectedSecurityRevision: 2 },
    },
  };

  const result = await fixture.service.prepare(request);

  assert.equal(result.status, 'NOT_READY');
  assert.deepEqual(result.reasons, ['REFERENCE_CONFLICT']);
});

test('returns NOT_READY while approval is required', async () => {
  const fixture = setup({ authorizationEvaluator: new FixedAuthorizationEvaluator('REQUIRE_APPROVAL') });

  const result = await fixture.service.prepare(preparationRequest(fixture.structural, fixture.health));

  assert.equal(result.status, 'NOT_READY');
  assert.deepEqual(result.reasons, ['APPROVAL_REQUIRED']);
});

test('allows an OPTIONAL credential requirement with no references', async () => {
  const checker = new FixedCredentialChecker({ status: 'NOT_REQUIRED', checkedAt: now, credentials: [] });
  const fixture = setup({ credentialChecker: checker });

  const result = await fixture.service.prepare(preparationRequest(fixture.structural, fixture.health));

  assert.equal(result.status, 'READY');
  assert.equal(result.credentials.status, 'NOT_REQUIRED');
});

test('rejects a REQUIRED credential requirement with no references', async () => {
  const snapshot = structural({ credentialRequirement: 'REQUIRED' });
  const fixture = setup({ structuralSnapshots: [snapshot], credentialChecker: new CredentialReadinessChecker({ inspect: async () => { throw new Error('must not inspect'); } }) });

  const result = await fixture.service.prepare(preparationRequest(snapshot, fixture.health));

  assert.equal(result.status, 'NOT_READY');
  assert.equal(result.credentials.status, 'NOT_READY');
});

test('rejects a credential that belongs to another connector', async () => {
  const snapshot = structural({
    credentialRequirement: 'REQUIRED',
    credentialReferences: [{ credentialId: 'credential-1', providerId: 'provider-1', revision: 1 }],
  });
  const authority: CredentialReadinessAuthority = {
    inspect: async () => ({ exists: true, ownershipMatches: false, referenceMatches: true, purposeMatches: true, status: 'ACTIVE' }),
  };
  const fixture = setup({ structuralSnapshots: [snapshot], credentialChecker: new CredentialReadinessChecker(authority) });

  const result = await fixture.service.prepare(preparationRequest(snapshot, fixture.health));

  assert.equal(result.status, 'NOT_READY');
  assert.equal(result.credentials.credentials[0]?.status, 'NOT_READY');
});

test('never acquires a credential lease during readiness', async () => {
  let acquireLeaseCalls = 0;
  const snapshot = structural({
    credentialRequirement: 'REQUIRED',
    credentialReferences: [{ credentialId: 'credential-1', providerId: 'provider-1', revision: 1 }],
  });
  const authority: CredentialReadinessAuthority & { acquireLease(): void } = {
    inspect: async () => ({ exists: true, ownershipMatches: true, referenceMatches: true, purposeMatches: true, status: 'ACTIVE' }),
    acquireLease: () => { acquireLeaseCalls += 1; },
  };
  const fixture = setup({ structuralSnapshots: [snapshot], credentialChecker: new CredentialReadinessChecker(authority) });

  await fixture.service.prepare(preparationRequest(snapshot, fixture.health));

  assert.equal(acquireLeaseCalls, 0);
});

test('does not expose SDK objects or functions', async () => {
  const fixture = setup();
  const result = await fixture.service.prepare(preparationRequest(fixture.structural, fixture.health));

  assert.equal('sdk' in result, false);
  assert.equal('connector' in result, false);
  assert.equal(countFunctions(result), 0);
});

test('does not expose a legacy resolver or runtime', async () => {
  const fixture = setup();
  const result = await fixture.service.prepare(preparationRequest(fixture.structural, fixture.health));

  assert.equal('resolver' in result, false);
  assert.equal('runtime' in result, false);
});

test('does not mutate lifecycle through its read-only structural port', async () => {
  const fixture = setup();
  await fixture.service.prepare(preparationRequest(fixture.structural, fixture.health));

  assert.deepEqual(fixture.structuralReader.reads, ['managed-1', 'managed-1']);
  assert.equal('transitionLifecycle' in fixture.structuralReader, false);
});

test('records safe Requested then terminal audit events', async () => {
  const fixture = setup();
  await fixture.service.prepare(preparationRequest(fixture.structural, fixture.health));

  assert.equal((fixture.auditPort.requested[0] as { eventType: string }).eventType, 'ExecutionPreparationRequested');
  assert.equal((fixture.auditPort.outcomes[0] as { eventType: string }).eventType, 'ExecutionPreparationApproved');
  const serialized = JSON.stringify([...fixture.auditPort.requested, ...fixture.auditPort.outcomes]);
  assert.equal(serialized.includes('secretRef'), false);
  assert.equal(serialized.includes('token'), false);
});

test('returns a deeply immutable result', async () => {
  const fixture = setup();
  const result = await fixture.service.prepare(preparationRequest(fixture.structural, fixture.health));

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.referenceAssessment.reference), true);
  assert.throws(() => {
    (result.referenceAssessment.reference.definitionRef as { id: string }).id = 'mutated';
  }, TypeError);
});

test('does not leak secret, token, lease, or raw credential fields', async () => {
  const fixture = setup();
  const result = await fixture.service.prepare(preparationRequest(fixture.structural, fixture.health));
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('token'), false);
  assert.equal(serialized.includes('lease'), false);
  assert.equal(serialized.includes('providerId'), false);
});

function countFunctions(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value === 'function') return 1;
  if (typeof value !== 'object' || value === null || seen.has(value)) return 0;
  seen.add(value);
  return Object.values(value).reduce((count, child) => count + countFunctions(child, seen), 0);
}
