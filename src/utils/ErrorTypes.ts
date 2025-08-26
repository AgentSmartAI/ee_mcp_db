/**
 * Type-safe error handling utilities
 */

// PostgreSQL error interface
export interface PostgresError extends Error {
  code: string;
  detail?: string;
  hint?: string;
  position?: string;
  internalPosition?: string;
  internalQuery?: string;
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
  file?: string;
  line?: string;
  routine?: string;
}

// Node.js error with code
export interface NodeError extends Error {
  code: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

// MCP Error with enhanced context
export interface MCPError {
  code: string;
  message: string;
  query?: string;
  details?: Record<string, unknown>;
  stack?: string;
}

// Type guards
export function isPostgresError(error: unknown): error is PostgresError {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as any).code === 'string' &&
    (error as any).code.length === 5 // PostgreSQL error codes are 5 characters
  );
}

export function isNodeError(error: unknown): error is NodeError {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as any).code === 'string' &&
    (error as any).code.length !== 5 // Not a PostgreSQL error code
  );
}

export function isMCPError(error: unknown): error is MCPError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as any).code === 'string' &&
    typeof (error as any).message === 'string'
  );
}

// Error code constants
export const PostgresErrorCodes = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
  UNDEFINED_TABLE: '42P01',
  UNDEFINED_COLUMN: '42703',
  SYNTAX_ERROR: '42601',
  INSUFFICIENT_PRIVILEGE: '42501',
  QUERY_CANCELED: '57014',
  ADMIN_SHUTDOWN: '57P01',
  CRASH_SHUTDOWN: '57P02',
  CANNOT_CONNECT_NOW: '57P03',
  DATABASE_DROPPED: '57P04',
} as const;

export const NodeErrorCodes = {
  ECONNREFUSED: 'ECONNREFUSED',
  ENOTFOUND: 'ENOTFOUND',
  ETIMEDOUT: 'ETIMEDOUT',
  ECONNRESET: 'ECONNRESET',
  EPIPE: 'EPIPE',
  ENOENT: 'ENOENT',
  EACCES: 'EACCES',
  EISDIR: 'EISDIR',
} as const;

// Error enhancement functions
export function enhanceError(
  error: unknown,
  context: {
    operation: string;
    query?: string;
    params?: unknown[];
    [key: string]: unknown;
  }
): MCPError {
  if (isMCPError(error)) {
    return {
      ...error,
      details: { ...error.details, ...context },
    };
  }

  if (isPostgresError(error)) {
    return {
      code: error.code,
      message: error.message,
      query: context.query,
      details: {
        ...context,
        detail: error.detail,
        hint: error.hint,
        position: error.position,
        constraint: error.constraint,
        table: error.table,
        column: error.column,
      },
      stack: error.stack,
    };
  }

  if (isNodeError(error)) {
    return {
      code: error.code,
      message: error.message,
      details: {
        ...context,
        errno: error.errno,
        syscall: error.syscall,
        path: error.path,
      },
      stack: error.stack,
    };
  }

  if (error instanceof Error) {
    return {
      code: 'UNKNOWN_ERROR',
      message: error.message,
      details: context,
      stack: error.stack,
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: String(error),
    details: context,
  };
}

// Error message helpers
export function getErrorSuggestion(error: MCPError): string | undefined {
  switch (error.code) {
    case PostgresErrorCodes.UNIQUE_VIOLATION:
      return `Duplicate value violates unique constraint. Consider using ON CONFLICT clause or checking for existence first.`;

    case PostgresErrorCodes.FOREIGN_KEY_VIOLATION:
      return `Referenced record does not exist. Ensure parent record exists before inserting child record.`;

    case PostgresErrorCodes.UNDEFINED_TABLE:
      return `Table does not exist. Check table name and schema, or use list_tables tool to see available tables.`;

    case PostgresErrorCodes.SYNTAX_ERROR:
      return `SQL syntax error. Check query syntax, quotes, and keywords.`;

    case NodeErrorCodes.ECONNREFUSED:
      return `Database connection refused. Check if PostgreSQL is running and connection settings are correct.`;

    case NodeErrorCodes.ETIMEDOUT:
      return `Connection timeout. Check network connectivity and database server status.`;

    default:
      return undefined;
  }
}
