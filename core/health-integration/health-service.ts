import { randomUUID } from 'node:crypto';
import type { ManagedConnector } from '../contracts-foundation/domain.ts';
import { HealthIntegrationError } from './errors.ts';
import type { HealthEventPublisher } from './events.ts';
import type {
  HealthCheckProviderResult,
  HealthCheckRequest,
  HealthFailureDetails,
  HealthHistoryPage,
  HealthHistoryQuery,
  HealthSnapshot,
  NewHealthSnapshot,
} from './models.ts';
import type {
  HealthCheckProvider,
  HealthClock,
  HealthIdGenerator,
  HealthRepository,
  ManagedConnectorHealthReader,
} from './ports.ts';
import { HealthValidator } from './health-validator.ts';

const systemClock: HealthClock = {
  now: () => new Date().toISOString(),
};

const uuidGenerator: HealthIdGenerator = {
  next: () => randomUUID(),
};

interface NormalizedHealthResult {
  readonly status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  readonly observedAt: string;
  readonly latencyMs: number | null;
  readonly details?: HealthFailureDetails;
  readonly providerFailed: boolean;
}

function sameRequest(
  snapshot: HealthSnapshot,
  request: HealthCheckRequest,
  providerId: string,
): boolean {
  return (
    snapshot.checkId === request.checkId &&
    snapshot.origin.probeType === request.probeType &&
    snapshot.origin.providerId === providerId
  );
}

export class HealthService {
  private readonly connectorReader: ManagedConnectorHealthReader;
  private readonly provider: HealthCheckProvider;
  private readonly repository: HealthRepository;
  private readonly publisher: HealthEventPublisher;
  private readonly validator: HealthValidator;
  private readonly clock: HealthClock;
  private readonly idGenerator: HealthIdGenerator;

  constructor(
    connectorReader: ManagedConnectorHealthReader,
    provider: HealthCheckProvider,
    repository: HealthRepository,
    publisher: HealthEventPublisher,
    validator: HealthValidator = new HealthValidator(),
    clock: HealthClock = systemClock,
    idGenerator: HealthIdGenerator = uuidGenerator,
  ) {
    this.connectorReader = connectorReader;
    this.provider = provider;
    this.repository = repository;
    this.publisher = publisher;
    this.validator = validator;
    this.clock = clock;
    this.idGenerator = idGenerator;
  }

  async observe(request: HealthCheckRequest): Promise<HealthSnapshot> {
    this.validator.validateRequest(request);
    this.validator.validateProviderId(this.provider.providerId);

    const connector = await this.requireConnector(request.connectorInstanceId);
    this.validator.validateLifecycle(connector);

    const existing = await this.repository.getByIdempotencyKey(
      request.connectorInstanceId,
      request.idempotencyKey,
    );
    if (existing !== undefined) {
      if (!sameRequest(existing, request, this.provider.providerId)) {
        throw new HealthIntegrationError('IDEMPOTENCY_CONFLICT', 'Health idempotency key conflicts', {
          connectorInstanceId: request.connectorInstanceId,
          checkId: request.checkId,
          correlationId: request.correlationId,
        });
      }
      return existing;
    }

    const result = await this.check(request, connector);
    const current = await this.connectorReader.getManagedConnector(request.connectorInstanceId);
    this.validator.validateTargetUnchanged(connector, current);

    const previous = await this.repository.getLatest(request.connectorInstanceId);
    const candidate = this.newSnapshot(request, connector, previous, result);
    let appended;
    try {
      appended = await this.repository.append({
        idempotencyKey: request.idempotencyKey,
        snapshot: candidate,
      });
    } catch (error) {
      if (error instanceof HealthIntegrationError) throw error;
      throw new HealthIntegrationError('HEALTH_PERSISTENCE_FAILED', 'Health observation could not persist', {
        connectorInstanceId: request.connectorInstanceId,
        checkId: request.checkId,
        correlationId: request.correlationId,
      });
    }

    if (appended.outcome === 'DUPLICATE') {
      if (!sameRequest(appended.value, request, this.provider.providerId)) {
        throw new HealthIntegrationError('IDEMPOTENCY_CONFLICT', 'Health idempotency key conflicts', {
          connectorInstanceId: request.connectorInstanceId,
          checkId: request.checkId,
          correlationId: request.correlationId,
        });
      }
      return appended.value;
    }

    await this.publishEvents(appended.value, appended.previous, request, result.providerFailed);
    return appended.value;
  }

  latest(connectorInstanceId: string): Promise<HealthSnapshot | undefined> {
    if (!connectorInstanceId.trim()) {
      throw new HealthIntegrationError('INVALID_HEALTH_REQUEST', 'Health connector reference is invalid');
    }
    return this.repository.getLatest(connectorInstanceId);
  }

  history(connectorInstanceId: string, query: HealthHistoryQuery): Promise<HealthHistoryPage> {
    if (!connectorInstanceId.trim()) {
      throw new HealthIntegrationError('INVALID_HEALTH_REQUEST', 'Health connector reference is invalid');
    }
    return this.repository.findHistory(connectorInstanceId, query);
  }

