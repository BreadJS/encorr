import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import type {
  ServerToNodeMessage,
  NodeToServerMessage,
  RegisterPayload,
  HeartbeatPayload,
  JobAssignPayload,
  JobCancelPayload,
  FileReplacePayload,
  VideoMetadata,
} from '@encorr/shared';
import {
  createMessage,
  createAckMessage,
  isJobAssignMessage,
  isJobCancelMessage,
  isPingMessage,
  isConfigUpdateMessage,
  isScanFolderMessage,
  isFileReplaceMessage,
} from '@encorr/shared';
import type { Logger } from 'winston';

// ============================================================================
// WebSocket Client Options
// ============================================================================

export interface WebSocketClientOptions {
  serverUrl: string;
  nodeId?: string;
  logger: Logger;
  reconnectInterval?: number;
  heartbeatInterval?: number;
}

// ============================================================================
// WebSocket Client Class
// ============================================================================

export class WebSocketClient extends EventEmitter {
  private serverUrl: string;
  private nodeId?: string;
  private logger: Logger;
  private reconnectInterval: number;
  private heartbeatInterval: number;
  private ws: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private isConnecting: boolean = false;

  constructor(options: WebSocketClientOptions) {
    super();
    this.serverUrl = options.serverUrl;
    this.nodeId = options.nodeId;
    this.logger = options.logger;
    this.reconnectInterval = options.reconnectInterval ?? 5000;
    this.heartbeatInterval = options.heartbeatInterval ?? 30000;
  }

  // ========================================================================
  // Connection
  // ========================================================================

