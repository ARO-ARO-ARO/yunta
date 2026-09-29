import type {
  ConnectorReference,
  ConnectorStatus,
  RiskLevel,
} from '../types/runtime-types.ts';
import type { ManagedConnectorLifecycleState } from '../contracts-foundation/domain.ts';

export type CredentialRequirement = 'REQUIRED' | 'OPTIONAL';

export type RuntimeEligibleLifecycleState = 'CONNECTED' | 'HEALTHY' | 'DEGRADED';

export interface RuntimeAssemblyRequest {
  readonly instanceId: string;
}

export interface RuntimeCompatibilityProfile {
  readonly runtimeProtocolVersion: string;
  readonly connectorApiVersion: string;
  readonly capabilitySchemaVersion: string;
  readonly definitionSchemaVersion: string;
  readonly connectorRecordSchemaVersion: number;
  readonly managedConnectorSchemaVersion: number;
}

export interface RuntimeConnectorCapabilitySnapshot {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly riskLevel: RiskLevel;
}

export interface RuntimeConnectorDefinitionSnapshot {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly type: string;
  readonly status: Extract<ConnectorStatus, 'ACTIVE' | 'DEGRADED'>;
  readonly capabilities: readonly RuntimeConnectorCapabilitySnapshot[];
}

export interface ManagedConnectorSnapshot {
  readonly definitionRef: ConnectorReference;
  readonly schemaVersion: number;
  readonly revision: number;
  readonly securityRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeLifecycleSnapshot {
  readonly state: RuntimeEligibleLifecycleState;
  readonly readiness: 'STRUCTURALLY_READY';
}

export interface RuntimeCompatibilitySnapshot {
  readonly connectorApiVersion: string;
  readonly minimumRuntimeVersion: string;
  readonly capabilitySchemaVersion: string;
  readonly definitionSchemaVersion: string;
}

export interface RuntimeCredentialReferenceSnapshot {
  readonly credentialId: string;
  readonly providerId: string;
  readonly secretRef: string;
  readonly revision: number;
}

export interface RuntimeCredentialInformation {
  readonly requirement: CredentialRequirement;
  readonly references: readonly RuntimeCredentialReferenceSnapshot[];
  readonly availability: 'NOT_VERIFIED';
}

export interface RuntimeOperationalMetadata {
  readonly assembledAt: string;
  readonly connectorRecordSchemaVersion: number;
  readonly connectorRecordRevision: number;
  readonly definitionChecksum: string;
  readonly healthValidation: 'NOT_PERFORMED';
  readonly credentialAvailability: 'NOT_VERIFIED';
  readonly consistencyCheck: 'VERIFIED_BY_REREAD';
}

export interface ManagedConnectorRuntime {
  readonly instanceId: string;
  readonly definition: RuntimeConnectorDefinitionSnapshot;
  readonly managedConnector: ManagedConnectorSnapshot;
  readonly lifecycle: RuntimeLifecycleSnapshot;
  readonly compatibility: RuntimeCompatibilitySnapshot;
  readonly permissions: readonly string[];
  readonly credentials: RuntimeCredentialInformation;
  readonly operationalMetadata: RuntimeOperationalMetadata;
}

export interface RuntimeAssemblyConsistencyInput {
  readonly instanceId: string;
  readonly definitionRef: ConnectorReference;
  readonly lifecycleState: ManagedConnectorLifecycleState;
  readonly revision: number;
  readonly securityRevision: number;
  readonly managedSchemaVersion: number;
  readonly connectorRecordSchemaVersion: number;
  readonly connectorRecordRevision: number;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly definitionChecksum: string;
}
