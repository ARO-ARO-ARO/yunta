import { randomUUID } from 'node:crypto';
import { SkillResolver } from '../skill-resolver/resolver.ts';
import type {
  ExecutionContext,
  ExecutionPlan,
  SkillDefinition,
  SkillResolution,
  SkillValidationResult,
} from '../types/runtime-types.ts';

export class SkillEngine {
  private readonly resolver: SkillResolver;

  constructor(resolver: SkillResolver) {
    this.resolver = resolver;
  }

  resolve(intent: string): SkillResolution | null {
    return this.resolver.resolve(intent);
  }

  validate(skill: SkillDefinition): SkillValidationResult {
    const errors: string[] = [];

    if (!skill.id.trim()) errors.push('Skill id is required');
    if (!/^\d+(\.\d+)*$/.test(skill.version)) errors.push('Skill version is invalid');
    if (!skill.capability.trim()) errors.push('Skill capability is required');
    if (skill.status !== 'ACTIVE') errors.push('Skill is not active');
    if (skill.steps.length === 0) errors.push('Skill requires at least one step');
    if (
      skill.matchingKeywords.length === 0 ||
      skill.matchingKeywords.some((keyword) => !keyword.trim())
    ) {
      errors.push('Skill requires non-empty matching keywords');
    }
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(skill.riskLevel)) {
      errors.push('Skill risk level is invalid');
    }

    return { valid: errors.length === 0, errors };
  }

  createPlan(resolution: SkillResolution, context: ExecutionContext): ExecutionPlan {
    const validation = this.validate(resolution.skill);
    if (!validation.valid) {
      throw new Error(validation.errors.join('; '));
    }

    return {
      id: `plan-${randomUUID()}`,
      intent: { ...resolution.intent },
      capability: resolution.capability,
      skill: {
        id: resolution.skill.id,
        version: resolution.skill.version,
      },
      steps: [...resolution.skill.steps],
      currentStep: 0,
      status: 'READY',
      permissions: [...resolution.skill.permissions],
      context: structuredClone(context),
      createdAt: new Date().toISOString(),
      riskLevel: resolution.skill.riskLevel,
      rollbackStrategy: resolution.skill.rollbackStrategy,
    };
  }
}
