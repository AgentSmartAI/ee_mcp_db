/**
 * Manages PostgreSQL connection pooling and lifecycle.
 * Handles connection failures, retries, and health monitoring.
 */

import { Pool, PoolConfig, PoolClient } from 'pg';

import { DatabaseConfig } from '../config/DatabaseConfig.js';
import { StructuredLogger } from '../logging/StructuredLogger.js';
import { MCPError } from '../types/index.js';
import { enhanceError } from '../utils/ErrorTypes.js';

import { PreparedStatementCache } from './PreparedStatementCache.js';
import { ConnectionHealth } from './types/QueryTypes.js';

// Type for Pool stats
interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

// Type for Client with processID
interface ClientWithProcessId extends PoolClient {
  processID?: string;
}

export class PostgresConnectionManager {
  private pool: Pool | null = null;
  private config: PoolConfig;
  private logger: StructuredLogger;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private lastHealthCheck: ConnectionHealth | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 5000; // 5 seconds
  private preparedStatementCache: PreparedStatementCache;
  private usePreparedStatements: boolean = true;

  constructor(dbConfig: DatabaseConfig, logger: StructuredLogger) {
    this.logger = logger;

    this.logger.trace(
      'Building pool configuration',
      {
        hasSSL: !!dbConfig.ssl,
        hasPoolConfig: !!dbConfig.poolConfig,
      },
      'PostgresConnectionManager'
    );

    // Build pool configuration
    this.config = {
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      user: dbConfig.user,
      password: dbConfig.password,
      ssl: dbConfig.ssl,
      max: dbConfig.poolConfig?.max || 20,
      idleTimeoutMillis: dbConfig.poolConfig?.idleTimeoutMillis || 60000, // Increased to 60 seconds
      connectionTimeoutMillis: dbConfig.poolConfig?.connectionTimeoutMillis || 5000, // Increased to 5 seconds
      application_name: 'ee-tools-mcp-server',
      // Set search_path to include the documents schema by default
      options: `-c search_path=${dbConfig.schema},public`,
      // Enable TCP keepalive to detect dead connections
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000, // Start keepalive probes after 10 seconds
    };

    // Initialize prepared statement cache
    this.preparedStatementCache = new PreparedStatementCache(logger, {
      maxSize: 100,
      ttlSeconds: 3600,
      enableMetrics: true,
    });

    // Use prepared statements from config
    this.usePreparedStatements = dbConfig.usePreparedStatements !== false;

    // Note: pg pool doesn't support error handler in config, will use event listeners

    this.logger.info(
      'PostgresConnectionManager initialized',
      {
        host: dbConfig.host,
        port: dbConfig.port,
        database: dbConfig.database,
        poolSize: this.config.max,
        idleTimeout: this.config.idleTimeoutMillis,
        connectionTimeout: this.config.connectionTimeoutMillis,
        usePreparedStatements: this.usePreparedStatements,
        ssl: dbConfig.ssl
          ? {
              enabled: true,
              rejectUnauthorized:
                typeof dbConfig.ssl === 'object' ? dbConfig.ssl.rejectUnauthorized : true,
            }
          : undefined,
      },
      'PostgresConnectionManager'
    );
  }

  /**
   * Get or create the connection pool
   */
  async getPool(): Promise<Pool> {
    if (!this.pool) {
      this.logger.debug('No pool exists, creating new pool', {}, 'PostgresConnectionManager');
      await this.createPool();
    } else {
      this.logger.trace(
        'Returning existing pool',
        {
          totalCount: this.pool.totalCount,
          idleCount: this.pool.idleCount,
          waitingCount: this.pool.waitingCount,
        },
        'PostgresConnectionManager'
      );
    }
    return this.pool!;
  }

