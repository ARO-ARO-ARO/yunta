import type { ManagedConnectorCandidate, ManagedStructuralCandidate } from './models.ts';
import type {
  LatestManagedHealthReader,
  ManagedCandidateCatalog,
  ManagedCandidateSource,
  ManagedStructuralEligibilityReader,
} from './ports.ts';
import { priorityFor, type ResolverPolicy } from './resolver-policy.ts';

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function snapshot(
  structural: ManagedStructuralCandidate,
  health: ManagedConnectorCandidate['health'],
  policy: ResolverPolicy,
): ManagedConnectorCandidate {
  return freeze({
    instanceId: structural.instanceId,
    definitionRef: {
      id: structural.definitionRef.id,
      version: structural.definitionRef.version,
    },
    capabilities: structural.capabilities.map((capability) => ({
      id: capability.id,
      riskLevel: capability.riskLevel,
    })),
    definitionStatus: structural.definitionStatus,
    lifecycle: {
      state: structural.lifecycle.state,
      revision: structural.lifecycle.revision,
      securityRevision: structural.lifecycle.securityRevision,
      updatedAt: structural.lifecycle.updatedAt,
    },
    compatibility: {
      status: structural.compatibility.status,
      definitionChecksum: structural.compatibility.definitionChecksum,
      connectorRecordRevision: structural.compatibility.connectorRecordRevision,
    },
    ...(health === undefined
      ? {}
      : {
          health: {
            observationId: health.observationId,
            sequence: health.sequence,
            status: health.status,
            recordedAt: health.recordedAt,
          },
        }),
    policyPriority: priorityFor(policy, structural.instanceId),
  });
}

export class DefaultManagedCandidateCatalog implements ManagedCandidateCatalog {
  private readonly source: ManagedCandidateSource;
  private readonly structuralReader: ManagedStructuralEligibilityReader;
  private readonly healthReader: LatestManagedHealthReader;

  constructor(
    source: ManagedCandidateSource,
    structuralReader: ManagedStructuralEligibilityReader,
    healthReader: LatestManagedHealthReader,
  ) {
    this.source = source;
    this.structuralReader = structuralReader;
    this.healthReader = healthReader;
  }

  async list(policy: ResolverPolicy): Promise<readonly ManagedConnectorCandidate[]> {
    const instanceIds = await this.source.listInstanceIds();
    const candidates = await Promise.all(
      [...new Set(instanceIds)].map((instanceId) => this.get(instanceId, policy)),
    );
    return Object.freeze(candidates.filter((candidate): candidate is ManagedConnectorCandidate => candidate !== undefined));
  }

  async get(
    instanceId: string,
    policy: ResolverPolicy,
  ): Promise<ManagedConnectorCandidate | undefined> {
    const structural = await this.structuralReader.inspect(instanceId);
    if (structural === undefined) return undefined;
    const health = await this.healthReader.getLatest(structural.instanceId);
    return snapshot(structural, health, policy);
  }
}
