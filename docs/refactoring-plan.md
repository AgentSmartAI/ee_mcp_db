# PostgreSQL Read-Only MCP Server Refactoring Plan

## Overview

This document outlines a step-by-step plan to refactor the PostgreSQL Read-Only MCP Server from a monolithic structure to a modular, well-tested architecture with SSE transport support and structured logging.

## Prerequisites

- Node.js 18+ and npm installed
- PostgreSQL database access (configured in `.env`)
- Existing `.env` file with database credentials

## Environment Configuration

The application uses the following environment variables from `.env`:

```bash
# Database Configuration
DB_HOST=172.21.89.238
DB_PORT=5432
DB_NAME=documents
DB_SCHEMA=documents
DB_USER=postgres
DB_PASSWORD=dasvick01!!

# MCP Configuration
MCP_PORT=8090

# Logging Configuration
LOG_DIR=logs
LOG_LEVEL=INFO
```

## Phase 1: Infrastructure Setup (Day 1-2)

### Step 1.1: Install Dependencies

```bash
npm install --save \
  winston \
  winston-daily-rotate-file \
  express \
  express-sse \
  dotenv \
  joi \
  @types/express \
  @types/joi

npm install --save-dev \
  @types/jest \
  jest \
  ts-jest \
  @types/supertest \
  supertest \
  pg-mem
```

### Step 1.2: Create Directory Structure

```bash
mkdir -p src/{server/transports,database/types,tools,logging/types,config,types}
mkdir -p tests/{unit,integration,e2e}
mkdir -p logs
```

### Step 1.3: Implement Logging System

Create `src/logging/StructuredLogger.ts`:

```typescript
/**
 * Structured logger with JSONL format and automatic rotation.
 * Logs are written to the LOG_DIR with daily rotation and 7-day retention.
 */
```

Key features:

- JSONL format for easy parsing
- Daily rotation with timestamp
- 7-day retention policy
- Separate log file per application start
- Log levels: ERROR, WARN, INFO, DEBUG

### Step 1.4: Implement Configuration Management

Create `src/config/ConfigurationManager.ts`:

```typescript
/**
 * Centralized configuration management using environment variables.
 * Validates and provides typed access to all configuration values.
 */
```

Features:

- Environment variable validation using Joi
- Type-safe configuration access
- Default values for optional settings
- Configuration error handling

## Phase 2: Database Layer (Day 3-4)

### Step 2.1: Create Connection Manager

Create `src/database/PostgresConnectionManager.ts`:

```typescript
/**
 * Manages PostgreSQL connection pooling and lifecycle.
 * Handles connection failures, retries, and health monitoring.
 */
```

Features:

- Connection pool management
- Automatic reconnection on failure
- Connection health monitoring
- Graceful shutdown handling

### Step 2.2: Implement Query Validator

Create `src/database/QueryValidator.ts`:

```typescript
/**
 * Validates SQL queries to ensure read-only access.
 * Uses whitelist approach for allowed SQL operations.
 */
```

Features:

- Whitelist of allowed SQL keywords
- Prevention of data modification
- Support for CTEs and complex queries
- Clear error messages

### Step 2.3: Define Database Types

Create `src/database/types/QueryTypes.ts`:

```typescript
/**
 * Type definitions for database operations and results.
 * Ensures type safety throughout the application.
 */
```

## Phase 3: Tool Modularization (Day 5-6)

### Step 3.1: Query Executor Tool

Create `src/tools/QueryExecutorTool.ts`:

```typescript
/**
 * Executes validated read-only SQL queries.
 * Handles parameterized queries and result formatting.
 */
```

### Step 3.2: Schema Explorer Tool

Create `src/tools/SchemaExplorerTool.ts`:

```typescript
/**
 * Lists tables and schemas in the database.
 * Provides filtering and sorting capabilities.
 */
```

### Step 3.3: Table Inspector Tool

Create `src/tools/TableInspectorTool.ts`:

```typescript
/**
 * Provides detailed information about table structure.
 * Includes columns, constraints, indexes, and relationships.
 */
```

### Step 3.4: Database Catalog Tool

Create `src/tools/DatabaseCatalogTool.ts`:

```typescript
/**
 * Lists available databases and their metadata.
 * Shows database sizes and connection information.
 */
```

## Phase 4: SSE Transport Implementation (Day 7-8)

### Step 4.1: Create SSE Transport

Create `src/server/transports/SSEServerTransport.ts`:

