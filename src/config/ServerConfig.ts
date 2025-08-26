/**
 * Server configuration for MCP and SSE transport.
 * Handles server-specific settings and CORS configuration.
 */

import Joi from 'joi';

export interface ServerConfig {
  port: number;
  cors: {
    enabled: boolean;
    origins: string[];
  };
  queryTimeoutMs: number;
  maxResultRows: number;
  auth: {
    enabled: boolean;
    apiKey?: string;
    allowedIPs?: string[];
  };
  enableWriteOperations: boolean;
  enableManagedTables: boolean;
}

export const serverConfigSchema = Joi.object({
  port: Joi.number().port().required(),
  cors: Joi.object({
    enabled: Joi.boolean().default(true),
    origins: Joi.array().items(Joi.string()).default(['*']),
  }).default(),
  queryTimeoutMs: Joi.number().integer().min(1000).max(300000).default(30000),
  maxResultRows: Joi.number().integer().min(1).max(100000).default(10000),
  auth: Joi.object({
    enabled: Joi.boolean().default(false),
    apiKey: Joi.string().optional(),
    allowedIPs: Joi.array().items(Joi.string()).optional(),
  }).default(),
  enableWriteOperations: Joi.boolean().default(false),
  enableManagedTables: Joi.boolean().default(false),
});

export function createServerConfig(source: NodeJS.ProcessEnv | any): ServerConfig {
  const logger = console; // Use console for config logging

  // Check if source is environment variables or JSON config
  const isEnv = source === process.env || (source && source.MCP_PORT !== undefined);

  logger.debug('[ServerConfig] Building server configuration from', isEnv ? 'environment' : 'JSON');

  let config: ServerConfig;

  if (isEnv) {
    const env = source as NodeJS.ProcessEnv;
    config = {
      port: parseInt(env.MCP_PORT || '8090'),
      cors: {
        enabled: env.CORS_ENABLED !== 'false',
        origins: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((o) => o.trim()) : ['*'],
      },
      queryTimeoutMs: parseInt(env.QUERY_TIMEOUT_MS || '30000'),
      maxResultRows: parseInt(env.MAX_RESULT_ROWS || '10000'),
      auth: {
        enabled: env.AUTH_ENABLED === 'true',
        apiKey: env.MCP_API_KEY,
        allowedIPs: env.ALLOWED_IPS ? env.ALLOWED_IPS.split(',').map((ip) => ip.trim()) : undefined,
      },
      enableWriteOperations: env.ENABLE_WRITE_OPERATIONS === 'true',
      enableManagedTables: env.ENABLE_MANAGED_TABLES === 'true',
    };
  } else {
    // Handle JSON config - directly use the structure from JSON
    config = {
      port: source.port || 8090,
      cors: {
        enabled: source.cors?.enabled !== false,
        origins: source.cors?.origins || ['*'],
      },
      queryTimeoutMs: source.queryTimeoutMs || 30000,
      maxResultRows: source.maxResultRows || 10000,
      auth: {
        enabled: source.auth?.enabled || false,
        apiKey: source.auth?.apiKey,
        allowedIPs: source.auth?.allowedIPs,
      },
      enableWriteOperations: source.enableWriteOperations || false,
      enableManagedTables: source.enableManagedTables || false,
    };
  }

  logger.debug('[ServerConfig] Raw configuration', {
    port: config.port,
    corsEnabled: config.cors.enabled,
    corsOrigins: config.cors.origins,
    queryTimeoutMs: config.queryTimeoutMs,
    maxResultRows: config.maxResultRows,
    authEnabled: config.auth.enabled,
    hasApiKey: !!config.auth.apiKey,
    allowedIPCount: config.auth.allowedIPs?.length || 0,
    enableWriteOperations: config.enableWriteOperations,
    enableManagedTables: config.enableManagedTables,
  });

  // Validate configuration
  const { error, value } = serverConfigSchema.validate(config);
  if (error) {
    logger.error('[ServerConfig] Configuration validation failed', {
      error: error.message,
      details: error.details,
    });
    throw new Error(`Invalid server configuration: ${error.message}`);
  }

  logger.debug('[ServerConfig] Server configuration validated successfully');

  return value as ServerConfig;
}
