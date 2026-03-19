import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type { IncomingMessage } from 'http';
import type {
  ServerToNodeMessage,
  NodeToServerMessage,
  ServerToWebClientMessage,
  RegisterPayload,
  HeartbeatPayload,
  JobAcceptPayload,
  JobProgressPayload,
  JobCompletePayload,
  JobErrorPayload,
  FileInfoPayload,
  GPUInfoPayload,
  UsageUpdatePayload,
  AckPayload,
} from '@encorr/shared';
import {
  createMessage,
  createAckMessage,
  createErrorMessage,
  isRegisterMessage,
  isHeartbeatMessage,
  isJobAcceptMessage,
  isJobProgressMessage,
  isJobCompleteMessage,
  isJobErrorMessage,
  isFileInfoMessage,
  isGpuInfoMessage,
  isAckMessage,
  isErrorMessage,
  generateMessageId,
  validateMessagePayload,
  MessageType,
} from '@encorr/shared';
import type { EncorrDatabase } from '../database';
import type { Logger } from 'winston';

// ============================================================================
// Connection Info
// ============================================================================

interface NodeConnection {
  ws: WebSocket;
  nodeId: string | null;
  nodeName: string;
  lastHeartbeat: number;
  pendingRequests: Map<string, {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>;
}

interface WebClientConnection {
  ws: WebSocket;
  subscriptions: Set<'nodes' | 'jobs'>;
  lastHeartbeat: number;
}

// ============================================================================
// WebSocket Server Options
// ============================================================================

export interface WebSocketServerOptions {
  server?: any;
  path?: string;
  db: EncorrDatabase;
  logger: Logger;
}

// ============================================================================
// Event Handlers
// ============================================================================

export interface WebSocketServerEvents {
  nodeRegistered: (nodeId: string, nodeName: string) => void;
  nodeDisconnected: (nodeId: string) => void;
  jobProgress: (jobId: string, progress: number, action: string) => void;
  jobCompleted: (jobId: string, stats: any) => void;
  jobFailed: (jobId: string, error: string) => void;
  filesDiscovered: (files: any[]) => void;
}

// ============================================================================
// WebSocket Server Class
// ============================================================================

export class EncorrWebSocketServer {
  private wss: WebSocketServer;
  private connections: Map<WebSocket, NodeConnection> = new Map();
  private connectionsByNodeId: Map<string, NodeConnection> = new Map();
  private webClients: Map<WebSocket, WebClientConnection> = new Map();
  private db: EncorrDatabase;
  private logger: Logger;
  private eventHandlers: Partial<WebSocketServerEvents> = {};
  private heartbeatInterval: NodeJS.Timeout | null = null;
  // Track pending job assignments per node (node_id -> count of pending assignments)
  private pendingAssignments: Map<string, number> = new Map();

  constructor(options: WebSocketServerOptions) {
    this.db = options.db;
    this.logger = options.logger;

    this.wss = new WebSocketServer({
      server: options.server,
      path: options.path || '/ws',
    });

    this.wss.on('connection', this.handleConnection.bind(this));
    this.startHeartbeatCheck();
    this.startJobAssignment();

    this.logger.info('WebSocket server started');
  }

  // ========================================================================
  // Event Handler Registration
  // ========================================================================

  on<K extends keyof WebSocketServerEvents>(
    event: K,
    handler: WebSocketServerEvents[K]
  ): void {
    this.eventHandlers[event] = handler;
  }

  // ========================================================================
  // Helper Functions
  // ========================================================================

  /**
   * Filter out integrated GPUs from system_info
   * Keeps only discrete GPUs (NVIDIA, AMD discrete, etc.)
   */
  private filterIntegratedGPUs(systemInfo: any): any {
    if (!systemInfo.gpus || !Array.isArray(systemInfo.gpus)) {
      return systemInfo;
    }

    const filteredGpus = systemInfo.gpus.filter((gpu: any) => {
      const name = (gpu.name || gpu.model || '').toLowerCase();
      const vendor = (gpu.vendor || '').toLowerCase();

      // Filter out all Intel GPUs (all are integrated)
      if (vendor.includes('intel')) {
        return false;
      }

      // Filter out AMD integrated GPUs
      // Check for AMD/ATI/Radeon in vendor OR "advanced" (for "Advanced Micro Devices, Inc.")
      if (vendor.includes('amd') || vendor.includes('ati') || vendor.includes('radeon') || vendor.includes('advanced')) {
        // Remove special characters like (TM), (R), etc. then normalize whitespace
        const cleanName = name.replace(/[™®©\(tm\)\(r\)\(c\)]/gi, '').replace(/\s+/g, ' ').trim();

        // "AMD Radeon Graphics" without model number = integrated
        // After removing (TM) and normalizing spaces, "AMD Radeon(TM) Graphics" becomes "AMD Radeon Graphics"
        if (/^(amd\s+)?radeon\s+graphics$/.test(cleanName)) {
          return false;
        }

        // Very low VRAM (< 2GB) = likely integrated
        // memory is stored in bytes, convert to MB for comparison
        // Values < 1000 are likely already in MB, >= 1024*1024 are in bytes
        const vramBytes = gpu.vram || gpu.memory;
        if (vramBytes) {
          const vramMB = vramBytes >= 1048576 ? vramBytes / (1024 * 1024) : vramBytes;
          if (vramMB < 2048) {
            return false;
          }
        }

        // Contains "integrated" in name
        if (name.includes('integrated')) {
          return false;
        }
      }

      return true; // Keep this GPU
    });

    const removedCount = systemInfo.gpus.length - filteredGpus.length;
    if (removedCount > 0) {
      this.logger.info(`Filtered GPUs: ${systemInfo.gpus.length} -> ${filteredGpus.length} (removed ${removedCount} integrated GPU(s))`);
    }

    return {
      ...systemInfo,
      gpus: filteredGpus,
    };
  }

  // ========================================================================
  // Connection Handling
  // ========================================================================

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const connectionId = uuidv4();
    const clientIp = req.socket.remoteAddress;

    this.logger.info(`New WebSocket connection from ${clientIp}`);

    // Initially create as potential node connection
    const connection: NodeConnection = {
      ws,
      nodeId: null,
      nodeName: 'Unknown',
      lastHeartbeat: Date.now(),
      pendingRequests: new Map(),
    };

    this.connections.set(ws, connection);

    ws.on('message', (data: Buffer) => this.handleMessage(ws, data));
    ws.on('close', () => this.handleDisconnect(ws));
    ws.on('error', (error) => this.handleError(ws, error));
    ws.on('pong', () => {
      const conn = this.connections.get(ws);
      if (conn) {
        conn.lastHeartbeat = Date.now();
      }
      const webClient = this.webClients.get(ws);
      if (webClient) {
        webClient.lastHeartbeat = Date.now();
      }
    });

    // Send ping every 30 seconds
    ws.ping();
  }

  private handleDisconnect(ws: WebSocket): void {
    // Check if it's a node connection
    const connection = this.connections.get(ws);
    if (connection) {
      this.logger.info(`WebSocket disconnected: ${connection.nodeName} (${connection.nodeId || 'unregistered'})`);

      if (connection.nodeId) {
        this.db.updateNodeStatus(connection.nodeId, 'offline');
        this.connectionsByNodeId.delete(connection.nodeId);
        this.eventHandlers.nodeDisconnected?.(connection.nodeId);

        // Clear pending assignments for this node since it's disconnected
        const pendingCount = this.pendingAssignments.get(connection.nodeId) || 0;
        if (pendingCount > 0) {
          this.logger.info(`[DISCONNECT] Clearing ${pendingCount} pending assignments for disconnected node ${connection.nodeId}`);
          this.pendingAssignments.delete(connection.nodeId);
        }

        // Broadcast node update to web clients
        this.broadcastNodesUpdate();
      }

      // Clear pending request timeouts
      for (const [messageId, pending] of connection.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Connection closed'));
      }
      connection.pendingRequests.clear();

      this.connections.delete(ws);
      return;
    }

    // Check if it's a web client
    const webClient = this.webClients.get(ws);
    if (webClient) {
      this.logger.info(`Web client disconnected`);
      this.webClients.delete(ws);
    }
  }

