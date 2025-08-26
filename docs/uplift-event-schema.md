# Event Schema Documentation

## Overview

This document defines the event schemas and types used in the PostgreSQL MCP Server's event-driven architecture. Events are the foundation for monitoring, learning, and self-repair mechanisms.

## Core Event Structure

```typescript
interface MCPEvent {
  // Unique identifier for this event instance
  event_id: string;
  
  // Categorized event type from EventType enum
  event_type: EventType;
  
  // ISO 8601 timestamp of event occurrence
  timestamp: string;
  
  // Event severity level
  severity: 'info' | 'warn' | 'error' | 'critical';
  
  // Component or service that generated the event
  source: string;
  
  // Event-specific data payload
  data: Record<string, any>;
  
  // Optional: Links related events together
  correlation_id?: string;
  
  // Optional: User or client identifier
  user_id?: string;
  
  // Optional: Session identifier for request tracking
  session_id?: string;
  
  // Optional: Parent event ID for event chains
  parent_event_id?: string;
  
  // Optional: Additional metadata
  metadata?: Record<string, any>;
}
```

## Event Categories and Types

### 1. Query Events

#### QUERY_EXECUTED

Emitted when a query is successfully executed.

```typescript
{
  event_id: "evt_query_123456",
  event_type: "QUERY_EXECUTED",
  timestamp: "2024-01-20T10:30:00.000Z",
  severity: "info",
  source: "QueryExecutorTool",
  data: {
    query: "SELECT * FROM users WHERE active = true",
    query_hash: "a1b2c3d4",
    execution_time_ms: 45,
    row_count: 150,
    database: "main",
    schema: "public",
    tables_accessed: ["users"],
    index_used: ["users_active_idx"],
    cache_hit: false
  },
  user_id: "client_789",
  session_id: "sess_abc123"
}
```

#### QUERY_FAILED

Emitted when a query execution fails.

```typescript
{
  event_id: "evt_query_fail_789",
  event_type: "QUERY_FAILED",
  timestamp: "2024-01-20T10:31:00.000Z",
  severity: "error",
  source: "QueryExecutorTool",
  data: {
    query: "SELECT * FROM non_existent_table",
    error_code: "42P01",
    error_message: "relation \"non_existent_table\" does not exist",
    error_position: 14,
    suggested_fix: "Check table name spelling or schema",
    recovery_attempted: true,
    recovery_strategy: "SUGGEST_SIMILAR_TABLES"
  },
  user_id: "client_789",
  session_id: "sess_abc123"
}
```

#### QUERY_SLOW

Emitted when a query exceeds performance thresholds.

```typescript
{
  event_id: "evt_slow_query_456",
  event_type: "QUERY_SLOW",
  timestamp: "2024-01-20T10:32:00.000Z",
  severity: "warn",
  source: "QueryExecutorTool",
  data: {
    query: "SELECT * FROM large_table WHERE unindexed_column = ?",
    execution_time_ms: 5432,
    threshold_ms: 1000,
    row_count: 50000,
    full_table_scan: true,
    missing_indexes: ["unindexed_column"],
    optimization_suggestions: [
      {
        type: "CREATE_INDEX",
        sql: "CREATE INDEX idx_large_table_unindexed ON large_table(unindexed_column)",
        estimated_improvement: 0.95
      }
    ]
  }
}
```

#### QUERY_OPTIMIZED

Emitted when a query is automatically optimized.

```typescript
{
  event_id: "evt_optimized_789",
  event_type: "QUERY_OPTIMIZED",
  timestamp: "2024-01-20T10:33:00.000Z",
  severity: "info",
  source: "QueryOptimizer",
  data: {
    original_query: "SELECT * FROM orders WHERE status = 'pending'",
    optimized_query: "SELECT * FROM orders WHERE status = 'pending' AND created_at > NOW() - INTERVAL '7 days'",
    optimization_type: "ADD_TIME_CONSTRAINT",
    original_execution_time_ms: 3000,
    optimized_execution_time_ms: 150,
    improvement_factor: 20,
    confidence_score: 0.95
  },
  parent_event_id: "evt_slow_query_456"
}
```

