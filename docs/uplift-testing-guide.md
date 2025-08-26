# Uplift Testing Framework Guide

## Overview

This guide provides comprehensive testing strategies for validating the PostgreSQL MCP Server uplift implementation. It covers unit testing, integration testing, performance benchmarking, and error recovery validation.

## Testing Architecture

```
┌─────────────────────┐
│   Test Harness     │
├─────────────────────┤
│  Unit Tests        │ → Component isolation
│  Integration Tests │ → Feature validation  
│  Performance Tests │ → Benchmark tracking
│  E2E Tests        │ → Full system validation
│  Chaos Tests      │ → Error injection
└─────────────────────┘
```

## Test Categories

### 1. Unit Tests

#### Event System Tests

```typescript
// tests/unit/events/EventCollector.test.ts
import { EventCollector } from '../../../src/events/EventCollector';
import { MCPEvent, EventType } from '../../../src/events/EventTypes';

describe('EventCollector', () => {
  let collector: EventCollector;
  let mockLogger: jest.Mock;
  let mockStore: jest.Mock;

  beforeEach(() => {
    mockLogger = jest.fn();
    mockStore = jest.fn();
    collector = new EventCollector(mockLogger, mockStore);
  });

  describe('Event Routing', () => {
    it('should route events with event_id to events log', async () => {
      const event: MCPEvent = {
        event_id: 'test-123',
        event_type: EventType.QUERY_EXECUTED,
        timestamp: new Date(),
        severity: 'info',
        source: 'QueryExecutor',
        data: { query: 'SELECT 1' }
      };

      await collector.collect(event);

      expect(mockLogger).toHaveBeenCalledWith('events.jsonl', event);
      expect(mockStore).toHaveBeenCalledWith(event);
    });

    it('should calculate event metrics', async () => {
      const events = generateTestEvents(100);
      
      for (const event of events) {
        await collector.collect(event);
      }

      const metrics = await collector.getMetrics();
      expect(metrics.total).toBe(100);
      expect(metrics.byType[EventType.QUERY_EXECUTED]).toBeGreaterThan(0);
    });
  });

  describe('Event Processing', () => {
    it('should trigger registered processors', async () => {
      const processor = jest.fn();
      collector.registerProcessor(EventType.QUERY_FAILED, processor);

      const event = createEvent(EventType.QUERY_FAILED);
      await collector.collect(event);

      expect(processor).toHaveBeenCalledWith(event);
    });

    it('should handle processor errors gracefully', async () => {
      const failingProcessor = jest.fn().mockRejectedValue(new Error('Process failed'));
      collector.registerProcessor(EventType.QUERY_FAILED, failingProcessor);

      const event = createEvent(EventType.QUERY_FAILED);
      
      // Should not throw
      await expect(collector.collect(event)).resolves.not.toThrow();
    });
  });
});
```

#### Resource Manager Tests

```typescript
// tests/unit/resources/ResourceManager.test.ts
describe('ResourceManager', () => {
  describe('Resource Discovery', () => {
    it('should discover database resources', async () => {
      const resources = await resourceManager.listResources();
      
      expect(resources).toContainEqual(
        expect.objectContaining({
          uri: expect.stringMatching(/^postgres:\/\/schema\//),
          type: 'schema'
        })
      );
    });

    it('should cache resource content', async () => {
      const uri = 'postgres://table/public.users';
      
      // First call - hits database
      const content1 = await resourceManager.getResource(uri);
      expect(mockDb.query).toHaveBeenCalledTimes(1);
      
      // Second call - uses cache
      const content2 = await resourceManager.getResource(uri);
      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(content2).toEqual(content1);
    });
  });

  describe('Resource Subscriptions', () => {
    it('should notify subscribers on resource change', async () => {
      const callback = jest.fn();
      const uri = 'postgres://stats/connection-pool';
      
      await resourceManager.subscribe(uri, callback);
      await resourceManager.notifyChange(uri);
      
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ uri })
      );
    });
  });
});
```

