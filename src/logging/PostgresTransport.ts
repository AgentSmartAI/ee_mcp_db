/**
 * Custom Winston transport for logging directly to PostgreSQL
 * Stores log messages in the logs.service_logs table
 */

import { Pool } from 'pg';
import Transport from 'winston-transport';

export interface PostgresTransportOptions extends Transport.TransportStreamOptions {
  pool: Pool;
  tableName?: string;
  batchSize?: number;
  flushIntervalMs?: number;
}

export interface LogMessage {
  timestamp: Date;
  service: string;
  level?: string;
  trace_id?: string;
  span_id?: string;
  module?: string;
  function?: string;
  message?: string;
  context?: Record<string, unknown>;
  filepath?: string;
}

interface LogInfo {
  timestamp?: string | number | Date;
  service?: string;
  level?: string;
  traceId?: string;
  trace_id?: string;
  span_id?: string;
  module?: string;
  function?: string;
  message?: string;
  filepath?: string;
  [key: string]: unknown;
}

export class PostgresTransport extends Transport {
  private pool: Pool;
  private tableName: string;
  private batchSize: number;
  private flushIntervalMs: number;
  private batch: LogMessage[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: PostgresTransportOptions) {
    super(opts);

    this.pool = opts.pool;
    this.tableName = opts.tableName || 'logs.service_logs';
    this.batchSize = opts.batchSize || 10; // Batch multiple logs for better performance
    this.flushIntervalMs = opts.flushIntervalMs || 1000; // Flush every second

    // Start the flush timer
    this.startFlushTimer();
  }

  log(info: LogInfo, callback: () => void): void {
    const logMessage: LogMessage = {
      timestamp: new Date(info.timestamp || Date.now()),
      service: info.service || process.env.SERVICE_NAME || 'ee-postgres',
      level: info.level?.toUpperCase(),
      trace_id: info.traceId || info.trace_id,
      span_id: info.span_id,
      module: info.module,
      function: info.function,
      message: info.message,
      context: this.sanitizeMetadata(info),
      filepath: info.filepath,
    };

    this.batch.push(logMessage);

    // Flush if batch is full
    if (this.batch.length >= this.batchSize) {
      this.flush();
    }

    callback();
  }

  private sanitizeMetadata(info: LogInfo): Record<string, unknown> {
    // Remove winston-specific fields and create clean context object
    const excluded = [
      'timestamp',
      'level',
      'message',
      'service',
      'traceId',
      'trace_id',
      'span_id',
      'module',
      'function',
      'filepath',
    ];
    const context: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(info)) {
      if (!excluded.includes(key)) {
        context[key] = value;
      }
    }

    return Object.keys(context).length > 0 ? context : {};
  }

  private async flush(): Promise<void> {
    if (this.batch.length === 0) return;

    const messagesToFlush = [...this.batch];
    this.batch = [];

    try {
      const query = `
        INSERT INTO ${this.tableName} (timestamp, service, level, trace_id, span_id, module, function, message, context, filepath)
        VALUES ${messagesToFlush
          .map((_, i) => {
            const offset = i * 10;
            return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`;
          })
          .join(', ')}
      `;

      const values = messagesToFlush.flatMap((msg) => [
        msg.timestamp,
        msg.service,
        msg.level || null,
        msg.trace_id || null,
        msg.span_id || null,
        msg.module || null,
        msg.function || null,
        msg.message || null,
        JSON.stringify(msg.context || {}),
        msg.filepath || null,
      ]);

      await this.pool.query(query, values);
    } catch (error) {
      // Fallback to console if database write fails
      console.error('Failed to write logs to database:', error);

      // Log to console as fallback
      for (const msg of messagesToFlush) {
        console.log(
          JSON.stringify({
            timestamp: msg.timestamp,
            service: msg.service,
            level: msg.level,
            message: msg.message,
            ...msg.context,
            trace_id: msg.trace_id,
            span_id: msg.span_id,
            module: msg.module,
            function: msg.function,
            _db_write_failed: true,
          })
        );
      }
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch((error) => {
        console.error('Error during scheduled flush:', error);
      });
    }, this.flushIntervalMs);
  }

  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush any remaining messages
    this.flush().catch((error) => {
      console.error('Error during final flush:', error);
    });

    if (super.close) {
      super.close();
    }
  }
}
