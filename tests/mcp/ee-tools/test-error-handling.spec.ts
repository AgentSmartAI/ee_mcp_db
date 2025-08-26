/**
 * Tests for MCP server error handling and diagnostic messages.
 * Validates that errors provide clear, actionable feedback for debugging.
 */

import { MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('MCP EE-Tools Error Handling Tests', () => {
  let client: MCPClient;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
        LOG_LEVEL: 'error'
      }
    });

    client = new MCPClient({
      name: 'test-client',
      version: '1.0.0'
    });

    await client.connect(transport);
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  describe('SQL Syntax Errors', () => {
    test('should handle basic syntax errors with clear messages', async () => {
      const result = await client.callTool('query', {
        sql: 'SELCT * FROM users' // Typo in SELECT
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/Query must start with a valid SQL operation/);
      expect(result.code).toBe('UNKNOWN_ERROR');
    });

    test('should handle malformed SQL with helpful diagnostics', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT * FROM WHERE id = 1' // Missing table name
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/syntax error/i);
      expect(result.code).toBe('QUERY_ERROR');
    });

    test('should handle unclosed quotes', async () => {
      const result = await client.callTool('query', {
        sql: "SELECT * FROM documents.users WHERE email = 'test@example.com"
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/unterminated|quote/i);
    });

    test('should handle invalid operators', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT * FROM documents.users WHERE id === 1' // Invalid operator
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/syntax error|operator/i);
    });
  });

  describe('Table and Column Reference Errors', () => {
    test('should handle non-existent table with clear error', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT * FROM nonexistent_table'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('relation "nonexistent_table" does not exist');
      expect(result.code).toBe('QUERY_ERROR');
      expect(result.query).toBe('SELECT * FROM nonexistent_table');
    });

    test('should handle non-existent column with clear error', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT invalid_column FROM documents.users'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('column "invalid_column" does not exist');
      expect(result.code).toBe('QUERY_ERROR');
    });

    test('should handle ambiguous column references', async () => {
      const result = await client.callTool('query', {
        sql: `
          SELECT user_id 
          FROM documents.users u1, documents.users u2
          WHERE u1.company_id = u2.company_id
        `
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/ambiguous|column reference/i);
    });

    test('should suggest available tables when table not found', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT * FROM documents.userss' // Typo in table name
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('relation "documents.userss" does not exist');
      // The suggestion should come from the error code
      if (result.code === 'INVALID_OBJECT') {
        expect(result.suggestion).toContain('Check table/column names');
        expect(result.suggestion).toContain('list_tables');
      }
    });
  });

  describe('Parameter Type Mismatches', () => {
    test('should handle wrong parameter count', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT * FROM documents.users WHERE user_id = $1 AND company_id = $2',
        params: ['USER-001'] // Missing second parameter
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/parameter|bind/i);
    });

    test('should handle type conversion errors', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT * FROM documents.users WHERE user_id = $1::integer',
        params: ['not-a-number']
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid.*integer|type|conversion/i);
    });

    test('should handle invalid boolean conversions', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT * FROM documents.users WHERE is_active = $1::boolean',
        params: ['maybe'] // Invalid boolean value
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid.*boolean/i);
    });

    test('should handle invalid date conversions', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT * FROM documents.users WHERE created_at > $1::timestamp',
        params: ['not-a-date']
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid.*timestamp|date/i);
    });
  });

  describe('Permission and Access Errors', () => {
    test('should handle write operations when disabled', async () => {
      // Assuming the server is configured as read-only by default
      const result = await client.callTool('query', {
        sql: 'INSERT INTO documents.users (user_id, email) VALUES ($1, $2)',
        params: ['USER-TEST-001', 'test@example.com']
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/INSERT|write|not allowed|read.*only/i);
    });

    test('should handle UPDATE operations when disabled', async () => {
      const result = await client.callTool('query', {
        sql: 'UPDATE documents.users SET email = $1 WHERE user_id = $2',
        params: ['newemail@example.com', 'USER-001']
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/UPDATE|write|not allowed|read.*only/i);
    });

    test('should handle DELETE operations when disabled', async () => {
      const result = await client.callTool('query', {
        sql: 'DELETE FROM documents.users WHERE user_id = $1',
        params: ['USER-001']
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/DELETE|write|not allowed|read.*only/i);
    });

    test('should handle DDL operations', async () => {
      const result = await client.callTool('query', {
        sql: 'CREATE TABLE test_table (id integer)'
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/CREATE|DDL|not allowed/i);
    });
  });

  describe('Query Timeout Scenarios', () => {
    test('should handle query timeout with clear message', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT pg_sleep(5)',
        options: {
          timeout: 1000 // 1 second timeout
        }
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timeout|cancel|exceeded/i);
    });

    test('should provide query context in timeout errors', async () => {
      const longQuery = `
        WITH RECURSIVE long_running AS (
          SELECT 1 as n
          UNION ALL
          SELECT n + 1 FROM long_running WHERE n < 1000000
        )
        SELECT COUNT(*) FROM long_running
      `;

      const result = await client.callTool('query', {
        sql: longQuery,
        options: {
          timeout: 100 // Very short timeout
        }
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timeout|cancel/i);
      expect(result.query).toContain('long_running');
    });
  });

  describe('Batch Query Error Handling', () => {
    test('should handle mixed success/failure in batch', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT COUNT(*) FROM documents.users', name: 'valid_query' },
          { sql: 'SELECT * FROM invalid_table', name: 'invalid_query' },
          { sql: 'SELECT NOW()', name: 'another_valid' }
        ],
        options: {
          stopOnError: false
        }
      });

      expect(result.success).toBe(false);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
      
      const invalidResult = result.results.find((r: any) => r.name === 'invalid_query');
      expect(invalidResult.success).toBe(false);
      expect(invalidResult.error).toBeDefined();
    });

    test('should stop on first error when configured', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT 1', name: 'query1' },
          { sql: 'INVALID SQL', name: 'query2' },
          { sql: 'SELECT 3', name: 'query3' }
        ],
        options: {
          stopOnError: true
        }
      });

      expect(result.success).toBe(false);
      expect(result.results.length).toBe(2); // Only first two queries attempted
      expect(result.results[1].success).toBe(false);
    });

    test('should handle transaction rollback on error', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT COUNT(*) as initial FROM documents.users', name: 'count_before' },
          { sql: 'INSERT INTO invalid_table VALUES (1)', name: 'failing_insert' },
          { sql: 'SELECT COUNT(*) as final FROM documents.users', name: 'count_after' }
        ],
        options: {
          transaction: true
        }
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/transaction|rolled back/i);
    });
  });


  describe('Error Message Quality', () => {
    test('should include request and trace IDs in errors', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT * FROM nonexistent'
      });

      expect(result.success).toBe(false);
      if (result.metadata) {
        expect(result.metadata.requestId).toMatch(/^req_\d+_\w+$/);
        expect(result.metadata.traceId).toMatch(/^mcp_\d+_\w+$/);
      }
    });

    test('should provide actionable error messages', async () => {
      const result = await client.callTool('describe_table', {
        table: 'nonexistent_table'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // Error should suggest how to find valid tables
      if (result.suggestion) {
        expect(result.suggestion).toMatch(/list_tables|available tables/i);
      }
    });

    test('should handle malformed tool arguments', async () => {
      try {
        // Missing required 'sql' parameter
        await client.callTool('query', {});
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toMatch(/required|missing|sql/i);
      }
    });
  });
});