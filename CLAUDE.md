# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
# Install dependencies
npm install

# Build TypeScript to JavaScript
npm run build

# Development mode with auto-reload
npm run dev

# Production start
npm start

# MCP Server Management (recommended)
./start-mcp-server.sh    # Start the MCP server
./stop-mcp-server.sh     # Stop the MCP server

# Run all tests
npm test

# Run specific test suites
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests only
npm run test:e2e          # End-to-end tests only

# Run tests with coverage
npm run test:coverage

# Watch mode for test development
npm run test:watch

# Clean build artifacts
npm run clean
```

## Code Quality Commands

```bash
# Linting
npm run lint              # Check for linting errors
npm run lint:fix          # Auto-fix linting errors

# Code Formatting
npm run format            # Format code with Prettier
npm run format:check      # Check if code is formatted

# Type Checking
npm run typecheck         # Type check without building

# Code Analysis
npm run unused            # Find unused exports with ts-prune
npm run circular          # Check for circular dependencies with madge
npm run deps:check        # Find unused dependencies with depcheck
npm run knip              # Find unused files/exports/dependencies with knip

# Run all checks at once
npm run check:all         # Runs typecheck, lint, format:check, and circular
```

### Common Workflows

```bash
# Before committing code, run all checks
npm run check:all

# Fix all auto-fixable issues
npm run lint:fix && npm run format

# Check for code quality issues
npm run unused
npm run circular
npm run deps:check
```

## Running a Single Test
```bash
# Run a specific test file
npx jest path/to/test.spec.ts

# Run tests matching a pattern
npx jest --testNamePattern="should validate SELECT queries"

# Debug a specific test
node --inspect-brk node_modules/.bin/jest path/to/test.spec.ts
```

## Architecture Overview

### Core Flow
The MCP server follows a multi-layered architecture with clear separation of concerns:

1. **Entry Point** (`src/index.ts`) → **Server Orchestrator** (`PostgresReadOnlyMCPServer`) → **Streamable HTTP Transport** → **Client**
2. **Tool Execution**: Client Request → Transport → Server → Tool → Database → Response

### Key Architectural Components

#### 1. Configuration System
- **ConfigurationManager** (`src/config/ConfigurationManager.ts`): Central configuration loader using environment variables
- **Validation**: Uses Joi schemas for strict validation
- **Three config domains**: Database, Server, and Logging configurations

#### 2. Database Layer
- **PostgresConnectionManager**: Manages connection pooling, health checks, and query execution
- **QueryValidator**: Validates SQL queries based on enabled operations (read-only vs write)
- **Transaction Support**: The `createManagedTable` method shows transaction pattern usage

#### 3. Tool System
All tools implement the `MCPTool` interface:
```typescript
interface MCPTool {
  name: string;
  description: string;
  inputSchema: object;
  execute(args: any, context?: ToolContext): Promise<ToolResult>;
}
```

Tools are registered conditionally based on configuration (e.g., `CreateManagedTableTool` only when `ENABLE_MANAGED_TABLES=true`).

#### 4. Transport Layer
- **IMPORTANT**: ALWAYS use Streamable HTTP transport (default). DO NOT switch to SSE transport as it has known bugs and doesn't work properly.
- **Streamable HTTP**: Primary transport mechanism via Express server (createStreamableHttpServer.ts)
- **Session Management**: Each connection gets a unique session ID
- **MCP_TRANSPORT Environment Variable**: Leave unset to use streamable HTTP (default). Setting MCP_TRANSPORT=sse will break functionality.

#### 5. Event System
- **EventCollector**: Buffers events for batch processing
- **Event Processors**: Pluggable processors for different event types (Metrics, etc.)
- **Event Types**: Strongly typed events for different system activities

#### 6. Logging System
- **StructuredLogger**: Winston-based logger with JSONL output
- **LogRotationManager**: Automatic log file rotation (7-day retention by default)
- **Trace IDs**: Every request gets a unique trace ID for debugging

### Cross-Cutting Concerns

#### Error Handling Pattern
The codebase uses a consistent error handling pattern:
1. Tools catch errors and return structured error responses
2. Errors are enhanced with context (trace IDs, request IDs)
3. Different error types map to specific error codes

#### Security Boundaries
1. **Query Validation**: All SQL queries go through `QueryValidator`
2. **Parameter Sanitization**: Using PostgreSQL's native parameterized queries
3. **Configuration-based Access**: Write operations require explicit enablement

#### Performance Considerations
1. **Connection Pooling**: Reuses database connections
2. **Query Timeouts**: Configurable timeouts prevent long-running queries
3. **Result Limiting**: `MAX_RESULT_ROWS` prevents memory exhaustion

### Tool Development Pattern
When adding new tools:
1. Create tool class implementing `MCPTool` interface
2. Add tool-specific configuration if needed
3. Register in `PostgresReadOnlyMCPServer.initializeTools()`
4. Add event types if the tool emits events
5. Update help documentation in `HelpTool`

### Testing Strategy
- **Unit Tests**: Test individual components in isolation
- **Integration Tests**: Test database interactions
- **E2E Tests**: Test full request/response cycles
- **Coverage Requirements**: 80% minimum for all metrics

### Environment-Specific Behavior
- **Development**: More verbose logging, relaxed timeouts
- **Production**: Structured logging, strict timeouts, health monitoring
- **Testing**: May use in-memory databases or mocks

## Key Files to Understand the System

1. **src/server/PostgresReadOnlyMCPServer.ts**: Main orchestrator, shows how all components integrate
2. **src/database/PostgresConnectionManager.ts**: Database interaction patterns
3. **src/tools/QueryExecutorTool.ts**: Most complex tool, shows error handling and event patterns
4. **src/config/ConfigurationManager.ts**: Configuration loading and validation patterns
5. **src/server/createStreamableHttpServer.ts**: Primary transport layer implementation (DO NOT use createSSEServer.ts)