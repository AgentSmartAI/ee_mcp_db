/**
 * Synchronizes file-based logs to PostgreSQL after database connection is established.
 * Reads startup logs from files and bulk inserts them into the database.
 */

import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { createReadStream } from 'fs';

import { Pool } from 'pg';

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  service: string;
  module?: string;
  traceId?: string;
  [key: string]: any;
}

export class LogSynchronizer {
  constructor(
    private pool: Pool,
    private logDir: string = process.env.LOG_DIRECTORY || './logs',
    private tableName: string = process.env.LOG_DB_TABLE || 'logs.service_logs'
  ) {}

  /**
   * Sync all startup logs from files to PostgreSQL.
   * After successful sync, optionally delete the files.
   */
  async syncStartupLogs(deleteAfterSync: boolean = false): Promise<number> {
    const startupPatterns = [
      'ee-postgres-init-',
      'ee-postgres-startup-',
      'ee-postgres-init-events-',
      'ee-postgres-startup-events-'
    ];

    let totalSynced = 0;

    try {
      // Find today's startup log files
      const files = await fs.readdir(this.logDir);
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      
      const startupFiles = files.filter(file => 
        startupPatterns.some(pattern => file.startsWith(pattern)) &&
        file.includes(today) &&
        file.endsWith('.jsonl')
      );

      // Process each startup file
      for (const file of startupFiles) {
        const filePath = path.join(this.logDir, file);
        const count = await this.syncFile(filePath);
        totalSynced += count;
        
        if (deleteAfterSync && count > 0) {
          await fs.unlink(filePath);
          console.log(`Deleted synced log file: ${file}`);
        }
      }

      return totalSynced;
    } catch (error) {
      console.error('Failed to sync startup logs:', error);
      return totalSynced;
    }
  }

  /**
   * Sync a single log file to PostgreSQL.
   */
  private async syncFile(filePath: string): Promise<number> {
    const logs: LogEntry[] = [];
    
    try {
      // Read file line by line
      const fileStream = createReadStream(filePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        
        try {
          const log = JSON.parse(line);
          logs.push(log);
        } catch (e) {
          // Skip malformed lines
          continue;
        }
      }

      // Batch insert logs
      if (logs.length > 0) {
        await this.batchInsert(logs);
        return logs.length;
      }

      return 0;
    } catch (error) {
      console.error(`Failed to sync file ${filePath}:`, error);
      return 0;
    }
  }

  /**
   * Batch insert logs into PostgreSQL.
   */
  private async batchInsert(logs: LogEntry[]): Promise<void> {
    if (logs.length === 0) return;

    const values: any[] = [];
    const placeholders: string[] = [];

    logs.forEach((log, index) => {
      const offset = index * 10;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, ` +
        `$${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, ` +
        `$${offset + 9}, $${offset + 10})`
      );

      // Extract context (all fields except the standard ones)
      const { timestamp, level, message, service, module, traceId, trace_id, ...context } = log;

      values.push(
        log.timestamp ? new Date(log.timestamp) : new Date(),
        log.service || process.env.SERVICE_NAME || 'ee-postgres',
        log.level?.toUpperCase() || 'INFO',
        log.traceId || log.trace_id || null,
        null, // span_id
        log.module || null,
        null, // function
        log.message || '',
        Object.keys(context).length > 0 ? JSON.stringify(context) : null,
        null  // filepath
      );
    });

    const query = `
      INSERT INTO ${this.tableName} 
      (timestamp, service, level, trace_id, span_id, module, function, message, context, filepath)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT DO NOTHING
    `;

    await this.pool.query(query, values);
  }

  /**
   * Clean up old log files based on age.
   */
  async cleanupOldLogs(maxAgeDays: number = parseInt(process.env.LOG_MAX_FILES || '7')): Promise<number> {
    let deletedCount = 0;
    const cutoffTime = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

    try {
      const files = await fs.readdir(this.logDir);
      
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        
        const filePath = path.join(this.logDir, file);
        const stats = await fs.stat(filePath);
        
        if (stats.mtime.getTime() < cutoffTime) {
          await fs.unlink(filePath);
          deletedCount++;
          console.log(`Deleted old log file: ${file}`);
        }
      }

      return deletedCount;
    } catch (error) {
      console.error('Failed to cleanup old logs:', error);
      return deletedCount;
    }
  }
}