import { randomUUID } from 'node:crypto';
import { ConnectorRegistry } from '../../core/connector-registry/registry.ts';
import { InMemoryConnectorRepository } from '../../core/contracts-foundation/in-memory.ts';
import type { ConnectorRecord, ManagedConnector } from '../../core/contracts-foundation/domain.ts';
import { AuthorizationEvaluator } from '../../core/execution-preparation/authorization-evaluator.ts';
import { CredentialReadinessChecker } from '../../core/execution-preparation/credential-readiness-checker.ts';
import { ExecutionPreparationService } from '../../core/execution-preparation/execution-preparation-service.ts';
import { StaticExecutionPreparationPolicy } from '../../core/execution-preparation/policies.ts';
import { PreparationAudit } from '../../core/execution-preparation/preparation-audit.ts';
import { InMemoryHealthRepository } from '../../core/health-integration/in-memory-health-repository.ts';
import { InMemoryHealthEventPublisher } from '../../core/health-integration/events.ts';
import { HealthService } from '../../core/health-integration/health-service.ts';
import { DefaultManagedCandidateCatalog } from '../../core/managed-resolver/candidate-catalog.ts';
import { ManagedResolver } from '../../core/managed-resolver/managed-resolver.ts';
import { StaticResolverPolicy } from '../../core/managed-resolver/resolver-policy.ts';
import { PermissionEvaluator } from '../../core/permission-engine/evaluator.ts';
import { RuntimeAssembler } from '../../core/runtime-assembly/runtime-assembler.ts';
import { RuntimeAssemblyPolicy } from '../../core/runtime-assembly/runtime-assembly-policy.ts';
import { RuntimeValidator } from '../../core/runtime-assembly/runtime-validator.ts';
import { SkillEngine } from '../../core/skill-engine/engine.ts';
import { SkillRegistry } from '../../core/skill-registry/registry.ts';
import { SkillResolver } from '../../core/skill-resolver/resolver.ts';
import type { ConnectorContext } from '../../core/types/runtime-types.ts';
import {
  WordPressConnector,
  wordpressConfigurationFromEnvironment,
  validWordPressDraftFields,
  type WordPressArticleDraftInput,
  type WordPressArticleDraftOutput,
  type WordPressFetch,
} from '../../connectors/wordpress.connector/connector.ts';
import { WordPressConnectorDefinition } from '../../connectors/wordpress.connector/definition.ts';
import {
  B3ManagedHealthAdapter,
  B3PreparationHealthAdapter,
  ManagedConnectorListAdapter,
  RuntimeAssemblyManagedStructuralAdapter,
  RuntimeAssemblyPreparationStructuralAdapter,
  WordPressCredentialReadinessAdapter,
  registerWordPressConnector,
} from '../../missions/wordpress-article-draft/adapters.ts';
import { WordPressArticleExecution } from '../../missions/wordpress-article-draft/execution.ts';
import { WordPressArticleDraftMission } from '../../missions/wordpress-article-draft/mission.ts';
import { WordPressHealthProvider } from '../../missions/wordpress-article-draft/wordpress-health-provider.ts';
import { categoryForHealthCode, type FailureCategory, type FailureStage } from '../../missions/wordpress-article-draft/failure-diagnostic.ts';
import { ArticleSkill } from '../../skills/content.article.create/skill.ts';
import { DurableWordPressMissionAudit } from './durable-audit.ts';

const connectorInstanceId = 'wordpress-managed-1';
const credentialId = 'wordpress-credential-1';
const runtimeCompatibility = {
  runtimeProtocolVersion: '1.4.1',
  connectorApiVersion: '1',
  capabilitySchemaVersion: '1',
  definitionSchemaVersion: '1',
  connectorRecordSchemaVersion: 1,
  managedConnectorSchemaVersion: 1,
} as const;

export interface WordPressDraftInvocation extends WordPressArticleDraftInput {
  readonly requestId?: string;
  readonly correlationId?: string;
}

