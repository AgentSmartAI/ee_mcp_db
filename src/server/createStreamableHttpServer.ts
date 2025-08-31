/**
 * Creates a streamable HTTP server using the MCP SDK's StreamableHTTPServerTransport.
 * This transport is more reliable than SSE and supports proper request/response streaming.
 */

import { randomUUID } from 'crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import express, { Express, Request, Response } from 'express';

import { OAuthHandler } from '../auth/OAuthHandler.js';
import { ServerConfig } from '../config/ServerConfig.js';
import { PostgresConnectionManager } from '../database/PostgresConnectionManager.js';
import { EventCollector } from '../events/EventCollector.js';
import { StructuredLogger } from '../logging/StructuredLogger.js';

import { EEDatabaseMCPServer } from './EEDatabaseMCPServer.js';
// Check if request is initialization request
function isInitializeRequest(body: any): boolean {
  return body?.method === 'initialize';
}

import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';

export async function createStreamableHttpServer(
  serverFactory: EEDatabaseMCPServer,
  config: ServerConfig,
  logger: StructuredLogger,
  connectionManager?: PostgresConnectionManager,
  _eventCollector?: EventCollector
): Promise<void> {
  const app: Express = express();

  // Initialize OAuth handler
  const oauthHandler = new OAuthHandler(config, logger, connectionManager);

  // Configure CORS
  app.use(
    cors({
      origin: config.cors.enabled ? config.cors.origins : false,
      credentials: true,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'X-API-Key',
        'X-Client-ID',
        'MCP-Session-ID',
        'Last-Event-ID',
      ],
    })
  );

  // Parse JSON bodies
  app.use(express.json({ limit: '50mb' }));

  // Request logging middleware
  app.use((req, res, next) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    (req as any).requestId = requestId;

    res.on('finish', () => {
      logger.debug(
        `HTTP request ${req.ip} - - [${new Date().toISOString()}] "${req.method} ${req.url} HTTP/1.1" ${res.statusCode} - "${req.headers.referer || '-'}" "${req.headers['user-agent'] || '-'}"`,
        {},
        'StreamableHttpServer'
      );
    });

    next();
  });

  // Health check endpoint
  app.get('/health', async (req: Request, res: Response) => {
    try {
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        server: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
        },
      };

      if (connectionManager) {
        const dbHealth = await connectionManager.checkHealth();
        (health as any).database = dbHealth;
      }

      res.json(health);
    } catch (error) {
      logger.error('Health check failed', error as Error, 'StreamableHttpServer');
      res.status(503).json({
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Heartbeat endpoint to keep sessions alive
  app.post('/mcp/heartbeat', (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string;

    if (sessionId && sessions[sessionId]) {
      sessions[sessionId].lastActivity = new Date();
      res.json({
        status: 'ok',
        sessionId,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(404).json({
        error: 'Session not found',
        sessionId,
      });
    }
  });

  // OAuth discovery endpoints (required by MCP specification)
  app.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    oauthHandler.handleDiscovery(req, res);
  });

  app.get('/.well-known/oauth-authorization-server/mcp', (req: Request, res: Response) => {
    oauthHandler.handleDiscovery(req, res);
  });

  app.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    oauthHandler.handleProtectedResource(req, res);
  });

  // OAuth dynamic client registration endpoint
  app.post('/oauth/register', (req: Request, res: Response) => {
    oauthHandler.handleClientRegistration(req, res);
  });

  // OAuth flow endpoints (active only when auth is enabled)
  app.get('/oauth/authorize', (req: Request, res: Response) => {
    oauthHandler.handleAuthorizationRequest(req, res);
  });

  app.post('/oauth/token', (req: Request, res: Response) => {
    oauthHandler.handleTokenRequest(req, res);
  });

  // Session management with improved isolation
  interface SessionInfo {
    transport: StreamableHTTPServerTransport;
    server: Server; // Each session gets its own MCP server instance
    lastActivity: Date;
    created: Date;
    response?: Response; // Store response for heartbeat
    activeConnections?: number; // Track active SSE connections
    clientId?: string; // Track which client owns this session
    serviceType?: string; // Track service type for debugging
  }

  const sessions: { [sessionId: string]: SessionInfo } = {};
  const SESSION_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (matching OAuth session timeout)
  const SESSION_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minute grace period for active connections

  // Clean up expired sessions every hour
  const cleanupInterval = setInterval(
    () => {
      const now = new Date();
      const expiredSessions = Object.keys(sessions).filter((sessionId) => {
        const session = sessions[sessionId];
        const inactiveTime = now.getTime() - session.lastActivity.getTime();

        // Don't cleanup if session has active connections and is within grace period
        if (session.activeConnections && session.activeConnections > 0) {
          if (inactiveTime < SESSION_TIMEOUT_MS + SESSION_GRACE_PERIOD_MS) {
            logger.debug(
              'Skipping cleanup for session with active connections',
              {
                sessionId,
                activeConnections: session.activeConnections,
                inactiveTime: Math.floor(inactiveTime / 1000),
              },
              'StreamableHttpServer'
            );
            return false;
          }
        }

        return inactiveTime > SESSION_TIMEOUT_MS;
      });

      expiredSessions.forEach((sessionId) => {
        logger.info(
          'Cleaning up expired session',
          {
            sessionId,
            age: now.getTime() - sessions[sessionId].created.getTime(),
            activeConnections: sessions[sessionId].activeConnections || 0,
          },
          'StreamableHttpServer'
        );
        try {
          sessions[sessionId].transport.close();
        } catch (error) {
          logger.warn(
            'Error closing expired session transport',
            { sessionId },
            'StreamableHttpServer'
          );
        }
        // Server instance will be garbage collected when session is deleted
        delete sessions[sessionId];
      });

      if (expiredSessions.length > 0 || Object.keys(sessions).length > 0) {
        logger.info(
          'Session cleanup completed',
          {
            expiredCount: expiredSessions.length,
            activeSessions: Object.keys(sessions).length,
            sessionsWithActiveConnections: Object.values(sessions).filter(
              (s) => s.activeConnections && s.activeConnections > 0
            ).length,
          },
          'StreamableHttpServer'
        );
      }
    },
    60 * 60 * 1000
  ); // Run every hour

  // MCP POST endpoint - handles all JSON-RPC requests
  app.post('/mcp', async (req: Request, res: Response) => {
    const requestId = (req as any).requestId;

    logger.debug(
      'MCP POST request received',
      {
        requestId,
        hasSessionId: !!req.headers['mcp-session-id'],
        method: req.body?.method,
        bodyKeys: req.body ? Object.keys(req.body) : [],
      },
      'StreamableHttpServer'
    );

    try {
      const sessionId = req.headers['mcp-session-id'] as string;
      let transport: StreamableHTTPServerTransport;

      logger.debug(
        'Session lookup',
        {
          requestId,
          providedSessionId: sessionId,
          existingSessions: Object.keys(sessions),
          sessionFound: sessionId ? !!sessions[sessionId] : false,
        },
        'StreamableHttpServer'
      );

      if (sessionId && sessions[sessionId]) {
        // Reuse existing transport and update activity
        const sessionInfo = sessions[sessionId];
        sessionInfo.lastActivity = new Date();
        transport = sessionInfo.transport;
        logger.debug(
          'Reusing existing transport with isolation check',
          {
            requestId,
            sessionId,
            clientId: sessionInfo.clientId,
            serviceType: sessionInfo.serviceType,
            method: req.body?.method,
            sessionAge: new Date().getTime() - sessionInfo.created.getTime(),
          },
          'StreamableHttpServer'
        );
      } else if (isInitializeRequest(req.body)) {
        // New initialization request with session isolation
        const clientId = (req.headers['x-client-id'] as string) || `client-${randomUUID()}`;
        const serviceType = (req.headers['x-service-type'] as string) || 'unknown';

        // Check for existing sessions from same client to prevent conflicts
        const existingClientSessions = Object.entries(sessions).filter(
          ([_, info]) => info.clientId === clientId
        );

        if (existingClientSessions.length > 0) {
          logger.debug(
            'Client has existing sessions, allowing multiple sessions per client',
            {
              clientId,
              existingSessions: existingClientSessions.map(([id]) => id),
              requestId,
            },
            'StreamableHttpServer'
          );
        }

        // Create a new MCP server instance for this client FIRST
        const mcpServer = serverFactory.createServerInstance();

        const eventStore = new InMemoryEventStore();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          eventStore, // Enable resumability
          enableJsonResponse: true, // Enable direct JSON responses instead of SSE streaming
          onsessioninitialized: (sessionId) => {
            // Store the transport and server by session ID when initialized
            const now = new Date();
            logger.info(
              'Session initialized - storing in sessions map',
              {
                sessionId,
                clientId,
                serviceType,
                requestId,
              },
              'StreamableHttpServer'
            );
            sessions[sessionId] = {
              transport,
              server: mcpServer,
              lastActivity: now,
              created: now,
              clientId,
              serviceType,
            };
          },
        });

        // Set up onclose handler - mark session as closed but keep for reconnection
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions[sid]) {
            logger.info(
              'Transport closed - keeping session for reconnection',
              {
                sessionId: sid,
                sessionAge: new Date().getTime() - sessions[sid].created.getTime(),
                timeout: '24 hours',
              },
              'StreamableHttpServer'
            );
            // Don't delete the session - let the timeout cleanup handle it
            // This allows for reconnection with the same session ID
          }
        };

        // Connect transport to MCP server
        try {
          await mcpServer.connect(transport);
          logger.info(
            'Transport connected to new MCP server instance',
            {
              clientId,
              serviceType,
              requestId,
            },
            'StreamableHttpServer'
          );
        } catch (error) {
          logger.error('Failed to connect transport', error as Error, 'StreamableHttpServer');
          logger.debug(
            'Connection failure details',
            {
              clientId,
              serviceType,
              requestId,
              errorMessage: error instanceof Error ? error.message : 'Unknown error',
            },
            'StreamableHttpServer'
          );
          throw error;
        }
      } else {
        // No session ID and not initialization - create a new transport
        // BUT DO NOT connect it to mcpServer to avoid disconnecting others
        logger.info(
          'Creating new transport for sessionless request',
          {
            requestId,
            method: req.body?.method,
          },
          'StreamableHttpServer'
        );

        // Create a new MCP server instance for sessionless request FIRST
        const mcpServer = serverFactory.createServerInstance();

        const eventStore = new InMemoryEventStore();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          eventStore,
          enableJsonResponse: true, // Enable direct JSON responses instead of SSE streaming
          onsessioninitialized: (sessionId) => {
            // Store the transport and server by session ID when initialized
            const now = new Date();
            logger.info(
              'Session initialized for sessionless request - storing in sessions map',
              {
                sessionId,
                requestId,
              },
              'StreamableHttpServer'
            );
            sessions[sessionId] = {
              transport,
              server: mcpServer,
              lastActivity: now,
              created: now,
            };
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions[sid]) {
            logger.info(
              'Transport closed',
              {
                sessionId: sid,
              },
              'StreamableHttpServer'
            );
            // Don't delete session - keep for reconnection with 24-hour timeout
          }
        };

        // Connect transport to the new server instance
        await mcpServer.connect(transport);

        logger.debug(
          'Sessionless request connected to new MCP server instance',
          { requestId },
          'StreamableHttpServer'
        );
      }

      // Handle the request
      logger.debug(
        'Handling request with transport',
        {
          requestId,
          sessionId: transport.sessionId,
          method: req.body?.method,
          bodySize: JSON.stringify(req.body).length,
        },
        'StreamableHttpServer'
      );

      logger.debug(
        'About to call transport.handleRequest',
        {
          requestId,
          sessionId: transport.sessionId,
          method: req.body?.method,
          transportConnected: transport.sessionId !== undefined,
          responseHeadersSent: res.headersSent,
        },
        'StreamableHttpServer'
      );

      // Handle the request and ensure proper cleanup as per MCP examples
      res.on('close', () => {
        logger.debug('Response closed - cleaning up', { requestId }, 'StreamableHttpServer');
      });

      await transport.handleRequest(req as any, res as any, req.body);

      logger.debug(
        'transport.handleRequest completed',
        {
          requestId,
          sessionId: transport.sessionId,
          method: req.body?.method,
          responseHeadersSent: res.headersSent,
          responseStatusCode: res.statusCode,
          responseFinished: res.finished,
        },
        'StreamableHttpServer'
      );

      logger.debug(
        'Request handled successfully',
        {
          requestId,
          sessionId: transport.sessionId,
          method: req.body?.method,
          statusCode: res.statusCode,
        },
        'StreamableHttpServer'
      );
    } catch (error) {
      logger.error('Error handling MCP request', error as Error, 'StreamableHttpServer');

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: req.body?.id || null,
        });
      }
    }
  });

  // MCP GET endpoint - handles SSE streams for notifications
  app.get('/mcp', async (req: Request, res: Response) => {
    const requestId = (req as any).requestId;
    const sessionId = req.headers['mcp-session-id'] as string;
    const clientId = req.headers['x-client-id'] as string;

    logger.debug(
      'MCP GET request received with session isolation',
      {
        requestId,
        sessionId,
        clientId,
        hasLastEventId: !!req.headers['last-event-id'],
      },
      'StreamableHttpServer'
    );

    if (!sessionId || !sessions[sessionId]) {
      logger.warn(
        'Invalid or missing session ID for GET',
        {
          requestId,
          sessionId,
          clientId,
          activeSessions: Object.keys(sessions),
        },
        'StreamableHttpServer'
      );
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    // Validate client owns this session (if clientId provided)
    const sessionInfo = sessions[sessionId];
    if (clientId && sessionInfo.clientId && sessionInfo.clientId !== clientId) {
      logger.warn(
        'Client ID mismatch - session isolation violation',
        {
          requestId,
          sessionId,
          providedClientId: clientId,
          sessionClientId: sessionInfo.clientId,
          serviceType: sessionInfo.serviceType,
        },
        'StreamableHttpServer'
      );
      res.status(403).send('Session access denied - wrong client');
      return;
    }

    const lastEventId = req.headers['last-event-id'] as string;
    if (lastEventId) {
      logger.info(
        'Client reconnecting with Last-Event-ID',
        {
          requestId,
          sessionId,
          lastEventId,
        },
        'StreamableHttpServer'
      );
    }

    try {
      const sessionInfo = sessions[sessionId];
      sessionInfo.lastActivity = new Date();
      const transport = sessionInfo.transport;

      // Track active connection
      sessionInfo.activeConnections = (sessionInfo.activeConnections || 0) + 1;

      // Set up SSE heartbeat to prevent timeouts
      let heartbeatActive = true;
      const heartbeatInterval = setInterval(() => {
        if (!heartbeatActive || res.writableEnded || res.destroyed) {
          clearInterval(heartbeatInterval);
          logger.debug(
            'Stopping heartbeat - connection ended',
            {
              sessionId,
              writableEnded: res.writableEnded,
              destroyed: res.destroyed,
            },
            'StreamableHttpServer'
          );
          return;
        }

        try {
          // Send SSE comment as heartbeat
          res.write(': heartbeat\n\n');
          sessionInfo.lastActivity = new Date();
          logger.trace('Heartbeat sent', { sessionId }, 'StreamableHttpServer');
        } catch (error) {
          logger.warn('Failed to send heartbeat', error as Error, 'StreamableHttpServer');
          logger.debug(
            'Heartbeat failure details',
            {
              sessionId,
              errorMessage: error instanceof Error ? error.message : 'Unknown',
            },
            'StreamableHttpServer'
          );
          heartbeatActive = false;
          clearInterval(heartbeatInterval);
        }
      }, 15000); // 15 second heartbeat (half of DB idle timeout)

      // Clean up heartbeat on connection close
      res.on('close', () => {
        heartbeatActive = false;
        clearInterval(heartbeatInterval);
        sessionInfo.activeConnections = Math.max(0, (sessionInfo.activeConnections || 1) - 1);
        logger.info(
          'SSE connection closed',
          {
            sessionId,
            remainingConnections: sessionInfo.activeConnections,
          },
          'StreamableHttpServer'
        );
      });

      await transport.handleRequest(req as any, res as any);

      logger.debug(
        'SSE stream established',
        {
          requestId,
          sessionId,
        },
        'StreamableHttpServer'
      );
    } catch (error) {
      logger.error('Error establishing SSE stream', error as Error, 'StreamableHttpServer');

      if (!res.headersSent) {
        res.status(500).send('Error establishing SSE stream');
      }
    }
  });

  // MCP DELETE endpoint - handles session termination
  app.delete('/mcp', async (req: Request, res: Response) => {
    const requestId = (req as any).requestId;
    const sessionId = req.headers['mcp-session-id'] as string;

    logger.debug(
      'MCP DELETE request received',
      {
        requestId,
        sessionId,
      },
      'StreamableHttpServer'
    );

    if (!sessionId || !sessions[sessionId]) {
      logger.warn(
        'Invalid or missing session ID for DELETE',
        {
          requestId,
          sessionId,
        },
        'StreamableHttpServer'
      );
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    try {
      const sessionInfo = sessions[sessionId];
      sessionInfo.lastActivity = new Date();
      const transport = sessionInfo.transport;
      await transport.handleRequest(req as any, res as any);

      logger.info(
        'Session terminated',
        {
          requestId,
          sessionId,
        },
        'StreamableHttpServer'
      );
    } catch (error) {
      logger.error('Error handling session termination', error as Error, 'StreamableHttpServer');

      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  });

  // Start the server with keep-alive configuration
  const port = config.port;
  const host = '0.0.0.0';

  const server = app.listen(port, host, () => {
    logger.info(
      'Streamable HTTP server started',
      {
        host,
        port,
        endpoints: ['/health', '/mcp'],
        authEnabled: config.auth.enabled,
      },
      'StreamableHttpServer'
    );
  });

  // Configure server keep-alive to prevent timeout issues
  server.keepAliveTimeout = 65 * 1000; // 65 seconds (higher than typical proxy timeout)
  server.headersTimeout = 70 * 1000; // 70 seconds (should be higher than keepAliveTimeout)

  // Handle shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down server...', {}, 'StreamableHttpServer');

    // Clear cleanup interval and close all active sessions
    clearInterval(cleanupInterval);

    for (const sessionId in sessions) {
      try {
        logger.debug(`Closing transport for session ${sessionId}`, {}, 'StreamableHttpServer');
        await sessions[sessionId].transport.close();
        delete sessions[sessionId];
      } catch (error) {
        logger.error(
          `Error closing transport for session ${sessionId}`,
          error as Error,
          'StreamableHttpServer'
        );
      }
    }

    logger.info('Server shutdown complete', {}, 'StreamableHttpServer');
    process.exit(0);
  });
}
