/**
 * Provides detailed information about table structure.
 * Includes columns, constraints, indexes, and relationships.
 */

import { PostgresConnectionManager } from '../database/PostgresConnectionManager.js';
import { StructuredLogger } from '../logging/StructuredLogger.js';
import { MCPTool, ToolResult, ToolContext, ColumnInfo, ConstraintInfo } from '../types/index.js';

export class TableInspectorTool implements MCPTool {
  name = 'describe_table';
  description = 'Get detailed information about a table including columns and constraints';

  inputSchema: any;
  private tableStatsCache: Map<string, { inboundCount: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    private connectionManager: PostgresConnectionManager,
    private logger: StructuredLogger,
    private defaultSchema: string = 'public'
  ) {
    this.inputSchema = {
      type: 'object',
      properties: {
        table: {
          type: 'string',
          description: 'Table name',
        },
        schema: {
          type: 'string',
          description: `Schema name (default: ${this.defaultSchema})`,
          default: this.defaultSchema,
        },
        includeIndexes: {
          type: 'boolean',
          description: 'Include index information',
          default: true,
        },
        includeConstraints: {
          type: 'boolean',
          description: 'Include constraint information',
          default: true,
        },
        includeRelationships: {
          type: 'boolean',
          description: 'Include foreign key relationships',
          default: true,
        },
        maxInboundRelationships: {
          type: 'number',
          description:
            'Maximum number of inbound relationships to return (tables referencing this one). 0 = unlimited',
          default: 25,
        },
        includeTriggers: {
          type: 'boolean',
          description: 'Include trigger information',
          default: false,
        },
      },
      required: ['table'],
    };

    this.logger.info(
      'TableInspectorTool initialized',
      { defaultSchema: this.defaultSchema },
      'TableInspectorTool'
    );
  }