  async connect(payload: RegisterPayload): Promise<void> {
    if (this.isConnected) {
      this.logger.info('Already connected to server');
      return;
    }
    if (this.isConnecting) {
      this.logger.info('Already connecting to server');
      return;
    }

    this.isConnecting = true;
    this.logger.info(`Connecting to ${this.serverUrl}...`);

    return new Promise((resolve, reject) => {
      let connectionResolved = false; // Track if promise has been resolved/rejected

      // Add timeout to detect hanging connections
      const timeout = setTimeout(() => {
        if (!connectionResolved) {
          this.logger.error('Connection timeout - no response from server');
          this.isConnecting = false;
          connectionResolved = true;
          if (this.ws) {
            this.ws.close();
          }
          reject(new Error('Connection timeout'));
        }
      }, 10000); // 10 second timeout

      try {
        this.ws = new WebSocket(this.serverUrl, { handshakeTimeout: 5000 });

        this.ws.on('open', () => {
          if (!connectionResolved) {
            clearTimeout(timeout);
            connectionResolved = true;

            // Check if this was a reconnection
            const wasReconnecting = this.reconnectTimeout !== null;
            if (wasReconnecting) {
              this.logger.info('Reconnected to server');
            } else {
              this.logger.info('Connected to server');
            }

            this.isConnected = true;
            this.isConnecting = false;

            // Clear reconnect timeout if exists
            if (this.reconnectTimeout) {
              clearTimeout(this.reconnectTimeout);
              this.reconnectTimeout = null;
            }

            // Register with server
            this.send(createMessage('REGISTER', payload));

            // Start heartbeat
            this.startHeartbeat();

            this.emit('connected');
            resolve();
          }
        });

        this.ws.on('message', (data: Buffer) => {
          this.handleMessage(data);
        });

        this.ws.on('close', () => {
          if (!connectionResolved) {
            clearTimeout(timeout);
            connectionResolved = true;
            this.isConnecting = false;
            reject(new Error('Connection closed before opening'));
          }

          this.handleDisconnect();
        });

        this.ws.on('error', (error: any) => {
          if (!connectionResolved) {
            clearTimeout(timeout);
            connectionResolved = true;

            // Suppress verbose error logging for connection errors - they're expected during reconnection
            const isConnectionError =
              error?.code === 'ECONNREFUSED' ||
              error?.code === 'ECONNRESET' ||
              error?.message?.includes('ECONNREFUSED') ||
              error?.message?.includes('Unexpected server response');

            if (isConnectionError) {
              this.logger.warn(`Connection to server failed (${this.serverUrl}). Will retry...`);
              this.isConnecting = false; // Reset so reconnect can work
              reject(error); // Reject the promise so caller knows it failed
              // Don't emit error event for connection errors - prevents unhandled exception
            } else {
              this.logger.error('WebSocket error:', error);
              this.isConnecting = false;
              this.emit('error', error);
              reject(error);
            }
          }
        });

        this.ws.on('pong', () => {
          // Server is alive
        });

      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  disconnect(): void {
    this.stopHeartbeat();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
  }

  private handleDisconnect(): void {
    const wasConnected = this.isConnected;
    this.isConnected = false;
    this.stopHeartbeat();

    if (wasConnected) {
      this.logger.warn('Disconnected from server');
      this.emit('disconnected');
    }

    // Attempt to reconnect
    if (!this.isConnecting) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      return;
    }

    this.logger.info(`Reconnecting in ${this.reconnectInterval / 1000}s...`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.emit('reconnect');
    }, this.reconnectInterval);
  }

  // ========================================================================
  // Message Handling
  // ========================================================================

  private handleMessage(data: Buffer): void {
    try {
      const message = JSON.parse(data.toString()) as ServerToNodeMessage;

      // Handle ACK
      if (message.type === 'ACK') {
        this.emit('ack', message.payload);
        return;
      }

      // Handle ERROR
      if (message.type === 'ERROR') {
        const payload = message.payload as { code: string; message: string; details?: Record<string, unknown> };
        this.logger.error('Server error:', payload.message);
        this.emit('serverError', payload);
        return;
      }

      // Handle PING
      if (isPingMessage(message)) {
        this.send(createAckMessage(message.id!));
        return;
      }

      // Handle JOB_ASSIGN
      if (isJobAssignMessage(message)) {
        this.emit('jobAssigned', message.payload);
        this.send(createAckMessage(message.id!));
        return;
      }

      // Handle JOB_CANCEL
      if (isJobCancelMessage(message)) {
        this.emit('jobCancelled', message.payload);
        this.send(createAckMessage(message.id!));
        return;
      }

      // Handle CONFIG_UPDATE
      if (isConfigUpdateMessage(message)) {
        this.emit('configUpdate', message.payload);
        this.send(createAckMessage(message.id!));
        return;
      }

      // Handle SCAN_FOLDER
      if (isScanFolderMessage(message)) {
        this.emit('scanFolder', message.payload);
        this.send(createAckMessage(message.id!));
        return;
      }

      // Handle FILE_REPLACE
      if (isFileReplaceMessage(message)) {
        this.emit('fileReplace', message.payload);
        this.send(createAckMessage(message.id!));
        return;
      }

      this.logger.warn(`Unknown message type: ${message.type}`);

    } catch (error) {
      this.logger.error('Error handling message:', error);
    }
  }

  // ========================================================================
  // Sending Messages
  // ========================================================================

  send(message: NodeToServerMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn('Cannot send message: not connected');
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.logger.error('Error sending message:', error);
      return false;
    }
  }

  sendHeartbeat(
    status: 'idle' | 'busy' | 'error',
    activeJobs: Array<{ job_id: string; progress: number }>,
    cpuPercent?: number,
    ramPercent?: number,
    gpuData?: Array<{
      utilizationGpu?: number;
      utilizationMemory?: number;
      memoryUsed?: number;
      memoryFree?: number;
      temperatureGpu?: number;
      powerDraw?: number;
      clockCore?: number;
      clockMemory?: number;
    }>
  ): void {
    const payload: any = {
      status,
      active_jobs: activeJobs,
    };

    // Detailed logging for heartbeat
    this.logger.debug(`[HEARTBEAT] Sending: status=${status}, active_jobs=${JSON.stringify(activeJobs)}, cpu=${cpuPercent}%, ram=${ramPercent}%`);

    // Add system_load if provided
    if (cpuPercent !== undefined || ramPercent !== undefined) {
      payload.system_load = {};
      if (cpuPercent !== undefined) {
        payload.system_load.cpu_percent = cpuPercent;
      }
      if (ramPercent !== undefined) {
        payload.system_load.memory_percent = ramPercent;
      }
    }

    // Add GPU data if provided
    if (gpuData && gpuData.length > 0) {
      payload.gpus = gpuData;
    }

    this.send(createMessage('HEARTBEAT', payload));
  }

  sendUsageUpdate(cpuPercent: number, ramPercent: number, gpuUsage: number[]): void {
    // Send a lightweight usage update message
    const payload = {
      system_load: {
        cpu_percent: cpuPercent,
        memory_percent: ramPercent,
      },
      gpu_usage: gpuUsage,
    };
    this.send(createMessage('USAGE_UPDATE' as any, payload));
  }

  sendJobAccept(jobId: string, accepted: boolean, reason?: string): void {
    this.send(createMessage('JOB_ACCEPT', {
      job_id: jobId,
      accepted,
      reason,
    }));
  }

  sendJobProgress(jobId: string, progress: number, currentAction: string, eta?: number, fps?: number, ratio?: string): void {
    // Detailed logging for job progress
    this.logger.debug(`[JOB_PROGRESS] Sending: job_id=${jobId}, progress=${progress.toFixed(1)}%, action=${currentAction}, eta=${eta}s, fps=${fps}, ratio=${ratio}`);
    this.send(createMessage('JOB_PROGRESS', {
      job_id: jobId,
      progress,
      current_action: currentAction,
      eta_seconds: eta,
      fps, // Include fps in the message
      ratio, // Include ratio in the message
    }));
  }

  sendJobComplete(jobId: string, stats: {
    original_size: number;
    transcoded_size: number;
    duration_seconds: number;
    avg_fps?: number;
  }, outputPath: string, ffmpeg_logs?: string, decoder_info?: string): void {
    this.send(createMessage('JOB_COMPLETE', {
      job_id: jobId,
      stats,
      output_path: outputPath,
      ffmpeg_logs,
      decoder_info,
    }));
  }

  sendJobCompleteWithMetadata(jobId: string, metadata: VideoMetadata, outputPath: string, ffmpeg_logs?: string): void {
    this.send(createMessage('JOB_COMPLETE', {
      job_id: jobId,
      metadata,
      output_path: outputPath,
      ffmpeg_logs,
    }));
  }

  sendJobError(jobId: string, error: string, retryPossible?: boolean, ffmpeg_logs?: string): void {
    this.send(createMessage('JOB_ERROR', {
      job_id: jobId,
      error,
      retry_possible: retryPossible ?? false,
      ffmpeg_logs,
    }));
  }

  // ========================================================================
  // Heartbeat
  // ========================================================================

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      // Send ping
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ========================================================================
  // Public Methods
  // ========================================================================

  get connected(): boolean {
    return this.isConnected;
  }
}
