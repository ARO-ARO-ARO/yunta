import { ExecutionPreparationError } from './errors.ts';
import type {
  AuthorizationAssessment,
  CredentialReadiness,
  ExecutionPreparationRequest,
  ExecutionPreparationResult,
  PermissionEvaluation,
  PreparationHealthSnapshot,
  PreparationReasonCode,
  StructuralReadinessSnapshot,
} from './models.ts';
import type {
  AuthorizationEvaluatorPort,
  CredentialReadinessCheckerPort,
  ExecutionPreparationClock,
  LatestPreparationHealthReader,
  StructuralReadinessReader,
} from './ports.ts';
import type { ExecutionPreparationPolicy } from './policies.ts';
import { PreparationAudit } from './preparation-audit.ts';
import { ExecutionPreparationValidator } from './validator.ts';

const systemClock: ExecutionPreparationClock = { now: () => new Date().toISOString() };

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function notEvaluated(): {
  readonly permissions: PermissionEvaluation;
  readonly credentials: CredentialReadiness;
  readonly authorization: AuthorizationAssessment;
} {
  return {
    permissions: { status: 'NOT_EVALUATED', requiredCount: 0, missingCount: 0 },
    credentials: { status: 'NOT_EVALUATED', credentials: [] },
    authorization: { decision: 'NOT_EVALUATED' },
  };
}

export class ExecutionPreparationService {
  private readonly structuralReader: StructuralReadinessReader;
  private readonly healthReader: LatestPreparationHealthReader;
  private readonly authorizationEvaluator: AuthorizationEvaluatorPort;
  private readonly credentialChecker: CredentialReadinessCheckerPort;
  private readonly audit: PreparationAudit;
  private readonly policy: ExecutionPreparationPolicy;
  private readonly validator: ExecutionPreparationValidator;
  private readonly clock: ExecutionPreparationClock;

  constructor(
    structuralReader: StructuralReadinessReader,
    healthReader: LatestPreparationHealthReader,
    authorizationEvaluator: AuthorizationEvaluatorPort,
    credentialChecker: CredentialReadinessCheckerPort,
    audit: PreparationAudit,
    policy: ExecutionPreparationPolicy,
    validator: ExecutionPreparationValidator = new ExecutionPreparationValidator(),
    clock: ExecutionPreparationClock = systemClock,
  ) {
    this.structuralReader = structuralReader;
    this.healthReader = healthReader;
    this.authorizationEvaluator = authorizationEvaluator;
    this.credentialChecker = credentialChecker;
    this.audit = audit;
    this.policy = policy;
    this.validator = validator;
    this.clock = clock;
  }