### 2. Integration Tests

#### Error Recovery Flow Tests

```typescript
// tests/integration/error-recovery.test.ts
describe('Error Recovery Integration', () => {
  let server: PostgresReadOnlyMCPServer;
  let eventCollector: EventCollector;
  let errorRecovery: ErrorRecoveryEngine;

  beforeAll(async () => {
    server = await createTestServer();
    eventCollector = server.getEventCollector();
    errorRecovery = server.getErrorRecovery();
  });

  it('should recover from connection timeout', async () => {
    // Setup event listener
    const recoveryPromise = waitForEvent(eventCollector, 'ERROR_RECOVERED');

    // Inject connection timeout
    await injectConnectionTimeout(server);

    // Wait for recovery
    const recoveryEvent = await recoveryPromise;

    // Verify recovery
    expect(recoveryEvent.data.recovery_strategy).toBe('CONNECTION_RESET');
    expect(recoveryEvent.data.success).toBe(true);

    // Verify connection restored
    const health = await server.getHealth();
    expect(health.checks.database.connected).toBe(true);
  });

  it('should optimize slow queries automatically', async () => {
    // Execute slow query
    const slowQuery = `
      SELECT * FROM large_table lt
      JOIN reference_table rt ON lt.unindexed_col = rt.id
      WHERE lt.status = 'active'
    `;

    const result = await server.executeQuery(slowQuery);

    // Wait for optimization event
    const optimizationEvent = await waitForEvent(
      eventCollector, 
      'QUERY_OPTIMIZED',
      5000
    );

    // Verify optimization suggestions
    expect(optimizationEvent.data.suggestions).toContain('CREATE_INDEX');
    expect(optimizationEvent.data.optimized_query).toBeDefined();
    
    // Execute optimized query
    const optimizedResult = await server.executeQuery(
      optimizationEvent.data.optimized_query
    );

    // Compare performance
    expect(optimizedResult.executionTime).toBeLessThan(
      result.executionTime * 0.5
    );
  });
});
```

#### Prompt Optimization Tests

```typescript
// tests/integration/prompt-optimization.test.ts
describe('Prompt Optimization', () => {
  it('should improve prompt performance over time', async () => {
    const promptName = 'sql_select_builder';
    const testCases = generateTestCases(50);
    
    const initialMetrics = [];
    const optimizedMetrics = [];

    // Execute prompt multiple times
    for (const testCase of testCases) {
      const result = await promptRegistry.executePrompt(promptName, testCase);
      initialMetrics.push(result.executionTime);
    }

    // Trigger optimization
    await promptStore.optimizePrompt(promptName);

    // Execute optimized prompt
    for (const testCase of testCases) {
      const result = await promptRegistry.executePrompt(promptName, testCase);
      optimizedMetrics.push(result.executionTime);
    }

    // Calculate improvement
    const initialAvg = average(initialMetrics);
    const optimizedAvg = average(optimizedMetrics);
    const improvement = (initialAvg - optimizedAvg) / initialAvg;

    expect(improvement).toBeGreaterThan(0.2); // 20% improvement
  });
});
```

### 3. Performance Benchmarks

