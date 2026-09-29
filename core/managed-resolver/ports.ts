import type {
  ManagedCandidateHealthSnapshot,
  ManagedConnectorCandidate,
  ManagedStructuralCandidate,
} from './models.ts';
import type { ResolverPolicy } from './resolver-policy.ts';

export interface ManagedCandidateSource {
  listInstanceIds(): Promise<readonly string[]>;
}

export interface ManagedStructuralEligibilityReader {
  inspect(instanceId: string): Promise<ManagedStructuralCandidate | undefined>;
}

export interface LatestManagedHealthReader {
  getLatest(instanceId: string): Promise<ManagedCandidateHealthSnapshot | undefined>;
}

export interface ManagedCandidateCatalog {
  list(policy: ResolverPolicy): Promise<readonly ManagedConnectorCandidate[]>;
  get(
    instanceId: string,
    policy: ResolverPolicy,
  ): Promise<ManagedConnectorCandidate | undefined>;
}

export interface ManagedResolverClock {
  now(): string;
}