  async execute(args: any, context?: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const {
      table,
      schema = this.defaultSchema,
      includeIndexes = true,
      includeConstraints = true,
      includeRelationships = true,
      maxInboundRelationships = 25,
      includeTriggers = false,
    } = args;

    this.logger.debug(
      'Inspecting table',
      {
        requestId: context?.requestId,
        traceId: context?.traceId,
        sessionId: context?.sessionId,
        table,
        schema,
        options: {
          includeIndexes,
          includeConstraints,
          includeRelationships,
          maxInboundRelationships,
          includeTriggers,
        },
      },
      'TableInspectorTool'
    );

    try {
      // Check if table exists and get relationship stats for smart caching
      const cacheKey = `${schema}.${table}`;
      const tableExistsResult = await this.connectionManager.executeQuery(
        `WITH table_check AS (
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables 
            WHERE table_schema = $1 AND table_name = $2
          ) as exists
        ),
        inbound_stats AS (
          SELECT COUNT(DISTINCT c.conname) as inbound_count
          FROM pg_constraint c
          JOIN pg_class cl ON cl.oid = c.confrelid
          JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE c.contype = 'f' 
            AND n.nspname = $1
            AND cl.relname = $2
        )
        SELECT 
          tc.exists,
          COALESCE(ibs.inbound_count, 0) as inbound_relationship_count
        FROM table_check tc
        CROSS JOIN inbound_stats ibs`,
        [schema, table]
      );

      const tableCheckResult = tableExistsResult.rows[0];
      if (!tableCheckResult.exists) {
        throw new Error(`Table "${schema}"."${table}" does not exist`);
      }

      // Update cache with inbound relationship count
      this.tableStatsCache.set(cacheKey, {
        inboundCount: parseInt(tableCheckResult.inbound_relationship_count),
        timestamp: Date.now(),
      });

      // Get basic table information
      const tableInfoResult = await this.connectionManager.executeQuery(
        `SELECT 
          obj_description(c.oid) as comment,
          pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
          pg_size_pretty(pg_relation_size(c.oid)) as table_size,
          pg_size_pretty(pg_indexes_size(c.oid)) as indexes_size,
          reltuples::bigint as estimated_row_count
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, table]
      );

      const tableInfo = tableInfoResult.rows[0] || {};

      // Get column information
      const columnsResult = await this.connectionManager.executeQuery(
        `SELECT 
          column_name,
          data_type,
          character_maximum_length,
          numeric_precision,
          numeric_scale,
          is_nullable,
          column_default,
          ordinal_position,
          udt_name,
          is_identity,
          identity_generation,
          col_description(pgc.oid, a.attnum) as comment
        FROM information_schema.columns
        LEFT JOIN pg_class pgc ON pgc.relname = table_name
        LEFT JOIN pg_namespace pgn ON pgn.nspname = table_schema AND pgc.relnamespace = pgn.oid
        LEFT JOIN pg_attribute a ON a.attrelid = pgc.oid AND a.attname = column_name
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position`,
        [schema, table]
      );

      const columns: ColumnInfo[] = columnsResult.rows.map((col) => ({
        column_name: col.column_name,
        data_type: col.data_type,
        character_maximum_length: col.character_maximum_length,
        numeric_precision: col.numeric_precision,
        numeric_scale: col.numeric_scale,
        is_nullable: col.is_nullable,
        column_default: col.column_default,
        ordinal_position: col.ordinal_position,
        udt_name: col.udt_name,
        is_identity: col.is_identity === 'YES',
        identity_generation: col.identity_generation,
        comment: col.comment,
      }));

      // Get constraints if requested
      let constraints: ConstraintInfo[] = [];
      if (includeConstraints) {
        const constraintsResult = await this.connectionManager.executeQuery(
          `SELECT 
            tc.constraint_name,
            tc.constraint_type,
            kcu.column_name,
            ccu.table_schema AS foreign_table_schema,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name,
            rc.update_rule,
            rc.delete_rule,
            con.condeferrable as is_deferrable,
            con.condeferred as initially_deferred,
            pg_get_constraintdef(con.oid) as definition
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          LEFT JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
          LEFT JOIN information_schema.referential_constraints rc
            ON rc.constraint_name = tc.constraint_name
            AND rc.constraint_schema = tc.table_schema
          LEFT JOIN pg_constraint con
            ON con.conname = tc.constraint_name
            AND con.connamespace = (SELECT oid FROM pg_namespace WHERE nspname = tc.table_schema)
          WHERE tc.table_schema = $1 AND tc.table_name = $2
          ORDER BY tc.constraint_type, tc.constraint_name, kcu.ordinal_position`,
          [schema, table]
        );

        constraints = constraintsResult.rows.map((con) => ({
          constraint_name: con.constraint_name,
          constraint_type: con.constraint_type,
          column_name: con.column_name,
          foreign_table_schema: con.foreign_table_schema,
          foreign_table_name: con.foreign_table_name,
          foreign_column_name: con.foreign_column_name,
          update_rule: con.update_rule,
          delete_rule: con.delete_rule,
          is_deferrable: con.is_deferrable,
          initially_deferred: con.initially_deferred,
          definition: con.definition,
        }));
      }

      // Get indexes if requested
      let indexes: any[] = [];
      if (includeIndexes) {
        const indexesResult = await this.connectionManager.executeQuery(
          `SELECT 
            i.relname as index_name,
            idx.indisprimary as is_primary,
            idx.indisunique as is_unique,
            idx.indisclustered as is_clustered,
            idx.indisvalid as is_valid,
            pg_get_indexdef(idx.indexrelid) as definition,
            pg_size_pretty(pg_relation_size(idx.indexrelid)) as size,
            tabstat.idx_scan as scan_count,
            tabstat.idx_tup_read as tuples_read,
            tabstat.idx_tup_fetch as tuples_fetched
          FROM pg_index idx
          JOIN pg_class i ON i.oid = idx.indexrelid
          JOIN pg_class t ON t.oid = idx.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          LEFT JOIN pg_stat_user_indexes tabstat ON tabstat.indexrelid = idx.indexrelid
          WHERE n.nspname = $1 AND t.relname = $2
          ORDER BY i.relname`,
          [schema, table]
        );

        indexes = indexesResult.rows;
      }

      // Get relationships if requested
      let relationships: any[] = [];
      let inboundTruncated = false;
      let totalInboundCount = 0;

      if (includeRelationships) {
        // Always include all outgoing foreign keys (this table references others)
        const outgoingFKResult = await this.connectionManager.executeQuery(
          `SELECT 
            conname as constraint_name,
            'REFERENCES' as relationship_type,
            confrelid::regclass as related_table,
            array_agg(a.attname ORDER BY conkey_idx) as local_columns,
            array_agg(af.attname ORDER BY conkey_idx) as foreign_columns
          FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          JOIN pg_class cl ON cl.oid = c.conrelid
          CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS conkey(attnum, conkey_idx)
          CROSS JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS confkey(attnum, confkey_idx)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = conkey.attnum
          JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = confkey.attnum
          WHERE c.contype = 'f' 
            AND n.nspname = $1 
            AND cl.relname = $2
            AND conkey_idx = confkey_idx
          GROUP BY conname, confrelid
          ORDER BY confrelid::regclass::text`,
          [schema, table]
        );

        relationships.push(...outgoingFKResult.rows);

        // Get cached stats to determine if we should limit inbound relationships
        const cachedStats = this.tableStatsCache.get(cacheKey);
        const shouldLimitInbound =
          cachedStats &&
          cachedStats.inboundCount > maxInboundRelationships &&
          maxInboundRelationships > 0;

        totalInboundCount = cachedStats?.inboundCount || 0;

        // Incoming foreign keys (other tables reference this one)
        const incomingQuery = `
          SELECT 
            conname as constraint_name,
            'REFERENCED BY' as relationship_type,
            conrelid::regclass as related_table,
            array_agg(a.attname ORDER BY conkey_idx) as foreign_columns,
            array_agg(af.attname ORDER BY confkey_idx) as local_columns
          FROM pg_constraint c
          JOIN pg_class cl ON cl.oid = c.confrelid
          JOIN pg_namespace n ON n.oid = cl.relnamespace
          CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS conkey(attnum, conkey_idx)
          CROSS JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS confkey(attnum, confkey_idx)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = conkey.attnum
          JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = confkey.attnum
          WHERE c.contype = 'f' 
            AND n.nspname = $1
            AND cl.relname = $2
            AND conkey_idx = confkey_idx
          GROUP BY conname, conrelid
          ORDER BY conrelid::regclass::text`;

        const incomingFKResult = await this.connectionManager.executeQuery(
          shouldLimitInbound ? `${incomingQuery} LIMIT ${maxInboundRelationships}` : incomingQuery,
          [schema, table]
        );

        if (shouldLimitInbound) {
          inboundTruncated = true;
        }

        relationships.push(...incomingFKResult.rows);
      }

      // Get triggers if requested
      let triggers: any[] = [];
      if (includeTriggers) {
        const triggersResult = await this.connectionManager.executeQuery(
          `SELECT 
            tgname as trigger_name,
            tgtype,
            proname as function_name,
            tgenabled as is_enabled,
            pg_get_triggerdef(t.oid) as definition
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE n.nspname = $1 
            AND c.relname = $2
            AND NOT t.tgisinternal
          ORDER BY tgname`,
          [schema, table]
        );

        triggers = triggersResult.rows;
      }

      const duration = Date.now() - startTime;

      this.logger.info(
        'Table inspected successfully',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          duration,
          table: `${schema}.${table}`,
          columnCount: columns.length,
          constraintCount: constraints.length,
          indexCount: indexes.length,
        },
        'TableInspectorTool'
      );

      // Format the response
      const responseData = {
        success: true,
        schema,
        table,
        tableInfo: {
          comment: tableInfo.comment,
          totalSize: tableInfo.total_size,
          tableSize: tableInfo.table_size,
          indexesSize: tableInfo.indexes_size,
          estimatedRowCount: parseInt(tableInfo.estimated_row_count || '0'),
        },
        columns,
        ...(includeConstraints && { constraints }),
        ...(includeIndexes && { indexes }),
        ...(includeRelationships && {
          relationships,
          ...(inboundTruncated && {
            relationshipSummary: {
              outbound: relationships.filter((r) => r.relationship_type === 'REFERENCES').length,
              inbound: {
                shown: relationships.filter((r) => r.relationship_type === 'REFERENCED BY').length,
                total: totalInboundCount,
                truncated: true,
                note: `Showing first ${maxInboundRelationships} of ${totalInboundCount} inbound relationships. Use maxInboundRelationships parameter to see more.`,
              },
            },
          }),
        }),
        ...(includeTriggers && { triggers }),
        metadata: {
          requestId: context?.requestId,
          traceId: context?.traceId || '',
          duration,
          columnCount: columns.length,
          constraintCount: constraints.length,
          indexCount: indexes.length,
          relationshipCount: relationships.length,
          triggerCount: triggers.length,
        },
      };

      const responseText = JSON.stringify(responseData, null, 2);
      const responseSizeKB = Buffer.byteLength(responseText, 'utf8') / 1024;

      this.logger.debug(
        'Tool response size',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          sizeKB: responseSizeKB.toFixed(2),
          relationshipCount: relationships.length,
          table: `${schema}.${table}`,
        },
        'TableInspectorTool'
      );

      // Warn if response is very large
      if (responseSizeKB > 500) {
        this.logger.warn(
          'Large response detected',
          {
            requestId: context?.requestId,
            traceId: context?.traceId,
            sessionId: context?.sessionId,
            sizeKB: responseSizeKB.toFixed(2),
            relationshipCount: relationships.length,
            table: `${schema}.${table}`,
            suggestion: 'Consider using maxInboundRelationships parameter to limit response size',
          },
          'TableInspectorTool'
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
        metadata: {
          duration_ms: duration,
          traceId: context?.traceId || '',
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);

      this.logger.error(
        'Failed to inspect table',
        {
          requestId: context?.requestId,
          traceId: context?.traceId,
          sessionId: context?.sessionId,
          duration,
          error: {
            message: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
          },
          errorRaw: error,
          table: `${schema}.${table}`,
        },
        'TableInspectorTool'
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: 'Failed to inspect table',
                message: errorMessage,
                table: `${schema}.${table}`,
                schema: schema,
              },
              null,
              2
            ),
          },
        ],
        metadata: {
          duration_ms: duration,
          traceId: context?.traceId || '',
          error: {
            code: 'TABLE_INSPECTOR_ERROR',
            message: errorMessage,
            details: { schema, table },
          },
        },
      };
    }
  }
}
