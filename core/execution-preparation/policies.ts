export interface ExecutionPreparationPolicy {
  readonly policyId: string;
  readonly revision: number;
  readonly maxHealthAgeMs: number;
  readonly maximumFutureSkewMs: number;
  readonly maxPreparationTtlMs: number;
  readonly maxAuthorizationAgeMs: number;
}

export class StaticExecutionPreparationPolicy implements ExecutionPreparationPolicy {
  readonly policyId: string;
  readonly revision: number;
  readonly maxHealthAgeMs: number;
  readonly maximumFutureSkewMs: number;
  readonly maxPreparationTtlMs: number;
  readonly maxAuthorizationAgeMs: number;

  constructor(policy: ExecutionPreparationPolicy) {
    if (
      !policy.policyId.trim() ||
      !Number.isInteger(policy.revision) ||
      policy.revision < 1 ||
      !Number.isInteger(policy.maxHealthAgeMs) ||
      policy.maxHealthAgeMs < 0 ||
      !Number.isInteger(policy.maximumFutureSkewMs) ||
      policy.maximumFutureSkewMs < 0 ||
      !Number.isInteger(policy.maxPreparationTtlMs) ||
      policy.maxPreparationTtlMs < 1 ||
      !Number.isInteger(policy.maxAuthorizationAgeMs) ||
      policy.maxAuthorizationAgeMs < 1
    ) {
      throw new Error('Execution preparation policy is invalid');
    }
    this.policyId = policy.policyId;
    this.revision = policy.revision;
    this.maxHealthAgeMs = policy.maxHealthAgeMs;
    this.maximumFutureSkewMs = policy.maximumFutureSkewMs;
    this.maxPreparationTtlMs = policy.maxPreparationTtlMs;
    this.maxAuthorizationAgeMs = policy.maxAuthorizationAgeMs;
    Object.freeze(this);
  }
}
