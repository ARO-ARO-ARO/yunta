import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import type {
  PreparationAuditOutcome,
  PreparationAuditRequested,
} from '../../core/execution-preparation/models.ts';
import { InMemoryWordPressMissionAudit } from '../../missions/wordpress-article-draft/audit.ts';
import type { WordPressArticleMissionAuditEvent } from '../../missions/wordpress-article-draft/models.ts';
import type { FailureCategory, FailureStage } from '../../missions/wordpress-article-draft/failure-diagnostic.ts';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function auditProtectedRoots(executablePath = process.execPath, sea = isSea()): readonly string[] {
  if (!sea) return [resolve(fileURLToPath(new URL('../../', import.meta.url)))];

  const executableDirectory = resolve(dirname(executablePath));
  const roots = [executableDirectory];
  // A SEA built in dist/ must also preserve the original checkout exclusion.
  for (let directory = executableDirectory; ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git')) || (
      existsSync(join(directory, 'package.json')) &&
      existsSync(join(directory, 'entrypoints', 'mcp', 'stdio.ts'))
    )) roots.push(directory);
    if (dirname(directory) === directory) break;
  }
  return roots;
}

const protectedRoots = auditProtectedRoots();

function insideProtectedRoots(path: string): boolean {
  return protectedRoots.some((root) => {
    const position = relative(root, path);
    return position === '' || (position !== '..' && !position.startsWith(`..${sep}`) && !isAbsolute(position));
  });
}

export class DuplicateMissionRequestError extends Error {
  constructor() {
    super('Mission request was already accepted');
    this.name = 'DuplicateMissionRequestError';
  }
}

export interface DurableMissionAuditEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly eventType:
    | 'MissionRequested'
    | 'ExecutionPreparationRequested'
    | 'ExecutionPreparationApproved'
    | 'ExecutionPreparationDenied'
    | 'ArticleDraftCreated'
    | 'ArticleDraftCreationFailed'
    | 'MissionResult';
  readonly requestId: string;
  readonly correlationId: string;
  readonly executionId?: string;
  readonly timestamp: string;
  readonly actorId?: string;
  readonly capability?: string;
  readonly preparationStatus?: 'READY' | 'NOT_READY' | 'DENIED';
  readonly preparationReasons?: readonly string[];
  readonly connectorInstanceId?: string;
  readonly connectorRef?: { readonly id: string; readonly version: string };
  readonly postId?: number;
  readonly status?: 'draft';
  readonly resultStatus?: 'SUCCEEDED' | 'DENIED' | 'NOT_READY' | 'FAILED';
  readonly reasonCode?: string;
  readonly failureStage?: FailureStage;
  readonly failureCategory?: FailureCategory;
  readonly elapsedMs?: number;
  readonly failureCode?: string;
}

function assertIdentifier(value: string, name: string): void {
  if (!identifierPattern.test(value)) throw new Error(`${name} is invalid`);
}

function isSafeAuditEvent(value: DurableMissionAuditEvent): boolean {
  const forbiddenKeys = new Set(['password', 'authorization', 'token', 'secret', 'contenthtml', 'raw']);
  const visit = (candidate: unknown): boolean => {
    if (Array.isArray(candidate)) return candidate.every(visit);
    if (typeof candidate !== 'object' || candidate === null) return true;
    return Object.entries(candidate).every(
      ([key, child]) => !forbiddenKeys.has(key.toLowerCase()) && visit(child),
    );
  };
  return visit(value);
}

function requestClaimPath(auditPath: string, requestId: string): string {
  const digest = createHash('sha256').update(requestId).digest('hex');
  return `${auditPath}.${digest}.claim`;
}

export class DurableWordPressMissionAudit extends InMemoryWordPressMissionAudit {
  private readonly auditPath: string;
  private readonly executionIds = new Map<string, string>();
  private readonly requestIds = new Map<string, string>();

  constructor(auditPath: string) {
    super();
    if (!auditPath.trim() || !isAbsolute(auditPath) || insideProtectedRoots(resolve(auditPath))) {
      throw new Error('Mission audit path is unavailable');
    }
    this.auditPath = resolve(auditPath);
  }

  async beginRequest(input: {
    readonly requestId: string;
    readonly correlationId: string;
    readonly timestamp: string;
  }): Promise<void> {
    assertIdentifier(input.requestId, 'Request id');
    assertIdentifier(input.correlationId, 'Correlation id');
    this.requestIds.set(input.correlationId, input.requestId);
    await this.preparePath();
    try {
      const claim = await open(requestClaimPath(this.auditPath, input.requestId), 'wx');
      await claim.close();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DuplicateMissionRequestError();
      throw new Error('Mission request could not be claimed');
    }
    await this.append({
      schemaVersion: 1,
      eventId: randomUUID(),
      eventType: 'MissionRequested',
      requestId: input.requestId,
      correlationId: input.correlationId,
      timestamp: input.timestamp,
    });
  }

