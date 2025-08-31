/**
 * Executes multiple queries in a batch for improved performance.
 * Supports transactional batch execution and prepared statements.
 */

import { PostgresConnectionManager } from '../database/PostgresConnectionManager.js';
import { QueryValidator } from '../database/QueryValidator.js';
import { EventCollector } from '../events/EventCollector.js';
import { EventType, createEvent } from '../events/EventTypes.js';
import { StructuredLogger } from '../logging/StructuredLogger.js';
import { MCPTool, ToolResult, ToolContext, MCPError } from '../types/index.js';

export interface BatchQuery {
  sql: string;
  params?: any[];
  name?: string; // Optional name for identifying results
}

export interface BatchOptions {
  transaction?: boolean; // Execute all queries in a transaction
  stopOnError?: boolean; // Stop execution on first error
  timeout?: number; // Timeout for entire batch
  maxParallel?: number; // Max queries to run in parallel (non-transactional only)
}

export interface BatchResult {
  name?: string;
  success: boolean;
  rowCount?: number;
  rows?: any[];
  error?: string;
  executionTime: number;
}

export class BatchQueryTool implements MCPTool {
  name = 'batch_query';
  description = 'Execute multiple SQL queries in a batch with optional transaction support';

  inputSchema = {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        description: 'Array of queries to execute',
        items: {
          type: 'object',
          properties: {
            sql: {
              type: 'string',
              description: 'SQL query to execute',
            },
            params: {
              type: 'array',
              description: 'Query parameters',
              items: {
                type: ['string', 'number', 'boolean', 'null'],
              },
            },
            name: {
              type: 'string',
              description: 'Optional name to identify this query result',
            },
          },
          required: ['sql'],
        },
      },
      options: {
        type: 'object',
        description: 'Batch execution options',
        properties: {
          transaction: {
            type: 'boolean',
            description: 'Execute all queries in a transaction',
            default: true,
          },
          stopOnError: {
            type: 'boolean',
            description: 'Stop execution on first error',
            default: true,
          },
          timeout: {
            type: 'number',
            description: 'Timeout for entire batch in milliseconds',
          },
          maxParallel: {
            type: 'number',
            description: 'Max queries to run in parallel (non-transactional only)',
            default: 1,
          },
        },
      },
    },
    required: ['queries'],
  };

  constructor(
    private connectionManager: PostgresConnectionManager,
    private validator: QueryValidator,
    private logger: StructuredLogger,
    private eventCollector?: EventCollector,
    private defaultTimeout: number = 60000, // 1 minute for batch
    private allowWriteOperations: boolean = false
  ) {
    this.logger.info(
      'BatchQueryTool initialized',
      {
        defaultTimeout,
        allowWriteOperations,
      },
      'BatchQueryTool'
    );
  }

  async execute(args: any, context?: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const { queries, options = {} } = args;
    const batchOptions: BatchOptions = {
      transaction: options.transaction !== false,
      stopOnError: options.stopOnError !== false,
      timeout: options.timeout || this.defaultTimeout,
      maxParallel: options.maxParallel || 1,
    };

    this.logger.debug(
      'Executing batch queries',
      {
        requestId: context?.requestId,
        traceId: context?.traceId,
        sessionId: context?.sessionId,
        queryCount: queries.length,
        options: batchOptions,
      },
      'BatchQueryTool'
    );

    try {
      // Validate all queries first
      const validationResults = await this.validateQueries(queries);
      const invalidQueries = validationResults.filter((v) => !v.valid);

      if (invalidQueries.length > 0) {
        const errors = invalidQueries.map((v, i) => ({
          query: queries[i].name || `Query ${i + 1}`,
          error: v.error,
        }));

        this.logger.warn(
          'Batch validation failed',
          {
            requestId: context?.requestId,
            invalidCount: invalidQueries.length,
            errors,
          },
          'BatchQueryTool'
        );

        throw new Error(
          `Validation failed for ${invalidQueries.length} queries: ${JSON.stringify(errors)}`
        );
      }

      let results: BatchResult[];

      if (batchOptions.transaction) {
        results = await this.executeInTransaction(queries, batchOptions, context);
      } else {
        results = await this.executeParallel(queries, batchOptions, context);
      }

      const duration = Date.now() - startTime;
      const successCount = results.filter((r) => r.success).length;
      const totalRows = results.reduce((sum, r) => sum + (r.rowCount || 0), 0);

      // Log batch execution
      this.logger.info(
        'Batch queries executed',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          duration,
          queryCount: queries.length,
          successCount,
          failureCount: queries.length - successCount,
          totalRows,
          transaction: batchOptions.transaction,
        },
        'BatchQueryTool'
      );

      // Emit batch event
      if (this.eventCollector) {
        this.eventCollector.collect(
          createEvent(
            EventType.QUERY_EXECUTED,
            {
              query_type: 'BATCH',
              query_count: queries.length,
              success_count: successCount,
              execution_time_ms: duration,
              row_count: totalRows,
              transaction: batchOptions.transaction,
              database: this.connectionManager.getCurrentDatabase(),
            },
            {
              source: 'BatchQueryTool',
              correlation_id: context?.requestId,
              trace_id: context?.traceId,
              severity: 'info',
            }
          )
        );
      }

      // Format response
      const response = {
        success: successCount === queries.length,
        totalQueries: queries.length,
        successCount,
        failureCount: queries.length - successCount,
        totalRows,
        executionTime: duration,
        transaction: batchOptions.transaction,
        results,
        metadata: {
          requestId: context?.requestId,
          traceId: context?.traceId,
          preparedStatements: this.connectionManager.getPreparedStatementMetrics(),
        },
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2),
          },
        ],
        metadata: {
          duration_ms: duration,
          traceId: context?.traceId || '',
          query_count: queries.length,
          success_count: successCount,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      this.logger.error(
        'Batch execution failed',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          duration,
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                }
              : { message: String(error) },
        },
        'BatchQueryTool'
      );

      // Emit failure event
      if (this.eventCollector) {
        this.eventCollector.collect(
          createEvent(
            EventType.QUERY_FAILED,
            {
              query_type: 'BATCH',
              error_message: error instanceof Error ? error.message : String(error),
              query_count: queries.length,
            },
            {
              source: 'BatchQueryTool',
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
            text: `Batch execution error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        metadata: {
          duration_ms: duration,
          traceId: context?.traceId || '',
          error: {
            code: 'BATCH_EXECUTION_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }

  /**
   * Validate all queries in the batch
   */
  private async validateQueries(
    queries: BatchQuery[]
  ): Promise<Array<{ valid: boolean; error?: string; queryType?: string }>> {
    return queries.map((query, index) => {
      try {
        const validation = this.validator.validate(query.sql, query.params);
        if (!validation.valid) {
          return {
            valid: false,
            error: validation.error || `Query ${index + 1} validation failed`,
          };
        }
        return {
          valid: true,
          queryType: validation.queryType,
        };
      } catch (error) {
        return {
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  /**
   * Execute queries in a transaction
   */
  private async executeInTransaction(
    queries: BatchQuery[],
    options: BatchOptions,
    context?: ToolContext
  ): Promise<BatchResult[]> {
    const pool = await this.connectionManager.getPool();
    const client = await pool.connect();
    const results: BatchResult[] = [];

    try {
      // Set timeout for the entire transaction
      if (options.timeout) {
        await client.query(`SET statement_timeout = ${options.timeout}`);
      }

      // Begin transaction
      await client.query('BEGIN');

      this.logger.debug(
        'Transaction started',
        {
          requestId: context?.requestId,
          queryCount: queries.length,
        },
        'BatchQueryTool'
      );

      // Execute each query
      for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        const queryStart = Date.now();

        try {
          const result = await client.query(query.sql, query.params);
          const executionTime = Date.now() - queryStart;

          results.push({
            name: query.name,
            success: true,
            rowCount: result.rowCount || 0,
            rows: result.rows,
            executionTime,
          });

          this.logger.trace(
            'Transaction query executed',
            {
              requestId: context?.requestId,
              queryIndex: i,
              name: query.name,
              rowCount: result.rowCount ?? undefined,
              executionTime,
            },
            'BatchQueryTool'
          );
        } catch (error) {
          const executionTime = Date.now() - queryStart;
          const errorMessage = error instanceof Error ? error.message : String(error);

          results.push({
            name: query.name,
            success: false,
            error: errorMessage,
            executionTime,
          });

          if (options.stopOnError) {
            await client.query('ROLLBACK');
            throw new Error(
              `Transaction failed at query ${i + 1} (${query.name || 'unnamed'}): ${errorMessage}`
            );
          }
        }
      }

      // Commit transaction
      await client.query('COMMIT');

      this.logger.debug(
        'Transaction committed',
        {
          requestId: context?.requestId,
          queryCount: queries.length,
          successCount: results.filter((r) => r.success).length,
        },
        'BatchQueryTool'
      );

      return results;
    } catch (error) {
      // Ensure rollback on error
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        this.logger.error(
          'Rollback failed',
          {
            error: {
              message:
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            },
          },
          'BatchQueryTool'
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Execute queries in parallel (non-transactional)
   */
  private async executeParallel(
    queries: BatchQuery[],
    options: BatchOptions,
    context?: ToolContext
  ): Promise<BatchResult[]> {
    const maxParallel = Math.min(options.maxParallel || 1, queries.length);
    const results: BatchResult[] = new Array(queries.length);

    this.logger.debug(
      'Executing queries in parallel',
      {
        requestId: context?.requestId,
        queryCount: queries.length,
        maxParallel,
      },
      'BatchQueryTool'
    );

    // Execute in batches
    for (let i = 0; i < queries.length; i += maxParallel) {
      const batch = queries.slice(i, i + maxParallel);
      const batchPromises = batch.map(async (query, batchIndex) => {
        const queryIndex = i + batchIndex;
        const queryStart = Date.now();

        try {
          // Use prepared statements when available
          const result = await this.connectionManager.executeQueryWithPreparedStatement(
            query.sql,
            query.params,
            options.timeout
          );

          const executionTime = Date.now() - queryStart;

          results[queryIndex] = {
            name: query.name,
            success: true,
            rowCount: result.rowCount ?? undefined,
            rows: result.rows,
            executionTime,
          };
        } catch (error) {
          const executionTime = Date.now() - queryStart;
          const errorMessage = error instanceof Error ? error.message : String(error);

          results[queryIndex] = {
            name: query.name,
            success: false,
            error: errorMessage,
            executionTime,
          };

          if (options.stopOnError) {
            throw new Error(
              `Query ${queryIndex + 1} (${query.name || 'unnamed'}) failed: ${errorMessage}`
            );
          }
        }
      });

      try {
        await Promise.all(batchPromises);
      } catch (error) {
        if (options.stopOnError) {
          throw error;
        }
      }
    }

    return results;
  }
}