  private async requireConnector(instanceId: string): Promise<ManagedConnector> {
    const connector = await this.connectorReader.getManagedConnector(instanceId);
    if (!connector) {
      throw new HealthIntegrationError('CONNECTOR_NOT_FOUND', 'Managed connector was not found', {
        connectorInstanceId: instanceId,
      });
    }
    return connector;
  }

  private async check(
    request: HealthCheckRequest,
    connector: ManagedConnector,
  ): Promise<NormalizedHealthResult> {
    let result: HealthCheckProviderResult;
    try {
      result = await this.provider.check({
        checkId: request.checkId,
        connectorInstanceId: connector.instanceId,
        definitionRef: {
          id: connector.definitionRef.id,
          version: connector.definitionRef.version,
        },
        probeType: request.probeType,
        requestedAt: this.clock.now(),
        correlationId: request.correlationId,
      });
    } catch {
      return {
        status: 'UNKNOWN',
        observedAt: this.clock.now(),
        latencyMs: null,
        details: { code: 'PROVIDER_UNAVAILABLE', retryable: true },
        providerFailed: true,
      };
    }
    this.validator.validateProviderResult(result);

    if (result.outcome === 'FAILED') {
      return {
        status: 'UNKNOWN',
        observedAt: result.observedAt,
        latencyMs: result.latencyMs,
        details: { code: result.code, retryable: result.retryable },
        providerFailed: true,
      };
    }

    return result.details === undefined
      ? {
          status: result.status,
          observedAt: result.observedAt,
          latencyMs: result.latencyMs,
          providerFailed: false,
        }
      : {
          status: result.status,
          observedAt: result.observedAt,
          latencyMs: result.latencyMs,
          details: { code: result.details.code, retryable: result.details.retryable },
          providerFailed: false,
        };
  }

  private newSnapshot(
    request: HealthCheckRequest,
    connector: ManagedConnector,
    previous: HealthSnapshot | undefined,
    result: NormalizedHealthResult,
  ): NewHealthSnapshot {
    const consecutiveFailures =
      result.status === 'HEALTHY' || result.status === 'DEGRADED'
        ? 0
        : (previous?.consecutiveFailures ?? 0) + 1;
    const base: NewHealthSnapshot = {
      observationId: this.idGenerator.next(),
      checkId: request.checkId,
      connector: {
        instanceId: connector.instanceId,
        definitionRef: {
          id: connector.definitionRef.id,
          version: connector.definitionRef.version,
        },
      },
      status: result.status,
      observedAt: result.observedAt,
      recordedAt: this.clock.now(),
      origin: {
        providerId: this.provider.providerId,
        probeType: request.probeType,
      },
      latencyMs: result.latencyMs,
      consecutiveFailures,
    };
    return result.details === undefined
      ? base
      : {
          observationId: base.observationId,
          checkId: base.checkId,
          connector: base.connector,
          status: base.status,
          observedAt: base.observedAt,
          recordedAt: base.recordedAt,
          origin: base.origin,
          latencyMs: base.latencyMs,
          consecutiveFailures: base.consecutiveFailures,
          details: result.details,
        };
  }

  private async publishEvents(
    snapshot: HealthSnapshot,
    previous: HealthSnapshot | undefined,
    request: HealthCheckRequest,
    providerFailed: boolean,
  ): Promise<void> {
    await this.publisher.publish({
      eventId: this.idGenerator.next(),
      eventType: 'HealthObserved',
      schemaVersion: 1,
      connectorInstanceId: snapshot.connector.instanceId,
      definitionRef: {
        id: snapshot.connector.definitionRef.id,
        version: snapshot.connector.definitionRef.version,
      },
      observationId: snapshot.observationId,
      checkId: snapshot.checkId,
      providerId: snapshot.origin.providerId,
      status: snapshot.status,
      probeType: snapshot.origin.probeType,
      observedAt: snapshot.observedAt,
      recordedAt: snapshot.recordedAt,
      sequence: snapshot.sequence,
      latencyMs: snapshot.latencyMs,
      consecutiveFailures: snapshot.consecutiveFailures,
      correlationId: request.correlationId,
    });
    if (previous !== undefined && previous.status !== snapshot.status) {
      await this.publisher.publish({
        eventId: this.idGenerator.next(),
        eventType: 'HealthChanged',
        schemaVersion: 1,
        connectorInstanceId: snapshot.connector.instanceId,
        observationId: snapshot.observationId,
        previousStatus: previous.status,
        currentStatus: snapshot.status,
        recordedAt: snapshot.recordedAt,
        sequence: snapshot.sequence,
        correlationId: request.correlationId,
      });
    }
    if (providerFailed && snapshot.details !== undefined) {
      await this.publisher.publish({
        eventId: this.idGenerator.next(),
        eventType: 'HealthCheckFailed',
        schemaVersion: 1,
        connectorInstanceId: snapshot.connector.instanceId,
        observationId: snapshot.observationId,
        checkId: snapshot.checkId,
        providerId: snapshot.origin.providerId,
        code: snapshot.details.code,
        retryable: snapshot.details.retryable,
        recordedAt: snapshot.recordedAt,
        sequence: snapshot.sequence,
        correlationId: request.correlationId,
      });
    }
  }
}
