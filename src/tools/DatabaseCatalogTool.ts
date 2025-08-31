/**
 * Lists available databases and their metadata.
 * Shows database sizes and connection information.
 */

import { PostgresConnectionManager } from '../database/PostgresConnectionManager.js';
import { StructuredLogger } from '../logging/StructuredLogger.js';
import { MCPTool, ToolResult, ToolContext, DatabaseInfo } from '../types/index.js';

interface DatabaseCatalogArgs {
  includeSystemDatabases?: boolean;
  includeStatistics?: boolean;
  pattern?: string;
}

export class DatabaseCatalogTool implements MCPTool<DatabaseCatalogArgs> {
  name = 'list_databases';
  description = 'List all databases on the PostgreSQL server';

  inputSchema = {
    type: 'object',
    properties: {
      includeSystemDatabases: {
        type: 'boolean',
        description: 'Include PostgreSQL system databases (postgres, template0, template1)',
        default: false,
      },
      includeStatistics: {
        type: 'boolean',
        description: 'Include database statistics (connections, transactions)',
        default: false,
      },
      pattern: {
        type: 'string',
        description: 'Filter databases by name pattern (SQL LIKE pattern)',
      },
    },
  };

  constructor(
    private connectionManager: PostgresConnectionManager,
    private logger: StructuredLogger
  ) {
    this.logger.info('DatabaseCatalogTool initialized', {}, 'DatabaseCatalogTool');
  }

