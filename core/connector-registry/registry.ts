import { isDeepStrictEqual } from 'node:util';
import type { Connector } from '../connector-sdk/connector.ts';
import type {
  ConnectorDefinition,
  ConnectorStatus,
  RiskLevel,
} from '../types/runtime-types.ts';

export interface ConnectorRegistration {
  definition: ConnectorDefinition;
  connector: Connector;
}

const connectorStatuses: readonly ConnectorStatus[] = [
  'ACTIVE',
  'INACTIVE',
  'DEGRADED',
  'OFFLINE',
];
const riskLevels: readonly RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

function cloneDefinition(definition: ConnectorDefinition): ConnectorDefinition {
  return structuredClone(definition);
}

function cloneRegistration(registration: ConnectorRegistration): ConnectorRegistration {
  return {
    definition: cloneDefinition(registration.definition),
    connector: registration.connector,
  };
}

export function compareConnectorVersions(left: string, right: string): number {
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

function validateDefinition(definition: ConnectorDefinition, connector: Connector): void {
  const errors: string[] = [];
  const capabilityIds = definition.capabilities.map((capability) => capability.id);
  const sdkCapabilities = connector.capabilities();
  const versionPattern = /^(0|[1-9]\d*)(\.(0|[1-9]\d*))+$/;

  if (!definition.id.trim()) errors.push('Connector id is required');
  if (!versionPattern.test(definition.version)) errors.push('Connector version is invalid');
  if (!definition.name.trim()) errors.push('Connector name is required');
  if (!definition.description.trim()) errors.push('Connector description is required');
  if (!definition.type.trim()) errors.push('Connector type is required');
  if (!connectorStatuses.includes(definition.status)) errors.push('Connector status is invalid');
  if (!connectorStatuses.includes(definition.health)) errors.push('Connector health is invalid');
  if (definition.capabilities.length === 0) errors.push('Connector requires capabilities');
  if (capabilityIds.some((id) => !id.trim())) errors.push('Capability id is required');
  if (definition.capabilities.some((capability) => !capability.description.trim())) {
    errors.push('Capability description is required');
  }
  if (
    definition.capabilities.some(
      (capability) =>
        typeof capability.inputSchema !== 'object' ||
        capability.inputSchema === null ||
        Array.isArray(capability.inputSchema) ||
        typeof capability.outputSchema !== 'object' ||
        capability.outputSchema === null ||
        Array.isArray(capability.outputSchema),
    )
  ) {
    errors.push('Capability schemas must be objects');
  }
  if (new Set(capabilityIds).size !== capabilityIds.length) {
    errors.push('Connector capability ids must be unique');
  }
  if (definition.capabilities.some((capability) => !riskLevels.includes(capability.riskLevel))) {
    errors.push('Connector capability risk is invalid');
  }
  if (
    definition.permissions.length === 0 ||
    definition.permissions.some((permission) => !permission.trim())
  ) {
    errors.push('Connector permissions must be non-empty');
  }
  if (new Set(definition.permissions).size !== definition.permissions.length) {
    errors.push('Connector permissions must be unique');
  }
  if (
    typeof definition.metadata !== 'object' ||
    definition.metadata === null ||
    Array.isArray(definition.metadata)
  ) {
    errors.push('Connector metadata must be an object');
  }
  if (connector.id() !== definition.id || connector.version() !== definition.version) {
    errors.push('Connector SDK identity does not match its definition');
  }
  if (!isDeepStrictEqual(sdkCapabilities, definition.capabilities)) {
    errors.push('Connector SDK capabilities do not match its definition');
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, ConnectorRegistration>();

  register(definition: ConnectorDefinition, connector: Connector): void {
    validateDefinition(definition, connector);
    const key = this.key(definition.id, definition.version);
    const equivalentVersionExists = [...this.connectors.values()].some(
      (registration) =>
        registration.definition.id === definition.id &&
        compareConnectorVersions(registration.definition.version, definition.version) === 0,
    );
    if (this.connectors.has(key) || equivalentVersionExists) {
      throw new Error(`Connector already registered: ${key}`);
    }

    this.connectors.set(key, {
      definition: cloneDefinition(definition),
      connector,
    });
  }

  get(id: string, version: string): ConnectorRegistration | undefined {
    const registration = this.connectors.get(this.key(id, version));
    return registration ? cloneRegistration(registration) : undefined;
  }

  list(): ConnectorRegistration[] {
    return [...this.connectors.values()].map(cloneRegistration);
  }

  update(definition: ConnectorDefinition, connector: Connector): void {
    validateDefinition(definition, connector);
    const key = this.key(definition.id, definition.version);
    if (!this.connectors.has(key)) {
      throw new Error(`Connector not registered: ${key}`);
    }

    this.connectors.set(key, {
      definition: cloneDefinition(definition),
      connector,
    });
  }

  remove(id: string, version: string): boolean {
    return this.connectors.delete(this.key(id, version));
  }

  exists(id: string, version?: string): boolean {
    if (version !== undefined) {
      return this.connectors.has(this.key(id, version));
    }

    return [...this.connectors.values()].some(
      (registration) => registration.definition.id === id,
    );
  }

  findByCapability(capability: string): ConnectorRegistration[] {
    return this.list().filter((registration) =>
      registration.definition.capabilities.some((candidate) => candidate.id === capability),
    );
  }

  getLatestVersion(id: string): ConnectorRegistration | undefined {
    return this.list()
      .filter((registration) => registration.definition.id === id)
      .sort((left, right) =>
        compareConnectorVersions(right.definition.version, left.definition.version),
      )[0];
  }

  private key(id: string, version: string): string {
    return `${id}@${version}`;
  }
}
