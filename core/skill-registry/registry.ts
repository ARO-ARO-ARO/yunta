import type { SkillDefinition, SkillStatus } from '../types/runtime-types.ts';

function cloneSkill(skill: SkillDefinition): SkillDefinition {
  return {
    ...skill,
    matchingKeywords: [...skill.matchingKeywords],
    steps: [...skill.steps],
    permissions: [...skill.permissions],
  };
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    const key = this.key(skill.id, skill.version);
    if (this.skills.has(key)) {
      throw new Error(`Skill already registered: ${key}`);
    }

    this.skills.set(key, cloneSkill(skill));
  }

  get(id: string, version: string): SkillDefinition | undefined {
    const skill = this.skills.get(this.key(id, version));
    return skill ? cloneSkill(skill) : undefined;
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()].map(cloneSkill);
  }

  update(skill: SkillDefinition): void {
    const key = this.key(skill.id, skill.version);
    if (!this.skills.has(key)) {
      throw new Error(`Skill not registered: ${key}`);
    }

    this.skills.set(key, cloneSkill(skill));
  }

  remove(id: string, version: string): boolean {
    return this.skills.delete(this.key(id, version));
  }

  exists(id: string, version?: string): boolean {
    if (version !== undefined) {
      return this.skills.has(this.key(id, version));
    }

    return [...this.skills.values()].some((skill) => skill.id === id);
  }

  findByCapability(capability: string): SkillDefinition[] {
    return this.list().filter((skill) => skill.capability === capability);
  }

  getLatestVersion(id: string, status?: SkillStatus): SkillDefinition | undefined {
    return this.list()
      .filter((skill) => skill.id === id && (status === undefined || skill.status === status))
      .sort((left, right) => compareVersions(right.version, left.version))[0];
  }

  private key(id: string, version: string): string {
    return `${id}@${version}`;
  }
}
