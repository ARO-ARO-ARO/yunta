import type { CredentialReadiness } from './models.ts';
import type { CredentialReadinessAuthority, CredentialReadinessCheckerPort } from './ports.ts';

export class CredentialReadinessChecker implements CredentialReadinessCheckerPort {
  private readonly authority: CredentialReadinessAuthority;

  constructor(authority: CredentialReadinessAuthority) {
    this.authority = authority;
  }

  async check(input: Parameters<CredentialReadinessCheckerPort['check']>[0]): Promise<CredentialReadiness> {
    const references = input.structural.credentialReferences;
    if (references.length === 0) {
      return {
        status: input.structural.credentialRequirement === 'OPTIONAL' ? 'NOT_REQUIRED' : 'NOT_READY',
        checkedAt: input.checkedAt,
        credentials: [],
      };
    }
    const checkedAt = Date.parse(input.checkedAt);
    const credentials = await Promise.all(
      references.map(async (reference) => {
        const record = await this.authority.inspect({
          connectorInstanceId: input.structural.instanceId,
          capability: input.capability,
          operation: input.operation,
          reference: {
            credentialId: reference.credentialId,
            providerId: reference.providerId,
            revision: reference.revision,
          },
        });
        const expired =
          record.expiresAt !== undefined &&
          (!Number.isFinite(checkedAt) || Number.isNaN(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= checkedAt);
        const ready =
          record.exists &&
          record.ownershipMatches &&
          record.referenceMatches &&
          record.purposeMatches &&
          record.status === 'ACTIVE' &&
          !expired;
        return {
          credentialId: reference.credentialId,
          revision: reference.revision,
          status: ready ? ('READY' as const) : ('NOT_READY' as const),
          ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
        };
      }),
    );
    return {
      status: credentials.every((credential) => credential.status === 'READY') ? 'READY' : 'NOT_READY',
      checkedAt: input.checkedAt,
      credentials,
    };
  }
}
