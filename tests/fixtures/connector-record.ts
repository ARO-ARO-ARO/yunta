import type {
  CompatibilityDescriptor,
  ConnectorRecord,
} from '../../core/contracts-foundation/domain.ts';
import type { ConnectorDefinition } from '../../core/types/runtime-types.ts';

export const TestConnectorCompatibility: CompatibilityDescriptor = {
  connectorApiVersion: '1',
  minimumRuntimeVersion: '1.4.0',
  capabilitySchemaVersion: '1',
  definitionSchemaVersion: '1',
};

const TestConnectorDefinition = {
  id: 'mock.connector',
  version: '1.0',
  name: 'Test Connector',
  description: 'Non-executable connector definition for runtime tests',
  type: 'TEST',
  capabilities: [
    {
      id: 'content.create',
      description: 'Create test content',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      riskLevel: 'LOW',
    },
  ],
  permissions: ['connector.execute'],
  status: 'ACTIVE',
  metadata: { external: false },
  health: 'ACTIVE',
} satisfies ConnectorDefinition;

export function createTestConnectorRecord(
  createdAt = new Date().toISOString(),
): ConnectorRecord {
  return {
    schemaVersion: 1,
    recordRevision: 1,
    definition: structuredClone(TestConnectorDefinition),
    compatibility: { ...TestConnectorCompatibility },
    createdAt,
    updatedAt: createdAt,
    checksum: 'test-connector-record-v1',
  };
}
