import assert from 'node:assert/strict';
import test from 'node:test';
import { SkillRegistry } from '../core/skill-registry/registry.ts';
import { SkillResolver } from '../core/skill-resolver/resolver.ts';
import type { SkillDefinition } from '../core/types/runtime-types.ts';
import { ArticleSkill } from '../skills/content.article.create/skill.ts';

test('resolves article creation intent through registry matching', () => {
  const registry = new SkillRegistry();
  registry.register(ArticleSkill);
  registry.register({
    ...ArticleSkill,
    version: '2.0',
    status: 'INACTIVE',
  });

  const resolution = new SkillResolver(registry).resolve('Crear un art\u00edculo sobre c\u00e1maras');

  assert.ok(resolution);
  assert.equal(resolution.intent.id, 'content_creation');
  assert.equal(resolution.capability, 'content.create');
  assert.equal(resolution.skill.id, 'content.article.create');
  assert.equal(resolution.skill.version, '1.0');
  assert.ok(resolution.confidence > 0);
});

test('returns null when no registered skill matches the intent', () => {
  const registry = new SkillRegistry();
  registry.register(ArticleSkill);

  assert.equal(new SkillResolver(registry).resolve('Consultar el clima'), null);
});

test('ignores empty matching keywords', () => {
  const registry = new SkillRegistry();
  const invalidSkill: SkillDefinition = {
    ...ArticleSkill,
    id: 'invalid.empty-keyword',
    matchingKeywords: [''],
  };
  registry.register(invalidSkill);

  assert.equal(new SkillResolver(registry).resolve('Consultar el clima'), null);
});