  private handleError(ws: WebSocket, error: Error): void {
    this.logger.error('WebSocket error:', error);
    ws.close();
  }

  // ========================================================================
  // Message Handling
  // ========================================================================

  private handleMessage(ws: WebSocket, data: Buffer): void {
    try {
      const message = JSON.parse(data.toString()) as NodeToServerMessage;

      if (!message.type) {
        this.sendMessage(ws, createErrorMessage('INVALID_MESSAGE', 'Message type is required'));
        return;
      }

      // Handle ACK
      if (isAckMessage(message)) {
        this.handleAck(ws, message);
        return;
      }

      // Handle ERROR
      if (isErrorMessage(message)) {
        this.logger.error(`Error from node: ${message.payload.message}`, message.payload.details);
        return;
      }

      // Route message based on type
      switch (message.type) {
        case 'REGISTER':
          this.handleRegister(ws, message as any);
          break;
        case 'HEARTBEAT':
          this.handleHeartbeat(ws, message as any);
          break;
        case 'JOB_ACCEPT':
          this.handleJobAccept(ws, message as any);
          break;
        case 'JOB_PROGRESS':
          this.handleJobProgress(ws, message as any);
          break;
        case 'JOB_COMPLETE':
          this.handleJobComplete(ws, message as any);
          break;
        case 'JOB_ERROR':
          this.handleJobError(ws, message as any);
          break;
        case 'FILE_INFO':
          this.handleFileInfo(ws, message as any);
          break;
        case 'GPU_INFO':
          this.handleGpuInfo(ws, message as any);
          break;
        case 'USAGE_UPDATE':
          this.handleUsageUpdate(ws, message as any);
          break;
        case 'WEB_SUBSCRIBE':
          this.handleWebSubscribe(ws, message as any);
          break;
        default:
          this.logger.warn(`Unknown message type: ${message.type}`);
          this.sendMessage(ws, createAckMessage(message.id!, false, 'Unknown message type'));
      }
    } catch (error) {
      this.logger.error('Error handling message:', error);
      this.sendMessage(ws, createErrorMessage('PARSE_ERROR', 'Failed to parse message'));
    }
  }

  // ========================================================================
  // Message Type Handlers
  // ========================================================================

  private handleRegister(ws: WebSocket, message: NodeToServerMessage): void {
    const payload = message.payload as RegisterPayload;

    this.logger.info(`Node registration: ${payload.name}`);

    try {
      // Filter out integrated GPUs from system_info
      const filteredSystemInfo = this.filterIntegratedGPUs(payload.system_info);

      // Check if node already exists
      let node = this.db.getAllNodes().find(n => n.name === payload.name);

      if (node) {
        // Update existing node
        this.db.updateNodeStatus(node.id, 'online', Math.floor(Date.now() / 1000));
        // Also update system info when re-registering (with filtered GPUs)
        this.db.updateNodeSystemInfo(node.id, filteredSystemInfo);
        this.logger.info(`Node re-registered: ${node.id} (${payload.name})`);
        this.logger.info(`Updated system_info with ${filteredSystemInfo.gpus?.length || 0} GPU(s) (filtered from ${payload.system_info.gpus?.length || 0})`);

        // Clean up any existing integrated GPUs in the database immediately
        const currentNodeData = this.db.getNodeById(node.id);
        if (currentNodeData && currentNodeData.system_info.gpus) {
          const alreadyFiltered = this.filterIntegratedGPUs(currentNodeData.system_info);
          if (alreadyFiltered.gpus.length !== currentNodeData.system_info.gpus.length) {
            this.logger.info(`Cleaned up integrated GPUs on re-registration: ${currentNodeData.system_info.gpus.length} -> ${alreadyFiltered.gpus.length}`);
            this.db.updateNodeSystemInfo(node.id, alreadyFiltered);
          }
        }
      } else {
        // Create new node
        node = this.db.createNode({
          name: payload.name,
          system_info: filteredSystemInfo,
          capabilities: payload.capabilities,
        });

        // Initialize max_workers and config for new node
        const cpuCount = payload.system_info.cpu_cores;
        const gpuCount = payload.system_info.gpus?.length || 0;

        this.db.updateNodeUsage(node.id, {
          gpu_usage: new Array(gpuCount).fill(0),
        });

        this.db.updateNodeConfig(node.id, {
          cpu_preset: null,
          gpu_presets: new Array(gpuCount).fill(null),
        });

        this.logger.info(`New node registered: ${node.id} (${payload.name})`);
      }

      // Update connection
      const connection = this.connections.get(ws)!;
      connection.nodeId = node.id;
      connection.nodeName = payload.name;
      connection.lastHeartbeat = Date.now();

      // Update mapping
      this.connectionsByNodeId.set(node.id, connection);

      // Send ACK
      this.sendMessage(ws, createAckMessage(message.id!, true, node.id));

      // Notify event handlers
      this.eventHandlers.nodeRegistered?.(node.id, payload.name);

      // Broadcast update to web clients
      this.broadcastNodesUpdate();

      // Log activity
      this.db.logActivity({
        level: 'info',
        category: 'node',
        message: `Node "${payload.name}" registered`,
        metadata: { node_id: node.id, system_info: payload.system_info },
      });
    } catch (error) {
      this.logger.error('Error handling node registration:', error);
      this.sendMessage(ws, createAckMessage(message.id!, false, 'Registration failed'));
    }
  }

