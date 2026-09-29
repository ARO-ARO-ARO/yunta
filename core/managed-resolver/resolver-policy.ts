import type { ManagedConnectorReference, ManagedResolverHealthStatus } from './models.ts';

export type ResolverTieStrategy = 'STABLE_INSTANCE_ID' | 'REJECT_AMBIGUOUS';
export type MinimumHealth = 'HEALTHY' | 'DEGRADED';

export interface ResolverPolicy {
  readonly policyId: string;
  readonly revision: number;
  readonly minimumHealth: MinimumHealth;
  readonly maxHealthAgeMs: number;
  readonly maximumFutureSkewMs: number;
  readonly allowedDefinitionRefs?: readonly {
    readonly id: string;
    readonly version: string;
  }[];
  readonly instancePriorities: Readonly<Record<string, number>>;
  readonly tieStrategy: ResolverTieStrategy;
  readonly maxConsistencyRetries: number;
}

export class StaticResolverPolicy implements ResolverPolicy {
  readonly policyId: string;
  readonly revision: number;
  readonly minimumHealth: MinimumHealth;
  readonly maxHealthAgeMs: number;
  readonly maximumFutureSkewMs: number;
  readonly allowedDefinitionRefs?: readonly { readonly id: string; readonly version: string }[];
  readonly instancePriorities: Readonly<Record<string, number>>;
  readonly tieStrategy: ResolverTieStrategy;
  readonly maxConsistencyRetries: number;

  constructor(policy: ResolverPolicy) {
    if (
      !policy.policyId.trim() ||
      !Number.isInteger(policy.revision) ||
      policy.revision < 1 ||
      (policy.minimumHealth !== 'HEALTHY' && policy.minimumHealth !== 'DEGRADED') ||
      !Number.isInteger(policy.maxHealthAgeMs) ||
      policy.maxHealthAgeMs < 0 ||
      !Number.isInteger(policy.maximumFutureSkewMs) ||
      policy.maximumFutureSkewMs < 0 ||
      (policy.tieStrategy !== 'STABLE_INSTANCE_ID' && policy.tieStrategy !== 'REJECT_AMBIGUOUS') ||
      !Number.isInteger(policy.maxConsistencyRetries) ||
      policy.maxConsistencyRetries < 0
    ) {
      throw new Error('Resolver policy is invalid');
    }
    for (const [instanceId, priority] of Object.entries(policy.instancePriorities)) {
      if (!instanceId.trim() || !Number.isFinite(priority)) throw new Error('Resolver policy is invalid');
    }
    if (
      policy.allowedDefinitionRefs?.some(
        (reference) => !reference.id.trim() || !reference.version.trim(),
      )
    ) {
      throw new Error('Resolver policy is invalid');
    }

    this.policyId = policy.policyId;
    this.revision = policy.revision;
    this.minimumHealth = policy.minimumHealth;
    this.maxHealthAgeMs = policy.maxHealthAgeMs;
    this.maximumFutureSkewMs = policy.maximumFutureSkewMs;
    if (policy.allowedDefinitionRefs !== undefined) {
      this.allowedDefinitionRefs = policy.allowedDefinitionRefs.map((reference) =>
        Object.freeze({ id: reference.id, version: reference.version }),
      );
    }
    this.instancePriorities = Object.freeze({ ...policy.instancePriorities });
    this.tieStrategy = policy.tieStrategy;
    this.maxConsistencyRetries = policy.maxConsistencyRetries;
    Object.freeze(this);
  }
}

export function priorityFor(policy: ResolverPolicy, instanceId: string): number {
  return policy.instancePriorities[instanceId] ?? 0;
}

export function isDefinitionAllowed(
  policy: ResolverPolicy,
  reference: ManagedConnectorReference['definitionRef'],
): boolean {
  return (
    policy.allowedDefinitionRefs === undefined ||
    policy.allowedDefinitionRefs.some(
      (candidate) => candidate.id === reference.id && candidate.version === reference.version,
    )
  );
}

export function healthMeetsMinimum(
  minimum: MinimumHealth,
  status: ManagedResolverHealthStatus,
): status is 'HEALTHY' | 'DEGRADED' {
  return status === 'HEALTHY' || (minimum === 'DEGRADED' && status === 'DEGRADED');
}
