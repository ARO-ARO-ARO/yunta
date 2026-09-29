import type {
  ConnectorCapability,
  ConnectorExecutionRequest,
  ConnectorExecutionResult,
  ConnectorStatus,
} from '../types/runtime-types.ts';

export interface Connector {
  id(): string;
  version(): string;
  capabilities(): readonly ConnectorCapability[];
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<ConnectorStatus>;
  execute(request: ConnectorExecutionRequest): Promise<ConnectorExecutionResult>;
}
