# Testing Strategy for PostgreSQL Read-Only MCP Server

## Overview

This document outlines the comprehensive testing strategy for the PostgreSQL Read-Only MCP Server, including unit tests, integration tests, end-to-end tests, and performance testing.

## Testing Philosophy

- **Test Pyramid**: Heavy emphasis on unit tests, moderate integration tests, minimal E2E tests
- **Test-Driven Development**: Write tests before implementation
- **Mocking Strategy**: Mock external dependencies in unit tests
- **Real Dependencies**: Use real databases for integration tests
- **Continuous Testing**: Tests run on every commit

## Testing Stack

### Dependencies

```json
{
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "jest": "^29.5.0",
    "ts-jest": "^29.1.0",
    "@types/supertest": "^2.0.12",
    "supertest": "^6.3.3",
    "pg-mem": "^2.6.0",
    "@faker-js/faker": "^8.0.0",
    "nock": "^13.3.0"
  }
}
```

### Test Configuration

```javascript
// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/types/**',
    '!src/index.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
};
```

## Unit Tests

### 1. Database Layer Tests

#### PostgresConnectionManager Tests

```typescript
// tests/unit/database/PostgresConnectionManager.test.ts
import { PostgresConnectionManager } from '../../../src/database/PostgresConnectionManager';
import { Pool } from 'pg';

jest.mock('pg');

describe('PostgresConnectionManager', () => {
  let manager: PostgresConnectionManager;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
      end: jest.fn(),
      on: jest.fn(),
    } as any;
    
    (Pool as jest.MockedClass<typeof Pool>).mockImplementation(() => mockPool);
    
    manager = new PostgresConnectionManager({
      host: 'localhost',
      port: 5432,
      database: 'test',
      user: 'user',
      password: 'pass',
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getPool', () => {
    it('should create a new pool on first call', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] } as any);
      
      const pool = await manager.getPool();
      
      expect(Pool).toHaveBeenCalledWith({
        host: 'localhost',
        port: 5432,
        database: 'test',
        user: 'user',
        password: 'pass',
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      });
      expect(mockPool.query).toHaveBeenCalledWith('SELECT 1');
      expect(pool).toBe(mockPool);
    });

    it('should return existing pool on subsequent calls', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] } as any);
      
      const pool1 = await manager.getPool();
      const pool2 = await manager.getPool();
      
      expect(Pool).toHaveBeenCalledTimes(1);
      expect(pool1).toBe(pool2);
    });

    it('should throw error if connection fails', async () => {
      mockPool.query.mockRejectedValue(new Error('Connection failed'));
      
      await expect(manager.getPool()).rejects.toThrow('Failed to connect to PostgreSQL');
      expect(Pool).toHaveBeenCalledTimes(1);
    });
  });

  describe('close', () => {
    it('should close the pool if it exists', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] } as any);
      await manager.getPool();
      
      await manager.close();
      
      expect(mockPool.end).toHaveBeenCalled();
    });

    it('should not throw if no pool exists', async () => {
      await expect(manager.close()).resolves.not.toThrow();
    });
  });
});
```

#### QueryValidator Tests

