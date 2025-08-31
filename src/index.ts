/**
 * Application entry point with proper initialization sequence.
 * Handles graceful startup and shutdown.
 */

import { LogReaderRegistration } from './logging/LogReaderRegistration.js';
import { StructuredLogger } from './logging/StructuredLogger.js';
import { EEDatabaseMCPServer } from './server/EEDatabaseMCPServer.js';

// Global server instance
let server: EEDatabaseMCPServer | null = null;
let logRegistration: LogReaderRegistration | null = null;

// Early logger for startup/shutdown logging - all from environment variables
const startupLogger = new StructuredLogger({
  level: (process.env.LOG_LEVEL || 'INFO') as any,
  directory: process.env.LOG_DIRECTORY || './logs',
  maxFiles: parseInt(process.env.LOG_MAX_FILES || '7'),
  maxSize: process.env.LOG_MAX_SIZE || '20m',
  service: process.env.SERVICE_NAME || 'ee-postgres',
});

/**
 * Start the server
 */
async function start(): Promise<void> {
  const startTime = Date.now();

  startupLogger.info(
    'Starting EE PostgreSQL MCP Server',
    {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      env: 'production', // Default to production for safety
    },
    'Main'
  );

  // Configuration will be loaded from config.json

  try {
    // Create server instance first to get config
    startupLogger.trace('Creating server instance', {}, 'Main');
    server = new EEDatabaseMCPServer();
    const config = server.getConfig();

    // Register with log monitor
    startupLogger.debug('Registering with ee-mcp log monitor', {}, 'Main');
    logRegistration = new LogReaderRegistration(
      startupLogger,
      config.getServiceName('mcp-server'),
      config.getLogDirectory(),
      config.getVersion()
    );
    await logRegistration.register();

    // Start the server
    startupLogger.debug('Starting server', {}, 'Main');
    await server.start();

    const startupTime = Date.now() - startTime;

    // Log startup success to stderr (MCP convention)
    console.error(`${config.getDisplayName()} started successfully`);
    console.error(`HTTP endpoint: http://localhost:${config.getServerPort()}`);
    console.error(`Health check: http://localhost:${config.getServerPort()}/health`);

    startupLogger.info(
      'Server started successfully',
      {
        startupTime,
        endpoint: `http://localhost:${config.getServerPort()}`,
        healthCheck: `http://localhost:${config.getServerPort()}/health`,
        version: config.getVersion(),
      },
      'Main'
    );
  } catch (error) {
    const startupTime = Date.now() - startTime;

    startupLogger.error(
      'Failed to start server',
      {
        error:
          error instanceof Error
            ? {
                message: error.message,
                stack: error.stack,
                code: error.name,
              }
            : { message: String(error) },
        startupTime,
      },
      'Main'
    );

    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  const shutdownStart = Date.now();

  console.error(`\nReceived ${signal}, shutting down gracefully...`);

  startupLogger.info(
    'Shutdown initiated',
    {
      signal,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    },
    'Main'
  );

  if (server) {
    try {
      startupLogger.debug('Stopping server', {}, 'Main');
      await server.stop();

      const shutdownTime = Date.now() - shutdownStart;

      console.error('Server stopped successfully');
      startupLogger.info(
        'Server stopped successfully',
        {
          shutdownTime,
          signal,
        },
        'Main'
      );
    } catch (error) {
      startupLogger.error(
        'Error during shutdown',
        {
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                }
              : { message: String(error) },
          signal,
        },
        'Main'
      );
      console.error('Error during shutdown:', error);
    }
  } else {
    startupLogger.warn('No server instance to stop', { signal }, 'Main');
  }

  // Unregister from log monitor
  if (logRegistration) {
    try {
      startupLogger.debug('Unregistering from log monitor', {}, 'Main');
      await logRegistration.unregister();
    } catch (error) {
      startupLogger.warn(
        'Error unregistering from log monitor',
        {
          error:
            error instanceof Error
              ? {
                  message: error.message,
                }
              : { message: String(error) },
        },
        'Main'
      );
    }
  }

  startupLogger.info(
    'Process exiting',
    {
      exitCode: 0,
      signal,
      totalUptime: process.uptime(),
    },
    'Main'
  );

  // Give logger time to flush
  setTimeout(() => process.exit(0), 100);
}

// Handle process signals
process.on('SIGINT', () => {
  startupLogger.debug('SIGINT received', {}, 'Main');
  shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  startupLogger.debug('SIGTERM received', {}, 'Main');
  shutdown('SIGTERM');
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  startupLogger.error(
    'Uncaught exception',
    {
      error: {
        message: error.message,
        stack: error.stack,
        code: error.name,
      },
    },
    'Main'
  );
  console.error('Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  startupLogger.error(
    'Unhandled rejection',
    {
      reason:
        reason instanceof Error
          ? {
              message: reason.message,
              stack: reason.stack,
              name: reason.name,
            }
          : { value: String(reason) },
      promise: String(promise),
    },
    'Main'
  );
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

// Log process warnings
process.on('warning', (warning) => {
  startupLogger.warn(
    'Process warning',
    {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    },
    'Main'
  );
});

// Log startup
startupLogger.info(
  'Process started',
  {
    argv: process.argv,
    cwd: process.cwd(),
    execPath: process.execPath,
  },
  'Main'
);

// Start the server
start().catch((error) => {
  startupLogger.error(
    'Fatal error during startup',
    {
      error:
        error instanceof Error
          ? {
              message: error.message,
              stack: error.stack,
              code: error.name,
            }
          : { message: String(error) },
    },
    'Main'
  );
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