  private handleHeartbeat(ws: WebSocket, message: NodeToServerMessage): void {
    const connection = this.connections.get(ws);
    if (!connection || !connection.nodeId) {
      this.sendMessage(ws, createErrorMessage('NOT_REGISTERED', 'Node not registered'));
      return;
    }

    const payload = message.payload as HeartbeatPayload;
    connection.lastHeartbeat = Date.now();

    // Update node status in database
    const status = payload.status === 'idle' ? 'online' : payload.status;
    this.db.updateNodeStatus(connection.nodeId, status, Math.floor(Date.now() / 1000));
    this.db.updateNodeHeartbeat(connection.nodeId);

    // Update usage data
    const cpuUsage = payload.system_load?.cpu_percent || 0;
    const ramUsage = payload.system_load?.memory_percent || 0;

    // Get current node info for static GPU info and to preserve existing active_jobs data
    const node = this.db.getAllNodes().find(n => n.id === connection.nodeId);
    const existingActiveJobs = node?.active_jobs || [];

    // Build active jobs info - preserve existing rich data (fps, eta, etc.) from DB
    const activeJobsInfo = payload.active_jobs?.map(job => {
      const dbJob = this.db.getJobById(job.job_id);
      const file = dbJob ? this.db.getFileById(dbJob.file_id) : null;

      // Find existing job data to preserve fps, eta, and other fields set by JOB_PROGRESS
      const existingJob = existingActiveJobs.find((j: any) => j.id === job.job_id);

      return {
        id: job.job_id,
        file_name: file?.relative_path,
        progress: job.progress,
        // Always include GPU from the payload (node sets this correctly)
        gpu: job.gpu,
        // Preserve rich data from existing job if available
        ...(existingJob && {
          fps: existingJob.fps,
          eta: existingJob.eta,
          ratio: existingJob.ratio,
          current_action: existingJob.current_action,
          preset_name: existingJob.preset_name,
          status: existingJob.status,
        }),
      } as any; // Use 'as any' since active_jobs is dynamically typed
    }) || [];

    // Process GPU data - rebuild GPU list from incoming live data
    // The node has already filtered out integrated GPUs, so we trust the incoming data
    let gpuUsage: number[] | undefined;

    if (node && node.system_info.gpus) {
      // Filter out integrated GPUs from the existing database entry
      const currentSystemInfo = { ...node.system_info };
      const filteredSystemInfo = this.filterIntegratedGPUs(currentSystemInfo);

      // Update with live data from payload - rebuild GPU list entirely from payload
      if (payload.gpus && payload.gpus.length > 0) {
        // Debug log to see what GPU data we're receiving
        this.logger.debug(`Received GPU data in heartbeat: ${JSON.stringify(payload.gpus)}`);

        // Extract GPU utilization percentages
        gpuUsage = payload.gpus.map(gpu => gpu.utilizationGpu ?? 0);

        // Rebuild GPU list by matching each incoming GPU with static info from DB
        const updatedGpus: any[] = [];
        const usedStaticIndices = new Set<number>();

        for (const liveGpu of payload.gpus) {
          // Find matching static GPU info from the filtered DB GPUs by vendor
          const staticGpuIndex = filteredSystemInfo.gpus.findIndex((existingGpu: any, idx: number) => {
            if (usedStaticIndices.has(idx)) return false; // Skip already matched

            const existingVendor = (existingGpu.vendor || '').toLowerCase();
            const existingName = (existingGpu.name || '').toLowerCase();

            // NVIDIA GPUs match NVIDIA
            if (existingVendor.includes('nvidia') || existingName.includes('nvidia') ||
                existingName.includes('geforce') || existingName.includes('rtx') || existingName.includes('quadro')) {
              return true;
            }

            // AMD GPUs match AMD
            if (existingVendor.includes('amd') || existingName.includes('amd') ||
                existingName.includes('radeon') || existingVendor.includes('ati')) {
              return true;
            }

            return false;
          });

          if (staticGpuIndex >= 0) {
            const staticGpu = filteredSystemInfo.gpus[staticGpuIndex];
            usedStaticIndices.add(staticGpuIndex);

            // Merge static info with live data
            updatedGpus.push({
              ...staticGpu,
              utilizationGpu: liveGpu.utilizationGpu,
              utilizationMemory: liveGpu.utilizationMemory,
              memoryUsed: liveGpu.memoryUsed,
              memoryFree: liveGpu.memoryFree,
              temperatureGpu: liveGpu.temperatureGpu,
              powerDraw: liveGpu.powerDraw,
              clockCore: liveGpu.clockCore,
              clockMemory: liveGpu.clockMemory,
            });
          } else {
            // No matching static GPU found - this shouldn't happen, but log it
            this.logger.warn(`No matching static GPU found for live GPU data: ${JSON.stringify(liveGpu)}`);
          }
        }

        // Update with rebuilt GPU list (only GPUs with live data)
        this.db.updateNodeSystemInfo(connection.nodeId!, {
          ...filteredSystemInfo,
          gpus: updatedGpus,
        });
      } else {
        // No GPU data in payload, just filter the existing GPUs
        this.db.updateNodeSystemInfo(connection.nodeId!, filteredSystemInfo);
      }
    }

    this.db.updateNodeUsage(connection.nodeId, {
      cpu_usage: cpuUsage,
      ram_usage: ramUsage,
      gpu_usage: gpuUsage,
      active_jobs: activeJobsInfo,
    });

    // Broadcast node update to web clients
    this.broadcastNodesUpdate();

    this.sendMessage(ws, createAckMessage(message.id!));
  }

  private handleJobAccept(ws: WebSocket, message: NodeToServerMessage): void {
    const connection = this.connections.get(ws);
    if (!connection || !connection.nodeId) {
      this.sendMessage(ws, createErrorMessage('NOT_REGISTERED', 'Node not registered'));
      return;
    }

    const payload = message.payload as JobAcceptPayload;

    if (payload.accepted) {
      this.db.setJobProcessing(payload.job_id);

      // Add job to node's active_jobs
      const node = this.db.getAllNodes().find(n => n.id === connection.nodeId);
      const job = this.db.getJobById(payload.job_id);
      const file = job ? this.db.getFileById(job.file_id) : null;
      const preset = job ? this.db.getPresetById(job.preset_id) : null;

      if (node && job && file) {
        const activeJob = {
          id: job.id,
          file_name: file.relative_path.split('/').pop() || file.relative_path.split('\\').pop() || 'Unknown',
          preset_name: preset?.name || 'Unknown',
          status: 'processing',
          progress: 0,
          current_action: 'Starting...',
        };
        const currentActiveJobs = node.active_jobs || [];
        this.db.updateNodeUsage(connection.nodeId!, { active_jobs: [...currentActiveJobs, activeJob] });
      }

      this.logger.info(`Job ${payload.job_id} accepted by node ${connection.nodeId}`);
      // Broadcast updates
      this.broadcastJobsUpdate();
      this.broadcastNodesUpdate();
    } else {
      this.logger.warn(`Job ${payload.job_id} rejected by node ${connection.nodeId}: ${payload.reason}`);

      // Decrement pending assignments since this job is no longer pending
      const pending = this.pendingAssignments.get(connection.nodeId) || 0;
      this.pendingAssignments.set(connection.nodeId, Math.max(0, pending - 1));
      this.logger.info(`[PENDING] Decremented pending assignments for node ${connection.nodeId} after rejection: ${pending} -> ${Math.max(0, pending - 1)}`);

      // Clean up any pending request for this job to prevent double-decrement when ACK arrives
      // We need to find and remove the pending request for this job_id
      for (const [msgId, pendingReq] of connection.pendingRequests) {
        // Note: We can't directly match job_id here since the pending request doesn't store it
        // But decrementing once in handleJobAccept is sufficient since the ACK's decrement will no-op due to Math.max(0, x-1)
      }

      // Fail the job with the rejection reason so it's properly tracked
      const fullErrorMessage = `Rejected by node ${connection.nodeId}: ${payload.reason || 'Unknown reason'}`;
      this.db.failJob(payload.job_id, fullErrorMessage);

      // Return job to queue
      this.db.updateNodeStatus(connection.nodeId, 'online');

      // Broadcast updates so the UI shows the failed job status
      this.broadcastJobsUpdate();
      this.broadcastNodesUpdate();

      // Trigger job assignment again to pick up remaining queued jobs
      this.assignJobsNow();
    }

    this.sendMessage(ws, createAckMessage(message.id!));
  }

  private handleJobProgress(ws: WebSocket, message: NodeToServerMessage): void {
    const connection = this.connections.get(ws);
    if (!connection || !connection.nodeId) return;

    const payload = message.payload as JobProgressPayload;

    // Detailed logging for incoming progress
    this.logger.debug(`[JOB_PROGRESS] Received from node ${connection.nodeId}: job_id=${payload.job_id}, progress=${payload.progress.toFixed(1)}%, action=${payload.current_action}, fps=${payload.fps}, eta=${payload.eta_seconds}s, ratio=${payload.ratio}`);

    this.db.updateJobProgress(
      payload.job_id,
      payload.progress,
      payload.current_action
    );

    // Update active job info in node's usage data
    const node = this.db.getAllNodes().find(n => n.id === connection.nodeId);
    if (node && node.active_jobs) {
      const updatedActiveJobs = node.active_jobs.map(job => {
        if (job.id === payload.job_id) {
          const updated = {
            ...job,
            progress: payload.progress,
            current_action: payload.current_action,
            // Only update FPS if payload provides a value (preserve existing if undefined)
            ...(payload.fps !== undefined && { fps: payload.fps }),
            // Only update ETA if payload provides a value (preserve existing if undefined)
            ...(payload.eta_seconds !== undefined && { eta: this.formatDuration(payload.eta_seconds) }),
            // Only update ratio if payload provides a value (preserve existing if undefined)
            ...(payload.ratio !== undefined && { ratio: payload.ratio }),
          };
          this.logger.debug(`[JOB_PROGRESS] Updated job ${job.id} in active_jobs: fps=${updated.fps}, eta=${updated.eta}, ratio=${updated.ratio}, progress=${updated.progress}, action=${updated.current_action} (payload fps=${payload.fps}, eta=${payload.eta_seconds}, ratio=${payload.ratio})`);
          return updated;
        }
        return job;
      });
      this.db.updateNodeUsage(connection.nodeId!, { active_jobs: updatedActiveJobs });
    } else {
      this.logger.warn(`[JOB_PROGRESS] Node ${connection.nodeId} not found or has no active_jobs`);
    }

    this.eventHandlers.jobProgress?.(
      payload.job_id,
      payload.progress,
      payload.current_action
    );

    // Broadcast updates to web clients
    this.broadcastJobsUpdate();
    this.broadcastNodesUpdate();

    this.sendMessage(ws, createAckMessage(message.id!));
  }

