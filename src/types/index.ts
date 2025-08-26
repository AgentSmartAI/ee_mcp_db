/**
 * Shared type definitions used across the application.
 * Centralizes common types and interfaces.
 */

/**
 * Enhanced error type with additional context
 */
export interface MCPError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  query?: string;
  stack?: string;
}

/**
 * Tool execution context
 */
export interface ToolContext {
  requestId: string;
  traceId: string;
  sessionId?: string;
  startTime: number;
  userId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Tool execution result metadata
 */
export interface ToolResultMetadata {
  duration_ms: number;
  traceId: string;
  row_count?: number;
  error?: MCPError;
  query_count?: number;
  success_count?: number;
  table_name?: string;
  preparedStatement?: boolean;
  [key: string]: unknown; // Allow additional metadata properties with known types
}

/**
 * Tool execution result
 */
export interface ToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  metadata?: ToolResultMetadata;
}

/**
 * JSON Schema type for tool input validation
 */
export interface JSONSchema {
  type: string | string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/**
 * Base interface for all tools with generic type support
 */
export interface MCPTool<TArgs = unknown> {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute(args: TArgs, context?: ToolContext): Promise<ToolResult>;
}

/**
 * Database field information
 */
export interface FieldInfo {
  name: string;
  dataTypeID: number;
  dataType?: string;
  tableID?: number;
  columnID?: number;
  format?: string;
}

/**
 * Database query result with generic row type
 */
export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number | null;
  fields: FieldInfo[];
  executionTime?: number;
  command?: string;
  preparedStatement?: boolean;
}

/**
 * Table information
 */
export interface TableInfo {
  schema: string;
  table: string;
  owner?: string;
  size?: string;
  rowCount?: number;
}

/**
 * Column information
 */
export interface ColumnInfo {
  column_name: string;
  data_type: string;
  character_maximum_length?: number;
  is_nullable: string;
  column_default?: string;
  ordinal_position: number;
}

/**
 * Constraint information
 */
export interface ConstraintInfo {
  constraint_name: string;
  constraint_type: string;
  column_name: string;
  foreign_table_name?: string;
  foreign_column_name?: string;
}

/**
 * Database information
 */
export interface DatabaseInfo {
  database: string;
  size: string;
  encoding?: string;
  collation?: string;
}

/**
 * Health check status
 */
export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  checks: {
    database: {
      connected: boolean;
      latency_ms?: number;
      error?: string;
      poolStats?: {
        active: number;
        idle: number;
        waiting: number;
      };
    };
    server: {
      uptime_seconds: number;
      memory_usage_mb: number;
      memory_total_mb?: number;
      memory_rss_mb?: number;
      activeClients?: number;
    };
  };
}
