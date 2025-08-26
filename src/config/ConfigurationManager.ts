/**
 * Centralized configuration management using config.json file.
 * Validates and provides typed access to all configuration values.
 *
 * Environment variable support:
 * - DB_PASSWORD: Can override database.password for security (avoid storing in config.json)
 * All other configuration must be in config.json.
 */

import fs from 'fs';
import path from 'path';

import dotenv from 'dotenv';

import { LogLevel } from '../logging/types/LogTypes.js';

import { DatabaseConfig, createDatabaseConfig } from './DatabaseConfig.js';
import { ServerConfig, createServerConfig } from './ServerConfig.js';

export interface AppInfo {
  name: string;
  displayName: string;
  version: string;
}

export interface LoggingConfig {
  level: LogLevel;
  directory: string;
  maxFiles: number;
  maxSize: string;
}

export interface AppConfig {
  app: AppInfo;
  database: DatabaseConfig;
  server: ServerConfig;
  logging: LoggingConfig;
  features?: {
    events?: {
      enabled: boolean;
      processors?: string[];
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

export class ConfigurationManager {
  private static instance: ConfigurationManager;
  private config: AppConfig;
  private logger = console; // Use console for early logging before logger is initialized

  /**
   * Get singleton instance
   */
  static getInstance(envPath?: string): ConfigurationManager {
    if (!ConfigurationManager.instance) {
      ConfigurationManager.instance = new ConfigurationManager(envPath);
    }
    return ConfigurationManager.instance;
  }

  private constructor(envPath?: string) {
    this.logger.debug('[ConfigurationManager] Initializing configuration', { envPath });

    // ALWAYS load environment variables first (they have priority)
    if (envPath) {
      this.logger.debug('[ConfigurationManager] Loading env from file', { path: envPath });
      const result = dotenv.config({ path: envPath });
      if (result.error) {
        this.logger.error('[ConfigurationManager] Failed to load env file', result.error);
      } else {
        this.logger.debug('[ConfigurationManager] Env file loaded', {
          varsLoaded: Object.keys(result.parsed || {}).length,
        });
      }
    } else {
      this.logger.debug('[ConfigurationManager] Loading env from default .env file');
      dotenv.config();
    }

    // Check if we should use config.json as fallback
    const useConfigJson = process.env.USE_CONFIG_JSON === 'true';
    const configPath = path.join(process.cwd(), 'config.json');
    let jsonConfig: any = null;

    if (useConfigJson && fs.existsSync(configPath)) {
      try {
        this.logger.debug('[ConfigurationManager] Loading configuration from config.json as fallback');
        const configContent = fs.readFileSync(configPath, 'utf8');
        jsonConfig = JSON.parse(configContent);
        this.logger.debug('[ConfigurationManager] Successfully loaded config.json');
      } catch (error) {
        this.logger.error('[ConfigurationManager] Failed to load config.json', error);
      }
    }

    // Build configuration - prioritize environment variables
    if (process.env.DB_HOST) {
      this.logger.debug('[ConfigurationManager] Building configuration from environment variables');
      this.config = this.buildConfigFromEnv();
    } else if (jsonConfig) {
      this.logger.debug('[ConfigurationManager] Building configuration from config.json (no env vars found)');
      this.config = this.buildConfigFromJson(jsonConfig);
    } else {
      this.logger.error('[ConfigurationManager] No configuration found in environment or config.json');
      throw new Error(
        'Configuration required. Set environment variables or provide config.json with USE_CONFIG_JSON=true'
      );
    }

    this.logger.debug('[ConfigurationManager] Configuration built', {
      logLevel: this.config.logging.level,
      dbHost: this.config.database.host,
      serverPort: this.config.server.port,
    });

    this.validateConfiguration();

    this.logger.info('[ConfigurationManager] Configuration loaded and validated successfully');
  }

  /**
   * Build configuration from environment variables
   */
  private buildConfigFromEnv(): AppConfig {
    // Read version from package.json
    let version = process.env.APP_VERSION || 'auto';
    if (version === 'auto') {
      try {
        const packageJsonPath = path.join(process.cwd(), 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        version = packageJson.version || '1.0.0';
      } catch (error) {
        this.logger.warn('[ConfigurationManager] Failed to read package.json version', error);
        version = '1.0.0';
      }
    }

    return {
      app: {
        name: process.env.SERVICE_NAME || 'ee-postgres',
        displayName: process.env.APP_DISPLAY_NAME || 'EE PostgreSQL MCP Server',
        version: version,
      },
      database: createDatabaseConfig({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_DATABASE || 'postgres',
        schema: process.env.DB_SCHEMA || 'documents',
        ssl: process.env.DB_SSL === 'true',
        poolConfig: {
          max: parseInt(process.env.DB_POOL_MAX || '10'),
          idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS || '30000'),
          connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT_MS || '5000'),
        },
      }),
      server: createServerConfig(process.env),
      logging: {
        level: (process.env.LOG_LEVEL?.toUpperCase() as LogLevel) || 'INFO',
        directory: process.env.LOG_DIRECTORY || './logs',
        maxFiles: parseInt(process.env.LOG_MAX_FILES || '7'),
        maxSize: process.env.LOG_MAX_SIZE || '20m',
      },
      features: {
        events: {
          enabled: process.env.FEATURE_EVENTS_ENABLED === 'true',
          processors: process.env.FEATURE_EVENTS_PROCESSORS?.split(',').filter(p => p) || [],
          bufferSize: parseInt(process.env.FEATURE_EVENTS_BUFFER_SIZE || '10000'),
        },
        resources: {
          enabled: process.env.FEATURE_RESOURCES_ENABLED === 'true',
          cacheEnabled: process.env.FEATURE_RESOURCES_CACHE_ENABLED !== 'false',
          cacheTTL: parseInt(process.env.FEATURE_RESOURCES_CACHE_TTL || '300'),
        },
        prompts: {
          enabled: process.env.FEATURE_PROMPTS_ENABLED === 'true',
          customPromptsPath: process.env.FEATURE_PROMPTS_PATH,
        },
        optimization: {
          enabled: process.env.FEATURE_OPTIMIZATION_ENABLED === 'true',
          autoOptimize: process.env.FEATURE_OPTIMIZATION_AUTO === 'true',
          learningEnabled: process.env.FEATURE_OPTIMIZATION_LEARNING === 'true',
        },
      },
    };
  }

  /**
   * Build configuration from JSON object
   */
  private buildConfigFromJson(json: any): AppConfig {
    // Allow DB_PASSWORD to be overridden by environment variable for security
    const dbPassword = process.env.DB_PASSWORD || json.database?.password || '';

    // Read version from package.json if app.version is 'auto'
    let version = json.app?.version || '1.0.0';
    if (version === 'auto') {
      try {
        const packageJsonPath = path.join(process.cwd(), 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        version = packageJson.version || '1.0.0';
      } catch (error) {
        this.logger.warn('[ConfigurationManager] Failed to read package.json version', error);
        version = '1.0.0';
      }
    }

    return {
      app: {
        name: json.app?.name || 'ee-postgres',
        displayName: json.app?.displayName || 'EE PostgreSQL MCP Server',
        version: version,
      },
      database: createDatabaseConfig({
        ...json.database,
        password: dbPassword,
      }),
      server: createServerConfig(json.server || {}),
      logging: {
        level: (json.logging?.level?.toUpperCase() as LogLevel) || 'INFO',
        directory: json.logging?.directory || './logs',
        maxFiles: json.logging?.maxFiles || 7,
        maxSize: json.logging?.maxSize || '20m',
      },
      features: {
        events: {
          enabled: json.features?.events?.enabled || false,
          processors: json.features?.events?.processors || [],
          bufferSize: json.features?.events?.bufferSize || 10000,
        },
        resources: {
          enabled: json.features?.resources?.enabled || false,
          cacheEnabled: json.features?.resources?.cacheEnabled !== false,
          cacheTTL: json.features?.resources?.cacheTTL || 300,
        },
        prompts: {
          enabled: json.features?.prompts?.enabled || false,
          customPromptsPath: json.features?.prompts?.customPromptsPath,
        },
        optimization: {
          enabled: json.features?.optimization?.enabled || false,
          autoOptimize: json.features?.optimization?.autoOptimize || false,
          learningEnabled: json.features?.optimization?.learningEnabled || false,
        },
      },
    };
  }

  /**
   * Validate the complete configuration
   */
  private validateConfiguration(): void {
    this.logger.debug('[ConfigurationManager] Validating configuration');

    const errors: string[] = [];

    // Check required database fields
    if (!this.config.database.host) {
      errors.push('DB_HOST is required');
    }
    if (!this.config.database.user) {
      errors.push('DB_USER is required');
    }
    if (!this.config.database.password) {
      errors.push('DB_PASSWORD is required');
    }
    if (!this.config.database.database) {
      errors.push('DB_NAME is required');
    }

    // Validate log level
    const validLogLevels: LogLevel[] = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
    if (!validLogLevels.includes(this.config.logging.level)) {
      errors.push(
        `Invalid LOG_LEVEL: ${this.config.logging.level}. Must be one of: ${validLogLevels.join(', ')}`
      );
    }

    // Validate numeric values
    if (this.config.database.port <= 0 || this.config.database.port > 65535) {
      errors.push(`Invalid DB_PORT: ${this.config.database.port}. Must be between 1 and 65535`);
    }

    if (this.config.server.port <= 0 || this.config.server.port > 65535) {
      errors.push(`Invalid SERVER_PORT: ${this.config.server.port}. Must be between 1 and 65535`);
    }

    if (errors.length > 0) {
      this.logger.error('[ConfigurationManager] Configuration validation failed', { errors });
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }

    this.logger.debug('[ConfigurationManager] Configuration validated successfully', {
      requiredFields: {
        host: !!this.config.database.host,
        user: !!this.config.database.user,
        password: '***',
        database: !!this.config.database.database,
      },
      logLevel: this.config.logging.level,
      ports: {
        database: this.config.database.port,
        server: this.config.server.port,
      },
    });
  }

  /**
   * Get app configuration
   */
  get app(): AppInfo {
    return this.config.app;
  }

  /**
   * Get app name
   */
  getAppName(): string {
    return this.config.app.name;
  }

  /**
   * Get app display name
   */
  getDisplayName(): string {
    return this.config.app.displayName;
  }

  /**
   * Get app version
   */
  getVersion(): string {
    return this.config.app.version;
  }

  /**
   * Get log directory
   */
  getLogDirectory(): string {
    return this.config.logging.directory;
  }

  /**
   * Get log level
   */
  getLogLevel(): LogLevel {
    return this.config.logging.level;
  }

  /**
   * Get server port
   */
  getServerPort(): number {
    return this.config.server.port;
  }

  /**
   * Build service name with optional component
   */
  getServiceName(component?: string): string {
    return component ? `${this.config.app.name}-${component}` : this.config.app.name;
  }

  /**
   * Get database configuration
   */
  get database(): DatabaseConfig {
    return this.config.database;
  }

  /**
   * Get server configuration
   */
  get server(): ServerConfig {
    return this.config.server;
  }

  /**
   * Get logging configuration
   */
  get logging() {
    return this.config.logging;
  }

  /**
   * Get features configuration
   */
  get features() {
    return this.config.features;
  }

  /**
   * Get complete configuration
   */
  get all(): AppConfig {
    return this.config;
  }

  /**
   * Create a safe version of config for logging (without sensitive data)
   */
  getSafeConfig(): {
    database: Partial<DatabaseConfig>;
    server: ServerConfig;
    logging: LoggingConfig;
  } {
    return {
      database: {
        host: this.config.database.host,
        port: this.config.database.port,
        database: this.config.database.database,
        schema: this.config.database.schema,
        user: this.config.database.user,
        ssl: !!this.config.database.ssl,
        poolConfig: this.config.database.poolConfig,
      },
      server: this.config.server,
      logging: this.config.logging,
    };
  }
}
