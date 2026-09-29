import type {
  ConnectorRecord,
  ManagedConnector,
} from '../contracts-foundation/domain.ts';
import { RuntimeAssemblyError } from './errors.ts';
import type {
  ManagedConnectorRuntime,
  RuntimeAssemblyConsistencyInput,
  RuntimeAssemblyRequest,
  RuntimeCompatibilityProfile,
} from './models.ts';
import type {
  RuntimeAssemblyClock,
  RuntimeAssemblyPolicyPort,
  RuntimeAssemblyRepository,
} from './ports.ts';
import { RuntimeValidator } from './runtime-validator.ts';

const systemClock: RuntimeAssemblyClock = {
  now: () => new Date().toISOString(),
};

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const entry of Object.values(value)) {
    deepFreeze(entry, seen);
  }
  return Object.freeze(value);
}

function consistencyInput(
  connector: ManagedConnector,
  record: ConnectorRecord,
): RuntimeAssemblyConsistencyInput {
  return {
    instanceId: connector.instanceId,
    definitionRef: {
      id: connector.definitionRef.id,
      version: connector.definitionRef.version,
    },
    lifecycleState: connector.lifecycleState,
    revision: connector.revision,
    securityRevision: connector.securityRevision,
    managedSchemaVersion: connector.schemaVersion,
    connectorRecordSchemaVersion: record.schemaVersion,
    connectorRecordRevision: record.recordRevision,
    definitionId: record.definition.id,
    definitionVersion: record.definition.version,
    definitionChecksum: record.checksum,
  };
}

export class RuntimeAssembler {
  private readonly repository: RuntimeAssemblyRepository;
  private readonly validator: RuntimeValidator;
  private readonly policy: RuntimeAssemblyPolicyPort;
  private readonly compatibility: RuntimeCompatibilityProfile;
  private readonly clock: RuntimeAssemblyClock;

  constructor(
    repository: RuntimeAssemblyRepository,
    validator: RuntimeValidator,
    policy: RuntimeAssemblyPolicyPort,
    compatibility: RuntimeCompatibilityProfile,
    clock: RuntimeAssemblyClock = systemClock,
  ) {
    this.repository = repository;
    this.validator = validator;
    this.policy = policy;
    this.compatibility = compatibility;
    this.clock = clock;
  }

  async assemble(request: RuntimeAssemblyRequest): Promise<ManagedConnectorRuntime> {
    this.validator.validateRequest(request.instanceId);
    const connector = await this.repository.getManagedConnector(request.instanceId);
    if (!connector) {
      throw new RuntimeAssemblyError('RUNTIME_NOT_FOUND', 'Managed connector runtime was not found', {
        instanceId: request.instanceId,
      });
    }

    const lifecycleState = this.validator.validateLifecycle(
      connector.lifecycleState,
      connector.instanceId,
    );
    this.validator.validateManagedConnector(connector);
    this.validator.validateManagedSchema(connector, this.compatibility);

    const requirement = this.policy.credentialRequirementFor(connector.definitionRef);
    this.validator.validateCredentials(connector.credentialRefs, requirement, connector.instanceId);

    const record = await this.repository.getDefinition(
      connector.definitionRef.id,
      connector.definitionRef.version,
    );
    if (!record) {
      throw new RuntimeAssemblyError('INVALID_DEFINITION', 'Connector definition was not found', {
        connectorId: connector.definitionRef.id,
        connectorVersion: connector.definitionRef.version,
      });
    }
    this.validator.validateDefinition(record, connector.definitionRef);
    this.validator.validateCompatibility(record, this.compatibility);

    const currentConnector = await this.repository.getManagedConnector(request.instanceId);
    const currentRecord = await this.repository.getDefinition(
      connector.definitionRef.id,
      connector.definitionRef.version,
    );
    if (!currentConnector || !currentRecord) {
      throw new RuntimeAssemblyError('RUNTIME_CONFLICT', 'Runtime assembly snapshot changed', {
        instanceId: request.instanceId,
      });
    }
    this.validator.validateConsistency(
      consistencyInput(connector, record),
      consistencyInput(currentConnector, currentRecord),
    );

    const runtime = this.snapshot(connector, record, lifecycleState, requirement);
    try {
      return deepFreeze(structuredClone(runtime));
    } catch {
      throw new RuntimeAssemblyError('INVALID_DEFINITION', 'Runtime assembly snapshot is invalid', {
        instanceId: connector.instanceId,
      });
    }
  }

  private snapshot(
    connector: ManagedConnector,
    record: ConnectorRecord,
    lifecycleState: 'CONNECTED' | 'HEALTHY' | 'DEGRADED',
    requirement: 'REQUIRED' | 'OPTIONAL',
  ): ManagedConnectorRuntime {
    const definition = record.definition;
    const status = definition.status === 'ACTIVE' ? 'ACTIVE' : 'DEGRADED';

    return {
      instanceId: connector.instanceId,
      definition: {
        id: definition.id,
        version: definition.version,
        name: definition.name,
        description: definition.description,
        type: definition.type,
        status,
        capabilities: definition.capabilities.map((capability) => ({
          id: capability.id,
          description: capability.description,
          inputSchema: capability.inputSchema,
          outputSchema: capability.outputSchema,
          riskLevel: capability.riskLevel,
        })),
      },
      managedConnector: {
        definitionRef: {
          id: connector.definitionRef.id,
          version: connector.definitionRef.version,
        },
        schemaVersion: connector.schemaVersion,
        revision: connector.revision,
        securityRevision: connector.securityRevision,
        createdAt: connector.createdAt,
        updatedAt: connector.updatedAt,
      },
      lifecycle: {
        state: lifecycleState,
        readiness: 'STRUCTURALLY_READY',
      },
      compatibility: {
        connectorApiVersion: record.compatibility.connectorApiVersion,
        minimumRuntimeVersion: record.compatibility.minimumRuntimeVersion,
        capabilitySchemaVersion: record.compatibility.capabilitySchemaVersion,
        definitionSchemaVersion: record.compatibility.definitionSchemaVersion,
      },
      permissions: definition.permissions.map((permission) => permission),
      credentials: {
        requirement,
        references: connector.credentialRefs.map((reference) => ({
          credentialId: reference.credentialId,
          providerId: reference.providerId,
          secretRef: reference.secretRef,
          revision: reference.revision,
        })),
        availability: 'NOT_VERIFIED',
      },
      operationalMetadata: {
        assembledAt: this.clock.now(),
        connectorRecordSchemaVersion: record.schemaVersion,
        connectorRecordRevision: record.recordRevision,
        definitionChecksum: record.checksum,
        healthValidation: 'NOT_PERFORMED',
        credentialAvailability: 'NOT_VERIFIED',
        consistencyCheck: 'VERIFIED_BY_REREAD',
      },
    };
  }
}
