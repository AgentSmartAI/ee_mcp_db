/**
 * Database configuration with validation and type safety.
 * Handles PostgreSQL connection parameters from environment variables.
 */

import Joi from 'joi';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  schema: string;
  user: string;
  password: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
  poolConfig?: {
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
  };
  usePreparedStatements?: boolean;
}

export const databaseConfigSchema = Joi.object({
  host: Joi.string().required(),
  port: Joi.number().port().required(),
  database: Joi.string().required(),
  schema: Joi.string().default('public'),
  user: Joi.string().required(),
  password: Joi.string().required(),
  ssl: Joi.alternatives()
    .try(
      Joi.boolean(),
      Joi.object({
        rejectUnauthorized: Joi.boolean(),
      })
    )
    .optional(),
  poolConfig: Joi.object({
    max: Joi.number().integer().min(1).max(100).default(10),
    idleTimeoutMillis: Joi.number().integer().min(1000).default(30000),
    connectionTimeoutMillis: Joi.number().integer().min(1000).default(2000),
  }).optional(),
  usePreparedStatements: Joi.boolean().optional().default(true),
});

export function createDatabaseConfig(source: NodeJS.ProcessEnv | any): DatabaseConfig {
  const logger = console; // Use console for config logging

  // Check if source is environment variables or JSON config
  const isEnv = source === process.env || (source && source.DB_HOST !== undefined);

  logger.debug(
    '[DatabaseConfig] Building database configuration from',
    isEnv ? 'environment' : 'JSON'
  );

  let config: DatabaseConfig;

  if (isEnv) {
    const env = source as NodeJS.ProcessEnv;
    config = {
      host: env.DB_HOST!,
      port: parseInt(env.DB_PORT || '5432'),
      database: env.DB_NAME!,
      schema: env.DB_SCHEMA || 'public',
      user: env.DB_USER!,
      password: env.DB_PASSWORD!,
    };
  } else {
    // Handle JSON config
    config = {
      host: source.host || 'localhost',
      port: source.port || 5432,
      database: source.database || 'postgres',
      schema: source.schema || 'public',
      user: source.user || 'postgres',
      password: source.password || '',
    };
  }

  logger.debug('[DatabaseConfig] Base configuration', {
    host: config.host,
    port: config.port,
    database: config.database,
    schema: config.schema,
    user: config.user,
    hasPassword: !!config.password,
  });

  // Handle SSL configuration
  if (isEnv) {
    const env = source as NodeJS.ProcessEnv;
    if (env.DB_SSL === 'true') {
      config.ssl =
        env.DB_SSL_REJECT_UNAUTHORIZED === 'false' ? { rejectUnauthorized: false } : true;
      logger.debug('[DatabaseConfig] SSL configured', {
        ssl: config.ssl,
        rejectUnauthorized: typeof config.ssl === 'object' ? config.ssl.rejectUnauthorized : true,
      });
    }

    // Handle pool configuration
    if (env.DB_POOL_MAX || env.DB_POOL_IDLE_TIMEOUT_MS || env.DB_POOL_CONNECTION_TIMEOUT_MS) {
      config.poolConfig = {
        max: parseInt(env.DB_POOL_MAX || '20'), // Increased default from 10 to 20
        idleTimeoutMillis: parseInt(env.DB_POOL_IDLE_TIMEOUT_MS || '30000'),
        connectionTimeoutMillis: parseInt(env.DB_POOL_CONNECTION_TIMEOUT_MS || '5000'), // Increased from 2s to 5s
      };
      logger.debug('[DatabaseConfig] Pool configuration', config.poolConfig);
    }
  } else {
    // Handle JSON config
    if (source.ssl !== undefined) {
      config.ssl = source.ssl;
    }
    if (source.poolConfig) {
      config.poolConfig = source.poolConfig;
    }
    if (source.usePreparedStatements !== undefined) {
      config.usePreparedStatements = source.usePreparedStatements;
    }
  }

  // Validate configuration
  const { error, value } = databaseConfigSchema.validate(config);
  if (error) {
    logger.error('[DatabaseConfig] Configuration validation failed', {
      error: error.message,
      details: error.details,
    });
    throw new Error(`Invalid database configuration: ${error.message}`);
  }

  logger.debug('[DatabaseConfig] Database configuration validated successfully');

  return value as DatabaseConfig;
}