```typescript
// tests/unit/database/QueryValidator.test.ts
import { QueryValidator } from '../../../src/database/QueryValidator';

describe('QueryValidator', () => {
  let validator: QueryValidator;

  beforeEach(() => {
    validator = new QueryValidator();
  });

  describe('validate', () => {
    describe('valid queries', () => {
      const validQueries = [
        'SELECT * FROM users',
        'SELECT id, name FROM users WHERE id = $1',
        'WITH cte AS (SELECT * FROM users) SELECT * FROM cte',
        'SELECT COUNT(*) FROM users',
        'SELECT u.*, p.* FROM users u JOIN posts p ON u.id = p.user_id',
        '  SELECT * FROM users  ', // with whitespace
        'select * from users', // lowercase
      ];

      test.each(validQueries)('should allow: %s', (query) => {
        expect(() => validator.validate(query)).not.toThrow();
      });
    });

    describe('invalid queries', () => {
      const invalidQueries = [
        ['INSERT INTO users VALUES (1)', 'INSERT'],
        ['UPDATE users SET name = $1', 'UPDATE'],
        ['DELETE FROM users WHERE id = 1', 'DELETE'],
        ['DROP TABLE users', 'DROP'],
        ['CREATE TABLE test (id INT)', 'CREATE'],
        ['ALTER TABLE users ADD COLUMN email', 'ALTER'],
        ['TRUNCATE TABLE users', 'TRUNCATE'],
        ['GRANT SELECT ON users TO public', 'GRANT'],
        ['BEGIN; SELECT * FROM users; COMMIT;', 'transaction'],
      ];

      test.each(invalidQueries)('should reject: %s', (query, keyword) => {
        expect(() => validator.validate(query)).toThrow(`${keyword} operations are not allowed`);
      });
    });

    describe('edge cases', () => {
      it('should handle empty query', () => {
        expect(() => validator.validate('')).toThrow('Query cannot be empty');
      });

      it('should handle null query', () => {
        expect(() => validator.validate(null as any)).toThrow('Query must be a string');
      });

      it('should handle query with comments', () => {
        const query = '-- This is a comment\nSELECT * FROM users';
        expect(() => validator.validate(query)).not.toThrow();
      });
    });
  });

  describe('sanitizeParams', () => {
    it('should validate parameter types', () => {
      const validParams = ['string', 123, true, null];
      expect(() => validator.sanitizeParams(validParams)).not.toThrow();
    });

    it('should reject invalid parameter types', () => {
      const invalidParams = [{ key: 'value' }];
      expect(() => validator.sanitizeParams(invalidParams)).toThrow('Invalid parameter type');
    });
  });
});
```

### 2. Tool Layer Tests

#### QueryExecutorTool Tests

```typescript
// tests/unit/tools/QueryExecutorTool.test.ts
import { QueryExecutorTool } from '../../../src/tools/QueryExecutorTool';
import { PostgresConnectionManager } from '../../../src/database/PostgresConnectionManager';
import { QueryValidator } from '../../../src/database/QueryValidator';
import { StructuredLogger } from '../../../src/logging/StructuredLogger';

jest.mock('../../../src/database/PostgresConnectionManager');
jest.mock('../../../src/database/QueryValidator');
jest.mock('../../../src/logging/StructuredLogger');

describe('QueryExecutorTool', () => {
  let tool: QueryExecutorTool;
  let mockConnectionManager: jest.Mocked<PostgresConnectionManager>;
  let mockValidator: jest.Mocked<QueryValidator>;
  let mockLogger: jest.Mocked<StructuredLogger>;
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    };

    mockConnectionManager = {
      getPool: jest.fn().mockResolvedValue(mockPool),
    } as any;

    mockValidator = {
      validate: jest.fn(),
      sanitizeParams: jest.fn((params) => params),
    } as any;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
    } as any;

    tool = new QueryExecutorTool(mockConnectionManager, mockValidator, mockLogger);
  });

  describe('execute', () => {
    it('should execute valid query successfully', async () => {
      const mockResult = {
        rows: [{ id: 1, name: 'John' }, { id: 2, name: 'Jane' }],
        rowCount: 2,
        fields: [
          { name: 'id', dataTypeID: 23 },
          { name: 'name', dataTypeID: 25 },
        ],
      };

      mockPool.query.mockResolvedValue(mockResult);

      const result = await tool.execute({
        sql: 'SELECT * FROM users',
        params: [],
      });

      expect(mockValidator.validate).toHaveBeenCalledWith('SELECT * FROM users');
      expect(mockPool.query).toHaveBeenCalledWith('SELECT * FROM users', []);
      expect(result.content[0].text).toContain('"rowCount": 2');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Query executed successfully',
        expect.objectContaining({
          rowCount: 2,
          duration: expect.any(Number),
        })
      );
    });

    it('should handle query with parameters', async () => {
      const mockResult = {
        rows: [{ id: 1, name: 'John' }],
        rowCount: 1,
        fields: [],
      };

      mockPool.query.mockResolvedValue(mockResult);

      await tool.execute({
        sql: 'SELECT * FROM users WHERE id = $1',
        params: [1],
      });

      expect(mockValidator.sanitizeParams).toHaveBeenCalledWith([1]);
      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE id = $1',
        [1]
      );
    });

    it('should handle query errors', async () => {
      mockPool.query.mockRejectedValue(new Error('Database error'));

      const result = await tool.execute({
        sql: 'SELECT * FROM invalid_table',
      });

      expect(result.content[0].text).toContain('Error: Database error');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Query execution failed',
        expect.any(Error)
      );
    });

    it('should handle validation errors', async () => {
      mockValidator.validate.mockImplementation(() => {
        throw new Error('Invalid query');
      });

      const result = await tool.execute({
        sql: 'DELETE FROM users',
      });

      expect(result.content[0].text).toContain('Error: Invalid query');
      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });

  describe('tool metadata', () => {
    it('should have correct name and description', () => {
      expect(tool.name).toBe('query');
      expect(tool.description).toContain('read-only SQL query');
    });

    it('should have valid input schema', () => {
      expect(tool.inputSchema).toMatchObject({
        type: 'object',
        properties: {
          sql: { type: 'string' },
          params: { type: 'array' },
        },
        required: ['sql'],
      });
    });
  });
});
```

