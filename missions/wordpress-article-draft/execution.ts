import { randomUUID } from 'node:crypto';
import type { ConnectorRegistry } from '../../core/connector-registry/registry.ts';
import type {
  ConnectorAuthorization,
  ConnectorContext,
} from '../../core/types/runtime-types.ts';
import type { ExecutionPreparationResult } from '../../core/execution-preparation/models.ts';
import type { LatestPreparationHealthReader, StructuralReadinessReader } from '../../core/execution-preparation/ports.ts';
import type { ManagedResolution } from '../../core/managed-resolver/models.ts';
import type {
  WordPressArticleDraftInput,
  WordPressArticleDraftOutput,
  WordPressArticleExecutionFailureCode,
  WordPressArticleExecutionOutcome,
} from './models.ts';
import type { InMemoryWordPressMissionAudit } from './audit.ts';

export interface WordPressExecutionClock {
  now(): string;
}

export interface WordPressConnectorAuthorizationIssuer {
  issue(input: {
    readonly executionId: string;
    readonly capability: string;
    readonly connector: { readonly id: string; readonly version: string };
  }): ConnectorAuthorization;
  context(input: {
    readonly executionId: string;
    readonly capability: string;
    readonly connectorId: string;
  }): ConnectorContext;
}

const systemClock: WordPressExecutionClock = { now: () => new Date().toISOString() };

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function validInput(input: WordPressArticleDraftInput): boolean {
  return input.title.trim().length > 0 && input.contentHtml.trim().length > 0;
}

export class WordPressArticleExecution {
  private readonly registry: ConnectorRegistry;
  private readonly structuralReader: StructuralReadinessReader;
  private readonly healthReader: LatestPreparationHealthReader;
  private readonly resolution: ManagedResolution;
  private readonly authorization: WordPressConnectorAuthorizationIssuer;
  private readonly audit: InMemoryWordPressMissionAudit;
  private readonly clock: WordPressExecutionClock;
  private readonly attemptedExecutionIds = new Set<string>();

  constructor(
    registry: ConnectorRegistry,
    structuralReader: StructuralReadinessReader,
    healthReader: LatestPreparationHealthReader,
    resolution: ManagedResolution,
    authorization: WordPressConnectorAuthorizationIssuer,
    audit: InMemoryWordPressMissionAudit,
    clock: WordPressExecutionClock = systemClock,
  ) {
    this.registry = registry;
    this.structuralReader = structuralReader;
    this.healthReader = healthReader;
    this.resolution = resolution;
    this.authorization = authorization;
    this.audit = audit;
    this.clock = clock;
  }

  async execute(
    preparation: ExecutionPreparationResult,
    input: WordPressArticleDraftInput,
  ): Promise<WordPressArticleExecutionOutcome> {
    const precheck = await this.precheck(preparation, input);
    if (precheck !== undefined) return this.failed(preparation, precheck, false);
    if (this.attemptedExecutionIds.has(preparation.executionId)) {
      return this.failed(preparation, 'EXECUTION_ALREADY_ATTEMPTED', false);
    }
    this.attemptedExecutionIds.add(preparation.executionId);

    const registration = this.registry.get(
      preparation.referenceAssessment.reference.definitionRef.id,
      preparation.referenceAssessment.reference.definitionRef.version,
    );
    if (!registration || registration.definition.id !== 'wordpress.connector') {
      return this.failed(preparation, 'EXECUTION_CONNECTOR_UNAVAILABLE', true);
    }
    try {
      await registration.connector.connect();
      const request = {
        connector: {
          id: preparation.referenceAssessment.reference.definitionRef.id,
          version: preparation.referenceAssessment.reference.definitionRef.version,
        },
        capability: 'content.create',
        input: { title: input.title, contentHtml: input.contentHtml },
        context: this.authorization.context({
          executionId: preparation.executionId,
          capability: 'content.create',
          connectorId: registration.definition.id,
        }),
        authorization: this.authorization.issue({
          executionId: preparation.executionId,
          capability: 'content.create',
          connector: {
            id: preparation.referenceAssessment.reference.definitionRef.id,
            version: preparation.referenceAssessment.reference.definitionRef.version,
          },
        }),
      };
      const result = await registration.connector.execute(request);
      if (result.status !== 'SUCCEEDED' || !this.isDraftOutput(result.output)) {
        return this.failed(preparation, this.connectorFailureCode(result), true);
      }
      const output = freeze({
        postId: result.output.postId,
        status: 'draft' as const,
        resourceUrl: result.output.resourceUrl,
      });
      await this.audit.recordExecution({
        eventType: 'ArticleDraftCreated',
        eventId: randomUUID(),
        executionId: preparation.executionId,
        correlationId: preparation.correlationId,
        connectorInstanceId: preparation.referenceAssessment.reference.instanceId,
        connectorRef: {
          id: preparation.referenceAssessment.reference.definitionRef.id,
          version: preparation.referenceAssessment.reference.definitionRef.version,
        },
        preparationOutcomeEventId: preparation.audit.outcomeEventId,
        postId: output.postId,
        status: 'draft',
        timestamp: this.clock.now(),
      });
      return freeze({ status: 'SUCCEEDED' as const, output });
    } catch {
      // The POST may already have succeeded even when final audit persistence fails.
      return freeze({ status: 'FAILED' as const, reasonCode: 'EXECUTION_OUTCOME_AMBIGUOUS' as const });
    } finally {
      await registration.connector.disconnect().catch(() => undefined);
    }
  }

