export type FailureStage =
  | 'CONFIGURATION' | 'HEALTH_CHECK' | 'PRE_EXECUTION' | 'MISSION_RUN'
  | 'CONNECTOR_EXECUTION' | 'READBACK' | 'UNKNOWN';

export type FailureCategory =
  | 'TIMEOUT' | 'NETWORK' | 'HTTP' | 'AUTHENTICATION'
  | 'VALIDATION' | 'CONFIGURATION' | 'INTERNAL' | 'UNKNOWN';

// Only recognize fixed error codes. Never persist an exception's message, stack, or arbitrary code.
export function networkFailureCategory(error: unknown, timedOut: boolean): FailureCategory {
  if (timedOut) return 'TIMEOUT';
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' && new Set([
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'ETIMEDOUT',
    'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  ]).has(code) ? 'NETWORK' : 'UNKNOWN';
}

export function categoryForHealthCode(code: string | undefined): FailureCategory {
  switch (code) {
    case 'HEALTH_TIMEOUT': return 'TIMEOUT';
    case 'HEALTH_NETWORK': return 'NETWORK';
    case 'HEALTH_HTTP': return 'HTTP';
    case 'HEALTH_AUTHENTICATION': return 'AUTHENTICATION';
    default: return 'UNKNOWN';
  }
}
