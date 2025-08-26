/**
 * Central event collection service for the MCP server.
 * Collects, processes, and routes events for monitoring and automation.
 */

import { EventEmitter } from 'events';

import { StructuredLogger } from '../logging/StructuredLogger.js';

import { MCPEvent, EventType, EventSeverity } from './EventTypes.js';

export interface EventProcessor {
  process(event: MCPEvent): Promise<void>;
}

export interface EventMetrics {
  total: number;
  byType: Record<EventType, number>;
  bySeverity: Record<EventSeverity, number>;
  bySource: Record<string, number>;
  eventsPerMinute: number;
  lastUpdated: Date;
}

export interface EventFilter {
  types?: EventType[];
  severities?: EventSeverity[];
  sources?: string[];
  startTime?: Date;
  endTime?: Date;
}

export class EventCollector extends EventEmitter {
  private processors: Map<EventType, EventProcessor[]> = new Map();
  private metrics: EventMetrics;
  private eventBuffer: MCPEvent[] = [];
  private readonly maxBufferSize = 10000;
  private metricsInterval: NodeJS.Timeout | null = null;
  private eventLog: string = 'events.jsonl';

  constructor(
    private logger: StructuredLogger,
    private enableMetrics: boolean = true
  ) {
    super();

    this.metrics = this.initializeMetrics();

    if (this.enableMetrics) {
      this.startMetricsCollection();
    }

    this.logger.info(
      'EventCollector initialized',
      {
        enableMetrics: this.enableMetrics,
        maxBufferSize: this.maxBufferSize,
      },
      'EventCollector'
    );
  }

  /**
   * Collect and process an event
   */
  async collect(event: MCPEvent): Promise<void> {
    try {
      // Update metrics
      this.updateMetrics(event);

      // Log to events file if it has an event_id
      if (event.event_id) {
        await this.logEvent(event);
      }

      // Buffer event for analysis
      this.bufferEvent(event);

      // Process event
      await this.processEvent(event);

      // Emit event for listeners
      this.emit('event', event);
      this.emit(event.event_type, event);
    } catch (error) {
      this.logger.error(
        'Failed to collect event',
        error instanceof Error ? error : new Error(String(error)),
        'EventCollector'
      );
    }
  }

  /**
   * Register a processor for specific event types
   */
  registerProcessor(eventType: EventType, processor: EventProcessor): void {
    if (!this.processors.has(eventType)) {
      this.processors.set(eventType, []);
    }

    this.processors.get(eventType)!.push(processor);

    this.logger.debug(
      'Registered event processor',
      {
        eventType,
        processorCount: this.processors.get(eventType)!.length,
      },
      'EventCollector'
    );
  }

  /**
   * Get current metrics
   */
  getMetrics(): EventMetrics {
    return { ...this.metrics };
  }

  /**
   * Get buffered events with optional filtering
   */
  getEvents(filter?: EventFilter): MCPEvent[] {
    let events = [...this.eventBuffer];

    if (filter) {
      if (filter.types) {
        events = events.filter((e) => filter.types!.includes(e.event_type));
      }

      if (filter.severities) {
        events = events.filter((e) => filter.severities!.includes(e.severity));
      }

      if (filter.sources) {
        events = events.filter((e) => filter.sources!.includes(e.source));
      }

      if (filter.startTime) {
        events = events.filter((e) => new Date(e.timestamp) >= filter.startTime!);
      }

      if (filter.endTime) {
        events = events.filter((e) => new Date(e.timestamp) <= filter.endTime!);
      }
    }

    return events;
  }

  /**
   * Clear event buffer
   */
  clearBuffer(): void {
    const size = this.eventBuffer.length;
    this.eventBuffer = [];

    this.logger.info(
      'Event buffer cleared',
      {
        eventsCleared: size,
      },
      'EventCollector'
    );
  }

  /**
   * Stop the event collector
   */
  stop(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }

    this.removeAllListeners();
    this.processors.clear();

