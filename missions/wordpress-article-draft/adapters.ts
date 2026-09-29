import type { ManagedConnector } from '../../core/contracts-foundation/domain.ts';
import { ConnectorRegistry } from '../../core/connector-registry/registry.ts';
import type { HealthRepository } from '../../core/health-integration/ports.ts';
import type {
  ManagedCandidateHealthSnapshot,
  ManagedStructuralCandidate,
} from '../../core/managed-resolver/models.ts';
import type {
  LatestManagedHealthReader,
  ManagedCandidateSource,
  ManagedStructuralEligibilityReader,
} from '../../core/managed-resolver/ports.ts';
import type { ManagedConnectorRuntime } from '../../core/runtime-assembly/models.ts';
import type {
  AuthorizationAuthority,
  CredentialReadinessAuthority,
  LatestPreparationHealthReader,
  StructuralReadinessReader,
} from '../../core/execution-preparation/ports.ts';
import type {
  PreparationHealthSnapshot,
  StructuralReadinessSnapshot,
} from '../../core/execution-preparation/models.ts';
import { WordPressConnector } from '../../connectors/wordpress.connector/connector.ts';
import { WordPressConnectorDefinition } from '../../connectors/wordpress.connector/definition.ts';

export interface RuntimeAssemblyReader {
  assemble(request: { readonly instanceId: string }): Promise<ManagedConnectorRuntime>;
}

export function registerWordPressConnector(
  registry: ConnectorRegistry,
  connector: WordPressConnector,
): void {
  registry.register(WordPressConnectorDefinition, connector);
}

export interface ManagedConnectorListReader {
  listManagedConnectors(): Promise<readonly ManagedConnector[]>;
}

function healthSnapshot(snapshot: Awaited<ReturnType<HealthRepository['getLatest']>>):
  | ManagedCandidateHealthSnapshot
  | undefined {
  if (snapshot === undefined) return undefined;
  return {
    observationId: snapshot.observationId,
    sequence: snapshot.sequence,
    status: snapshot.status,
    recordedAt: snapshot.recordedAt,
  };
}

function structuralForManagedResolver(runtime: ManagedConnectorRuntime): ManagedStructuralCandidate {
  return {
    instanceId: runtime.instanceId,
    definitionRef: { id: runtime.definition.id, version: runtime.definition.version },
    capabilities: runtime.definition.capabilities.map((capability) => ({
      id: capability.id,
      riskLevel: capability.riskLevel,
    })),
    definitionStatus: runtime.definition.status,
    lifecycle: {
      state: runtime.lifecycle.state,
      revision: runtime.managedConnector.revision,
      securityRevision: runtime.managedConnector.securityRevision,
      updatedAt: runtime.managedConnector.updatedAt,
    },
    compatibility: {
      status: 'COMPATIBLE',
      definitionChecksum: runtime.operationalMetadata.definitionChecksum,
      connectorRecordRevision: runtime.operationalMetadata.connectorRecordRevision,
    },
  };
}

function structuralForPreparation(runtime: ManagedConnectorRuntime): StructuralReadinessSnapshot {
  return {
    instanceId: runtime.instanceId,
    definitionRef: { id: runtime.definition.id, version: runtime.definition.version },
    lifecycle: {
      state: runtime.lifecycle.state,
      updatedAt: runtime.managedConnector.updatedAt,
    },
    revision: runtime.managedConnector.revision,
    securityRevision: runtime.managedConnector.securityRevision,
    capabilities: runtime.definition.capabilities.map((capability) => ({
      id: capability.id,
      riskLevel: capability.riskLevel,
    })),
    permissions: [...runtime.permissions],
    credentialRequirement: runtime.credentials.requirement,
    credentialReferences: runtime.credentials.references.map((reference) => ({
      credentialId: reference.credentialId,
      providerId: reference.providerId,
      revision: reference.revision,
    })),
    connectorRecordRevision: runtime.operationalMetadata.connectorRecordRevision,
    definitionChecksum: runtime.operationalMetadata.definitionChecksum,
  };
}

export class ManagedConnectorListAdapter implements ManagedCandidateSource {
  private readonly repository: ManagedConnectorListReader;

  constructor(repository: ManagedConnectorListReader) {
    this.repository = repository;
  }

  async listInstanceIds(): Promise<readonly string[]> {
    const connectors = await this.repository.listManagedConnectors();
    return Object.freeze(connectors.map((connector) => connector.instanceId));
  }
}

export class RuntimeAssemblyManagedStructuralAdapter implements ManagedStructuralEligibilityReader {
  private readonly runtime: RuntimeAssemblyReader;

  constructor(runtime: RuntimeAssemblyReader) {
    this.runtime = runtime;
  }

