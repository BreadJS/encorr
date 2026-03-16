import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { join } from 'path';
import type { EncorrDatabase } from '../database';
import type { EncorrWebSocketServer } from '../websocket/server';
import type { Logger } from 'winston';
import { apiRoutes } from './routes';

// ============================================================================
// Server Options
// ============================================================================

export interface ApiServerOptions {
  db: EncorrDatabase;
  wsServer: EncorrWebSocketServer;
  logger: Logger;
  port?: number;
  host?: string;
}

// ============================================================================
// API Server Class
// ============================================================================

export class ApiServer {
  private fastify: FastifyInstance;
  private db: EncorrDatabase;
  private logger: Logger;
  private wsServer: EncorrWebSocketServer | null = null;
  private apiRoutesRegistered = false;

  constructor(options: ApiServerOptions) {
    this.db = options.db;
    this.wsServer = options.wsServer;
    this.logger = options.logger;

    this.fastify = Fastify({
      logger: false,
    });

    this.setupMiddleware();
    this.registerBasicRoutes();
    // Defer API routes registration until wsServer is available
    if (this.wsServer) {
      this.registerApiRoutes();
      this.apiRoutesRegistered = true;
    }
  }

  private setupMiddleware(): void {
    // CORS
    this.fastify.register(cors, {
      origin: true,
      credentials: true,
    });

    // Static files (for production)
    this.fastify.register(staticFiles, {
      root: join(__dirname, '../../../../web/dist'),
      prefix: '/',
    });

    // Global error handler
    this.fastify.setErrorHandler(async (error, request, reply) => {
      this.logger.error('API error:', error);

      reply.status(error.statusCode || 500).send({
        success: false,
        error: error.message || 'Internal server error',
      });
    });

    // Global 404 handler
    this.fastify.setNotFoundHandler(async (request, reply) => {
      reply.status(404).send({
        success: false,
        error: 'Not found',
      });
    });
  }

  private registerBasicRoutes(): void {
    // Root redirect/info
    this.fastify.get('/', async (request, reply) => {
      return {
        success: true,
        message: 'Encorr Backend API is running',
        web_ui: 'http://localhost:8100',
        api: '/',
        endpoints: {
          health: '/health',
          config: '/config',
          nodes: '/nodes',
          mappings: '/mappings',
          files: '/files',
          jobs: '/jobs',
          presets: '/presets',
          settings: '/settings',
          stats: '/stats',
        }
      };
    });

    // Health check
    this.fastify.get('/health', async (request, reply) => {
      return { success: true, status: 'ok', timestamp: Date.now() };
    });
  }

  private registerApiRoutes(): void {
    // API routes - only register once wsServer is available
    this.fastify.register(apiRoutes, {
      db: this.db,
      wsServer: this.wsServer!,
      logger: this.logger,
    });
  }

  async start(port: number, host: string): Promise<void> {
    try {
      await this.fastify.listen({ port, host });
      this.logger.info(`API server listening on http://${host}:${port}`);
    } catch (error) {
      this.logger.error('Failed to start API server:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.fastify.close();
    this.logger.info('API server stopped');
  }

  getServer(): any {
    return this.fastify.server;
  }

  setWebSocketServer(wsServer: EncorrWebSocketServer): void {
    this.wsServer = wsServer;
    if (!this.apiRoutesRegistered) {
      this.registerApiRoutes();
      this.apiRoutesRegistered = true;
    }
  }
}
