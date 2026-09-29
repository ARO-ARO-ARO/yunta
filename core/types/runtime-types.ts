export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type SkillStatus = 'ACTIVE' | 'INACTIVE';

export type PermissionResult = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

export interface Actor {
  id: string;
  permissions: readonly string[];
  status: 'ACTIVE' | 'BLOCKED';
}

export interface Intent {
  id: string;
  input: string;
}

export interface ExecutionContext {
  actorId: string;
  input: Readonly<Record<string, unknown>>;
  metadata: Readonly<Record<string, unknown>>;
}

export interface SkillDefinition {
  id: string;
  version: string;
  intent: string;
  capability: string;
  status: SkillStatus;
  matchingKeywords: readonly string[];
  steps: readonly string[];
  permissions: readonly string[];
  riskLevel: RiskLevel;
  rollbackStrategy: string;
}

export interface SkillReference {
  id: string;
  version: string;
}

export interface SkillResolution {
  intent: Intent;
  capability: string;
  skill: SkillDefinition;
  confidence: number;
}

export interface SkillValidationResult {
  valid: boolean;
  errors: readonly string[];
}

export type ExecutionPlanStatus = 'READY' | 'PENDING_APPROVAL' | 'DENIED';

export interface ExecutionPlan {
  id: string;
  intent: Intent;
  capability: string;
  skill: SkillReference;
  steps: readonly string[];
  currentStep: number;
  status: ExecutionPlanStatus;
  permissions: readonly string[];
  context: ExecutionContext;
  createdAt: string;
  riskLevel: RiskLevel;
  rollbackStrategy: string;
}

export interface PermissionRequest {
  actor: Actor;
  skill: SkillDefinition;
  capability: string;
  riskLevel: RiskLevel;
  context: ExecutionContext;
}

export type ExecutionResultStatus =
  | 'PLANNED'
  | 'DENIED'
  | 'PENDING_APPROVAL'
  | 'SUCCEEDED'
  | 'FAILED';

export interface ExecutionResult {
  status: ExecutionResultStatus;
  output?: unknown;
}

export type ConnectorStatus = 'ACTIVE' | 'INACTIVE' | 'DEGRADED' | 'OFFLINE';

export interface ConnectorCapability {
  id: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema: Readonly<Record<string, unknown>>;
  riskLevel: RiskLevel;
}

export interface ConnectorDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  type: string;
  capabilities: readonly ConnectorCapability[];
  permissions: readonly string[];
  status: ConnectorStatus;
  metadata: Readonly<Record<string, unknown>>;
  health: ConnectorStatus;
}

export interface ConnectorContext {
  executionId: string;
  connectorId: string;
  capability: string;
  metadata: Readonly<Record<string, unknown>>;
  timestamp: string;
}

export interface ConnectorReference {
  id: string;
  version: string;
}

export interface ConnectorAuthorization {
  readonly connector: ConnectorReference;
  readonly capability: string;
  readonly executionId: string;
  readonly decision: PermissionResult;
  readonly evaluatedAt: string;
  readonly token: string;
}

export interface ConnectorExecutionRequest {
  connector: ConnectorReference;
  capability: string;
  input: unknown;
  context: ConnectorContext;
  authorization: ConnectorAuthorization;
}

export type ConnectorExecutionResult =
  | {
      status: 'SUCCEEDED';
      output: unknown;
      errors: readonly [];
    }
  | {
      status: 'FAILED';
      errors: readonly string[];
    };

export interface ConnectorPermissionRequest {
  actor: Actor;
  skill: SkillDefinition;
  capability: string;
  connector: ConnectorDefinition;
  context: ConnectorContext;
}

export interface ConnectorAuditRecord {
  connector: ConnectorReference;
  capability: string;
  permissionDecision: PermissionResult;
  health: ConnectorStatus;
  result: ConnectorExecutionResult;
}

export interface AuditEvent {
  executionId: string;
  intent: Intent;
  capability: string;
  skill: SkillReference;
  executionPlan: ExecutionPlan;
  permissionDecision: PermissionResult;
  result: ExecutionResult;
  errors: readonly string[];
  timestamp: string;
  connector?: ConnectorAuditRecord;
}
