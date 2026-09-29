import assert from 'node:assert/strict';
import test from 'node:test';
import { SkillRegistry } from '../core/skill-registry/registry.ts';
import type { SkillDefinition } from '../core/types/runtime-types.ts';
import { ArticleSkill } from '../skills/content.article.create/skill.ts';

test('registry manages skills by id and version', () => {
  const registry = new SkillRegistry();
  const versionTwo: SkillDefinition = {
    ...ArticleSkill,
    version: '2.0',
    steps: [...ArticleSkill.steps, 'publicar borrador'],
  };
  const versionTen: SkillDefinition = {
    ...ArticleSkill,
    version: '10.0',
  };

  registry.register(ArticleSkill);
  registry.register(versionTwo);
  registry.register(versionTen);

  assert.deepEqual(registry.get(ArticleSkill.id, '1.0'), ArticleSkill);
  assert.equal(registry.getLatestVersion(ArticleSkill.id)?.version, '10.0');
  assert.equal(registry.exists(ArticleSkill.id, '2.0'), true);
  assert.equal(registry.findByCapability('content.create').length, 3);
  assert.throws(() => registry.register(ArticleSkill), /already registered/);

  registry.update({ ...versionTwo, rollbackStrategy: 'Remove the draft' });
  assert.equal(registry.get(ArticleSkill.id, '2.0')?.rollbackStrategy, 'Remove the draft');
  assert.equal(registry.remove(ArticleSkill.id, '2.0'), true);
  assert.equal(registry.exists(ArticleSkill.id, '2.0'), false);
});
