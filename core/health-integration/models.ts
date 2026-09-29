import type { HealthStatus } from '../contracts-foundation/domain.ts';
import type { ConnectorReference } from '../types/runtime-types.ts';

export type HealthProbeType = 'SCHEDULED' | 'ON_DEMAND' | 'PRE_EXECUTION';

export interface HealthFailureDetails {
  readonly code: string;
  readonly retryable: boolean;
}

export interface HealthSnapshot {
  readonly observationId: string;
  readonly checkId: string;
  readonly connector: {
    readonly instanceId: string;
    readonly definitionRef: ConnectorReference;
  };
  readonly status: HealthStatus;
  readonly observedAt: string;
  readonly recordedAt: string;
  readonly sequence: number;
  readonly origin: {
    readonly providerId: string;
    readonly probeType: HealthProbeType;
  };
  readonly latencyMs: number | null;
  readonly consecutiveFailures: number;
  readonly details?: HealthFailureDetails;
}

export interface NewHealthSnapshot {
  readonly observationId: string;
  readonly checkId: string;
  readonly connector: {
    readonly instanceId: string;
    readonly definitionRef: ConnectorReference;
  };
  readonly status: HealthStatus;
  readonly observedAt: string;
  readonly recordedAt: string;
  readonly origin: {
    readonly providerId: string;
    readonly probeType: HealthProbeType;
  };
  readonly latencyMs: number | null;
  readonly consecutiveFailures: number;
  readonly details?: HealthFailureDetails;
}

export interface HealthCheckRequest {
  readonly checkId: string;
  readonly idempotencyKey: string;
  readonly connectorInstanceId: string;
  readonly probeType: HealthProbeType;
  readonly correlationId: string;
}

export interface HealthCheckProviderRequest {
  readonly checkId: string;
  readonly connectorInstanceId: string;
  readonly definitionRef: ConnectorReference;
  readonly probeType: HealthProbeType;
  readonly requestedAt: string;
  readonly correlationId: string;
}

export type HealthCheckProviderResult =
  | {
      readonly outcome: 'OBSERVED';
      readonly status: HealthStatus;
      readonly observedAt: string;
      readonly latencyMs: number;
      readonly details?: HealthFailureDetails;
    }
  | {
      readonly outcome: 'FAILED';
      readonly observedAt: string;
      readonly latencyMs: number | null;
      readonly code: string;
      readonly retryable: boolean;
    };

export interface HealthHistoryQuery {
  readonly limit: number;
  readonly beforeSequence?: number;
}

export interface HealthHistoryPage {
  readonly items: readonly HealthSnapshot[];
  readonly nextBeforeSequence?: number;
}

export interface HealthAppendRequest {
  readonly idempotencyKey: string;
  readonly snapshot: NewHealthSnapshot;
}

export type HealthAppendResult =
  | {
      readonly outcome: 'APPENDED';
      readonly value: HealthSnapshot;
      readonly previous?: HealthSnapshot;
    }
  | {
      readonly outcome: 'DUPLICATE';
      readonly value: HealthSnapshot;
    };

export interface HealthRetentionPolicy {
  readonly maxObservationsPerConnector: number;
  readonly maxHistoryQueryLimit: number;
}
