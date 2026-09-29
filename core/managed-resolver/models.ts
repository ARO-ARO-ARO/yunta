export type ManagedResolverLifecycleState =
  | 'REGISTERED'
  | 'CONNECTED'
  | 'HEALTHY'
  | 'DEGRADED'
  | 'DISABLED'
  | 'REMOVED';

export type ManagedResolverHealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

export interface ManagedConnectorReference {
  readonly instanceId: string;
  readonly definitionRef: {
    readonly id: string;
    readonly version: string;
  };
  readonly expectedRevision: number;
  readonly expectedSecurityRevision: number;
}

export interface ResolutionRequest {
  readonly requestId: string;
  readonly correlationId: string;
  readonly capability: string;
  readonly requiredVersion?: string;
  readonly constraints?: {
    readonly instanceId?: string;
    readonly definitionId?: string;
  };
}

export interface ManagedCandidateCapability {
  readonly id: string;
  readonly riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface ManagedCandidateLifecycleSnapshot {
  readonly state: ManagedResolverLifecycleState;
  readonly revision: number;
  readonly securityRevision: number;
  readonly updatedAt: string;
}

export interface ManagedCandidateHealthSnapshot {
  readonly observationId: string;
  readonly sequence: number;
  readonly status: ManagedResolverHealthStatus;
  readonly recordedAt: string;
}

export interface ManagedCandidateCompatibilitySnapshot {
  readonly status: 'COMPATIBLE' | 'INCOMPATIBLE';
  readonly definitionChecksum: string;
  readonly connectorRecordRevision: number;
}

export interface ManagedStructuralCandidate {
  readonly instanceId: string;
  readonly definitionRef: {
    readonly id: string;
    readonly version: string;
  };
  readonly capabilities: readonly ManagedCandidateCapability[];
  readonly definitionStatus: 'ACTIVE' | 'DEGRADED';
  readonly lifecycle: ManagedCandidateLifecycleSnapshot;
  readonly compatibility: ManagedCandidateCompatibilitySnapshot;
}

export interface ManagedConnectorCandidate extends ManagedStructuralCandidate {
  readonly health?: ManagedCandidateHealthSnapshot;
  readonly policyPriority: number;
}

export interface ManagedResolution {
  readonly requestId: string;
  readonly capability: string;
  readonly selected: ManagedConnectorReference;
  readonly healthEvidence: {
    readonly observationId: string;
    readonly sequence: number;
    readonly status: 'HEALTHY' | 'DEGRADED';
    readonly recordedAt: string;
  };
  readonly policy: {
    readonly policyId: string;
    readonly revision: number;
  };
  readonly resolvedAt: string;
  readonly validUntil: string;
}
