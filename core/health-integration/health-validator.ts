import type { ManagedConnector, ManagedConnectorLifecycleState } from '../contracts-foundation/domain.ts';
import { HealthIntegrationError } from './errors.ts';
import type {
  HealthCheckProviderResult,
  HealthCheckRequest,
  HealthFailureDetails,
  HealthProbeType,
} from './models.ts';

const healthStatuses = new Set(['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN']);
const probeTypes = new Set(['SCHEDULED', 'ON_DEMAND', 'PRE_EXECUTION']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonBlankString(value) && !Number.isNaN(Date.parse(value));
}

function isLatency(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFailureDetails(value: unknown): value is HealthFailureDetails {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'code' && key !== 'retryable')) {
    return false;
  }
  return isNonBlankString(value.code) && typeof value.retryable === 'boolean';
}

export class HealthValidator {
  validateRequest(request: HealthCheckRequest): void {
    if (
      !isNonBlankString(request.checkId) ||
      !isNonBlankString(request.idempotencyKey) ||
      !isNonBlankString(request.connectorInstanceId) ||
      !probeTypes.has(request.probeType) ||
      !isNonBlankString(request.correlationId)
    ) {
      throw new HealthIntegrationError('INVALID_HEALTH_REQUEST', 'Health check request is invalid');
    }
  }

  validateProviderId(providerId: string): void {
    if (!isNonBlankString(providerId)) {
      throw new HealthIntegrationError('INVALID_HEALTH_REQUEST', 'Health provider is invalid');
    }
  }

  validateLifecycle(connector: ManagedConnector): void {
    if (connector.lifecycleState === 'REMOVED') {
      throw new HealthIntegrationError('CONNECTOR_TERMINAL', 'Managed connector is terminal', {
        connectorInstanceId: connector.instanceId,
      });
    }
    if (!this.isProbeEligible(connector.lifecycleState)) {
      throw new HealthIntegrationError('HEALTH_CHECK_NOT_ALLOWED', 'Health check is not allowed', {
        connectorInstanceId: connector.instanceId,
      });
    }
  }

  validateTargetUnchanged(initial: ManagedConnector, current: ManagedConnector | undefined): void {
    if (
      !current ||
      !this.isProbeEligible(current.lifecycleState) ||
      initial.definitionRef.id !== current.definitionRef.id ||
      initial.definitionRef.version !== current.definitionRef.version
    ) {
      throw new HealthIntegrationError('HEALTH_TARGET_CONFLICT', 'Health check target changed', {
        connectorInstanceId: initial.instanceId,
      });
    }
  }

  validateProviderResult(result: HealthCheckProviderResult): void {
    const candidate = result as unknown;
    if (!isRecord(candidate) || !isNonBlankString(candidate.outcome)) {
      throw new HealthIntegrationError('INVALID_PROVIDER_RESULT', 'Health provider result is invalid');
    }

    if (candidate.outcome === 'OBSERVED') {
      if (
        Object.keys(candidate).some(
          (key) =>
            key !== 'outcome' &&
            key !== 'status' &&
            key !== 'observedAt' &&
            key !== 'latencyMs' &&
            key !== 'details',
        ) ||
        !healthStatuses.has(candidate.status as string) ||
        !isTimestamp(candidate.observedAt) ||
        !isLatency(candidate.latencyMs) ||
        (candidate.details !== undefined && !isFailureDetails(candidate.details))
      ) {
        throw new HealthIntegrationError('INVALID_PROVIDER_RESULT', 'Health provider result is invalid');
      }
      return;
    }

    if (
      candidate.outcome !== 'FAILED' ||
      Object.keys(candidate).some(
        (key) =>
          key !== 'outcome' &&
          key !== 'observedAt' &&
          key !== 'latencyMs' &&
          key !== 'code' &&
          key !== 'retryable',
      ) ||
      !isTimestamp(candidate.observedAt) ||
      (candidate.latencyMs !== null && !isLatency(candidate.latencyMs)) ||
      !isNonBlankString(candidate.code) ||
      typeof candidate.retryable !== 'boolean'
    ) {
      throw new HealthIntegrationError('INVALID_PROVIDER_RESULT', 'Health provider result is invalid');
    }
  }

  isProbeEligible(state: ManagedConnectorLifecycleState): boolean {
    return state === 'CONNECTED' || state === 'HEALTHY' || state === 'DEGRADED';
  }

  validateHistoryQuery(limit: number, maximum: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
      throw new HealthIntegrationError('INVALID_HEALTH_REQUEST', 'Health history query is invalid');
    }
  }

  validateProbeType(value: unknown): value is HealthProbeType {
    return typeof value === 'string' && probeTypes.has(value);
  }
}