### 2. Connection Events

#### CONN_CREATED

Emitted when a new database connection is established.

```typescript
{
  event_id: "evt_conn_create_111",
  event_type: "CONN_CREATED",
  timestamp: "2024-01-20T10:34:00.000Z",
  severity: "info",
  source: "ConnectionManager",
  data: {
    connection_id: "conn_xyz789",
    pool_name: "main",
    pool_size: 10,
    active_connections: 5,
    idle_connections: 5,
    connection_time_ms: 23
  }
}
```

#### CONN_FAILED

Emitted when a connection attempt fails.

```typescript
{
  event_id: "evt_conn_fail_222",
  event_type: "CONN_FAILED",
  timestamp: "2024-01-20T10:35:00.000Z",
  severity: "error",
  source: "ConnectionManager",
  data: {
    error_code: "ECONNREFUSED",
    error_message: "connect ECONNREFUSED 127.0.0.1:5432",
    retry_count: 3,
    max_retries: 5,
    backoff_ms: 1000,
    pool_name: "main"
  }
}
```

#### POOL_EXHAUSTED

Emitted when the connection pool reaches capacity.

```typescript
{
  event_id: "evt_pool_exhausted_333",
  event_type: "POOL_EXHAUSTED",
  timestamp: "2024-01-20T10:36:00.000Z",
  severity: "warn",
  source: "ConnectionManager",
  data: {
    pool_name: "main",
    max_size: 20,
    active_connections: 20,
    waiting_requests: 5,
    avg_wait_time_ms: 500,
    suggested_action: "INCREASE_POOL_SIZE",
    auto_scaling_triggered: true
  }
}
```

### 3. Resource Events

#### RESOURCE_ACCESSED

Emitted when a resource is accessed.

```typescript
{
  event_id: "evt_resource_access_444",
  event_type: "RESOURCE_ACCESSED",
  timestamp: "2024-01-20T10:37:00.000Z",
  severity: "info",
  source: "ResourceManager",
  data: {
    resource_uri: "postgres://table/public.users",
    resource_type: "table",
    access_type: "READ",
    cache_hit: true,
    response_time_ms: 5,
    content_size_bytes: 2048
  },
  user_id: "client_789"
}
```

#### RESOURCE_CACHED

Emitted when a resource is cached.

```typescript
{
  event_id: "evt_resource_cache_555",
  event_type: "RESOURCE_CACHED",
  timestamp: "2024-01-20T10:38:00.000Z",
  severity: "info",
  source: "ResourceCache",
  data: {
    resource_uri: "postgres://schema/public",
    cache_key: "schema:public:v1",
    ttl_seconds: 300,
    size_bytes: 10240,
    compression_ratio: 0.65,
    evicted_items: 2
  }
}
```

### 4. Error Recovery Events

#### ERROR_DETECTED

Emitted when an error pattern is recognized.

```typescript
{
  event_id: "evt_error_detect_666",
  event_type: "ERROR_DETECTED",
  timestamp: "2024-01-20T10:39:00.000Z",
  severity: "error",
  source: "ErrorDetector",
  data: {
    error_pattern: "DEADLOCK_DETECTED",
    error_signature: "deadlock detected",
    occurrence_count: 3,
    time_window_seconds: 60,
    affected_queries: ["query_123", "query_456"],
    recovery_strategy: "RETRY_WITH_BACKOFF",
    confidence: 0.98
  }
}
```

#### ERROR_RECOVERED

Emitted when automatic recovery succeeds.

