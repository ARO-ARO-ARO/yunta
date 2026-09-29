import { ManagedResolverError, type ManagedResolverErrorCode } from './errors.ts';
import type {
  ManagedConnectorCandidate,
  ManagedResolution,
  ResolutionRequest,
} from './models.ts';
import type { ManagedCandidateCatalog, ManagedResolverClock } from './ports.ts';
import {
  healthMeetsMinimum,
  isDefinitionAllowed,
  priorityFor,
  type ResolverPolicy,
} from './resolver-policy.ts';
import { ResolverValidator } from './resolver-validator.ts';

const systemClock: ManagedResolverClock = {
  now: () => new Date().toISOString(),
};

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function context(request: ResolutionRequest, instanceId?: string) {
  return {
    requestId: request.requestId,
    capability: request.capability,
    ...(instanceId === undefined ? {} : { instanceId }),
  };
}

function sameCandidate(
  initial: ManagedConnectorCandidate,
  current: ManagedConnectorCandidate,
): boolean {
  return (
    initial.instanceId === current.instanceId &&
    initial.definitionRef.id === current.definitionRef.id &&
    initial.definitionRef.version === current.definitionRef.version &&
    initial.lifecycle.revision === current.lifecycle.revision &&
    initial.lifecycle.securityRevision === current.lifecycle.securityRevision &&
    initial.compatibility.definitionChecksum === current.compatibility.definitionChecksum &&
    initial.compatibility.connectorRecordRevision === current.compatibility.connectorRecordRevision &&
    initial.health?.observationId === current.health?.observationId &&
    initial.health?.sequence === current.health?.sequence
  );
}

function healthRank(candidate: ManagedConnectorCandidate): number {
  return candidate.health?.status === 'HEALTHY' ? 1 : 0;
}

function definitionRank(candidate: ManagedConnectorCandidate): number {
  return candidate.definitionStatus === 'ACTIVE' ? 1 : 0;
}

export class ManagedResolver {
  private readonly catalog: ManagedCandidateCatalog;
  private readonly policy: ResolverPolicy;
  private readonly validator: ResolverValidator;
  private readonly clock: ManagedResolverClock;

  constructor(
    catalog: ManagedCandidateCatalog,
    policy: ResolverPolicy,
    validator: ResolverValidator = new ResolverValidator(),
    clock: ManagedResolverClock = systemClock,
  ) {
    this.catalog = catalog;
    this.policy = policy;
    this.validator = validator;
    this.clock = clock;
  }

  async resolve(request: ResolutionRequest): Promise<ManagedResolution> {
    this.validator.validateRequest(request);
    for (let attempt = 0; attempt <= this.policy.maxConsistencyRetries; attempt += 1) {
      const resolvedAt = this.clock.now();
      const candidates = await this.loadCandidates(request);
      const selected = this.select(candidates, request, resolvedAt);
      const current = await this.revalidate(selected, request);
      if (current !== undefined && sameCandidate(selected, current)) {
        return this.result(request, selected, resolvedAt);
      }
    }
    throw new ManagedResolverError(
      'RESOLUTION_CONFLICT',
      'Managed connector changed during resolution',
      context(request),
    );
  }

  private async loadCandidates(request: ResolutionRequest): Promise<readonly ManagedConnectorCandidate[]> {
    try {
      const candidates = await this.catalog.list(this.policy);
      const prioritized = candidates.map((candidate) => ({
        ...candidate,
        policyPriority: priorityFor(this.policy, candidate.instanceId),
      }));
      prioritized.forEach((candidate) => this.validator.validateCandidate(candidate));
      return prioritized;
    } catch (error) {
      if (error instanceof ManagedResolverError) throw error;
      throw new ManagedResolverError(
        'RESOLUTION_DEPENDENCY_FAILED',
        'Managed candidate catalog is unavailable',
        context(request),
      );
    }
  }

