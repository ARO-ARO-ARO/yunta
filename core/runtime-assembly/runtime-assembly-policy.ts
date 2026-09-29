import type { ConnectorReference } from '../types/runtime-types.ts';
import type { CredentialRequirement } from './models.ts';
import type { RuntimeAssemblyPolicyPort } from './ports.ts';

function key(reference: ConnectorReference): string {
  return `${reference.id}@${reference.version}`;
}

function assertReference(reference: ConnectorReference): void {
  if (!reference.id.trim() || !reference.version.trim()) {
    throw new Error('Optional credential reference is invalid');
  }
}

export class RuntimeAssemblyPolicy implements RuntimeAssemblyPolicyPort {
  private readonly optionalReferences: ReadonlySet<string>;

  constructor(optionalReferences: readonly ConnectorReference[] = []) {
    const keys = new Set<string>();
    for (const reference of optionalReferences) {
      assertReference(reference);
      const referenceKey = key(reference);
      if (keys.has(referenceKey)) {
        throw new Error('Optional credential reference is duplicated');
      }
      keys.add(referenceKey);
    }
    this.optionalReferences = keys;
  }

  credentialRequirementFor(reference: ConnectorReference): CredentialRequirement {
    return this.optionalReferences.has(key(reference)) ? 'OPTIONAL' : 'REQUIRED';
  }
}
