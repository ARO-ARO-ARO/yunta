import type { HealthStatus } from '../contracts-foundation/domain.ts';
import type { ConnectorReference } from '../types/runtime-types.ts';
import type { HealthProbeType } from './models.ts';

export interface HealthObservedEvent {
  readonly eventId: string;
  readonly eventType: 'HealthObserved';
  readonly schemaVersion: 1;
  readonly connectorInstanceId: string;
  readonly definitionRef: ConnectorReference;
  readonly observationId: string;
  readonly checkId: string;
  readonly providerId: string;
  readonly status: HealthStatus;
  readonly probeType: HealthProbeType;
  readonly observedAt: string;
  readonly recordedAt: string;
  readonly sequence: number;
  readonly latencyMs: number | null;
  readonly consecutiveFailures: number;
  readonly correlationId: string;
}

export interface HealthChangedEvent {
  readonly eventId: string;
  readonly eventType: 'HealthChanged';
  readonly schemaVersion: 1;
  readonly connectorInstanceId: string;
  readonly observationId: string;
  readonly previousStatus: HealthStatus;
  readonly currentStatus: HealthStatus;
  readonly recordedAt: string;
  readonly sequence: number;
  readonly correlationId: string;
}

export interface HealthCheckFailedEvent {
  readonly eventId: string;
  readonly eventType: 'HealthCheckFailed';
  readonly schemaVersion: 1;
  readonly connectorInstanceId: string;
  readonly observationId: string;
  readonly checkId: string;
  readonly providerId: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly recordedAt: string;
  readonly sequence: number;
  readonly correlationId: string;
}

export type HealthEvent = HealthObservedEvent | HealthChangedEvent | HealthCheckFailedEvent;

export interface HealthEventPublisher {
  publish(event: HealthEvent): Promise<void>;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

export class InMemoryHealthEventPublisher implements HealthEventPublisher {
  private readonly events: HealthEvent[] = [];

  async publish(event: HealthEvent): Promise<void> {
    this.events.push(deepFreeze(structuredClone(event)));
  }

  list(): HealthEvent[] {
    return this.events.map((event) => deepFreeze(structuredClone(event)));
  }
}
