# Comprehensive Logging Enhancements

This document describes the comprehensive logging enhancements added throughout the PostgreSQL Read-Only MCP Server application.

## Overview

Enhanced logging has been added to all major components with appropriate log levels:

- **TRACE**: Very detailed flow information
- **DEBUG**: Useful debugging information
- **INFO**: Important events and milestones
- **WARN**: Potential issues and security events
- **ERROR**: Failures and exceptions

## Components Enhanced

### 1. Main Entry Point (`src/index.ts`)

- Added startup logger for early initialization logging
- Enhanced process lifecycle logging (startup, shutdown, signals)
- Added environment and configuration logging
- Improved error handling with detailed stack traces
- Added process warning handlers

### 2. PostgresReadOnlyMCPServer (`src/server/PostgresReadOnlyMCPServer.ts`)

- Enhanced initialization sequence logging
- Added detailed tool registration logging
- Improved request/response lifecycle tracking
- Added performance metrics (startup time, execution duration)
- Enhanced health check logging with detailed stats

### 3. SSEServerTransport (`src/server/transports/SSEServerTransport.ts`)

- Added request ID tracking for all HTTP requests
- Enhanced authentication logging with security context
- Detailed SSE client lifecycle tracking
- Improved heartbeat cycle logging with metrics
- Added performance tracking for JSON-RPC messages

### 4. PostgresConnectionManager (`src/database/PostgresConnectionManager.ts`)

- Added connection pool lifecycle logging
- Enhanced query execution tracking with query IDs
- Improved health monitoring with state change detection
- Added reconnection attempt tracking
- Detailed performance metrics (connection time, query time, pool stats)

### 5. QueryValidator (`src/database/QueryValidator.ts`)

- Added validation ID tracking
- Enhanced security logging for forbidden keywords/patterns
- Detailed parameter validation logging
- Added context extraction for security violations

### 6. QueryExecutorTool (`src/tools/QueryExecutorTool.ts`)

- Enhanced query execution flow tracking
- Added detailed parameter and option logging
- Improved error categorization and logging
- Added performance metrics at each stage

### 7. SchemaExplorerTool (`src/tools/SchemaExplorerTool.ts`)

- Added detailed query building logging
- Enhanced table and schema fetching tracking
- Added row count fetching metrics
- Improved error context logging

### 8. Configuration Components

- **ConfigurationManager**: Added early console logging for configuration loading
- **ServerConfig**: Added validation and security configuration logging
- **DatabaseConfig**: Added connection parameter logging (with password masking)

## Security Logging

Special attention has been paid to security-related logging:

1. **Authentication Attempts**
   - Failed API key attempts with IP and user agent
   - IP allowlist violations with full context
   - All auth checks are logged at appropriate levels

2. **Query Security**
   - Forbidden SQL keywords detection with context
   - Dangerous pattern detection with match details
   - Query validation failures with reasons

3. **Connection Security**
   - SSL configuration logging
   - Connection attempt tracking
   - Failed connection details

## Performance Metrics

The following performance metrics are now tracked:

1. **Request/Response Timing**
   - Total request duration
   - Query execution time
   - Connection acquisition time
   - Response preparation time

2. **Resource Usage**
   - Memory usage at startup/shutdown
   - Connection pool statistics
   - Active client counts
   - Heartbeat cycle performance

3. **Query Performance**
   - Validation time
   - Execution time
   - Result processing time
   - Row count fetching time

## Log Message Format

All log messages follow a consistent format:

```json
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "level": "info",
  "message": "Descriptive message",
  "service": "postgres-read-only-mcp",
  "module": "ComponentName",
  "requestId": "req_123456_abc",
  "duration": 123,
  "metadata": { ... }
}
```

## Usage Tips

1. **Development**: Set `LOG_LEVEL=TRACE` for maximum detail
2. **Production**: Use `LOG_LEVEL=INFO` for important events only
3. **Debugging**: Use `LOG_LEVEL=DEBUG` for troubleshooting
4. **Security Monitoring**: Watch for WARN level auth/security events

## Log Rotation

Logs are automatically rotated daily with configurable retention:

- Default: 7 days retention
- Configurable via `LOG_MAX_FILES` environment variable
- Maximum file size configurable via `LOG_MAX_SIZE`
