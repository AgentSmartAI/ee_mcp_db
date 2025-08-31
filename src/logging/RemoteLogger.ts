/**
 * High-performance asynchronous remote PostgreSQL logger.
 *
 * Features:
 * - Non-blocking async writes
 * - Batch buffering with configurable size
 * - Automatic flush on interval or buffer size
 * - Circuit breaker for database failures
 * - Zero impact on main thread performance
 */

import { EventEmitter } from 'events';

import { Pool } from 'pg';

interface LogEntry {
  timestamp: Date;
  service: string;
  level: string;
  message: string;
  trace_id?: string;
  span_id?: string;
  module?: string;
  function?: string;
  context?: Record<string, unknown>;
  filepath?: string;
}

interface RemoteLoggerConfig {
  // Database connection
  host: string;
  port: number;
  database: string;
  schema: string;
  user: string;
  password: string;

  // Performance tuning
  poolMax: number;
  batchSize: number;
  flushIntervalMs: number;
  bufferMax: number;

  // Circuit breaker
  enabled: boolean;
  failureThreshold: number;
  resetTimeMs: number;
}

enum CircuitState {
  CLOSED = 'CLOSED', // Normal operation
  OPEN = 'OPEN', // Failing, reject requests
  HALF_OPEN = 'HALF_OPEN', // Testing recovery
}

