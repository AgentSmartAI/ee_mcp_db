/**
 * Tool for providing comprehensive help and documentation about available MCP server tools.
 * Displays usage examples, parameter formats, and common error solutions.
 */

import { StructuredLogger } from '../logging/StructuredLogger.js';
import { MCPTool, ToolResult, ToolContext } from '../types/index.js';
import { HelpArgs } from '../types/ToolArguments.js';

export class HelpTool implements MCPTool {
  name = 'help';
  description = 'Get comprehensive help and documentation for all available tools';

  inputSchema = {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          'Specific help topic (optional). Options: tools, query, schema, errors, parameters',
        enum: ['tools', 'query', 'schema', 'errors', 'parameters'],
      },
    },
  };

  constructor(
    private logger: StructuredLogger,
    private enableWriteOperations: boolean = false,
    private enableManagedTables: boolean = false
  ) {
    this.logger.info(
      'HelpTool initialized',
      {
        enableWriteOperations,
        enableManagedTables,
      },
      'HelpTool'
    );
  }

  async execute(args: HelpArgs, context?: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const { topic } = args || {};

    this.logger.debug(
      'Help requested',
      {
        requestId: context?.requestId,
        traceId: context?.traceId,
        topic,
      },
      'HelpTool'
    );

    let helpContent = '';

    if (!topic || topic === 'tools') {
      helpContent = this.getGeneralHelp();
    } else {
      switch (topic) {
        case 'query':
          helpContent = this.getQueryHelp();
          break;
        case 'schema':
          helpContent = this.getSchemaHelp();
          break;
        case 'errors':
          helpContent = this.getErrorHelp();
          break;
        case 'parameters':
          helpContent = this.getParameterHelp();
          break;
        default:
          helpContent = this.getGeneralHelp();
      }
    }

    const duration = Date.now() - startTime;

    return {
      content: [
        {
          type: 'text',
          text: helpContent,
        },
      ],
      metadata: {
        duration_ms: duration,
        traceId: context?.traceId || '',
        topic: topic || 'general',
      },
    };
  }

  private getGeneralHelp(): string {
    return `# PostgreSQL MCP Server - Help Documentation

## Available Tools

### Database Query Tools:
1. **query** - Execute SQL queries on the PostgreSQL database
   - Supports parameterized queries with $1, $2, etc.
   - Uses prepared statement caching for better performance
   - ${this.enableWriteOperations ? 'Allows both read and write operations' : 'Read-only operations (SELECT queries only)'}
   - Returns: JSON with success, rowCount, rows, fields, executionTime

2. **batch_query** - Execute multiple queries efficiently
   - Transaction support for atomic execution
   - Parallel execution for non-transactional batches
   - Prepared statement caching for repeated queries
   - Returns: Array of results with individual success/failure status

### Database Schema Tools:
3. **list_tables** - List all tables in the current schema
   - Optional: search pattern to filter tables
   - Returns: Array of table names with row counts

4. **describe_table** - Get detailed information about a table
   - Shows columns, data types, constraints, indexes
   - Includes foreign key relationships
   - Returns: Comprehensive table metadata

5. **list_databases** - List all accessible databases
   - Shows database size and connection count
   - Returns: Array of database information

${
  this.enableManagedTables
    ? `### Table Management Tool:
6. **create_managed_table** - Create tables with standard columns
   - Auto-generated IDs with custom prefix
   - Automatic created_at and updated_at timestamps
   - Built-in update triggers
   - Returns: Creation status and table details
`
    : ''
}

## Quick Examples:

### Query data:
\`\`\`json
{
  "tool": "query",
  "arguments": {
    "sql": "SELECT * FROM users WHERE active = $1 LIMIT 10",
    "params": [true]
  }
}
\`\`\`

### Batch queries:
\`\`\`json
{
  "tool": "batch_query",
  "arguments": {
    "queries": [
      { "sql": "SELECT COUNT(*) as user_count FROM users", "name": "user_count" },
      { "sql": "SELECT COUNT(*) as order_count FROM orders", "name": "order_count" },
      { "sql": "SELECT AVG(total) as avg_order FROM orders", "name": "avg_order" }
    ],
    "options": {
      "transaction": false,
      "maxParallel": 3
    }
  }
}
\`\`\`

### List tables:
\`\`\`json
{
  "tool": "list_tables",
  "arguments": {
    "search": "user"
  }
}
\`\`\`

### Get table details:
\`\`\`json
{
  "tool": "describe_table",
  "arguments": {
    "table_name": "users"
  }
}
\`\`\`

## For more specific help, use:
- help(topic: "query") - Detailed query syntax and examples
- help(topic: "schema") - Schema exploration tools
- help(topic: "errors") - Common errors and solutions
- help(topic: "parameters") - Parameter formatting guide
`;
  }

  private getQueryHelp(): string {
    const writeOpsSection = this.enableWriteOperations
      ? `
### Write Operations:
- **INSERT**: \`INSERT INTO table (col1, col2) VALUES ($1, $2)\`
- **UPDATE**: \`UPDATE table SET col1 = $1 WHERE id = $2\`
- **DELETE**: \`DELETE FROM table WHERE id = $1\`

### DDL Operations:
- **CREATE TABLE**: Table creation with constraints
- **ALTER TABLE**: Modify table structure
- **CREATE INDEX**: Add indexes for performance
- **DROP**: Remove database objects (use with caution!)
`
      : `
### Write Operations:
- **Not available** - This connection is read-only
- Only SELECT queries are allowed
- To enable writes, set ENABLE_WRITE_OPERATIONS=true
`;

    return `# Query Tool - Detailed Help

## Overview
The **query** tool executes SQL queries on the PostgreSQL database with support for parameterized queries.

## Basic Syntax:
\`\`\`json
{
  "sql": "YOUR SQL QUERY HERE",
  "params": [param1, param2, ...],  // Optional
  "options": {
    "timeout": 30000,    // Optional: timeout in milliseconds
    "maxRows": 10000     // Optional: max rows to return
  }
}
\`\`\`

## Query Types:

### Read Operations:
- **SELECT**: Retrieve data from tables
- **WITH**: Common Table Expressions (CTEs)
- **JOIN**: Combine data from multiple tables

${writeOpsSection}

## Batch Queries:
Use the **batch_query** tool for executing multiple queries efficiently:

### Transaction Batch (all succeed or all fail):
\`\`\`json
{
  "tool": "batch_query",
  "arguments": {
    "queries": [
      { "sql": "INSERT INTO users (name, email) VALUES ($1, $2)", "params": ["John", "john@example.com"], "name": "insert_user" },
      { "sql": "INSERT INTO profiles (user_email, bio) VALUES ($1, $2)", "params": ["john@example.com", "Developer"], "name": "insert_profile" }
    ],
    "options": {
      "transaction": true,
      "stopOnError": true
    }
  }
}
\`\`\`

### Parallel Batch (independent queries):
\`\`\`json
{
  "tool": "batch_query",
  "arguments": {
    "queries": [
      { "sql": "SELECT COUNT(*) FROM users", "name": "count_users" },
      { "sql": "SELECT COUNT(*) FROM orders", "name": "count_orders" },
      { "sql": "SELECT COUNT(*) FROM products", "name": "count_products" }
    ],
    "options": {
      "transaction": false,
      "maxParallel": 3
    }
  }
}
\`\`\`

## Parameter Usage:
Always use $1, $2, $3... for parameters (PostgreSQL style):
\`\`\`sql
SELECT * FROM users WHERE age > $1 AND city = $2
\`\`\`
With params: [18, "New York"]

## Advanced Examples:

### 1. Aggregation with GROUP BY:
\`\`\`json
{
  "sql": "SELECT department, COUNT(*) as count, AVG(salary) as avg_salary FROM employees WHERE hire_date > $1 GROUP BY department",
  "params": ["2023-01-01"]
}
\`\`\`

### 2. JOIN with multiple tables:
\`\`\`json
{
  "sql": "SELECT u.name, o.order_date, o.total FROM users u JOIN orders o ON u.id = o.user_id WHERE o.status = $1",
  "params": ["completed"]
}
\`\`\`

### 3. Using CTEs:
\`\`\`json
{
  "sql": "WITH active_users AS (SELECT * FROM users WHERE active = true) SELECT * FROM active_users WHERE created_at > $1",
  "params": ["2024-01-01"]
}
\`\`\`

### 4. Window functions:
\`\`\`json
{
  "sql": "SELECT name, salary, RANK() OVER (PARTITION BY department ORDER BY salary DESC) as rank FROM employees",
  "params": []
}
\`\`\`

## Query Options:
- **timeout**: Maximum execution time (default: 30000ms)
- **maxRows**: Maximum rows to return (default: 10000)

## Performance Tips:
1. Always use LIMIT for large tables
2. Create indexes on frequently queried columns
3. Use EXPLAIN ANALYZE to understand query performance
4. Avoid SELECT * in production queries
5. **Prepared Statements**: Automatically cached when using parameters
   - Reduces parsing overhead for repeated queries
   - Improves performance for similar queries
   - Cache size: 100 statements (configurable)
   - TTL: 1 hour (configurable)
6. **Batch Queries**: Use batch_query for multiple operations
   - Transaction batches for atomic operations
   - Parallel batches for independent queries
   - Reduces network round trips
`;
  }

  private getSchemaHelp(): string {
    return `# Schema Exploration Tools - Detailed Help

## Available Schema Tools:

### 1. list_tables
Lists all tables in the current schema with basic metadata.

**Usage:**
\`\`\`json
{
  "search": "user"  // Optional: filter tables by name pattern
}
\`\`\`

**Returns:**
- Table names
- Estimated row counts
- Table type (BASE TABLE, VIEW, etc.)

### 2. describe_table
Provides comprehensive information about a specific table.

**Usage:**
\`\`\`json
{
  "table_name": "users",
  "include_stats": true  // Optional: include table statistics
}
\`\`\`

**Returns:**
- **Columns**: name, data type, nullable, default value
- **Constraints**: primary keys, foreign keys, unique, check
- **Indexes**: name, columns, type, unique status
- **Triggers**: name, timing, events
- **Table stats**: row count, size, last vacuum

### 3. list_databases
Shows all accessible databases on the server.

**Returns:**
- Database names
- Sizes
- Connection limits
- Current connections

## Schema Query Examples:

### Find all tables with a specific column:
\`\`\`json
{
  "tool": "query",
  "arguments": {
    "sql": "SELECT table_name FROM information_schema.columns WHERE column_name = $1 AND table_schema = 'public'",
    "params": ["email"]
  }
}
\`\`\`

### Check foreign key relationships:
\`\`\`json
{
  "tool": "query",
  "arguments": {
    "sql": "SELECT conname, conrelid::regclass AS table_from, confrelid::regclass AS table_to FROM pg_constraint WHERE contype = 'f'",
    "params": []
  }
}
\`\`\`

### Find indexes on a table:
\`\`\`json
{
  "tool": "query",
  "arguments": {
    "sql": "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1",
    "params": ["users"]
  }
}
\`\`\`

### View table sizes:
\`\`\`json
{
  "tool": "query",
  "arguments": {
    "sql": "SELECT relname AS table, pg_size_pretty(pg_total_relation_size(relid)) AS size FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC",
    "params": []
  }
}
\`\`\`

## Best Practices:
1. Use describe_table before writing queries to understand structure
2. Check indexes before writing performance-critical queries
3. Review foreign keys to understand table relationships
4. Monitor table sizes to identify potential performance issues
`;
  }

  private getErrorHelp(): string {
    return `# Common PostgreSQL Errors - Solutions Guide

## Connection Errors:

### "connection refused"
**Causes:**
- PostgreSQL service not running
- Wrong host/port configuration
- Firewall blocking connection

**Solutions:**
- Verify PostgreSQL is running: \`systemctl status postgresql\`
- Check connection settings in configuration
- Verify network connectivity

### "password authentication failed"
**Causes:**
- Incorrect password
- Wrong username
- pg_hba.conf misconfiguration

**Solutions:**
- Verify credentials
- Check pg_hba.conf authentication method
- Ensure user exists in database

## Query Errors:

### "relation does not exist"
**Example:** \`relation "users" does not exist\`

**Causes:**
- Table doesn't exist
- Wrong schema
- Case sensitivity issue

**Solutions:**
\`\`\`sql
-- Check if table exists
SELECT * FROM information_schema.tables WHERE table_name = 'users';

-- Use schema prefix
SELECT * FROM public.users;

-- Handle case-sensitive names
SELECT * FROM "Users";  -- If table created with quotes
\`\`\`

### "column does not exist"
**Causes:**
- Typo in column name
- Column was renamed/dropped
- Case sensitivity

**Solutions:**
- Use describe_table to see actual column names
- Check for typos
- Use quotes for case-sensitive columns

### "syntax error at or near"
**Common issues:**
- Missing commas
- Incorrect quotes
- Reserved keywords

**Examples:**
\`\`\`sql
-- Wrong: Missing comma
SELECT id name FROM users

-- Correct:
SELECT id, name FROM users

-- Wrong: Mixed quotes
SELECT * FROM users WHERE name = "John'

-- Correct:
SELECT * FROM users WHERE name = 'John'
\`\`\`

### "duplicate key violates unique constraint"
**Causes:**
- Inserting duplicate value in unique column
- Primary key conflict

**Solutions:**
\`\`\`sql
-- Use ON CONFLICT
INSERT INTO users (email) VALUES ('test@example.com')
ON CONFLICT (email) DO NOTHING;

-- Or update on conflict
INSERT INTO users (id, email) VALUES (1, 'new@example.com')
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
\`\`\`

### "violates foreign key constraint"
**Causes:**
- Referenced record doesn't exist
- Trying to delete parent record

**Solutions:**
\`\`\`sql
-- Check if parent exists
SELECT * FROM parent_table WHERE id = 123;

-- Use CASCADE for related deletes
DELETE FROM parent_table WHERE id = 123 CASCADE;
\`\`\`

### "invalid input syntax for type"
**Examples:**
- \`invalid input syntax for type integer: "abc"\`
- \`invalid input syntax for type timestamp: "not-a-date"\`

**Solutions:**
\`\`\`sql
-- Validate before inserting
SELECT '123'::integer;  -- Works
SELECT 'abc'::integer;  -- Fails

-- Use proper date formats
SELECT '2024-01-15'::date;
SELECT '2024-01-15T10:30:00Z'::timestamp;
\`\`\`

## Parameter Errors:

### "expected N arguments, got M"
**Cause:** Mismatch between $1, $2 placeholders and params array

**Example:**
\`\`\`json
// Wrong - 2 placeholders, 1 parameter
{
  "sql": "SELECT * FROM users WHERE age > $1 AND city = $2",
  "params": [25]
}

// Correct
{
  "sql": "SELECT * FROM users WHERE age > $1 AND city = $2",
  "params": [25, "NYC"]
}
\`\`\`

## Performance Issues:

### Query timeout
**Solutions:**
- Add indexes on filtered columns
- Use LIMIT to reduce result size
- Optimize JOIN conditions
- Increase timeout in options

### "out of memory"
**Solutions:**
- Reduce result set with LIMIT
- Avoid SELECT *
- Use pagination for large results
- Add WHERE conditions
`;
  }

  private getParameterHelp(): string {
    return `# Parameter Formatting Guide

## PostgreSQL Parameter Style
Always use $1, $2, $3... for parameters (not ? or :name)

## Basic Examples:

### Simple parameters:
\`\`\`json
{
  "sql": "SELECT * FROM users WHERE age > $1 AND city = $2",
  "params": [18, "New York"]
}
\`\`\`

### NULL values:
\`\`\`json
{
  "sql": "SELECT * FROM users WHERE deleted_at IS $1",
  "params": [null]
}
\`\`\`

## Data Type Formatting:

### Strings:
\`\`\`json
{
  "sql": "SELECT * FROM users WHERE name = $1",
  "params": ["John O'Brien"]  // Quotes handled automatically
}
\`\`\`

### Numbers:
\`\`\`json
{
  "sql": "SELECT * FROM products WHERE price BETWEEN $1 AND $2",
  "params": [10.99, 99.99]  // Integers and decimals
}
\`\`\`

### Booleans:
\`\`\`json
{
  "sql": "SELECT * FROM users WHERE active = $1",
  "params": [true]  // or false
}
\`\`\`

### Dates and Timestamps:
\`\`\`json
{
  "sql": "SELECT * FROM events WHERE created_at > $1",
  "params": ["2024-01-15"]  // Date only
}

{
  "sql": "SELECT * FROM logs WHERE timestamp > $1",
  "params": ["2024-01-15T10:30:00Z"]  // ISO 8601 format
}
\`\`\`

### Arrays:
\`\`\`json
{
  "sql": "SELECT * FROM users WHERE id = ANY($1)",
  "params": [[1, 2, 3, 4, 5]]  // Array as single parameter
}

{
  "sql": "SELECT * FROM products WHERE tags && $1",  // Array overlap
  "params": [["electronics", "mobile"]]
}
\`\`\`

### JSON/JSONB:
\`\`\`json
{
  "sql": "INSERT INTO settings (user_id, config) VALUES ($1, $2)",
  "params": [123, {"theme": "dark", "notifications": true}]
}

{
  "sql": "SELECT * FROM logs WHERE data @> $1",  // JSONB contains
  "params": [{"level": "error"}]
}
\`\`\`

### UUID:
\`\`\`json
{
  "sql": "SELECT * FROM users WHERE id = $1",
  "params": ["550e8400-e29b-41d4-a716-446655440000"]
}
\`\`\`

## Advanced Parameter Usage:

### IN clause with arrays:
\`\`\`json
{
  "sql": "SELECT * FROM users WHERE status = ANY($1)",
  "params": [["active", "pending", "verified"]]
}
\`\`\`

### Multiple array parameters:
\`\`\`json
{
  "sql": "SELECT * FROM products WHERE category = ANY($1) AND price < $2",
  "params": [["electronics", "books"], 50.00]
}
\`\`\`

### Type casting in queries:
\`\`\`json
{
  "sql": "SELECT * FROM users WHERE created_at > $1::timestamp",
  "params": ["2024-01-15 10:30:00"]
}
\`\`\`

### LIKE patterns:
\`\`\`json
{
  "sql": "SELECT * FROM users WHERE email LIKE $1",
  "params": ["%@gmail.com"]  // % and _ handled as literals
}
\`\`\`

### Case-insensitive search:
\`\`\`json
{
  "sql": "SELECT * FROM users WHERE LOWER(name) = LOWER($1)",
  "params": ["John"]
}
\`\`\`

## Common Patterns:

### Pagination:
\`\`\`json
{
  "sql": "SELECT * FROM users ORDER BY id LIMIT $1 OFFSET $2",
  "params": [20, 40]  // 20 per page, skip 40 (page 3)
}
\`\`\`

### Optional filters:
\`\`\`json
{
  "sql": "SELECT * FROM users WHERE ($1::text IS NULL OR city = $1) AND ($2::int IS NULL OR age > $2)",
  "params": ["NYC", null]  // Filter by city only
}
\`\`\`

### Bulk insert:
\`\`\`json
{
  "sql": "INSERT INTO users (name, email) VALUES ($1, $2), ($3, $4)",
  "params": ["John", "john@example.com", "Jane", "jane@example.com"]
}
\`\`\`

## Important Notes:
1. Parameters are 1-indexed ($1, $2, not $0)
2. Parameter count must match placeholders exactly
3. PostgreSQL handles escaping automatically
4. No quotes needed around $1, $2 placeholders
5. Type casting can be done in SQL or by PostgreSQL
`;
  }
}
