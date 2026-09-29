import type { ManagedResolution } from '../managed-resolver/models.ts';

export type ExecutionOperation = 'EXECUTE_CONNECTOR';
export type ExecutionPreparationStatus = 'READY' | 'NOT_READY' | 'DENIED';
export type AuthorizationDecision = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'NOT_EVALUATED';
export type CredentialReadinessStatus = 'READY' | 'NOT_REQUIRED' | 'NOT_READY' | 'NOT_EVALUATED';

export type PreparationReasonCode =
  | 'RESOLUTION_EXPIRED'
  | 'REFERENCE_CONFLICT'
  | 'RUNTIME_CONFLICT'
  | 'HEALTH_CONFLICT'
  | 'HEALTH_EXPIRED'
  | 'AUTHORIZATION_DENIED'
  | 'AUTHORIZATION_EXPIRED'
  | 'APPROVAL_REQUIRED'
  | 'CREDENTIAL_NOT_READY'
  | 'CAPABILITY_MISMATCH'
  | 'INVALID_LIFECYCLE'
  | 'DEPENDENCY_UNAVAILABLE';

export interface ExecutionPreparationRequest {
  readonly requestId: string;
  readonly correlationId: string;
  readonly managedResolution: ManagedResolution;
  readonly capability: string;
  readonly operation: ExecutionOperation;
  readonly actor: {
    readonly actorId: string;
  };
  readonly context: {
    readonly executionId: string;
    readonly planId: string;
    readonly skillRef: {
      readonly id: string;
      readonly version: string;
    };
  };
}

export interface StructuralReadinessSnapshot {
  readonly instanceId: string;
  readonly definitionRef: {
    readonly id: string;
    readonly version: string;
  };
  readonly lifecycle: {
    readonly state: 'CONNECTED' | 'HEALTHY' | 'DEGRADED' | 'REGISTERED' | 'DISABLED' | 'REMOVED';
    readonly updatedAt: string;
  };
  readonly revision: number;
  readonly securityRevision: number;
  readonly capabilities: readonly {
    readonly id: string;
    readonly riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  }[];
  readonly permissions: readonly string[];
  readonly credentialRequirement: 'REQUIRED' | 'OPTIONAL';
  readonly credentialReferences: readonly {
    readonly credentialId: string;
    readonly providerId: string;
    readonly revision: number;
  }[];
  readonly connectorRecordRevision: number;
  readonly definitionChecksum: string;
}

export interface PreparationHealthSnapshot {
  readonly observationId: string;
  readonly sequence: number;
  readonly status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  readonly recordedAt: string;
  readonly definitionRef: {
    readonly id: string;
    readonly version: string;
  };
}

export interface AuthorizationAssessment {
  readonly evaluationId?: string;
  readonly decision: AuthorizationDecision;
  readonly policy?: {
    readonly id: string;
    readonly revision: number;
  };
  readonly evaluatedAt?: string;
  readonly notBefore?: string;
  readonly expiresAt?: string;
}

export interface PermissionEvaluation {
  readonly status: 'SATISFIED' | 'MISSING' | 'DENIED' | 'NOT_EVALUATED';
  readonly requiredCount: number;
  readonly missingCount: number;
  readonly evaluatedAt?: string;
}

export interface CredentialReadiness {
  readonly status: CredentialReadinessStatus;
  readonly checkedAt?: string;
  readonly credentials: readonly {
    readonly credentialId: string;
    readonly revision: number;
    readonly status: 'READY' | 'NOT_READY';
    readonly expiresAt?: string;
  }[];
}

export interface AuditReferences {
  readonly requestedEventId: string;
  readonly outcomeEventId: string;
}

export interface ExecutionPreparationResult {
  readonly requestId: string;
  readonly correlationId: string;
  readonly executionId: string;
  readonly status: ExecutionPreparationStatus;
  readonly capability: string;
  readonly operation: ExecutionOperation;
  readonly referenceAssessment: {
    readonly reference: {
      readonly instanceId: string;
      readonly definitionRef: { readonly id: string; readonly version: string };
      readonly expectedRevision: number;
      readonly expectedSecurityRevision: number;
    };
    readonly status: 'VALIDATED' | 'CONFLICT' | 'INVALID';
  };
  readonly structuralEvidence?: {
    readonly lifecycleState: 'CONNECTED' | 'HEALTHY' | 'DEGRADED';
    readonly connectorRecordRevision: number;
    readonly definitionChecksum: string;
  };
  readonly permissions: PermissionEvaluation;
  readonly credentials: CredentialReadiness;
  readonly authorization: AuthorizationAssessment;
  readonly reasons: readonly PreparationReasonCode[];
  readonly audit: AuditReferences;
  readonly preparedAt: string;
  readonly expiresAt: string;
}

export interface PreparationAuditRequested {
  readonly eventType: 'ExecutionPreparationRequested';
  readonly requestId: string;
  readonly correlationId: string;
  readonly executionId: string;
  readonly actorId: string;
  readonly capability: string;
  readonly operation: ExecutionOperation;
  readonly reference: ExecutionPreparationResult['referenceAssessment']['reference'];
  readonly occurredAt: string;
}

export interface PreparationAuditOutcome {
  readonly eventType: 'ExecutionPreparationApproved' | 'ExecutionPreparationDenied';
  readonly requestId: string;
  readonly requestedEventId: string;
  readonly correlationId: string;
  readonly executionId: string;
  readonly actorId: string;
  readonly capability: string;
  readonly operation: ExecutionOperation;
  readonly status: ExecutionPreparationStatus;
  readonly reference: ExecutionPreparationResult['referenceAssessment']['reference'];
  readonly reasons: readonly PreparationReasonCode[];
  readonly expiresAt: string;
  readonly occurredAt: string;
}
