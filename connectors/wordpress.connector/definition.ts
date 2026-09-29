import type { ConnectorDefinition } from '../../core/types/runtime-types.ts';

export const WordPressConnectorDefinition = {
  id: 'wordpress.connector',
  version: '1.0',
  name: 'WordPress Draft Connector',
  description: 'Creates WordPress posts as drafts only',
  type: 'WORDPRESS',
  capabilities: [
    {
      id: 'content.create',
      description: 'Create a WordPress article draft',
      inputSchema: {
        type: 'object',
        required: ['title', 'contentHtml'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        required: ['postId', 'status', 'resourceUrl'],
        additionalProperties: false,
      },
      riskLevel: 'LOW',
    },
  ],
  permissions: ['connector.execute'],
  status: 'ACTIVE',
  metadata: { external: true, operation: 'create-draft-only' },
  health: 'ACTIVE',
} satisfies ConnectorDefinition;
