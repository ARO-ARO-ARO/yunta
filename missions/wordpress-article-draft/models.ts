import type {
  WordPressArticleDraftInput,
  WordPressArticleDraftOutput,
} from '../../connectors/wordpress.connector/connector.ts';
import type { ExecutionPreparationResult } from '../../core/execution-preparation/models.ts';

export type { WordPressArticleDraftInput, WordPressArticleDraftOutput };

export type WordPressArticleMissionReason =
  | 'WORDPRESS_UNAUTHORIZED'
  | 'WORDPRESS_UNAVAILABLE'
  | 'WORDPRESS_TIMEOUT'
  | 'WORDPRESS_REQUEST_REJECTED'
  | 'WORDPRESS_INVALID_RESPONSE'
  | 'WORDPRESS_REQUEST_FAILED'
  | 'WORDPRESS_VERIFICATION_FAILED'
  | 'EXECUTION_OUTCOME_AMBIGUOUS';

export interface WordPressArticleDraftCreatedEvent {
  readonly eventType: 'ArticleDraftCreated';
  readonly eventId: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly connectorInstanceId: string;
  readonly connectorRef: { readonly id: string; readonly version: string };
  readonly preparationOutcomeEventId: string;
  readonly postId: number;
  readonly status: 'draft';
  readonly timestamp: string;
}

export interface WordPressArticleDraftFailedEvent {
  readonly eventType: 'ArticleDraftCreationFailed';
  readonly eventId: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly connectorInstanceId: string;
  readonly connectorRef: { readonly id: string; readonly version: string };
  readonly preparationOutcomeEventId: string;
  readonly reasonCode: WordPressArticleMissionReason;
  readonly timestamp: string;
}

export type WordPressArticleMissionAuditEvent =
  | WordPressArticleDraftCreatedEvent
  | WordPressArticleDraftFailedEvent;

export interface WordPressArticleDraftMissionInput extends WordPressArticleDraftInput {
  readonly actorId: string;
  readonly correlationId: string;
}

export type WordPressArticleExecutionFailureCode =
  | 'PREPARATION_NOT_READY'
  | 'PREPARATION_EXPIRED'
  | 'EXECUTION_REFERENCE_CONFLICT'
  | 'EXECUTION_HEALTH_CONFLICT'
  | 'EXECUTION_CONNECTOR_UNAVAILABLE'
  | 'EXECUTION_ALREADY_ATTEMPTED'
  | 'WORDPRESS_EXECUTION_NOT_AUTHORIZED'
  | 'WORDPRESS_NOT_CONNECTED'
  | 'WORDPRESS_INVALID_REQUEST'
  | WordPressArticleMissionReason;

export type WordPressArticleExecutionOutcome =
  | {
      readonly status: 'SUCCEEDED';
      readonly output: WordPressArticleDraftOutput;
    }
  | {
      readonly status: 'FAILED';
      readonly reasonCode: WordPressArticleExecutionFailureCode;
    };

export type WordPressArticleDraftMissionResult =
  | {
      readonly status: 'SUCCEEDED';
      readonly preparation: ExecutionPreparationResult;
      readonly output: WordPressArticleDraftOutput;
    }
  | {
      readonly status: 'DENIED' | 'NOT_READY';
      readonly preparation: ExecutionPreparationResult;
    }
  | {
      readonly status: 'FAILED';
      readonly preparation: ExecutionPreparationResult;
      readonly reasonCode: WordPressArticleExecutionFailureCode;
    };
