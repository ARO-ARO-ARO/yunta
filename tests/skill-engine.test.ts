import assert from 'node:assert/strict';
import test from 'node:test';
import { SkillEngine } from '../core/skill-engine/engine.ts';
import { SkillRegistry } from '../core/skill-registry/registry.ts';
import { SkillResolver } from '../core/skill-resolver/resolver.ts';
import { ArticleSkill } from '../skills/content.article.create/skill.ts';

test('validates a skill and creates a complete execution plan', () => {
  const registry = new SkillRegistry();
  registry.register(ArticleSkill);
  const engine = new SkillEngine(new SkillResolver(registry));
  const resolution = engine.resolve('Crear un art\u00edculo sobre c\u00e1maras');

  assert.ok(resolution);
  assert.deepEqual(engine.validate(resolution.skill), { valid: true, errors: [] });

  const context = {
    actorId: 'editor-1',
    input: { topic: { name: 'camaras' } },
    metadata: { source: 'test' },
  };
  const plan = engine.createPlan(resolution, context);
  const secondPlan = engine.createPlan(resolution, context);
  context.input.topic.name = 'modified';

  assert.match(plan.id, /^plan-/);
  assert.notEqual(plan.id, secondPlan.id);
  assert.deepEqual(plan.intent, {
    id: 'content_creation',
    input: 'Crear un art\u00edculo sobre c\u00e1maras',
  });
  assert.equal(plan.capability, 'content.create');
  assert.deepEqual(plan.skill, { id: 'content.article.create', version: '1.0' });
  assert.deepEqual(plan.steps, ArticleSkill.steps);
  assert.equal(plan.currentStep, 0);
  assert.equal(plan.status, 'READY');
  assert.deepEqual(plan.permissions, ['content.write']);
  assert.deepEqual(plan.context, {
    actorId: 'editor-1',
    input: { topic: { name: 'camaras' } },
    metadata: { source: 'test' },
  });
  assert.equal(plan.riskLevel, 'LOW');
  assert.equal(plan.rollbackStrategy, ArticleSkill.rollbackStrategy);
  assert.equal(Number.isNaN(Date.parse(plan.createdAt)), false);
});