  private async precheck(
    preparation: ExecutionPreparationResult,
    input: WordPressArticleDraftInput,
  ): Promise<WordPressArticleExecutionFailureCode | undefined> {
    const reference = preparation.referenceAssessment.reference;
    if (
      preparation.status !== 'READY' ||
      preparation.executionId !== this.resolution.requestId ||
      preparation.capability !== 'content.create' ||
      this.resolution.capability !== preparation.capability ||
      reference.instanceId !== this.resolution.selected.instanceId ||
      reference.definitionRef.id !== 'wordpress.connector' ||
      reference.definitionRef.id !== this.resolution.selected.definitionRef.id ||
      reference.definitionRef.version !== this.resolution.selected.definitionRef.version ||
      reference.expectedRevision !== this.resolution.selected.expectedRevision ||
      reference.expectedSecurityRevision !== this.resolution.selected.expectedSecurityRevision ||
      !validInput(input)
    ) {
      return 'PREPARATION_NOT_READY';
    }
    if (Date.parse(this.clock.now()) >= Date.parse(preparation.expiresAt)) {
      return 'PREPARATION_EXPIRED';
    }
    try {
      const [structural, health] = await Promise.all([
        this.structuralReader.inspect(reference.instanceId),
        this.healthReader.getLatest(reference.instanceId),
      ]);
      if (
        structural === undefined ||
        structural.instanceId !== reference.instanceId ||
        structural.definitionRef.id !== reference.definitionRef.id ||
        structural.definitionRef.version !== reference.definitionRef.version ||
        structural.revision !== reference.expectedRevision ||
        structural.securityRevision !== reference.expectedSecurityRevision
      ) {
        return 'EXECUTION_REFERENCE_CONFLICT';
      }
      if (
        health === undefined ||
        health.observationId !== this.resolution.healthEvidence.observationId ||
        health.sequence !== this.resolution.healthEvidence.sequence ||
        health.status !== this.resolution.healthEvidence.status ||
        health.definitionRef.id !== reference.definitionRef.id ||
        health.definitionRef.version !== reference.definitionRef.version
      ) {
        return 'EXECUTION_HEALTH_CONFLICT';
      }
      return undefined;
    } catch {
      return 'EXECUTION_REFERENCE_CONFLICT';
    }
  }

  private isDraftOutput(value: unknown): value is WordPressArticleDraftOutput {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return (
      Number.isInteger(candidate.postId) &&
      (candidate.postId as number) > 0 &&
      candidate.status === 'draft' &&
      typeof candidate.resourceUrl === 'string' &&
      candidate.resourceUrl.trim().length > 0
    );
  }

  private connectorFailureCode(result: { readonly errors: readonly string[] }): WordPressArticleExecutionFailureCode {
    const code = result.errors[0];
    return code === 'EXECUTION_OUTCOME_AMBIGUOUS' || code?.startsWith('WORDPRESS_')
      ? code as WordPressArticleExecutionFailureCode
      : 'WORDPRESS_REQUEST_FAILED';
  }

  private async failed(
    preparation: ExecutionPreparationResult,
    reasonCode: WordPressArticleExecutionFailureCode,
    attempted: boolean,
  ): Promise<WordPressArticleExecutionOutcome> {
    if (attempted) {
      await this.audit.recordExecution({
        eventType: 'ArticleDraftCreationFailed',
        eventId: randomUUID(),
        executionId: preparation.executionId,
        correlationId: preparation.correlationId,
        connectorInstanceId: preparation.referenceAssessment.reference.instanceId,
        connectorRef: {
          id: preparation.referenceAssessment.reference.definitionRef.id,
          version: preparation.referenceAssessment.reference.definitionRef.version,
        },
        preparationOutcomeEventId: preparation.audit.outcomeEventId,
        reasonCode: this.auditReason(reasonCode),
        timestamp: this.clock.now(),
      });
    }
    return freeze({ status: 'FAILED' as const, reasonCode });
  }

  private auditReason(reason: WordPressArticleExecutionFailureCode): import('./models.ts').WordPressArticleMissionReason {
    return reason === 'EXECUTION_OUTCOME_AMBIGUOUS' || reason.startsWith('WORDPRESS_')
      ? reason as import('./models.ts').WordPressArticleMissionReason
      : 'WORDPRESS_REQUEST_FAILED';
  }
}