  override async recordRequested(
    event: PreparationAuditRequested,
  ): Promise<{ readonly eventId: string }> {
    const eventId = randomUUID();
    this.executionIds.set(event.correlationId, event.executionId);
    await this.append({
      schemaVersion: 1,
      eventId,
      eventType: event.eventType,
      requestId: this.requestIds.get(event.correlationId) ?? event.requestId,
      correlationId: event.correlationId,
      executionId: event.executionId,
      timestamp: event.occurredAt,
      actorId: event.actorId,
      capability: event.capability,
      connectorInstanceId: event.reference.instanceId,
      connectorRef: event.reference.definitionRef,
    });
    return Object.freeze({ eventId });
  }

  override async recordOutcome(
    event: PreparationAuditOutcome,
  ): Promise<{ readonly eventId: string }> {
    const eventId = randomUUID();
    await this.append({
      schemaVersion: 1,
      eventId,
      eventType: event.eventType,
      requestId: this.requestIds.get(event.correlationId) ?? event.requestId,
      correlationId: event.correlationId,
      executionId: event.executionId,
      timestamp: event.occurredAt,
      actorId: event.actorId,
      capability: event.capability,
      preparationStatus: event.status,
      preparationReasons: [...event.reasons],
      connectorInstanceId: event.reference.instanceId,
      connectorRef: event.reference.definitionRef,
    });
    return Object.freeze({ eventId });
  }

  override async recordExecution(event: WordPressArticleMissionAuditEvent): Promise<void> {
    await this.append({
      schemaVersion: 1,
      eventId: event.eventId,
      eventType: event.eventType,
      requestId: this.requestIds.get(event.correlationId) ?? event.executionId,
      correlationId: event.correlationId,
      executionId: event.executionId,
      timestamp: event.timestamp,
      connectorInstanceId: event.connectorInstanceId,
      connectorRef: event.connectorRef,
      ...(event.eventType === 'ArticleDraftCreated'
        ? { postId: event.postId, status: event.status }
        : { reasonCode: event.reasonCode }),
    });
  }

  executionIdFor(correlationId: string): string | undefined {
    return this.executionIds.get(correlationId);
  }

  async recordResult(input: {
    readonly requestId: string;
    readonly correlationId: string;
    readonly executionId?: string;
    readonly status: 'SUCCEEDED' | 'DENIED' | 'NOT_READY' | 'FAILED';
    readonly reasonCode?: string;
    readonly postId?: number;
    readonly timestamp: string;
    readonly failureStage?: FailureStage;
    readonly failureCategory?: FailureCategory;
    readonly elapsedMs?: number;
    readonly failureCode?: string;
  }): Promise<void> {
    await this.append({
      schemaVersion: 1,
      eventId: randomUUID(),
      eventType: 'MissionResult',
      requestId: input.requestId,
      correlationId: input.correlationId,
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
      timestamp: input.timestamp,
      resultStatus: input.status,
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
      ...(input.postId === undefined ? {} : { postId: input.postId }),
      ...(input.failureStage === undefined ? {} : { failureStage: input.failureStage }),
      ...(input.failureCategory === undefined ? {} : { failureCategory: input.failureCategory }),
      ...(input.elapsedMs === undefined ? {} : { elapsedMs: input.elapsedMs }),
      ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
    });
  }

  async readEvents(): Promise<readonly DurableMissionAuditEvent[]> {
    try {
      const contents = await readFile(this.auditPath, 'utf8');
      return Object.freeze(
        contents
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => Object.freeze(JSON.parse(line) as DurableMissionAuditEvent)),
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw error;
    }
  }

  private async append(event: DurableMissionAuditEvent): Promise<void> {
    if (!isSafeAuditEvent(event)) throw new Error('Mission audit event is not safe');
    await this.preparePath();
    await appendFile(this.auditPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private async preparePath(): Promise<void> {
    const parent = await realpath(dirname(this.auditPath));
    if (insideProtectedRoots(join(parent, 'audit.jsonl'))) throw new Error('Mission audit path is unavailable');
    try {
      const target = await lstat(this.auditPath);
      if (!target.isFile() || target.isSymbolicLink()) throw new Error('Mission audit path is unavailable');
      if (process.platform !== 'win32' && (target.mode & 0o077) !== 0) {
        throw new Error('Mission audit path is unavailable');
      }
      if (insideProtectedRoots(await realpath(this.auditPath))) throw new Error('Mission audit path is unavailable');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