  async inspect(instanceId: string): Promise<ManagedStructuralCandidate | undefined> {
    try {
      return structuralForManagedResolver(await this.runtime.assemble({ instanceId }));
    } catch {
      return undefined;
    }
  }
}

export class RuntimeAssemblyPreparationStructuralAdapter implements StructuralReadinessReader {
  private readonly runtime: RuntimeAssemblyReader;

  constructor(runtime: RuntimeAssemblyReader) {
    this.runtime = runtime;
  }

  async inspect(instanceId: string): Promise<StructuralReadinessSnapshot | undefined> {
    try {
      return structuralForPreparation(await this.runtime.assemble({ instanceId }));
    } catch {
      return undefined;
    }
  }
}

export class B3ManagedHealthAdapter implements LatestManagedHealthReader {
  private readonly repository: HealthRepository;

  constructor(repository: HealthRepository) {
    this.repository = repository;
  }

  async getLatest(instanceId: string): Promise<ManagedCandidateHealthSnapshot | undefined> {
    return healthSnapshot(await this.repository.getLatest(instanceId));
  }
}

export class B3PreparationHealthAdapter implements LatestPreparationHealthReader {
  private readonly repository: HealthRepository;

  constructor(repository: HealthRepository) {
    this.repository = repository;
  }

  async getLatest(instanceId: string): Promise<PreparationHealthSnapshot | undefined> {
    const snapshot = await this.repository.getLatest(instanceId);
    if (snapshot === undefined) return undefined;
    return {
      observationId: snapshot.observationId,
      sequence: snapshot.sequence,
      status: snapshot.status,
      recordedAt: snapshot.recordedAt,
      definitionRef: {
        id: snapshot.connector.definitionRef.id,
        version: snapshot.connector.definitionRef.version,
      },
    };
  }
}

export interface MissionActorAuthority {
  getActor(actorId: string): Promise<{
    readonly active: boolean;
    readonly permissions: readonly string[];
  } | undefined>;
}

export interface MissionSkillAuthority {
  getSkill(reference: { readonly id: string; readonly version: string }): Promise<{
    readonly active: boolean;
    readonly capability: string;
    readonly permissions: readonly string[];
  } | undefined>;
}

export class MissionAuthorizationAdapter implements AuthorizationAuthority {
  private readonly actors: MissionActorAuthority;
  private readonly skills: MissionSkillAuthority;

  constructor(actors: MissionActorAuthority, skills: MissionSkillAuthority) {
    this.actors = actors;
    this.skills = skills;
  }

  async read(input: Parameters<AuthorizationAuthority['read']>[0]): Promise<Awaited<ReturnType<AuthorizationAuthority['read']>>> {
    const [actor, skill] = await Promise.all([
      this.actors.getActor(input.actorId),
      this.skills.getSkill(input.skillRef),
    ]);
    return {
      actorActive: actor?.active ?? false,
      actorPermissions: actor?.permissions ?? [],
      skillActive: skill?.active ?? false,
      skillCapability: skill?.capability ?? '',
      skillPermissions: skill?.permissions ?? [],
      explicitDeny: false,
      approvalGranted: false,
      evaluatedAt: new Date().toISOString(),
    };
  }
}

export interface WordPressCredentialBinding {
  readonly connectorInstanceId: string;
  readonly credentialId: string;
  readonly providerId: string;
  readonly revision: number;
  readonly purpose: 'EXECUTE_CONNECTOR';
}

export interface WordPressEnvironmentAvailability {
  isConfigured(): boolean;
}

export class WordPressCredentialReadinessAdapter implements CredentialReadinessAuthority {
  private readonly binding: WordPressCredentialBinding;
  private readonly environment: WordPressEnvironmentAvailability;

  constructor(binding: WordPressCredentialBinding, environment: WordPressEnvironmentAvailability) {
    this.binding = binding;
    this.environment = environment;
  }

  async inspect(input: Parameters<CredentialReadinessAuthority['inspect']>[0]): Promise<Awaited<ReturnType<CredentialReadinessAuthority['inspect']>>> {
    const ownershipMatches = input.connectorInstanceId === this.binding.connectorInstanceId;
    const referenceMatches =
      input.reference.credentialId === this.binding.credentialId &&
      input.reference.providerId === this.binding.providerId &&
      input.reference.revision === this.binding.revision;
    return {
      exists: this.environment.isConfigured(),
      ownershipMatches,
      referenceMatches,
      purposeMatches: input.operation === this.binding.purpose && input.capability === 'content.create',
      status: this.environment.isConfigured() ? 'ACTIVE' : 'REGISTERED',
    };
  }
}
