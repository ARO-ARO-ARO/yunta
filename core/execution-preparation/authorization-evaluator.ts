import type { AuthorizationAssessment, PermissionEvaluation } from './models.ts';
import type { AuthorizationAuthority, AuthorizationEvaluatorPort } from './ports.ts';
import type { ExecutionPreparationPolicy } from './policies.ts';

export class AuthorizationEvaluator implements AuthorizationEvaluatorPort {
  private readonly authority: AuthorizationAuthority;
  private readonly policy: ExecutionPreparationPolicy;

  constructor(authority: AuthorizationAuthority, policy: ExecutionPreparationPolicy) {
    this.authority = authority;
    this.policy = policy;
  }

  async evaluate(input: Parameters<AuthorizationEvaluatorPort['evaluate']>[0]): Promise<{
    readonly authorization: AuthorizationAssessment;
    readonly permissions: PermissionEvaluation;
  }> {
    const state = await this.authority.read({
      actorId: input.actorId,
      skillRef: input.skillRef,
      capability: input.capability,
      operation: input.operation,
      target: {
        instanceId: input.structural.instanceId,
        definitionRef: {
          id: input.structural.definitionRef.id,
          version: input.structural.definitionRef.version,
        },
        revision: input.structural.revision,
        securityRevision: input.structural.securityRevision,
      },
    });
    const required = new Set([...state.skillPermissions, ...input.structural.permissions]);
    const missing = [...required].filter((permission) => !state.actorPermissions.includes(permission));
    const evaluatedAt = state.evaluatedAt;
    const expiresAt = new Date(
      Date.parse(evaluatedAt) + this.policy.maxAuthorizationAgeMs,
    ).toISOString();
    const assessment = (decision: AuthorizationAssessment['decision']): AuthorizationAssessment => ({
      evaluationId: `${input.actorId}:${input.structural.instanceId}:${evaluatedAt}`,
      decision,
      policy: { id: this.policy.policyId, revision: this.policy.revision },
      evaluatedAt,
      notBefore: evaluatedAt,
      expiresAt,
    });
    const permissions = (status: PermissionEvaluation['status']): PermissionEvaluation => ({
      status,
      requiredCount: required.size,
      missingCount: missing.length,
      evaluatedAt,
    });

    if (
      !state.actorActive ||
      !state.skillActive ||
      state.skillCapability !== input.capability ||
      state.explicitDeny
    ) {
      return { authorization: assessment('DENY'), permissions: permissions('DENIED') };
    }
    if (missing.length > 0) {
      return { authorization: assessment('DENY'), permissions: permissions('MISSING') };
    }
    const capability = input.structural.capabilities.find(
      (candidate) => candidate.id === input.capability,
    );
    if (capability?.riskLevel === 'HIGH' && !state.approvalGranted) {
      return { authorization: assessment('REQUIRE_APPROVAL'), permissions: permissions('SATISFIED') };
    }
    return { authorization: assessment('ALLOW'), permissions: permissions('SATISFIED') };
  }
}
