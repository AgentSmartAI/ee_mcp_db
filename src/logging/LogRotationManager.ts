/**
 * Manages log rotation and cleanup for structured logs.
 * Ensures logs are rotated daily and old logs are cleaned up.
 */

import fs from 'fs/promises';
import path from 'path';

import { StructuredLogger } from './StructuredLogger.js';

export class LogRotationManager {
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private logDir: string,
    private maxAgeDays: number = parseInt(process.env.LOG_MAX_FILES || '7'),
    private logger?: StructuredLogger
  ) {}

  /**
   * Start automatic log cleanup process
   */
  async startAutoCleanup(): Promise<void> {
    // Run cleanup immediately
    await this.cleanupOldLogs();

    // Schedule daily cleanup at 2 AM
    const now = new Date();
    const tomorrow2AM = new Date(now);
    tomorrow2AM.setDate(tomorrow2AM.getDate() + 1);
    tomorrow2AM.setHours(2, 0, 0, 0);

    const msUntil2AM = tomorrow2AM.getTime() - now.getTime();

    setTimeout(() => {
      // Run cleanup at 2 AM
      this.cleanupOldLogs().catch((err) => {
        this.logger?.error('Failed to cleanup old logs', err);
      });

      // Then schedule daily cleanup
      this.cleanupInterval = setInterval(
        () => {
          this.cleanupOldLogs().catch((err) => {
            this.logger?.error('Failed to cleanup old logs', err);
          });
        },
        24 * 60 * 60 * 1000
      ); // 24 hours
    }, msUntil2AM);

    this.logger?.info('Log rotation manager started', {
      logDir: this.logDir,
      maxAgeDays: this.maxAgeDays,
      nextCleanup: tomorrow2AM.toISOString(),
    });
  }

  /**
   * Stop automatic log cleanup
   */
  stopAutoCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Clean up logs older than maxAgeDays
   */
  async cleanupOldLogs(): Promise<void> {
    try {
      const files = await fs.readdir(this.logDir);
      const now = Date.now();
      const maxAgeMs = this.maxAgeDays * 24 * 60 * 60 * 1000;

      let deletedCount = 0;
      let totalSize = 0;

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = path.join(this.logDir, file);
        const stats = await fs.stat(filePath);

        if (now - stats.mtime.getTime() > maxAgeMs) {
          totalSize += stats.size;
          await fs.unlink(filePath);
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        this.logger?.info('Cleaned up old log files', {
          deletedCount,
          totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
        });
      }
    } catch (error) {
      this.logger?.error('Error cleaning up old logs', error as Error);
    }
  }

  /**
   * Get current log statistics
   */
  async getLogStats(): Promise<{
    fileCount: number;
    totalSizeMB: number;
    oldestLog: Date | null;
    newestLog: Date | null;
  }> {
    try {
      const files = await fs.readdir(this.logDir);
      const logFiles = files.filter((f) => f.endsWith('.jsonl'));

      if (logFiles.length === 0) {
        return {
          fileCount: 0,
          totalSizeMB: 0,
          oldestLog: null,
          newestLog: null,
        };
      }

      let totalSize = 0;
      let oldestTime = Infinity;
      let newestTime = 0;

      for (const file of logFiles) {
        const filePath = path.join(this.logDir, file);
        const stats = await fs.stat(filePath);
        totalSize += stats.size;

        const mtime = stats.mtime.getTime();
        if (mtime < oldestTime) oldestTime = mtime;
        if (mtime > newestTime) newestTime = mtime;
      }

      return {
        fileCount: logFiles.length,
        totalSizeMB: totalSize / 1024 / 1024,
        oldestLog: new Date(oldestTime),
        newestLog: new Date(newestTime),
      };
    } catch (error) {
      this.logger?.error('Error getting log stats', error as Error);
      return {
        fileCount: 0,
        totalSizeMB: 0,
        oldestLog: null,
        newestLog: null,
      };
    }
  }
}