```typescript
{
  event_id: "evt_error_recover_777",
  event_type: "ERROR_RECOVERED",
  timestamp: "2024-01-20T10:40:00.000Z",
  severity: "info",
  source: "ErrorRecoveryEngine",
  data: {
    error_pattern: "CONNECTION_TIMEOUT",
    recovery_strategy: "CONNECTION_RESET",
    recovery_time_ms: 150,
    actions_taken: [
      "CLOSE_STALE_CONNECTIONS",
      "RESET_CONNECTION_POOL",
      "VERIFY_CONNECTIVITY"
    ],
    success: true,
    prevented_failures: 10
  },
  parent_event_id: "evt_error_detect_666"
}
```

### 5. Optimization Events

#### PROMPT_EXECUTED

Emitted when a prompt template is executed.

```typescript
{
  event_id: "evt_prompt_exec_888",
  event_type: "PROMPT_EXECUTED",
  timestamp: "2024-01-20T10:41:00.000Z",
  severity: "info",
  source: "PromptRegistry",
  data: {
    prompt_name: "sql_select_builder",
    prompt_version: "1.2.0",
    arguments: {
      table: "orders",
      columns: ["id", "status", "total"],
      conditions: ["status = 'pending'"]
    },
    execution_time_ms: 25,
    token_count: 150,
    success: true
  },
  user_id: "client_789"
}
```

#### OPTIMIZATION_LEARNED

Emitted when the system learns a new optimization pattern.

```typescript
{
  event_id: "evt_learn_999",
  event_type: "OPTIMIZATION_LEARNED",
  timestamp: "2024-01-20T10:42:00.000Z",
  severity: "info",
  source: "LearningEngine",
  data: {
    pattern_type: "MISSING_INDEX",
    pattern_signature: "full_scan_on_large_table",
    occurrences: 25,
    avg_improvement: 0.85,
    confidence: 0.92,
    rule_created: {
      name: "suggest_index_for_frequent_filters",
      conditions: ["table_size > 10000", "filter_selectivity < 0.1"],
      action: "SUGGEST_INDEX"
    }
  }
}
```

## Event Processing Rules

### Event Routing

```typescript
const EVENT_ROUTES = {
  // Critical events trigger immediate action
  CRITICAL: [
    EventType.POOL_EXHAUSTED,
    EventType.CONN_FAILED,
    EventType.ERROR_ESCALATED
  ],
  
  // Warning events trigger analysis
  WARNING: [
    EventType.QUERY_SLOW,
    EventType.RESOURCE_EXPIRED,
    EventType.HIGH_ERROR_RATE
  ],
  
  // Info events for metrics and learning
  INFO: [
    EventType.QUERY_EXECUTED,
    EventType.RESOURCE_ACCESSED,
    EventType.PROMPT_EXECUTED
  ]
};
```

### Event Correlation

Events can be correlated using:

1. `correlation_id` - Groups related events across a request
2. `parent_event_id` - Links cause and effect events
3. `session_id` - Groups events within a user session

### Event Retention

```typescript
const RETENTION_POLICIES = {
  // Keep critical events for analysis
  CRITICAL: {
    duration: '90 days',
    storage: 'long_term'
  },
  
  // Keep warnings for pattern detection
  WARNING: {
    duration: '30 days',
    storage: 'medium_term'
  },
  
  // Keep info events for metrics
  INFO: {
    duration: '7 days',
    storage: 'short_term',
    sampling_rate: 0.1 // Sample 10% after 24 hours
  }
};
```

## Event Triggers and Actions

### Automatic Actions

```typescript
const EVENT_TRIGGERS = {
  [EventType.QUERY_SLOW]: [
    'ANALYZE_QUERY_PLAN',
    'SUGGEST_OPTIMIZATION',
    'UPDATE_STATISTICS'
  ],
  
  [EventType.POOL_EXHAUSTED]: [
    'SCALE_CONNECTION_POOL',
    'ALERT_OPERATORS',
    'THROTTLE_REQUESTS'
  ],
  
  [EventType.ERROR_PATTERN_DETECTED]: [
    'ACTIVATE_RECOVERY_STRATEGY',
    'LOG_PATTERN',
    'UPDATE_KNOWLEDGE_BASE'
  ]
};
```