### 3. Logging Tests

```typescript
// tests/unit/logging/StructuredLogger.test.ts
import { StructuredLogger } from '../../../src/logging/StructuredLogger';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

jest.mock('winston', () => ({
  createLogger: jest.fn(),
  format: {
    combine: jest.fn(),
    timestamp: jest.fn(),
    json: jest.fn(),
    printf: jest.fn(),
  },
  transports: {
    Console: jest.fn(),
  },
}));

jest.mock('winston-daily-rotate-file');

describe('StructuredLogger', () => {
  let logger: StructuredLogger;
  let mockWinstonLogger: any;

  beforeEach(() => {
    mockWinstonLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };

    (winston.createLogger as jest.Mock).mockReturnValue(mockWinstonLogger);

    logger = new StructuredLogger({
      level: 'info',
      directory: './logs',
      maxFiles: 7,
      maxSize: '20m',
    });
  });

  describe('log methods', () => {
    it('should log info messages with metadata', () => {
      logger.info('Test message', { userId: 123 });

      expect(mockWinstonLogger.info).toHaveBeenCalledWith('Test message', {
        service: 'postgres-mcp',
        userId: 123,
      });
    });

    it('should log error messages with error objects', () => {
      const error = new Error('Test error');
      logger.error('Error occurred', error);

      expect(mockWinstonLogger.error).toHaveBeenCalledWith('Error occurred', {
        service: 'postgres-mcp',
        error: {
          message: 'Test error',
          stack: expect.any(String),
        },
      });
    });

    it('should add module context', () => {
      logger.info('Query executed', { duration: 100 }, 'QueryExecutor');

      expect(mockWinstonLogger.info).toHaveBeenCalledWith('Query executed', {
        service: 'postgres-mcp',
        module: 'QueryExecutor',
        duration: 100,
      });
    });
  });

  describe('configuration', () => {
    it('should create daily rotate transport', () => {
      expect(DailyRotateFile).toHaveBeenCalledWith(
        expect.objectContaining({
          dirname: './logs',
          maxFiles: 7,
          maxSize: '20m',
        })
      );
    });

    it('should respect log level configuration', () => {
      expect(winston.createLogger).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
        })
      );
    });
  });
});
```

## Integration Tests

### Database Integration Tests

```typescript
// tests/integration/database-integration.test.ts
import { PostgresConnectionManager } from '../../src/database/PostgresConnectionManager';
import { QueryValidator } from '../../src/database/QueryValidator';
import { ConfigurationManager } from '../../src/config/ConfigurationManager';
import { newDb } from 'pg-mem';

describe('Database Integration', () => {
  let db: any;
  let connectionManager: PostgresConnectionManager;
  let validator: QueryValidator;

  beforeAll(() => {
    // Create in-memory PostgreSQL instance
    db = newDb();
    const { Pool } = db.adapters.createPg();
    
    // Mock pg module
    jest.mock('pg', () => ({ Pool }));
    
    // Create test data
    db.public.none(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        email VARCHAR(100) UNIQUE
      );
      
      INSERT INTO users (name, email) VALUES
        ('John Doe', 'john@example.com'),
        ('Jane Smith', 'jane@example.com');
    `);
  });

  beforeEach(() => {
    const config = new ConfigurationManager();
    connectionManager = new PostgresConnectionManager(config.database);
    validator = new QueryValidator();
  });

  afterEach(async () => {
    await connectionManager.close();
  });

  describe('Query Execution', () => {
    it('should execute SELECT queries', async () => {
      const pool = await connectionManager.getPool();
      const result = await pool.query('SELECT * FROM users ORDER BY id');
      
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toMatchObject({
        id: 1,
        name: 'John Doe',
        email: 'john@example.com',
      });
    });

    it('should handle parameterized queries', async () => {
      const pool = await connectionManager.getPool();
      const result = await pool.query(
        'SELECT * FROM users WHERE email = $1',
        ['jane@example.com']
      );
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('Jane Smith');
    });

    it('should reject data modification queries', async () => {
      expect(() => 
        validator.validate('DELETE FROM users WHERE id = 1')
      ).toThrow();
    });
  });

  describe('Connection Pool', () => {
    it('should reuse connections', async () => {
      const pool = await connectionManager.getPool();
      
      // Execute multiple queries
      const promises = Array(5).fill(null).map(() => 
        pool.query('SELECT COUNT(*) FROM users')
      );
      
      const results = await Promise.all(promises);
      
      results.forEach(result => {
        expect(result.rows[0].count).toBe('2');
      });
    });
  });
});
```

### Tool Integration Tests

```typescript
// tests/integration/tool-integration.test.ts
import { QueryExecutorTool } from '../../src/tools/QueryExecutorTool';
import { SchemaExplorerTool } from '../../src/tools/SchemaExplorerTool';
import { TableInspectorTool } from '../../src/tools/TableInspectorTool';
import { setupTestDatabase, cleanupTestDatabase } from '../helpers/database';

