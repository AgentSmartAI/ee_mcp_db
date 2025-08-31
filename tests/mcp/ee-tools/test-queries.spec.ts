/**
 * Tests for MCP server query execution functionality.
 * Validates basic queries, parameterized queries, and prepared statement caching.
 */

import { MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('MCP EE-Tools Query Tests', () => {
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

  describe('Basic SELECT Queries', () => {
    test('should execute simple SELECT query', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT * FROM documents.users LIMIT 5'
      });

      expect(result).toMatchObject({
        success: true,
        rowCount: expect.any(Number),
        rows: expect.any(Array),
        fields: expect.arrayContaining([
          expect.objectContaining({
            name: 'user_id',
            dataType: 'text'
          }),
          expect.objectContaining({
            name: 'email',
            dataType: 'text'
          })
        ]),
        executionTime: expect.any(Number),
        truncated: false
      });

      // Verify metadata
      expect(result.metadata).toMatchObject({
        requestId: expect.stringMatching(/^req_\d+_\w+$/),
        traceId: expect.stringMatching(/^mcp_\d+_\w+$/),
        queryType: 'SELECT',
        hasParameters: false,
        preparedStatement: false,
        duration: expect.any(Number)
      });
    });

    test('should handle COUNT queries', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT COUNT(*) as total FROM documents.users'
      });

      expect(result.success).toBe(true);
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]).toHaveProperty('total');
      expect(Number(result.rows[0].total)).toBeGreaterThanOrEqual(0);
    });

    test('should handle aggregate queries', async () => {
      const result = await client.callTool('query', {
        sql: `
          SELECT 
            COUNT(*) as count,
            COUNT(DISTINCT company_id) as unique_companies,
            MIN(created_at) as first_created,
            MAX(created_at) as last_created
          FROM documents.users
          WHERE is_active = true
        `
      });

      expect(result.success).toBe(true);
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]).toMatchObject({
        count: expect.any(String),
        unique_companies: expect.any(String),
        first_created: expect.any(String),
        last_created: expect.any(String)
      });
    });

    test('should handle JOIN queries', async () => {
      const result = await client.callTool('query', {
        sql: `
          SELECT 
            u.user_id,
            u.email,
            c.company_id,
            c.name as company_name
          FROM documents.users u
          JOIN documents.companies c ON u.company_id = c.company_id
          LIMIT 5
        `
      });

      expect(result.success).toBe(true);
      expect(result.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'user_id' }),
          expect.objectContaining({ name: 'email' }),
          expect.objectContaining({ name: 'company_id' }),
          expect.objectContaining({ name: 'company_name' })
        ])
      );
    });
  });

  describe('Parameterized Queries', () => {
    test('should execute query with single parameter', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT * FROM documents.users WHERE is_active = $1',
        params: [true]
      });

      expect(result.success).toBe(true);
      expect(result.metadata.hasParameters).toBe(true);
      result.rows.forEach((row: any) => {
        expect(row.is_active).toBe(true);
      });
    });

    test('should execute query with multiple parameters', async () => {
      const result = await client.callTool('query', {
        sql: `
          SELECT * FROM documents.users 
          WHERE is_active = $1 
          AND created_at >= $2
          ORDER BY created_at DESC
          LIMIT $3
        `,
        params: [true, '2025-01-01', 10]
      });

      expect(result.success).toBe(true);
      expect(result.rowCount).toBeLessThanOrEqual(10);
      expect(result.metadata.hasParameters).toBe(true);
    });

    test('should handle different parameter types', async () => {
      // Text parameter
      const textResult = await client.callTool('query', {
        sql: 'SELECT $1::text as value',
        params: ['test string']
      });
      expect(textResult.rows[0].value).toBe('test string');

      // Number parameter
      const numberResult = await client.callTool('query', {
        sql: 'SELECT $1::integer as value',
        params: [42]
      });
      expect(numberResult.rows[0].value).toBe(42);

      // Boolean parameter
      const boolResult = await client.callTool('query', {
        sql: 'SELECT $1::boolean as value',
        params: [true]
      });
      expect(boolResult.rows[0].value).toBe(true);

      // Null parameter
      const nullResult = await client.callTool('query', {
        sql: 'SELECT $1::text as value',
        params: [null]
      });
      expect(nullResult.rows[0].value).toBeNull();

      // Array parameter
      const arrayResult = await client.callTool('query', {
        sql: 'SELECT $1::text[] as value',
        params: [['a', 'b', 'c']]
      });
      expect(arrayResult.rows[0].value).toEqual(['a', 'b', 'c']);
    });

    test('should handle JSON/JSONB parameters', async () => {
      const jsonData = { key: 'value', nested: { prop: 123 } };
      
      const result = await client.callTool('query', {
        sql: 'SELECT $1::jsonb as data, $1::jsonb->\'key\' as key_value',
        params: [JSON.stringify(jsonData)]
      });

      expect(result.success).toBe(true);
      expect(JSON.parse(result.rows[0].data)).toEqual(jsonData);
      expect(result.rows[0].key_value).toBe('"value"');
    });
  });

  describe('Query Options', () => {
    test('should respect maxRows option', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT * FROM documents.users',
        options: {
          maxRows: 3
        }
      });

      expect(result.success).toBe(true);
      expect(result.rowCount).toBeLessThanOrEqual(3);
      expect(result.truncated).toBe(true);
    });

    test('should handle query timeout', async () => {
      // This query should timeout
      const result = await client.callTool('query', {
        sql: 'SELECT pg_sleep(2)',
        options: {
          timeout: 1000 // 1 second timeout
        }
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timeout|cancel/i);
    });
  });

  describe('Prepared Statement Caching', () => {
    test('should cache and reuse prepared statements', async () => {
      // Execute the same parameterized query multiple times
      const sql = 'SELECT * FROM documents.users WHERE user_id = $1';
      
      const results = await Promise.all([
        client.callTool('query', { sql, params: ['USER-AUS1-000001'] }),
        client.callTool('query', { sql, params: ['USER-AUS1-000002'] }),
        client.callTool('query', { sql, params: ['USER-AUS1-000003'] })
      ]);

      results.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.metadata.preparedStatement).toBe(true);
      });

      // The metadata should show cache statistics
      const lastResult = results[results.length - 1];
      if (lastResult.metadata.preparedStatements) {
        expect(lastResult.metadata.preparedStatements.hits).toBeGreaterThan(0);
        expect(lastResult.metadata.preparedStatements.hitRate).toBeGreaterThan(0);
      }
    });
  });

  describe('Query Result Formatting', () => {
    test('should properly format date/time values', async () => {
      const result = await client.callTool('query', {
        sql: `
          SELECT 
            CURRENT_TIMESTAMP as timestamp_value,
            CURRENT_DATE as date_value,
            CURRENT_TIME as time_value
        `
      });

      expect(result.success).toBe(true);
      const row = result.rows[0];
      
      // Timestamp should be ISO format
      expect(row.timestamp_value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      
      // Date should be YYYY-MM-DD format
      expect(row.date_value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      
      // Time should include hours:minutes:seconds
      expect(row.time_value).toMatch(/^\d{2}:\d{2}:\d{2}/);
    });

    test('should handle NULL values correctly', async () => {
      const result = await client.callTool('query', {
        sql: `
          SELECT 
            NULL::text as null_text,
            NULL::integer as null_int,
            NULL::boolean as null_bool,
            NULL::jsonb as null_json
        `
      });

      expect(result.success).toBe(true);
      const row = result.rows[0];
      
      expect(row.null_text).toBeNull();
      expect(row.null_int).toBeNull();
      expect(row.null_bool).toBeNull();
      expect(row.null_json).toBeNull();
    });

    test('should handle large text values', async () => {
      const longText = 'A'.repeat(1000);
      
      const result = await client.callTool('query', {
        sql: 'SELECT $1::text as long_value',
        params: [longText]
      });

      expect(result.success).toBe(true);
      expect(result.rows[0].long_value).toBe(longText);
    });
  });

  describe('Query Performance', () => {
    test('should track execution time', async () => {
      const result = await client.callTool('query', {
        sql: 'SELECT COUNT(*) FROM documents.users'
      });

      expect(result.executionTime).toBeDefined();
      expect(result.executionTime).toBeGreaterThan(0);
      expect(result.executionTime).toBeLessThan(5000); // Should complete within 5 seconds
      
      expect(result.metadata.duration).toBeDefined();
      expect(result.metadata.duration).toBeGreaterThanOrEqual(result.executionTime);
    });

    test('should handle large result sets efficiently', async () => {
      const startTime = Date.now();
      
      const result = await client.callTool('query', {
        sql: 'SELECT * FROM documents.users',
        options: {
          maxRows: 100
        }
      });

      const totalTime = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(totalTime).toBeLessThan(2000); // Should stream results quickly
    });
  });
});