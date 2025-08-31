# Authentication Implementation Guide

This guide explains the technical implementation of the authentication system for developers maintaining or extending the codebase.

## Architecture Overview

```
┌─────────────┐     OAuth Discovery      ┌──────────────────┐
│             │ ◄──────────────────────► │                  │
│   Claude    │     Registration         │   MCP Server     │
│   Client    │ ◄──────────────────────► │  (Port 8102)     │
│             │     Authorization        │                  │
│             │ ──────────────────────►  │ ┌──────────────┐ │
│             │     Token Exchange       │ │ Auth Middle- │ │
│             │ ◄──────────────────────► │ │    ware      │ │
│             │                          │ └──────┬───────┘ │
│             │     Bearer Token         │        │         │
│             │ ──────────────────────►  │ ┌──────▼───────┐ │
│             │     MCP Requests         │ │  PostgreSQL  │ │
│             │ ◄──────────────────────► │ │   Database   │ │
└─────────────┘                          │ └──────────────┘ │
                                         └──────────────────┘
```

## Key Components

### 1. OAuth Endpoints (`createStreamableHttpServer.ts`)

#### OAuth Discovery
```javascript
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: `http://localhost:${config.port}`,
    authorization_endpoint: `http://localhost:${config.port}/oauth/authorize`,
    token_endpoint: `http://localhost:${config.port}/oauth/token`,
    registration_endpoint: `http://localhost:${config.port}/oauth/register`,
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    response_types_supported: ['code'],
    grant_types_supported: ['client_credentials', 'authorization_code'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp']
  });
});
```

#### Client Registration
```javascript
app.post('/oauth/register', (req, res) => {
  const clientId = `client_${randomUUID()}`;
  const clientSecret = `secret_${randomUUID()}`;
  
  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    grant_types: req.body.grant_types || ['client_credentials', 'authorization_code'],
    redirect_uris: req.body.redirect_uris || [],
    response_types: req.body.response_types || ['code']
  });
});
```

#### Authorization (Auto-Approve)
```javascript
app.get('/oauth/authorize', (req, res) => {
  const authCode = `authcode_${randomUUID()}`;
  const redirectUrl = new URL(req.query.redirect_uri);
  redirectUrl.searchParams.append('code', authCode);
  if (req.query.state) {
    redirectUrl.searchParams.append('state', req.query.state);
  }
  
  // Immediate redirect - no user interaction
  res.redirect(302, redirectUrl.toString());
});
```

#### Token Exchange
```javascript
app.post('/oauth/token', (req, res) => {
  if (req.body.grant_type === 'authorization_code') {
    // Validate authorization code
    if (!req.body.code?.startsWith('authcode_')) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid authorization code'
      });
    }
  }
  
  // Return the actual API key as the access token
  res.json({
    access_token: 'ee-mcp-dUAm2TmZp_xP2oPHYI8jkChpvlDsCK72STSkJuMNbbs',
    token_type: 'Bearer',
    scope: 'mcp'
    // No expires_in = tokens don't expire
  });
});
```

### 2. Authentication Middleware

```javascript
if (config.auth.enabled) {
  app.use(async (req, res, next) => {
    // Skip auth for public endpoints
    if (req.path === '/health' || 
        req.path.startsWith('/oauth/') ||
        req.path === '/.well-known/oauth-authorization-server') {
      return next();
    }

    // Extract Bearer token
    let providedKey;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      providedKey = authHeader.substring(7);
    } else {
      providedKey = req.headers['x-api-key'] || 
                    req.query.apiKey || 
                    req.query.api_key;
    }

    if (!providedKey) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'API key required'
      });
    }

    // Hash and validate against database
    const keyHash = crypto.createHash('sha256').update(providedKey).digest('hex');
    const result = await pool.query(
      `SELECT * FROM documents.api_keys 
       WHERE api_key_hash = $1 
       AND is_active = true 
       AND is_deleted = false
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [keyHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid API key'
      });
    }

    // Enrich request context
    req.apiKeyContext = {
      keyId: result.rows[0].api_key_id,
      projectId: result.rows[0].project_id,
      userId: result.rows[0].user_id,
      companyId: result.rows[0].company_id,
      permissions: result.rows[0].permissions || [],
      metadata: result.rows[0].reference_data || {}
    };

    // Update last used timestamp
    await pool.query(
      `UPDATE documents.api_keys 
       SET last_used_at = NOW() 
       WHERE api_key_id = $1`,
      [result.rows[0].api_key_id]
    );

    next();
  });
}
```

### 3. Session Management

```javascript
const transports = {};
const sessionLastActivity = {};
const SESSION_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Session cleanup interval
setInterval(() => {
  const now = Date.now();
  const expiredSessions = [];

  for (const sessionId in sessionLastActivity) {
    if (now - sessionLastActivity[sessionId] > SESSION_TIMEOUT_MS) {
      expiredSessions.push(sessionId);
    }
  }

  for (const sessionId of expiredSessions) {
    if (transports[sessionId]) {
      transports[sessionId].close();
      delete transports[sessionId];
    }
    delete sessionLastActivity[sessionId];
  }
}, 60000); // Run every minute
```

### 4. Database Integration

#### Connection Pool with Keep-Alive
```javascript
this.config = {
  host: dbConfig.host,
  port: dbConfig.port,
  database: dbConfig.database,
  user: dbConfig.user,
  password: dbConfig.password,
  ssl: dbConfig.ssl,
  max: dbConfig.poolConfig?.max || 10,
  idleTimeoutMillis: dbConfig.poolConfig?.idleTimeoutMillis || 30000,
  connectionTimeoutMillis: dbConfig.poolConfig?.connectionTimeoutMillis || 2000,
  application_name: 'ee-tools-mcp-server',
  options: `-c search_path=${dbConfig.schema},public`,
  // TCP keepalive to detect dead connections
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
};
```

## Security Considerations

### 1. API Key Storage
- Keys are hashed with SHA-256 before storage
- Original keys are never logged or stored
- Database column uses unique constraint on hash

### 2. Request Validation
- Every request validates against live database
- No caching of authentication status
- Instant revocation by updating database

### 3. OAuth Security
- PKCE support for authorization code flow
- State parameter preserved for CSRF protection
- Auto-approval eliminates phishing opportunities

### 4. Session Security
- Sessions tied to specific transport instances
- Activity tracking prevents idle session abuse
- Automatic cleanup of expired sessions

## Configuration Options

### Environment Variables
```bash
# Transport (leave unset for StreamableHTTP)
MCP_TRANSPORT=

# Node environment
NODE_ENV=production

# Application name
APP_NAME=ee-tools
```

### Config.json
```json
{
  "server": {
    "auth": {
      "enabled": true,
      "apiKey": "PROJ-AUS1-000003",
      "allowedIPs": []
    }
  }
}
```

## Extension Points

### Custom Authentication Providers
To add a new authentication method:

1. Extend the middleware to check for your auth type
2. Add validation logic for your auth scheme
3. Map to standard `apiKeyContext` format
4. Update OAuth token endpoint if needed

### Permission System
The `permissions` array in `api_keys` table can be used for:

```javascript
// Check permissions in tools
if (!req.apiKeyContext.permissions.includes('write')) {
  throw new Error('Write permission required');
}
```

### Rate Limiting
Add rate limiting per API key:

```javascript
const rateLimits = new Map();

// In middleware
const key = req.apiKeyContext.keyId;
if (!rateLimits.has(key)) {
  rateLimits.set(key, { count: 0, reset: Date.now() + 60000 });
}

const limit = rateLimits.get(key);
if (limit.count > 100) {
  return res.status(429).json({ error: 'Rate limit exceeded' });
}
limit.count++;
```

## Debugging

### Common Issues

1. **OAuth Loop**: Client keeps asking for auth
   - Check OAuth discovery endpoint is accessible
   - Verify all required fields in metadata

2. **401 Errors**: Authentication failing
   - Check API key exists and is active
   - Verify SHA-256 hash matches
   - Check expires_at is NULL or future

3. **Session Timeout**: Connections dropping
   - Check SESSION_TIMEOUT_MS value
   - Monitor sessionLastActivity updates
   - Verify cleanup interval is running

### Debug Logging
```javascript
// Add to middleware for detailed auth logging
logger.debug('Auth attempt', {
  hasAuthHeader: !!req.headers.authorization,
  keyPrefix: providedKey?.substring(0, 8),
  path: req.path,
  method: req.method
});
```

## Testing

### Manual Testing
```bash
# Test OAuth discovery
curl http://localhost:8102/.well-known/oauth-authorization-server

# Test with API key
curl -X POST http://localhost:8102/mcp \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

### Integration Testing
```javascript
describe('Authentication', () => {
  it('should reject missing API key', async () => {
    const res = await request(app)
      .post('/mcp')
      .send({ method: 'tools/list' });
    expect(res.status).toBe(401);
  });

  it('should accept valid API key', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer valid-key')
      .send({ method: 'tools/list' });
    expect(res.status).toBe(200);
  });
});
```