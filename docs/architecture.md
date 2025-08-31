# PostgreSQL Read-Only MCP Server Architecture

## System Overview

The PostgreSQL Read-Only MCP Server is a modular, production-ready Model Context Protocol server that provides safe, read-only access to PostgreSQL databases through a well-defined API.

``` text
┌─────────────────────────────────────────────────────────────┐
│                    MCP Client (LLM/AI Agent)                │
└─────────────────────────┬───────────────────────────────────┘
                          │ SSE (Server-Sent Events)
┌─────────────────────────┴───────────────────────────────────┐
│                    SSE Transport Layer                      │
│                    (Express + SSE)                          │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│              PostgresReadOnlyMCPServer                      │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────────────────┐   │
│  │   Logging   │ │   Config    │ │   Tool Registry      │   │
│  └─────────────┘ └─────────────┘ └──────────────────────┘   │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│                        Tool Layer                           │
│  ┌──────────────┐ ┌───────────────┐ ┌─────────────────┐     │
│  │QueryExecutor │ │SchemaExplorer │ │ TableInspector  │     │
│  └──────────────┘ └───────────────┘ └─────────────────┘     │
│  ┌──────────────────────────────────┐                       │
│  │    DatabaseCatalog               │                       │
│  └──────────────────────────────────┘                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│                    Database Layer                           │
│  ┌─────────────────────┐ ┌──────────────────────────────┐   │
│  │  QueryValidator     │ │  PostgresConnectionManager   │   │
│  └─────────────────────┘ └──────────────────────────────┘   │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│                  PostgreSQL Database                        │
└─────────────────────────────────────────────────────────────┘
```

## Component Architecture

### 1. Transport Layer

#### SSEServerTransport

- **Purpose**: Handles HTTP/SSE communication with MCP clients
- **Responsibilities**:
  - HTTP server management on configured port
  - SSE connection handling
  - Message serialization/deserialization
  - Connection lifecycle management
- **Key Features**:
  - Multiple concurrent connections
  - Automatic reconnection support
  - CORS configuration for web clients

### 2. Server Core

#### PostgresReadOnlyMCPServer

- **Purpose**: Main orchestrator for the MCP server
- **Responsibilities**:
  - Tool registration and management
  - Request routing
  - Response formatting
  - Error handling and recovery
- **Dependencies**:
  - All tool implementations
  - ConfigurationManager
  - StructuredLogger

### 3. Tool Layer

Each tool follows a consistent interface:

```typescript
interface MCPTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute(args: any, context: ToolContext): Promise<ToolResult>;
}
```

#### QueryExecutorTool

- **Purpose**: Execute read-only SQL queries
- **Features**:
  - Query validation
  - Parameterized query support
  - Result pagination
  - Query timeout handling

#### SchemaExplorerTool

- **Purpose**: List database schemas and tables
- **Features**:
  - Schema filtering
  - Table metadata
  - Owner information
  - Table statistics

#### TableInspectorTool

- **Purpose**: Detailed table structure information
- **Features**:
  - Column definitions
  - Constraints (PK, FK, unique)
  - Indexes
  - Relationships

#### DatabaseCatalogTool

- **Purpose**: List available databases
- **Features**:
  - Database sizes
  - Connection limits
  - Template status

### 4. Database Layer

#### PostgresConnectionManager

- **Purpose**: Manage database connection pooling
- **Features**:
  - Connection pool configuration
  - Health monitoring
  - Automatic retry logic
  - Graceful shutdown
- **Configuration**:

  ```typescript
  {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 10,                    // Maximum pool size
    idleTimeoutMillis: 30000,   // Close idle connections
    connectionTimeoutMillis: 2000
  }
  ```

#### QueryValidator

- **Purpose**: Ensure query safety
- **Validation Rules**:
  - Only SELECT and WITH statements allowed
  - No data modification keywords
  - No administrative commands
  - Parameterized query validation

### 5. Infrastructure Components

#### StructuredLogger

