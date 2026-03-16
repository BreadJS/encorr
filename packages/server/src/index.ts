import { loadConfig, ensureDirectories, type ServerConfig } from './config';
import { getDatabase } from './database';
import { EncorrWebSocketServer } from './websocket/server';
import { ApiServer } from './api';
import { createLogger } from './utils/logger';
import type winston from 'winston';

// ============================================================================
// Main Server Class
// ============================================================================

class EncorrServer {
  private config: ServerConfig;
  private logger: winston.Logger;
  private wsServer: EncorrWebSocketServer | null = null;
  private apiServer: ApiServer | null = null;

  constructor() {
    this.config = loadConfig();
    this.logger = createLogger();

    this.setupShutdownHandlers();
  }

  // ========================================================================
  // Startup
  // ========================================================================

  async start(): Promise<void> {
    try {
      this.logger.info('Starting Encorr Server...');

      // Ensure directories exist
      ensureDirectories(this.config);
      this.logger.info('Configuration:', this.config);

      // Initialize database
      this.logger.info('Initializing database...');
      const db = getDatabase({ path: this.config.database });
      this.logger.info('Database initialized');

      // Initialize API server first (to get the HTTP server)
      this.logger.info('Starting API server...');
      this.apiServer = new ApiServer({
        db,
        wsServer: null as any, // Will set after WebSocket server is created
        logger: this.logger,
      });

      // Get the HTTP server from Fastify
      const httpServer = this.apiServer.getServer();

      // Initialize WebSocket server with the API server's HTTP server
      this.logger.info('Starting WebSocket server...');
      this.wsServer = new EncorrWebSocketServer({
        server: httpServer,
        db,
        logger: this.logger,
      });

      // Update API server with WebSocket server reference
      this.apiServer.setWebSocketServer(this.wsServer);

      // Set up event handlers
      this.setupWebSocketEvents();

      // Start the API server (which starts the HTTP server)
      await this.apiServer.start(this.config.backendPort, this.config.host);

      this.logger.info(`Encorr Server is running`);
      this.logger.info(`  Web UI:    http://localhost:${this.config.frontendPort}`);
      this.logger.info(`  API:       http://localhost:${this.config.backendPort}/api`);
      this.logger.info(`  WebSocket: ws://localhost:${this.config.backendPort}/ws`);

      // Log initial stats
      const stats = db.getDashboardStats();
      this.logger.info('Initial stats:', {
        nodes: stats.nodes.total,
        files: stats.files.total,
        jobs: stats.jobs.queued,
      });

    } catch (error) {
      this.logger.error('Failed to start server:', error);
      throw error;
    }
  }

  // ========================================================================
  // WebSocket Event Handlers
  // ========================================================================

  private setupWebSocketEvents(): void {
    if (!this.wsServer) return;

    this.wsServer.on('nodeRegistered', (nodeId, nodeName) => {
      this.logger.info(`Node registered: ${nodeName} (${nodeId})`);
    });

    this.wsServer.on('nodeDisconnected', (nodeId) => {
      this.logger.info(`Node disconnected: ${nodeId}`);
    });

    this.wsServer.on('jobProgress', (jobId, progress, action) => {
      this.logger.debug(`Job ${jobId} progress: ${progress}% - ${action}`);
    });

    this.wsServer.on('jobCompleted', (jobId, stats) => {
      const db = getDatabase();
      db.logActivity({
        level: 'info',
        category: 'job',
        message: `Job ${jobId} completed. Saved ${stats.original_size - stats.transcoded_size} bytes`,
        metadata: { job_id: jobId, stats },
      });
    });

    this.wsServer.on('jobFailed', (jobId, error) => {
      this.logger.error(`Job ${jobId} failed: ${error}`);
    });

    this.wsServer.on('filesDiscovered', (files) => {
      this.logger.info(`Discovered ${files.length} files`);
    });
  }

  // ========================================================================
  // Shutdown Handlers
  // ========================================================================

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      this.logger.info(`Received ${signal}, shutting down gracefully...`);

      try {
        if (this.wsServer) {
          this.wsServer.close();
        }
        if (this.apiServer) {
          await this.apiServer.stop();
        }

        this.logger.info('Server stopped');
        process.exit(0);

        // Force close after 10 seconds
        setTimeout(() => {
          this.logger.error('Forced shutdown after timeout');
          process.exit(1);
        }, 10000);
      } catch (error) {
        this.logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception:', error);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    });
  }

  // ========================================================================
  // Public Methods
  // ========================================================================

  async stop(): Promise<void> {
    this.logger.info('Stopping Encorr Server...');

    if (this.wsServer) {
      this.wsServer.close();
    }

    if (this.apiServer) {
      await this.apiServer.stop();
    }
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
  const server = new EncorrServer();

  try {
    await server.start();

    // Keep process alive
    process.on('SIGINT', () => {
      server.stop().then(() => process.exit(0));
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { EncorrServer };
