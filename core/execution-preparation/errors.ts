export type ExecutionPreparationErrorCode =
  | 'INVALID_PREPARATION_REQUEST'
  | 'REFERENCE_CONFLICT'
  | 'RUNTIME_CONFLICT'
  | 'HEALTH_CONFLICT'
  | 'HEALTH_EXPIRED'
  | 'AUTHORIZATION_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'CREDENTIAL_NOT_READY'
  | 'AUDIT_PERSISTENCE_FAILED'
  | 'PREPARATION_CONFLICT';

export class ExecutionPreparationError extends Error {
  readonly code: ExecutionPreparationErrorCode;
  readonly requestId?: string;

  constructor(code: ExecutionPreparationErrorCode, message: string, requestId?: string) {
    super(message);
    this.name = 'ExecutionPreparationError';
    this.code = code;
    if (requestId !== undefined) this.requestId = requestId;
  }
}
