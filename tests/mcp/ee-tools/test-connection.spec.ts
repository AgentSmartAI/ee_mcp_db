/**
 * Tests for MCP server database connection functionality.
 * Validates connection establishment, database listing, and connection error handling.
 */

import { MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('MCP EE-Tools Connection Tests', () => {
  let client: MCPClient;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    // Initialize MCP client and transport
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
        LOG_LEVEL: 'error' // Reduce noise during tests
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

  describe('Database Connection', () => {
    test('should successfully list available databases', async () => {
      const result = await client.callTool('list_databases', {
        includeStatistics: true
      });

      expect(result).toMatchObject({
        success: true,
        databaseCount: expect.any(Number),
        currentDatabase: expect.any(String),
        serverVersion: expect.stringContaining('PostgreSQL'),
        databases: expect.arrayContaining([
          expect.objectContaining({
            database: expect.any(String),
            size: expect.any(String),
            sizeBytes: expect.any(Number),
            owner: expect.any(String),
            encoding: 'UTF8',
            isCurrent: expect.any(Boolean)
          })
        ])
      });

      // Verify metadata is present
      expect(result.metadata).toMatchObject({
        requestId: expect.stringMatching(/^req_\d+_\w+$/),
        traceId: expect.stringMatching(/^mcp_\d+_\w+$/),
        duration: expect.any(Number)
      });
    });

    test('should include database statistics when requested', async () => {
      const result = await client.callTool('list_databases', {
        includeStatistics: true
      });

      const currentDb = result.databases.find((db: any) => db.isCurrent);
      expect(currentDb).toBeDefined();
      expect(currentDb.statistics).toMatchObject({
        activeConnections: expect.any(Number),
        transactionsCommitted: expect.any(Number),
        transactionsRolledBack: expect.any(Number),
        cacheHitRatio: expect.stringMatching(/^\d+\.\d+%$/),
        tuplesReturned: expect.any(Number),
        tuplesFetched: expect.any(Number)
      });
    });

    test('should exclude system databases by default', async () => {
      const result = await client.callTool('list_databases', {
        includeSystemDatabases: false
      });

      const systemDbs = ['postgres', 'template0', 'template1'];
      const foundSystemDbs = result.databases.filter((db: any) => 
        systemDbs.includes(db.database)
      );

      expect(foundSystemDbs).toHaveLength(0);
    });

    test('should filter databases by pattern', async () => {
      const result = await client.callTool('list_databases', {
        pattern: 'doc%'
      });

      // All returned databases should match the pattern
      result.databases.forEach((db: any) => {
        expect(db.database).toMatch(/^doc/);
      });
    });
  });

  describe('Connection Error Handling', () => {
    test('should handle invalid database URL gracefully', async () => {
      // Create a new client with invalid database URL
      const invalidTransport = new StdioClientTransport({
        command: 'node',
        args: ['dist/index.js'],
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://invalid:invalid@nonexistent:5432/invalid',
          LOG_LEVEL: 'error'
        }
      });

      const invalidClient = new MCPClient({
        name: 'test-client-invalid',
        version: '1.0.0'
      });

      try {
        await invalidClient.connect(invalidTransport);
        // Connection might succeed but query should fail
        const result = await invalidClient.callTool('list_databases', {});
        
        // Should get an error result
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error).toContain('connection');
      } catch (error: any) {
        // Connection itself might fail
        expect(error.message).toMatch(/connection|ENOTFOUND|ETIMEDOUT/i);
      } finally {
        try {
          await invalidClient.close();
        } catch {
          // Ignore close errors
        }
      }
    });

    test('should provide helpful error messages for connection issues', async () => {
      // Test with missing DATABASE_URL
      const noDbUrlTransport = new StdioClientTransport({
        command: 'node',
        args: ['dist/index.js'],
        env: {
          ...process.env,
          DATABASE_URL: '', // Empty database URL
          LOG_LEVEL: 'error'
        }
      });

      const noDbUrlClient = new MCPClient({
        name: 'test-client-no-url',
        version: '1.0.0'
      });

      try {
        await noDbUrlClient.connect(noDbUrlTransport);
        fail('Expected connection to fail with empty DATABASE_URL');
      } catch (error: any) {
        expect(error.message).toMatch(/DATABASE_URL|configuration|required/i);
      }
    });
  });

  describe('Server Health Check', () => {
    test('should verify server is responsive', async () => {
      const startTime = Date.now();
      const result = await client.callTool('list_databases', {});
      const responseTime = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(responseTime).toBeLessThan(5000); // Should respond within 5 seconds
    });

    test('should handle concurrent requests', async () => {
      const promises = Array(5).fill(null).map((_, index) => 
        client.callTool('list_databases', {
          includeStatistics: index % 2 === 0 // Vary the parameters
        })
      );

      const results = await Promise.all(promises);

      results.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.databases).toBeDefined();
        expect(result.metadata.requestId).toBeDefined();
        // Each request should have a unique request ID
        const requestIds = results.map(r => r.metadata.requestId);
        expect(new Set(requestIds).size).toBe(requestIds.length);
      });
    });
  });
});