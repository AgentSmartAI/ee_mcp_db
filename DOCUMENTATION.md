# PostgreSQL MCP Server - Complete Documentation

## Table of Contents

1. [Overview](#overview)
2. [Installation & Setup](#installation--setup)
3. [Configuration](#configuration)
4. [Available Tools](#available-tools)
5. [Query Syntax & Examples](#query-syntax--examples)
6. [Parameter Formatting](#parameter-formatting)
7. [Error Handling](#error-handling)
8. [Best Practices](#best-practices)
9. [Troubleshooting](#troubleshooting)

## Overview

The PostgreSQL MCP Server provides a secure, production-ready interface for interacting with PostgreSQL databases through the Model Context Protocol. It supports both read-only and full database operations (when enabled), with comprehensive monitoring, logging, and error handling.

## Installation & Setup

### Prerequisites

- Node.js 18+
- PostgreSQL 12+
- npm or yarn

### Basic Installation

```bash
npm install
npm run build
```

### Environment Configuration

Create a `.env` file with your database configuration:

```bash
# Database Connection
DB_HOST=localhost
DB_PORT=5432
DB_NAME=your_database
DB_USER=your_user
DB_PASSWORD=your_password
DB_SCHEMA=public

# Server Configuration
MCP_PORT=8090
ENABLE_WRITE_OPERATIONS=false
ENABLE_MANAGED_TABLES=false

# Security
AUTH_ENABLED=false
MCP_API_KEY=your-api-key
CORS_ENABLED=true
CORS_ORIGINS=*

# Performance
QUERY_TIMEOUT_MS=30000
MAX_RESULT_ROWS=10000
CONNECTION_POOL_MAX=10
USE_PREPARED_STATEMENTS=true
PREPARED_STATEMENT_CACHE_SIZE=100
PREPARED_STATEMENT_TTL_SECONDS=3600
BATCH_QUERY_TIMEOUT_MS=60000
BATCH_QUERY_MAX_PARALLEL=5
```

### Running the Server

```bash
# Development
npm run dev

# Production
npm start
```

## Configuration

### Database Configuration

- `DB_HOST`: PostgreSQL host (default: localhost)
- `DB_PORT`: PostgreSQL port (default: 5432)
- `DB_NAME`: Database name
- `DB_USER`: Database user
- `DB_PASSWORD`: Database password
- `DB_SCHEMA`: Default schema (default: public)
- `DB_SSL_ENABLED`: Enable SSL connection (default: false)

### Server Configuration

- `MCP_PORT`: Server port (default: 8090)
- `ENABLE_WRITE_OPERATIONS`: Allow INSERT/UPDATE/DELETE (default: false)
- `ENABLE_MANAGED_TABLES`: Enable managed table creation tool (default: false)
- `QUERY_TIMEOUT_MS`: Query timeout in milliseconds (default: 30000)
- `MAX_RESULT_ROWS`: Maximum rows to return (default: 10000)

### Security Configuration

- `AUTH_ENABLED`: Enable API key authentication (default: false)
- `MCP_API_KEY`: API key for authentication
- `ALLOWED_IPS`: Comma-separated list of allowed IP addresses
- `CORS_ENABLED`: Enable CORS (default: true)
- `CORS_ORIGINS`: Allowed origins (default: *)

## Available Tools

### 1. help

Get comprehensive documentation about available tools.

```json
{
  "tool": "help",
  "arguments": {
    "topic": "query"  // Optional: tools, query, schema, filesystem, errors, parameters
  }
}
```

### 2. query

Execute SQL queries with parameterized support and automatic prepared statement caching.

```json
{
  "tool": "query",
  "arguments": {
    "sql": "SELECT * FROM users WHERE age > $1 AND city = $2",
    "params": [18, "New York"],
    "options": {
      "timeout": 30000,
      "maxRows": 1000
    }
  }
}
```

**Features:**

- Parameterized queries with $1, $2, etc.
- Automatic prepared statement caching for better performance
- Read-only by default (SELECT, WITH, EXPLAIN)
- Write operations when enabled (INSERT, UPDATE, DELETE)
- DDL operations when enabled (CREATE, ALTER, DROP)
- Configurable timeout and row limits

### 3. batch_query

Execute multiple queries efficiently with transaction support.

```json
{
  "tool": "batch_query",
  "arguments": {
    "queries": [
      {
        "sql": "INSERT INTO users (name, email) VALUES ($1, $2)",
        "params": ["John Doe", "john@example.com"],
        "name": "insert_user"
      },
      {
        "sql": "INSERT INTO audit_log (action, user_email) VALUES ($1, $2)",
        "params": ["user_created", "john@example.com"],
        "name": "audit_log"
      }
    ],
    "options": {
      "transaction": true,
      "stopOnError": true,
      "timeout": 60000
    }
  }
}
```

**Features:**

- Execute multiple queries in a single request
- Transaction support (all succeed or all fail)
- Parallel execution for non-transactional batches
- Prepared statement caching across batch queries
- Individual success/failure tracking
- Configurable timeout for entire batch

### 4. list_tables

List all tables in the current schema.

```json
{
  "tool": "list_tables",
  "arguments": {
    "search": "user"  // Optional: filter by name pattern
  }
}
```

**Returns:**

- Table names
- Row counts
- Table types (BASE TABLE, VIEW)

### 5. describe_table

Get detailed information about a table structure.

```json
{
  "tool": "describe_table",
  "arguments": {
    "table_name": "users",
    "include_stats": true
  }
}
```

**Returns:**

- Column definitions (name, type, nullable, default)
- Primary keys
- Foreign keys
- Indexes
- Constraints
- Triggers

### 6. list_databases

List all accessible databases on the server.

```json
{
  "tool": "list_databases",
  "arguments": {}
}
```

**Returns:**

- Database names
- Sizes
- Connection limits
- Active connections

### 7. sequential_thinking

Process complex database tasks step-by-step.

```json
{
  "tool": "sequential_thinking",
  "arguments": {
    "task": "Analyze user engagement metrics for the last 30 days",
    "context": {
      "tables": ["users", "events", "sessions"],
      "requirements": ["Daily active users", "Average session duration"]
    }
  }
}
```

### 8. create_managed_table (Optional)

Create tables with standard columns and automatic management features.
**Note:** Requires `ENABLE_MANAGED_TABLES=true`

```json
{
  "tool": "create_managed_table",
  "arguments": {
    "table_name": "products",
    "id_prefix": "PRD_",
    "additional_columns": "name VARCHAR(255) NOT NULL, price DECIMAL(10,2), category VARCHAR(100)"
  }
}
```

**Standard columns added:**

- `id`: Auto-generated with prefix (e.g., PRD_12345678)
- `created_at`: Timestamp with timezone
- `updated_at`: Timestamp with timezone (auto-updated)

### 9. Filesystem Tools

#### read_file

```json
{
  "tool": "read_file",
  "arguments": {
    "path": "/path/to/file.sql"
  }
}
```

#### write_file

```json
{
  "tool": "write_file",
  "arguments": {
    "path": "/path/to/output.json",
    "content": "{ \"data\": \"content\" }"
  }
}
```

#### list_directory

```json
{
  "tool": "list_directory",
  "arguments": {
    "path": "/path/to/directory",
    "recursive": false
  }
}
```

#### create_directory

```json
{
  "tool": "create_directory",
  "arguments": {
    "path": "/path/to/new/directory"
  }
}
```

#### get_file_info

```json
{
  "tool": "get_file_info",
  "arguments": {
    "path": "/path/to/file"
  }
}
```

## Query Syntax & Examples

### Basic SELECT Queries

```sql
-- Simple query
SELECT * FROM users WHERE active = true;

-- With parameters
SELECT id, name, email FROM users WHERE age > $1 AND city = $2;

-- Aggregation
SELECT department, COUNT(*) as count, AVG(salary) as avg_salary 
FROM employees 
GROUP BY department;

-- Joins
SELECT u.name, o.order_date, o.total 
FROM users u 
JOIN orders o ON u.id = o.user_id 
WHERE o.status = 'completed';
```

### Advanced Queries

```sql
-- CTEs (Common Table Expressions)
WITH active_users AS (
  SELECT * FROM users WHERE last_login > NOW() - INTERVAL '30 days'
)
SELECT city, COUNT(*) FROM active_users GROUP BY city;

-- Window Functions
SELECT 
  name,
  salary,
  department,
  RANK() OVER (PARTITION BY department ORDER BY salary DESC) as salary_rank
FROM employees;

-- JSON operations
SELECT * FROM products WHERE specs @> '{"color": "red"}';
SELECT data->>'customer_id' as customer_id FROM orders WHERE data ? 'priority';
```

### Write Operations (when enabled)

```sql
-- INSERT
INSERT INTO users (name, email, age) VALUES ($1, $2, $3);

-- UPDATE
UPDATE users SET last_login = NOW() WHERE id = $1;

-- DELETE
DELETE FROM sessions WHERE created_at < NOW() - INTERVAL '7 days';

-- UPSERT
INSERT INTO user_settings (user_id, theme, notifications) 
VALUES ($1, $2, $3)
ON CONFLICT (user_id) 
DO UPDATE SET theme = EXCLUDED.theme, notifications = EXCLUDED.notifications;
```

## Parameter Formatting

### Basic Types

```json
{
  "sql": "SELECT * FROM users WHERE age > $1 AND name = $2 AND active = $3",
  "params": [18, "John Doe", true]
}
```

### Null Values

```json
{
  "sql": "SELECT * FROM users WHERE deleted_at IS $1",
  "params": [null]
}
```

### Dates and Timestamps

```json
{
  "sql": "SELECT * FROM events WHERE created_at BETWEEN $1 AND $2",
  "params": ["2024-01-01", "2024-12-31T23:59:59Z"]
}
```

### Arrays

```json
{
  "sql": "SELECT * FROM products WHERE category = ANY($1)",
  "params": [["electronics", "computers", "phones"]]
}
```

### JSON/JSONB

```json
{
  "sql": "INSERT INTO settings (user_id, preferences) VALUES ($1, $2)",
  "params": [123, {"theme": "dark", "language": "en", "notifications": true}]
}
```

### Type Casting

```json
{
  "sql": "SELECT * FROM users WHERE created_at > $1::timestamp",
  "params": ["2024-01-15 10:30:00"]
}
```

## Error Handling

### Common Errors and Solutions

#### Connection Errors

- **"connection refused"**: Check if PostgreSQL is running and accessible
- **"password authentication failed"**: Verify credentials in configuration
- **"SSL required"**: Enable SSL in configuration with DB_SSL_ENABLED=true

#### Query Errors

- **"relation does not exist"**: Check table name and schema
- **"column does not exist"**: Verify column names in describe_table
- **"syntax error"**: Check SQL syntax, quotes, and keywords
- **"permission denied"**: User lacks required privileges

#### Parameter Errors

- **"expected N arguments, got M"**: Match parameter count with $1, $2 placeholders
- **"invalid input syntax for type"**: Check data type compatibility

### Error Response Format

```json
{
  "content": [{
    "type": "error",
    "text": "Error: relation \"users\" does not exist\nCode: INVALID_OBJECT"
  }],
  "metadata": {
    "duration_ms": 45,
    "error": {
      "code": "INVALID_OBJECT",
      "message": "relation \"users\" does not exist",
      "query": "SELECT * FROM users"
    }
  }
}
```

## Best Practices

### Query Optimization

1. **Use indexes**: Create indexes on frequently queried columns
2. **Limit results**: Always use LIMIT for large tables
3. **Avoid SELECT ***: Specify only needed columns
4. **Use EXPLAIN**: Analyze query plans for optimization

### Security

1. **Always use parameters**: Never concatenate SQL strings
2. **Validate input**: Check data types and ranges
3. **Principle of least privilege**: Use minimum required permissions
4. **Enable SSL**: Use encrypted connections in production

### Connection Management

1. **Connection pooling**: Let the server manage connections
2. **Timeout configuration**: Set appropriate query timeouts
3. **Monitor pool health**: Check /health endpoint regularly

### Error Handling

1. **Log errors**: All errors are logged with context
2. **Handle timeouts**: Implement retry logic for transient failures
3. **Validate queries**: Test queries before production use

## Troubleshooting

### Debugging Connection Issues

```bash
# Test database connection
psql -h localhost -p 5432 -U your_user -d your_database

# Check server logs
tail -f logs/postgres-mcp-*.log

# Monitor health endpoint
curl http://localhost:8090/health
```

### Performance Issues

1. **Slow queries**:
   - Check execution time in response metadata
   - Use EXPLAIN ANALYZE to identify bottlenecks
   - Add appropriate indexes

2. **Connection pool exhaustion**:
   - Increase CONNECTION_POOL_MAX
   - Check for long-running queries
   - Monitor pool statistics in logs

3. **Memory issues**:
   - Reduce MAX_RESULT_ROWS
   - Use pagination for large datasets
   - Optimize queries to return less data

### Common Configuration Issues

1. **Write operations not working**: Set ENABLE_WRITE_OPERATIONS=true
2. **Managed tables unavailable**: Set ENABLE_MANAGED_TABLES=true
3. **CORS errors**: Configure CORS_ORIGINS appropriately
4. **Authentication failures**: Verify MCP_API_KEY matches client configuration

## Support

For issues, questions, or contributions:

- GitHub Issues: [Report bugs or request features]
- Logs: Check `logs/` directory for detailed error information
- Health Check: `GET /health` for server status

## Version History

- v2.0.0: Added SSE transport, managed tables, comprehensive help system
- v1.5.0: Added write operations support, enhanced security
- v1.0.0: Initial release with read-only operations