    this.logger.info(
      'EventCollector stopped',
      {
        bufferedEvents: this.eventBuffer.length,
        totalEvents: this.metrics.total,
      },
      'EventCollector'
    );
  }

  /**
   * Log event to dedicated events file
   */
  private async logEvent(event: MCPEvent): Promise<void> {
    try {
      // The StructuredLogger will detect the event_id and route to events.jsonl
      this.logger.debug(
        'Event collected',
        {
          ...event,
          _eventLog: true, // Special flag for routing
        },
        'EventCollector'
      );
    } catch (error) {
      this.logger.error(
        'Failed to log event',
        error instanceof Error ? error : new Error(String(error)),
        'EventCollector'
      );
    }
  }

  /**
   * Buffer event for analysis
   */
  private bufferEvent(event: MCPEvent): void {
    this.eventBuffer.push(event);

    // Maintain buffer size limit (FIFO)
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer.shift();
    }
  }

  /**
   * Process event through registered processors
   */
  private async processEvent(event: MCPEvent): Promise<void> {
    const processors = this.processors.get(event.event_type) || [];

    if (processors.length === 0) {
      return;
    }

    // Process in parallel with timeout and error handling
    const timeoutMs = 5000; // 5 second timeout per processor
    const results = await Promise.allSettled(
      processors.map((processor) => this.withTimeout(processor.process(event), timeoutMs))
    );

    // Log any processor failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(
          'Event processor failed',
          {
            error:
              result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
            processorIndex: index,
            eventType: event.event_type,
            eventId: event.event_id,
          },
          'EventCollector'
        );
      }
    });
  }

  /**
   * Wrap a promise with a timeout
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Processor timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  }

  /**
   * Update metrics for the event
   */
  private updateMetrics(event: MCPEvent): void {
    this.metrics.total++;

    // Update type counts
    this.metrics.byType[event.event_type] = (this.metrics.byType[event.event_type] || 0) + 1;

    // Update severity counts
    this.metrics.bySeverity[event.severity] = (this.metrics.bySeverity[event.severity] || 0) + 1;

    // Update source counts
    this.metrics.bySource[event.source] = (this.metrics.bySource[event.source] || 0) + 1;

    this.metrics.lastUpdated = new Date();
  }

  /**
   * Initialize metrics structure
   */
  private initializeMetrics(): EventMetrics {
    const byType: Record<EventType, number> = {} as Record<EventType, number>;
    Object.values(EventType).forEach((type) => {
      byType[type as EventType] = 0;
    });

    return {
      total: 0,
      byType,
      bySeverity: {
        info: 0,
        warn: 0,
        error: 0,
        critical: 0,
      },
      bySource: {},
      eventsPerMinute: 0,
      lastUpdated: new Date(),
    };
  }

  /**
   * Start periodic metrics calculation
   */
  private startMetricsCollection(): void {
    let previousTotal = 0;

    this.metricsInterval = setInterval(() => {
      const currentTotal = this.metrics.total;
      const eventsInMinute = currentTotal - previousTotal;

      this.metrics.eventsPerMinute = eventsInMinute;
      previousTotal = currentTotal;

      // Emit metrics event
      this.emit('metrics', this.getMetrics());
    }, 60000); // Every minute
  }

  /**
   * Get event statistics for a time window
   */
  getEventStats(windowMinutes: number = 60): {
    eventRate: number;
    errorRate: number;
    topEventTypes: Array<{ type: EventType; count: number }>;
    severityDistribution: Record<EventSeverity, number>;
  } {
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMinutes * 60 * 1000);

    const windowEvents = this.eventBuffer.filter((e) => new Date(e.timestamp) >= windowStart);

    const totalInWindow = windowEvents.length;
    const errorsInWindow = windowEvents.filter(
      (e) => e.severity === 'error' || e.severity === 'critical'
    ).length;

    // Calculate top event types
    const typeCounts = new Map<EventType, number>();
    windowEvents.forEach((e) => {
      typeCounts.set(e.event_type, (typeCounts.get(e.event_type) || 0) + 1);
    });

    const topEventTypes = Array.from(typeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => ({ type, count }));

    // Calculate severity distribution
    const severityDistribution: Record<EventSeverity, number> = {
      info: 0,
      warn: 0,
      error: 0,
      critical: 0,
    };

    windowEvents.forEach((e) => {
      severityDistribution[e.severity]++;
    });

    return {
      eventRate: totalInWindow / windowMinutes,
      errorRate: totalInWindow > 0 ? errorsInWindow / totalInWindow : 0,
      topEventTypes,
      severityDistribution,
    };
  }
}
