# Uplift Integration Plan - Building on Existing Architecture

## Overview

This document outlines how the uplift plan integrates with and enhances the existing PostgreSQL MCP Server architecture, rather than replacing it.

## Current Architecture Analysis

### What We Already Have

#### 1. **Modular Tool System** ✓

- QueryExecutorTool - SQL query execution with validation
- SchemaExplorerTool - Database schema discovery
- TableInspectorTool - Detailed table information
- DatabaseCatalogTool - Database listing
- SequentialThinkingTool - Complex problem solving

**Enhancement**: Add event emission to existing tools rather than rewriting them.

#### 2. **Robust Connection Management** ✓

- PostgresConnectionManager with pooling
- Health checks and monitoring
- Graceful connection handling

**Enhancement**: Add event-driven self-healing on top of existing manager.

#### 3. **Structured Logging** ✓

- JSON-formatted logs with rotation
- Module-based logging
- Comprehensive metadata

**Enhancement**: We've already added event routing - just need to integrate EventCollector.

#### 4. **Configuration System** ✓

- Environment-based configuration
- Validation with Joi schemas
- Type-safe config objects

**Enhancement**: Extend existing configs for new features.

#### 5. **SSE Transport** ✓

- Real-time communication
- Authentication middleware
- CORS support

**Enhancement**: Transport is MCP-compliant, just needs Resources/Prompts support.

## Integration Approach

### Phase 1: Event Integration (Minimal Changes)

#### 1.1 Add Event Emission to Existing Tools

```typescript
// Example: QueryExecutorTool enhancement
export class QueryExecutorTool implements MCPTool {
  constructor(
    private connectionManager: PostgresConnectionManager,
    private validator: QueryValidator,
    private logger: StructuredLogger,
    private eventCollector?: EventCollector,  // Optional for backward compatibility
    private defaultTimeout: number = 30000,
    private maxRows: number = 10000
  ) {
    // Existing code unchanged
  }

  async execute(args: any, context?: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    
    try {
      // Existing validation and execution code...
      const result = await this.executeQuery(validatedQuery);
      
      // NEW: Emit success event
      if (this.eventCollector) {
        await this.eventCollector.collect(createEvent(
          EventType.QUERY_EXECUTED,
          {
            query: validatedQuery.sql,
            execution_time_ms: Date.now() - startTime,
            row_count: result.rowCount,
            truncated: result.rows.length < result.rowCount
          },
          {
            source: 'QueryExecutorTool',
            correlation_id: context?.requestId
          }
        ));
      }
      
      return result;
      
    } catch (error) {
      // NEW: Emit failure event
      if (this.eventCollector) {
        await this.eventCollector.collect(createEvent(
          EventType.QUERY_FAILED,
          {
            query: args.sql,
            error_message: error.message,
            error_code: error.code
          },
          {
            source: 'QueryExecutorTool',
            severity: 'error',
            correlation_id: context?.requestId
          }
        ));
      }
      
      // Existing error handling...
      throw error;
    }
  }
}
```

#### 1.2 Integrate EventCollector into Main Server

```typescript
// PostgresReadOnlyMCPServer.ts - minimal changes
export class PostgresReadOnlyMCPServer {
  private eventCollector?: EventCollector;  // NEW
  
  constructor(configPath?: string) {
    // Existing initialization...
    
    // NEW: Initialize event collector if enabled
    if (this.config.features?.events?.enabled) {
      this.eventCollector = new EventCollector(this.logger);
      this.setupEventProcessors();
    }
  }
  
  private initializeTools(): void {
    // Pass eventCollector to existing tools
    const queryExecutor = new QueryExecutorTool(
      this.connectionManager,
      this.validator,
      this.logger,
      this.eventCollector,  // NEW
      this.config.server.queryTimeoutMs,
      this.config.server.maxResultRows
    );
    
    // Same for other tools...
  }
  
  private setupEventProcessors(): void {
    if (!this.eventCollector) return;
    
    // Register processors
    this.eventCollector.registerProcessor(
      EventType.QUERY_SLOW,
      new QueryOptimizationProcessor(this.logger)
    );
    
    this.eventCollector.registerProcessor(
      EventType.CONN_FAILED,
      new ConnectionRecoveryProcessor(this.connectionManager, this.logger)
    );
  }
}
```

