export type HealthIntegrationErrorCode =
  | 'INVALID_HEALTH_REQUEST'
  | 'CONNECTOR_NOT_FOUND'
  | 'CONNECTOR_TERMINAL'
  | 'HEALTH_CHECK_NOT_ALLOWED'
  | 'INVALID_PROVIDER_RESULT'
  | 'HEALTH_TARGET_CONFLICT'
  | 'OBSERVATION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'HEALTH_PERSISTENCE_FAILED';

export interface HealthIntegrationErrorContext {
  readonly connectorInstanceId?: string;
  readonly checkId?: string;
  readonly correlationId?: string;
  readonly retryable?: boolean;
}

export class HealthIntegrationError extends Error {
  readonly code: HealthIntegrationErrorCode;
  readonly connectorInstanceId?: string;
  readonly checkId?: string;
  readonly correlationId?: string;
  readonly retryable?: boolean;

  constructor(
    code: HealthIntegrationErrorCode,
    message: string,
    context: HealthIntegrationErrorContext = {},
  ) {
    super(message);
    this.name = 'HealthIntegrationError';
    this.code = code;
    if (context.connectorInstanceId !== undefined) this.connectorInstanceId = context.connectorInstanceId;
    if (context.checkId !== undefined) this.checkId = context.checkId;
    if (context.correlationId !== undefined) this.correlationId = context.correlationId;
    if (context.retryable !== undefined) this.retryable = context.retryable;
  }
}
