import type {
  ConnectorRecord,
  ManagedConnector,
} from '../contracts-foundation/domain.ts';
import type { ConnectorReference } from '../types/runtime-types.ts';
import type { CredentialRequirement } from './models.ts';

export interface RuntimeAssemblyRepository {
  getManagedConnector(instanceId: string): Promise<ManagedConnector | undefined>;
  getDefinition(connectorId: string, version: string): Promise<ConnectorRecord | undefined>;
}

export interface RuntimeAssemblyPolicyPort {
  credentialRequirementFor(reference: ConnectorReference): CredentialRequirement;
}

export interface RuntimeAssemblyClock {
  now(): string;
}
