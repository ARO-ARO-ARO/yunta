import type {
  AuditEnvelope,
  AuditQuery,
  CompatibilityDescriptor,
  ConnectorRecord,
  CredentialDefinition,
  CredentialReference,
  CredentialRotation,
  HealthObservation,
  LifecycleHistoryEntry,
  LifecycleTransition,
  LifecycleTransitionCommand,
  LifecycleTransitionResult,
  ManagedConnector,
  ManagedConnectorQuery,
  SecretLease,
} from './domain.ts';

export interface ConnectorRepository {
  saveDefinition(record: ConnectorRecord): Promise<ConnectorRecord>;
  getDefinition(connectorId: string, version: string): Promise<ConnectorRecord | undefined>;
  listVersions(connectorId: string): Promise<ConnectorRecord[]>;
  getLatestCompatible(
    connectorId: string,
    compatibility: CompatibilityDescriptor,
  ): Promise<ConnectorRecord | undefined>;
  saveManagedConnector(
    connector: ManagedConnector,
    expectedRevision?: number,
  ): Promise<ManagedConnector>;
  getManagedConnector(instanceId: string): Promise<ManagedConnector | undefined>;
  listManagedConnectors(query?: ManagedConnectorQuery): Promise<ManagedConnector[]>;
  transitionLifecycle(
    instanceId: string,
    transition: LifecycleTransition,
    expectedRevision: number,
  ): Promise<ManagedConnector>;
  markRemoved(instanceId: string, expectedRevision: number): Promise<ManagedConnector>;
}

export interface LifecycleConnectorRepository extends ConnectorRepository {
  transitionLifecycle(
    instanceId: string,
    transition: LifecycleTransition,
    expectedRevision: number,
  ): Promise<ManagedConnector>;
  transitionLifecycle(
    command: LifecycleTransitionCommand,
    expectedRevision: number,
  ): Promise<LifecycleTransitionResult>;
  getLifecycleHistory(instanceId: string): Promise<LifecycleHistoryEntry[]>;
}

export interface CredentialManager {
  register(definition: CredentialDefinition): Promise<CredentialDefinition>;
  getDefinition(credentialId: string): Promise<CredentialDefinition | undefined>;
  acquireLease(reference: CredentialReference, executionId: string): Promise<SecretLease>;
  rotate(
    credentialId: string,
    rotation: CredentialRotation,
    expectedRevision: number,
  ): Promise<CredentialDefinition>;
  revoke(
    credentialId: string,
    reason: string,
    occurredAt: string,
    expectedRevision: number,
  ): Promise<CredentialDefinition>;
  evaluateExpiration(at: string): Promise<CredentialDefinition[]>;
}

export interface HealthRepository {
  append(observation: HealthObservation): Promise<HealthObservation>;
  getLatest(connectorInstanceId: string): Promise<HealthObservation | undefined>;
  findHistory(connectorInstanceId: string): Promise<HealthObservation[]>;
}

export interface AuditRepository {
  append(envelope: AuditEnvelope): Promise<AuditEnvelope>;
  appendBatch(envelopes: readonly AuditEnvelope[]): Promise<AuditEnvelope[]>;
  findByExecution(executionId: string, query?: AuditQuery): Promise<AuditEnvelope[]>;
  findByConnector(
    connectorId: string,
    version?: string,
    query?: AuditQuery,
  ): Promise<AuditEnvelope[]>;
  readStream(executionId: string): Promise<AsyncIterable<AuditEnvelope>>;
}
