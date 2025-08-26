/**
 * Validates SQL queries to ensure read-only access.
 * Uses whitelist approach for allowed SQL operations.
 */

import { StructuredLogger } from '../logging/StructuredLogger.js';
import { MCPError } from '../types/index.js';

import { ValidationResult, FORBIDDEN_SQL_KEYWORDS } from './types/QueryTypes.js';

export class QueryValidator {
  private logger?: StructuredLogger;
  private allowWriteOperations: boolean;

  // Additional patterns to check for malicious queries
  private dangerousPatterns = [
    /;\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)/i,
    /\b(EXEC|EXECUTE)\s+/i,
    /\bINTO\s+OUTFILE\b/i,
    /\bLOAD_FILE\s*\(/i,
    /\b(xp_|sp_)/i, // SQL Server stored procedures
  ];

  constructor(logger?: StructuredLogger, allowWriteOperations: boolean = false) {
    this.logger = logger;
    this.allowWriteOperations = allowWriteOperations;
  }

  /**
   * Validate a SQL query for safety
   */
  validate(sql: string, params?: any[]): ValidationResult {
    const validationId = `val_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    this.logger?.trace(
      'Starting query validation',
      {
        validationId,
        queryLength: sql?.length || 0,
        hasParams: !!params,
        paramCount: params?.length || 0,
      },
      'QueryValidator'
    );

    const result: ValidationResult = {
      valid: true,
      hasParameters: !!params && params.length > 0,
      parameterCount: params?.length || 0,
    };

    try {
      // Basic validation
      if (!sql || typeof sql !== 'string') {
        throw new Error('Query must be a non-empty string');
      }

      const trimmedSql = sql.trim();
      if (!trimmedSql) {
        throw new Error('Query cannot be empty');
      }

      this.logger?.trace(
        'Removing comments from query',
        {
          validationId,
          originalLength: trimmedSql.length,
        },
        'QueryValidator'
      );

      // Remove comments for analysis (but keep original for execution)
      const sqlWithoutComments = this.removeComments(trimmedSql);

      this.logger?.trace(
        'Comments removed',
        {
          validationId,
          cleanedLength: sqlWithoutComments.length,
          lengthDiff: trimmedSql.length - sqlWithoutComments.length,
        },
        'QueryValidator'
      );

      // Check query type
      const queryType = this.getQueryType(sqlWithoutComments);
      if (!queryType) {
        if (this.allowWriteOperations) {
          throw new Error('Query must start with a valid SQL operation');
        } else {
          throw new Error('Query must start with SELECT, WITH, SHOW, or EXPLAIN');
        }
      }
      result.queryType = queryType;

      this.logger?.debug(
        'Query type identified',
        {
          validationId,
          queryType,
        },
        'QueryValidator'
      );

      // Check for forbidden keywords
      this.logger?.trace('Checking for forbidden keywords', { validationId }, 'QueryValidator');
      this.checkForbiddenKeywords(sqlWithoutComments);

      // Check for dangerous patterns
      this.logger?.trace('Checking for dangerous patterns', { validationId }, 'QueryValidator');
      this.checkDangerousPatterns(sqlWithoutComments);

      // Validate parameters if provided
      if (params) {
        this.logger?.trace(
          'Validating parameters',
          {
            validationId,
            paramCount: params.length,
          },
          'QueryValidator'
        );
        this.validateParameters(params);
      }

      // Multiple statement check removed - allowing complex SQL like CREATE FUNCTION

      this.logger?.debug(
        'Query validated successfully',
        {
          validationId,
          queryType,
          hasParameters: result.hasParameters,
          parameterCount: result.parameterCount,
          queryPreview: sql.substring(0, 50),
        },
        'QueryValidator'
      );

      return result;
    } catch (error) {
      result.valid = false;
      result.error = error instanceof Error ? error.message : String(error);

      this.logger?.debug(
        'Query validation failed',
        {
          validationId,
          error: {
            message: result.error,
            code: error instanceof Error ? error.name : 'Unknown',
          },
          query: sql?.substring(0, 100) || 'N/A',
          queryType: result.queryType || 'Unknown',
        },
        'QueryValidator'
      );

      return result;
    }
  }

  /**
   * Remove SQL comments for analysis
   */
  private removeComments(sql: string): string {
    // Remove single-line comments
    sql = sql.replace(/--.*$/gm, '');

    // Remove multi-line comments
    sql = sql.replace(/\/\*[\s\S]*?\*\//g, '');

    return sql.trim();
  }

  /**
   * Determine the query type
   */
  private getQueryType(sql: string): string | null {
    const upperSql = sql.toUpperCase();

    // Read-only operations
    if (upperSql.startsWith('SELECT')) return 'SELECT';
    if (upperSql.startsWith('WITH')) return 'WITH';
    if (upperSql.startsWith('SHOW')) return 'SHOW';
    if (upperSql.startsWith('EXPLAIN')) return 'EXPLAIN';

    // Write operations (only if allowed)
    if (this.allowWriteOperations) {
      if (upperSql.startsWith('INSERT')) return 'INSERT';
      if (upperSql.startsWith('UPDATE')) return 'UPDATE';
      if (upperSql.startsWith('DELETE')) return 'DELETE';
      if (upperSql.startsWith('CREATE')) return 'CREATE';
      if (upperSql.startsWith('ALTER')) return 'ALTER';
      if (upperSql.startsWith('DROP')) return 'DROP';
      if (upperSql.startsWith('TRUNCATE')) return 'TRUNCATE';
      if (upperSql.startsWith('BEGIN')) return 'BEGIN';
      if (upperSql.startsWith('COMMIT')) return 'COMMIT';
      if (upperSql.startsWith('ROLLBACK')) return 'ROLLBACK';
      if (upperSql.startsWith('COMMENT')) return 'COMMENT';
    }

    return null;
  }

  /**
   * Check for forbidden SQL keywords
   */
  private checkForbiddenKeywords(sql: string): void {
    // Skip check if write operations are allowed
    if (this.allowWriteOperations) {
      this.logger?.trace(
        'Write operations allowed, skipping forbidden keyword check',
        {},
        'QueryValidator'
      );
      return;
    }

    const upperSql = sql.toUpperCase();

    for (const keyword of FORBIDDEN_SQL_KEYWORDS) {
      // Use word boundary to avoid false positives (e.g., "UPDATED_AT" column)
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(sql)) {
        this.logger?.warn(
          'Forbidden keyword detected',
          {
            keyword,
            context: this.getKeywordContext(sql, keyword),
          },
          'QueryValidator'
        );
        throw new Error(`${keyword} operations are not allowed in read-only mode`);
      }
    }
  }

  /**
   * Get context around a keyword for logging
   */
  private getKeywordContext(sql: string, keyword: string): string {
    const index = sql.toUpperCase().indexOf(keyword.toUpperCase());
    if (index === -1) return '';

    const start = Math.max(0, index - 20);
    const end = Math.min(sql.length, index + keyword.length + 20);
    return sql.substring(start, end);
  }

  /**
   * Check for dangerous patterns
   */
  private checkDangerousPatterns(sql: string): void {
    // Skip dangerous pattern checks entirely when write operations are allowed
    if (this.allowWriteOperations) {
      this.logger?.debug(
        'Skipping dangerous pattern checks due to enableWriteOperations=true',
        {},
        'QueryValidator'
      );
      return;
    }

    for (const pattern of this.dangerousPatterns) {
      if (pattern.test(sql)) {
        const match = sql.match(pattern);
        this.logger?.warn(
          'Dangerous pattern detected',
          {
            pattern: pattern.toString(),
            match: match?.[0] || 'N/A',
            context: match ? this.getPatternContext(sql, match.index || 0) : 'N/A',
          },
          'QueryValidator'
        );
        throw new Error('Query contains potentially dangerous patterns');
      }
    }
  }

  /**
   * Get context around a pattern match for logging
   */
  private getPatternContext(sql: string, index: number): string {
    const start = Math.max(0, index - 30);
    const end = Math.min(sql.length, index + 50);
    return sql.substring(start, end);
  }

  /**
   * Validate query parameters
   */
  validateParameters(params: any[]): void {
    if (!Array.isArray(params)) {
      this.logger?.error(
        'Parameters validation failed - not an array',
        {
          providedType: typeof params,
          value: JSON.stringify(params).substring(0, 100),
        },
        'QueryValidator'
      );
      throw new Error('Parameters must be an array');
    }

    this.logger?.trace(
      'Validating parameter types',
      {
        count: params.length,
      },
      'QueryValidator'
    );

    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      const type = typeof param;

      // Allow: string, number, boolean, null, Date, Buffer
      if (
        param !== null &&
        type !== 'string' &&
        type !== 'number' &&
        type !== 'boolean' &&
        !(param instanceof Date) &&
        !(param instanceof Buffer)
      ) {
        this.logger?.warn(
          'Invalid parameter type detected',
          {
            index: i,
            type,
            isDate: param instanceof Date,
            isBuffer: param instanceof Buffer,
            constructor: param?.constructor?.name,
            value: JSON.stringify(param).substring(0, 50),
          },
          'QueryValidator'
        );

        throw new Error(
          `Invalid parameter type at index ${i}: ${type}. Only string, number, boolean, null, Date, and Buffer are allowed`
        );
      }
    }

    this.logger?.trace(
      'All parameters validated',
      {
        types: params.map((p) =>
          p === null
            ? 'null'
            : p instanceof Date
              ? 'Date'
              : p instanceof Buffer
                ? 'Buffer'
                : typeof p
        ),
      },
      'QueryValidator'
    );
  }

  /**
   * Sanitize error messages to avoid leaking sensitive information
   */
  sanitizeError(error: Error | MCPError): MCPError {
    const sanitized: MCPError = {
      code: 'VALIDATION_ERROR',
      message: 'Query validation failed',
    };

    // Only include safe error messages
    if (error instanceof Error) {
      if (error.message.includes('not allowed')) {
        sanitized.message = error.message;
      } else if (error.message.includes('must start with')) {
        sanitized.message = error.message;
      }
    }

    return sanitized;
  }
}
