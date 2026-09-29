import type { ConnectorReference } from '../types/runtime-types.ts';
import {
  createSecretLease,
  isSecretLease,
  type AuditEnvelope,
  type AuditQuery,
  type CompatibilityDescriptor,
  type ConnectorRecord,
  type CredentialDefinition,
  type CredentialReference,
  type CredentialRotation,
  type HealthObservation,
  LifecycleContractError,
  type LifecycleHistoryEntry,
  type LifecycleTransition,
  type LifecycleTransitionCommand,
  type LifecycleTransitionResult,
  type ManagedConnector,
  type ManagedConnectorLifecycleState,
  type ManagedConnectorQuery,
  type SecretLease,
} from './domain.ts';
import type {
  AuditRepository,
  ConnectorRepository,
  CredentialManager,
  HealthRepository,
  LifecycleConnectorRepository,
} from './repositories.ts';

function containsSecretLease(value: unknown, seen = new WeakSet<object>()): boolean {
  if (isSecretLease(value)) {
    return true;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return false;
  }

  seen.add(value);
  return Object.values(value).some((entry) => containsSecretLease(entry, seen));
}

function containsSecretMaterial(value: unknown, seen = new WeakSet<object>()): boolean {
  const sensitiveKeys = new Set([
    'secret',
    'token',
    'password',
    'authorization',
    'accessToken',
    'refreshToken',
    'apiKey',
    'material',
  ]);
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return false;
  }

  seen.add(value);
  return Object.entries(value).some(
    ([property, entry]) => sensitiveKeys.has(property) || containsSecretMaterial(entry, seen),
  );
}

function redactDynamicData(value: unknown, redactStrings = false): unknown {
  if (typeof value === 'string') {
    return redactStrings ? '[REDACTED]' : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDynamicData(entry, redactStrings));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([property, entry]) => [
      property,
      redactDynamicData(entry, redactStrings || property === 'metadata' || property === 'payload'),
    ]),
  );
}

