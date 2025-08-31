# Trace ID and Session ID Documentation

## Overview

The MCP server now includes comprehensive transaction tracking through Trace IDs and Session IDs. These identifiers help with debugging, monitoring, and tracking the flow of requests through the system.

## Trace ID

### Format
- Pattern: `mcp_[timestamp]_[random]`
- Example: `mcp_1704067200000_a1b2c3d4`

### Purpose
- Uniquely identifies each individual MCP transaction/request
- Tracks a single request through all components and tools
- Helps correlate logs and events for a specific operation

### Generation
- Generated automatically when a tool is called
- Created using the `TraceIdGenerator` utility
- Includes timestamp for chronological ordering

### Usage
- Included in all log entries
- Passed through tool execution context
- Returned in response metadata
- Added to event tracking

## Session ID

### Format
- Pattern: `session_[timestamp]_[random]`
- Example: `session_1704067200000_xyz789ab`

### Purpose
- Groups related requests within a connection session
- Helps identify requests from the same client connection
- Useful for analyzing client behavior and session patterns

### Generation
- Generated for each request batch
- Created when a tool request is received
- Unique per request chain

### Usage
- Included in all log entries alongside trace ID
- Passed through tool execution context
- Available for session-based analytics

## Implementation Details

### Response Structure
All tool responses now include trace ID in their metadata:
```json
{
  "content": [...],
  "_meta": {
    "traceId": "mcp_1704067200000_a1b2c3d4"
  }
}
```

### Tool Metadata
Tool execution results include:
```json
{
  "metadata": {
    "duration_ms": 125,
    "traceId": "mcp_1704067200000_a1b2c3d4",
    "row_count": 10
  }
}
```

### Logging Format
All log entries now include both IDs:
```json
{
  "message": "Tool call received",
  "tool": "query",
  "requestId": "req_1704067200000_abc123",
  "traceId": "mcp_1704067200000_a1b2c3d4",
  "sessionId": "session_1704067200000_xyz789ab"
}
```

## Benefits

1. **Debugging**: Easily trace requests through the system
2. **Performance Analysis**: Track execution times across components
3. **Error Tracking**: Correlate errors with specific transactions
4. **Session Analysis**: Understand client usage patterns
5. **Audit Trail**: Complete record of all operations

## Usage Examples

### Finding all logs for a transaction:
```bash
grep "mcp_1704067200000_a1b2c3d4" logs/*.log
```

### Analyzing session activity:
```bash
grep "session_1704067200000_xyz789ab" logs/*.log | jq '.message'
```

### Tracking slow queries:
Look for trace IDs in slow query events and correlate with the full transaction logs.

## Future Enhancements

1. Persistent session tracking across reconnections
2. Parent-child trace relationships for sub-operations
3. Distributed tracing support
4. Session analytics dashboard