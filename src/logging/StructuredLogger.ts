/**
 * Structured logger with support for both file-based (JSONL) and PostgreSQL logging.
 * Can write to files with daily rotation OR directly to PostgreSQL database.
 */

import path from 'path';

import { Pool } from 'pg';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

import { MCPEvent } from '../events/EventTypes.js';

import { PostgresTransport } from './PostgresTransport.js';
import { LogLevel, LogMetadata, DatabaseLoggerConfig } from './types/LogTypes.js';

export class StructuredLogger {
  private logger: winston.Logger;
  private eventLogger: winston.Logger | null = null;
  private service: string;
  private pool?: Pool;
  private config: DatabaseLoggerConfig;

  constructor(config: DatabaseLoggerConfig) {
    this.service = config.service;
    this.config = config;
    this.pool = config.pool;

    // Define custom levels including TRACE
    const customLevels = {
      levels: {
        error: 0,
        warn: 1,
        info: 2,
        debug: 3,
        trace: 4,
      },
      colors: {
        error: 'red',
        warn: 'yellow',
        info: 'green',
        debug: 'blue',
        trace: 'magenta',
      },
    };

    // Add colors to Winston
    winston.addColors(customLevels.colors);

    // Create transports array
    const transports: winston.transport[] = [
      // Console transport for development
      new winston.transports.Console({
        format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
      }),
    ];

    // Add appropriate transport based on configuration
    if (this.pool) {
      // Database logging mode
      transports.push(
        new PostgresTransport({
          pool: this.pool,
          tableName: 'logs.service_logs',
          batchSize: config.batchSize || 10,
          flushIntervalMs: config.flushIntervalMs || 1000,
        })
      );
    } else if (config.directory) {
      // File-based logging mode (backward compatibility)
      transports.push(
        new DailyRotateFile({
          dirname: config.directory,
          filename: `${this.service}-%DATE%.jsonl`,
          datePattern: 'YYYY-MM-DD',
          maxFiles: config.maxFiles || '7d',
          maxSize: config.maxSize || '20m',
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json(),
            winston.format.printf((info) => {
              // Reorder fields: timestamp, level, message, then rest
              const { timestamp, level, message, ...rest } = info;
              return JSON.stringify({ timestamp, level, message, ...rest });
            })
          ),
        })
      );
    }

    // Create Winston logger
    this.logger = winston.createLogger({
      levels: customLevels.levels,
      level: config.level.toLowerCase(),
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
      defaultMeta: { service: this.service },
      transports,
    });

    // Create event logger for event_id based logs
    if (this.pool) {
      // Database event logging
      this.eventLogger = winston.createLogger({
        levels: customLevels.levels,
        level: 'trace', // Always log all events
        format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
        defaultMeta: { service: this.service, event_log: true },
        transports: [
          new PostgresTransport({
            pool: this.pool,
            tableName: 'logs.service_logs',
            batchSize: config.batchSize || 10,
            flushIntervalMs: config.flushIntervalMs || 1000,
          }),
        ],
      });
    } else if (config.directory) {
      // File-based event logging
      this.eventLogger = winston.createLogger({
        levels: customLevels.levels,
        level: 'trace', // Always log all events
        format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
        defaultMeta: { service: this.service },
        transports: [
          // Separate file for events
          new DailyRotateFile({
            dirname: config.directory,
            filename: `${this.service}-events-%DATE%.jsonl`,
            datePattern: 'YYYY-MM-DD',
            maxFiles: config.maxFiles || '30d', // Keep events longer
            maxSize: config.maxSize || '20m',
            format: winston.format.combine(
              winston.format.timestamp(),
              winston.format.json(),
              winston.format.printf((info) => JSON.stringify(info))
            ),
          }),
        ],
      });
    }