describe('Tool Integration', () => {
  let queryTool: QueryExecutorTool;
  let schemaTool: SchemaExplorerTool;
  let tableTool: TableInspectorTool;

  beforeAll(async () => {
    await setupTestDatabase();
    
    // Initialize tools with real dependencies
    const { connectionManager, validator, logger } = await createTestDependencies();
    
    queryTool = new QueryExecutorTool(connectionManager, validator, logger);
    schemaTool = new SchemaExplorerTool(connectionManager, logger);
    tableTool = new TableInspectorTool(connectionManager, logger);
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  describe('QueryExecutorTool', () => {
    it('should execute queries and return formatted results', async () => {
      const result = await queryTool.execute({
        sql: 'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
        params: ['public'],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.rows).toBeInstanceOf(Array);
      expect(data.rowCount).toBeGreaterThan(0);
    });
  });

  describe('SchemaExplorerTool', () => {
    it('should list tables in schema', async () => {
      const result = await schemaTool.execute({ schema: 'public' });
      
      const data = JSON.parse(result.content[0].text);
      expect(data.schema).toBe('public');
      expect(data.tables).toBeInstanceOf(Array);
    });
  });

  describe('TableInspectorTool', () => {
    it('should describe table structure', async () => {
      const result = await tableTool.execute({
        table: 'users',
        schema: 'public',
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.columns).toBeInstanceOf(Array);
      expect(data.constraints).toBeInstanceOf(Array);
    });
  });
});
```

## End-to-End Tests

### MCP Server E2E Tests

```typescript
// tests/e2e/mcp-server.test.ts
import request from 'supertest';
import { PostgresReadOnlyMCPServer } from '../../src/server/PostgresReadOnlyMCPServer';
import { SSEServerTransport } from '../../src/server/transports/SSEServerTransport';

describe('MCP Server E2E', () => {
  let server: PostgresReadOnlyMCPServer;
  let app: any;

  beforeAll(async () => {
    server = new PostgresReadOnlyMCPServer();
    const transport = new SSEServerTransport({ port: 0 }); // Random port
    await server.start(transport);
    app = transport.getApp();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('SSE Communication', () => {
    it('should establish SSE connection', (done) => {
      const eventSource = request(app)
        .get('/sse')
        .set('Accept', 'text/event-stream')
        .expect(200)
        .expect('Content-Type', /text\/event-stream/);

      eventSource.on('response', (res) => {
        expect(res.headers['cache-control']).toBe('no-cache');
        done();
      });
    });

    it('should handle tool list request', async () => {
      const response = await request(app)
        .post('/rpc')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        })
        .expect(200);

      expect(response.body.result.tools).toBeInstanceOf(Array);
      expect(response.body.result.tools).toContainEqual(
        expect.objectContaining({ name: 'query' })
      );
    });

    it('should execute query tool', async () => {
      const response = await request(app)
        .post('/rpc')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'query',
            arguments: {
              sql: 'SELECT 1 as test',
            },
          },
        })
        .expect(200);

      const result = JSON.parse(response.body.result.content[0].text);
      expect(result.rows[0].test).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid tool calls', async () => {
      const response = await request(app)
        .post('/rpc')
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'invalid_tool',
            arguments: {},
          },
        })
        .expect(200);

      expect(response.body.result.content[0].text).toContain('Error');
    });

    it('should validate query safety', async () => {
      const response = await request(app)
        .post('/rpc')
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'query',
            arguments: {
              sql: 'DROP TABLE users',
            },
          },
        })
        .expect(200);

      expect(response.body.result.content[0].text).toContain('not allowed');
    });
  });
});
```

## Performance Tests

```typescript
// tests/performance/query-performance.test.ts
import { performance } from 'perf_hooks';