- **Purpose**: Centralized logging with structure
- **Features**:
  - JSONL format for easy parsing
  - Automatic daily rotation
  - 7-day retention
  - Log levels: ERROR, WARN, INFO, DEBUG
- **Log Structure**:

  ```json
  {
    "timestamp": "2024-01-20T10:30:45.123Z",
    "level": "info",
    "service": "postgres-mcp",
    "module": "QueryExecutorTool",
    "action": "query_executed",
    "metadata": {
      "duration_ms": 45,
      "row_count": 150,
      "query_hash": "abc123"
    }
  }
  ```

#### ConfigurationManager

- **Purpose**: Centralized configuration management
- **Features**:
  - Environment variable loading
  - Configuration validation
  - Type-safe access
  - Default values
- **Configuration Schema**:

  ```typescript
  interface AppConfig {
    database: {
      host: string;
      port: number;
      name: string;
      user: string;
      password: string;
      schema: string;
    };
    server: {
      port: number;
      cors: {
        enabled: boolean;
        origins: string[];
      };
    };
    logging: {
      level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
      directory: string;
      maxFiles: number;
      maxSize: string;
    };
  }
  ```

## Data Flow

### 1. Request Flow

```
Client Request → SSE Transport → Server Core → Tool Selection
→ Query Validation → Database Execution → Result Formatting
→ Response Serialization → SSE Response → Client
```

### 2. Error Handling Flow

```
Error Occurrence → Error Capture → Logger → Error Formatter
→ Client Error Response
```

### 3. Connection Management Flow

```
Initial Connection → Pool Creation → Health Check
→ Query Execution → Connection Return → Idle Timeout
→ Connection Close
```

## Security Architecture

### Query Security

1. **Whitelist Approach**: Only explicitly allowed SQL keywords
2. **Parameterized Queries**: Prevent SQL injection
3. **Query Timeout**: Prevent resource exhaustion
4. **Result Limits**: Configurable row limits

### Connection Security

1. **SSL/TLS Support**: Encrypted database connections
2. **Credential Management**: Environment-based configuration
3. **Connection Limits**: Pool size restrictions
4. **Access Control**: Read-only database user

### API Security

1. **CORS Configuration**: Controlled client access
2. **Rate Limiting**: Request throttling (optional)
3. **Request Validation**: Schema-based input validation

## Performance Considerations

### Connection Pooling

- Minimum connections: 2
- Maximum connections: 10
- Idle timeout: 30 seconds
- Connection timeout: 2 seconds

### Query Optimization

- Query result streaming for large datasets
- Configurable query timeout (default: 30s)
- Result pagination support
- Query plan caching (future enhancement)

### Caching Strategy

- Schema metadata caching (5 minutes)
- Database list caching (1 minute)
- No query result caching (ensure fresh data)

## Monitoring and Observability

### Metrics

- Query execution time
- Connection pool utilization
- Error rates by type
- Request throughput

### Health Checks

- `/health`: Basic liveness check
- `/ready`: Database connectivity check
- `/metrics`: Prometheus-compatible metrics (future)

### Logging

- Structured JSON logs
- Correlation IDs for request tracking
- Performance metrics in logs
- Error stack traces with context

## Deployment Architecture

### Container Deployment

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
EXPOSE 8090
CMD ["node", "dist/index.js"]
```

### Environment Requirements

- Node.js 18+
- PostgreSQL 12+
- 512MB RAM minimum
- 1GB disk space for logs

### Scaling Considerations

- Horizontal scaling via load balancer
- Shared nothing architecture
- Database connection pool per instance
- Log aggregation for multiple instances

## Future Enhancements

### Phase 1 (Next Quarter)

- Query result caching
- Advanced query validation
- Performance monitoring dashboard

### Phase 2 (6 Months)

- Multi-database support
- Query federation
- Real-time change notifications

### Phase 3 (1 Year)

- GraphQL interface
- Advanced security features
- Plugin architecture
