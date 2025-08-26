# Multi-Database Session Support Design

## Overview

This document outlines the design for supporting different database connections per MCP session, allowing each client to work with a different database.

## Architecture Changes

### 1. Connection Pool Registry

Create a new `ConnectionPoolRegistry` that manages multiple database connection pools:

```typescript
class ConnectionPoolRegistry {
  private pools: Map<string, PostgresConnectionManager> = new Map();
  private sessionDatabaseMap: Map<string, string> = new Map();
  
  async getConnection(sessionId: string): Promise<PostgresConnectionManager>
  async createConnection(sessionId: string, config: DatabaseConfig): Promise<PostgresConnectionManager>
  async switchDatabase(sessionId: string, databaseId: string): Promise<void>
  async cleanup(sessionId: string): Promise<void>
}
```

### 2. Database Configuration Options

#### Option A: Named Configurations (Recommended)

```typescript
// Environment variables
DB_CONFIGS='[
  {
    "id": "prod",
    "name": "Production DB",
    "host": "prod.db.com",
    "database": "prod_db"
  },
  {
    "id": "staging",
    "name": "Staging DB", 
    "host": "staging.db.com",
    "database": "staging_db"
  }
]'
```

#### Option B: Dynamic Connection Strings

Allow clients to provide connection strings at runtime through a tool.

### 3. Session-Aware Tool Execution

Modify tools to get connections from the registry:

```typescript
// In tool execute method
const connectionManager = await this.registry.getConnection(context.sessionId);
const result = await connectionManager.query(sql, params);
```

### 4. New Tools

#### DatabaseSelectorTool

- List available database configurations
- Switch active database for session
- Show current connection info

#### DatabaseConnectTool (if using dynamic connections)

- Accept connection parameters
- Validate and establish connection
- Store in registry

### 5. Session Lifecycle Management

- Clean up connections when sessions end
- Implement connection pooling limits per session
- Add timeout for idle connections

## Implementation Plan

1. **Phase 1: Core Infrastructure**
   - Create ConnectionPoolRegistry
   - Extend configuration system
   - Add session-database mapping

2. **Phase 2: Tool Integration**
   - Modify existing tools to use registry
   - Create DatabaseSelectorTool
   - Update error handling

3. **Phase 3: Session Management**
   - Implement cleanup handlers
   - Add connection monitoring
   - Create health checks per connection

## Configuration Examples

### Multiple Named Databases

```bash
# Option 1: JSON array
DB_CONFIGS='[{"id":"db1","host":"host1","database":"db1"},{"id":"db2","host":"host2","database":"db2"}]'

# Option 2: Prefix-based
DB_CONFIG_DB1_HOST=host1
DB_CONFIG_DB1_DATABASE=db1
DB_CONFIG_DB2_HOST=host2
DB_CONFIG_DB2_DATABASE=db2
```

### Default Database

```bash
DB_DEFAULT_CONFIG=db1  # Use db1 as default for new sessions
```

## Security Considerations

1. **Connection String Validation**
   - Sanitize all connection parameters
   - Limit allowed hosts/ports
   - Validate SSL requirements

2. **Session Isolation**
   - Ensure sessions cannot access other sessions' connections
   - Implement proper connection cleanup
   - Add connection limits per session

3. **Credential Management**
   - Support credential providers (AWS Secrets, Vault)
   - Rotate credentials safely
   - Mask sensitive data in logs

## Benefits

1. **Multi-tenancy**: Different clients can work on different databases
2. **Development Flexibility**: Switch between dev/staging/prod easily
3. **Testing**: Each test session can use isolated database
4. **Security**: Better isolation between different database environments

## Migration Path

1. Current single-database setup continues to work (backward compatible)
2. If no multi-database config provided, behave as before
3. Gradual adoption - tools work with both old and new patterns