describe('Query Performance', () => {
  describe('Large Result Sets', () => {
    it('should handle 10k rows efficiently', async () => {
      const start = performance.now();
      
      const result = await queryTool.execute({
        sql: 'SELECT generate_series(1, 10000) as id',
      });
      
      const duration = performance.now() - start;
      
      expect(duration).toBeLessThan(1000); // Under 1 second
      const data = JSON.parse(result.content[0].text);
      expect(data.rowCount).toBe(10000);
    });
  });

  describe('Concurrent Queries', () => {
    it('should handle 50 concurrent queries', async () => {
      const queries = Array(50).fill(null).map((_, i) => 
        queryTool.execute({
          sql: 'SELECT $1::int as num',
          params: [i],
        })
      );
      
      const start = performance.now();
      const results = await Promise.all(queries);
      const duration = performance.now() - start;
      
      expect(duration).toBeLessThan(5000); // Under 5 seconds
      expect(results).toHaveLength(50);
    });
  });
});
```

## Test Helpers

### Database Setup Helper

```typescript
// tests/helpers/database.ts
import { Client } from 'pg';
import { ConfigurationManager } from '../../src/config/ConfigurationManager';

export async function setupTestDatabase(): Promise<void> {
  const config = new ConfigurationManager();
  const client = new Client({
    ...config.database,
    database: 'postgres', // Connect to default database
  });

  await client.connect();

  try {
    // Create test database
    await client.query('CREATE DATABASE mcp_test');
  } catch (error) {
    // Database might already exist
  }

  await client.end();

  // Connect to test database and create schema
  const testClient = new Client({
    ...config.database,
    database: 'mcp_test',
  });

  await testClient.connect();

  await testClient.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100),
      email VARCHAR(100) UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      title VARCHAR(200),
      content TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await testClient.end();
}

export async function cleanupTestDatabase(): Promise<void> {
  const config = new ConfigurationManager();
  const client = new Client({
    ...config.database,
    database: 'postgres',
  });

  await client.connect();
  await client.query('DROP DATABASE IF EXISTS mcp_test');
  await client.end();
}
```

### Mock Factories

```typescript
// tests/helpers/mocks.ts
import { faker } from '@faker-js/faker';

export function createMockUser() {
  return {
    id: faker.number.int({ min: 1, max: 1000 }),
    name: faker.person.fullName(),
    email: faker.internet.email(),
    created_at: faker.date.past(),
  };
}

export function createMockQueryResult(rows: any[]) {
  return {
    rows,
    rowCount: rows.length,
    fields: Object.keys(rows[0] || {}).map(name => ({
      name,
      dataTypeID: 25, // VARCHAR
    })),
  };
}
```

## Continuous Integration

### GitHub Actions Configuration

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run tests
        run: npm test
        env:
          DB_HOST: localhost
          DB_PORT: 5432
          DB_USER: postgres
          DB_PASSWORD: postgres
          DB_NAME: test_db
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info
```

## Test Execution Strategy

### Local Development

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test suite
npm test -- tests/unit/database

# Run in watch mode
npm test -- --watch
```

### Pre-commit Hook

```bash
# .husky/pre-commit
#!/bin/sh
npm run test:unit
```

### Deployment Pipeline

1. Unit tests (must pass)
2. Integration tests (must pass)
3. E2E tests (must pass)
4. Performance tests (informational)
5. Security scan
6. Deploy to staging
7. Smoke tests on staging
8. Deploy to production

## Testing Best Practices

1. **Test Naming**: Use descriptive names that explain the scenario
2. **Test Data**: Use factories and fixtures for consistent test data
3. **Mocking**: Mock external dependencies but test with real implementations in integration tests
4. **Assertions**: Use specific assertions, avoid generic truthiness checks
5. **Cleanup**: Always clean up test data and connections
6. **Timeouts**: Set appropriate timeouts for async operations
7. **Error Cases**: Test both happy paths and error scenarios
8. **Performance**: Include performance benchmarks for critical paths