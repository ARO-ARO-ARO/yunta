import type { ManagedConnector } from '../contracts-foundation/domain.ts';
import type {
  HealthAppendRequest,
  HealthAppendResult,
  HealthCheckProviderRequest,
  HealthCheckProviderResult,
  HealthHistoryPage,
  HealthHistoryQuery,
  HealthSnapshot,
} from './models.ts';

export interface ManagedConnectorHealthReader {
  getManagedConnector(instanceId: string): Promise<ManagedConnector | undefined>;
}

export interface HealthCheckProvider {
  readonly providerId: string;
  check(request: HealthCheckProviderRequest): Promise<HealthCheckProviderResult>;
}

export interface HealthRepository {
  append(request: HealthAppendRequest): Promise<HealthAppendResult>;
  getByIdempotencyKey(
    connectorInstanceId: string,
    idempotencyKey: string,
  ): Promise<HealthSnapshot | undefined>;
  getLatest(connectorInstanceId: string): Promise<HealthSnapshot | undefined>;
  findHistory(
    connectorInstanceId: string,
    query: HealthHistoryQuery,
  ): Promise<HealthHistoryPage>;
}

export interface HealthClock {
  now(): string;
}

export interface HealthIdGenerator {
  next(): string;
}
