import { ManagedResolverError } from './errors.ts';
import type { ManagedConnectorCandidate, ResolutionRequest } from './models.ts';

const requestKeys = new Set(['requestId', 'correlationId', 'capability', 'requiredVersion', 'constraints']);
const constraintKeys = new Set(['instanceId', 'definitionId']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class ResolverValidator {
  validateRequest(request: ResolutionRequest): void {
    const candidate = request as unknown;
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).some((key) => !requestKeys.has(key)) ||
      !isNonBlankString(candidate.requestId) ||
      !isNonBlankString(candidate.correlationId) ||
      !isNonBlankString(candidate.capability) ||
      (candidate.requiredVersion !== undefined && !isNonBlankString(candidate.requiredVersion))
    ) {
      throw new ManagedResolverError('INVALID_RESOLUTION_REQUEST', 'Resolution request is invalid');
    }
    if (candidate.constraints !== undefined) {
      if (
        !isRecord(candidate.constraints) ||
        Object.keys(candidate.constraints).some((key) => !constraintKeys.has(key)) ||
        (candidate.constraints.instanceId !== undefined &&
          !isNonBlankString(candidate.constraints.instanceId)) ||
        (candidate.constraints.definitionId !== undefined &&
          !isNonBlankString(candidate.constraints.definitionId))
      ) {
        throw new ManagedResolverError('INVALID_RESOLUTION_REQUEST', 'Resolution request is invalid');
      }
    }
  }

  validateCandidate(candidate: ManagedConnectorCandidate): void {
    if (
      !isNonBlankString(candidate.instanceId) ||
      !isNonBlankString(candidate.definitionRef.id) ||
      !isNonBlankString(candidate.definitionRef.version) ||
      !Number.isInteger(candidate.lifecycle.revision) ||
      candidate.lifecycle.revision < 1 ||
      !Number.isInteger(candidate.lifecycle.securityRevision) ||
      candidate.lifecycle.securityRevision < 1 ||
      !isNonBlankString(candidate.lifecycle.updatedAt) ||
      !isNonBlankString(candidate.compatibility.definitionChecksum) ||
      !Number.isInteger(candidate.compatibility.connectorRecordRevision) ||
      candidate.compatibility.connectorRecordRevision < 1 ||
      !Number.isFinite(candidate.policyPriority)
    ) {
      throw new ManagedResolverError('RESOLUTION_DEPENDENCY_FAILED', 'Candidate projection is invalid');
    }
  }

  isLifecycleEligible(candidate: ManagedConnectorCandidate): boolean {
    return (
      candidate.lifecycle.state === 'CONNECTED' ||
      candidate.lifecycle.state === 'HEALTHY' ||
      candidate.lifecycle.state === 'DEGRADED'
    );
  }
}
