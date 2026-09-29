import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConnectorRegistry } from '../connector-registry/registry.ts';
import type {
  ConnectorAuthorization,
  ConnectorPermissionRequest,
  ConnectorReference,
  PermissionRequest,
  PermissionResult,
} from '../types/runtime-types.ts';

const authorizationSecret = randomBytes(32);

interface AuthorizationClaims {
  connector: ConnectorReference;
  capability: string;
  executionId: string;
  decision: PermissionResult;
  evaluatedAt: string;
}

function signAuthorization(claims: AuthorizationClaims): string {
  return createHmac('sha256', authorizationSecret)
    .update(JSON.stringify(claims))
    .digest('hex');
}

function issueConnectorAuthorization(claims: AuthorizationClaims): ConnectorAuthorization {
  const immutableClaims = {
    ...claims,
    connector: Object.freeze({ ...claims.connector }),
  };

  return Object.freeze({
    ...immutableClaims,
    token: signAuthorization(immutableClaims),
  });
}

export function verifyConnectorAuthorization(
  authorization: ConnectorAuthorization,
): boolean {
  const { token, ...claims } = authorization;
  if (!/^[a-f\d]{64}$/.test(token)) {
    return false;
  }

  const providedToken = Buffer.from(token, 'hex');
  const expectedToken = Buffer.from(signAuthorization(claims), 'hex');
  return timingSafeEqual(providedToken, expectedToken);
}

export class PermissionEvaluator {
  private readonly connectorRegistry: ConnectorRegistry | undefined;

  constructor(connectorRegistry?: ConnectorRegistry) {
    this.connectorRegistry = connectorRegistry;
  }

  evaluate(request: PermissionRequest | ConnectorPermissionRequest): PermissionResult {
    if ('connector' in request) {
      return this.evaluateConnector(request);
    }

    if (!['LOW', 'MEDIUM', 'HIGH'].includes(request.riskLevel)) {
      return 'DENY';
    }

    const actorHasRequiredPermissions = request.skill.permissions.every((permission) =>
      request.actor.permissions.includes(permission),
    );

    if (
      request.actor.status === 'BLOCKED' ||
      request.actor.id !== request.context.actorId ||
      request.skill.status !== 'ACTIVE' ||
      request.skill.capability !== request.capability ||
      request.skill.riskLevel !== request.riskLevel ||
      !actorHasRequiredPermissions
    ) {
      return 'DENY';
    }

    return request.riskLevel === 'HIGH' ? 'REQUIRE_APPROVAL' : 'ALLOW';
  }

  authorizeConnector(request: ConnectorPermissionRequest): ConnectorAuthorization {
    return issueConnectorAuthorization({
      connector: {
        id: request.connector.id,
        version: request.connector.version,
      },
      capability: request.capability,
      executionId: request.context.executionId,
      decision: this.evaluateConnector(request),
      evaluatedAt: new Date().toISOString(),
    });
  }

  private evaluateConnector(request: ConnectorPermissionRequest): PermissionResult {
    if (
      !this.connectorRegistry ||
      request.actor.status !== 'ACTIVE' ||
      !Array.isArray(request.actor.permissions) ||
      request.skill.status !== 'ACTIVE' ||
      request.skill.capability !== request.capability ||
      !request.context.executionId.trim() ||
      Number.isNaN(Date.parse(request.context.timestamp))
    ) {
      return 'DENY';
    }

    const trustedConnector = this.connectorRegistry.get(
      request.connector.id,
      request.connector.version,
    )?.definition;
    if (!trustedConnector) {
      return 'DENY';
    }

    const capability = trustedConnector.capabilities.find(
      (candidate) => candidate.id === request.capability,
    );
    const actorHasRequiredPermissions = trustedConnector.permissions.every((permission) =>
      request.actor.permissions.includes(permission),
    );

    if (
      !capability ||
      !['LOW', 'MEDIUM', 'HIGH'].includes(capability.riskLevel) ||
      !['ACTIVE', 'DEGRADED'].includes(trustedConnector.status) ||
      request.context.connectorId !== trustedConnector.id ||
      request.context.capability !== request.capability ||
      !actorHasRequiredPermissions
    ) {
      return 'DENY';
    }

    return capability.riskLevel === 'HIGH' ? 'REQUIRE_APPROVAL' : 'ALLOW';
  }
}
