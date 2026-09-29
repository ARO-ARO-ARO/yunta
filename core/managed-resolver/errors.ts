export type ManagedResolverErrorCode =
  | 'INVALID_RESOLUTION_REQUEST'
  | 'CONNECTOR_NOT_FOUND'
  | 'NO_MATCH'
  | 'AMBIGUOUS_MATCH'
  | 'INCOMPATIBLE_CONNECTOR'
  | 'UNHEALTHY_CONNECTOR'
  | 'MISSING_HEALTH'
  | 'STALE_HEALTH'
  | 'DISABLED_CONNECTOR'
  | 'TERMINAL_CONNECTOR'
  | 'VERSION_CONFLICT'
  | 'RESOLUTION_CONFLICT'
  | 'RESOLUTION_DEPENDENCY_FAILED';

export interface ManagedResolverErrorContext {
  readonly requestId?: string;
  readonly capability?: string;
  readonly instanceId?: string;
}

export class ManagedResolverError extends Error {
  readonly code: ManagedResolverErrorCode;
  readonly requestId?: string;
  readonly capability?: string;
  readonly instanceId?: string;

  constructor(
    code: ManagedResolverErrorCode,
    message: string,
    context: ManagedResolverErrorContext = {},
  ) {
    super(message);
    this.name = 'ManagedResolverError';
    this.code = code;
    if (context.requestId !== undefined) this.requestId = context.requestId;
    if (context.capability !== undefined) this.capability = context.capability;
    if (context.instanceId !== undefined) this.instanceId = context.instanceId;
  }
}