  private select(
    catalogCandidates: readonly ManagedConnectorCandidate[],
    request: ResolutionRequest,
    decisionTime: string,
  ): ManagedConnectorCandidate {
    let candidates = [...catalogCandidates];
    if (request.constraints?.instanceId !== undefined) {
      const exact = candidates.find((candidate) => candidate.instanceId === request.constraints!.instanceId);
      if (exact === undefined) {
        throw new ManagedResolverError(
          'CONNECTOR_NOT_FOUND',
          'Managed connector was not found',
          context(request, request.constraints.instanceId),
        );
      }
      candidates = [exact];
    }
    if (request.constraints?.definitionId !== undefined) {
      candidates = candidates.filter(
        (candidate) => candidate.definitionRef.id === request.constraints!.definitionId,
      );
      if (candidates.length === 0) this.noMatch(request);
    }
    if (request.requiredVersion !== undefined) {
      candidates = candidates.filter(
        (candidate) => candidate.definitionRef.version === request.requiredVersion,
      );
      if (candidates.length === 0) {
        throw new ManagedResolverError(
          'VERSION_CONFLICT',
          'No managed connector satisfies the required version',
          context(request),
        );
      }
    }

    const lifecycleCandidates = candidates.filter((candidate) => this.validator.isLifecycleEligible(candidate));
    if (lifecycleCandidates.length === 0) this.lifecycleError(candidates, request);
    const capabilityCandidates = lifecycleCandidates.filter((candidate) =>
      candidate.capabilities.some((capability) => capability.id === request.capability),
    );
    if (capabilityCandidates.length === 0) this.noMatch(request);

    const compatibleCandidates = capabilityCandidates.filter(
      (candidate) => candidate.compatibility.status === 'COMPATIBLE',
    );
    if (compatibleCandidates.length === 0) {
      throw new ManagedResolverError(
        'INCOMPATIBLE_CONNECTOR',
        'No compatible managed connector satisfies the capability',
        context(request),
      );
    }

    const healthCandidates = this.healthEligible(compatibleCandidates, request, decisionTime);
    const allowedCandidates = healthCandidates.filter((candidate) =>
      isDefinitionAllowed(this.policy, candidate.definitionRef),
    );
    if (allowedCandidates.length === 0) this.noMatch(request);
    return this.rank(allowedCandidates, request);
  }

  private healthEligible(
    candidates: readonly ManagedConnectorCandidate[],
    request: ResolutionRequest,
    decisionTime: string,
  ): ManagedConnectorCandidate[] {
    const decisionTimestamp = Date.parse(decisionTime);
    if (Number.isNaN(decisionTimestamp)) {
      throw new ManagedResolverError(
        'RESOLUTION_DEPENDENCY_FAILED',
        'Managed resolver clock is invalid',
        context(request),
      );
    }
    const missing = candidates.filter((candidate) => candidate.health === undefined);
    const stale = candidates.filter((candidate) => this.isStale(candidate, decisionTimestamp));
    const eligible = candidates.filter((candidate) => {
      if (candidate.health === undefined || this.isStale(candidate, decisionTimestamp)) return false;
      return healthMeetsMinimum(this.policy.minimumHealth, candidate.health.status);
    });
    if (eligible.length > 0) return eligible;
    if (missing.length === candidates.length) {
      throw new ManagedResolverError('MISSING_HEALTH', 'Managed connector health is unavailable', context(request));
    }
    if (stale.length === candidates.length) {
      throw new ManagedResolverError('STALE_HEALTH', 'Managed connector health is stale', context(request));
    }
    throw new ManagedResolverError(
      'UNHEALTHY_CONNECTOR',
      'Managed connector health does not satisfy policy',
      context(request),
    );
  }

  private isStale(candidate: ManagedConnectorCandidate, decisionTimestamp: number): boolean {
    if (candidate.health === undefined) return false;
    const recordedAt = Date.parse(candidate.health.recordedAt);
    const updatedAt = Date.parse(candidate.lifecycle.updatedAt);
    if (Number.isNaN(recordedAt) || Number.isNaN(updatedAt)) return true;
    return (
      recordedAt < updatedAt ||
      recordedAt > decisionTimestamp + this.policy.maximumFutureSkewMs ||
      decisionTimestamp - recordedAt > this.policy.maxHealthAgeMs
    );
  }

