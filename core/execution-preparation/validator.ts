import { ExecutionPreparationError } from './errors.ts';
import type { ExecutionPreparationRequest, StructuralReadinessSnapshot } from './models.ts';

const requestKeys = new Set([
  'requestId',
  'correlationId',
  'managedResolution',
  'capability',
  'operation',
  'actor',
  'context',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class ExecutionPreparationValidator {
  validateRequest(request: ExecutionPreparationRequest): void {
    const candidate = request as unknown;
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).some((key) => !requestKeys.has(key)) ||
      !isNonBlank(candidate.requestId) ||
      !isNonBlank(candidate.correlationId) ||
      !isNonBlank(candidate.capability) ||
      candidate.operation !== 'EXECUTE_CONNECTOR' ||
      !isRecord(candidate.actor) ||
      !isNonBlank(candidate.actor.actorId) ||
      !isRecord(candidate.context) ||
      !isNonBlank(candidate.context.executionId) ||
      !isNonBlank(candidate.context.planId) ||
      !isRecord(candidate.context.skillRef) ||
      !isNonBlank(candidate.context.skillRef.id) ||
      !isNonBlank(candidate.context.skillRef.version) ||
      !isRecord(candidate.managedResolution) ||
      !isNonBlank(candidate.managedResolution.requestId) ||
      !isNonBlank(candidate.managedResolution.capability) ||
      !isNonBlank(candidate.managedResolution.validUntil) ||
      !isRecord(candidate.managedResolution.selected) ||
      !isNonBlank(candidate.managedResolution.selected.instanceId) ||
      !isRecord(candidate.managedResolution.selected.definitionRef) ||
      !isNonBlank(candidate.managedResolution.selected.definitionRef.id) ||
      !isNonBlank(candidate.managedResolution.selected.definitionRef.version) ||
      !Number.isInteger(candidate.managedResolution.selected.expectedRevision) ||
      !Number.isInteger(candidate.managedResolution.selected.expectedSecurityRevision) ||
      !isRecord(candidate.managedResolution.healthEvidence) ||
      !isNonBlank(candidate.managedResolution.healthEvidence.observationId) ||
      !Number.isInteger(candidate.managedResolution.healthEvidence.sequence) ||
      !isNonBlank(candidate.managedResolution.healthEvidence.recordedAt)
    ) {
      throw new ExecutionPreparationError('INVALID_PREPARATION_REQUEST', 'Preparation request is invalid');
    }
  }

  validateStructural(snapshot: StructuralReadinessSnapshot): void {
    if (
      !isNonBlank(snapshot.instanceId) ||
      !isNonBlank(snapshot.definitionRef.id) ||
      !isNonBlank(snapshot.definitionRef.version) ||
      !Number.isInteger(snapshot.revision) ||
      snapshot.revision < 1 ||
      !Number.isInteger(snapshot.securityRevision) ||
      snapshot.securityRevision < 1 ||
      !isNonBlank(snapshot.lifecycle.updatedAt) ||
      !isNonBlank(snapshot.definitionChecksum) ||
      !Number.isInteger(snapshot.connectorRecordRevision) ||
      snapshot.connectorRecordRevision < 1
    ) {
      throw new ExecutionPreparationError('RUNTIME_CONFLICT', 'Structural readiness snapshot is invalid');
    }
  }

  isEligibleLifecycle(snapshot: StructuralReadinessSnapshot): boolean {
    return (
      snapshot.lifecycle.state === 'CONNECTED' ||
      snapshot.lifecycle.state === 'HEALTHY' ||
      snapshot.lifecycle.state === 'DEGRADED'
    );
  }
}