  async prepare(request: ExecutionPreparationRequest): Promise<ExecutionPreparationResult> {
    this.validator.validateRequest(request);
    const reference = request.managedResolution.selected;
    const preparedAt = this.clock.now();
    const requested = await this.recordRequested(request, preparedAt);
    const defaults = notEvaluated();

    if (
      request.capability !== request.managedResolution.capability ||
      this.isExpired(request.managedResolution.validUntil, preparedAt)
    ) {
      return this.finish(
        request,
        requested.eventId,
        'NOT_READY',
        request.capability !== request.managedResolution.capability
          ? ['REFERENCE_CONFLICT']
          : ['RESOLUTION_EXPIRED'],
        preparedAt,
        request.managedResolution.validUntil,
        defaults,
      );
    }

    let structural: StructuralReadinessSnapshot | undefined;
    try {
      structural = await this.structuralReader.inspect(reference.instanceId);
      if (structural !== undefined) this.validator.validateStructural(structural);
    } catch {
      return this.finish(request, requested.eventId, 'NOT_READY', ['RUNTIME_CONFLICT'], preparedAt, preparedAt, defaults);
    }
    if (!structural || !this.matchesReference(structural, request)) {
      return this.finish(request, requested.eventId, 'NOT_READY', ['REFERENCE_CONFLICT'], preparedAt, preparedAt, defaults);
    }
    if (!this.validator.isEligibleLifecycle(structural)) {
      return this.finish(request, requested.eventId, 'NOT_READY', ['INVALID_LIFECYCLE'], preparedAt, preparedAt, defaults, structural);
    }
    if (!structural.capabilities.some((capability) => capability.id === request.capability)) {
      return this.finish(request, requested.eventId, 'NOT_READY', ['CAPABILITY_MISMATCH'], preparedAt, preparedAt, defaults, structural);
    }

    const health = await this.readHealth(request, structural, preparedAt);
    if (health === undefined) {
      return this.finish(request, requested.eventId, 'NOT_READY', ['HEALTH_CONFLICT'], preparedAt, preparedAt, defaults, structural);
    }
    const healthExpiry = new Date(Date.parse(health.recordedAt) + this.policy.maxHealthAgeMs).toISOString();
    if (this.isExpired(healthExpiry, preparedAt)) {
      return this.finish(request, requested.eventId, 'NOT_READY', ['HEALTH_EXPIRED'], preparedAt, healthExpiry, defaults, structural);
    }

    let authorization: AuthorizationAssessment;
    let permissions: PermissionEvaluation;
    try {
      ({ authorization, permissions } = await this.authorizationEvaluator.evaluate({
        actorId: request.actor.actorId,
        skillRef: request.context.skillRef,
        capability: request.capability,
        operation: request.operation,
        structural,
      }));
    } catch {
      return this.finish(request, requested.eventId, 'NOT_READY', ['DEPENDENCY_UNAVAILABLE'], preparedAt, healthExpiry, defaults, structural);
    }
    const afterAuthorization = { ...defaults, authorization, permissions };
    if (authorization.decision === 'DENY') {
      return this.finish(request, requested.eventId, 'DENIED', ['AUTHORIZATION_DENIED'], preparedAt, healthExpiry, afterAuthorization, structural);
    }
    if (authorization.decision === 'REQUIRE_APPROVAL') {
      return this.finish(request, requested.eventId, 'NOT_READY', ['APPROVAL_REQUIRED'], preparedAt, healthExpiry, afterAuthorization, structural);
    }
    if (
      authorization.decision !== 'ALLOW' ||
      authorization.notBefore === undefined ||
      authorization.expiresAt === undefined ||
      this.isBefore(authorization.notBefore, preparedAt) ||
      this.isExpired(authorization.expiresAt, preparedAt)
    ) {
      return this.finish(request, requested.eventId, 'NOT_READY', ['AUTHORIZATION_EXPIRED'], preparedAt, healthExpiry, afterAuthorization, structural);
    }

    let credentials: CredentialReadiness;
    try {
      credentials = await this.credentialChecker.check({
        capability: request.capability,
        operation: request.operation,
        structural,
        checkedAt: preparedAt,
      });
    } catch {
      return this.finish(request, requested.eventId, 'NOT_READY', ['DEPENDENCY_UNAVAILABLE'], preparedAt, healthExpiry, afterAuthorization, structural);
    }
    const assessed = { authorization, permissions, credentials };
    if (credentials.status === 'NOT_READY') {
      return this.finish(request, requested.eventId, 'NOT_READY', ['CREDENTIAL_NOT_READY'], preparedAt, healthExpiry, assessed, structural);
    }

    const expiresAt = this.expiration(request, healthExpiry, authorization, credentials, preparedAt);
    if (this.isExpired(expiresAt, preparedAt)) {
      return this.finish(request, requested.eventId, 'NOT_READY', ['HEALTH_EXPIRED'], preparedAt, expiresAt, assessed, structural);
    }
    const revalidationReason = await this.revalidationReason(request, structural, health);
    if (revalidationReason !== undefined) {
      return this.finish(request, requested.eventId, 'NOT_READY', [revalidationReason], preparedAt, expiresAt, assessed, structural);
    }
    return this.finish(request, requested.eventId, 'READY', [], preparedAt, expiresAt, assessed, structural);
  }

  private async recordRequested(request: ExecutionPreparationRequest, occurredAt: string): Promise<{ readonly eventId: string }> {
    try {
      return await this.audit.recordRequested({
        eventType: 'ExecutionPreparationRequested',
        requestId: request.requestId,
        correlationId: request.correlationId,
        executionId: request.context.executionId,
        actorId: request.actor.actorId,
        capability: request.capability,
        operation: request.operation,
        reference: request.managedResolution.selected,
        occurredAt,
      });
    } catch {
      throw new ExecutionPreparationError(
        'AUDIT_PERSISTENCE_FAILED',
        'Preparation request audit could not persist',
        request.requestId,
      );
    }
  }

  private async readHealth(
    request: ExecutionPreparationRequest,
    structural: StructuralReadinessSnapshot,
    preparedAt: string,
  ): Promise<PreparationHealthSnapshot | undefined> {
    let health: PreparationHealthSnapshot | undefined;
    try {
      health = await this.healthReader.getLatest(structural.instanceId);
    } catch {
      return undefined;
    }
    if (!health) return undefined;
    const expected = request.managedResolution.healthEvidence;
    const recordedAt = Date.parse(health.recordedAt);
    const lifecycleUpdatedAt = Date.parse(structural.lifecycle.updatedAt);
    const now = Date.parse(preparedAt);
    if (
      health.observationId !== expected.observationId ||
      health.sequence !== expected.sequence ||
      health.status !== expected.status ||
      health.definitionRef.id !== structural.definitionRef.id ||
      health.definitionRef.version !== structural.definitionRef.version ||
      Number.isNaN(recordedAt) ||
      Number.isNaN(lifecycleUpdatedAt) ||
      Number.isNaN(now) ||
      recordedAt < lifecycleUpdatedAt ||
      recordedAt > now + this.policy.maximumFutureSkewMs
    ) {
      return undefined;
    }
    return health;
  }

