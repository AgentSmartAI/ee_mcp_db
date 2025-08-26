/**
 * Type definitions for database operations and results.
 * Ensures type safety throughout the application.
 */

/**
 * Query execution options
 */
export interface QueryOptions {
  timeout?: number;
  maxRows?: number;
  includeMetadata?: boolean;
}

/**
 * Connection health information
 */
export interface ConnectionHealth {
  connected: boolean;
  latency: number;
  poolSize: number;
  activeConnections: number;
  idleConnections: number;
  waitingConnections: number;
  lastError?: string;
  lastCheck: Date;
}

/**
 * Query validation result
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
  queryType?:
    | 'SELECT'
    | 'WITH'
    | 'SHOW'
    | 'EXPLAIN'
    | 'INSERT'
    | 'UPDATE'
    | 'DELETE'
    | 'CREATE'
    | 'ALTER'
    | 'DROP'
    | 'TRUNCATE'
    | 'BEGIN'
    | 'COMMIT'
    | 'ROLLBACK'
    | string;
  hasParameters: boolean;
  parameterCount: number;
}

/**
 * Forbidden SQL keywords that indicate write operations
 */
export const FORBIDDEN_SQL_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'COMMIT',
  'ROLLBACK',
  'BEGIN',
  'START',
  'TRANSACTION',
  'LOCK',
  'VACUUM',
  'ANALYZE',
  'COPY',
  'EXECUTE',
  'PREPARE',
  'DEALLOCATE',
  'LISTEN',
  'NOTIFY',
  'LOAD',
  'RESET',
  'SET',
];