### Phase 2: Add MCP Resources (New Feature)

#### 2.1 Resource Manager as New Component

```typescript
// src/resources/ResourceManager.ts - NEW FILE
export class ResourceManager {
  private resources: Map<string, Resource> = new Map();
  
  constructor(
    private connectionManager: PostgresConnectionManager,
    private eventCollector?: EventCollector
  ) {
    this.registerDatabaseResources();
  }
  
  private registerDatabaseResources(): void {
    // Schema resources
    this.addResourceTemplate({
      uriTemplate: 'postgres://schema/{schema}',
      handler: async (params) => {
        const schemaInfo = await this.getSchemaInfo(params.schema);
        
        // Emit resource access event
        if (this.eventCollector) {
          await this.eventCollector.collect(createEvent(
            EventType.RESOURCE_ACCESSED,
            { resource_uri: `postgres://schema/${params.schema}` }
          ));
        }
        
        return schemaInfo;
      }
    });
  }
}
```

#### 2.2 Integrate Resources into Server

```typescript
// Add to PostgresReadOnlyMCPServer
export class PostgresReadOnlyMCPServer {
  private resourceManager?: ResourceManager;  // NEW
  
  constructor(configPath?: string) {
    // After existing initialization...
    
    // NEW: Initialize resources if enabled
    if (this.config.features?.resources?.enabled) {
      this.resourceManager = new ResourceManager(
        this.connectionManager,
        this.eventCollector
      );
    }
  }
  
  private setupRequestHandlers(): void {
    // Existing handlers...
    
    // NEW: Resource handlers
    if (this.resourceManager) {
      this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
        return this.resourceManager.listResources();
      });
      
      this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        return this.resourceManager.readResource(request.params.uri);
      });
    }
  }
}
```

### Phase 3: Add MCP Prompts (New Feature)

#### 3.1 Prompt Registry as New Component

```typescript
// src/prompts/PromptRegistry.ts - NEW FILE
export class PromptRegistry {
  private prompts: Map<string, PromptTemplate> = new Map();
  
  constructor(
    private tools: Map<string, MCPTool>,
    private eventCollector?: EventCollector
  ) {
    this.registerBuiltInPrompts();
  }
  
  private registerBuiltInPrompts(): void {
    // SQL Builder Prompt
    this.register({
      name: 'sql_select_builder',
      description: 'Build SELECT queries with guided parameters',
      arguments: [
        { name: 'table', required: true },
        { name: 'columns', required: false },
        { name: 'conditions', required: false }
      ],
      handler: async (args) => {
        // Build SQL from arguments
        const sql = this.buildSelectQuery(args);
        
        // Use existing QueryExecutorTool
        const result = await this.tools.get('query')?.execute({ sql });
        
        // Track prompt usage
        if (this.eventCollector) {
          await this.eventCollector.collect(createEvent(
            EventType.PROMPT_EXECUTED,
            { prompt_name: 'sql_select_builder', args }
          ));
        }
        
        return result;
      }
    });
  }
}
```

### Phase 4: Self-Repair Integration

#### 4.1 Connection Pool Self-Healing

```typescript
// src/optimization/ConnectionPoolHealer.ts - NEW FILE
export class ConnectionPoolHealer implements EventProcessor {
  constructor(
    private connectionManager: PostgresConnectionManager,
    private logger: StructuredLogger
  ) {}
  
  async process(event: MCPEvent): Promise<void> {
    if (event.event_type !== EventType.POOL_EXHAUSTED) return;
    
    // Use existing connection manager methods
    const health = await this.connectionManager.checkHealth();
    
    if (health.waitingConnections > 5) {
      // Expand pool using existing config
      await this.connectionManager.expandPool(5);
      
      this.logger.info('Connection pool expanded', {
        event_id: createEvent(EventType.POOL_HEALED, {
          action: 'EXPAND_POOL',
          new_size: health.activeConnections + 5
        })
      });
    }
  }
}
```

## Configuration Changes

### Extend Existing Config

```typescript
// Update ConfigurationManager.ts
export interface MCPConfig {
  // Existing configs...
  database: DatabaseConfig;
  server: ServerConfig;
  logging: LoggerConfig;
  
