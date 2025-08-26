/**
 * OAuth handler module that centralizes all OAuth-related functionality.
 * Supports both authenticated and non-authenticated modes based on configuration.
 */

import crypto, { randomUUID } from 'crypto';

import { Request, Response } from 'express';

import { ServerConfig } from '../config/ServerConfig.js';
import { PostgresConnectionManager } from '../database/PostgresConnectionManager.js';
import { StructuredLogger } from '../logging/StructuredLogger.js';

export interface OAuthConfig {
  enabled: boolean;
  port: number;
  issuer?: string;
  clientCredentialsEnabled?: boolean;
  authorizationCodeEnabled?: boolean;
}

export interface ApiKeyContext {
  keyId: string;
  projectId: string;
  permissions: string[];
  metadata: any;
  userId?: string;
  companyId?: string;
}

export class OAuthHandler {
  private readonly config: OAuthConfig;
  private readonly logger: StructuredLogger;
  private readonly connectionManager?: PostgresConnectionManager;

  constructor(
    config: ServerConfig,
    logger: StructuredLogger,
    connectionManager?: PostgresConnectionManager
  ) {
    this.config = {
      enabled: config.auth.enabled,
      port: config.port,
      issuer: `http://localhost:${config.port}`,
      clientCredentialsEnabled: true,
      authorizationCodeEnabled: true,
    };
    this.logger = logger;
    this.connectionManager = connectionManager;
  }

