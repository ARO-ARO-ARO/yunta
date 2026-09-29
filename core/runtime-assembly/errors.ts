export type RuntimeAssemblyErrorCode =
  | 'RUNTIME_NOT_FOUND'
  | 'INVALID_DEFINITION'
  | 'INCOMPATIBLE_VERSION'
  | 'INVALID_LIFECYCLE'
  | 'MISSING_REFERENCE'
  | 'TERMINAL_CONNECTOR'
  | 'RUNTIME_CONFLICT';

export interface RuntimeAssemblyErrorContext {
  readonly instanceId?: string;
  readonly connectorId?: string;
  readonly connectorVersion?: string;
}

export class RuntimeAssemblyError extends Error {
  readonly code: RuntimeAssemblyErrorCode;
  readonly instanceId?: string;
  readonly connectorId?: string;
  readonly connectorVersion?: string;

  constructor(
    code: RuntimeAssemblyErrorCode,
    message: string,
    context: RuntimeAssemblyErrorContext = {},
  ) {
    super(message);
    this.name = 'RuntimeAssemblyError';
    this.code = code;
    if (context.instanceId !== undefined) this.instanceId = context.instanceId;
    if (context.connectorId !== undefined) this.connectorId = context.connectorId;
    if (context.connectorVersion !== undefined) this.connectorVersion = context.connectorVersion;
  }
}