  private matchesReference(
    structural: StructuralReadinessSnapshot,
    request: ExecutionPreparationRequest,
  ): boolean {
    const reference = request.managedResolution.selected;
    return (
      structural.instanceId === reference.instanceId &&
      structural.definitionRef.id === reference.definitionRef.id &&
      structural.definitionRef.version === reference.definitionRef.version &&
      structural.revision === reference.expectedRevision &&
      structural.securityRevision === reference.expectedSecurityRevision
    );
  }

  private async revalidationReason(
    request: ExecutionPreparationRequest,
    initialStructural: StructuralReadinessSnapshot,
    initialHealth: PreparationHealthSnapshot,
  ): Promise<PreparationReasonCode | undefined> {
    try {
      const structural = await this.structuralReader.inspect(initialStructural.instanceId);
      const health = await this.healthReader.getLatest(initialStructural.instanceId);
      if (
        structural === undefined ||
        !this.matchesReference(structural, request) ||
        structural.lifecycle.state !== initialStructural.lifecycle.state ||
        structural.connectorRecordRevision !== initialStructural.connectorRecordRevision ||
        structural.definitionChecksum !== initialStructural.definitionChecksum
      ) {
        return 'RUNTIME_CONFLICT';
      }
      if (
        health === undefined ||
        health.observationId !== initialHealth.observationId ||
        health.sequence !== initialHealth.sequence
      ) {
        return 'HEALTH_CONFLICT';
      }
      return undefined;
    } catch {
      return 'RUNTIME_CONFLICT';
    }
  }

  private expiration(
    request: ExecutionPreparationRequest,
    healthExpiry: string,
    authorization: AuthorizationAssessment,
    credentials: CredentialReadiness,
    preparedAt: string,
  ): string {
    const candidates = [
      request.managedResolution.validUntil,
      healthExpiry,
      authorization.expiresAt!,
      new Date(Date.parse(preparedAt) + this.policy.maxPreparationTtlMs).toISOString(),
      ...credentials.credentials.flatMap((credential) =>
        credential.expiresAt === undefined ? [] : [credential.expiresAt],
      ),
    ];
    return candidates.sort((left, right) => Date.parse(left) - Date.parse(right))[0]!;
  }

  private isExpired(expiresAt: string, now: string): boolean {
    const expiry = Date.parse(expiresAt);
    const current = Date.parse(now);
    return Number.isNaN(expiry) || Number.isNaN(current) || current >= expiry;
  }

  private isBefore(notBefore: string, now: string): boolean {
    const start = Date.parse(notBefore);
    const current = Date.parse(now);
    return Number.isNaN(start) || Number.isNaN(current) || current < start;
  }

  private async finish(
    request: ExecutionPreparationRequest,
    requestedEventId: string,
    status: ExecutionPreparationResult['status'],
    reasons: readonly PreparationReasonCode[],
    preparedAt: string,
    expiresAt: string,
    assessments: {
      readonly authorization: AuthorizationAssessment;
      readonly permissions: PermissionEvaluation;
      readonly credentials: CredentialReadiness;
    },
    structural?: StructuralReadinessSnapshot,
  ): Promise<ExecutionPreparationResult> {
    const referenceStatus = reasons.includes('REFERENCE_CONFLICT') ? 'CONFLICT' : 'VALIDATED';
    let outcomeEventId: string;
    try {
      const outcome = await this.audit.recordOutcome({
        eventType: status === 'READY' ? 'ExecutionPreparationApproved' : 'ExecutionPreparationDenied',
        requestId: request.requestId,
        requestedEventId,
        correlationId: request.correlationId,
        executionId: request.context.executionId,
        actorId: request.actor.actorId,
        capability: request.capability,
        operation: request.operation,
        status,
        reference: request.managedResolution.selected,
        reasons,
        expiresAt,
        occurredAt: preparedAt,
      });
      outcomeEventId = outcome.eventId;
    } catch {
      throw new ExecutionPreparationError(
        'AUDIT_PERSISTENCE_FAILED',
        'Preparation outcome audit could not persist',
        request.requestId,
      );
    }
    return freeze(structuredClone({
      requestId: request.requestId,
      correlationId: request.correlationId,
      executionId: request.context.executionId,
      status,
      capability: request.capability,
      operation: request.operation,
      referenceAssessment: {
        reference: request.managedResolution.selected,
        status: referenceStatus,
      },
      ...(structural === undefined ||
      !['CONNECTED', 'HEALTHY', 'DEGRADED'].includes(structural.lifecycle.state)
        ? {}
        : {
            structuralEvidence: {
              lifecycleState: structural.lifecycle.state as 'CONNECTED' | 'HEALTHY' | 'DEGRADED',
              connectorRecordRevision: structural.connectorRecordRevision,
              definitionChecksum: structural.definitionChecksum,
            },
          }),
      permissions: assessments.permissions,
      credentials: assessments.credentials,
      authorization: assessments.authorization,
      reasons: [...reasons],
      audit: { requestedEventId, outcomeEventId },
      preparedAt,
      expiresAt,
    }));
  }
}
