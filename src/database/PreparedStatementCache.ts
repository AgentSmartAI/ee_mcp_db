/**
 * Caches prepared statements to improve query performance.
 * Implements LRU eviction and TTL-based expiration.
 */

import crypto from 'crypto';

import { StructuredLogger } from '../logging/StructuredLogger.js';

export interface PreparedStatement {
  name: string;
  sql: string;
  paramCount: number;
  lastUsed: Date;
  useCount: number;
  created: Date;
}

export interface CacheOptions {
  maxSize: number;
  ttlSeconds: number;
  enableMetrics: boolean;
}

export class PreparedStatementCache {
  private cache: Map<string, PreparedStatement> = new Map();
  private readonly options: CacheOptions;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(
    private logger: StructuredLogger,
    options?: Partial<CacheOptions>
  ) {
    this.options = {
      maxSize: options?.maxSize || 100,
      ttlSeconds: options?.ttlSeconds || 3600, // 1 hour default
      enableMetrics: options?.enableMetrics || true,
    };

    this.logger.info(
      'PreparedStatementCache initialized',
      {
        maxSize: this.options.maxSize,
        ttlSeconds: this.options.ttlSeconds,
        enableMetrics: this.options.enableMetrics,
      },
      'PreparedStatementCache'
    );

    // Start cleanup interval
    if (this.options.ttlSeconds > 0) {
      this.cleanupInterval = setInterval(
        () => this.cleanup(),
        (this.options.ttlSeconds * 1000) / 2
      );
    }
  }

  /**
   * Generate a unique statement name from SQL and parameter count
   */
  generateStatementName(sql: string, paramCount: number): string {
    const hash = crypto.createHash('md5').update(sql).update(paramCount.toString()).digest('hex');
    return `ps_${hash.substring(0, 16)}`;
  }

  /**
   * Get or create a prepared statement
   */
  getOrCreate(sql: string, paramCount: number): PreparedStatement {
    const name = this.generateStatementName(sql, paramCount);

    // Check if exists and not expired
    const existing = this.cache.get(name);
    if (existing && !this.isExpired(existing)) {
      existing.lastUsed = new Date();
      existing.useCount++;
      this.hits++;

      this.logger.trace(
        'Prepared statement cache hit',
        {
          name,
          useCount: existing.useCount,
          age: Date.now() - existing.created.getTime(),
        },
        'PreparedStatementCache'
      );

      return existing;
    }

    // Create new prepared statement
    this.misses++;

    // Check cache size and evict if necessary
    if (this.cache.size >= this.options.maxSize) {
      this.evictLRU();
    }

    const statement: PreparedStatement = {
      name,
      sql,
      paramCount,
      lastUsed: new Date(),
      useCount: 1,
      created: new Date(),
    };

    this.cache.set(name, statement);

    this.logger.debug(
      'Created new prepared statement',
      {
        name,
        sqlLength: sql.length,
        paramCount,
        cacheSize: this.cache.size,
      },
      'PreparedStatementCache'
    );

    return statement;
  }

  /**
   * Check if a statement has expired
   */
  private isExpired(statement: PreparedStatement): boolean {
    if (this.options.ttlSeconds <= 0) return false;

    const age = Date.now() - statement.created.getTime();
    return age > this.options.ttlSeconds * 1000;
  }

  /**
   * Evict least recently used statement
   */
  private evictLRU(): void {
    let lruKey: string | null = null;
    let lruTime = Date.now();

    for (const [key, statement] of this.cache.entries()) {
      if (statement.lastUsed.getTime() < lruTime) {
        lruTime = statement.lastUsed.getTime();
        lruKey = key;
      }
    }

    if (lruKey) {
      const evicted = this.cache.get(lruKey);
      this.cache.delete(lruKey);
      this.evictions++;

      this.logger.debug(
        'Evicted LRU prepared statement',
        {
          name: lruKey,
          useCount: evicted?.useCount,
          age: evicted ? Date.now() - evicted.created.getTime() : 0,
        },
        'PreparedStatementCache'
      );
    }
  }

  /**
   * Clean up expired statements
   */
  private cleanup(): void {
    // Safety check to prevent running after destruction
    if (!this.cleanupInterval) {
      return;
    }

    const startSize = this.cache.size;
    const expired: string[] = [];

    for (const [key, statement] of this.cache.entries()) {
      if (this.isExpired(statement)) {
        expired.push(key);
      }
    }

    for (const key of expired) {
      this.cache.delete(key);
      this.evictions++;
    }

    if (expired.length > 0) {
      this.logger.debug(
        'Cleaned up expired prepared statements',
        {
          removed: expired.length,
          startSize,
          endSize: this.cache.size,
        },
        'PreparedStatementCache'
      );
    }
  }

  /**
   * Get cache metrics
   */
  getMetrics(): {
    size: number;
    hits: number;
    misses: number;
    hitRate: number;
    evictions: number;
    statements: Array<{
      name: string;
      useCount: number;
      age: number;
      lastUsed: number;
    }>;
  } {
    const statements = Array.from(this.cache.entries()).map(([name, stmt]) => ({
      name,
      useCount: stmt.useCount,
      age: Date.now() - stmt.created.getTime(),
      lastUsed: Date.now() - stmt.lastUsed.getTime(),
    }));

    const total = this.hits + this.misses;
    const hitRate = total > 0 ? this.hits / total : 0;

    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate,
      evictions: this.evictions,
      statements: statements.sort((a, b) => b.useCount - a.useCount),
    };
  }

  /**
   * Clear all cached statements
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;

    this.logger.info(
      'Cleared prepared statement cache',
      {
        clearedCount: size,
      },
      'PreparedStatementCache'
    );
  }

  /**
   * Check if a statement exists in cache
   */
  has(sql: string, paramCount: number): boolean {
    const name = this.generateStatementName(sql, paramCount);
    const statement = this.cache.get(name);
    return statement !== undefined && !this.isExpired(statement);
  }

  /**
   * Remove a specific statement from cache
   */
  remove(sql: string, paramCount: number): boolean {
    const name = this.generateStatementName(sql, paramCount);
    return this.cache.delete(name);
  }

  /**
   * Destroy the cache and clean up resources
   */
  destroy(): void {
    // Clear the cleanup interval to prevent memory leak
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    // Clear all cached statements
    this.clear();

    this.logger.info(
      'PreparedStatementCache destroyed',
      {
        finalStats: {
          hits: this.hits,
          misses: this.misses,
          evictions: this.evictions,
          hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
        },
      },
      'PreparedStatementCache'
    );
  }
}