### Event Metrics

Events are automatically aggregated into metrics:

```typescript
interface EventMetrics {
  // Counters
  total_events: number;
  events_by_type: Record<EventType, number>;
  events_by_severity: Record<Severity, number>;
  
  // Rates
  events_per_minute: number;
  error_rate: number;
  recovery_success_rate: number;
  
  // Latencies
  avg_query_time_ms: number;
  p95_query_time_ms: number;
  p99_query_time_ms: number;
  
  // System Health
  active_connections: number;
  cache_hit_rate: number;
  optimization_success_rate: number;
}
```

## Implementation Example

```typescript
// src/events/EventTypes.ts
export enum EventType {
  // Query Events
  QUERY_EXECUTED = 'QUERY_EXECUTED',
  QUERY_FAILED = 'QUERY_FAILED',
  QUERY_SLOW = 'QUERY_SLOW',
  QUERY_OPTIMIZED = 'QUERY_OPTIMIZED',
  
  // Connection Events
  CONN_CREATED = 'CONN_CREATED',
  CONN_FAILED = 'CONN_FAILED',
  CONN_TIMEOUT = 'CONN_TIMEOUT',
  POOL_EXHAUSTED = 'POOL_EXHAUSTED',
  
  // Resource Events
  RESOURCE_ACCESSED = 'RESOURCE_ACCESSED',
  RESOURCE_CACHED = 'RESOURCE_CACHED',
  RESOURCE_EXPIRED = 'RESOURCE_EXPIRED',
  
  // Error Recovery Events
  ERROR_DETECTED = 'ERROR_DETECTED',
  ERROR_RECOVERED = 'ERROR_RECOVERED',
  ERROR_ESCALATED = 'ERROR_ESCALATED',
  
  // Optimization Events
  PROMPT_EXECUTED = 'PROMPT_EXECUTED',
  PROMPT_OPTIMIZED = 'PROMPT_OPTIMIZED',
  OPTIMIZATION_LEARNED = 'OPTIMIZATION_LEARNED',
  
  // System Events
  SYSTEM_STARTUP = 'SYSTEM_STARTUP',
  SYSTEM_SHUTDOWN = 'SYSTEM_SHUTDOWN',
  CONFIG_CHANGED = 'CONFIG_CHANGED',
  HEALTH_CHECK = 'HEALTH_CHECK'
}

// Event factory function
export function createEvent(
  type: EventType,
  data: any,
  options?: Partial<MCPEvent>
): MCPEvent {
  return {
    event_id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    event_type: type,
    timestamp: new Date().toISOString(),
    severity: options?.severity || 'info',
    source: options?.source || 'System',
    data,
    ...options
  };
}
```

## Event Storage Format

Events are stored in JSONL format for efficient streaming and processing:

```jsonl
{"event_id":"evt_1234","event_type":"QUERY_EXECUTED","timestamp":"2024-01-20T10:30:00.000Z","severity":"info","source":"QueryExecutor","data":{"query":"SELECT 1","execution_time_ms":5}}
{"event_id":"evt_1235","event_type":"QUERY_SLOW","timestamp":"2024-01-20T10:31:00.000Z","severity":"warn","source":"QueryExecutor","data":{"query":"SELECT * FROM large_table","execution_time_ms":5000}}
```

## Best Practices

1. **Event Design**
   - Keep events immutable
   - Include all relevant context
   - Use consistent naming conventions
   - Avoid sensitive data in events

2. **Event Processing**
   - Process events asynchronously
   - Handle processing failures gracefully
   - Implement circuit breakers
   - Monitor event queue depth

3. **Event Storage**
   - Implement retention policies
   - Use compression for old events
   - Index by common query patterns
   - Regular archival of old events

## Conclusion

This event schema provides a robust foundation for monitoring, learning, and self-repair in the PostgreSQL MCP Server. The structured approach enables powerful analytics and automation while maintaining system observability.
