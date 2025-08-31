# MCP EE-Tools Test Suite

This directory contains comprehensive integration tests for the EE-Tools MCP (Model Context Protocol) server.

## Test Files

### 1. `test-connection.spec.ts`
Tests database connection functionality:
- Basic connection establishment
- Database listing with statistics
- Connection error handling
- Server health checks
- Concurrent request handling

### 2. `test-queries.spec.ts`
Tests query execution:
- Basic SELECT queries
- Parameterized queries with various data types
- Query options (maxRows, timeout)
- Prepared statement caching
- Result formatting and performance tracking

### 3. `test-error-handling.spec.ts`
Comprehensive error scenario testing:
- SQL syntax errors
- Invalid table/column references
- Parameter type mismatches
- Permission/access errors
- Query timeouts
- Batch query error handling
- Filesystem errors
- Error message quality and diagnostics

### 4. `test-batch-queries.spec.ts`
Tests batch query operations:
- Basic batch execution
- Transactional vs non-transactional batches
- Parallel execution
- Error handling with stopOnError
- Mixed success/failure scenarios
- Performance metrics

### 5. `test-schema-tools.spec.ts`
Tests schema exploration tools:
- Table listing with filtering
- Table description with columns, constraints, indexes
- Foreign key relationship mapping
- Data type information
- Schema navigation
- Performance considerations

## Running Tests

### Using Make targets:
```bash
# Run all MCP tests
make test-mcp

# Run specific test suites
make test-mcp-connection
make test-mcp-queries
make test-mcp-errors
make test-mcp-batch
make test-mcp-schema

# Run quick smoke tests
make test-mcp-quick

# Run full test suite
make test-mcp-full
```

### Using npm directly:
```bash
# Run all MCP tests
npm run test -- tests/mcp/ee-tools/

# Run specific test file
npm run test -- tests/mcp/ee-tools/test-connection.spec.ts

# Run with coverage
npm run test:coverage -- tests/mcp/ee-tools/

# Run in watch mode
npm run test:watch -- tests/mcp/ee-tools/
```

## Environment Variables

Required:
- `DATABASE_URL`: PostgreSQL connection string

Optional:
- `TEST_DATABASE_URL`: Separate database for testing
- `LOG_LEVEL`: Set to 'error' to reduce noise during tests

## Test Database Setup

Tests expect a PostgreSQL database with the `documents` schema containing tables like:
- users
- projects
- tasks
- companies
- And many others...

## CI/CD Integration

Add to your GitHub Actions workflow:
```yaml
- name: Run MCP Server Tests
  run: make test-mcp
  env:
    DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
```

## Writing New Tests

1. Create a new test file following the naming pattern: `test-[feature].spec.ts`
2. Import required MCP client libraries
3. Set up client connection in `beforeAll`
4. Group related tests in `describe` blocks
5. Include both success and failure scenarios
6. Test error messages for clarity and actionability
7. Add corresponding Make target in the Makefile

## Test Patterns

### Success Path Testing
- Verify correct results
- Check response structure
- Validate metadata (requestId, traceId)
- Test performance metrics

### Error Path Testing
- Verify error codes
- Check error messages for clarity
- Ensure suggestions are provided where appropriate
- Test graceful degradation

### Performance Testing
- Set reasonable timeout expectations
- Test concurrent operations
- Verify caching mechanisms
- Check for memory leaks with large datasets