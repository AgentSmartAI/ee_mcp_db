/**
 * Main server orchestrator with modular architecture.
 * Coordinates tools, transport, and database connections.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { ConfigurationManager } from '../config/ConfigurationManager.js';
import { PostgresConnectionManager } from '../database/PostgresConnectionManager.js';
import { QueryValidator } from '../database/QueryValidator.js';
import { EventCollector } from '../events/EventCollector.js';
import {
  QueryOptimizationProcessor,
  ErrorRecoveryProcessor,
  MetricsAggregationProcessor,
} from '../events/EventProcessor.js';
import { EventType, createEvent } from '../events/EventTypes.js';
import { LogRotationManager } from '../logging/LogRotationManager.js';
import { StructuredLogger } from '../logging/StructuredLogger.js';
import { BatchQueryTool } from '../tools/BatchQueryTool.js';
import { CreateJobTool } from '../tools/CreateJobTool.js';
import { CreateManagedTableTool } from '../tools/CreateManagedTableTool.js';
import { CreateTaskTool } from '../tools/CreateTaskTool.js';
import { DatabaseCatalogTool } from '../tools/DatabaseCatalogTool.js';
import { HelpTool } from '../tools/HelpTool.js';
import { PopTaskTool } from '../tools/PopTaskTool.js';
import { QueryExecutorTool } from '../tools/QueryExecutorTool.js';
import { SchemaExplorerTool } from '../tools/SchemaExplorerTool.js';
import { TableInspectorTool } from '../tools/TableInspectorTool.js';
import { MCPTool, HealthStatus } from '../types/index.js';
import { TraceIdGenerator } from '../utils/TraceIdGenerator.js';

import { createStreamableHttpServer } from './createStreamableHttpServer.js';

export class EEDatabaseMCPServer {
  private server: Server;
  private config: ConfigurationManager;
  private logger: StructuredLogger;
  private logRotationManager: LogRotationManager;
  private connectionManager: PostgresConnectionManager;
  private validator: QueryValidator;
  private eventCollector?: EventCollector;
  // Transport is now managed by createStreamableHttpServer
  private tools: Map<string, MCPTool> = new Map();
  private startTime: Date;
  private sessionMap: Map<string, string> = new Map(); // Maps connection context to sessionId

  constructor(configPath?: string) {
    this.startTime = new Date();

    // Initialize configuration - use environment variables
    this.logger = new StructuredLogger({
      level: (process.env.LOG_LEVEL || 'INFO') as any,
      directory: process.env.LOG_DIRECTORY || './logs',
      maxFiles: parseInt(process.env.LOG_MAX_FILES || '7'),
      maxSize: process.env.LOG_MAX_SIZE || '20m',
      service: process.env.SERVICE_NAME || 'ee-postgres',
    });

    this.logger.trace('Initializing configuration', { configPath }, 'EEDatabaseMCPServer');

    try {
      this.config = ConfigurationManager.getInstance(configPath);
      this.logger.debug(
        'Configuration loaded successfully',
        {
          hasConfigPath: !!configPath,
          configSource: 'config.json',
        },
        'EEDatabaseMCPServer'
      );
    } catch (error) {
      this.logger.error('Failed to load configuration', error as Error, 'EEDatabaseMCPServer');
      throw error;
    }

    // Reinitialize logger with loaded config
    this.logger = new StructuredLogger({
      ...this.config.logging,
      service: this.config.getServiceName(),
    });

    // Initialize log rotation
    this.logRotationManager = new LogRotationManager(
      this.config.getLogDirectory(),
      this.config.logging.maxFiles,
      this.logger
    );

    // Log startup
    this.logger.info(
      `${this.config.getDisplayName()} initializing`,
      {
        config: this.config.getSafeConfig(),
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
        memory: {
          heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        },
      },
      'EEDatabaseMCPServer'
    );

    // Initialize database components
    this.logger.debug('Initializing database components', {}, 'EEDatabaseMCPServer');
    this.connectionManager = new PostgresConnectionManager(this.config.database, this.logger);

    this.validator = new QueryValidator(this.logger, this.config.server.enableWriteOperations);
    this.logger.debug('Database components initialized', {}, 'EEDatabaseMCPServer');

    // Initialize MCP server
    this.logger.debug('Initializing MCP server', {}, 'EEDatabaseMCPServer');
    this.server = new Server(
      {
        name: this.config.getAppName(),
        version: this.config.getVersion(),
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
    this.logger.debug('MCP server initialized', {}, 'EEDatabaseMCPServer');

    // Initialize event collector if enabled
    if (this.config.features?.events?.enabled) {
      this.logger.info('Initializing event collector', {}, 'EEDatabaseMCPServer');
      this.eventCollector = new EventCollector(this.logger);
      this.setupEventProcessors();
    }

    // Initialize tools
    this.initializeTools();

    // Setup request handlers
    this.setupRequestHandlers();
  }

  /**
   * Initialize all tools
   */
  private initializeTools(): void {
    this.logger.debug('Starting tool initialization', {}, 'EEDatabaseMCPServer');

    try {
      // Create tool instances
      this.logger.trace(
        'Creating QueryExecutorTool',
        {
          queryTimeoutMs: this.config.server.queryTimeoutMs,
          maxResultRows: this.config.server.maxResultRows,
        },
        'EEDatabaseMCPServer'
      );
      const queryExecutor = new QueryExecutorTool(
        this.connectionManager,
        this.validator,
        this.logger,
        this.eventCollector,
        this.config.server.queryTimeoutMs,
        this.config.server.maxResultRows,
        this.config.server.enableWriteOperations
      );

      this.logger.trace(
        'Creating BatchQueryTool',
        {
          enableWriteOperations: this.config.server.enableWriteOperations,
        },
        'EEDatabaseMCPServer'
      );
      const batchQueryTool = new BatchQueryTool(
        this.connectionManager,
        this.validator,
        this.logger,
        this.eventCollector,
        60000, // 1 minute default timeout for batch
        this.config.server.enableWriteOperations
      );

      this.logger.trace('Creating SchemaExplorerTool', {}, 'EEDatabaseMCPServer');
      const schemaExplorer = new SchemaExplorerTool(
        this.connectionManager,
        this.logger,
        this.config.database.schema
      );

      this.logger.trace('Creating TableInspectorTool', {}, 'EEDatabaseMCPServer');
      const tableInspector = new TableInspectorTool(
        this.connectionManager,
        this.logger,
        this.config.database.schema
      );

      this.logger.trace('Creating DatabaseCatalogTool', {}, 'EEDatabaseMCPServer');
      const databaseCatalog = new DatabaseCatalogTool(this.connectionManager, this.logger);

      // Create help tool
      this.logger.trace('Creating HelpTool', {}, 'EEDatabaseMCPServer');
      const helpTool = new HelpTool(
        this.logger,
        this.config.server.enableWriteOperations,
        this.config.server.enableManagedTables
      );

      // Create PopTaskTool
      this.logger.trace('Creating PopTaskTool', {}, 'EEDatabaseMCPServer');
      const popTaskTool = new PopTaskTool(
        this.connectionManager,
        this.validator,
        this.logger,
        this.eventCollector
      );

      // Create CreateTaskTool
      this.logger.trace('Creating CreateTaskTool', {}, 'EEDatabaseMCPServer');
      const createTaskTool = new CreateTaskTool(
        this.connectionManager,
        this.validator,
        this.logger,
        this.eventCollector
      );

      // Create CreateJobTool
      this.logger.trace('Creating CreateJobTool', {}, 'EEDatabaseMCPServer');
      const createJobTool = new CreateJobTool(
        this.connectionManager,
        this.validator,
        this.logger,
        this.eventCollector
      );

      // Register tools
      this.logger.trace('Registering tools', {}, 'EEDatabaseMCPServer');
      this.tools.set(helpTool.name, helpTool);
      this.tools.set(queryExecutor.name, queryExecutor);
      this.tools.set(batchQueryTool.name, batchQueryTool);
      this.tools.set(schemaExplorer.name, schemaExplorer);
      this.tools.set(tableInspector.name, tableInspector);
      this.tools.set(databaseCatalog.name, databaseCatalog);
      this.tools.set(popTaskTool.name, popTaskTool);
      this.tools.set(createTaskTool.name, createTaskTool);
      this.tools.set(createJobTool.name, createJobTool);

      // Conditionally register CreateManagedTableTool
      if (this.config.server.enableManagedTables) {
        this.logger.trace('Creating CreateManagedTableTool', {}, 'EEDatabaseMCPServer');
        const createManagedTableTool = new CreateManagedTableTool(
          this.connectionManager,
          this.logger,
          this.eventCollector
        );
        this.tools.set(createManagedTableTool.name, createManagedTableTool);
      }

      this.logger.info(
        'Tools initialized',
        {
          toolCount: this.tools.size,
          tools: Array.from(this.tools.keys()),
          defaultSchema: this.config.database.schema,
          managedTablesEnabled: this.config.server.enableManagedTables,
        },
        'EEDatabaseMCPServer'
      );
    } catch (error) {
      this.logger.error('Failed to initialize tools', error as Error, 'EEDatabaseMCPServer');
      throw error;
    }
  }

  /**
   * Setup MCP request handlers
   */
  private setupRequestHandlers(): void {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.logger.trace('List tools request received', {}, 'EEDatabaseMCPServer');

      const tools: Tool[] = Array.from(this.tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: 'object' as const,
          properties: tool.inputSchema.properties,
          required: tool.inputSchema.required,
        },
      }));

      this.logger.debug(
        'Tools listed',
        {
          count: tools.length,
          toolNames: tools.map((t) => t.name),
        },
        'EEDatabaseMCPServer'
      );

      return { tools };
    });

    // Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const traceId = TraceIdGenerator.generate();

      // Generate a session ID for this request chain
      // Since we don't have access to transport sessionId directly, we'll create one per request batch
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      this.logger.info(
        'Tool call received',
        {
          tool: name,
          requestId,
          traceId,
          sessionId,
          hasArgs: !!args,
          argKeys: args ? Object.keys(args) : [],
        },
        'EEDatabaseMCPServer'
      );

      this.logger.trace(
        'Tool call arguments',
        {
          tool: name,
          requestId,
          traceId,
          sessionId,
          args: args ? JSON.stringify(args).slice(0, 200) : null,
        },
        'EEDatabaseMCPServer'
      );

      try {
        const tool = this.tools.get(name);
        if (!tool) {
          this.logger.warn(
            'Unknown tool requested',
            {
              tool: name,
              requestId,
              availableTools: Array.from(this.tools.keys()),
            },
            'EEDatabaseMCPServer'
          );
          throw new Error(`Unknown tool: ${name}`);
        }

        this.logger.debug(
          'Executing tool',
          {
            tool: name,
            requestId,
            toolClass: tool.constructor.name,
          },
          'EEDatabaseMCPServer'
        );

        // Execute tool with context
        const result = await tool.execute(args, {
          requestId,
          traceId,
          sessionId,
          startTime: Date.now(),
        });

        this.logger.info(
          'Tool call completed',
          {
            tool: name,
            requestId,
            traceId,
            sessionId,
            duration: result.metadata?.duration_ms,
            success: !result.metadata?.error,
            contentType: result.content[0].type,
            hasMetadata: !!result.metadata,
          },
          'EEDatabaseMCPServer'
        );

        // Return in MCP format with trace ID in the content
        try {
          const mcpResponse = {
            content: result.content,
            _meta: {
              traceId: traceId,
            },
          };

          this.logger.debug(
            'Preparing MCP response',
            {
              tool: name,
              requestId,
              traceId,
              sessionId,
              contentCount: mcpResponse.content.length,
              contentTypes: mcpResponse.content.map((c) => c.type),
              contentLengths: mcpResponse.content.map((c) => ('text' in c ? c.text.length : 0)),
              hasMeta: !!mcpResponse._meta,
            },
            'EEDatabaseMCPServer'
          );

          this.logger.debug(
            'About to return MCP response',
            {
              tool: name,
              requestId,
              traceId,
              sessionId,
              responseSize: JSON.stringify(mcpResponse).length,
            },
            'EEDatabaseMCPServer'
          );

          return mcpResponse;
        } catch (responseError) {
          this.logger.error(
            'Failed to prepare MCP response',
            {
              tool: name,
              requestId,
              traceId,
              sessionId,
              responseError:
                responseError instanceof Error ? responseError.message : String(responseError),
            },
            'EEDatabaseMCPServer'
          );

          // Return minimal response
          return {
            content: [
              {
                type: 'text',
                text: 'Failed to prepare response. Please check logs.',
              },
            ],
            _meta: {
              traceId: traceId,
            },
          };
        }
      } catch (error) {
        const errorDetails =
          error instanceof Error
            ? {
                message: error.message,
                stack: error.stack,
                name: error.name,
                ...((error as any).code && { code: (error as any).code }),
              }
            : { message: String(error) };

        this.logger.error(
          'Tool call failed',
          {
            tool: name,
            requestId,
            traceId,
            sessionId,
            error: errorDetails,
          },
          'EEDatabaseMCPServer'
        );

        return {
          content: [
            {
              type: 'text',
              text: `Error executing tool ${name}: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          _meta: {
            traceId: traceId,
          },
        };
      }
    });
  }

  /**
   * Enable database logging once pool is available
   */
  private enableDatabaseLogging(): void {
    try {
      // Pool is already available - we just tested the connection with SELECT 1
      // Access the pool directly from the connection manager
      const pool = (this.connectionManager as any).pool;
      if (pool && this.logger instanceof StructuredLogger) {
        this.logger.setPool(pool);
        this.logger.info(
          'Database logging enabled',
          {
            service: this.config.getServiceName(),
            schema: 'logs',
            table: 'service_logs',
          },
          'EEDatabaseMCPServer'
        );
      }
    } catch (error) {
      this.logger.warn('Failed to enable database logging', error as Error, 'EEDatabaseMCPServer');
      // Continue with file-based logging
    }
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    this.logger.debug('Starting server initialization', {}, 'EEDatabaseMCPServer');

    try {
      // Start log rotation
      this.logger.trace('Starting log rotation manager', {}, 'EEDatabaseMCPServer');
      await this.logRotationManager.startAutoCleanup();
      this.logger.debug('Log rotation started', {}, 'EEDatabaseMCPServer');

      // Test database connection
      this.logger.info(
        'Testing database connection...',
        {
          host: this.config.database.host,
          port: this.config.database.port,
          database: this.config.database.database,
        },
        'EEDatabaseMCPServer'
      );

      const connectionStart = Date.now();
      const pool = await this.connectionManager.getPool();
      const testResult = await pool.query('SELECT 1');
      const connectionTime = Date.now() - connectionStart;

      this.logger.info(
        'Database connection successful',
        {
          connectionTime,
          poolSize: this.config.database.poolConfig?.max,
          testResult: testResult.rows[0],
        },
        'EEDatabaseMCPServer'
      );

      // Enable database logging now that pool is available
      this.enableDatabaseLogging();

      // Create server transport - always use StreamableHTTP
      this.logger.debug(
        'Creating Streamable HTTP server',
        {
          port: this.config.server.port,
          corsOrigins: this.config.server.cors.origins,
          authEnabled: this.config.server.auth.enabled,
        },
        'EEDatabaseMCPServer'
      );

      await createStreamableHttpServer(
        this, // Pass the server factory instead of a single server instance
        this.config.server,
        this.logger,
        this.connectionManager,
        this.eventCollector
      );

      this.logger.debug('Streamable HTTP server created and connected', {}, 'EEDatabaseMCPServer');

      const serverName = this.config.server.enableWriteOperations
        ? this.config.getDisplayName()
        : `${this.config.getDisplayName()} (Read-Only)`;

      this.logger.info(
        `${serverName} started`,
        {
          port: this.config.getServerPort(),
          transport: 'StreamableHTTP',
          database: `${this.config.database.host}:${this.config.database.port}/${this.config.database.database}`,
          authEnabled: this.config.server.auth.enabled,
          corsOrigins: this.config.server.cors.origins,
          enableWriteOperations: this.config.server.enableWriteOperations,
          startupTime: Date.now() - this.startTime.getTime(),
        },
        'EEDatabaseMCPServer'
      );

      // Log initial health status
      const health = await this.getHealth();
      this.logger.info('Initial health check', health, 'EEDatabaseMCPServer');
    } catch (error) {
      this.logger.error('Failed to start server', error as Error, 'EEDatabaseMCPServer');
      throw error;
    }
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    this.logger.info(
      `Stopping ${this.config.getDisplayName()}...`,
      {
        uptime: Date.now() - this.startTime.getTime(),
        activeClients: 0, // Client count not available with SDK transport
      },
      'EEDatabaseMCPServer'
    );

    const shutdownStart = Date.now();

    try {
      // Stop log rotation
      this.logger.trace('Stopping log rotation', {}, 'EEDatabaseMCPServer');
      this.logRotationManager.stopAutoCleanup();

      // Stop event collector
      if (this.eventCollector) {
        this.logger.debug('Stopping event collector', {}, 'EEDatabaseMCPServer');
        this.eventCollector.stop();
      }

      // Close database connections
      this.logger.debug('Closing database connections', {}, 'EEDatabaseMCPServer');
      await this.connectionManager.close();
      this.logger.debug('Database connections closed', {}, 'EEDatabaseMCPServer');

      // Transport is managed by the SSE server
      this.logger.debug(
        'SSE server will be closed by process termination',
        {},
        'EEDatabaseMCPServer'
      );

      // Log final statistics
      const uptime = Date.now() - this.startTime.getTime();
      const shutdownTime = Date.now() - shutdownStart;

      this.logger.info(
        'Server stopped',
        {
          uptime,
          uptimeHuman: this.formatUptime(uptime),
          shutdownTime,
          totalRequests: 'N/A',
        },
        'EEDatabaseMCPServer'
      );
    } catch (error) {
      this.logger.error('Error during shutdown', error as Error, 'EEDatabaseMCPServer');
      throw error;
    }
  }

  /**
   * Create a new MCP Server instance for a client connection
   * Each client gets its own isolated server instance
   */
  createServerInstance(): Server {
    this.logger.debug('Creating new MCP server instance for client', {}, 'EEDatabaseMCPServer');

    // Create a new Server instance
    const server = new Server(
      {
        name: this.config.getAppName(),
        version: this.config.getVersion(),
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Register request handlers for this server instance
    // List tools handler
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.logger.trace('List tools request received', {}, 'EEDatabaseMCPServer');

      const tools: Tool[] = Array.from(this.tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: 'object' as const,
          properties: tool.inputSchema.properties,
          required: tool.inputSchema.required,
        },
      }));

      this.logger.debug(
        'Tools listed',
        {
          count: tools.length,
          toolNames: tools.map((t) => t.name),
        },
        'EEDatabaseMCPServer'
      );

      return { tools };
    });

    // Call tool handler
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const traceId = TraceIdGenerator.generate();

      this.logger.info(
        'Tool call received',
        {
          tool: name,
          hasArgs: !!args,
          argKeys: args ? Object.keys(args) : [],
          requestId,
          sessionId,
          traceId,
        },
        'EEDatabaseMCPServer'
      );

      const tool = this.tools.get(name);
      if (!tool) {
        this.logger.warn(
          'Tool not found',
          {
            tool: name,
            availableTools: Array.from(this.tools.keys()),
            requestId,
          },
          'EEDatabaseMCPServer'
        );
        throw new Error(`Tool not found: ${name}`);
      }

      const context = {
        requestId,
        sessionId,
        traceId,
        startTime: Date.now(),
      };

      try {
        this.logger.debug(
          'Executing tool',
          {
            tool: name,
            toolClass: tool.constructor.name,
            requestId,
          },
          'EEDatabaseMCPServer'
        );

        const result = await tool.execute(args || {}, context);

        this.logger.info(
          'Tool call completed',
          {
            tool: name,
            success: true,
            hasMetadata: !!result.metadata,
            contentType: result.content[0]?.type,
            requestId,
            sessionId,
            traceId,
            duration: Date.now() - parseInt(requestId.split('_')[1]),
          },
          'EEDatabaseMCPServer'
        );

        this.logger.debug(
          'Preparing MCP response',
          {
            tool: name,
            contentCount: result.content.length,
            contentTypes: result.content.map((c) => c.type),
            contentLengths: result.content.map((c) => (c.type === 'text' ? c.text.length : 'N/A')),
            hasMeta: !!result.metadata,
            requestId,
            sessionId,
            traceId,
          },
          'EEDatabaseMCPServer'
        );

        this.logger.debug(
          'About to return MCP response',
          {
            tool: name,
            responseSize: JSON.stringify(result).length,
            requestId,
            sessionId,
            traceId,
          },
          'EEDatabaseMCPServer'
        );

        // Return in MCP format with trace ID in the content
        const mcpResponse = {
          content: result.content,
          _meta: {
            traceId: traceId,
          },
        };

        return mcpResponse;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorDetails = error instanceof Error ? error.stack : undefined;

        this.logger.error(
          'Tool call failed',
          {
            tool: name,
            error: { message: errorMessage, stack: errorDetails },
            requestId,
            sessionId,
            traceId,
          },
          'EEDatabaseMCPServer'
        );

        // Emit failure event
        if (this.eventCollector) {
          this.eventCollector.collect(
            createEvent(EventType.ERROR_DETECTED, {
              requestId,
              traceId,
              tool: name,
              error: { message: errorMessage },
            })
          );
        }

        // Return error response in MCP format
        return {
          content: [
            {
              type: 'text',
              text: `Error executing tool ${name}: ${errorMessage}`,
            },
          ],
          _meta: {
            traceId: traceId,
          },
        };
      }
    });

    this.logger.debug('Server instance created with handlers', {}, 'EEDatabaseMCPServer');
    return server;
  }

  /**
   * Get server health status
   */
  async getHealth(): Promise<HealthStatus> {
    this.logger.trace('Performing health check', {}, 'EEDatabaseMCPServer');

    const dbHealth = await this.connectionManager.checkHealth();
    const memoryUsage = process.memoryUsage();

    const health: HealthStatus = {
      status: dbHealth.connected ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks: {
        database: {
          connected: dbHealth.connected,
          latency_ms: dbHealth.latency,
          error: dbHealth.lastError,
          poolStats: {
            active: dbHealth.activeConnections,
            idle: dbHealth.idleConnections,
            waiting: dbHealth.waitingConnections,
          },
        },
        server: {
          uptime_seconds: process.uptime(),
          memory_usage_mb: memoryUsage.heapUsed / 1024 / 1024,
          memory_total_mb: memoryUsage.heapTotal / 1024 / 1024,
          memory_rss_mb: memoryUsage.rss / 1024 / 1024,
          activeClients: 0, // Client count not available with SDK transport
        },
      },
    };

    this.logger.trace(
      'Health check completed',
      {
        status: health.status,
        dbConnected: dbHealth.connected,
        dbLatency: dbHealth.latency,
      },
      'EEDatabaseMCPServer'
    );

    return health;
  }

  /**
   * Format uptime in human-readable format
   */
  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Get the SSE transport (for additional route setup if needed)
   */
  getTransport(): null {
    return null; // Transport is managed by SSE server
  }

  /**
   * Setup event processors
   */
  private setupEventProcessors(): void {
    if (!this.eventCollector) return;

    this.logger.debug('Setting up event processors', {}, 'EEDatabaseMCPServer');

    // Query optimization processor
    if (this.config.features?.events?.processors?.includes('QueryOptimization')) {
      this.eventCollector.registerProcessor(
        EventType.QUERY_SLOW,
        new QueryOptimizationProcessor(this.logger)
      );
    }

    // Error recovery processor
    if (this.config.features?.events?.processors?.includes('ErrorRecovery')) {
      this.eventCollector.registerProcessor(
        EventType.CONN_FAILED,
        new ErrorRecoveryProcessor(this.logger)
      );
      this.eventCollector.registerProcessor(
        EventType.QUERY_FAILED,
        new ErrorRecoveryProcessor(this.logger)
      );
    }

    // Metrics aggregation processor
    if (this.config.features?.events?.processors?.includes('Metrics')) {
      const metricsProcessor = new MetricsAggregationProcessor(this.logger);
      this.eventCollector.registerProcessor(EventType.QUERY_EXECUTED, metricsProcessor);
      this.eventCollector.registerProcessor(EventType.QUERY_FAILED, metricsProcessor);
      this.eventCollector.registerProcessor(EventType.CONN_CREATED, metricsProcessor);
      this.eventCollector.registerProcessor(EventType.ERROR_DETECTED, metricsProcessor);
    }

    this.logger.info(
      'Event processors configured',
      {
        processors: this.config.features?.events?.processors || [],
      },
      'EEDatabaseMCPServer'
    );
  }

  /**
   * Get event collector (for external access if needed)
   */
  getEventCollector(): EventCollector | undefined {
    return this.eventCollector;
  }

  /**
   * Get configuration manager
   */
  getConfig(): ConfigurationManager {
    return this.config;
  }
}
