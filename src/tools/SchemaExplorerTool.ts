/**
 * Lists tables and schemas in the database.
 * Provides filtering and sorting capabilities.
 */

import { PostgresConnectionManager } from '../database/PostgresConnectionManager.js';
import { StructuredLogger } from '../logging/StructuredLogger.js';
import { MCPTool, ToolResult, ToolContext, TableInfo } from '../types/index.js';

export class SchemaExplorerTool implements MCPTool {
  name = 'list_tables';
  description = 'List all tables in the current database or a specific schema';

  inputSchema: any;

  constructor(
    private connectionManager: PostgresConnectionManager,
    private logger: StructuredLogger,
    private defaultSchema: string = 'public'
  ) {
    this.inputSchema = {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description: `Schema name (default: ${this.defaultSchema})`,
          default: this.defaultSchema,
        },
        includeSystemTables: {
          type: 'boolean',
          description: 'Include PostgreSQL system tables',
          default: false,
        },
        includeSize: {
          type: 'boolean',
          description: 'Include table size information (slower)',
          default: false,
        },
        pattern: {
          type: 'string',
          description: 'Filter tables by name pattern (SQL LIKE pattern)',
        },
      },
    };

    this.logger.info(
      'SchemaExplorerTool initialized',
      { defaultSchema: this.defaultSchema },
      'SchemaExplorerTool'
    );
  }

  async execute(args: any, context?: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const {
      schema = this.defaultSchema,
      includeSystemTables = false,
      includeSize = false,
      pattern,
    } = args;

    this.logger.debug(
      'Listing tables',
      {
        requestId: context?.requestId,
        traceId: context?.traceId,
        sessionId: context?.sessionId,
        schema,
        includeSystemTables,
        includeSize,
        pattern,
        allSchemas: schema === '*',
      },
      'SchemaExplorerTool'
    );

    this.logger.trace(
      'Building table listing query',
      {
        requestId: context?.requestId,
        traceId: context?.traceId,
        sessionId: context?.sessionId,
        options: args,
      },
      'SchemaExplorerTool'
    );

    try {
      // Build the query based on options
      let query: string;
      const params: any[] = [];

      if (includeSize) {
        // Query with size information (slower)
        query = `
          SELECT 
            schemaname AS schema,
            tablename AS table,
            tableowner AS owner,
            pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
            (SELECT COUNT(*) FROM pg_stat_user_tables WHERE schemaname = t.schemaname AND relname = t.tablename) > 0 AS has_stats
          FROM pg_tables t
          WHERE 1=1
        `;
      } else {
        // Basic query (faster)
        query = `
          SELECT 
            schemaname AS schema,
            tablename AS table,
            tableowner AS owner
          FROM pg_tables
          WHERE 1=1
        `;
      }

      // Add schema filter
      if (schema !== '*') {
        query += ` AND schemaname = $${params.length + 1}`;
        params.push(schema);
        this.logger.trace(
          'Added schema filter',
          {
            requestId: context?.requestId,
            traceId: context?.traceId,
            sessionId: context?.sessionId,
            schema,
            paramIndex: params.length,
          },
          'SchemaExplorerTool'
        );
      }

      // Add system tables filter
      if (!includeSystemTables) {
        query += ` AND schemaname NOT IN ('pg_catalog', 'information_schema')`;
        this.logger.trace(
          'Excluding system tables',
          {
            requestId: context?.requestId,
            traceId: context?.traceId,
            sessionId: context?.sessionId,
          },
          'SchemaExplorerTool'
        );
      }

      // Add pattern filter
      if (pattern) {
        query += ` AND tablename LIKE $${params.length + 1}`;
        params.push(pattern);
        this.logger.trace(
          'Added pattern filter',
          {
            requestId: context?.requestId,
            traceId: context?.traceId,
            sessionId: context?.sessionId,
            pattern,
            paramIndex: params.length,
          },
          'SchemaExplorerTool'
        );
      }

      query += ` ORDER BY schemaname, tablename`;

      this.logger.debug(
        'Executing table listing query',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          paramCount: params.length,
        },
        'SchemaExplorerTool'
      );

      // Execute the query
      const result = await this.connectionManager.executeQuery(query, params);

      this.logger.debug(
        'Table listing query completed',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          tableCount: result.rows.length,
          executionTime: result.executionTime,
        },
        'SchemaExplorerTool'
      );

      const duration = Date.now() - startTime;

      // Get additional schema information if listing all schemas
      let schemas: any[] = [];
      if (schema === '*') {
        this.logger.debug(
          'Fetching schema information',
          {
            requestId: context?.requestId,
            traceId: context?.traceId,
            sessionId: context?.sessionId,
          },
          'SchemaExplorerTool'
        );

        const schemaResult = await this.connectionManager.executeQuery(`
          SELECT 
            schema_name,
            schema_owner,
            (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = schema_name) AS table_count
          FROM information_schema.schemata
          WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          ORDER BY schema_name
        `);
        schemas = schemaResult.rows;

        this.logger.debug(
          'Schema information fetched',
          {
            requestId: context?.requestId,
            traceId: context?.traceId,
            sessionId: context?.sessionId,
            schemaCount: schemas.length,
          },
          'SchemaExplorerTool'
        );
      }

      // Format the tables
      const tables: TableInfo[] = result.rows.map((row) => ({
        schema: row.schema,
        table: row.table,
        owner: row.owner,
        size: row.size,
        rowCount: row.has_stats ? row.row_count : undefined, // undefined means no stats available
      }));

      // Get row counts if requested and available
      if (includeSize && tables.length > 0 && tables.length <= 50) {
        this.logger.debug(
          'Fetching row counts for tables',
          {
            requestId: context?.requestId,
            traceId: context?.traceId,
            sessionId: context?.sessionId,
            tableCount: tables.length,
          },
          'SchemaExplorerTool'
        );

        let successCount = 0;
        let errorCount = 0;

        // Only get row counts for up to 50 tables to avoid performance issues
        for (const table of tables) {
          if (table.rowCount !== null) continue; // Skip if no stats

          try {
            const countResult = await this.connectionManager.executeQuery(
              `SELECT COUNT(*) as count FROM ${table.schema}.${table.table}`,
              [],
              5000 // 5 second timeout for count queries
            );
            table.rowCount = parseInt(countResult.rows[0].count);
            successCount++;
          } catch (err) {
            // Ignore count errors
            errorCount++;
            this.logger.trace(
              'Failed to get row count',
              {
                table: `${table.schema}.${table.table}`,
                error: { message: err instanceof Error ? err.message : String(err) },
              },
              'SchemaExplorerTool'
            );
          }
        }

        this.logger.debug(
          'Row count fetching completed',
          {
            requestId: context?.requestId,
            traceId: context?.traceId,
            sessionId: context?.sessionId,
            successCount,
            errorCount,
            totalTables: tables.length,
          },
          'SchemaExplorerTool'
        );
      }

      this.logger.info(
        'Tables listed successfully',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          duration,
          tableCount: tables.length,
          schemaCount: schemas.length,
          schema: schema === '*' ? 'all' : schema,
          includeSize,
          pattern: pattern || 'none',
        },
        'SchemaExplorerTool'
      );

      this.logger.trace(
        'Response data statistics',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          totalSize: tables.reduce((sum, t) => sum + (t.size ? 1 : 0), 0),
          totalRowCounts: tables.reduce((sum, t) => sum + (t.rowCount !== undefined ? 1 : 0), 0),
          uniqueSchemas: [...new Set(tables.map((t) => t.schema))].length,
        },
        'SchemaExplorerTool'
      );

      // Format the response
      const responseData = {
        success: true,
        schema: schema === '*' ? 'all' : schema,
        tableCount: tables.length,
        tables,
        ...(schemas.length > 0 && { schemas }),
        metadata: {
          requestId: context?.requestId,
          traceId: context?.traceId || '',
          duration,
          includeSize,
          includeSystemTables,
          pattern,
        },
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(responseData, null, 2),
          },
        ],
        metadata: {
          duration_ms: duration,
          traceId: context?.traceId || '',
          row_count: tables.length,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      this.logger.error(
        'Failed to list tables',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          duration,
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                  code: error.name,
                }
              : { message: String(error) },
          schema,
          includeSize,
          pattern,
        },
        'SchemaExplorerTool'
      );

      return {
        content: [
          {
            type: 'text',
            text: `Error listing tables: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        metadata: {
          duration_ms: duration,
          traceId: context?.traceId || '',
          error: {
            code: 'SCHEMA_EXPLORER_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }
}
