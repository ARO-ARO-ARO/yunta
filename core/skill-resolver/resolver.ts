import { SkillRegistry } from '../skill-registry/registry.ts';
import type { SkillDefinition, SkillResolution } from '../types/runtime-types.ts';

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase();
}

export class SkillResolver {
  private readonly registry: SkillRegistry;

  constructor(registry: SkillRegistry) {
    this.registry = registry;
  }

  resolve(intentInput: string): SkillResolution | null {
    const normalizedIntent = normalize(intentInput);
    const latestSkills = this.latestActiveSkills();
    const candidates = latestSkills
      .map((skill) => {
        const matchingKeywords = skill.matchingKeywords.filter((keyword) => keyword.trim());
        const matches = matchingKeywords.filter((keyword) =>
          normalizedIntent.includes(normalize(keyword)),
        ).length;

        return {
          skill,
          confidence: matchingKeywords.length === 0 ? 0 : matches / matchingKeywords.length,
        };
      })
      .filter((candidate) => candidate.confidence > 0)
      .sort((left, right) => right.confidence - left.confidence);

    const bestMatch = candidates[0];
    if (!bestMatch) {
      return null;
    }

    return {
      intent: {
        id: bestMatch.skill.intent,
        input: intentInput,
      },
      capability: bestMatch.skill.capability,
      skill: bestMatch.skill,
      confidence: bestMatch.confidence,
    };
  }

  private latestActiveSkills(): SkillDefinition[] {
    const activeSkills = this.registry.list().filter((skill) => skill.status === 'ACTIVE');
    const skillIds = new Set(activeSkills.map((skill) => skill.id));

    return [...skillIds]
      .map((id) => this.registry.getLatestVersion(id, 'ACTIVE'))
      .filter((skill): skill is SkillDefinition => skill !== undefined);
  }
}