    // Log initialization
    this.info('Logger initialized', {
      config: {
        level: config.level,
        mode: this.pool ? 'database' : 'file',
        database_logging: !!this.pool,
        batch_size: config.batchSize || 10,
        flush_interval_ms: config.flushIntervalMs || 1000,
      },
    });
  }

  /**
   * Set or update the database pool for logging (enables database logging)
   */
  setPool(pool: Pool): void {
    this.pool = pool;

    // Remove existing file transports if any
    const fileTransports = this.logger.transports.filter((t) => t instanceof DailyRotateFile);
    fileTransports.forEach((t) => this.logger.remove(t));

    // Add PostgreSQL transport
    this.logger.add(
      new PostgresTransport({
        pool,
        tableName: 'logs.service_logs',
        batchSize: this.config.batchSize || 10,
        flushIntervalMs: this.config.flushIntervalMs || 1000,
      })
    );

    // Update event logger
    if (!this.eventLogger || fileTransports.length > 0) {
      const customLevels = {
        levels: {
          error: 0,
          warn: 1,
          info: 2,
          debug: 3,
          trace: 4,
        },
      };

      // Remove file-based event logger
      if (this.eventLogger) {
        const eventFileTransports = this.eventLogger.transports.filter(
          (t) => t instanceof DailyRotateFile
        );
        eventFileTransports.forEach((t) => this.eventLogger!.remove(t));
      } else {
        // Create new event logger
        this.eventLogger = winston.createLogger({
          levels: customLevels.levels,
          level: 'trace',
          format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
          defaultMeta: { service: this.service, event_log: true },
          transports: [],
        });
      }

      // Add database transport for events
      this.eventLogger.add(
        new PostgresTransport({
          pool,
          tableName: 'logs.service_logs',
          batchSize: this.config.batchSize || 10,
          flushIntervalMs: this.config.flushIntervalMs || 1000,
        })
      );
    }

    this.info('Database logging enabled', { pool_connected: true });
  }

  /**
   * Log an info message
   */
  info(message: string, metadata?: LogMetadata | Error, module?: string): void {
    this.log('INFO', message, metadata, module);
  }

  /**
   * Log a warning message
   */
  warn(message: string, metadata?: LogMetadata | Error, module?: string): void {
    this.log('WARN', message, metadata, module);
  }

  /**
   * Log an error message
   */
  error(message: string, metadata?: LogMetadata | Error, module?: string): void {
    this.log('ERROR', message, metadata, module);
  }

  /**
   * Log a debug message
   */
  debug(message: string, metadata?: LogMetadata | Error, module?: string): void {
    this.log('DEBUG', message, metadata, module);
  }

  /**
   * Log a trace message (most verbose)
   */
  trace(message: string, metadata?: LogMetadata | Error, module?: string): void {
    this.log('TRACE', message, metadata, module);
  }

  /**
   * Internal logging method
   */
  private log(
    level: LogLevel,
    message: string,
    metadata?: LogMetadata | Error,
    module?: string
  ): void {
    const logData: any = {
      level: level.toLowerCase(),
      message,
      module,
    };

    // Handle Error objects specially
    if (metadata instanceof Error) {
      logData.error = {
        message: metadata.message,
        stack: metadata.stack,
        name: metadata.name,
      };
    } else if (metadata) {
      // Merge metadata
      Object.assign(logData, metadata);
    }

    // Add trace ID if available in metadata
    if (metadata && typeof metadata === 'object' && 'traceId' in metadata) {
      logData.trace_id = metadata.traceId;
    }

    // Use the appropriate log level method
    switch (level) {
      case 'ERROR':
        (this.logger as any).error(logData);
        break;
      case 'WARN':
        (this.logger as any).warn(logData);
        break;
      case 'INFO':
        (this.logger as any).info(logData);
        break;
      case 'DEBUG':
        (this.logger as any).debug(logData);
        break;
      case 'TRACE':
        (this.logger as any).trace(logData);
        break;
      default:
        (this.logger as any).info(logData);
    }
  }

  /**
   * Log an event with event_id
   */
  logEvent(event: MCPEvent): void {
    if (!this.eventLogger) {
      // Fall back to regular logger if event logger not available
      this.debug('Event', event);
      return;
    }

    const eventData = {
      ...event,
      event_log: true,
      _eventLog: true, // Mark as event log
    };

    // Use trace level for all events
    (this.eventLogger as any).trace(eventData);
  }

  /**
   * Create a startup logger for early initialization
   */
  static createStartupLogger(level: LogLevel = 'INFO'): StructuredLogger {
    // Create a console-only logger for startup
    return new StructuredLogger({
      level,
      service: 'startup',
    });
  }
}