```typescript
/**
 * Server-Sent Events transport for MCP communication.
 * Replaces stdio transport with HTTP-based SSE.
 */
```

Features:

- HTTP server on configurable port (MCP_PORT)
- SSE endpoint for real-time communication
- Connection management
- CORS support for web clients

### Step 4.2: Update Server Architecture

Create `src/server/PostgresReadOnlyMCPServer.ts`:

```typescript
/**
 * Main server orchestrator with modular architecture.
 * Coordinates tools, transport, and database connections.
 */
```

## Phase 5: Testing Implementation (Day 9-10)

### Step 5.1: Unit Tests

Create unit tests for each module:

``` sh
tests/unit/
├── database/
│   ├── PostgresConnectionManager.test.ts
│   └── QueryValidator.test.ts
├── tools/
│   ├── QueryExecutorTool.test.ts
│   ├── SchemaExplorerTool.test.ts
│   ├── TableInspectorTool.test.ts
│   └── DatabaseCatalogTool.test.ts
└── logging/
    └── StructuredLogger.test.ts
```

### Step 5.2: Integration Tests

Create integration tests:

``` sh
tests/integration/
├── database-connection.test.ts
├── query-execution.test.ts
└── tool-integration.test.ts
```

### Step 5.3: End-to-End Tests

Create E2E tests:

``` sh
tests/e2e/
├── mcp-server.test.ts
└── sse-transport.test.ts
```

### Step 5.4: Test Configuration

Update `package.json` with test scripts:

```json
{
  "scripts": {
    "test": "jest",
    "test:unit": "jest tests/unit",
    "test:integration": "jest tests/integration",
    "test:e2e": "jest tests/e2e",
    "test:coverage": "jest --coverage"
  }
}
```

Create `jest.config.js`:

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/types/**'
  ]
};
```

## Phase 6: Integration and Deployment (Day 11-12)

### Step 6.1: Update Entry Point

Update `src/index.ts`:

```typescript
/**
 * Application entry point with proper initialization sequence.
 * Handles graceful startup and shutdown.
 */
```

### Step 6.2: Add Health Checks

Implement health check endpoints:

- `/health` - Basic health check
- `/ready` - Readiness check (database connectivity)

### Step 6.3: Documentation Updates

Update documentation:

- README.md with new architecture
- API documentation for SSE endpoints
- Configuration guide

### Step 6.4: Migration Script

Create migration helper:

```bash
#!/bin/bash
# migrate.sh - Helps migrate from old to new structure
```

## Testing Strategy

### Unit Test Example

```typescript
// tests/unit/database/QueryValidator.test.ts
describe('QueryValidator', () => {
  it('should allow SELECT queries', () => {
    const validator = new QueryValidator();
    expect(() => validator.validate('SELECT * FROM users')).not.toThrow();
  });

  it('should reject DELETE queries', () => {
    const validator = new QueryValidator();
    expect(() => validator.validate('DELETE FROM users')).toThrow();
  });
});
```

### Integration Test Example

```typescript
// tests/integration/database-connection.test.ts
describe('Database Connection', () => {
  it('should connect to PostgreSQL', async () => {
    const manager = new PostgresConnectionManager(config);
    const pool = await manager.getPool();
    const result = await pool.query('SELECT 1');
    expect(result.rows[0]).toEqual({ '?column?': 1 });
  });
});
```

## Rollback Plan

If issues arise during migration:

1. Keep original `src/index.ts` as `src/index.legacy.ts`
2. Maintain backward compatibility during transition
3. Use feature flags to toggle between old/new implementations
4. Gradual rollout with monitoring

## Success Criteria

- [ ] All unit tests passing (>80% coverage)
- [ ] Integration tests passing
- [ ] E2E tests validating MCP protocol
- [ ] SSE transport working with multiple connections
- [ ] Structured logging with rotation working
- [ ] Performance equal or better than original
- [ ] Zero downtime migration possible

## Timeline

- **Week 1**: Infrastructure and Database Layer (Phases 1-2)
- **Week 2**: Tools and Transport (Phases 3-4)
- **Week 3**: Testing and Integration (Phases 5-6)

## Monitoring

Post-deployment monitoring:

- Log aggregation for error tracking
- Performance metrics (query times, connection pool usage)
- Health check monitoring
- SSE connection tracking

## Next Steps

1. Review and approve this plan
2. Create feature branch for refactoring
3. Begin Phase 1 implementation
4. Daily progress reviews
5. Incremental testing and validation
