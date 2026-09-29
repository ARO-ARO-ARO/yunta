import type { SkillDefinition } from '../../core/types/runtime-types.ts';

export const ArticleSkill = {
  id: 'content.article.create',
  version: '1.0',
  intent: 'content_creation',
  capability: 'content.create',
  status: 'ACTIVE',
  matchingKeywords: ['crear', 'articulo', 'contenido'],
  steps: [
    'analizar tema',
    'crear estructura',
    'generar contenido',
    'validar',
  ],
  permissions: ['content.write'],
  riskLevel: 'LOW',
  rollbackStrategy: 'Discard the generated draft',
} satisfies SkillDefinition;
