import type {
  ExecutionPreparationAuditPort,
} from '../../core/execution-preparation/ports.ts';
import type {
  PreparationAuditOutcome,
  PreparationAuditRequested,
} from '../../core/execution-preparation/models.ts';
import type { WordPressArticleMissionAuditEvent } from './models.ts';

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

export class InMemoryWordPressMissionAudit implements ExecutionPreparationAuditPort {
  private readonly preparationEvents: Array<PreparationAuditRequested | PreparationAuditOutcome> = [];
  private readonly executionEvents: WordPressArticleMissionAuditEvent[] = [];
  private sequence = 0;

  async recordRequested(event: PreparationAuditRequested): Promise<{ readonly eventId: string }> {
    const eventId = this.nextId();
    this.preparationEvents.push(freeze(structuredClone(event)));
    return Object.freeze({ eventId });
  }

  async recordOutcome(event: PreparationAuditOutcome): Promise<{ readonly eventId: string }> {
    const eventId = this.nextId();
    this.preparationEvents.push(freeze(structuredClone(event)));
    return Object.freeze({ eventId });
  }

  async recordExecution(event: WordPressArticleMissionAuditEvent): Promise<void> {
    this.executionEvents.push(freeze(structuredClone(event)));
  }

  listPreparation(): readonly (PreparationAuditRequested | PreparationAuditOutcome)[] {
    return freeze(structuredClone(this.preparationEvents));
  }

  listExecution(): readonly WordPressArticleMissionAuditEvent[] {
    return freeze(structuredClone(this.executionEvents));
  }

  private nextId(): string {
    this.sequence += 1;
    return `wordpress-mission-audit-${this.sequence}`;
  }
}