```typescript
// tests/performance/benchmarks.test.ts
describe('Performance Benchmarks', () => {
  const BASELINE_METRICS = {
    simpleQuery: 50,      // ms
    complexQuery: 500,    // ms
    eventProcessing: 10,  // ms
    resourceFetch: 100,   // ms
  };

  describe('Query Performance', () => {
    it('should meet simple query baseline', async () => {
      const query = 'SELECT * FROM small_table LIMIT 100';
      const metrics = await measureQueryPerformance(query, 100);
      
      expect(metrics.p50).toBeLessThan(BASELINE_METRICS.simpleQuery);
      expect(metrics.p95).toBeLessThan(BASELINE_METRICS.simpleQuery * 1.5);
      expect(metrics.p99).toBeLessThan(BASELINE_METRICS.simpleQuery * 2);
    });

    it('should optimize complex queries', async () => {
      const complexQuery = generateComplexQuery();
      
      // Measure baseline
      const baseline = await measureQueryPerformance(complexQuery, 10);
      
      // Enable optimization
      await optimizer.enableAutoOptimization();
      
      // Measure with optimization
      const optimized = await measureQueryPerformance(complexQuery, 10);
      
      expect(optimized.p50).toBeLessThan(baseline.p50 * 0.7);
    });
  });

  describe('Event Processing Performance', () => {
    it('should handle high event throughput', async () => {
      const eventRate = 1000; // events per second
      const duration = 10; // seconds
      
      const results = await loadTest({
        generator: () => generateRandomEvent(),
        rate: eventRate,
        duration: duration,
        processor: (event) => eventCollector.collect(event)
      });

      expect(results.processed).toBe(eventRate * duration);
      expect(results.failed).toBe(0);
      expect(results.p95Latency).toBeLessThan(BASELINE_METRICS.eventProcessing);
    });
  });
});
```

### 4. Chaos Testing

```typescript
// tests/chaos/error-injection.test.ts
describe('Chaos Testing', () => {
  let chaosEngine: ChaosEngine;

  beforeEach(() => {
    chaosEngine = new ChaosEngine(server);
  });

  describe('Connection Failures', () => {
    it('should handle random connection drops', async () => {
      const chaos = await chaosEngine.start({
        scenario: 'CONNECTION_CHAOS',
        probability: 0.1, // 10% failure rate
        duration: 60000   // 1 minute
      });

      // Run normal operations
      const operations = [];
      for (let i = 0; i < 100; i++) {
        operations.push(
          server.executeQuery('SELECT 1')
            .catch(err => ({ error: err }))
        );
      }

      const results = await Promise.all(operations);
      const failures = results.filter(r => r.error).length;
      const recoveries = await chaos.getRecoveryCount();

      // Should recover from most failures
      expect(recoveries).toBeGreaterThan(failures * 0.8);
      
      await chaos.stop();
    });
  });

  describe('Resource Exhaustion', () => {
    it('should handle connection pool exhaustion', async () => {
      // Flood with connections
      const connections = [];
      for (let i = 0; i < 200; i++) {
        connections.push(server.getConnection());
      }

      // Wait for pool exhaustion event
      const exhaustionEvent = await waitForEvent(
        eventCollector,
        'POOL_EXHAUSTED'
      );

      // Verify self-healing triggered
      const healingEvent = await waitForEvent(
        eventCollector,
        'POOL_HEALED',
        10000
      );

      expect(healingEvent.data.actions).toContain('EXPAND_POOL');
      expect(healingEvent.data.newSize).toBeGreaterThan(100);
    });
  });
});
```

### 5. End-to-End Tests

```typescript
// tests/e2e/full-workflow.test.ts
describe('End-to-End Workflows', () => {
  it('should handle complete query optimization workflow', async () => {
    // 1. Client connects
    const client = await createTestClient();
    
    // 2. Execute problematic query
    const slowQuery = 'SELECT * FROM orders WHERE status = ? AND created > ?';
    const result1 = await client.query(slowQuery, ['pending', '2024-01-01']);
    
    // 3. System detects slow query
    const slowQueryEvent = await waitForEvent(
      eventCollector,
      'QUERY_SLOW'
    );
    
    // 4. Optimizer analyzes query
    const analysisEvent = await waitForEvent(
      eventCollector,
      'QUERY_ANALYZED'
    );
    
    // 5. System suggests optimization
    const suggestion = await client.getOptimizationSuggestion(slowQuery);
    expect(suggestion.type).toBe('CREATE_INDEX');
    
    // 6. Apply optimization (simulated)
    await applyOptimization(suggestion);
    
    // 7. Re-run query
    const result2 = await client.query(slowQuery, ['pending', '2024-01-01']);
    
    // 8. Verify improvement
    expect(result2.executionTime).toBeLessThan(result1.executionTime * 0.3);
    
    // 9. Check learning event
    const learningEvent = await waitForEvent(
      eventCollector,
      'OPTIMIZATION_LEARNED'
    );
    expect(learningEvent.data.pattern).toBe('MISSING_INDEX_ON_FILTER');
  });
});
```

