import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionEvaluator } from '../core/permission-engine/evaluator.ts';
import type { PermissionRequest, SkillDefinition } from '../core/types/runtime-types.ts';
import { ArticleSkill } from '../skills/content.article.create/skill.ts';

const actor = {
  id: 'editor-1',
  permissions: ['content.write'],
  status: 'ACTIVE',
} as const;

const context = {
  actorId: actor.id,
  input: { topic: 'camaras' },
  metadata: {},
};

test('allows low risk and requires approval for high risk', () => {
  const evaluator = new PermissionEvaluator();
  const highRiskSkill: SkillDefinition = {
    ...ArticleSkill,
    riskLevel: 'HIGH',
  };

  assert.equal(
    evaluator.evaluate({
      actor,
      skill: ArticleSkill,
      capability: ArticleSkill.capability,
      riskLevel: 'LOW',
      context,
    }),
    'ALLOW',
  );
  assert.equal(
    evaluator.evaluate({
      actor,
      skill: highRiskSkill,
      capability: highRiskSkill.capability,
      riskLevel: 'HIGH',
      context,
    }),
    'REQUIRE_APPROVAL',
  );
});

test('denies actors without the skill permission', () => {
  const evaluator = new PermissionEvaluator();

  assert.equal(
    evaluator.evaluate({
      actor: { ...actor, permissions: [] },
      skill: ArticleSkill,
      capability: ArticleSkill.capability,
      riskLevel: ArticleSkill.riskLevel,
      context,
    }),
    'DENY',
  );
});

test('denies unsupported runtime risk values', () => {
  const evaluator = new PermissionEvaluator();
  const invalidRequest = {
    actor,
    skill: { ...ArticleSkill, riskLevel: 'CRITICAL' },
    capability: ArticleSkill.capability,
    riskLevel: 'CRITICAL',
    context,
  } as unknown as PermissionRequest;

  assert.equal(evaluator.evaluate(invalidRequest), 'DENY');
});
