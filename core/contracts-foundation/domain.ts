import type {
  ConnectorDefinition,
  ConnectorReference,
  PermissionResult,
} from '../types/runtime-types.ts';

export type ManagedConnectorLifecycleState =
  | 'REGISTERED'
  | 'CONNECTED'
  | 'HEALTHY'
  | 'DEGRADED'
  | 'DISABLED'
  | 'REMOVED';

export type CredentialStatus =
  | 'REGISTERED'
  | 'ACTIVE'
  | 'EXPIRING'
  | 'ROTATING'
  | 'EXPIRED'
  | 'REVOKED';

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

export interface CompatibilityDescriptor {
  connectorApiVersion: string;
  minimumRuntimeVersion: string;
  capabilitySchemaVersion: string;
  definitionSchemaVersion: string;
}

export interface CredentialReference {
  credentialId: string;
  providerId: string;
  secretRef: string;
  revision: number;
}

export interface HealthObservation {
  observationId: string;
  connectorInstanceId: string;
  timestamp: string;
  status: HealthStatus;
  latencyMs: number;
  error?: {
    code: string;
    message: string;
  };
  probeType: 'SCHEDULED' | 'ON_DEMAND' | 'PRE_EXECUTION';
  consecutiveFailures: number;
}

export interface ManagedConnector {
  instanceId: string;
  definitionRef: ConnectorReference;
  lifecycleState: ManagedConnectorLifecycleState;
  credentialRefs: readonly CredentialReference[];
  latestHealth?: HealthObservation;
  securityRevision: number;
  revision: number;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  metadata: Readonly<Record<string, unknown>>;
}

export interface ConnectorRecord {
  schemaVersion: number;
  recordRevision: number;
  definition: ConnectorDefinition;
  compatibility: CompatibilityDescriptor;
  createdAt: string;
  updatedAt: string;
  checksum: string;
}

export interface CredentialDefinition {
  id: string;
  connectorInstanceId: string;
  providerId: string;
  secretRef: string;
  purpose: string;
  status: CredentialStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  lastRotatedAt?: string;
  revokedAt?: string;
  revocationReason?: string;
  revision: number;
  metadata: Readonly<Record<string, unknown>>;
}

const secretLeaseMarker = Symbol('yunta.secret-lease');

export interface SecretLease {
  readonly credentialId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly material: unknown;
  readonly [secretLeaseMarker]: true;
  dispose(): void;
}

export function createSecretLease(
  credentialId: string,
  material: unknown,
  expiresAt: string,
  issuedAt = new Date().toISOString(),
): SecretLease {
  let disposed = false;

  return Object.freeze({
    credentialId,
    issuedAt,
    expiresAt,
    material,
    [secretLeaseMarker]: true as const,
    dispose(): void {
      disposed = true;
    },
    get disposed(): boolean {
      return disposed;
    },
  }) as SecretLease;
}

export function isSecretLease(value: unknown): value is SecretLease {
  return (
    typeof value === 'object' &&
    value !== null &&
    secretLeaseMarker in value &&
    (value as SecretLease)[secretLeaseMarker] === true
  );
}

export interface AuthorizationClaims {
  authorizationId: string;
  actorId: string;
  executionId: string;
  connectorInstanceId: string;
  connectorRef: ConnectorReference;
  capability: string;
  credentialRevision: number;
  securityRevision: number;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  nonce: string;
  decision: PermissionResult;
}

export interface AuditEnvelope {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  executionId: string;
  sequence: number;
  timestamp: string;
  actorId: string;
  connectorInstanceId: string;
  connectorRef: ConnectorReference;
  payload: unknown;
  correlationId: string;
}

export interface LifecycleTransition {
  nextState: ManagedConnectorLifecycleState;
  reason: string;
  occurredAt: string;
}

export interface LifecycleTransitionCommand {
  transitionId: string;
  instanceId: string;
  nextState: ManagedConnectorLifecycleState;
  actorId: string;
  reason: string;
  timestamp: string;
  securityRevisionIncrement: 0 | 1;
}

export interface LifecycleHistoryEntry {
  transitionId: string;
  instanceId: string;
  previousState: ManagedConnectorLifecycleState;
  nextState: ManagedConnectorLifecycleState;
  actorId: string;
  reason: string;
  timestamp: string;
  revision: number;
  securityRevision: number;
}

export interface LifecycleTransitionResult {
  connector: ManagedConnector;
  historyEntry: LifecycleHistoryEntry;
}

export type LifecycleContractErrorCode =
  | 'CONNECTOR_NOT_FOUND'
  | 'INVALID_COMMAND'
  | 'INVALID_TRANSITION'
  | 'TERMINAL_STATE'
  | 'REVISION_CONFLICT'
  | 'DUPLICATE_TRANSITION'
  | 'SECURITY_REVISION_POLICY_VIOLATION';

export class LifecycleContractError extends Error {
  readonly code: LifecycleContractErrorCode;

  constructor(code: LifecycleContractErrorCode, message: string) {
    super(message);
    this.name = 'LifecycleContractError';
    this.code = code;
  }
}

export interface CredentialRotation {
  secretRef: string;
  expiresAt?: string;
  occurredAt: string;
}

export interface ManagedConnectorQuery {
  lifecycleState?: ManagedConnectorLifecycleState;
  definitionId?: string;
}

export interface AuditQuery {
  afterSequence?: number;
}