function clonePersistible<T>(value: T): T {
  if (containsSecretLease(value)) {
    throw new Error('SecretLease cannot be persisted');
  }
  if (containsSecretMaterial(value)) {
    throw new Error('Secret material cannot be persisted');
  }

  try {
    return structuredClone(redactDynamicData(value)) as T;
  } catch {
    throw new Error('Value is not persistible');
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(BigInt);
  const rightParts = right.split('.').map(BigInt);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0n;
    const rightPart = rightParts[index] ?? 0n;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  return 0;
}

function sameCompatibility(
  left: CompatibilityDescriptor,
  right: CompatibilityDescriptor,
): boolean {
  return (
    left.connectorApiVersion === right.connectorApiVersion &&
    left.minimumRuntimeVersion === right.minimumRuntimeVersion &&
    left.capabilitySchemaVersion === right.capabilitySchemaVersion &&
    left.definitionSchemaVersion === right.definitionSchemaVersion
  );
}

function assertRecord(record: ConnectorRecord): void {
  if (
    record.schemaVersion < 1 ||
    record.recordRevision < 1 ||
    !record.definition.id.trim() ||
    !record.definition.version.trim() ||
    !record.checksum.trim() ||
    !record.compatibility.connectorApiVersion.trim() ||
    !record.compatibility.minimumRuntimeVersion.trim() ||
    !record.compatibility.capabilitySchemaVersion.trim() ||
    !record.compatibility.definitionSchemaVersion.trim()
  ) {
    throw new Error('ConnectorRecord is invalid');
  }
}

function assertManagedConnector(connector: ManagedConnector): void {
  if (
    !connector.instanceId.trim() ||
    !connector.definitionRef.id.trim() ||
    !connector.definitionRef.version.trim() ||
    connector.schemaVersion < 1 ||
    connector.securityRevision < 1 ||
    connector.revision < 1 ||
    !connector.createdAt ||
    !connector.updatedAt
  ) {
    throw new Error('ManagedConnector is invalid');
  }
}

function canTransition(
  current: ManagedConnectorLifecycleState,
  next: ManagedConnectorLifecycleState,
): boolean {
  const transitions: Readonly<Record<ManagedConnectorLifecycleState, readonly ManagedConnectorLifecycleState[]>> = {
    REGISTERED: ['CONNECTED', 'DISABLED', 'REMOVED'],
    CONNECTED: ['REGISTERED', 'HEALTHY', 'DEGRADED', 'DISABLED', 'REMOVED'],
    HEALTHY: ['REGISTERED', 'DEGRADED', 'DISABLED', 'REMOVED'],
    DEGRADED: ['REGISTERED', 'HEALTHY', 'DISABLED', 'REMOVED'],
    DISABLED: ['REGISTERED', 'REMOVED'],
    REMOVED: [],
  };

  return transitions[current].includes(next);
}

function canStrictlyTransition(
  current: ManagedConnectorLifecycleState,
  next: ManagedConnectorLifecycleState,
): boolean {
  const transitions: Readonly<Record<ManagedConnectorLifecycleState, readonly ManagedConnectorLifecycleState[]>> = {
    REGISTERED: ['CONNECTED', 'DISABLED'],
    CONNECTED: ['REGISTERED', 'HEALTHY', 'DEGRADED', 'DISABLED'],
    HEALTHY: ['REGISTERED', 'DEGRADED', 'DISABLED'],
    DEGRADED: ['REGISTERED', 'HEALTHY', 'DISABLED'],
    DISABLED: ['REGISTERED', 'REMOVED'],
    REMOVED: [],
  };

  return transitions[current].includes(next);
}

function expectedSecurityRevisionIncrement(
  current: ManagedConnectorLifecycleState,
  next: ManagedConnectorLifecycleState,
): 0 | 1 {
  return next === 'DISABLED' || (current === 'DISABLED' && ['REGISTERED', 'REMOVED'].includes(next))
    ? 1
    : 0;
}

function isLifecycleState(value: unknown): value is ManagedConnectorLifecycleState {
  return ['REGISTERED', 'CONNECTED', 'HEALTHY', 'DEGRADED', 'DISABLED', 'REMOVED'].includes(
    value as ManagedConnectorLifecycleState,
  );
}

function key(reference: ConnectorReference): string {
  return `${reference.id}@${reference.version}`;
}

export class InMemoryConnectorRepository implements LifecycleConnectorRepository {
  private readonly definitions = new Map<string, ConnectorRecord>();
  private readonly managedConnectors = new Map<string, ManagedConnector>();
  private readonly lifecycleHistory = new Map<string, LifecycleHistoryEntry[]>();
  private readonly transitionIds = new Map<string, LifecycleHistoryEntry>();

  async saveDefinition(record: ConnectorRecord): Promise<ConnectorRecord> {
    assertRecord(record);
    const recordKey = key({ id: record.definition.id, version: record.definition.version });
    const existing = this.definitions.get(recordKey);
    if (existing && existing.checksum !== record.checksum) {
      throw new Error(`ConnectorDefinition is immutable: ${recordKey}`);
    }

    const saved = clonePersistible(record);
    this.definitions.set(recordKey, saved);
    return clonePersistible(saved);
  }

  async getDefinition(connectorId: string, version: string): Promise<ConnectorRecord | undefined> {
    const record = this.definitions.get(`${connectorId}@${version}`);
    return record ? clonePersistible(record) : undefined;
  }

  async listVersions(connectorId: string): Promise<ConnectorRecord[]> {
    return [...this.definitions.values()]
      .filter((record) => record.definition.id === connectorId)
      .sort((left, right) => compareVersions(right.definition.version, left.definition.version))
      .map(clonePersistible);
  }

  async getLatestCompatible(
    connectorId: string,
    compatibility: CompatibilityDescriptor,
  ): Promise<ConnectorRecord | undefined> {
    const records = await this.listVersions(connectorId);
    return records.find((record) => sameCompatibility(record.compatibility, compatibility));
  }

  async saveManagedConnector(
    connector: ManagedConnector,
    expectedRevision?: number,
  ): Promise<ManagedConnector> {
    assertManagedConnector(connector);
    const existing = this.managedConnectors.get(connector.instanceId);
    if (
      existing &&
      (expectedRevision !== existing.revision || connector.revision !== expectedRevision)
    ) {
      throw new Error(`ManagedConnector revision conflict: ${connector.instanceId}`);
    }
    if (!existing && expectedRevision !== undefined) {
      throw new Error(`ManagedConnector does not exist: ${connector.instanceId}`);
    }

    if (existing?.lifecycleState === 'REMOVED') {
      throw new Error(`ManagedConnector is removed: ${connector.instanceId}`);
    }

    const saved = clonePersistible({
      ...connector,
      revision: existing ? existing.revision + 1 : connector.revision,
    });
    this.managedConnectors.set(connector.instanceId, saved);
    return clonePersistible(saved);
  }

  async getManagedConnector(instanceId: string): Promise<ManagedConnector | undefined> {
    const connector = this.managedConnectors.get(instanceId);
    return connector ? clonePersistible(connector) : undefined;
  }

  async listManagedConnectors(query?: ManagedConnectorQuery): Promise<ManagedConnector[]> {
    return [...this.managedConnectors.values()]
      .filter(
        (connector) =>
          (query?.lifecycleState === undefined ||
            connector.lifecycleState === query.lifecycleState) &&
          (query?.definitionId === undefined || connector.definitionRef.id === query.definitionId),
      )
      .map(clonePersistible);
  }

  async transitionLifecycle(
    instanceId: string,
    transition: LifecycleTransition,
    expectedRevision: number,
  ): Promise<ManagedConnector>;
  async transitionLifecycle(
    command: LifecycleTransitionCommand,
    expectedRevision: number,
  ): Promise<LifecycleTransitionResult>;
  async transitionLifecycle(
    instanceOrCommand: string | LifecycleTransitionCommand,
    transitionOrExpectedRevision: LifecycleTransition | number,
    expectedRevision?: number,
  ): Promise<ManagedConnector | LifecycleTransitionResult> {
    if (typeof instanceOrCommand === 'string') {
      return this.transitionLegacy(
        instanceOrCommand,
        transitionOrExpectedRevision as LifecycleTransition,
        expectedRevision as number,
      );
    }

    return this.transitionWithCommand(
      instanceOrCommand,
      transitionOrExpectedRevision as number,
    );
  }

  async getLifecycleHistory(instanceId: string): Promise<LifecycleHistoryEntry[]> {
    return [...(this.lifecycleHistory.get(instanceId) ?? [])]
      .sort((left, right) => left.revision - right.revision)
      .map(clonePersistible);
  }

  private async transitionLegacy(
    instanceId: string,
    transition: LifecycleTransition,
    expectedRevision: number,
  ): Promise<ManagedConnector> {
    const existing = this.managedConnectors.get(instanceId);
    if (!existing) {
      throw new Error(`ManagedConnector not found: ${instanceId}`);
    }
    if (existing.revision !== expectedRevision) {
      throw new Error(`ManagedConnector revision conflict: ${instanceId}`);
    }
    if (!transition.reason.trim() || !canTransition(existing.lifecycleState, transition.nextState)) {
      throw new Error(`Invalid lifecycle transition: ${existing.lifecycleState} -> ${transition.nextState}`);
    }

    const updated: ManagedConnector = {
      ...existing,
      lifecycleState: transition.nextState,
      revision: existing.revision + 1,
      updatedAt: transition.occurredAt,
    };
    this.managedConnectors.set(instanceId, clonePersistible(updated));
    return clonePersistible(updated);
  }

  private async transitionWithCommand(
    command: LifecycleTransitionCommand,
    expectedRevision: number,
  ): Promise<LifecycleTransitionResult> {
    this.assertCommand(command, expectedRevision);
    const existing = this.managedConnectors.get(command.instanceId);
    if (!existing) {
      throw new LifecycleContractError(
        'CONNECTOR_NOT_FOUND',
        `ManagedConnector not found: ${command.instanceId}`,
      );
    }
    if (this.transitionIds.has(command.transitionId)) {
      throw new LifecycleContractError(
        'DUPLICATE_TRANSITION',
        `Lifecycle transition already exists: ${command.transitionId}`,
      );
    }
    if (existing.revision !== expectedRevision) {
      throw new LifecycleContractError(
        'REVISION_CONFLICT',
        `ManagedConnector revision conflict: ${command.instanceId}`,
      );
    }
    if (existing.lifecycleState === 'REMOVED') {
      throw new LifecycleContractError(
        'TERMINAL_STATE',
        `ManagedConnector is removed: ${command.instanceId}`,
      );
    }
    if (!canStrictlyTransition(existing.lifecycleState, command.nextState)) {
      throw new LifecycleContractError(
        'INVALID_TRANSITION',
        `Invalid lifecycle transition: ${existing.lifecycleState} -> ${command.nextState}`,
      );
    }

    const requiredSecurityIncrement = expectedSecurityRevisionIncrement(
      existing.lifecycleState,
      command.nextState,
    );
    if (command.securityRevisionIncrement !== requiredSecurityIncrement) {
      throw new LifecycleContractError(
        'SECURITY_REVISION_POLICY_VIOLATION',
        `Invalid security revision increment for ${existing.lifecycleState} -> ${command.nextState}`,
      );
    }
    if (Date.parse(command.timestamp) < Date.parse(existing.updatedAt)) {
      throw new LifecycleContractError('INVALID_COMMAND', 'Lifecycle timestamp cannot move backwards');
    }

    const updated: ManagedConnector = {
      ...existing,
      lifecycleState: command.nextState,
      revision: existing.revision + 1,
      securityRevision: existing.securityRevision + command.securityRevisionIncrement,
      updatedAt: command.timestamp,
    };
    const historyEntry: LifecycleHistoryEntry = {
      transitionId: command.transitionId,
      instanceId: command.instanceId,
      previousState: existing.lifecycleState,
      nextState: command.nextState,
      actorId: command.actorId,
      reason: command.reason,
      timestamp: command.timestamp,
      revision: updated.revision,
      securityRevision: updated.securityRevision,
    };
    const persistedConnector = clonePersistible(updated);
    const persistedHistoryEntry = clonePersistible(historyEntry);
    const updatedHistory = [
      ...(this.lifecycleHistory.get(command.instanceId) ?? []),
      persistedHistoryEntry,
    ];

    this.managedConnectors.set(command.instanceId, persistedConnector);
    this.lifecycleHistory.set(command.instanceId, updatedHistory);
    this.transitionIds.set(command.transitionId, persistedHistoryEntry);

    return {
      connector: clonePersistible(persistedConnector),
      historyEntry: clonePersistible(persistedHistoryEntry),
    };
  }

  private assertCommand(command: LifecycleTransitionCommand, expectedRevision: number): void {
    if (
      typeof command !== 'object' ||
      command === null ||
      !command.transitionId?.trim() ||
      !command.instanceId?.trim() ||
      !isLifecycleState(command.nextState) ||
      !command.actorId?.trim() ||
      !command.reason?.trim() ||
      Number.isNaN(Date.parse(command.timestamp)) ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 1 ||
      ![0, 1].includes(command.securityRevisionIncrement)
    ) {
      throw new LifecycleContractError('INVALID_COMMAND', 'Lifecycle transition command is invalid');
    }
  }

  async markRemoved(instanceId: string, expectedRevision: number): Promise<ManagedConnector> {
    return this.transitionLifecycle(
      instanceId,
      {
        nextState: 'REMOVED',
        reason: 'Removed by repository command',
        occurredAt: new Date().toISOString(),
      },
      expectedRevision,
    );
  }
}

export class InMemoryCredentialManager implements CredentialManager {
  private readonly definitions = new Map<string, CredentialDefinition>();

  async register(definition: CredentialDefinition): Promise<CredentialDefinition> {
    if (
      !definition.id.trim() ||
      !definition.connectorInstanceId.trim() ||
      !definition.providerId.trim() ||
      !definition.secretRef.trim() ||
      !definition.purpose.trim() ||
      definition.revision < 1 ||
      this.definitions.has(definition.id)
    ) {
      throw new Error(`CredentialDefinition is invalid: ${definition.id}`);
    }

    const saved = clonePersistible(definition);
    this.definitions.set(definition.id, saved);
    return clonePersistible(saved);
  }

  async getDefinition(credentialId: string): Promise<CredentialDefinition | undefined> {
    const definition = this.definitions.get(credentialId);
    return definition ? clonePersistible(definition) : undefined;
  }

  async acquireLease(reference: CredentialReference, executionId: string): Promise<SecretLease> {
    const definition = this.definitions.get(reference.credentialId);
    if (
      !definition ||
      definition.providerId !== reference.providerId ||
      definition.secretRef !== reference.secretRef ||
      definition.revision !== reference.revision ||
      definition.status !== 'ACTIVE' ||
      !executionId.trim() ||
      (definition.expiresAt !== undefined && Date.parse(definition.expiresAt) <= Date.now())
    ) {
      throw new Error(`Credential lease is unavailable: ${reference.credentialId}`);
    }

    const expiresAt = definition.expiresAt ?? new Date(Date.now() + 60_000).toISOString();
    return createSecretLease(
      definition.id,
      Object.freeze({ credentialId: definition.id, executionId }),
      expiresAt,
    );
  }

  async rotate(
    credentialId: string,
    rotation: CredentialRotation,
    expectedRevision: number,
  ): Promise<CredentialDefinition> {
    const definition = this.definitions.get(credentialId);
    if (
      !definition ||
      definition.status === 'REVOKED' ||
      !rotation.secretRef.trim() ||
      definition.revision !== expectedRevision
    ) {
      throw new Error(`Credential cannot rotate: ${credentialId}`);
    }

    const updated: CredentialDefinition = {
      ...definition,
      secretRef: rotation.secretRef,
      status: 'ACTIVE',
      updatedAt: rotation.occurredAt,
      lastRotatedAt: rotation.occurredAt,
      revision: definition.revision + 1,
      ...(rotation.expiresAt === undefined ? {} : { expiresAt: rotation.expiresAt }),
    };
    this.definitions.set(credentialId, clonePersistible(updated));
    return clonePersistible(updated);
  }

  async revoke(
    credentialId: string,
    reason: string,
    occurredAt: string,
    expectedRevision: number,
  ): Promise<CredentialDefinition> {
    const definition = this.definitions.get(credentialId);
    if (!definition || !reason.trim() || definition.revision !== expectedRevision) {
      throw new Error(`Credential cannot revoke: ${credentialId}`);
    }

    const updated: CredentialDefinition = {
      ...definition,
      status: 'REVOKED',
      revokedAt: occurredAt,
      revocationReason: reason,
      updatedAt: occurredAt,
      revision: definition.revision + 1,
    };
    this.definitions.set(credentialId, clonePersistible(updated));
    return clonePersistible(updated);
  }

  async evaluateExpiration(at: string): Promise<CredentialDefinition[]> {
    const timestamp = Date.parse(at);
    if (Number.isNaN(timestamp)) {
      throw new Error('Expiration evaluation time is invalid');
    }

    return [...this.definitions.values()]
      .filter(
        (definition) =>
          definition.expiresAt !== undefined &&
          Date.parse(definition.expiresAt) <= timestamp &&
          !['EXPIRED', 'REVOKED'].includes(definition.status),
      )
      .map(clonePersistible);
  }
}

export class InMemoryHealthRepository implements HealthRepository {
  private readonly observations: HealthObservation[] = [];

  async append(observation: HealthObservation): Promise<HealthObservation> {
    if (
      !observation.observationId.trim() ||
      !observation.connectorInstanceId.trim() ||
      observation.latencyMs < 0 ||
      observation.consecutiveFailures < 0
    ) {
      throw new Error('HealthObservation is invalid');
    }

    const saved = clonePersistible(observation);
    this.observations.push(saved);
    return clonePersistible(saved);
  }

  async getLatest(connectorInstanceId: string): Promise<HealthObservation | undefined> {
    const observations = await this.findHistory(connectorInstanceId);
    return observations.at(-1);
  }

  async findHistory(connectorInstanceId: string): Promise<HealthObservation[]> {
    return this.observations
      .filter((observation) => observation.connectorInstanceId === connectorInstanceId)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .map(clonePersistible);
  }
}

export class InMemoryAuditRepository implements AuditRepository {
  private readonly events: AuditEnvelope[] = [];

  async append(envelope: AuditEnvelope): Promise<AuditEnvelope> {
    await this.appendBatch([envelope]);
    return clonePersistible(envelope);
  }

  async appendBatch(envelopes: readonly AuditEnvelope[]): Promise<AuditEnvelope[]> {
    const pending = envelopes.map(clonePersistible);
    const seenEventIds = new Set(this.events.map((event) => event.eventId));
    const nextSequenceByExecution = new Map<string, number>();

    for (const event of this.events) {
      nextSequenceByExecution.set(
        event.executionId,
        Math.max(nextSequenceByExecution.get(event.executionId) ?? 0, event.sequence),
      );
    }
    for (const envelope of pending) {
      const expectedSequence = (nextSequenceByExecution.get(envelope.executionId) ?? 0) + 1;
      if (
        !envelope.eventId.trim() ||
        !envelope.executionId.trim() ||
        !envelope.actorId.trim() ||
        !envelope.connectorInstanceId.trim() ||
        !envelope.connectorRef.id.trim() ||
        !envelope.connectorRef.version.trim() ||
        envelope.schemaVersion < 1 ||
        envelope.sequence !== expectedSequence ||
        seenEventIds.has(envelope.eventId)
      ) {
        throw new Error(`AuditEnvelope is invalid: ${envelope.eventId}`);
      }

      seenEventIds.add(envelope.eventId);
      nextSequenceByExecution.set(envelope.executionId, envelope.sequence);
    }

    this.events.push(...pending);
    return pending.map(clonePersistible);
  }

  async findByExecution(executionId: string, query?: AuditQuery): Promise<AuditEnvelope[]> {
    return this.events
      .filter(
        (event) =>
          event.executionId === executionId &&
          (query?.afterSequence === undefined || event.sequence > query.afterSequence),
      )
      .sort((left, right) => left.sequence - right.sequence)
      .map(clonePersistible);
  }

  async findByConnector(
    connectorId: string,
    version?: string,
    query?: AuditQuery,
  ): Promise<AuditEnvelope[]> {
    return this.events
      .filter(
        (event) =>
          event.connectorRef.id === connectorId &&
          (version === undefined || event.connectorRef.version === version) &&
          (query?.afterSequence === undefined || event.sequence > query.afterSequence),
      )
      .sort((left, right) => left.sequence - right.sequence || left.timestamp.localeCompare(right.timestamp))
      .map(clonePersistible);
  }

  async readStream(executionId: string): Promise<AsyncIterable<AuditEnvelope>> {
    const events = await this.findByExecution(executionId);

    return (async function* (): AsyncIterable<AuditEnvelope> {
      for (const event of events) {
        yield clonePersistible(event);
      }
    })();
  }
}
