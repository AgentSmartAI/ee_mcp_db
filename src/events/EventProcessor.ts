/**
 * Base event processor implementations for common event handling patterns.
 */

import { StructuredLogger } from '../logging/StructuredLogger.js';

import { EventProcessor } from './EventCollector.js';
import { MCPEvent, EventType } from './EventTypes.js';

/**
 * Query optimization processor - analyzes slow queries and suggests optimizations
 */
export class QueryOptimizationProcessor implements EventProcessor {
  constructor(
    private logger: StructuredLogger,
    private thresholdMs: number = 1000
  ) {}

  async process(event: MCPEvent): Promise<void> {
    if (event.event_type !== EventType.QUERY_SLOW) {
      return;
    }

    const { query, execution_time_ms, missing_indexes } = event.data;

    // Log optimization opportunity
    this.logger.info(
      'Query optimization opportunity detected',
      {
        event_id: `evt_opt_${Date.now()}`,
        event_type: EventType.QUERY_ANALYZED,
        parent_event_id: event.event_id,
        query_summary: query.substring(0, 100),
        execution_time_ms,
        optimization_potential: missing_indexes?.length > 0,
      },
      'QueryOptimizationProcessor'
    );

    // TODO: Implement actual optimization logic
    // 1. Analyze query plan
    // 2. Suggest indexes
    // 3. Rewrite query if possible
    // 4. Store optimization for learning
  }
}

/**
 * Error recovery processor - handles automatic error recovery
 */
export class ErrorRecoveryProcessor implements EventProcessor {
  private errorCounts: Map<string, number> = new Map();
  private lastErrorTime: Map<string, Date> = new Map();

  constructor(
    private logger: StructuredLogger,
    private maxRetries: number = 3,
    private windowMs: number = 60000 // 1 minute
  ) {}

  async process(event: MCPEvent): Promise<void> {
    if (event.event_type !== EventType.CONN_FAILED && event.event_type !== EventType.QUERY_FAILED) {
      return;
    }

    const errorKey = `${event.event_type}:${event.data.error_code || 'unknown'}`;
    const now = new Date();

    // Reset counter if outside time window
    const lastError = this.lastErrorTime.get(errorKey);
    if (lastError && now.getTime() - lastError.getTime() > this.windowMs) {
      this.errorCounts.delete(errorKey);
    }

    // Increment error count
    const currentCount = (this.errorCounts.get(errorKey) || 0) + 1;
    this.errorCounts.set(errorKey, currentCount);
    this.lastErrorTime.set(errorKey, now);

    // Check if we should attempt recovery
    if (currentCount <= this.maxRetries) {
      this.logger.info(
        'Attempting automatic error recovery',
        {
          event_id: `evt_recovery_${Date.now()}`,
          event_type: EventType.ERROR_DETECTED,
          parent_event_id: event.event_id,
          error_key: errorKey,
          attempt: currentCount,
          max_retries: this.maxRetries,
        },
        'ErrorRecoveryProcessor'
      );

      // TODO: Implement recovery strategies
      // 1. Connection reset for CONN_FAILED
      // 2. Query rewrite for QUERY_FAILED
      // 3. Backoff and retry
    } else {
      // Escalate if max retries exceeded
      this.logger.error(
        'Error recovery failed - escalating',
        {
          event_id: `evt_escalate_${Date.now()}`,
          event_type: EventType.ERROR_ESCALATED,
          parent_event_id: event.event_id,
          error_key: errorKey,
          total_attempts: currentCount,
        },
        'ErrorRecoveryProcessor'
      );
    }
  }
}

/**
 * Metrics aggregation processor - collects metrics from events
 */
export class MetricsAggregationProcessor implements EventProcessor {
  private metrics: {
    queryCount: number;
    totalQueryTime: number;
    errorCount: number;
    connectionCount: number;
    lastReset: Date;
  };

  constructor(
    private logger: StructuredLogger,
    private aggregationIntervalMs: number = 300000 // 5 minutes
  ) {
    this.metrics = this.resetMetrics();
    this.scheduleMetricsFlush();
  }

  async process(event: MCPEvent): Promise<void> {
    switch (event.event_type) {
      case EventType.QUERY_EXECUTED:
        this.metrics.queryCount++;
        this.metrics.totalQueryTime += event.data.execution_time_ms || 0;
        break;

      case EventType.QUERY_FAILED:
      case EventType.CONN_FAILED:
      case EventType.ERROR_DETECTED:
        this.metrics.errorCount++;
        break;

      case EventType.CONN_CREATED:
        this.metrics.connectionCount++;
        break;
    }
  }

  private scheduleMetricsFlush(): void {
    setInterval(() => {
      this.flushMetrics();
    }, this.aggregationIntervalMs);
  }

  private flushMetrics(): void {
    const avgQueryTime =
      this.metrics.queryCount > 0 ? this.metrics.totalQueryTime / this.metrics.queryCount : 0;

    this.logger.info(
      'Metrics aggregation',
      {
        event_id: `evt_metrics_${Date.now()}`,
        event_type: EventType.METRICS_COLLECTED,
        period_start: this.metrics.lastReset,
        period_end: new Date(),
        metrics: {
          total_queries: this.metrics.queryCount,
          avg_query_time_ms: avgQueryTime,
          total_errors: this.metrics.errorCount,
          new_connections: this.metrics.connectionCount,
          error_rate:
            this.metrics.queryCount > 0 ? this.metrics.errorCount / this.metrics.queryCount : 0,
        },
      },
      'MetricsAggregationProcessor'
    );

    // Reset metrics
    this.metrics = this.resetMetrics();
  }

  private resetMetrics() {
    return {
      queryCount: 0,
      totalQueryTime: 0,
      errorCount: 0,
      connectionCount: 0,
      lastReset: new Date(),
    };
  }
}