  /**
   * Create a new connection pool
   */
  private async createPool(): Promise<void> {
    const createStart = Date.now();

    this.logger.debug(
      'Creating connection pool',
      {
        attempt: this.reconnectAttempts + 1,
        maxAttempts: this.maxReconnectAttempts,
      },
      'PostgresConnectionManager'
    );

    try {
      this.pool = new Pool(this.config);

      // Set up event handlers
      this.pool.on('error', (err) => {
        this.logger.error(
          'Pool error',
          {
            error: {
              message: err.message,
              code: 'code' in err ? (err as Error & { code: string }).code : undefined,
              stack: err.stack,
            },
            poolStats: {
              totalCount: this.pool?.totalCount,
              idleCount: this.pool?.idleCount,
              waitingCount: this.pool?.waitingCount,
            },
          },
          'PostgresConnectionManager'
        );
        this.handlePoolError();
      });

      this.pool.on('connect', (client) => {
        this.logger.debug(
          'New client connected to pool',
          {
            processId: (client as ClientWithProcessId).processID,
            poolStats: {
              totalCount: this.pool?.totalCount,
              idleCount: this.pool?.idleCount,
              waitingCount: this.pool?.waitingCount,
            },
          },
          'PostgresConnectionManager'
        );
        this.reconnectAttempts = 0; // Reset on successful connection
      });

      this.pool.on('remove', () => {
        this.logger.trace(
          'Client removed from pool',
          {
            poolStats: {
              totalCount: this.pool?.totalCount,
              idleCount: this.pool?.idleCount,
              waitingCount: this.pool?.waitingCount,
            },
          },
          'PostgresConnectionManager'
        );
      });

      // Test the connection
      await this.testConnection();

      const createDuration = Date.now() - createStart;

      this.logger.info(
        'Connection pool created successfully',
        {
          poolSize: this.config.max,
          createDuration,
          poolStats: {
            totalCount: this.pool?.totalCount,
            idleCount: this.pool?.idleCount,
            waitingCount: this.pool?.waitingCount,
          },
        },
        'PostgresConnectionManager'
      );

      // Start health monitoring
      this.startHealthMonitoring();
    } catch (error) {
      const createDuration = Date.now() - createStart;
      this.pool = null;

      const errorDetails =
        error instanceof Error
          ? {
              message: error.message,
              code: 'code' in error ? (error as Error & { code: string }).code : undefined,
              stack: error.stack,
            }
          : { message: String(error) };

      const mcpError: MCPError = {
        code: 'CONNECTION_FAILED',
        message: `Failed to connect to PostgreSQL: ${error instanceof Error ? error.message : String(error)}`,
        details: {
          host: this.config.host,
          port: this.config.port,
          database: this.config.database,
          createDuration,
          attemptNumber: this.reconnectAttempts + 1,
        },
      };

      this.logger.error(
        'Failed to create connection pool',
        {
          error: errorDetails,
          createDuration,
          attemptNumber: this.reconnectAttempts + 1,
        },
        'PostgresConnectionManager'
      );

      // Attempt reconnection
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.logger.info(
          `Scheduling reconnection attempt`,
          {
            nextAttempt: this.reconnectAttempts,
            maxAttempts: this.maxReconnectAttempts,
            delayMs: this.reconnectDelay,
          },
          'PostgresConnectionManager'
        );
        setTimeout(() => this.createPool(), this.reconnectDelay);
      } else {
        this.logger.error(
          'Maximum reconnection attempts reached',
          {
            attempts: this.reconnectAttempts,
            maxAttempts: this.maxReconnectAttempts,
          },
          'PostgresConnectionManager'
        );
      }

      // Create a proper Error instance with the MCPError properties
      const errorMessage =
        mcpError.message || (error instanceof Error ? error.message : String(error));
      const errorToThrow = new Error(errorMessage);
      // Assign all MCPError properties except message (to avoid overwriting)
      const { message, ...mcpErrorProps } = mcpError;
      Object.assign(errorToThrow, mcpErrorProps);
      throw errorToThrow;
    }
  }

  /**
   * Test database connection
   */
  private async testConnection(): Promise<void> {
    const start = Date.now();

    this.logger.trace('Running connection test query', {}, 'PostgresConnectionManager');

    try {
      const result = await this.pool!.query(
        'SELECT 1 as test, version() as version, current_database() as database'
      );
      const latency = Date.now() - start;

      if (result.rows[0].test !== 1) {
        throw new Error('Connection test query returned unexpected result');
      }

      this.logger.debug(
        'Connection test successful',
        {
          latency,
          version: result.rows[0].version,
          database: result.rows[0].database,
        },
        'PostgresConnectionManager'
      );
    } catch (error) {
      const latency = Date.now() - start;
      this.logger.error(
        'Connection test failed',
        {
          latency,
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  code: 'code' in error ? (error as Error & { code: string }).code : undefined,
                }
              : { message: String(error) },
        },
        'PostgresConnectionManager'
      );

      throw new Error(
        `Connection test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handle pool errors and attempt recovery
   */
  private async handlePoolError(): Promise<void> {
    this.logger.warn(
      'Handling pool error, attempting recovery',
      {
        currentPoolExists: !!this.pool,
        reconnectAttempts: this.reconnectAttempts,
      },
      'PostgresConnectionManager'
    );

    // Close the existing pool
    if (this.pool) {
      try {
        this.logger.debug(
          'Closing failed pool',
          {
            poolStats: {
              totalCount: this.pool?.totalCount,
              idleCount: this.pool?.idleCount,
              waitingCount: this.pool?.waitingCount,
            },
          },
          'PostgresConnectionManager'
        );

        await this.pool.end();
        this.logger.debug('Failed pool closed successfully', {}, 'PostgresConnectionManager');
      } catch (err) {
        this.logger.error(
          'Error closing pool during recovery',
          {
            error:
              err instanceof Error
                ? {
                    message: err.message,
                    code: 'code' in err ? (err as Error & { code: string }).code : undefined,
                  }
                : { message: String(err) },
          },
          'PostgresConnectionManager'
        );
      }
      this.pool = null;
    }

    // Attempt to recreate the pool
    try {
      this.logger.debug('Attempting to recreate pool', {}, 'PostgresConnectionManager');
      await this.createPool();
      this.logger.info('Pool recovery successful', {}, 'PostgresConnectionManager');
    } catch (error) {
      this.logger.error(
        'Failed to recover connection pool',
        {
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  code: 'code' in error ? (error as Error & { code: string }).code : undefined,
                }
              : { message: String(error) },
        },
        'PostgresConnectionManager'
      );
    }
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      this.logger.trace('Health monitoring already started', {}, 'PostgresConnectionManager');
      return;
    }

    this.logger.debug(
      'Starting health monitoring',
      {
        interval: 30000,
      },
      'PostgresConnectionManager'
    );

    // Run health check every 30 seconds
    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await this.checkHealth();

        if (!health.connected && this.lastHealthCheck?.connected) {
          this.logger.warn(
            'Database connection lost',
            {
              lastError: health.lastError,
            },
            'PostgresConnectionManager'
          );
        } else if (health.connected && !this.lastHealthCheck?.connected) {
          this.logger.info(
            'Database connection restored',
            {
              latency: health.latency,
            },
            'PostgresConnectionManager'
          );
        }
      } catch (error) {
        this.logger.error(
          'Health check failed',
          {
            error:
              error instanceof Error
                ? {
                    message: error.message,
                    stack: error.stack,
                  }
                : { message: String(error) },
          },
          'PostgresConnectionManager'
        );
      }
    }, 30000);

    // Run initial health check
    this.checkHealth().catch((err) => {
      this.logger.error(
        'Initial health check failed',
        {
          error:
            err instanceof Error
              ? {
                  message: err.message,
                  stack: err.stack,
                }
              : { message: String(err) },
        },
        'PostgresConnectionManager'
      );
    });
  }

  /**
   * Check connection health
   */
  async checkHealth(): Promise<ConnectionHealth> {
    const health: ConnectionHealth = {
      connected: false,
      latency: -1,
      poolSize: this.config.max || 10,
      activeConnections: 0,
      idleConnections: 0,
      waitingConnections: 0,
      lastCheck: new Date(),
    };

    if (!this.pool) {
      health.lastError = 'No connection pool';
      this.lastHealthCheck = health;
      return health;
    }

    try {
      // Test query latency
      const start = Date.now();
      await this.pool.query('SELECT 1');
      health.latency = Date.now() - start;
      health.connected = true;

      // Get pool statistics
      const poolStats = this.pool as Pool & PoolStats;
      health.activeConnections = poolStats.totalCount || 0;
      health.idleConnections = poolStats.idleCount || 0;
      health.waitingConnections = poolStats.waitingCount || 0;

      this.logger.trace('Health check completed', health, 'PostgresConnectionManager');
    } catch (error) {
      health.connected = false;
      health.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        'Health check failed',
        { error: { message: health.lastError } },
        'PostgresConnectionManager'
      );
    }

    this.lastHealthCheck = health;
    return health;
  }

  /**
   * Get last health check result
   */
  getLastHealthCheck(): ConnectionHealth | null {
    return this.lastHealthCheck;
  }

  /**
   * Execute a query with prepared statement support
   */
  async executeQueryWithPreparedStatement(
    sql: string,
    params?: any[],
    timeoutMs?: number
  ): Promise<{
    rows: any[];
    rowCount: number;
    command: string;
    oid: number;
    fields: any[];
    executionTime: number;
    preparedStatement?: boolean;
  }> {
    const queryId = `query_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const queryStartTime = Date.now();

    // Check if we should use prepared statements
    if (!this.usePreparedStatements || !params || params.length === 0) {
      return this.executeQuery(sql, params, timeoutMs);
    }

    const pool = await this.getPool();
    const client = await pool.connect();

    try {
      // Set statement timeout if provided
      if (timeoutMs) {
        await client.query(`SET statement_timeout = ${timeoutMs}`);
      }

      // Get or create prepared statement
      const preparedStatement = this.preparedStatementCache.getOrCreate(sql, params.length);

      this.logger.trace(
        'Using prepared statement',
        {
          queryId,
          statementName: preparedStatement.name,
          useCount: preparedStatement.useCount,
          cacheMetrics: this.preparedStatementCache.getMetrics(),
        },
        'PostgresConnectionManager'
      );

      // Prepare the statement if it's new
      if (preparedStatement.useCount === 1) {
        await client.query({
          name: preparedStatement.name,
          text: sql,
          values: params,
        });

        this.logger.debug(
          'Prepared new statement',
          {
            queryId,
            statementName: preparedStatement.name,
          },
          'PostgresConnectionManager'
        );
      }

      // Execute the prepared statement
      const start = Date.now();
      const result = await client.query({
        text: sql,
        name: preparedStatement.name,
        values: params,
      });
      const executionTime = Date.now() - start;

      this.logger.debug(
        'Prepared statement executed successfully',
        {
          queryId,
          executionTime,
          rowCount: result.rowCount,
          statementName: preparedStatement.name,
          useCount: preparedStatement.useCount,
        },
        'PostgresConnectionManager'
      );

      return {
        ...result,
        rowCount: result.rowCount ?? 0,
        executionTime,
        preparedStatement: true,
      };
    } catch (error) {
      // If prepared statement fails, try regular query
      if (error instanceof Error && error.message.includes('prepared statement')) {
        this.logger.warn(
          'Prepared statement failed, falling back to regular query',
          {
            queryId,
            error: { message: error.message },
          },
          'PostgresConnectionManager'
        );

        // Remove from cache
        this.preparedStatementCache.remove(sql, params?.length || 0);

        // Fallback to regular query
        return this.executeQuery(sql, params, timeoutMs);
      }

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Execute a query with timeout and error handling
   */
  async executeQuery(
    sql: string,
    params?: any[],
    timeoutMs?: number
  ): Promise<{
    rows: any[];
    rowCount: number;
    command: string;
    oid: number;
    fields: any[];
    executionTime: number;
  }> {
    const queryId = `query_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const queryStartTime = Date.now();

    this.logger.trace(
      'Executing query',
      {
        queryId,
        queryLength: sql.length,
        paramCount: params?.length || 0,
        timeoutMs,
      },
      'PostgresConnectionManager'
    );

    const pool = await this.getPool();

    // Check pool health before acquiring
    const poolStats = {
      totalCount: this.pool?.totalCount || 0,
      idleCount: this.pool?.idleCount || 0,
      waitingCount: this.pool?.waitingCount || 0,
    };

    // Monitor pool health
    const poolUtilization =
      poolStats.totalCount > 0
        ? ((poolStats.totalCount - poolStats.idleCount) / poolStats.totalCount) * 100
        : 0;

    if (poolStats.waitingCount > 0) {
      this.logger.warn(
        'Connection pool has waiting clients',
        {
          queryId,
          poolStats,
          poolUtilization: `${poolUtilization.toFixed(1)}%`,
          warning: 'Pool may be exhausted',
        },
        'PostgresConnectionManager'
      );
    } else if (poolUtilization > 80) {
      this.logger.warn(
        'Connection pool utilization high',
        {
          queryId,
          poolStats,
          poolUtilization: `${poolUtilization.toFixed(1)}%`,
          warning: 'Consider increasing DB_POOL_MAX',
        },
        'PostgresConnectionManager'
      );
    }

    const acquireStart = Date.now();
    let client: PoolClient;

    try {
      // Add timeout for connection acquisition to prevent hanging
      const acquireTimeout = timeoutMs || 5000; // Default 5 second timeout
      client = await Promise.race([
        pool.connect(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Connection acquisition timeout after ${acquireTimeout}ms`)),
            acquireTimeout
          )
        ),
      ]);
    } catch (error) {
      const acquireTime = Date.now() - acquireStart;
      this.logger.error(
        'Failed to acquire connection from pool',
        {
          queryId,
          acquireTime,
          poolStats,
          error: { message: error instanceof Error ? error.message : String(error) },
        },
        'PostgresConnectionManager'
      );
      throw new Error(
        `Failed to acquire database connection: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const acquireTime = Date.now() - acquireStart;

    this.logger.trace(
      'Client acquired from pool',
      {
        queryId,
        acquireTime,
        poolStats: {
          totalCount: this.pool?.totalCount,
          idleCount: this.pool?.idleCount,
          waitingCount: this.pool?.waitingCount,
        },
      },
      'PostgresConnectionManager'
    );

    try {
      // Set statement timeout if provided
      if (timeoutMs) {
        await client.query(`SET statement_timeout = ${timeoutMs}`);
        this.logger.trace(
          'Statement timeout set',
          { queryId, timeoutMs },
          'PostgresConnectionManager'
        );
      }

      const start = Date.now();
      const result = await client.query(sql, params);
      const executionTime = Date.now() - start;

      this.logger.debug(
        'Query executed successfully',
        {
          queryId,
          executionTime,
          acquireTime,
          totalTime: executionTime + acquireTime,
          rowCount: result.rowCount,
          query: sql.substring(0, 100), // Log first 100 chars
          poolStats: {
            totalCount: this.pool?.totalCount,
            idleCount: this.pool?.idleCount,
            waitingCount: this.pool?.waitingCount,
          },
        },
        'PostgresConnectionManager'
      );

      return {
        ...result,
        rowCount: result.rowCount ?? 0,
        executionTime,
      };
    } catch (error) {
      // Use enhanceError to preserve PostgreSQL-specific fields
      const mcpError = enhanceError(error, {
        operation: 'executeQuery',
        query: sql,
        params,
        timeoutMs,
        queryId,
      });

      // Override code if not set by enhanceError
      if (mcpError.code === 'UNKNOWN_ERROR' || !mcpError.code.startsWith('2')) {
        mcpError.code = 'QUERY_ERROR';
      }

      // Log different error types appropriately
      if (error instanceof Error && error.message.includes('timeout')) {
        mcpError.code = 'QUERY_TIMEOUT';
        this.logger.warn(
          'Query timeout',
          {
            queryId,
            error: mcpError,
            executionTime: Date.now() - queryStartTime,
            timeoutMs,
          },
          'PostgresConnectionManager'
        );
      } else if (error instanceof Error && error.message.includes('terminating connection')) {
        mcpError.code = 'CONNECTION_TERMINATED';
        this.logger.error(
          'Query failed - connection terminated',
          {
            queryId,
            error: mcpError,
          },
          'PostgresConnectionManager'
        );
      } else {
        this.logger.error(
          'Query execution failed',
          {
            queryId,
            error:
              error instanceof Error
                ? {
                    message: error.message,
                    code: 'code' in error ? (error as Error & { code: string }).code : undefined,
                    stack: error.stack,
                  }
                : { message: String(error) },
            query: sql.substring(0, 200),
          },
          'PostgresConnectionManager'
        );
      }

      // Create a proper Error instance with the MCPError properties
      const errorMessage =
        mcpError.message || (error instanceof Error ? error.message : String(error));
      const errorToThrow = new Error(errorMessage);
      // Assign all MCPError properties except message (to avoid overwriting)
      const { message, ...mcpErrorProps } = mcpError;
      Object.assign(errorToThrow, mcpErrorProps);
      throw errorToThrow;
    } finally {
      // Reset statement timeout and release client
      const releaseStart = Date.now();
      try {
        if (timeoutMs) {
          await client.query('RESET statement_timeout');
          this.logger.trace('Statement timeout reset', { queryId }, 'PostgresConnectionManager');
        }
      } catch (err) {
        // Ignore reset errors
        this.logger.trace(
          'Failed to reset statement timeout',
          {
            queryId,
            error: { message: err instanceof Error ? err.message : String(err) },
          },
          'PostgresConnectionManager'
        );
      }

      client.release();
      const releaseTime = Date.now() - releaseStart;

      this.logger.trace(
        'Client released to pool',
        {
          queryId,
          releaseTime,
          poolStats: {
            totalCount: this.pool?.totalCount,
            idleCount: this.pool?.idleCount,
            waitingCount: this.pool?.waitingCount,
          },
        },
        'PostgresConnectionManager'
      );
    }
  }

  /**
   * Get the current database name
   */
  getCurrentDatabase(): string {
    return this.config.database || 'unknown';
  }

  /**
   * Create a managed table with standard columns
   */
  async createManagedTable(
    tableName: string,
    idPrefix: string,
    additionalColumns: string = ''
  ): Promise<string> {
    const createTableStartTime = Date.now();

    this.logger.info(
      'Creating managed table',
      {
        tableName,
        idPrefix,
        hasAdditionalColumns: !!additionalColumns,
      },
      'PostgresConnectionManager'
    );

    try {
      // Build the CREATE TABLE query
      let createTableQuery = `
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id VARCHAR(255) PRIMARY KEY DEFAULT '${idPrefix}' || substr(md5(random()::text || clock_timestamp()::text), 1, 8),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      `;

      // Add additional columns if provided
      if (additionalColumns.trim()) {
        createTableQuery += `,\n          ${additionalColumns}`;
      }

      createTableQuery += '\n        );';

      // Create trigger function for updating updated_at
      const createTriggerFunctionQuery = `
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ language 'plpgsql';
      `;

      // Create trigger for the table
      const createTriggerQuery = `
        CREATE TRIGGER update_${tableName}_updated_at
        BEFORE UPDATE ON ${tableName}
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
      `;

      // Execute all queries in a transaction
      const pool = await this.getPool();
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // Create the table
        await client.query(createTableQuery);
        this.logger.debug('Table created or verified', { tableName }, 'PostgresConnectionManager');

        // Create or replace the trigger function
        await client.query(createTriggerFunctionQuery);
        this.logger.debug('Trigger function created or verified', {}, 'PostgresConnectionManager');

        // Create the trigger
        await client.query(createTriggerQuery);
        this.logger.debug('Trigger created for table', { tableName }, 'PostgresConnectionManager');

        await client.query('COMMIT');

        const duration = Date.now() - createTableStartTime;

        this.logger.info(
          'Managed table created successfully',
          {
            tableName,
            idPrefix,
            duration,
          },
          'PostgresConnectionManager'
        );

        return `Managed table '${tableName}' created successfully with auto-generated IDs prefixed with '${idPrefix}'`;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const duration = Date.now() - createTableStartTime;

      this.logger.error(
        'Failed to create managed table',
        {
          tableName,
          idPrefix,
          duration,
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  code: 'code' in error ? (error as Error & { code: string }).code : undefined,
                  stack: error.stack,
                }
              : { message: String(error) },
        },
        'PostgresConnectionManager'
      );

      // Re-throw with enhanced error message
      if (error instanceof Error) {
        throw new Error(`Failed to create managed table '${tableName}': ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Get prepared statement cache metrics
   */
  getPreparedStatementMetrics() {
    return this.preparedStatementCache.getMetrics();
  }

  /**
   * Clear prepared statement cache
   */
  clearPreparedStatementCache(): void {
    this.preparedStatementCache.clear();
  }

  /**
   * Close the connection pool
   */
  async close(): Promise<void> {
    this.logger.debug(
      'Closing connection manager',
      {
        hasPool: !!this.pool,
        hasHealthCheck: !!this.healthCheckInterval,
        hasPreparedStatementCache: !!this.preparedStatementCache,
      },
      'PostgresConnectionManager'
    );

    // Stop health monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      this.logger.debug('Health monitoring stopped', {}, 'PostgresConnectionManager');
    }

    // Destroy prepared statement cache
    if (this.preparedStatementCache) {
      try {
        this.preparedStatementCache.destroy();
        this.logger.debug('Prepared statement cache destroyed', {}, 'PostgresConnectionManager');
      } catch (error) {
        this.logger.error(
          'Error destroying prepared statement cache',
          {
            error:
              error instanceof Error
                ? {
                    message: error.message,
                    stack: error.stack,
                  }
                : { message: String(error) },
          },
          'PostgresConnectionManager'
        );
      }
    }

    // Close pool
    if (this.pool) {
      try {
        const poolStats = {
          totalCount: this.pool.totalCount,
          idleCount: this.pool.idleCount,
          waitingCount: this.pool.waitingCount,
        };

        this.logger.debug('Closing connection pool', { poolStats }, 'PostgresConnectionManager');

        await this.pool.end();
        this.logger.info('Connection pool closed', { poolStats }, 'PostgresConnectionManager');
      } catch (error) {
        this.logger.error(
          'Error closing connection pool',
          {
            error:
              error instanceof Error
                ? {
                    message: error.message,
                    code: 'code' in error ? (error as Error & { code: string }).code : undefined,
                    stack: error.stack,
                  }
                : { message: String(error) },
          },
          'PostgresConnectionManager'
        );
      }
      this.pool = null;
    }
  }
}
