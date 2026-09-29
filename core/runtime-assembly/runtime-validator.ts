import type {
  CompatibilityDescriptor,
  ConnectorRecord,
  CredentialReference,
  ManagedConnector,
  ManagedConnectorLifecycleState,
} from '../contracts-foundation/domain.ts';
import type { ConnectorReference } from '../types/runtime-types.ts';
import { RuntimeAssemblyError } from './errors.ts';
import type {
  CredentialRequirement,
  RuntimeAssemblyConsistencyInput,
  RuntimeCompatibilityProfile,
  RuntimeEligibleLifecycleState,
} from './models.ts';

const numericVersionPattern = /^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/;
const allowedCredentialProperties = new Set([
  'credentialId',
  'providerId',
  'secretRef',
  'revision',
]);
const allowedRiskLevels = new Set(['LOW', 'MEDIUM', 'HIGH']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function compareNumericVersions(left: string, right: string): number {
  if (!numericVersionPattern.test(left) || !numericVersionPattern.test(right)) {
    throw new RuntimeAssemblyError(
      'INCOMPATIBLE_VERSION',
      'Runtime compatibility version is invalid',
    );
  }

  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function referencesMatch(left: ConnectorReference, right: ConnectorReference): boolean {
  return left.id === right.id && left.version === right.version;
}

function compatibilityValuesArePresent(compatibility: CompatibilityDescriptor): boolean {
  return (
    isNonBlankString(compatibility.connectorApiVersion) &&
    isNonBlankString(compatibility.minimumRuntimeVersion) &&
    isNonBlankString(compatibility.capabilitySchemaVersion) &&
    isNonBlankString(compatibility.definitionSchemaVersion)
  );
}

export class RuntimeValidator {
  validateRequest(instanceId: string): void {
    if (!isNonBlankString(instanceId)) {
      throw new RuntimeAssemblyError('MISSING_REFERENCE', 'Runtime assembly instance reference is required');
    }
  }

  validateManagedConnector(connector: ManagedConnector): void {
    if (
      !isNonBlankString(connector.instanceId) ||
      !isPositiveInteger(connector.schemaVersion) ||
      !isPositiveInteger(connector.revision) ||
      !isPositiveInteger(connector.securityRevision) ||
      !isNonBlankString(connector.createdAt) ||
      !isNonBlankString(connector.updatedAt)
    ) {
      throw new RuntimeAssemblyError('INVALID_DEFINITION', 'Managed connector record is invalid');
    }
    this.validateReference(connector.definitionRef, connector.instanceId);
  }

  validateLifecycle(
    state: ManagedConnectorLifecycleState,
    instanceId: string,
  ): RuntimeEligibleLifecycleState {
    if (state === 'REMOVED') {
      throw new RuntimeAssemblyError('TERMINAL_CONNECTOR', 'Managed connector is terminal', {
        instanceId,
      });
    }
    if (state === 'CONNECTED' || state === 'HEALTHY' || state === 'DEGRADED') {
      return state;
    }
    throw new RuntimeAssemblyError('INVALID_LIFECYCLE', 'Managed connector lifecycle is not eligible', {
      instanceId,
    });
  }

  validateCredentials(
    references: readonly CredentialReference[],
    requirement: CredentialRequirement,
    instanceId: string,
  ): void {
    if (requirement === 'REQUIRED' && references.length === 0) {
      throw new RuntimeAssemblyError('MISSING_REFERENCE', 'Required credential reference is missing', {
        instanceId,
      });
    }

    const credentialIds = new Set<string>();
    for (const reference of references) {
      const candidate = reference as unknown;
      if (!isRecord(candidate) || Object.keys(candidate).some((key) => !allowedCredentialProperties.has(key))) {
        throw new RuntimeAssemblyError('MISSING_REFERENCE', 'Credential reference is invalid', {
          instanceId,
        });
      }
      if (
        !isNonBlankString(candidate.credentialId) ||
        !isNonBlankString(candidate.providerId) ||
        !isNonBlankString(candidate.secretRef) ||
        !isPositiveInteger(candidate.revision) ||
        credentialIds.has(candidate.credentialId)
      ) {
        throw new RuntimeAssemblyError('MISSING_REFERENCE', 'Credential reference is invalid', {
          instanceId,
        });
      }
      credentialIds.add(candidate.credentialId);
    }
  }

  validateDefinition(record: ConnectorRecord, expectedReference: ConnectorReference): void {
    const definition = record.definition;
    if (
      !isPositiveInteger(record.schemaVersion) ||
      !isPositiveInteger(record.recordRevision) ||
      !isNonBlankString(record.checksum) ||
      !isNonBlankString(definition.id) ||
      !isNonBlankString(definition.version) ||
      definition.id !== expectedReference.id ||
      definition.version !== expectedReference.version ||
      !isNonBlankString(definition.name) ||
      !isNonBlankString(definition.description) ||
      !isNonBlankString(definition.type) ||
      !Array.isArray(definition.capabilities) ||
      definition.capabilities.length === 0 ||
      !Array.isArray(definition.permissions) ||
      definition.permissions.length === 0 ||
      (definition.status !== 'ACTIVE' && definition.status !== 'DEGRADED')
    ) {
      throw new RuntimeAssemblyError('INVALID_DEFINITION', 'Connector definition is invalid', {
        connectorId: expectedReference.id,
        connectorVersion: expectedReference.version,
      });
    }

    const capabilityIds = new Set<string>();
    for (const capability of definition.capabilities) {
      if (
        !isNonBlankString(capability.id) ||
        !isNonBlankString(capability.description) ||
        !isRecord(capability.inputSchema) ||
        !isRecord(capability.outputSchema) ||
        !allowedRiskLevels.has(capability.riskLevel) ||
        capabilityIds.has(capability.id)
      ) {
        throw new RuntimeAssemblyError('INVALID_DEFINITION', 'Connector definition is invalid', {
          connectorId: expectedReference.id,
          connectorVersion: expectedReference.version,
        });
      }
      capabilityIds.add(capability.id);
    }

    const permissions = new Set<string>();
    for (const permission of definition.permissions) {
      if (!isNonBlankString(permission) || permissions.has(permission)) {
        throw new RuntimeAssemblyError('INVALID_DEFINITION', 'Connector definition is invalid', {
          connectorId: expectedReference.id,
          connectorVersion: expectedReference.version,
        });
      }
      permissions.add(permission);
    }
  }

  validateCompatibility(record: ConnectorRecord, profile: RuntimeCompatibilityProfile): void {
    const compatibility = record.compatibility;
    if (
      !compatibilityValuesArePresent(compatibility) ||
      !numericVersionPattern.test(profile.runtimeProtocolVersion) ||
      !isNonBlankString(profile.connectorApiVersion) ||
      !isNonBlankString(profile.capabilitySchemaVersion) ||
      !isNonBlankString(profile.definitionSchemaVersion) ||
      !isPositiveInteger(profile.connectorRecordSchemaVersion) ||
      !isPositiveInteger(profile.managedConnectorSchemaVersion) ||
      record.schemaVersion !== profile.connectorRecordSchemaVersion ||
      compatibility.connectorApiVersion !== profile.connectorApiVersion ||
      compatibility.capabilitySchemaVersion !== profile.capabilitySchemaVersion ||
      compatibility.definitionSchemaVersion !== profile.definitionSchemaVersion ||
      compareNumericVersions(compatibility.minimumRuntimeVersion, profile.runtimeProtocolVersion) > 0
    ) {
      throw new RuntimeAssemblyError('INCOMPATIBLE_VERSION', 'Connector compatibility is not supported');
    }
  }

  validateManagedSchema(
    connector: ManagedConnector,
    profile: RuntimeCompatibilityProfile,
  ): void {
    if (connector.schemaVersion !== profile.managedConnectorSchemaVersion) {
      throw new RuntimeAssemblyError('INCOMPATIBLE_VERSION', 'Managed connector schema is not supported', {
        instanceId: connector.instanceId,
      });
    }
  }

  validateConsistency(
    initial: RuntimeAssemblyConsistencyInput,
    current: RuntimeAssemblyConsistencyInput,
  ): void {
    if (
      initial.instanceId !== current.instanceId ||
      !referencesMatch(initial.definitionRef, current.definitionRef) ||
      initial.lifecycleState !== current.lifecycleState ||
      initial.revision !== current.revision ||
      initial.securityRevision !== current.securityRevision ||
      initial.managedSchemaVersion !== current.managedSchemaVersion ||
      initial.connectorRecordSchemaVersion !== current.connectorRecordSchemaVersion ||
      initial.connectorRecordRevision !== current.connectorRecordRevision ||
      initial.definitionId !== current.definitionId ||
      initial.definitionVersion !== current.definitionVersion ||
      initial.definitionChecksum !== current.definitionChecksum
    ) {
      throw new RuntimeAssemblyError('RUNTIME_CONFLICT', 'Runtime assembly snapshot changed', {
        instanceId: initial.instanceId,
      });
    }
  }

  private validateReference(reference: ConnectorReference, instanceId: string): void {
    if (!isNonBlankString(reference.id) || !isNonBlankString(reference.version)) {
      throw new RuntimeAssemblyError('MISSING_REFERENCE', 'Connector definition reference is invalid', {
        instanceId,
      });
    }
  }
}
