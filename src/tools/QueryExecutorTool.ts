/**
 * Executes validated read-only SQL queries.
 * Handles parameterized queries and result formatting.
 */

import { PostgresConnectionManager } from '../database/PostgresConnectionManager.js';
import { QueryValidator } from '../database/QueryValidator.js';
import { QueryOptions } from '../database/types/QueryTypes.js';
import { EventCollector } from '../events/EventCollector.js';
import { EventType, createEvent } from '../events/EventTypes.js';
import { StructuredLogger } from '../logging/StructuredLogger.js';
import { MCPTool, ToolResult, ToolContext, MCPError, FieldInfo } from '../types/index.js';
import { QueryExecutorArgs } from '../types/ToolArguments.js';
import { enhanceError, isPostgresError, PostgresErrorCodes } from '../utils/ErrorTypes.js';
import { createValidator } from '../utils/ValidationUtils.js';

export class QueryExecutorTool implements MCPTool<QueryExecutorArgs> {
  name = 'query';
  description: string;
  private validateArgs: (value: unknown) => QueryExecutorArgs;

  inputSchema = {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'The SQL query to execute',
      },
      params: {
        type: 'array',
        description: 'Query parameters for parameterized queries',
        items: {
          type: ['string', 'number', 'boolean', 'null'],
        },
      },
      options: {
        type: 'object',
        description: 'Query execution options',
        properties: {
          timeout: {
            type: 'number',
            description: 'Query timeout in milliseconds',
          },
          maxRows: {
            type: 'number',
            description: 'Maximum number of rows to return',
          },
        },
      },
    },
    required: ['sql'],
  };

  constructor(
    private connectionManager: PostgresConnectionManager,
    private validator: QueryValidator,
    private logger: StructuredLogger,
    private eventCollector?: EventCollector,
    private defaultTimeout: number = 30000,
    private defaultMaxRows: number = 10000,
    private allowWriteOperations: boolean = false
  ) {
    this.description = this.allowWriteOperations
      ? 'Execute SQL queries on the PostgreSQL database (read and write operations allowed)'
      : 'Execute read-only SQL queries on the PostgreSQL database';

    this.logger.info(
      'QueryExecutorTool initialized',
      {
        defaultTimeout,
        defaultMaxRows,
        allowWriteOperations,
      },
      'QueryExecutorTool'
    );

    // Create validator for runtime type checking
    this.validateArgs = createValidator<QueryExecutorArgs>(this.inputSchema);
  }

  async execute(args: QueryExecutorArgs, context?: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();

    // Validate arguments at runtime
    let validatedArgs: QueryExecutorArgs;
    try {
      validatedArgs = this.validateArgs(args);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Invalid arguments: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        metadata: {
          duration_ms: Date.now() - startTime,
          traceId: context?.traceId || '',
          error: {
            code: 'INVALID_ARGUMENTS',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }

    const { sql, params = [], options = {} } = validatedArgs;

    this.logger.debug(
      'Executing query',
      {
        requestId: context?.requestId,
        traceId: context?.traceId,
        sessionId: context?.sessionId,
        queryLength: sql.length,
        paramCount: params.length,
        hasOptions: Object.keys(options).length > 0,
      },
      'QueryExecutorTool'
    );

    this.logger.trace(
      'Query details',
      {
        requestId: context?.requestId,
        traceId: context?.traceId,
        sessionId: context?.sessionId,
        sql: sql.substring(0, 500),
        params: params.map((p) => typeof p),
        options,
      },
      'QueryExecutorTool'
    );

    try {
      // Validate the query
      this.logger.trace('Validating query', { requestId: context?.requestId }, 'QueryExecutorTool');
      const validation = this.validator.validate(sql, params);
      if (!validation.valid) {
        this.logger.warn(
          'Query validation failed',
          {
            requestId: context?.requestId,
            error: { message: validation.error || 'Query validation failed' },
            queryType: validation.queryType,
          },
          'QueryExecutorTool'
        );
        throw new Error(validation.error || 'Query validation failed');
      }

      this.logger.debug(
        'Query validated',
        {
          requestId: context?.requestId,
          queryType: validation.queryType,
          hasParameters: validation.hasParameters,
        },
        'QueryExecutorTool'
      );

      // Apply options
      const queryOptions: QueryOptions = {
        timeout: options.timeout || this.defaultTimeout,
        maxRows: options.maxRows || this.defaultMaxRows,
        includeMetadata: true,
      };

      this.logger.trace(
        'Query options',
        {
          requestId: context?.requestId,
          ...queryOptions,
        },
        'QueryExecutorTool'
      );

      // Execute the query
      this.logger.debug(
        'Sending query to connection manager',
        {
          requestId: context?.requestId,
          timeout: queryOptions.timeout,
          hasParams: params && params.length > 0,
        },
        'QueryExecutorTool'
      );

      // Use prepared statements when parameters are provided
      const result = await this.connectionManager.executeQueryWithPreparedStatement(
        sql,
        params,
        queryOptions.timeout
      );

      this.logger.debug(
        'Query result received',
        {
          requestId: context?.requestId,
          rowCount: result.rowCount || result.rows?.length || 0,
          fieldCount: result.fields?.length || 0,
          executionTime: result.executionTime,
        },
        'QueryExecutorTool'
      );

      // Apply row limit if needed
      let rows = result.rows;
      let truncated = false;
      if (rows.length > queryOptions.maxRows!) {
        rows = rows.slice(0, queryOptions.maxRows);
        truncated = true;

        this.logger.debug(
          'Result truncated',
          {
            requestId: context?.requestId,
            originalRows: result.rows.length,
            truncatedRows: rows.length,
            maxRows: queryOptions.maxRows,
          },
          'QueryExecutorTool'
        );
      }

      const duration = Date.now() - startTime;

      // Log successful execution
      this.logger.info(
        'Query executed successfully',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          duration,
          rowCount: result.rowCount || rows.length,
          truncated,
          queryType: validation.queryType,
          executionTime: result.executionTime,
          totalTime: duration,
        },
        'QueryExecutorTool'
      );

      // Emit query executed event
      if (this.eventCollector) {
        this.eventCollector.collect(
          createEvent(
            EventType.QUERY_EXECUTED,
            {
              query: sql,
              query_hash: this.hashQuery(sql),
              execution_time_ms: result.executionTime || duration,
              row_count: result.rowCount || rows.length,
              database: this.connectionManager.getCurrentDatabase(),
              schema: 'public',
              tables_accessed: [],
              truncated,
              cache_hit: false,
            },
            {
              source: 'QueryExecutorTool',
              correlation_id: context?.requestId,
              trace_id: context?.traceId,
              severity: result.executionTime > 1000 ? 'warn' : 'info',
            }
          )
        );

        // Emit slow query event if execution time exceeds threshold
        if (result.executionTime > 1000) {
          this.eventCollector.collect(
            createEvent(
              EventType.QUERY_SLOW,
              {
                query: sql,
                execution_time_ms: result.executionTime,
                threshold_ms: 1000,
                row_count: result.rowCount || rows.length,
                full_table_scan: false, // TODO: Detect from query plan
                optimization_suggestions: [],
              },
              {
                source: 'QueryExecutorTool',
                correlation_id: context?.requestId,
                trace_id: context?.traceId,
                severity: 'warn',
              }
            )
          );
        }
      }

      // Format the response
      const responseData = {
        success: true,
        rowCount: result.rowCount || rows.length,
        rows,
        fields: result.fields.map((f: FieldInfo) => ({
          name: f.name,
          dataType: this.getDataTypeName(f.dataTypeID),
        })),
        executionTime: result.executionTime,
        truncated,
        metadata: {
          requestId: context?.requestId,
          traceId: context?.traceId,
          queryType: validation.queryType,
          hasParameters: validation.hasParameters,
          preparedStatement: result.preparedStatement || false,
          duration,
        },
      };

      this.logger.trace(
        'Response data prepared',
        {
          requestId: context?.requestId,
          responseSize: JSON.stringify(responseData).length,
          fieldNames: result.fields.map((f) => f.name),
        },
        'QueryExecutorTool'
      );

      try {
        const successResponse: ToolResult = {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(responseData, null, 2),
            },
          ],
          metadata: {
            duration_ms: duration,
            traceId: context?.traceId || '',
            row_count: result.rowCount || 0,
          },
        };

        this.logger.debug(
          'Returning success response',
          {
            requestId: context?.requestId,
            traceId: context?.traceId,
            sessionId: context?.sessionId,
            responseContentType: successResponse.content[0].type,
            responseTextLength: successResponse.content[0].text.length,
            hasMetadata: !!successResponse.metadata,
            metadataKeys: successResponse.metadata ? Object.keys(successResponse.metadata) : [],
            rowCount: result.rowCount || 0,
          },
          'QueryExecutorTool'
        );

        return successResponse;
      } catch (responseError) {
        this.logger.error(
          'Failed to format success response',
          {
            requestId: context?.requestId,
            traceId: context?.traceId,
            responseError:
              responseError instanceof Error ? responseError.message : String(responseError),
            rowCount: rows.length,
          },
          'QueryExecutorTool'
        );

        // Return minimal safe response
        return {
          content: [
            {
              type: 'text' as const,
              text: `Query executed successfully but failed to format response. Row count: ${rows.length}`,
            },
          ],
          metadata: {
            duration_ms: duration,
            traceId: context?.traceId || '',
            error: { code: 'RESPONSE_FORMAT_ERROR', message: 'Failed to format response' },
          },
        };
      }
    } catch (error) {
      const duration = Date.now() - startTime;

      // Check if error is already enhanced (has MCPError properties)
      let mcpError: MCPError;
      if (error && typeof error === 'object' && 'code' in error && 'details' in error) {
        // Error is already enhanced from PostgresConnectionManager
        mcpError = error as MCPError;
        // Ensure message is preserved
        if (!mcpError.message && error instanceof Error) {
          mcpError.message = error.message;
        }
      } else {
        // Enhance the error
        mcpError = enhanceError(error, {
          operation: 'executeQuery',
          query: sql.substring(0, 200),
          paramCount: params?.length || 0,
        });
      }

      // Check for validation errors first
      if (error instanceof Error) {
        if (error.message.includes('permission denied') || error.message.includes('not allowed')) {
          mcpError.code = 'PERMISSION_DENIED';
        } else if (error.message.includes('validation failed')) {
          mcpError.code = 'VALIDATION_ERROR';
        } else if (error.message.includes('Connection acquisition timeout')) {
          mcpError.code = 'CONNECTION_TIMEOUT';
          mcpError.details = {
            ...mcpError.details,
            suggestion:
              'Database connection pool may be exhausted. Try again in a few moments or contact administrator.',
          };
        } else if (error.message.includes('Failed to acquire database connection')) {
          mcpError.code = 'CONNECTION_FAILED';
          mcpError.details = {
            ...mcpError.details,
            suggestion:
              'Unable to connect to database. Check connection settings and pool availability.',
          };
        }
      }

      // Enhance error code based on specific PostgreSQL error types
      if (isPostgresError(error)) {
        switch (error.code) {
          case PostgresErrorCodes.QUERY_CANCELED:
            mcpError.code = 'QUERY_TIMEOUT';
            break;
          case PostgresErrorCodes.UNDEFINED_TABLE:
          case PostgresErrorCodes.UNDEFINED_COLUMN:
            mcpError.code = 'INVALID_OBJECT';
            break;
          case PostgresErrorCodes.INSUFFICIENT_PRIVILEGE:
            mcpError.code = 'PERMISSION_DENIED';
            break;
          case PostgresErrorCodes.SYNTAX_ERROR:
            mcpError.code = 'SYNTAX_ERROR';
            break;
        }
      }

      this.logger.error(
        'Query execution failed',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          duration,
          error: mcpError,
          query: sql.substring(0, 100),
          paramCount: params?.length || 0,
          errorType: mcpError.code,
        },
        'QueryExecutorTool'
      );

      // Emit query failed event
      if (this.eventCollector) {
        this.eventCollector.collect(
          createEvent(
            EventType.QUERY_FAILED,
            {
              query: sql,
              error_code: mcpError.code,
              error_message: mcpError.message,
              error_position: isPostgresError(error) ? error.position : undefined,
              suggested_fix: this.getSuggestedFix(mcpError),
              recovery_attempted: false,
              recovery_strategy: 'NONE',
            },
            {
              source: 'QueryExecutorTool',
              correlation_id: context?.requestId,
              trace_id: context?.traceId,
              severity: 'error',
            }
          )
        );
      }

      // Log specific error types at appropriate levels
      if (mcpError.code === 'QUERY_TIMEOUT') {
        this.logger.warn(
          'Query timed out',
          {
            requestId: context?.requestId,
            timeout: options.timeout || this.defaultTimeout,
            duration,
          },
          'QueryExecutorTool'
        );
      } else if (mcpError.code === 'PERMISSION_DENIED') {
        this.logger.warn(
          'Permission denied for query',
          {
            requestId: context?.requestId,
            query: sql.substring(0, 50),
          },
          'QueryExecutorTool'
        );
      }

      // Return error response with safe error handling
      try {
        const errorResponse: ToolResult = {
          content: [
            {
              type: 'text' as const,
              text: this.formatErrorResponse(mcpError, context?.traceId),
            },
          ],
          metadata: {
            duration_ms: duration,
            traceId: context?.traceId || '',
            error: mcpError,
          },
        };

        this.logger.debug(
          'Returning error response',
          {
            requestId: context?.requestId,
            traceId: context?.traceId,
            sessionId: context?.sessionId,
            errorCode: mcpError.code,
            responseContentType: errorResponse.content[0].type,
            responseTextLength: errorResponse.content[0].text.length,
            hasMetadata: !!errorResponse.metadata,
            metadataKeys: errorResponse.metadata ? Object.keys(errorResponse.metadata) : [],
          },
          'QueryExecutorTool'
        );

        return errorResponse;
      } catch (formatError) {
        // If error formatting fails, return a minimal safe response
        this.logger.error(
          'Failed to format error response',
          {
            requestId: context?.requestId,
            traceId: context?.traceId,
            formatError: formatError instanceof Error ? formatError.message : String(formatError),
            originalError: mcpError.message,
          },
          'QueryExecutorTool'
        );

        // Return absolute minimal response that should never fail
        return {
          content: [
            {
              type: 'text' as const,
              text: 'An error occurred while processing the query. Please check the logs for details.',
            },
          ],
          metadata: {
            duration_ms: duration,
            traceId: context?.traceId || '',
            error: { code: 'INTERNAL_ERROR', message: 'Failed to format error response' },
          },
        };
      }
    }
  }

  /**
   * Map PostgreSQL data type OIDs to readable names
   */
  private getDataTypeName(oid: number): string {
    // Common PostgreSQL type OIDs
    const typeMap: Record<number, string> = {
      16: 'boolean',
      17: 'bytea',
      18: 'char',
      19: 'name',
      20: 'bigint',
      21: 'smallint',
      23: 'integer',
      25: 'text',
      114: 'json',
      142: 'xml',
      700: 'real',
      701: 'double precision',
      1043: 'varchar',
      1082: 'date',
      1083: 'time',
      1114: 'timestamp',
      1184: 'timestamptz',
      1560: 'bit',
      1562: 'varbit',
      1700: 'numeric',
      2950: 'uuid',
      3802: 'jsonb',
    };

    return typeMap[oid] || `unknown(${oid})`;
  }

  /**
   * Create a simple hash of a query for identification
   */
  private hashQuery(query: string): string {
    // Simple hash for query identification (not cryptographic)
    let hash = 0;
    for (let i = 0; i < query.length; i++) {
      const char = query.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Format error response with all details including PostgreSQL hints
   */
  private formatErrorResponse(error: MCPError, traceId?: string): string {
    let response = `Error: ${error.message}`;
    response += `\nCode: ${error.code}`;

    // Check for PostgreSQL fields at top level first (from the thrown error)
    const errorAny = error as any;
    if (errorAny.detail) {
      response += `\nDetail: ${errorAny.detail}`;
    }
    if (errorAny.hint) {
      response += `\nHint: ${errorAny.hint}`;
    }
    if (errorAny.position) {
      response += `\nPosition: ${errorAny.position}`;
    }
    if (errorAny.constraint) {
      response += `\nConstraint: ${errorAny.constraint}`;
    }
    if (errorAny.table) {
      response += `\nTable: ${errorAny.table}`;
    }
    if (errorAny.column) {
      response += `\nColumn: ${errorAny.column}`;
    }

    // Also check in details object (for backward compatibility)
    if (error.details) {
      // PostgreSQL specific error details
      if (error.details.detail && !errorAny.detail) {
        response += `\nDetail: ${error.details.detail}`;
      }
      if (error.details.hint && !errorAny.hint) {
        response += `\nHint: ${error.details.hint}`;
      }
      if (error.details.position && !errorAny.position) {
        response += `\nPosition: ${error.details.position}`;
      }
      if (error.details.constraint && !errorAny.constraint) {
        response += `\nConstraint: ${error.details.constraint}`;
      }
      if (error.details.table && !errorAny.table) {
        response += `\nTable: ${error.details.table}`;
      }
      if (error.details.column && !errorAny.column) {
        response += `\nColumn: ${error.details.column}`;
      }

      // Add suggested fix if available
      const suggestedFix = this.getSuggestedFix(error);
      if (suggestedFix) {
        response += `\nSuggestion: ${suggestedFix}`;
      }

      // Add query context if available
      if (error.query) {
        response += `\n\nQuery: ${error.query}`;
      }
    }

    // Always include trace ID for log lookup
    if (traceId) {
      response += `\n\nTrace ID: ${traceId}`;
    }

    return response;
  }

  /**
   * Get suggested fix for common errors
   */
  private getSuggestedFix(error: MCPError): string | undefined {
    switch (error.code) {
      case 'VALIDATION_ERROR':
        if (
          error.message.includes('UPDATE') ||
          error.message.includes('DELETE') ||
          error.message.includes('INSERT')
        ) {
          return 'This is a read-only connection. Only SELECT queries are allowed.';
        }
        break;
      case 'INVALID_OBJECT':
        return 'Check table/column names and schema. Use the list_tables tool to see available tables.';
      case 'PERMISSION_DENIED':
        return 'The database user does not have permission to access this object.';
      case 'SYNTAX_ERROR':
        return 'Check SQL syntax. Common issues: missing quotes, incorrect keywords, unmatched parentheses.';
      case 'QUERY_TIMEOUT':
        return 'Query took too long. Consider adding indexes, limiting results, or optimizing the query.';
    }
    return undefined;
  }
}
