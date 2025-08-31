# Authentication Documentation

This document describes the authentication and authorization system implemented in the EE Database MCP Server.

## Table of Contents

1. [Overview](#overview)
2. [OAuth 2.1 Flow](#oauth-21-flow)
3. [API Key Authentication](#api-key-authentication)
4. [Database Schema](#database-schema)
5. [Configuration](#configuration)
6. [Security Model](#security-model)
7. [Client Integration](#client-integration)
8. [API Reference](#api-reference)
9. [Troubleshooting](#troubleshooting)

## Overview

The EE Database MCP Server implements a hybrid authentication system that combines:

- **OAuth 2.1** for client authentication flow (required by Claude MCP)
- **Database-backed API keys** for actual request authorization
- **Session management** with configurable timeouts
- **Bearer token authentication** for all MCP requests

### Key Features

- No token expiration (configurable)
- 30-day session timeout for idle connections
- Instant revocation via database
- Per-request authentication validation
- SHA-256 hashed API keys
- Automatic session cleanup

## OAuth 2.1 Flow

The server implements OAuth 2.1 with support for:
- Authorization Code flow with PKCE
- Client Credentials flow
- Dynamic client registration

### Flow Sequence

1. **Discovery**: Client requests `/.well-known/oauth-authorization-server`
2. **Registration**: Client registers at `/oauth/register`
3. **Authorization**: Browser redirects to `/oauth/authorize`
4. **Token Exchange**: Client exchanges code at `/oauth/token`
5. **API Access**: Client uses Bearer token for all requests

### Automatic Authorization

The authorization endpoint (`/oauth/authorize`) automatically:
- Generates an authorization code
- Redirects immediately without user interaction
- Supports PKCE (code_challenge/code_challenge_method)
- Maintains state parameter for security

## API Key Authentication

### How It Works

1. **OAuth tokens contain the actual API key**: `ee-mcp-dUAm2TmZp_xP2oPHYI8jkChpvlDsCK72STSkJuMNbbs`
2. **Every request validates against the database**:
   ```sql
   SELECT * FROM documents.api_keys 
   WHERE api_key_hash = $1 
   AND is_active = true 
   AND is_deleted = false
   AND (expires_at IS NULL OR expires_at > NOW())
   ```
3. **API key is hashed with SHA-256** before database lookup
4. **Request context is enriched** with user/project/permissions

### Request Context

Authenticated requests have access to:
```javascript
req.apiKeyContext = {
  keyId: 'APIK-AUS1-000001',
  projectId: 'PROJ-AUS1-000003',
  userId: 'USER-AUS1-000001',
  companyId: 'COMP-AUS1-000001',
  permissions: ['read', 'write'],
  metadata: { /* custom data */ }
}
```

## Database Schema

### API Keys Table

```sql
CREATE TABLE documents.api_keys (
    api_key_id text PRIMARY KEY DEFAULT generate_custom_id('api_keys'),
    company_id text,
    user_id text NOT NULL,
    api_key_hash text NOT NULL UNIQUE,
    name text NOT NULL,
    permissions jsonb DEFAULT '[]'::jsonb,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    is_revoked boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    created_by text,
    modified_at timestamp with time zone DEFAULT now(),
    modified_by text,
    is_active boolean DEFAULT true,
    is_deleted boolean DEFAULT false,
    reference_data jsonb DEFAULT '{}'::jsonb,
    project_id text
);
```

### Key Fields

- **api_key_hash**: SHA-256 hash of the actual API key
- **is_active**: Master switch for enabling/disabling access
- **expires_at**: Optional expiration timestamp
- **permissions**: JSON array of permission strings
- **last_used_at**: Updated on every authenticated request
- **reference_data**: Custom metadata for your application

## Configuration

### Server Configuration (config.json)

```json
{
  "server": {
    "auth": {
      "enabled": true,
      "apiKey": "PROJ-AUS1-000003",  // Not used for auth
      "allowedIPs": []                // Future: IP restrictions
    }
  }
}
```

### Environment Variables

- `MCP_TRANSPORT`: Leave unset (uses StreamableHTTP by default)
- `NODE_ENV`: Set to 'production' for production deployments

### Timeouts

- **OAuth Token Expiration**: None (tokens don't expire)
- **Session Timeout**: 30 days of inactivity
- **Session Cleanup**: Runs every minute

## Security Model

### Defense in Depth

1. **Transport Security**
   - HTTPS recommended for production
   - CORS configured for allowed origins
   - TCP keepalive for connection health

2. **Authentication Layers**
   - OAuth flow for initial authentication
   - Bearer token required on every request
   - Database validation for each request

3. **Access Control**
   - Instant revocation by setting `is_active = false`
   - Time-based expiration with `expires_at`
   - Permission-based access with `permissions` array
   - Soft delete with `is_deleted` flag

### API Key Management

```bash
# Generate a secure API key
openssl rand -base64 32

# Hash for database storage (example in Node.js)
const crypto = require('crypto');
const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
```

## Client Integration

### Claude MCP Integration

1. **Add server with OAuth** (opens browser once):
   ```bash
   claude mcp add --transport http ee-db http://localhost:8102/mcp
   ```

2. **Alternative with direct header** (if OAuth discovery is disabled):
   ```bash
   claude mcp add --transport http ee-db http://localhost:8102/mcp \
     --header "Authorization: Bearer YOUR_API_KEY"
   ```

### Manual Testing

```bash
# Test with curl
curl -X POST http://localhost:8102/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer ee-mcp-dUAm2TmZp_xP2oPHYI8jkChpvlDsCK72STSkJuMNbbs" \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'
```

## API Reference

### OAuth Endpoints

#### GET /.well-known/oauth-authorization-server
Returns OAuth 2.1 server metadata.

#### POST /oauth/register
Dynamic client registration.

**Request:**
```json
{
  "client_name": "My MCP Client",
  "grant_types": ["authorization_code"],
  "redirect_uris": ["http://localhost:12345/callback"],
  "response_types": ["code"]
}
```

**Response:**
```json
{
  "client_id": "client_uuid",
  "client_secret": "secret_uuid",
  "client_id_issued_at": 1234567890,
  "grant_types": ["authorization_code"],
  "redirect_uris": ["http://localhost:12345/callback"]
}
```

#### GET /oauth/authorize
Authorization endpoint (auto-approves).

**Parameters:**
- `response_type`: Must be "code"
- `client_id`: Client identifier
- `redirect_uri`: Callback URL
- `state`: CSRF protection
- `code_challenge`: PKCE challenge
- `code_challenge_method`: Must be "S256"

#### POST /oauth/token
Token exchange endpoint.

**Parameters:**
- `grant_type`: "authorization_code" or "client_credentials"
- `code`: Authorization code (for authorization_code)
- `client_id`: Client identifier
- `client_secret`: Client secret
- `code_verifier`: PKCE verifier

**Response:**
```json
{
  "access_token": "ee-mcp-dUAm2TmZp_xP2oPHYI8jkChpvlDsCK72STSkJuMNbbs",
  "token_type": "Bearer",
  "scope": "mcp"
}
```

### Protected Endpoints

All MCP endpoints require Bearer authentication:

```
Authorization: Bearer ee-mcp-dUAm2TmZp_xP2oPHYI8jkChpvlDsCK72STSkJuMNbbs
```

Endpoints that bypass authentication:
- `/health` - Health check
- `/.well-known/oauth-authorization-server` - OAuth discovery
- `/oauth/*` - OAuth flow endpoints

## Troubleshooting

### Common Issues

#### "Missing API key" Error
- Ensure Authorization header is present
- Format: `Authorization: Bearer YOUR_KEY`
- Check for typos in the Bearer prefix

#### "Invalid API key" Error
- Verify key exists in database
- Check `is_active = true`
- Ensure `is_deleted = false`
- Verify `expires_at` is NULL or future

#### Session Timeout
- Sessions expire after 30 days of inactivity
- Each request resets the timeout
- Check logs for "Cleaning up expired session"

### Debug Logging

Monitor authentication in logs:
```bash
tail -f logs/mcp-server.log | grep -E "(API key|OAuth|Bearer|auth)"
```

Key log messages:
- `API key authenticated` - Successful authentication
- `Missing API key` - No Authorization header
- `Invalid API key` - Key validation failed
- `OAuth authorization request` - OAuth flow initiated
- `Auto-approving OAuth authorization` - Automatic approval

### Database Queries

```sql
-- Check API key status
SELECT api_key_id, name, is_active, expires_at, last_used_at 
FROM documents.api_keys 
WHERE api_key_hash = sha256('your-api-key');

-- Revoke access immediately
UPDATE documents.api_keys 
SET is_active = false 
WHERE api_key_id = 'APIK-AUS1-000001';

-- Set expiration
UPDATE documents.api_keys 
SET expires_at = NOW() + INTERVAL '7 days'
WHERE api_key_id = 'APIK-AUS1-000001';

-- View recent usage
SELECT api_key_id, name, last_used_at 
FROM documents.api_keys 
WHERE last_used_at > NOW() - INTERVAL '1 hour'
ORDER BY last_used_at DESC;
```

## Best Practices

1. **API Key Security**
   - Generate cryptographically secure keys
   - Never log or display full API keys
   - Rotate keys periodically
   - Use different keys for different environments

2. **Access Control**
   - Implement least privilege with permissions
   - Set expiration dates for temporary access
   - Monitor `last_used_at` for unusual activity
   - Use soft delete (`is_deleted`) for audit trails

3. **Production Deployment**
   - Use HTTPS in production
   - Configure CORS appropriately
   - Set up monitoring for authentication failures
   - Implement rate limiting
   - Regular security audits of api_keys table

4. **Session Management**
   - Monitor active sessions
   - Adjust SESSION_TIMEOUT_MS based on security needs
   - Implement session revocation if needed
   - Consider shorter timeouts for sensitive operations