export class RemoteLogger extends EventEmitter {
  private config: RemoteLoggerConfig;
  private pool?: Pool;
  private buffer: LogEntry[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private isProcessing = false;

  // Circuit breaker state
  private circuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime = 0;

  // Statistics
  private stats = {
    logsQueued: 0,
    logsSent: 0,
    batchesSent: 0,
    failures: 0,
    droppedLogs: 0,
    averageBatchSize: 0,
    lastFlush: new Date(),
  };

  constructor(config: Partial<RemoteLoggerConfig>) {
    super();

    // Set defaults with environment variables
    this.config = {
      host: config.host || process.env.LOG_DB_HOST || 'localhost',
      port: config.port || parseInt(process.env.LOG_DB_PORT || '5432'),
      database: config.database || process.env.LOG_DB_DATABASE || 'documents',
      schema: config.schema || process.env.LOG_DB_SCHEMA || 'logs',
      user: config.user || process.env.LOG_DB_USER || 'postgres',
      password: config.password || process.env.LOG_DB_PASSWORD || '',

      poolMax: config.poolMax || parseInt(process.env.LOG_DB_POOL_MAX || '5'),
      batchSize: config.batchSize || parseInt(process.env.LOG_DB_BATCH_SIZE || '100'),
      flushIntervalMs:
        config.flushIntervalMs || parseInt(process.env.LOG_DB_FLUSH_INTERVAL_MS || '5000'),
      bufferMax: config.bufferMax || parseInt(process.env.LOG_DB_BUFFER_MAX || '1000'),

      enabled: config.enabled ?? process.env.LOG_DB_ENABLED === 'true',
      failureThreshold: config.failureThreshold || 5,
      resetTimeMs: config.resetTimeMs || 60000, // 1 minute
    };
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      this.emit('info', 'Remote logging is disabled');
      return;
    }

    try {
      // Create connection pool
      this.pool = new Pool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        max: this.config.poolMax,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      // Test connection
      const client = await this.pool.connect();
      await client.query(`SET search_path TO ${this.config.schema}`);
      client.release();

      // Start flush timer
      this.startFlushTimer();

      this.emit('initialized', { config: this.config });
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Log a message asynchronously without blocking.
   * Returns immediately, queuing the log for batch processing.
   */
  log(entry: Omit<LogEntry, 'timestamp'> & { timestamp?: Date }): void {
    if (!this.config.enabled || this.circuitState === CircuitState.OPEN) {
      return;
    }

    const logEntry: LogEntry = {
      ...entry,
      timestamp: entry.timestamp || new Date(),
    };

    // Add to buffer
    this.buffer.push(logEntry);
    this.stats.logsQueued++;

    // Check if we should flush
    if (this.buffer.length >= this.config.batchSize) {
      this.flush().catch((err) => this.emit('error', err));
    }

    // Drop oldest logs if buffer is full
    if (this.buffer.length > this.config.bufferMax) {
      const dropped = this.buffer.splice(0, this.buffer.length - this.config.bufferMax);
      this.stats.droppedLogs += dropped.length;
      this.emit('warning', `Dropped ${dropped.length} logs due to buffer overflow`);
    }
  }

  /**
   * Flush buffered logs to the database.
   * This is async but doesn't block the main thread.
   */
  private async flush(): Promise<void> {
    // Prevent concurrent flushes
    if (this.isProcessing || this.buffer.length === 0 || !this.pool) {
      return;
    }

    // Check circuit breaker
    if (this.circuitState === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.config.resetTimeMs) {
        this.circuitState = CircuitState.HALF_OPEN;
        this.emit('info', 'Circuit breaker entering half-open state');
      } else {
        return; // Still in cooldown
      }
    }

    this.isProcessing = true;

    // Take a batch from the buffer
    const batch = this.buffer.splice(0, this.config.batchSize);

    try {
      await this.sendBatch(batch);

      // Success - update stats and circuit breaker
      this.stats.logsSent += batch.length;
      this.stats.batchesSent++;
      this.stats.lastFlush = new Date();
      this.stats.averageBatchSize =
        (this.stats.averageBatchSize * (this.stats.batchesSent - 1) + batch.length) /
        this.stats.batchesSent;

      // Reset circuit breaker on success
      if (this.circuitState !== CircuitState.CLOSED) {
        this.circuitState = CircuitState.CLOSED;
        this.failureCount = 0;
        this.emit('info', 'Circuit breaker closed - connection restored');
      }
    } catch (error) {
      // Failure - update circuit breaker
      this.failureCount++;
      this.stats.failures++;
      this.lastFailureTime = Date.now();

      if (this.failureCount >= this.config.failureThreshold) {
        this.circuitState = CircuitState.OPEN;
        this.emit('error', `Circuit breaker opened after ${this.failureCount} failures`);
      }

      // Put logs back in buffer (at the front)
      this.buffer.unshift(...batch);
      this.emit('error', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Send a batch of logs to the database using a single INSERT.
   */
  private async sendBatch(batch: LogEntry[]): Promise<void> {
    if (!this.pool) throw new Error('Database pool not initialized');

    const client = await this.pool.connect();

    try {
      // Build bulk insert query
      const values: (string | number | Date | null)[] = [];
      const placeholders: string[] = [];

      batch.forEach((log, index) => {
        const offset = index * 10;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, ` +
            `$${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, ` +
            `$${offset + 9}, $${offset + 10})`
        );

        values.push(
          log.timestamp,
          log.service,
          log.level,
          log.trace_id || null,
          log.span_id || null,
          log.module || null,
          log.function || null,
          log.message,
          log.context ? JSON.stringify(log.context) : null,
          log.filepath || null
        );
      });

      const query = `
        INSERT INTO ${this.config.schema}.service_logs 
        (timestamp, service, level, trace_id, span_id, module, function, message, context, filepath)
        VALUES ${placeholders.join(', ')}
      `;

      await client.query(query, values);
    } finally {
      client.release();
    }
  }

  /**
   * Start the automatic flush timer.
   */
  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => this.emit('error', err));
    }, this.config.flushIntervalMs);
  }

  /**
   * Get current statistics.
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Gracefully shutdown the logger.
   */
  async shutdown(): Promise<void> {
    // Stop timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Flush remaining logs
    if (this.buffer.length > 0) {
      try {
        await this.flush();
      } catch {
        this.emit('error', `Failed to flush ${this.buffer.length} logs during shutdown`);
      }
    }

    // Close pool
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }

    this.emit('shutdown', this.stats);
  }
}

/**
 * Factory function to create and initialize a remote logger.
 */
export async function createRemoteLogger(
  config?: Partial<RemoteLoggerConfig>
): Promise<RemoteLogger> {
  const logger = new RemoteLogger(config || {});
  await logger.initialize();
  return logger;
}