  // Helper to format duration as HH:MM:SS
  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  }

  private handleJobComplete(ws: WebSocket, message: NodeToServerMessage): void {
    const connection = this.connections.get(ws);
    if (!connection || !connection.nodeId) return;

    const payload = message.payload as JobCompletePayload;

    this.logger.info(`Job ${payload.job_id} completed by node ${connection.nodeId}`);
    this.logger.debug(`Job complete payload keys: ${Object.keys(payload).join(', ')}`);
    this.logger.debug(`Has metadata: ${!!payload.metadata}, Has stats: ${!!payload.stats}`);

    // Check if this is an analyze job (has metadata) or transcode job (has stats)
    if (payload.metadata) {
      // Analyze job - update file metadata
      this.logger.info(`Processing as analyze job with metadata: ${JSON.stringify(payload.metadata).substring(0, 100)}...`);
      this.db.completeAnalyzeJob(payload.job_id, payload.metadata);
    } else if (payload.stats) {
      // Transcode job - update with stats
      this.logger.info(`Processing as transcode job with stats`);
      this.logger.info(`Output file location: ${payload.output_path || 'not specified'}`);
      this.db.completeJob(payload.job_id, {
        original_size: payload.stats.original_size,
        transcoded_size: payload.stats.transcoded_size,
        duration_seconds: payload.stats.duration_seconds,
        avg_fps: payload.stats.avg_fps,
      }, payload.output_path);
    } else {
      this.logger.warn(`Job complete has neither metadata nor stats! Keys: ${Object.keys(payload).join(', ')}`);
    }

    // Update node status
    this.db.updateNodeStatus(connection.nodeId, 'online');

    // Remove job from active_jobs
    const node = this.db.getAllNodes().find(n => n.id === connection.nodeId);
    if (node && node.active_jobs) {
      const updatedActiveJobs = node.active_jobs.filter(job => job.id !== payload.job_id);
      this.db.updateNodeUsage(connection.nodeId!, { active_jobs: updatedActiveJobs });
    }

    // Log activity
    const metadata = payload.metadata || payload.stats;
    this.db.logActivity({
      level: 'info',
      category: 'job',
      message: `Job ${payload.job_id} completed successfully`,
      metadata: metadata,
    });

    this.eventHandlers.jobCompleted?.(payload.job_id, metadata);

    // Broadcast updates to web clients
    this.broadcastJobsUpdate();
    this.broadcastNodesUpdate();

    // Assign next queued job to available workers
    this.assignJobsNow();

    this.sendMessage(ws, createAckMessage(message.id!));
  }

  private handleJobError(ws: WebSocket, message: NodeToServerMessage): void {
    const connection = this.connections.get(ws);
    if (!connection || !connection.nodeId) return;

    const payload = message.payload as JobErrorPayload;

    this.logger.error(`Job ${payload.job_id} failed on node ${connection.nodeId}: ${payload.error}`);

    this.db.failJob(payload.job_id, payload.error);

    // Update node status
    this.db.updateNodeStatus(connection.nodeId, 'online');

    // Remove job from active_jobs
    const node = this.db.getAllNodes().find(n => n.id === connection.nodeId);
    if (node && node.active_jobs) {
      const updatedActiveJobs = node.active_jobs.filter(job => job.id !== payload.job_id);
      this.db.updateNodeUsage(connection.nodeId!, { active_jobs: updatedActiveJobs });
    }

    // Log activity
    this.db.logActivity({
      level: 'error',
      category: 'job',
      message: `Job ${payload.job_id} failed: ${payload.error}`,
      metadata: payload.details,
    });

    this.eventHandlers.jobFailed?.(payload.job_id, payload.error);

    // Broadcast updates to web clients
    this.broadcastJobsUpdate();
    this.broadcastNodesUpdate();

    // Assign next queued job since a worker is now free
    this.assignJobsNow();

    this.sendMessage(ws, createAckMessage(message.id!));
  }

  private handleFileInfo(ws: WebSocket, message: NodeToServerMessage): void {
    const connection = this.connections.get(ws);
    if (!connection || !connection.nodeId) return;

    const payload = message.payload as FileInfoPayload;

    this.logger.info(`Received file info for ${payload.files.length} files`);

    const discoveredFiles: any[] = [];

    for (const file of payload.files) {
      // Get folder mapping
      const mapping = this.db.getFolderMappingById(payload.folder_mapping_id);
      if (!mapping) continue;

      const videoFile = this.db.upsertFile({
        folder_mapping_id: payload.folder_mapping_id,
        relative_path: file.relative_path,
        original_size: file.metadata.size,
        original_format: file.metadata.container,
        original_codec: file.metadata.video_codec,
        duration: file.metadata.duration,
        resolution: `${file.metadata.width}x${file.metadata.height}`,
        metadata: file.metadata,
      });

      discoveredFiles.push(videoFile);
    }

    if (discoveredFiles.length > 0) {
      this.eventHandlers.filesDiscovered?.(discoveredFiles);
    }

    this.sendMessage(ws, createAckMessage(message.id!));
  }

  private handleGpuInfo(ws: WebSocket, message: NodeToServerMessage): void {
    const connection = this.connections.get(ws);
    if (!connection || !connection.nodeId) return;

    const payload = message.payload as GPUInfoPayload;

    // Update node's GPU information in database - MUST filter integrated GPUs
    const node = this.db.getAllNodes().find(n => n.id === connection.nodeId);
    if (node && node.system_info) {
      // Filter out integrated GPUs before updating - CRITICAL
      const filteredSystemInfo = this.filterIntegratedGPUs({ gpus: payload.gpus, ...node.system_info });
      node.system_info.gpus = filteredSystemInfo.gpus;
      this.db.updateNodeSystemInfo(connection.nodeId!, node.system_info);

      // Calculate GPU usage percentages from filtered GPUs only
      const gpuUsage = filteredSystemInfo.gpus.map((gpu: any) => {
        if (gpu.memory && gpu.memoryUsed !== undefined) {
          return Math.round((gpu.memoryUsed / gpu.memory) * 100);
        }
        return 0;
      });

      this.db.updateNodeUsage(connection.nodeId!, { gpu_usage: gpuUsage });
    }

    this.sendMessage(ws, createAckMessage(message.id!));
  }

  private handleUsageUpdate(ws: WebSocket, message: NodeToServerMessage): void {
    const connection = this.connections.get(ws);
    if (!connection || !connection.nodeId) return;

    const payload = message.payload as UsageUpdatePayload;

    // Update node usage data
    const cpuUsage = payload.system_load?.cpu_percent || 0;
    const ramUsage = payload.system_load?.memory_percent || 0;

    // Extract GPU usage percentages from gpus array
    const gpuUsage = payload.gpus?.map(g => g.utilizationGpu ?? 0) || [];

    this.db.updateNodeUsage(connection.nodeId, {
      cpu_usage: cpuUsage,
      ram_usage: ramUsage,
      gpu_usage: gpuUsage.length > 0 ? gpuUsage : undefined,
    });

    // Also update GPU objects in system_info with dynamic data (temperature, utilization)
    if (payload.gpus && payload.gpus.length > 0) {
      const node = this.db.getAllNodes().find(n => n.id === connection.nodeId);
      if (node && node.system_info?.gpus) {
        // Update each GPU with dynamic data from USAGE_UPDATE
        node.system_info.gpus = node.system_info.gpus.map((gpu, index) => {
          const updateData = payload.gpus![index];
          if (updateData) {
            return {
              ...gpu,
              utilizationGpu: updateData.utilizationGpu,
              utilizationMemory: updateData.utilizationMemory,
              temperatureGpu: updateData.temperatureGpu,
              memoryUsed: updateData.memoryUsed,
              memoryFree: updateData.memoryFree,
              powerDraw: updateData.powerDraw,
              clockCore: updateData.clockCore,
            };
          }
          return gpu;
        });
        this.db.updateNodeSystemInfo(connection.nodeId, node.system_info);
      }
    }

    // Broadcast node updates so temperature shows in real-time
    this.broadcastNodesUpdate();

    this.sendMessage(ws, createAckMessage(message.id!));
  }

  private handleWebSubscribe(ws: WebSocket, message: any): void {
    const payload = message.payload as { channels?: ('nodes' | 'jobs')[] };
    const channels = payload.channels || ['nodes', 'jobs'];

    // Move connection from node connections to web clients
    const nodeConn = this.connections.get(ws);
    if (nodeConn && !nodeConn.nodeId) {
      // This is a web client, not a node
      this.connections.delete(ws);

      const webClient: WebClientConnection = {
        ws,
        subscriptions: new Set(channels),
        lastHeartbeat: Date.now(),
      };
      this.webClients.set(ws, webClient);

      this.logger.info(`Web client subscribed to: ${channels.join(', ')}`);

      // Send initial data immediately
      if (channels.includes('nodes')) {
        this.sendNodesUpdate(ws);
      }
      if (channels.includes('jobs')) {
        this.sendJobsUpdate(ws);
      }

      this.sendMessage(ws, createAckMessage(message.id!, true, 'Subscribed'));
    } else if (!nodeConn) {
      // Already a web client, update subscriptions
      const webClient = this.webClients.get(ws);
      if (webClient) {
        channels.forEach(ch => webClient.subscriptions.add(ch));
        this.logger.info(`Web client updated subscriptions: ${Array.from(webClient.subscriptions).join(', ')}`);
        this.sendMessage(ws, createAckMessage(message.id!, true, 'Subscriptions updated'));
      }
    }
  }

  private sendNodesUpdate(ws: WebSocket): void {
    const nodes = this.db.getAllNodes();
    const message = createMessage(MessageType.WEB_NODES_UPDATE, { nodes });
    this.sendMessage(ws, message);
  }

  private sendJobsUpdate(ws: WebSocket): void {
    const jobs = this.getEnrichedJobs();
    const message = createMessage(MessageType.WEB_JOBS_UPDATE, { jobs });
    this.sendMessage(ws, message);
  }

  // Helper to enrich jobs with file, preset, and node info
  private getEnrichedJobs(): any[] {
    const jobs = this.db.getAllJobs();

    return jobs.map(job => {
      const file = this.db.getFileById(job.file_id);
      const preset = this.db.getPresetById(job.preset_id);
      const node = job.node_id ? this.db.getNodeById(job.node_id) : null;

      // Check if this is a library file and get metadata
      let metadata = null;
      if (file?.folder_mapping_id) {
        const mapping = this.db.getFolderMappingById(file.folder_mapping_id);
        if (mapping?.server_path?.startsWith('library:')) {
          const fullPath = mapping.node_path && !mapping.node_path.includes('.mkv') && !mapping.node_path.includes('.mp4')
            ? `${mapping.node_path}/${file.relative_path}`
            : mapping.node_path || file.relative_path;

          const libFile = this.db.getLibraryFileByFilepath(fullPath);
          if (libFile?.metadata) {
            metadata = libFile.metadata;
          }
        }
      }

      // Get codec info from metadata or file
      const codec = metadata?.video_codec || file?.original_codec || '';
      const resolution = metadata?.width && metadata?.height
        ? `${metadata.width}x${metadata.height}`
        : (file?.resolution || '');

      return {
        ...job,
        file_name: file?.relative_path,
        file_size: file?.original_size,
        preset_name: preset?.name,
        node_name: node?.name,
        original_codec: codec,
        resolution: resolution,
        container: metadata?.container || file?.original_format || '',
        duration: metadata?.duration || file?.duration || 0,
        target_codec: preset?.config?.video_codec || '',
        metadata: metadata,
      };
    });
  }

  public broadcastNodesUpdate(): void {
    const nodes = this.db.getAllNodes();
    const connectedNodeIds = this.getConnectedNodeIds();

    // Add connected status to each node (same as API endpoint)
    const nodesWithStatus = nodes.map(node => ({
      ...node,
      connected: connectedNodeIds.includes(node.id),
    }));

    // Log what we're about to broadcast (first node with active jobs as sample)
    const sampleNode = nodesWithStatus.find(n => n.active_jobs && n.active_jobs.length > 0);
    if (sampleNode) {
      this.logger.debug(`[WEB_NODES_UPDATE] Broadcasting node ${sampleNode.name} with ${sampleNode.active_jobs?.length} active jobs`);
      sampleNode.active_jobs?.forEach(job => {
        this.logger.debug(`[WEB_NODES_UPDATE]   job ${job.id}: progress=${job.progress}%, action=${job.current_action}, fps=${job.fps}, eta=${job.eta}, ratio=${job.ratio}, gpu=${job.gpu}`);
      });
    }

    const message = createMessage(MessageType.WEB_NODES_UPDATE, { nodes: nodesWithStatus });

    for (const [ws, client] of this.webClients) {
      if (client.subscriptions.has('nodes') && ws.readyState === WebSocket.OPEN) {
        this.sendMessage(ws, message);
      }
    }
  }

  public broadcastJobsUpdate(): void {
    const enrichedJobs = this.getEnrichedJobs();
    const message = createMessage(MessageType.WEB_JOBS_UPDATE, { jobs: enrichedJobs });

    for (const [ws, client] of this.webClients) {
      if (client.subscriptions.has('jobs') && ws.readyState === WebSocket.OPEN) {
        this.sendMessage(ws, message);
      }
    }
  }

  private handleAck(ws: WebSocket, message: NodeToServerMessage): void {
    const payload = message.payload as AckPayload;
    const connection = this.connections.get(ws);

    if (!connection) return;

    const pending = connection.pendingRequests.get(payload.ack_id);
    if (pending) {
      clearTimeout(pending.timeout);
      connection.pendingRequests.delete(payload.ack_id);

      if (payload.success === false) {
        pending.reject(new Error(payload.message || 'Request failed'));
      } else {
        pending.resolve(payload);
      }
    }
  }

  // ========================================================================
  // Message Sending
  // ========================================================================

  private sendMessage(ws: WebSocket, message: ServerToNodeMessage | ServerToWebClientMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      this.logger.warn(`[SEND_MESSAGE] Cannot send message, WebSocket state is ${ws.readyState} (OPEN=${WebSocket.OPEN})`);
    }
  }

  public sendToNode(nodeId: string, message: ServerToNodeMessage): boolean {
    const connection = this.connectionsByNodeId.get(nodeId);
    if (connection && connection.ws.readyState === WebSocket.OPEN) {
      this.sendMessage(connection.ws, message);
      return true;
    }
    return false;
  }

  // ========================================================================
  // Public API
  // ========================================================================

  broadcastToAll(message: ServerToNodeMessage): void {
    for (const [ws, connection] of this.connections) {
      if (connection.nodeId) {
        this.sendMessage(ws, message);
      }
    }
  }

  broadcastToWebClients(message: any): void {
    // This would broadcast to connected web clients
    // For now, we'll use EventEmitter pattern
    this.logger.debug('Broadcasting to web clients:', message);
  }

  assignJobToNode(
    nodeId: string,
    jobData: {
      job_id: string;
      file_id: string;
      preset_id: string;
      source_path: string;
      dest_path?: string; // Optional for analyze-only jobs
      config: any;
    }
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const connection = this.connectionsByNodeId.get(nodeId);
      if (!connection) {
        this.logger.warn(`[JOB_ASSIGN] Node ${nodeId} not connected when trying to assign job ${jobData.job_id}`);
        reject(new Error('Node not connected'));
        return;
      }

      // Track pending assignment
      const pendingBefore = this.pendingAssignments.get(nodeId) || 0;
      this.pendingAssignments.set(nodeId, pendingBefore + 1);
      this.logger.info(`[JOB_ASSIGN] Sending job ${jobData.job_id} to node ${nodeId}, pending: ${pendingBefore} -> ${pendingBefore + 1}`);

      const messageId = generateMessageId();
      const message = createMessage(
        'JOB_ASSIGN',
        {
          job: {
            id: jobData.job_id,
            file_id: jobData.file_id,
            preset_id: jobData.preset_id,
            config: {
              source_path: jobData.source_path,
              dest_path: jobData.dest_path,
              ffmpeg: jobData.config,
            },
          },
        },
        messageId
      );

      this.logger.info(`[JOB_ASSIGN] Sending job ${jobData.job_id} to node ${nodeId}, pending was ${pendingBefore}, will be ${pendingBefore + 1}`);

      const timeout = setTimeout(() => {
        connection.pendingRequests.delete(messageId);
        // Decrement pending assignment on timeout
        const pending = this.pendingAssignments.get(nodeId) || 0;
        this.pendingAssignments.set(nodeId, Math.max(0, pending - 1));
        reject(new Error('Job assignment timeout'));
      }, 30000);

      connection.pendingRequests.set(messageId, {
        resolve: () => {
          // First, get the job and update its status BEFORE decrementing pendingAssignments
          // This prevents a race condition where the job looks available while it's being assigned
          const job = this.db.getJobById(jobData.job_id);

          // Only assign the job if it's not already in a terminal state
          // We use assignJob to set node_id, but it also sets status='assigned'
          // So we need to check the job status to prevent overwriting
          if (job && job.status !== 'failed' && job.status !== 'completed' && job.status !== 'cancelled') {
            // If job is already 'processing', only update node_id and started_at without changing status
            // This prevents overwriting 'processing' back to 'assigned'
            if (job.status === 'processing') {
              const now = Math.floor(Date.now() / 1000);
              this.db.updateJobNode(jobData.job_id, nodeId, now);
              this.logger.debug(`[JOB_ASSIGN] Job ${jobData.job_id} already processing, only updated node_id to ${nodeId}`);
            } else {
              // Job is 'queued' or 'assigned', safe to use assignJob
              this.db.assignJob(jobData.job_id, nodeId);
              this.logger.debug(`[JOB_ASSIGN] Job ${jobData.job_id} assigned to node ${nodeId}, status was: ${job.status}`);
            }
          } else {
            this.logger.info(`[JOB_ASSIGN] Job ${jobData.job_id} not assigned (current status: ${job?.status})`);
          }

          // NOW decrement pending assignments after job status is updated
          // This ensures the job is counted as 'assigned' or 'processing' before we decrement
          const jobAfterUpdate = this.db.getJobById(jobData.job_id);
          if (jobAfterUpdate && (jobAfterUpdate.status === 'processing' || jobAfterUpdate.status === 'assigned')) {
            const pending = this.pendingAssignments.get(nodeId) || 0;
            this.pendingAssignments.set(nodeId, Math.max(0, pending - 1));
            this.logger.info(`[JOB_ASSIGN_ACK] ACK for accepted job ${jobData.job_id}, decremented pending ${pending} -> ${Math.max(0, pending - 1)}`);
          } else {
            this.logger.info(`[JOB_ASSIGN_ACK] ACK received for job ${jobData.job_id}, job status: ${jobAfterUpdate?.status}, pending unchanged`);
          }

          this.broadcastJobsUpdate();
          resolve(true);
        },
        reject: (error: Error) => {
          // Decrement pending assignment on failure
          const pending = this.pendingAssignments.get(nodeId) || 0;
          this.pendingAssignments.set(nodeId, Math.max(0, pending - 1));
          reject(error);
        },
        timeout,
      });

      this.sendMessage(connection.ws, message);
    });
  }

  cancelJob(jobId: string, reason?: string): void {
    const job = this.db.getJobById(jobId);
    if (!job || !job.node_id) return;

    const message = createMessage('JOB_CANCEL', { job_id: jobId, reason });
    this.sendToNode(job.node_id, message);

    this.db.cancelJob(jobId);

    // Broadcast updates to all connected clients
    this.broadcastJobsUpdate();
    this.broadcastNodesUpdate();
  }

  getConnectedNodeIds(): string[] {
    return Array.from(this.connectionsByNodeId.keys());
  }

  isNodeConnected(nodeId: string): boolean {
    return this.connectionsByNodeId.has(nodeId);
  }

  // ========================================================================
  // Heartbeat & Job Assignment
  // ========================================================================

  private startHeartbeatCheck(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeout = 90000; // 90 seconds

      for (const [ws, connection] of this.connections) {
        if (now - connection.lastHeartbeat > timeout) {
          this.logger.warn(`Node ${connection.nodeName} heartbeat timeout, closing connection`);
          ws.close();
        } else {
          ws.ping();
        }
      }
    }, 30000);
  }

  private startJobAssignment(): void {
    // No longer using interval - jobs are pushed immediately when created
    this.logger.info('Job assignment ready (push-based)');
  }

  // Get worker availability status for UI
  getWorkerAvailability(): { hasCpuWorkers: boolean; hasGpuWorkers: boolean; cpuWorkersAvailable: number; details: any[] } {
    const allNodes = this.db.getAllNodes();
    const onlineNodes = allNodes.filter(n => n.status === 'online' || n.status === 'busy');

    let totalCpuWorkers = 0;
    let totalGpuWorkers = 0;
    let usedCpuWorkers = 0;
    let usedGpuWorkers = 0;
    const details: any[] = [];

    for (const node of onlineNodes) {
      const maxWorkers = node.max_workers || { cpu: 1, gpus: [] };
      const cpuWorkers = maxWorkers.cpu || 0;
      const gpuWorkers = (maxWorkers.gpus || []).reduce((sum: number, w: number) => sum + w, 0);

      // Count active jobs
      const activeJobs = this.db.getJobsByNode(node.id).filter(
        (j: any) => j.status === 'assigned' || j.status === 'processing'
      );

      totalCpuWorkers += cpuWorkers;
      totalGpuWorkers += gpuWorkers;
      usedCpuWorkers += activeJobs.length; // Simplified - each job uses one worker

      details.push({
        nodeId: node.id,
        nodeName: node.name,
        maxCpuWorkers: cpuWorkers,
        maxGpuWorkers: gpuWorkers,
        activeJobs: activeJobs.length,
      });
    }

    return {
      hasCpuWorkers: totalCpuWorkers > 0,
      hasGpuWorkers: totalGpuWorkers > 0,
      cpuWorkersAvailable: totalCpuWorkers - usedCpuWorkers,
      details,
    };
  }

  // Public method to trigger job assignment immediately
  public assignJobsNow(): void {
    this.assignQueuedJobs();
  }

  // Check if a job is an analyze job (CPU-only)
  private isAnalyzeJob(preset: any): boolean {
    return preset?.config?.action === 'analyze';
  }

  // Get available worker slots for a node
  // Returns available slots per GPU device (index in array = GPU device ID)
  private getAvailableWorkers(node: any): { cpu: number; gpus: number[] } {
    const maxWorkers = node.max_workers || { cpu: 1, gpus: [] };
    const allJobs = this.db.getJobsByNode(node.id);
    const activeJobs = allJobs.filter(
      (j: any) => j.status === 'assigned' || j.status === 'processing'
    );

    // Get pending assignments for this node (jobs sent but not yet confirmed)
    const pendingCount = this.pendingAssignments.get(node.id) || 0;

    // Calculate available CPU workers
    const availableCpu = Math.max(0, (maxWorkers.cpu || 0) - activeJobs.length - pendingCount);

    // Calculate available GPU slots per GPU device
    const availableGpus = (maxWorkers.gpus || []).map((maxSlots: number, gpuIndex: number) => {
      // Count jobs assigned to this specific GPU device
      const jobsOnThisGpu = activeJobs.filter((j: any) => {
        const preset = this.db.getPresetById(j.preset_id);
        return preset?.config?.encoding_type === 'gpu' &&
               preset?.config?.gpu_device_id === gpuIndex;
      }).length;

      // Available slots for this GPU
      return Math.max(0, maxSlots - jobsOnThisGpu);
    });

    // Detailed logging
    if (activeJobs.length > 0 || pendingCount > 0) {
      this.logger.debug(`[WORKERS] Node ${node.name}: maxCpu=${maxWorkers.cpu || 0}, activeJobs=${activeJobs.length}, pending=${pendingCount}, availableCpu=${availableCpu}`);
      activeJobs.forEach(j => {
        const preset = this.db.getPresetById(j.preset_id);
        const gpuInfo = preset?.config?.encoding_type === 'gpu'
          ? `, GPU ${preset.config.gpu_device_id ?? 'default'}`
          : ', CPU';
        this.logger.debug(`[WORKERS]   Active job: ${j.id}, status=${j.status}${gpuInfo}`);
      });
    }

    return {
      cpu: availableCpu,
      gpus: availableGpus,
    };
  }

  // Find an available GPU device on a node (returns GPU device ID or null)
  private findAvailableGpuDevice(node: any): number | null {
    const available = this.getAvailableWorkers(node);

    for (let gpuId = 0; gpuId < available.gpus.length; gpuId++) {
      if (available.gpus[gpuId] > 0) {
        this.logger.debug(`[GPU_SELECT] Node ${node.name}: Selected GPU ${gpuId} with ${available.gpus[gpuId]} available slot(s)`);
        return gpuId;
      }
    }

    return null;
  }

  private assignQueuedJobs(): void {
    const queuedJobs = this.db.getJobsByStatus('queued');
    const allNodes = this.db.getAllNodes();
    const onlineNodes = allNodes.filter(n => n.status === 'online' || n.status === 'busy');

    // Log detailed job info
    this.logger.info(`[JOB_ASSIGN] Queued jobs: ${queuedJobs.length}, Online nodes: ${onlineNodes.length}/${allNodes.length}`);
    if (queuedJobs.length > 0) {
      queuedJobs.forEach(j => this.logger.debug(`[JOB_ASSIGN] Queued job: ${j.id}, preset: ${j.preset_id}, file: ${j.file_id}`));
    }
    if (allNodes.length > 0) {
      allNodes.forEach(n => this.logger.debug(`[JOB_ASSIGN] Node: ${n.name} (${n.id}), status: ${n.status}, max_workers: ${JSON.stringify(n.max_workers)}`));
    }

    if (queuedJobs.length === 0) {
      return;
    }

    this.logger.info(`Job assignment: ${queuedJobs.length} queued, ${onlineNodes.length} online nodes`);

    // Clean up stale jobs first
    const now = Math.floor(Date.now() / 1000);
    const staleTimeout = 300; // 5 minutes

    // Log current state for debugging
    this.logger.info(`[CLEANUP] Starting job assignment cleanup`);
    allNodes.forEach(n => {
      const activeJobs = this.db.getJobsByNode(n.id).filter(j => j.status === 'assigned' || j.status === 'processing');
      const pendingCount = this.pendingAssignments.get(n.id) || 0;
      const maxWorkers = n.max_workers || { cpu: 1, gpus: [] };
      this.logger.info(`[CLEANUP] Node ${n.name}: maxCpu=${maxWorkers.cpu || 0}, activeJobs=${activeJobs.length}, pending=${pendingCount}, connected=${this.isNodeConnected(n.id)}`);

      // Log all jobs for this node to help debug
      const allJobs = this.db.getJobsByNode(n.id);
      if (allJobs.length > 0) {
        this.logger.debug(`[CLEANUP] All jobs for node ${n.name}:`);
        allJobs.forEach(j => {
          this.logger.debug(`[CLEANUP]   Job ${j.id}: status=${j.status}, created_at=${j.created_at}, started_at=${j.started_at || 'null'}`);
        });
      }
    });

    allNodes.forEach(n => {
      const activeJobs = this.db.getJobsByNode(n.id);
      const staleJobs = activeJobs.filter(j =>
        (j.status === 'assigned' || j.status === 'processing') &&
        j.started_at && (now - j.started_at) > staleTimeout
      );

      if (staleJobs.length > 0) {
        this.logger.warn(`Cleaning up ${staleJobs.length} stale jobs for node ${n.name}`);
        staleJobs.forEach(job => {
          this.logger.warn(`  Stale job: ${job.id} (${job.status}, started ${(now - (job.started_at || 0))}s ago)`);
          this.db.failJob(job.id, 'Job timed out (no progress for 5 minutes)');
        });
      }
    });

    let assignedCount = 0;
    const analyzeJobs: any[] = [];
    const transcodeJobs: any[] = [];

    // Categorize jobs by type
    for (const job of queuedJobs) {
      const preset = this.db.getPresetById(job.preset_id);
      if (this.isAnalyzeJob(preset)) {
        analyzeJobs.push({ job, preset });
      } else {
        transcodeJobs.push({ job, preset });
      }
    }

    this.logger.debug(`Job queue: ${analyzeJobs.length} analyze, ${transcodeJobs.length} transcode`);

    // Process analyze jobs first (they're quick and CPU-only)
    for (const { job, preset } of analyzeJobs) {
      // Find node with available CPU workers
      const nodeWithCpu = this.findNodeWithAvailableCpu(onlineNodes);
      if (!nodeWithCpu) {
        this.logger.warn(`No CPU workers available for analyze job ${job.id}`);
        continue;
      }

      if (this.assignJobToNodeWithRetry(nodeWithCpu, job, preset)) {
        assignedCount++;
      }
    }

    // Process transcode jobs (can use GPU or CPU)
    for (const { job, preset } of transcodeJobs) {
      // Check if preset uses GPU encoding
      const usesGpu = preset?.config?.encoding_type === 'gpu';

      if (usesGpu) {
        // Find node with available GPU workers
        const nodeWithGpu = this.findNodeWithAvailableGpu(onlineNodes);
        if (nodeWithGpu) {
          // Find specific GPU device on this node
          const gpuDeviceId = this.findAvailableGpuDevice(nodeWithGpu);
          if (gpuDeviceId !== null) {
            if (this.assignJobToNodeWithRetry(nodeWithGpu, job, preset, gpuDeviceId)) {
              assignedCount++;
              continue;
            }
          }
        }
        this.logger.warn(`No GPU workers available for GPU job ${job.id}, falling back to CPU`);
      }

      // Fall back to CPU workers
      const nodeWithCpu = this.findNodeWithAvailableCpu(onlineNodes);
      if (nodeWithCpu) {
        if (this.assignJobToNodeWithRetry(nodeWithCpu, job, preset)) {
          assignedCount++;
        }
      } else {
        this.logger.warn(`No workers available for transcode job ${job.id}`);
      }
    }

    // Always broadcast to show updated job list (even if no jobs were assigned)
    // This ensures clients see new jobs in the queue immediately
    this.broadcastJobsUpdate();

    if (assignedCount > 0) {
      this.logger.info(`Assigned ${assignedCount} job(s) to nodes`);
      this.broadcastNodesUpdate();
    }
  }

  private findNodeWithAvailableCpu(nodes: any[]): any | null {
    // Find the node with available CPU workers (load balanced)
    let bestNode: any | null = null;
    let maxAvailableCpu = 0;
    let minActiveJobs = Infinity;

    this.logger.debug(`[FIND_CPU] Checking ${nodes.length} nodes for available CPU workers`);

    for (const node of nodes) {
      const available = this.getAvailableWorkers(node);

      this.logger.debug(`[FIND_CPU] Node ${node.name}: availableCpu=${available.cpu}, maxCpu=${node.max_workers?.cpu || 0}`);

      if (available.cpu > 0) {
        const activeJobs = this.db.getJobsByNode(node.id).filter(
          (j: any) => j.status === 'assigned' || j.status === 'processing'
        ).length;

        // Prefer node with more available CPU slots
        // If tied, prefer node with fewer active jobs
        if (available.cpu > maxAvailableCpu ||
            (available.cpu === maxAvailableCpu && activeJobs < minActiveJobs)) {
          maxAvailableCpu = available.cpu;
          minActiveJobs = activeJobs;
          bestNode = node;
        }
      }
    }

    if (bestNode) {
      this.logger.debug(`[CPU_AVAIL] Node ${bestNode.name} selected with ${maxAvailableCpu} CPU slots available (active jobs: ${minActiveJobs})`);
    }

    return bestNode;
  }

  private findNodeWithAvailableGpu(nodes: any[]): any | null {
    // Find the node with the MOST available GPU slots (load balancing)
    // When tied, prefer the node with fewer active jobs (better load distribution)
    let bestNode: any | null = null;
    let maxAvailableSlots = 0;
    let minActiveJobs = Infinity;

    for (const node of nodes) {
      const available = this.getAvailableWorkers(node);
      const totalGpuSlotsAvailable = available.gpus.reduce((sum: number, slots: number) => sum + slots, 0);

      if (totalGpuSlotsAvailable > 0) {
        const activeJobs = this.db.getJobsByNode(node.id).filter(
          (j: any) => j.status === 'assigned' || j.status === 'processing'
        ).length;

        // Prefer node with more available slots
        // If tied on slots, prefer node with fewer active jobs
        if (totalGpuSlotsAvailable > maxAvailableSlots ||
            (totalGpuSlotsAvailable === maxAvailableSlots && activeJobs < minActiveJobs)) {
          maxAvailableSlots = totalGpuSlotsAvailable;
          minActiveJobs = activeJobs;
          bestNode = node;
        }
      }
    }

    if (bestNode) {
      this.logger.debug(`[GPU_AVAIL] Node ${bestNode.name} selected with ${maxAvailableSlots} GPU slots available (active jobs: ${minActiveJobs})`);
    }

    return bestNode;
  }

  private assignJobToNodeWithRetry(node: any, job: any, preset: any, gpuDeviceId?: number): boolean {
    // Get job details
    const file = this.db.getFileById(job.file_id);
    if (!file) {
      this.logger.warn(`Job ${job.id}: file ${job.file_id} not found`);
      return false;
    }

    let mapping = this.db.getFolderMappingById(file.folder_mapping_id);
    if (!mapping) {
      this.logger.warn(`Job ${job.id}: folder mapping ${file.folder_mapping_id} not found`);
      return false;
    }

    // Variable to track if we should use the library's server path directly (no mapping needed)
    let useLibraryServerPath = false;
    let libraryServerPath: string | undefined;

    // For library mappings, check if there's a node-specific mapping for the target node
    if (mapping.server_path?.startsWith('library:')) {
      const libraryId = mapping.server_path.replace('library:', '');
      const nodeMappings = this.db.getFolderMappingsByNode(node.id);
      const nodeSpecificMapping = nodeMappings.find(m => m.server_path === `library:${libraryId}`);

      if (nodeSpecificMapping) {
        this.logger.info(`[NODE_MAPPING] Found node-specific mapping for node ${node.name} and library ${libraryId}`);
        mapping = nodeSpecificMapping;
      } else {
        // No node-specific mapping exists - use the library's server path directly
        // This allows nodes running on the same machine as the server to access files directly
        const library = this.db.getLibraryById(libraryId);
        if (library) {
          this.logger.info(`[NODE_MAPPING] No node-specific mapping for node ${node.name} and library ${libraryId}, using library server path: ${library.path}`);
          useLibraryServerPath = true;
          libraryServerPath = library.path;
        } else {
          this.logger.warn(`[NODE_MAPPING] Library ${libraryId} not found, falling back to default mapping`);
        }
      }
    }

    // Check if this is an analyze-only job
    const isAnalyzeJob = preset.config?.action === 'analyze';

    // Get file metadata to extract source codec
    let sourceCodec: string | undefined;
    let metadata: any = undefined;

    // For library files, get metadata from library_files table
    if (mapping.server_path?.startsWith('library:')) {
      const basePath = useLibraryServerPath ? libraryServerPath : mapping.node_path;
      const fullPath = basePath && !basePath.includes('.mkv') && !basePath.includes('.mp4') && !basePath.includes('.avi')
        ? `${basePath}/${file.relative_path}`
        : basePath || file.relative_path;

      const libFile = this.db.getLibraryFileByFilepath(fullPath);
      if (libFile?.metadata) {
        metadata = libFile.metadata;
      }
    }

    // Extract source codec from metadata
    if (metadata?.video_codec) {
      const codecLower = metadata.video_codec.toLowerCase();
      if (codecLower.includes('265') || codecLower.includes('hevc')) {
        sourceCodec = 'h265';
      } else if (codecLower.includes('264') || codecLower.includes('avc')) {
        sourceCodec = 'h264';
      } else if (codecLower.includes('mpeg2') || codecLower.includes('mpeg2video')) {
        sourceCodec = 'mpeg2';
      }
    }

    // Enhance preset config with source codec and explicit decoder flag for GPU
    const enhancedConfig = { ...preset.config };

    // For GPU encoding, add source codec, GPU device ID, and enable explicit decoder
    if (enhancedConfig.encoding_type === 'gpu') {
      if (sourceCodec) {
        enhancedConfig.source_codec = sourceCodec;
        enhancedConfig.use_explicit_decoder = true;
        this.logger.info(`[GPU_PIPELINE] Job ${job.id}: Enhanced config with source_codec=${sourceCodec}, use_explicit_decoder=true for true GPU pipeline`);
      }
      if (gpuDeviceId !== undefined) {
        enhancedConfig.gpu_device_id = gpuDeviceId;
        this.logger.info(`[GPU_DEVICE] Job ${job.id}: Assigned to GPU device ${gpuDeviceId}`);
      }
    }

    // Determine source path
    let sourcePath: string;

    if (mapping.server_path?.startsWith('library:')) {
      const basePath = useLibraryServerPath ? libraryServerPath! : mapping.node_path;
      if (basePath && (basePath.includes('.mkv') || basePath.includes('.mp4') || basePath.includes('.avi'))) {
        sourcePath = basePath;
      } else {
        sourcePath = `${basePath}/${file.relative_path}`;
      }
    } else {
      sourcePath = `${mapping.node_path}/${file.relative_path}`;
    }

    // Determine destination path (only for transcode jobs, not analyze)
    let destPath: string | undefined;
    if (!isAnalyzeJob) {
      if (mapping.server_path?.startsWith('library:')) {
        const basePath = useLibraryServerPath ? libraryServerPath! : mapping.node_path;
        if (basePath && (basePath.includes('.mkv') || basePath.includes('.mp4') || basePath.includes('.avi'))) {
          destPath = basePath.replace(/\.[^.]+$/, '_enc.mkv');
        } else {
          destPath = `${basePath}/${file.relative_path.replace(/\.[^.]+$/, '_enc.mkv')}`;
        }
      } else {
        destPath = `${mapping.node_path}/${file.relative_path.replace(/\.[^.]+$/, '_enc.mkv')}`;
      }
    }

    this.logger.debug(`Assigning job ${job.id} to node ${node.name} (${node.id})${isAnalyzeJob ? ' (analyze only)' : ''}`);

    this.assignJobToNode(node.id, {
      job_id: job.id,
      file_id: file.id,
      preset_id: preset.id,
      source_path: sourcePath,
      dest_path: destPath,
      config: enhancedConfig,
    }).catch(error => {
      this.logger.error(`Failed to assign job ${job.id}:`, error);
    });

    return true;
  }

  // ========================================================================
  // Cleanup
  // ========================================================================

  close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    for (const [ws, connection] of this.connections) {
      for (const pending of connection.pendingRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Server shutting down'));
      }
      ws.close();
    }

    for (const [ws] of this.webClients) {
      ws.close();
    }

    this.connections.clear();
    this.connectionsByNodeId.clear();
    this.webClients.clear();
    this.wss.close();

    this.logger.info('WebSocket server closed');
  }
}
