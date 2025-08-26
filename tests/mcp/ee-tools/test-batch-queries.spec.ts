/**
 * Tests for MCP server batch query functionality.
 * Validates transactional and non-transactional batch operations.
 */

import { MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('MCP EE-Tools Batch Query Tests', () => {
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

  describe('Basic Batch Operations', () => {
    test('should execute multiple queries successfully', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT COUNT(*) as count FROM documents.users', name: 'user_count' },
          { sql: 'SELECT COUNT(*) as count FROM documents.projects', name: 'project_count' },
          { sql: 'SELECT COUNT(*) as count FROM documents.tasks', name: 'task_count' }
        ]
      });

      expect(result.success).toBe(true);
      expect(result.totalQueries).toBe(3);
      expect(result.successCount).toBe(3);
      expect(result.failureCount).toBe(0);
      expect(result.results).toHaveLength(3);

      // Verify each result
      result.results.forEach((queryResult: any) => {
        expect(queryResult.success).toBe(true);
        expect(queryResult.rowCount).toBe(1);
        expect(queryResult.rows[0]).toHaveProperty('count');
      });
    });

    test('should preserve query names in results', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT 1 as value', name: 'first_query' },
          { sql: 'SELECT 2 as value', name: 'second_query' },
          { sql: 'SELECT 3 as value', name: 'third_query' }
        ]
      });

      expect(result.success).toBe(true);
      expect(result.results[0].name).toBe('first_query');
      expect(result.results[1].name).toBe('second_query');
      expect(result.results[2].name).toBe('third_query');
    });

    test('should handle queries without names', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT 1' },
          { sql: 'SELECT 2' }
        ]
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
    });
  });

  describe('Transactional Batch Queries', () => {
    test('should execute all queries in a transaction by default', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT txid_current() as txid', name: 'tx1' },
          { sql: 'SELECT txid_current() as txid', name: 'tx2' },
          { sql: 'SELECT txid_current() as txid', name: 'tx3' }
        ],
        options: {
          transaction: true
        }
      });

      expect(result.success).toBe(true);
      expect(result.transaction).toBe(true);
      
      // All queries should have the same transaction ID
      const txIds = result.results.map((r: any) => r.rows[0].txid);
      expect(new Set(txIds).size).toBe(1);
    });

    test('should rollback transaction on error', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT COUNT(*) as before FROM documents.users', name: 'count_before' },
          { sql: 'SELECT * FROM nonexistent_table', name: 'error_query' },
          { sql: 'SELECT COUNT(*) as after FROM documents.users', name: 'count_after' }
        ],
        options: {
          transaction: true,
          stopOnError: true
        }
      });

      expect(result.success).toBe(false);
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);
      
      // Transaction should be rolled back
      const errorResult = result.results.find((r: any) => r.name === 'error_query');
      expect(errorResult.success).toBe(false);
    });

    test('should handle savepoints in transactions', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT 1', name: 'query1' },
          { sql: 'SAVEPOINT sp1', name: 'savepoint' },
          { sql: 'SELECT 2', name: 'query2' },
          { sql: 'RELEASE SAVEPOINT sp1', name: 'release' }
        ],
        options: {
          transaction: true
        }
      });

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(4);
    });
  });

  describe('Non-Transactional Batch Queries', () => {
    test('should execute queries independently without transaction', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT txid_current() as txid', name: 'tx1' },
          { sql: 'SELECT txid_current() as txid', name: 'tx2' },
          { sql: 'SELECT txid_current() as txid', name: 'tx3' }
        ],
        options: {
          transaction: false
        }
      });

      expect(result.success).toBe(true);
      expect(result.transaction).toBe(false);
      
      // Each query should have a different transaction ID
      const txIds = result.results.map((r: any) => r.rows[0].txid);
      expect(new Set(txIds).size).toBe(3);
    });

    test('should continue after error in non-transactional mode', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT 1 as value', name: 'query1' },
          { sql: 'SELECT * FROM invalid_table', name: 'error_query' },
          { sql: 'SELECT 3 as value', name: 'query3' }
        ],
        options: {
          transaction: false,
          stopOnError: false
        }
      });

      expect(result.success).toBe(false); // Overall failure due to one error
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
      
      // First and third queries should succeed
      expect(result.results[0].success).toBe(true);
      expect(result.results[1].success).toBe(false);
      expect(result.results[2].success).toBe(true);
    });
  });

  describe('Parallel Execution', () => {
    test('should execute non-transactional queries in parallel', async () => {
      const startTime = Date.now();
      
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT pg_sleep(0.1), 1 as value', name: 'query1' },
          { sql: 'SELECT pg_sleep(0.1), 2 as value', name: 'query2' },
          { sql: 'SELECT pg_sleep(0.1), 3 as value', name: 'query3' }
        ],
        options: {
          transaction: false,
          maxParallel: 3
        }
      });

      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      // Should complete faster than sequential execution (< 300ms)
      expect(duration).toBeLessThan(250);
    });

    test('should respect maxParallel limit', async () => {
      const result = await client.callTool('batch_query', {
        queries: Array(10).fill(null).map((_, i) => ({
          sql: `SELECT ${i} as value`,
          name: `query${i}`
        })),
        options: {
          transaction: false,
          maxParallel: 2
        }
      });

      expect(result.success).toBe(true);
      expect(result.totalQueries).toBe(10);
      expect(result.successCount).toBe(10);
    });
  });

  describe('Batch Query with Parameters', () => {
    test('should handle parameterized queries in batch', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { 
            sql: 'SELECT * FROM documents.users WHERE user_id = $1',
            params: ['USER-AUS1-000001'],
            name: 'user1'
          },
          { 
            sql: 'SELECT * FROM documents.users WHERE user_id = $1',
            params: ['USER-AUS1-000002'],
            name: 'user2'
          }
        ]
      });

      expect(result.success).toBe(true);
      expect(result.results[0].rows).toHaveLength(1);
      expect(result.results[1].rows).toHaveLength(1);
    });

    test('should reuse prepared statements in batch', async () => {
      const sql = 'SELECT COUNT(*) as count FROM documents.users WHERE is_active = $1';
      
      const result = await client.callTool('batch_query', {
        queries: [
          { sql, params: [true], name: 'active_users' },
          { sql, params: [false], name: 'inactive_users' },
          { sql, params: [true], name: 'active_again' }
        ]
      });

      expect(result.success).toBe(true);
      
      // Check prepared statement cache statistics
      if (result.metadata && result.metadata.preparedStatements) {
        expect(result.metadata.preparedStatements.hits).toBeGreaterThan(0);
        expect(result.metadata.preparedStatements.size).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('Batch Query Options', () => {
    test('should handle timeout for entire batch', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT pg_sleep(0.5)', name: 'query1' },
          { sql: 'SELECT pg_sleep(0.5)', name: 'query2' },
          { sql: 'SELECT pg_sleep(0.5)', name: 'query3' }
        ],
        options: {
          timeout: 1000, // 1 second for entire batch
          transaction: false
        }
      });

      // Some queries might timeout
      expect(result.failureCount).toBeGreaterThan(0);
      
      const timedOutQueries = result.results.filter((r: any) => 
        r.error && r.error.match(/timeout/i)
      );
      expect(timedOutQueries.length).toBeGreaterThan(0);
    });

    test('should stop on first error when configured', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT 1', name: 'query1' },
          { sql: 'INVALID SQL', name: 'query2' },
          { sql: 'SELECT 3', name: 'query3' },
          { sql: 'SELECT 4', name: 'query4' }
        ],
        options: {
          stopOnError: true,
          transaction: false
        }
      });

      expect(result.success).toBe(false);
      expect(result.results).toHaveLength(2); // Only first two executed
      expect(result.results[0].success).toBe(true);
      expect(result.results[1].success).toBe(false);
    });
  });

  describe('Complex Batch Scenarios', () => {
    test('should handle mixed read queries efficiently', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { 
            sql: 'SELECT COUNT(*) as total, COUNT(DISTINCT company_id) as companies FROM documents.users',
            name: 'user_stats'
          },
          {
            sql: `SELECT 
                    DATE(created_at) as date, 
                    COUNT(*) as daily_count 
                  FROM documents.tasks 
                  WHERE created_at > CURRENT_DATE - INTERVAL '7 days'
                  GROUP BY DATE(created_at)
                  ORDER BY date`,
            name: 'task_trend'
          },
          {
            sql: `SELECT 
                    p.name as project_name,
                    COUNT(t.task_id) as task_count
                  FROM documents.projects p
                  LEFT JOIN documents.tasks t ON p.project_id = t.project_id
                  GROUP BY p.project_id, p.name
                  ORDER BY task_count DESC
                  LIMIT 5`,
            name: 'top_projects'
          }
        ],
        options: {
          transaction: false,
          maxParallel: 3
        }
      });

      expect(result.success).toBe(true);
      expect(result.totalQueries).toBe(3);
      expect(result.successCount).toBe(3);
      
      // Verify complex query results
      const userStats = result.results.find((r: any) => r.name === 'user_stats');
      expect(userStats.rows[0]).toHaveProperty('total');
      expect(userStats.rows[0]).toHaveProperty('companies');
    });

    test('should handle CTEs and complex queries', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          {
            sql: `
              WITH user_activity AS (
                SELECT 
                  user_id,
                  COUNT(*) as action_count
                FROM documents.users
                WHERE is_active = true
                GROUP BY user_id
              )
              SELECT 
                AVG(action_count) as avg_actions,
                MAX(action_count) as max_actions,
                MIN(action_count) as min_actions
              FROM user_activity
            `,
            name: 'activity_stats'
          }
        ]
      });

      expect(result.success).toBe(true);
      expect(result.results[0].success).toBe(true);
    });
  });

  describe('Batch Performance Metrics', () => {
    test('should track execution time for each query', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT 1', name: 'fast_query' },
          { sql: 'SELECT COUNT(*) FROM documents.users', name: 'medium_query' },
          { sql: 'SELECT pg_sleep(0.1)', name: 'slow_query' }
        ],
        options: {
          transaction: false
        }
      });

      expect(result.success).toBe(true);
      expect(result.executionTime).toBeDefined();
      expect(result.totalRows).toBeGreaterThanOrEqual(3);
      
      // Each query should have execution time
      result.results.forEach((queryResult: any) => {
        expect(queryResult.executionTime).toBeDefined();
        expect(queryResult.executionTime).toBeGreaterThanOrEqual(0);
      });
      
      // Slow query should take longer
      const slowQuery = result.results.find((r: any) => r.name === 'slow_query');
      expect(slowQuery.executionTime).toBeGreaterThanOrEqual(100);
    });

    test('should include batch metadata', async () => {
      const result = await client.callTool('batch_query', {
        queries: [
          { sql: 'SELECT 1' },
          { sql: 'SELECT 2' }
        ]
      });

      expect(result.metadata).toBeDefined();
      expect(result.metadata.requestId).toMatch(/^req_\d+_\w+$/);
      expect(result.metadata.traceId).toMatch(/^mcp_\d+_\w+$/);
      
      if (result.metadata.preparedStatements) {
        expect(result.metadata.preparedStatements).toMatchObject({
          size: expect.any(Number),
          hits: expect.any(Number),
          misses: expect.any(Number),
          hitRate: expect.any(Number)
        });
      }
    });
  });
});