  async execute(args: DatabaseCatalogArgs, context?: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const { includeSystemDatabases = false, includeStatistics = false, pattern } = args;

    this.logger.debug(
      'Listing databases',
      {
        requestId: context?.requestId,
        traceId: context?.traceId,
        sessionId: context?.sessionId,
        includeSystemDatabases,
        includeStatistics,
        pattern,
      },
      'DatabaseCatalogTool'
    );

    try {
      // Build the main query
      let query = `
        SELECT 
          d.datname AS database,
          pg_size_pretty(pg_database_size(d.datname)) AS size,
          pg_database_size(d.datname) AS size_bytes,
          pg_catalog.pg_get_userbyid(d.datdba) AS owner,
          pg_catalog.obj_description(d.oid, 'pg_database') AS description,
          d.datistemplate AS is_template,
          d.datallowconn AS allow_connections,
          d.datconnlimit AS connection_limit,
          pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
          d.datcollate AS collation,
          d.datctype AS ctype,
          t.spcname AS tablespace,
          pg_catalog.array_to_string(d.datacl, E'\\n') AS access_privileges
        FROM pg_catalog.pg_database d
        JOIN pg_catalog.pg_tablespace t ON d.dattablespace = t.oid
        WHERE 1=1
      `;

      const params: unknown[] = [];

      // Add system database filter
      if (!includeSystemDatabases) {
        query += ` AND d.datname NOT IN ('postgres', 'template0', 'template1')`;
      }

      // Add pattern filter
      if (pattern) {
        query += ` AND d.datname LIKE $${params.length + 1}`;
        params.push(pattern);
      }

      query += ` ORDER BY d.datname`;

      // Execute the main query
      const result = await this.connectionManager.executeQuery(query, params);

      // Get statistics if requested
      let statistics: Record<string, Record<string, unknown>> = {};
      if (includeStatistics) {
        try {
          const statsResult = await this.connectionManager.executeQuery(`
            SELECT 
              datname,
              numbackends AS active_connections,
              xact_commit AS transactions_committed,
              xact_rollback AS transactions_rolled_back,
              blks_read AS blocks_read,
              blks_hit AS blocks_hit,
              tup_returned AS tuples_returned,
              tup_fetched AS tuples_fetched,
              tup_inserted AS tuples_inserted,
              tup_updated AS tuples_updated,
              tup_deleted AS tuples_deleted,
              conflicts,
              temp_files AS temp_files_created,
              pg_size_pretty(temp_bytes) AS temp_space_used,
              deadlocks,
              blk_read_time AS block_read_time_ms,
              blk_write_time AS block_write_time_ms,
              stats_reset
            FROM pg_stat_database
            WHERE datname IS NOT NULL
          `);

          // Convert to a map for easy lookup
          for (const stat of statsResult.rows) {
            statistics[stat.datname] = {
              activeConnections: parseInt(stat.active_connections || '0'),
              transactionsCommitted: parseInt(stat.transactions_committed || '0'),
              transactionsRolledBack: parseInt(stat.transactions_rolled_back || '0'),
              blocksRead: parseInt(stat.blocks_read || '0'),
              blocksHit: parseInt(stat.blocks_hit || '0'),
              cacheHitRatio:
                stat.blocks_hit > 0
                  ? (
                      (parseInt(stat.blocks_hit) /
                        (parseInt(stat.blocks_hit) + parseInt(stat.blocks_read))) *
                      100
                    ).toFixed(2) + '%'
                  : '0%',
              tuplesReturned: parseInt(stat.tuples_returned || '0'),
              tuplesFetched: parseInt(stat.tuples_fetched || '0'),
              tuplesInserted: parseInt(stat.tuples_inserted || '0'),
              tuplesUpdated: parseInt(stat.tuples_updated || '0'),
              tuplesDeleted: parseInt(stat.tuples_deleted || '0'),
              conflicts: parseInt(stat.conflicts || '0'),
              tempFilesCreated: parseInt(stat.temp_files_created || '0'),
              tempSpaceUsed: stat.temp_space_used,
              deadlocks: parseInt(stat.deadlocks || '0'),
              blockReadTimeMs: parseFloat(stat.block_read_time_ms || '0'),
              blockWriteTimeMs: parseFloat(stat.block_write_time_ms || '0'),
              statsResetAt: stat.stats_reset,
            };
          }
        } catch (err) {
          this.logger.warn(
            'Failed to get database statistics',
            {
              error: { message: err instanceof Error ? err.message : String(err) },
            },
            'DatabaseCatalogTool'
          );
        }
      }

      // Get current database info
      const currentDbResult = await this.connectionManager.executeQuery(
        'SELECT current_database() as current'
      );
      const currentDatabase = currentDbResult.rows[0].current;

      // Format the databases
      const databases: DatabaseInfo[] = result.rows.map((row) => ({
        database: row.database,
        size: row.size,
        sizeBytes: parseInt(row.size_bytes),
        owner: row.owner,
        encoding: row.encoding,
        collation: row.collation,
        ctype: row.ctype,
        description: row.description,
        isTemplate: row.is_template,
        allowConnections: row.allow_connections,
        connectionLimit: row.connection_limit === -1 ? 'unlimited' : row.connection_limit,
        tablespace: row.tablespace,
        accessPrivileges: row.access_privileges,
        isCurrent: row.database === currentDatabase,
        ...(includeStatistics &&
          statistics[row.database] && {
            statistics: statistics[row.database],
          }),
      }));

      const duration = Date.now() - startTime;

      // Get server version and other info
      const versionResult = await this.connectionManager.executeQuery('SELECT version()');
      const serverVersion = versionResult.rows[0].version;

      this.logger.info(
        'Databases listed successfully',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          duration,
          databaseCount: databases.length,
          currentDatabase,
        },
        'DatabaseCatalogTool'
      );

      // Format the response
      const responseData = {
        success: true,
        databaseCount: databases.length,
        currentDatabase,
        serverVersion,
        databases,
        metadata: {
          requestId: context?.requestId,
          traceId: context?.traceId || '',
          duration,
          includeSystemDatabases,
          includeStatistics,
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
          row_count: databases.length,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      this.logger.error(
        'Failed to list databases',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          duration,
          error: { message: error instanceof Error ? error.message : String(error) },
        },
        'DatabaseCatalogTool'
      );

      return {
        content: [
          {
            type: 'text',
            text: `Error listing databases: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        metadata: {
          duration_ms: duration,
          traceId: context?.traceId || '',
          error: {
            code: 'DATABASE_CATALOG_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }
}