## Test Data Management

### Test Data Generator

```typescript
class TestDataGenerator {
  generateEvents(count: number, distribution: EventDistribution): MCPEvent[] {
    // Generate realistic event distributions
  }

  generateQueries(complexity: 'simple' | 'medium' | 'complex'): string[] {
    // Generate test queries of varying complexity
  }

  generateErrors(types: ErrorType[]): Error[] {
    // Generate specific error scenarios
  }
}
```

### Test Database Setup

```sql
-- tests/fixtures/test-schema.sql
CREATE SCHEMA IF NOT EXISTS test_data;

-- Small table for quick tests
CREATE TABLE test_data.small_table (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Large table for performance tests
CREATE TABLE test_data.large_table (
  id SERIAL PRIMARY KEY,
  data JSONB,
  status VARCHAR(50),
  unindexed_col INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert test data
INSERT INTO test_data.large_table (data, status, unindexed_col)
SELECT 
  jsonb_build_object('value', random() * 1000),
  CASE WHEN random() < 0.7 THEN 'active' ELSE 'inactive' END,
  floor(random() * 1000)::int
FROM generate_series(1, 1000000);
```

## Test Execution

### Running Tests

```bash
# Run all tests
npm test

# Run specific test suites
npm test -- --testPathPattern=unit
npm test -- --testPathPattern=integration
npm test -- --testPathPattern=performance
npm test -- --testPathPattern=chaos

# Run with coverage
npm test -- --coverage

# Run in watch mode
npm test -- --watch
```

### CI/CD Pipeline

```yaml
# .github/workflows/test.yml
name: Test Suite

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Run unit tests
        run: npm test -- --testPathPattern=unit --coverage
      - name: Upload coverage
        uses: codecov/codecov-action@v1

  integration-tests:
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
    steps:
      - uses: actions/checkout@v2
      - name: Setup test database
        run: psql -h localhost -U postgres -f tests/fixtures/test-schema.sql
      - name: Run integration tests
        run: npm test -- --testPathPattern=integration

  performance-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Run performance benchmarks
        run: npm test -- --testPathPattern=performance
      - name: Store benchmark results
        uses: benchmark-action/github-action-benchmark@v1
        with:
          tool: 'customBiggerIsBetter'
          output-file-path: benchmark-results.json
```

## Test Reporting

### Metrics Dashboard

```typescript
class TestMetricsDashboard {
  async generateReport(): Promise<TestReport> {
    return {
      coverage: await this.getCoverageMetrics(),
      performance: await this.getPerformanceMetrics(),
      reliability: await this.getReliabilityMetrics(),
      trends: await this.getTrendAnalysis()
    };
  }
}
```

### Success Criteria

| Metric | Target | Measurement |
|--------|--------|-------------|
| Code Coverage | > 90% | Jest coverage report |
| Unit Test Pass Rate | 100% | CI/CD pipeline |
| Integration Test Pass Rate | > 98% | CI/CD pipeline |
| Performance Regression | < 5% | Benchmark comparison |
| Error Recovery Rate | > 95% | Chaos test results |
| Event Processing Latency | < 10ms p95 | Performance tests |

## Troubleshooting

### Common Test Issues

1. **Flaky Tests**
   - Use proper async/await
   - Mock external dependencies
   - Use deterministic test data

2. **Performance Variability**
   - Run on consistent hardware
   - Use performance baselines
   - Account for JIT warmup

3. **Database State**
   - Use transactions for isolation
   - Reset state between tests
   - Use separate test schemas

## Conclusion

This comprehensive testing framework ensures the reliability, performance, and correctness of the PostgreSQL MCP Server uplift. Regular execution of these tests provides confidence in the system's ability to self-heal and optimize automatically.