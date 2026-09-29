import { HealthIntegrationError } from './errors.ts';
import type {
  HealthAppendRequest,
  HealthAppendResult,
  HealthHistoryPage,
  HealthHistoryQuery,
  HealthRetentionPolicy,
  HealthSnapshot,
} from './models.ts';
import type { HealthRepository } from './ports.ts';

const defaultRetentionPolicy: HealthRetentionPolicy = {
  maxObservationsPerConnector: 100,
  maxHistoryQueryLimit: 50,
};

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

function snapshot(value: HealthSnapshot): HealthSnapshot {
  return deepFreeze(structuredClone(value));
}

function idempotencyKey(connectorInstanceId: string, key: string): string {
  return `${connectorInstanceId}\u0000${key}`;
}

export class InMemoryHealthRepository implements HealthRepository {
  private readonly observationsByInstance = new Map<string, HealthSnapshot[]>();
  private readonly observationsById = new Map<string, HealthSnapshot>();
  private readonly observationsByIdempotencyKey = new Map<string, HealthSnapshot>();
  private readonly retentionPolicy: HealthRetentionPolicy;

  constructor(retentionPolicy: HealthRetentionPolicy = defaultRetentionPolicy) {
    if (
      !Number.isInteger(retentionPolicy.maxObservationsPerConnector) ||
      retentionPolicy.maxObservationsPerConnector < 1 ||
      !Number.isInteger(retentionPolicy.maxHistoryQueryLimit) ||
      retentionPolicy.maxHistoryQueryLimit < 1
    ) {
      throw new Error('Health retention policy is invalid');
    }
    this.retentionPolicy = retentionPolicy;
  }

  async append(request: HealthAppendRequest): Promise<HealthAppendResult> {
    const existingIdempotency = this.observationsByIdempotencyKey.get(
      idempotencyKey(request.snapshot.connector.instanceId, request.idempotencyKey),
    );
    if (existingIdempotency) {
      return { outcome: 'DUPLICATE', value: snapshot(existingIdempotency) };
    }
    if (this.observationsById.has(request.snapshot.observationId)) {
      throw new HealthIntegrationError('OBSERVATION_CONFLICT', 'Health observation already exists', {
        connectorInstanceId: request.snapshot.connector.instanceId,
        checkId: request.snapshot.checkId,
      });
    }

    const instanceId = request.snapshot.connector.instanceId;
    const history = this.observationsByInstance.get(instanceId) ?? [];
    const previous = history.at(-1);
    const value = snapshot({
      observationId: request.snapshot.observationId,
      checkId: request.snapshot.checkId,
      connector: {
        instanceId,
        definitionRef: {
          id: request.snapshot.connector.definitionRef.id,
          version: request.snapshot.connector.definitionRef.version,
        },
      },
      status: request.snapshot.status,
      observedAt: request.snapshot.observedAt,
      recordedAt: request.snapshot.recordedAt,
      sequence: (previous?.sequence ?? 0) + 1,
      origin: {
        providerId: request.snapshot.origin.providerId,
        probeType: request.snapshot.origin.probeType,
      },
      latencyMs: request.snapshot.latencyMs,
      consecutiveFailures: request.snapshot.consecutiveFailures,
      ...(request.snapshot.details === undefined ? {} : { details: request.snapshot.details }),
    });

    history.push(value);
    this.observationsByInstance.set(instanceId, history);
    this.observationsById.set(value.observationId, value);
    this.observationsByIdempotencyKey.set(idempotencyKey(instanceId, request.idempotencyKey), value);
    this.applyRetention(instanceId);

    return previous === undefined
      ? { outcome: 'APPENDED', value: snapshot(value) }
      : { outcome: 'APPENDED', value: snapshot(value), previous: snapshot(previous) };
  }

  async getByIdempotencyKey(
    connectorInstanceId: string,
    key: string,
  ): Promise<HealthSnapshot | undefined> {
    const value = this.observationsByIdempotencyKey.get(idempotencyKey(connectorInstanceId, key));
    return value === undefined ? undefined : snapshot(value);
  }

  async getLatest(connectorInstanceId: string): Promise<HealthSnapshot | undefined> {
    const value = this.observationsByInstance.get(connectorInstanceId)?.at(-1);
    return value === undefined ? undefined : snapshot(value);
  }

  async findHistory(
    connectorInstanceId: string,
    query: HealthHistoryQuery,
  ): Promise<HealthHistoryPage> {
    if (
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > this.retentionPolicy.maxHistoryQueryLimit ||
      (query.beforeSequence !== undefined &&
        (!Number.isInteger(query.beforeSequence) || query.beforeSequence < 1))
    ) {
      throw new HealthIntegrationError('INVALID_HEALTH_REQUEST', 'Health history query is invalid', {
        connectorInstanceId,
      });
    }
    const items = (this.observationsByInstance.get(connectorInstanceId) ?? [])
      .filter((value) => query.beforeSequence === undefined || value.sequence < query.beforeSequence)
      .slice()
      .reverse()
      .slice(0, query.limit)
      .map(snapshot);
    const last = items.at(-1);
    const remaining = (this.observationsByInstance.get(connectorInstanceId) ?? []).some(
      (value) => last !== undefined && value.sequence < last.sequence,
    );
    return remaining && last !== undefined
      ? { items, nextBeforeSequence: last.sequence }
      : { items };
  }

  private applyRetention(instanceId: string): void {
    const history = this.observationsByInstance.get(instanceId);
    if (!history) return;
    while (history.length > this.retentionPolicy.maxObservationsPerConnector) {
      const removed = history.shift();
      if (removed) {
        this.observationsById.delete(removed.observationId);
      }
    }
  }
}
