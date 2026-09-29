import type { PreparationAuditOutcome, PreparationAuditRequested } from './models.ts';
import type { ExecutionPreparationAuditPort } from './ports.ts';

export class PreparationAudit {
  private readonly port: ExecutionPreparationAuditPort;

  constructor(port: ExecutionPreparationAuditPort) {
    this.port = port;
  }

  recordRequested(event: PreparationAuditRequested): Promise<{ readonly eventId: string }> {
    return this.port.recordRequested({
      eventType: 'ExecutionPreparationRequested',
      requestId: event.requestId,
      correlationId: event.correlationId,
      executionId: event.executionId,
      actorId: event.actorId,
      capability: event.capability,
      operation: event.operation,
      reference: {
        instanceId: event.reference.instanceId,
        definitionRef: { id: event.reference.definitionRef.id, version: event.reference.definitionRef.version },
        expectedRevision: event.reference.expectedRevision,
        expectedSecurityRevision: event.reference.expectedSecurityRevision,
      },
      occurredAt: event.occurredAt,
    });
  }

  recordOutcome(event: PreparationAuditOutcome): Promise<{ readonly eventId: string }> {
    return this.port.recordOutcome({
      eventType: event.eventType,
      requestId: event.requestId,
      requestedEventId: event.requestedEventId,
      correlationId: event.correlationId,
      executionId: event.executionId,
      actorId: event.actorId,
      capability: event.capability,
      operation: event.operation,
      status: event.status,
      reference: {
        instanceId: event.reference.instanceId,
        definitionRef: { id: event.reference.definitionRef.id, version: event.reference.definitionRef.version },
        expectedRevision: event.reference.expectedRevision,
        expectedSecurityRevision: event.reference.expectedSecurityRevision,
      },
      reasons: [...event.reasons],
      expiresAt: event.expiresAt,
      occurredAt: event.occurredAt,
    });
  }
}
