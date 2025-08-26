/**
 * Type definitions for structured logging.
 * Defines the structure of log entries and metadata.
 */

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';

export interface LogMetadata {
  [key: string]: any;
  module?: string;
  action?: string;
  duration_ms?: number;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  metadata?: LogMetadata;
}

export interface LoggerConfig {
  level: LogLevel;
  directory?: string; // Optional for database logging
  maxFiles?: number; // Optional for database logging
  maxSize?: string; // Optional for database logging
  service: string;
  // Database logging options
  batchSize?: number;
  flushIntervalMs?: number;
}

// Extended config for database logging
export interface DatabaseLoggerConfig extends LoggerConfig {
  pool?: any; // PostgreSQL connection pool (typed as any to avoid import)
}