  private rank(
    candidates: readonly ManagedConnectorCandidate[],
    request: ResolutionRequest,
  ): ManagedConnectorCandidate {
    const ranked = [...candidates].sort((left, right) => {
      const priority = right.policyPriority - left.policyPriority;
      if (priority !== 0) return priority;
      const health = healthRank(right) - healthRank(left);
      if (health !== 0) return health;
      const definition = definitionRank(right) - definitionRank(left);
      if (definition !== 0) return definition;
      return left.instanceId.localeCompare(right.instanceId);
    });
    const selected = ranked[0]!;
    const tied = ranked.filter(
      (candidate) =>
        candidate.policyPriority === selected.policyPriority &&
        healthRank(candidate) === healthRank(selected) &&
        definitionRank(candidate) === definitionRank(selected),
    );
    if (this.policy.tieStrategy === 'REJECT_AMBIGUOUS' && tied.length > 1) {
      throw new ManagedResolverError(
        'AMBIGUOUS_MATCH',
        'Multiple managed connectors share the highest rank',
        context(request),
      );
    }
    return selected;
  }

  private async revalidate(
    selected: ManagedConnectorCandidate,
    request: ResolutionRequest,
  ): Promise<ManagedConnectorCandidate | undefined> {
    try {
      const current = await this.catalog.get(selected.instanceId, this.policy);
      if (current !== undefined) this.validator.validateCandidate(current);
      return current;
    } catch (error) {
      if (error instanceof ManagedResolverError) throw error;
      throw new ManagedResolverError(
        'RESOLUTION_DEPENDENCY_FAILED',
        'Managed candidate catalog is unavailable',
        context(request, selected.instanceId),
      );
    }
  }

  private lifecycleError(
    candidates: readonly ManagedConnectorCandidate[],
    request: ResolutionRequest,
  ): never {
    const exact = request.constraints?.instanceId;
    const candidate = exact === undefined ? undefined : candidates.find((entry) => entry.instanceId === exact);
    if (candidate?.lifecycle.state === 'DISABLED') {
      throw new ManagedResolverError(
        'DISABLED_CONNECTOR',
        'Managed connector is disabled',
        context(request, candidate.instanceId),
      );
    }
    if (candidate?.lifecycle.state === 'REMOVED') {
      throw new ManagedResolverError(
        'TERMINAL_CONNECTOR',
        'Managed connector is terminal',
        context(request, candidate.instanceId),
      );
    }
    this.noMatch(request);
  }

  private noMatch(request: ResolutionRequest): never {
    throw new ManagedResolverError(
      'NO_MATCH',
      'No managed connector satisfies the resolution request',
      context(request),
    );
  }

  private result(
    request: ResolutionRequest,
    selected: ManagedConnectorCandidate,
    resolvedAt: string,
  ): ManagedResolution {
    const health = selected.health!;
    const validUntil = new Date(Date.parse(resolvedAt) + this.policy.maxHealthAgeMs).toISOString();
    return freeze(structuredClone({
      requestId: request.requestId,
      capability: request.capability,
      selected: {
        instanceId: selected.instanceId,
        definitionRef: {
          id: selected.definitionRef.id,
          version: selected.definitionRef.version,
        },
        expectedRevision: selected.lifecycle.revision,
        expectedSecurityRevision: selected.lifecycle.securityRevision,
      },
      healthEvidence: {
        observationId: health.observationId,
        sequence: health.sequence,
        status: health.status as 'HEALTHY' | 'DEGRADED',
        recordedAt: health.recordedAt,
      },
      policy: {
        policyId: this.policy.policyId,
        revision: this.policy.revision,
      },
      resolvedAt,
      validUntil,
    }));
  }
}
