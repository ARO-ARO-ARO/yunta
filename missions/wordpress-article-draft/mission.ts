import type { ExecutionPreparationService } from '../../core/execution-preparation/execution-preparation-service.ts';
import type { ManagedResolver } from '../../core/managed-resolver/managed-resolver.ts';
import type { SkillEngine } from '../../core/skill-engine/engine.ts';
import type { ManagedConnectorRuntime } from '../../core/runtime-assembly/models.ts';
import type { RuntimeAssemblyReader } from './adapters.ts';
import { WordPressArticleExecution } from './execution.ts';
import type { FailureStage } from './failure-diagnostic.ts';
import type {
  WordPressArticleDraftMissionInput,
  WordPressArticleDraftMissionResult,
} from './models.ts';

const articleIntent = 'Crear un artículo';

export interface WordPressArticleExecutionFactory {
  create(resolution: import('../../core/managed-resolver/models.ts').ManagedResolution): WordPressArticleExecution;
}

function validInput(input: WordPressArticleDraftMissionInput): boolean {
  return (
    input.actorId.trim().length > 0 &&
    input.correlationId.trim().length > 0 &&
    input.title.trim().length > 0 &&
    input.contentHtml.trim().length > 0
  );
}

function matchesResolution(
  runtime: ManagedConnectorRuntime,
  resolution: import('../../core/managed-resolver/models.ts').ManagedResolution,
): boolean {
  return (
    runtime.instanceId === resolution.selected.instanceId &&
    runtime.definition.id === resolution.selected.definitionRef.id &&
    runtime.definition.version === resolution.selected.definitionRef.version &&
    runtime.managedConnector.revision === resolution.selected.expectedRevision &&
    runtime.managedConnector.securityRevision === resolution.selected.expectedSecurityRevision
  );
}

export class WordPressArticleDraftMission {
  private readonly skillEngine: SkillEngine;
  private readonly managedResolver: ManagedResolver;
  private readonly runtimeAssembly: RuntimeAssemblyReader;
  private readonly preparation: ExecutionPreparationService;
  private readonly executionFactory: WordPressArticleExecutionFactory;

  constructor(
    skillEngine: SkillEngine,
    managedResolver: ManagedResolver,
    runtimeAssembly: RuntimeAssemblyReader,
    preparation: ExecutionPreparationService,
    executionFactory: WordPressArticleExecutionFactory,
  ) {
    this.skillEngine = skillEngine;
    this.managedResolver = managedResolver;
    this.runtimeAssembly = runtimeAssembly;
    this.preparation = preparation;
    this.executionFactory = executionFactory;
  }

  async run(
    input: WordPressArticleDraftMissionInput,
    onStage?: (stage: FailureStage) => void,
  ): Promise<WordPressArticleDraftMissionResult> {
    onStage?.('MISSION_RUN');
    if (!validInput(input)) throw new Error('WordPress article mission input is invalid');
    const skill = this.skillEngine.resolve(articleIntent);
    if (!skill || skill.skill.id !== 'content.article.create' || skill.capability !== 'content.create') {
      throw new Error('WordPress article mission skill is unavailable');
    }
    const plan = this.skillEngine.createPlan(skill, {
      actorId: input.actorId,
      input: { title: input.title, contentHtml: input.contentHtml },
      metadata: {},
    });
    onStage?.('PRE_EXECUTION');
    const resolution = await this.managedResolver.resolve({
      requestId: plan.id,
      correlationId: input.correlationId,
      capability: plan.capability,
    });
    const runtime = await this.runtimeAssembly.assemble({ instanceId: resolution.selected.instanceId });
    if (!matchesResolution(runtime, resolution)) {
      throw new Error('WordPress article mission runtime changed after resolution');
    }
    const prepared = await this.preparation.prepare({
      requestId: `prepare-${plan.id}`,
      correlationId: input.correlationId,
      managedResolution: resolution,
      capability: plan.capability,
      operation: 'EXECUTE_CONNECTOR',
      actor: { actorId: input.actorId },
      context: {
        executionId: plan.id,
        planId: plan.id,
        skillRef: plan.skill,
      },
    });
    if (prepared.status === 'DENIED' || prepared.status === 'NOT_READY') {
      return Object.freeze({ status: prepared.status, preparation: prepared });
    }
    onStage?.('CONNECTOR_EXECUTION');
    const outcome = await this.executionFactory.create(resolution).execute(prepared, {
      title: input.title,
      contentHtml: input.contentHtml,
    });
    return outcome.status === 'SUCCEEDED'
      ? Object.freeze({ status: 'SUCCEEDED' as const, preparation: prepared, output: outcome.output })
      : Object.freeze({ status: 'FAILED' as const, preparation: prepared, reasonCode: outcome.reasonCode });
  }
}
