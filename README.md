# ee_mcp_db

A production-ready MCP (Model Context Protocol) server that provides secure
database access with OAuth 2.1 authentication, advanced query capabilities,
and comprehensive monitoring.

## Features

### Core Features

- **Read-only access**: By default, only SELECT, WITH, SHOW, and EXPLAIN queries allowed
- **Write operations support**: Optional support for INSERT, UPDATE, DELETE, CREATE, ALTER, DROP operations (disabled by default)
- **Prepared Statement Caching**: Automatic caching of parameterized queries for improved performance
- **Batch Query Support**: Execute multiple queries efficiently with transaction support
- **StreamableHTTP Transport**: Reliable HTTP transport with session management
- **Structured Logging**: JSONL format with automatic 7-day rotation
- **Connection Pooling**: Efficient connection management with health monitoring
- **Comprehensive Error Handling**: Detailed error information returned to MCP callers

### Security

- **OAuth 2.1 Authentication**: Full OAuth flow with authorization code + PKCE
- **Database-backed API Keys**: SHA-256 hashed keys with instant revocation
- **Query Validation**: Whitelist approach for SQL operations
- **Parameterized Queries**: Protection against SQL injection
- **Connection Security**: SSL/TLS support for encrypted connections
- **Session Management**: 30-day timeout with automatic cleanup
- **CORS Support**: Configurable cross-origin resource sharing

### Monitoring

- **Health Checks**: `/health` endpoint for liveness monitoring
- **Performance Metrics**: Query execution time tracking
- **Connection Monitoring**: Pool utilization and health status
- **Structured Logs**: Easy integration with log aggregation tools

## Available Tools

The MCP server provides comprehensive tools for database interaction. For detailed documentation, see [DOCUMENTATION.md](./DOCUMENTATION.md).

### Quick Tool Overview:

1. **help** - Get comprehensive help and documentation
2. **query** - Execute SQL queries with automatic prepared statement caching
3. **batch_query** - Execute multiple queries efficiently with transaction support
4. **list_tables** - List all tables with metadata
5. **describe_table** - Get detailed table structure information
6. **list_databases** - List all accessible databases
7. **create_managed_table** - Create tables with standard columns (optional feature)
8. **pop_task** - Retrieve priority tasks and bugs from the database

### Getting Help

Use the help tool for comprehensive documentation:
```json
{
  "tool": "help",
  "arguments": {
    "topic": "query"  // Options: tools, query, schema, errors, parameters
  }
}

### 3. **describe_table**

Comprehensive table inspection:

- Column definitions with comments
- Constraints (PK, FK, unique)
- Indexes with usage statistics
- Foreign key relationships
- Triggers (optional)

### 4. **list_databases**

Database catalog with statistics:

- Database sizes
- Connection statistics
- Cache hit ratios
- Transaction metrics

## Authentication

The server uses OAuth 2.1 with database-backed API keys for secure access:

### Quick Start with Claude

```bash
# Add the MCP server (opens browser once for OAuth flow)
claude mcp add --transport http ee-db http://localhost:8102/mcp
```

### API Key Setup

1. Create an API key in your database:
```sql
INSERT INTO documents.api_keys (
    user_id, 
    api_key_hash, 
    name, 
    project_id
) VALUES (
    'USER-001',
    SHA256('your-secure-api-key'),
    'Claude MCP Access',
    'PROJ-001'
);
```

2. The OAuth flow automatically uses your configured API key
3. Tokens never expire (configurable)
4. Revoke access instantly via database

See [Authentication Documentation](docs/AUTHENTICATION.md) for complete details.

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/your-org/postgres_read_only_mcp.git
   cd postgres_read_only_mcp
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy the environment example:

   ```bash
   cp .env.example .env
   ```

4. Configure your `.env` file:

   ```bash
   # Database Configuration
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=mydatabase
   DB_SCHEMA=public
   DB_USER=readonly_user
   DB_PASSWORD=your_password

   # Server Configuration
   MCP_PORT=8090

   # Logging
   LOG_DIR=logs
   LOG_LEVEL=INFO
   ```

## MCP Inspector

``` javascript
npx @modelcontextprotocol/inspector .
```

## Usage

### Development Mode

```bash
npm run dev
```

### Production Mode

```bash
npm run build
npm start
```

### Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# With coverage
npm run test:coverage
```

## API Endpoints