  /**
   * Handle OAuth well-known discovery endpoint
   */
  handleDiscovery(req: Request, res: Response): void {
    if (!this.config.enabled) {
      // Return minimal response with required fields for MCP compatibility
      // Even when auth is disabled, clients expect these endpoints to exist
      res.json({
        issuer: this.config.issuer,
        authorization_endpoint: `${this.config.issuer}/oauth/authorize`,
        token_endpoint: `${this.config.issuer}/oauth/token`,
        registration_endpoint: `${this.config.issuer}/oauth/register`,
        grant_types_supported: [],
        response_types_supported: [],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }

    // Full OAuth discovery response
    res.json({
      issuer: this.config.issuer,
      authorization_endpoint: `${this.config.issuer}/oauth/authorize`,
      token_endpoint: `${this.config.issuer}/oauth/token`,
      registration_endpoint: `${this.config.issuer}/oauth/register`,
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      response_types_supported: ['code'],
      grant_types_supported: ['client_credentials', 'authorization_code'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp'],
      service_documentation: `${this.config.issuer}/docs`,
    });
  }

  /**
   * Handle OAuth protected resource discovery
   */
  handleProtectedResource(req: Request, res: Response): void {
    if (!this.config.enabled) {
      res.json({
        resource: `${this.config.issuer}/mcp`,
        authorization_servers: [],
      });
      return;
    }

    res.json({
      resource: `${this.config.issuer}/mcp`,
      authorization_servers: [this.config.issuer],
    });
  }

  /**
   * Handle OAuth dynamic client registration
   */
  handleClientRegistration(req: Request, res: Response): void {
    if (!this.config.enabled) {
      // Even when auth is disabled, we need to support client registration
      // for MCP compatibility. Return a dummy client that works without auth.
      res.status(201).json({
        client_id: `dummy_client_${randomUUID()}`,
        client_secret: `dummy_secret_${randomUUID()}`,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        grant_types: [],
        token_endpoint_auth_method: 'none',
        scope: '',
        redirect_uris: [],
        response_types: [],
        client_name: req.body.client_name || 'Claude MCP Client (No Auth)',
      });
      return;
    }

    this.logger.debug(
      'OAuth client registration request',
      {
        body: req.body,
        headers: req.headers,
      },
      'OAuthHandler'
    );

    // Generate client credentials
    const clientId = `client_${randomUUID()}`;
    const clientSecret = `secret_${randomUUID()}`;

    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      grant_types: req.body.grant_types || ['client_credentials', 'authorization_code'],
      token_endpoint_auth_method: 'client_secret_basic',
      scope: 'mcp',
      redirect_uris: req.body.redirect_uris || [],
      response_types: req.body.response_types || ['code'],
      client_name: req.body.client_name || 'Claude MCP Client',
    });
  }

  /**
   * Handle OAuth token endpoint
   */
  handleTokenRequest(req: Request, res: Response): void {
    if (!this.config.enabled) {
      // Even when auth is disabled, we need to support token requests
      // for MCP compatibility. Return a dummy token.
      res.json({
        access_token: 'dummy-token-no-auth-required',
        token_type: 'Bearer',
        scope: '',
      });
      return;
    }

    const grantType = req.body.grant_type;

    this.logger.debug(
      'OAuth token request',
      {
        grant_type: grantType,
        has_code: !!req.body.code,
        has_client_id: !!req.body.client_id,
        has_code_verifier: !!req.body.code_verifier,
      },
      'OAuthHandler'
    );

    if (grantType === 'authorization_code') {
      // Validate authorization code
      if (!req.body.code || !req.body.code.startsWith('authcode_')) {
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Invalid authorization code',
        });
        return;
      }

      // Return static token (in production, generate dynamic tokens)
      res.json({
        access_token: 'ee-mcp-dUAm2TmZp_xP2oPHYI8jkChpvlDsCK72STSkJuMNbbs',
        token_type: 'Bearer',
        scope: 'mcp',
      });
    } else if (grantType === 'client_credentials') {
      // Return static token for client credentials
      res.json({
        access_token: 'ee-mcp-dUAm2TmZp_xP2oPHYI8jkChpvlDsCK72STSkJuMNbbs',
        token_type: 'Bearer',
        scope: 'mcp',
      });
    } else {
      res.status(400).json({
        error: 'unsupported_grant_type',
        error_description:
          'Only authorization_code and client_credentials grant types are supported',
      });
    }
  }

  /**
   * Handle OAuth authorization endpoint
   */
  handleAuthorizationRequest(req: Request, res: Response): void {
    if (!this.config.enabled) {
      // Even when auth is disabled, we need to support authorization requests
      // for MCP compatibility. Return a dummy authorization code.
      const redirectUri = req.query.redirect_uri as string;
      const state = req.query.state as string;

      if (!redirectUri) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'redirect_uri is required',
        });
        return;
      }

      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.append('code', `dummy_code_${randomUUID()}`);
      if (state) {
        redirectUrl.searchParams.append('state', state);
      }

      res.redirect(302, redirectUrl.toString());
      return;
    }

    const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method } =
      req.query;

    this.logger.debug(
      'OAuth authorization request',
      {
        response_type,
        client_id,
        redirect_uri,
        state: state ? 'present' : 'missing',
        code_challenge: code_challenge ? 'present' : 'missing',
        code_challenge_method,
      },
      'OAuthHandler'
    );

    if (!redirect_uri) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri is required',
      });
      return;
    }

    // Generate authorization code
    const authCode = `authcode_${randomUUID()}`;

    // Build redirect URL
    const redirectUrl = new URL(redirect_uri as string);
    redirectUrl.searchParams.append('code', authCode);
    if (state) {
      redirectUrl.searchParams.append('state', state as string);
    }

    this.logger.info(
      'Auto-approving OAuth authorization',
      {
        client_id,
        redirect_uri,
        authCode,
      },
      'OAuthHandler'
    );

    res.redirect(302, redirectUrl.toString());
  }

  /**
   * Validate API key from request
   */
  async validateApiKey(
    req: Request
  ): Promise<{ valid: boolean; context?: ApiKeyContext; error?: string }> {
    if (!this.config.enabled) {
      return { valid: true };
    }

    // Extract API key from various sources
    let providedKey: string | undefined;

    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      providedKey = authHeader.substring(7).trim();

      this.logger.debug(
        'Bearer token received',
        {
          keyPrefix: providedKey.substring(0, 20) + '...',
          keyLength: providedKey.length,
          hasNewline: providedKey.includes('\n'),
          hasCarriageReturn: providedKey.includes('\r'),
          hasSpace: providedKey !== providedKey.trim(),
        },
        'OAuthHandler'
      );
    } else {
      providedKey =
        (req.headers['x-api-key'] as string) ||
        (req.query.apiKey as string) ||
        (req.query.api_key as string);
    }

    if (!providedKey) {
      return { valid: false, error: 'API key required' };
    }

    if (!this.connectionManager) {
      this.logger.error(
        'No connection manager available for API key validation',
        new Error('ConnectionManager not initialized'),
        'OAuthHandler'
      );
      return { valid: false, error: 'Internal server error during authentication' };
    }

    try {
      const keyHash = crypto.createHash('sha256').update(providedKey).digest('hex');
      const pool = await this.connectionManager.getPool();

      const result = await pool.query(
        `SELECT * FROM documents.api_keys 
         WHERE api_key_hash = $1 
         AND is_active = true 
         AND is_deleted = false
         AND (expires_at IS NULL OR expires_at > NOW())`,
        [keyHash]
      );

      if (result.rows.length === 0) {
        this.logger.warn(
          'Invalid API key',
          {
            ip: req.ip,
            keyHash: keyHash.substring(0, 8) + '...',
          },
          'OAuthHandler'
        );
        return { valid: false, error: 'Invalid API key' };
      }

      const apiKeyRecord = result.rows[0];

      // Update last used timestamp
      await pool.query(
        `UPDATE documents.api_keys 
         SET last_used_at = NOW() 
         WHERE api_key_id = $1`,
        [apiKeyRecord.api_key_id]
      );

      const context: ApiKeyContext = {
        keyId: apiKeyRecord.api_key_id,
        projectId: apiKeyRecord.project_id,
        permissions: apiKeyRecord.permissions || [],
        metadata: apiKeyRecord.reference_data || {},
        userId: apiKeyRecord.user_id,
        companyId: apiKeyRecord.company_id,
      };

      this.logger.info(
        'API key authenticated',
        {
          keyId: apiKeyRecord.api_key_id,
          projectId: apiKeyRecord.project_id,
        },
        'OAuthHandler'
      );

      return { valid: true, context };
    } catch (error) {
      this.logger.error('API key validation error', error as Error, 'OAuthHandler');
      return { valid: false, error: 'Internal server error during authentication' };
    }
  }
}
