/**
 * Tool for creating managed tables with standard columns.
 * Provides auto-generated IDs and timestamp tracking.
 */

import { PostgresConnectionManager } from '../database/PostgresConnectionManager.js';
import { EventCollector } from '../events/EventCollector.js';
import { EventType, createEvent } from '../events/EventTypes.js';
import { StructuredLogger } from '../logging/StructuredLogger.js';
import { MCPTool, ToolResult, ToolContext } from '../types/index.js';

export class CreateManagedTableTool implements MCPTool {
  name = 'create_managed_table';
  description =
    'Create a managed table with standard columns (id, created_at, updated_at, and optional additional columns)';

  inputSchema = {
    type: 'object',
    properties: {
      table_name: {
        type: 'string',
        description: 'Name of the table to create',
      },
      id_prefix: {
        type: 'string',
        description: 'Prefix for auto-generated IDs (e.g., "user_" for user_xxx)',
      },
      additional_columns: {
        type: 'string',
        description:
          'Additional column definitions in SQL format (e.g., "email VARCHAR(255) UNIQUE, status VARCHAR(50)")',
        default: '',
      },
    },
    required: ['table_name', 'id_prefix'],
  };

  constructor(
    private connectionManager: PostgresConnectionManager,
    private logger: StructuredLogger,
    private eventCollector?: EventCollector
  ) {
    this.logger.info('CreateManagedTableTool initialized', {}, 'CreateManagedTableTool');
  }

  async execute(args: any, context?: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const { table_name, id_prefix, additional_columns = '' } = args;

    this.logger.debug(
      'Creating managed table',
      {
        requestId: context?.requestId,
        traceId: context?.traceId,
        sessionId: context?.sessionId,
        tableName: table_name,
        idPrefix: id_prefix,
        hasAdditionalColumns: !!additional_columns,
      },
      'CreateManagedTableTool'
    );

    try {
      // Validate table name
      if (!this.isValidTableName(table_name)) {
        throw new Error(
          `Invalid table name: ${table_name}. Table names must start with a letter and contain only letters, numbers, and underscores.`
        );
      }

      // Validate id prefix
      if (!this.isValidIdPrefix(id_prefix)) {
        throw new Error(
          `Invalid ID prefix: ${id_prefix}. ID prefixes must end with an underscore and contain only letters, numbers, and underscores.`
        );
      }

      // Create the managed table
      const result = await this.connectionManager.createManagedTable(
        table_name,
        id_prefix,
        additional_columns
      );

      const duration = Date.now() - startTime;

      // Log successful creation
      this.logger.info(
        'Managed table created successfully',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          duration,
          tableName: table_name,
          idPrefix: id_prefix,
        },
        'CreateManagedTableTool'
      );

      // Emit table created event
      if (this.eventCollector) {
        this.eventCollector.collect(
          createEvent(
            EventType.TABLE_CREATED,
            {
              table_name,
              id_prefix,
              additional_columns,
              database: this.connectionManager.getCurrentDatabase(),
              schema: 'public',
            },
            {
              source: 'CreateManagedTableTool',
              correlation_id: context?.requestId,
              trace_id: context?.traceId,
              severity: 'info',
            }
          )
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: result,
                table_name,
                traceId: context?.traceId,
              },
              null,
              2
            ),
          },
        ],
        metadata: {
          duration_ms: duration,
          traceId: context?.traceId || '',
          table_name,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorType = this.getErrorType(errorMessage);

      this.logger.error(
        'Failed to create managed table',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          duration,
          tableName: table_name,
          error: {
            message: errorMessage,
            code: errorType,
          },
        },
        'CreateManagedTableTool'
      );

      // Emit table creation failed event
      if (this.eventCollector) {
        this.eventCollector.collect(
          createEvent(
            EventType.TABLE_CREATE_FAILED,
            {
              table_name,
              error_message: errorMessage,
              error_type: errorType,
            },
            {
              source: 'CreateManagedTableTool',
              correlation_id: context?.requestId,
              trace_id: context?.traceId,
              severity: 'error',
            }
          )
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Error creating managed table: ${errorMessage}`,
          },
        ],
        metadata: {
          duration_ms: duration,
          traceId: context?.traceId || '',
          error: {
            code: errorType,
            message: errorMessage,
            details: { table_name },
          },
        },
      };
    }
  }

  /**
   * Validate table name format
   */
  private isValidTableName(name: string): boolean {
    // Table names must start with a letter and contain only letters, numbers, and underscores
    return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(name);
  }

  /**
   * Validate ID prefix format
   */
  private isValidIdPrefix(prefix: string): boolean {
    // ID prefixes must end with underscore and contain only letters, numbers, and underscores
    return /^[a-zA-Z0-9_]+_$/.test(prefix);
  }

  /**
   * Determine error type from error message
   */
  private getErrorType(message: string): string {
    if (message.includes('already exists')) {
      return 'TABLE_ALREADY_EXISTS';
    } else if (message.includes('permission denied')) {
      return 'PERMISSION_DENIED';
    } else if (message.includes('syntax error')) {
      return 'SYNTAX_ERROR';
    } else if (message.includes('Invalid table name')) {
      return 'INVALID_TABLE_NAME';
    } else if (message.includes('Invalid ID prefix')) {
      return 'INVALID_ID_PREFIX';
    }
    return 'DATABASE_ERROR';
  }
}