  // NEW: Feature flags for gradual rollout
  features?: {
    events?: {
      enabled: boolean;
      processors?: string[];  // Which processors to enable
      bufferSize?: number;
    };
    resources?: {
      enabled: boolean;
      cacheEnabled?: boolean;
      cacheTTL?: number;
    };
    prompts?: {
      enabled: boolean;
      customPromptsPath?: string;
    };
    optimization?: {
      enabled: boolean;
      autoOptimize?: boolean;
      learningEnabled?: boolean;
    };
  };
}
```

### Environment Variables

```bash
# Existing vars unchanged
DATABASE_URL=postgresql://user:pass@localhost:5432/db
MCP_PORT=8090
AUTH_ENABLED=true
MCP_API_KEY=your-key

# New feature flags
FEATURE_EVENTS_ENABLED=true
FEATURE_RESOURCES_ENABLED=true
FEATURE_PROMPTS_ENABLED=true
FEATURE_OPTIMIZATION_ENABLED=false  # Start conservative

# Event configuration
EVENT_PROCESSORS=QueryOptimization,ErrorRecovery,Metrics
EVENT_BUFFER_SIZE=10000

# Resource configuration  
RESOURCE_CACHE_ENABLED=true
RESOURCE_CACHE_TTL=300

# Optimization configuration
AUTO_OPTIMIZE_QUERIES=false  # Manual approval initially
LEARNING_ENABLED=true
```

## Testing Strategy

### 1. Compatibility Tests

```typescript
describe('Backward Compatibility', () => {
  it('should work without event collector', async () => {
    // Create server without events enabled
    const server = new PostgresReadOnlyMCPServer({
      features: { events: { enabled: false } }
    });
    
    // Should work normally
    const result = await server.executeQuery('SELECT 1');
    expect(result).toBeDefined();
  });
  
  it('should work with partial features enabled', async () => {
    // Enable only events, not resources
    const server = new PostgresReadOnlyMCPServer({
      features: { 
        events: { enabled: true },
        resources: { enabled: false }
      }
    });
    
    // Events should work
    expect(server.getEventCollector()).toBeDefined();
    
    // Resources should not be available
    expect(server.getResourceManager()).toBeUndefined();
  });
});
```

### 2. Integration Tests

```typescript
describe('Event Integration', () => {
  it('should emit events from existing tools', async () => {
    const events: MCPEvent[] = [];
    eventCollector.on('event', (e) => events.push(e));
    
    // Execute query using existing tool
    await queryTool.execute({ sql: 'SELECT 1' });
    
    // Should have emitted event
    expect(events).toContainEqual(
      expect.objectContaining({
        event_type: EventType.QUERY_EXECUTED
      })
    );
  });
});
```

## Rollout Plan

### Stage 1: Events Only (Week 1-2)

1. Deploy with `FEATURE_EVENTS_ENABLED=true`
2. Monitor event collection and metrics
3. No automated actions yet

### Stage 2: Resources (Week 3-4)

1. Enable `FEATURE_RESOURCES_ENABLED=true`
2. Test resource discovery and caching
3. Monitor performance impact

### Stage 3: Prompts (Week 5-6)

1. Enable `FEATURE_PROMPTS_ENABLED=true`
2. Deploy built-in prompts
3. Gather usage metrics

### Stage 4: Optimization (Week 7-8)

1. Enable optimization in read-only mode
2. Log suggestions without applying
3. Manual review and approval

### Stage 5: Full Automation (Week 9-10)

1. Enable `AUTO_OPTIMIZE_QUERIES=true`
2. Monitor automatic optimizations
3. Fine-tune thresholds

## Benefits of This Approach

1. **No Breaking Changes** - Existing code continues to work
2. **Gradual Adoption** - Features can be enabled independently
3. **Low Risk** - Each phase can be rolled back
4. **Preserves Investment** - Builds on existing architecture
5. **Maintains Stability** - Core functionality unchanged

## Summary

This integration plan shows how to add advanced features to the existing PostgreSQL MCP Server without disrupting current functionality. By using feature flags and optional dependencies, we can roll out enhancements gradually while maintaining backward compatibility.
