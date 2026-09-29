import type {
  AuthorizationAssessment,
  CredentialReadiness,
  ExecutionOperation,
  PreparationAuditOutcome,
  PreparationAuditRequested,
  PreparationHealthSnapshot,
  StructuralReadinessSnapshot,
} from './models.ts';

export interface StructuralReadinessReader {
  inspect(instanceId: string): Promise<StructuralReadinessSnapshot | undefined>;
}

export interface LatestPreparationHealthReader {
  getLatest(instanceId: string): Promise<PreparationHealthSnapshot | undefined>;
}

export interface AuthorizationAuthority {
  read(input: {
    readonly actorId: string;
    readonly skillRef: { readonly id: string; readonly version: string };
    readonly capability: string;
    readonly operation: ExecutionOperation;
    readonly target: {
      readonly instanceId: string;
      readonly definitionRef: { readonly id: string; readonly version: string };
      readonly revision: number;
      readonly securityRevision: number;
    };
  }): Promise<{
    readonly actorActive: boolean;
    readonly actorPermissions: readonly string[];
    readonly skillActive: boolean;
    readonly skillCapability: string;
    readonly skillPermissions: readonly string[];
    readonly explicitDeny: boolean;
    readonly approvalGranted: boolean;
    readonly evaluatedAt: string;
  }>;
}

export interface CredentialReadinessAuthority {
  inspect(input: {
    readonly connectorInstanceId: string;
    readonly capability: string;
    readonly operation: ExecutionOperation;
    readonly reference: {
      readonly credentialId: string;
      readonly providerId: string;
      readonly revision: number;
    };
  }): Promise<{
    readonly exists: boolean;
    readonly ownershipMatches: boolean;
    readonly referenceMatches: boolean;
    readonly purposeMatches: boolean;
    readonly status: 'REGISTERED' | 'ACTIVE' | 'EXPIRING' | 'ROTATING' | 'EXPIRED' | 'REVOKED';
    readonly expiresAt?: string;
  }>;
}

export interface ExecutionPreparationAuditPort {
  recordRequested(event: PreparationAuditRequested): Promise<{ readonly eventId: string }>;
  recordOutcome(event: PreparationAuditOutcome): Promise<{ readonly eventId: string }>;
}

export interface ExecutionPreparationClock {
  now(): string;
}

export interface AuthorizationEvaluatorPort {
  evaluate(input: {
    readonly actorId: string;
    readonly skillRef: { readonly id: string; readonly version: string };
    readonly capability: string;
    readonly operation: ExecutionOperation;
    readonly structural: StructuralReadinessSnapshot;
  }): Promise<{ readonly authorization: AuthorizationAssessment; readonly permissions: import('./models.ts').PermissionEvaluation }>;
}

export interface CredentialReadinessCheckerPort {
  check(input: {
    readonly capability: string;
    readonly operation: ExecutionOperation;
    readonly structural: StructuralReadinessSnapshot;
    readonly checkedAt: string;
  }): Promise<CredentialReadiness>;
}