export type WordPressDraftInvocationResult =
  | {
      readonly requestId: string;
      readonly correlationId: string;
      readonly executionId: string;
      readonly status: 'SUCCEEDED';
      readonly output: WordPressArticleDraftOutput;
    }
  | {
      readonly requestId: string;
      readonly correlationId: string;
      readonly executionId?: string;
      readonly status: 'DENIED' | 'NOT_READY' | 'FAILED';
      readonly reasonCode?: string;
    };

export interface WordPressDraftEntrypointOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetcher?: WordPressFetch;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
}

function now(options: WordPressDraftEntrypointOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error('Productive mission configuration is unavailable');
  return value;
}

function connectorRecord(timestamp: string): ConnectorRecord {
  return {
    schemaVersion: 1,
    recordRevision: 1,
    definition: structuredClone(WordPressConnectorDefinition),
    compatibility: {
      connectorApiVersion: '1',
      minimumRuntimeVersion: '1.0',
      capabilitySchemaVersion: '1',
      definitionSchemaVersion: '1',
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    checksum: 'wordpress-connector-checksum-1',
  };
}

function managedConnector(timestamp: string): ManagedConnector {
  return {
    instanceId: connectorInstanceId,
    definitionRef: { id: 'wordpress.connector', version: '1.0' },
    lifecycleState: 'CONNECTED',
    credentialRefs: [{
      credentialId,
      providerId: 'wordpress.application-password',
      secretRef: 'env://WORDPRESS_APPLICATION_PASSWORD',
      revision: 1,
    }],
    securityRevision: 1,
    revision: 1,
    schemaVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  };
}

export async function invokeWordPressArticleDraft(
  input: WordPressDraftInvocation,
  options: WordPressDraftEntrypointOptions = {},
): Promise<WordPressDraftInvocationResult> {
  const environment = options.environment ?? process.env;
  if (!validWordPressDraftFields(input)) throw new Error('WordPress draft input is invalid');
  if (options.signal?.aborted) throw new Error('WordPress draft request was cancelled');
  const timestamp = now(options);
  const requestId = input.requestId ?? randomUUID();
  const correlationId = input.correlationId ?? requestId;
  const actorId = requiredEnvironment(environment, 'YUNTA_ACTOR_ID');
  const auditPath = requiredEnvironment(environment, 'YUNTA_AUDIT_PATH');
  const password = environment.WORDPRESS_APPLICATION_PASSWORD;
  if (password && auditPath.includes(password)) throw new Error('Mission audit path is invalid');
  if (environment.WORDPRESS_USERNAME && password && auditPath.includes(`${environment.WORDPRESS_USERNAME}:${password}`)) {
    throw new Error('Mission audit path is invalid');
  }
  const audit = new DurableWordPressMissionAudit(auditPath);
  await audit.beginRequest({ requestId, correlationId, timestamp });

  let postMayHaveDispatched = false;
  let failureStage: FailureStage = 'CONFIGURATION';
  let stageStarted = Date.now();
  let healthFailureCode: string | undefined;
  let healthElapsedMs: number | undefined;
  let connectorFailureCategory: FailureCategory | undefined;
  const stage = (value: FailureStage): void => {
    failureStage = value;
    stageStarted = Date.now();
  };
  const diagnostic = () => {
    const healthFailed = healthFailureCode !== undefined && failureStage === 'PRE_EXECUTION';
    const observedStage = healthFailed ? 'HEALTH_CHECK' : failureStage;
    return {
      failureStage: observedStage,
      failureCategory: observedStage === 'CONFIGURATION' ? 'CONFIGURATION' as const
        : observedStage === 'HEALTH_CHECK' ? categoryForHealthCode(healthFailureCode)
        : connectorFailureCategory ?? 'INTERNAL' as const,
      elapsedMs: healthFailed && healthElapsedMs !== undefined ? healthElapsedMs : Math.max(0, Date.now() - stageStarted),
      failureCode: observedStage === 'HEALTH_CHECK' ? healthFailureCode ?? 'HEALTH_CHECK_FAILED'
        : `${observedStage}_FAILED`,
    };
  };
  try {
    if (options.signal?.aborted) throw new Error('WordPress draft request was cancelled');
    const configuration = wordpressConfigurationFromEnvironment(environment);
    stage('HEALTH_CHECK');
    const repository = new InMemoryConnectorRepository();
    await repository.saveDefinition(connectorRecord(timestamp));
    await repository.saveManagedConnector(managedConnector(timestamp));
    const runtime = new RuntimeAssembler(
      repository,
      new RuntimeValidator(),
      new RuntimeAssemblyPolicy(),
      runtimeCompatibility,
    );
    const healthRepository = new InMemoryHealthRepository();
    const health = new HealthService(
      repository,
      new WordPressHealthProvider(configuration, options.fetcher),
      healthRepository,
      new InMemoryHealthEventPublisher(),
    );
    const healthSnapshot = await health.observe({
      checkId: `wordpress-health-${requestId}`,
      idempotencyKey: `wordpress-health-${requestId}`,
      connectorInstanceId,
      probeType: 'PRE_EXECUTION',
      correlationId,
    });
    if (healthSnapshot.status !== 'HEALTHY') {
      const code = healthSnapshot.details?.code;
      healthFailureCode = code === 'HEALTH_TIMEOUT' || code === 'HEALTH_NETWORK' ||
        code === 'HEALTH_HTTP' || code === 'HEALTH_AUTHENTICATION' ? code : 'HEALTH_UNKNOWN';
      healthElapsedMs = healthSnapshot.latencyMs ?? undefined;
    }
    if (options.signal?.aborted) throw new Error('WordPress draft request was cancelled');
    const managedResolver = new ManagedResolver(
      new DefaultManagedCandidateCatalog(
        new ManagedConnectorListAdapter(repository),
        new RuntimeAssemblyManagedStructuralAdapter(runtime),
        new B3ManagedHealthAdapter(healthRepository),
      ),
      new StaticResolverPolicy({
        policyId: 'wordpress-entrypoint-resolver-policy',
        revision: 1,
        minimumHealth: 'HEALTHY',
        maxHealthAgeMs: 60_000,
        maximumFutureSkewMs: 1_000,
        allowedDefinitionRefs: [{ id: 'wordpress.connector', version: '1.0' }],
        instancePriorities: {},
        tieStrategy: 'STABLE_INSTANCE_ID',
        maxConsistencyRetries: 0,
      }),
    );
    const preparationPolicy = new StaticExecutionPreparationPolicy({
      policyId: 'wordpress-entrypoint-preparation-policy',
      revision: 1,
      maxHealthAgeMs: 60_000,
      maximumFutureSkewMs: 1_000,
      maxPreparationTtlMs: 30_000,
      maxAuthorizationAgeMs: 30_000,
    });
    const preparation = new ExecutionPreparationService(
      new RuntimeAssemblyPreparationStructuralAdapter(runtime),
      new B3PreparationHealthAdapter(healthRepository),
      new AuthorizationEvaluator(
        {
          read: async (request) => ({
            actorActive: request.actorId === actorId,
            actorPermissions: ['content.write', 'connector.execute'],
            skillActive: request.skillRef.id === ArticleSkill.id && request.skillRef.version === ArticleSkill.version,
            skillCapability: ArticleSkill.capability,
            skillPermissions: ArticleSkill.permissions,
            explicitDeny: false,
            approvalGranted: false,
            evaluatedAt: timestamp,
          }),
        },
        preparationPolicy,
      ),
      new CredentialReadinessChecker(
        new WordPressCredentialReadinessAdapter(
          { connectorInstanceId, credentialId, providerId: 'wordpress.application-password', revision: 1, purpose: 'EXECUTE_CONNECTOR' },
          { isConfigured: () => Boolean(environment.WORDPRESS_APPLICATION_PASSWORD?.trim()) },
        ),
      ),
      new PreparationAudit(audit),
      preparationPolicy,
      undefined,
      { now: () => timestamp },
    );
    const skillRegistry = new SkillRegistry();
    skillRegistry.register(ArticleSkill);
    const mission = new WordPressArticleDraftMission(
      new SkillEngine(new SkillResolver(skillRegistry)),
      managedResolver,
      runtime,
      preparation,
      {
        create: (resolution) => {
          const registry = new ConnectorRegistry();
          registerWordPressConnector(registry, new WordPressConnector(configuration, options.fetcher, {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            onPostDispatch: () => { postMayHaveDispatched = true; },
            onReadback: () => stage('READBACK'),
            onFailure: (category) => { connectorFailureCategory = category; },
          }));
          const permissions = new PermissionEvaluator(registry);
          const context = (value: {
            readonly executionId: string;
            readonly capability: string;
            readonly connectorId: string;
          }): ConnectorContext => ({
            executionId: value.executionId,
            connectorId: value.connectorId,
            capability: value.capability,
            metadata: {},
            timestamp: now(options),
          });
          return new WordPressArticleExecution(
            registry,
            new RuntimeAssemblyPreparationStructuralAdapter(runtime),
            new B3PreparationHealthAdapter(healthRepository),
            resolution,
            {
              context,
              issue: (value) => permissions.authorizeConnector({
                actor: { id: actorId, permissions: ['content.write', 'connector.execute'], status: 'ACTIVE' },
                skill: ArticleSkill,
                capability: value.capability,
                connector: WordPressConnectorDefinition,
                context: context({
                  executionId: value.executionId,
                  capability: value.capability,
                  connectorId: value.connector.id,
                }),
              }),
            },
            audit,
          );
        },
      },
    );
    const result = await mission.run({
      actorId,
      correlationId,
      title: input.title,
      contentHtml: input.contentHtml,
    }, stage);
    const executionId = audit.executionIdFor(correlationId);
    if (result.status === 'SUCCEEDED') {
      await audit.recordResult({
        requestId,
        correlationId,
        ...(executionId === undefined ? {} : { executionId }),
        status: result.status,
        postId: result.output.postId,
        timestamp: now(options),
      });
      if (!executionId) throw new Error('Mission execution audit is unavailable');
      return Object.freeze({ requestId, correlationId, executionId, status: result.status, output: result.output });
    }
    await audit.recordResult({
      requestId,
      correlationId,
      ...(executionId === undefined ? {} : { executionId }),
      status: result.status,
      ...(result.status === 'FAILED' ? { reasonCode: result.reasonCode } : {}),
      ...diagnostic(),
      timestamp: now(options),
    });
    return Object.freeze({
      requestId,
      correlationId,
      ...(executionId === undefined ? {} : { executionId }),
      status: result.status,
      ...(result.status === 'FAILED' ? { reasonCode: result.reasonCode } : {}),
    });
  } catch (error) {
    const executionId = audit.executionIdFor(correlationId);
    await audit.recordResult({
      requestId,
      correlationId,
      ...(executionId === undefined ? {} : { executionId }),
      status: 'FAILED',
      reasonCode: postMayHaveDispatched ? 'EXECUTION_OUTCOME_AMBIGUOUS' : 'MISSION_FAILED',
      ...diagnostic(),
      timestamp: now(options),
    }).catch(() => undefined);
    if (postMayHaveDispatched) {
      return Object.freeze({
        requestId,
        correlationId,
        ...(executionId === undefined ? {} : { executionId }),
        status: 'FAILED' as const,
        reasonCode: 'EXECUTION_OUTCOME_AMBIGUOUS',
      });
    }
    throw error;
  }
}