### SSE Connection

``` js
{
  "mcpServers": {
    "ee_tools": {
      "timeout": 60,
      "type": "sse",
      "url": "http://localhost:8090/sse",
      "disabled": false,
      "headers": {
        "X-API-Key": "PROJ-AUS1-000003"
      }
    }
  }
}
```

### Add to claude code

``` bash
claude mcp add --transport sse ee-tools http://localhost:8090/sse

```

### JSON-RPC Endpoint

``` yaml
POST http://localhost:8090/rpc
Headers: 
  Content-Type: application/json
  X-Client-ID: <required-client-id>
```

### Health Check

``` ts
GET http://localhost:8090/health
```

### Connected Clients

``` ts
GET http://localhost:8090/clients
```

## MCP Client Configuration

### For SSE Transport

```json
{
  "mcpServers": {
    "postgres-readonly": {
      "url": "http://localhost:8090",
      "transport": "sse"
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DB_HOST` | PostgreSQL host | required |
| `DB_PORT` | PostgreSQL port | 5432 |
| `DB_NAME` | Database name | required |
| `DB_SCHEMA` | Default schema | public |
| `DB_USER` | Database user | required |
| `DB_PASSWORD` | Database password | required |
| `MCP_PORT` | Server port | 8090 |
| `LOG_LEVEL` | Log level (ERROR/WARN/INFO/DEBUG/TRACE) | INFO |
| `LOG_DIR` | Log directory | ./logs |
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated) | * |
| `QUERY_TIMEOUT_MS` | Default query timeout | 30000 |
| `MAX_RESULT_ROWS` | Maximum rows per query | 10000 |
| `AUTH_ENABLED` | Enable authentication | false |
| `MCP_API_KEY` | API key for authentication | - |
| `ALLOWED_IPS` | Comma-separated list of allowed IPs | - |

## Architecture

The server follows a modular architecture:

``` sh
src/
├── server/              # Main server and transport
├── database/            # Connection management and validation
├── tools/               # MCP tool implementations
├── logging/             # Structured logging system
├── config/              # Configuration management
└── types/               # TypeScript type definitions
```

## Security Considerations

1. **Database User**: Create a read-only PostgreSQL user:

   ```sql
   CREATE USER readonly_user WITH PASSWORD 'secure_password';
   GRANT CONNECT ON DATABASE mydb TO readonly_user;
   GRANT USAGE ON SCHEMA public TO readonly_user;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly_user;
   ```
   
   For write operations (when `ENABLE_WRITE_OPERATIONS=true`):
   ```sql
   -- WARNING: Only grant write permissions if absolutely necessary
   GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO write_user;
   GRANT CREATE ON SCHEMA public TO write_user;
   ```

2. **Query Validation**: All queries are validated against a whitelist of allowed operations
   - By default, only SELECT, WITH, SHOW, and EXPLAIN queries are allowed
   - Set `ENABLE_WRITE_OPERATIONS=true` to allow INSERT, UPDATE, DELETE, CREATE, ALTER, DROP operations
   - **WARNING**: Write operations can modify or delete data. Use with extreme caution!

3. **Connection Security**: Use SSL connections in production:

   ```bash
   DB_SSL=true
   DB_SSL_REJECT_UNAUTHORIZED=false
   ```

4. **API Authentication**: Enable authentication for production:

   ```bash
   AUTH_ENABLED=true
   MCP_API_KEY=your-secure-api-key-here
   ALLOWED_IPS=192.168.1.0,10.0.0.0
   ```

   Clients must provide the API key in one of these ways:
   - Header: `X-API-Key: your-secure-api-key-here`
   - Header: `Authorization: Bearer your-secure-api-key-here`
   - Query parameter: `?apiKey=your-secure-api-key-here`

## Monitoring

### Logs

- Location: `./logs/` directory
- Format: JSONL (one JSON object per line)
- Rotation: Daily with 7-day retention
- Files: `postgres-mcp-YYYY-MM-DD.jsonl`

### Health Monitoring

```bash
curl http://localhost:8090/health
```

### Log Analysis

```bash
# View today's errors
jq 'select(.level == "error")' logs/postgres-mcp-$(date +%Y-%m-%d).jsonl

# Query execution times
jq 'select(.module == "QueryExecutorTool") | .duration' logs/*.jsonl
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Submit a pull request

## License

ISC
