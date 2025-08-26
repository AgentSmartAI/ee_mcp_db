/**
 * Event type definitions for the MCP event-driven architecture.
 * These events enable monitoring, learning, and self-repair mechanisms.
 */

export enum EventType {
  // Query Events
  QUERY_EXECUTED = 'QUERY_EXECUTED',
  QUERY_FAILED = 'QUERY_FAILED',
  QUERY_SLOW = 'QUERY_SLOW',
  QUERY_OPTIMIZED = 'QUERY_OPTIMIZED',
  QUERY_ANALYZED = 'QUERY_ANALYZED',

  // Connection Events
  CONN_CREATED = 'CONN_CREATED',
  CONN_FAILED = 'CONN_FAILED',
  CONN_TIMEOUT = 'CONN_TIMEOUT',
  CONN_CLOSED = 'CONN_CLOSED',
  POOL_EXHAUSTED = 'POOL_EXHAUSTED',
  POOL_HEALED = 'POOL_HEALED',

  // Resource Events
  RESOURCE_ACCESSED = 'RESOURCE_ACCESSED',
  RESOURCE_CACHED = 'RESOURCE_CACHED',
  RESOURCE_EXPIRED = 'RESOURCE_EXPIRED',
  RESOURCE_UPDATED = 'RESOURCE_UPDATED',

  // Table Events
  TABLE_CREATED = 'TABLE_CREATED',
  TABLE_CREATE_FAILED = 'TABLE_CREATE_FAILED',

  // Task Events
  TASK_CREATED = 'TASK_CREATED',
  TASK_CREATE_FAILED = 'TASK_CREATE_FAILED',

  // Job Events
  JOB_CREATED = 'JOB_CREATED',
  JOB_CREATE_FAILED = 'JOB_CREATE_FAILED',

  // Error Recovery Events
  ERROR_DETECTED = 'ERROR_DETECTED',
  ERROR_RECOVERED = 'ERROR_RECOVERED',
  ERROR_ESCALATED = 'ERROR_ESCALATED',
  ERROR_PATTERN_DETECTED = 'ERROR_PATTERN_DETECTED',

  // Optimization Events
  PROMPT_EXECUTED = 'PROMPT_EXECUTED',
  PROMPT_OPTIMIZED = 'PROMPT_OPTIMIZED',
  OPTIMIZATION_LEARNED = 'OPTIMIZATION_LEARNED',
  OPTIMIZATION_APPLIED = 'OPTIMIZATION_APPLIED',

  // System Events
  SYSTEM_STARTUP = 'SYSTEM_STARTUP',
  SYSTEM_SHUTDOWN = 'SYSTEM_SHUTDOWN',
  CONFIG_CHANGED = 'CONFIG_CHANGED',
  HEALTH_CHECK = 'HEALTH_CHECK',
  METRICS_COLLECTED = 'METRICS_COLLECTED',
}

export type EventSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface MCPEvent {
  // Unique identifier for this event instance
  event_id: string;

  // Categorized event type from EventType enum
  event_type: EventType;

  // ISO 8601 timestamp of event occurrence
  timestamp: string;

  // Event severity level
  severity: EventSeverity;

  // Component or service that generated the event
  source: string;

  // Event-specific data payload
  data: Record<string, any>;

  // Optional: Links related events together
  correlation_id?: string;

  // Optional: Trace ID for tracking the entire transaction
  trace_id?: string;

  // Optional: User or client identifier
  user_id?: string;

  // Optional: Session identifier for request tracking
  session_id?: string;

  // Optional: Parent event ID for event chains
  parent_event_id?: string;

  // Optional: Additional metadata
  metadata?: Record<string, any>;
}

/**
 * Event factory function for consistent event creation
 */
export function createEvent(
  type: EventType,
  data: Record<string, any>,
  options?: Partial<MCPEvent>
): MCPEvent {
  return {
    event_id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    event_type: type,
    timestamp: new Date().toISOString(),
    severity: options?.severity || 'info',
    source: options?.source || 'System',
    data,
    ...options,
  };
}
