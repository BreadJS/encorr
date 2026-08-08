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
  FileReplacePayload,
  FileReplaceProgressPayload,
  AckPayload,
  WebLibraryScanUpdatePayload,
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
  isFileReplaceResultMessage,
  isAckMessage,
  isErrorMessage,
  generateMessageId,
  validateMessagePayload,
  MessageType,
  parseFFmpegError,
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
  subscriptions: Set<'nodes' | 'jobs' | 'library'>;
  lastHeartbeat: number;
}

interface RejectedNodeRegistration {
  id: string;
  name: string;
  status: 'error';
  connected: false;
  rejected: true;
  rejection_reason: string;
  rejected_at: number;
  last_heartbeat: number;
  system_info: RegisterPayload['system_info'];
  active_jobs: [];
  max_workers: { cpu: number; gpus: number[] };
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
  private rejectedNodeRegistrations: Map<string, RejectedNodeRegistration> = new Map();
  private activeLibraryScans: Map<string, WebLibraryScanUpdatePayload> = new Map();
  private db: EncorrDatabase;
  private logger: Logger;
  private eventHandlers: Partial<WebSocketServerEvents> = {};
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private jobAssignmentTimer: NodeJS.Timeout | null = null;
  private webUpdateTimer: NodeJS.Timeout | null = null;
  // Track pending job assignments per node (node_id -> count of pending assignments)
  private pendingAssignments: Map<string, number> = new Map();
  private cpuJobReservations: Map<string, Set<string>> = new Map();
  // Track every job reserved on each GPU. A GPU can have more than one slot, so
  // tracking only the device ID would collapse multiple reservations into one.
  private gpuJobAssignments: Map<string, Map<number, Set<string>>> = new Map();

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

  /** Keep usable encode devices while applying the server's worker-GPU policy. */
  private filterIntegratedGPUs(systemInfo: any): any {
    if (!systemInfo.gpus || !Array.isArray(systemInfo.gpus)) {
      return systemInfo;
    }

    const filteredGpus = systemInfo.gpus.filter((gpu: any) => {
      const name = (gpu.name || gpu.model || '').toLowerCase();
      const vendor = (gpu.vendor || '').toLowerCase();

      // Intel Arc and Intel integrated graphics both expose usable Quick Sync
      // encoders. Capability checks later verify that FFmpeg actually reports
      // h264_qsv/hevc_qsv before a job can be routed here.
      if (/\bintel\b|\barc(?:\(tm\))?\b/.test(`${vendor} ${name}`)) return true;

      // AMD APUs expose usable AMF/VAAPI encoders too. Keep them available as
      // workers instead of guessing capability from their name or shared VRAM.
      if (/\bamd\b|advanced micro devices|\bradeon\b|\bati\b/.test(`${vendor} ${name}`)) {
        return true;
      }

      return true; // Keep this GPU
    });

    const uniqueGpus: any[] = [];
    for (const gpu of filteredGpus) {
      const pciAddress = this.parseGpuPciAddress(gpu.pci_bus);
      const modelSignature = this.getGpuModelSignature(gpu);
      const duplicateIndex = uniqueGpus.findIndex(existing => {
        const existingPciAddress = this.parseGpuPciAddress(existing.pci_bus);
        if (pciAddress && existingPciAddress && pciAddress.full === existingPciAddress.full) return true;
        if (!pciAddress || !existingPciAddress || !modelSignature || modelSignature !== this.getGpuModelSignature(existing)) return false;

        const decimalHexAlias = (
          Number.parseInt(pciAddress.bus, 10).toString(16).padStart(2, '0') === existingPciAddress.bus
          || Number.parseInt(existingPciAddress.bus, 10).toString(16).padStart(2, '0') === pciAddress.bus
        ) && pciAddress.deviceFunction === existingPciAddress.deviceFunction;
        return decimalHexAlias && (!this.hasGpuDriverTelemetry(gpu) || !this.hasGpuDriverTelemetry(existing));
      });

      if (duplicateIndex < 0) {
        uniqueGpus.push(gpu);
        continue;
      }

      const existing = uniqueGpus[duplicateIndex];
      const primary = this.hasGpuDriverTelemetry(existing) ? existing : gpu;
      const secondary = primary === existing ? gpu : existing;
      const merged = { ...secondary, ...primary };
      for (const [key, value] of Object.entries(secondary)) {
        if (merged[key] === undefined || merged[key] === null || merged[key] === '') merged[key] = value;
      }
      uniqueGpus[duplicateIndex] = merged;
      this.logger.info(`Collapsed duplicate GPU ${gpu.name || gpu.model} (${existing.pci_bus} / ${gpu.pci_bus})`);
    }

    const removedCount = systemInfo.gpus.length - uniqueGpus.length;
    if (removedCount > 0) {
      this.logger.info(`Normalized GPUs: ${systemInfo.gpus.length} -> ${uniqueGpus.length} (removed ${removedCount} duplicate or unsupported entry/entries)`);
    }

    return {
      ...systemInfo,
      gpus: uniqueGpus,
    };
  }

  private parseGpuPciAddress(value?: string): { full: string; bus: string; deviceFunction: string } | null {
    const match = value?.toLowerCase().match(/([0-9a-f]{2}):([0-9a-f]{2}\.[0-9a-f])$/);
    return match ? { full: `${match[1]}:${match[2]}`, bus: match[1], deviceFunction: match[2] } : null;
  }

  private getGpuModelSignature(gpu: any): string | null {
    const identity = `${gpu.vendor || ''} ${gpu.name || gpu.model || ''}`.toLowerCase();
    const nvidiaModel = identity.match(/\b(?:geforce\s*)?(rtx|gtx)\s*(\d{3,4})(?:\s*(ti|super))?\b/);
    return nvidiaModel ? `nvidia:${nvidiaModel[1]}:${nvidiaModel[2]}:${nvidiaModel[3] || ''}` : null;
  }

  private hasGpuDriverTelemetry(gpu: any): boolean {
    return Boolean(
      gpu.driver_version
      || gpu.utilizationGpu !== undefined
      || gpu.temperatureGpu !== undefined
      || gpu.powerDraw !== undefined
      || gpu.memoryUsed !== undefined
    );
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
        this.cpuJobReservations.delete(connection.nodeId);

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
        case 'FILE_REPLACE_RESULT':
          this.handleFileReplaceResult(ws, message as any);
          break;
        case 'FILE_REPLACE_PROGRESS':
          this.handleFileReplaceProgress(ws, message as any);
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
      const normalizedName = payload.name.trim().toLocaleLowerCase();
      // Compare names case-insensitively: names are human labels, not IDs.
      let node = this.db.getAllNodes().find(n => n.name.trim().toLocaleLowerCase() === normalizedName);

      // A name identifies one live worker. Re-registering the same database
      // node after a reconnect is fine, but a second simultaneous socket must
      // never replace the active socket or inherit its worker reservations.
      const activeConnection = node ? this.connectionsByNodeId.get(node.id) : undefined;
      if (activeConnection && activeConnection.ws !== ws && activeConnection.ws.readyState === WebSocket.OPEN) {
        const reason = `Another connected node already uses the name "${payload.name}". Rename this node and reconnect.`;
        const existingRejection = this.rejectedNodeRegistrations.get(normalizedName);
        const rejectedAt = Math.floor(Date.now() / 1000);
        this.rejectedNodeRegistrations.set(normalizedName, {
          id: existingRejection?.id || `rejected:${uuidv4()}`,
          name: payload.name,
          status: 'error',
          connected: false,
          rejected: true,
          rejection_reason: reason,
          rejected_at: rejectedAt,
          last_heartbeat: rejectedAt,
          system_info: payload.system_info,
          active_jobs: [],
          max_workers: { cpu: 0, gpus: [] },
        });

        const connection = this.connections.get(ws);
        if (connection) connection.nodeName = payload.name;
        this.logger.warn(`[NODE_REJECTED] ${reason}`);
        this.sendMessage(ws, createErrorMessage('DUPLICATE_NODE_NAME', reason, {
          existing_node_id: node.id,
          existing_node_name: node.name,
        }));
        this.broadcastNodesUpdate();
        ws.close(1008, 'Duplicate node name');
        return;
      }

      // Normalize the GPUs accepted as encoding workers only after the
      // duplicate-name check has accepted this connection.
      const filteredSystemInfo = this.filterIntegratedGPUs(payload.system_info);

      if (node) {
        // Update existing node
        this.db.updateNodeStatus(node.id, 'online', Math.floor(Date.now() / 1000));
        // Also update system info when re-registering (with filtered GPUs)
        this.db.updateNodeSystemInfo(node.id, filteredSystemInfo);
        this.logger.info(`Node re-registered: ${node.id} (${payload.name})`);
        this.logger.info(`Updated system_info with ${filteredSystemInfo.gpus?.length || 0} GPU(s) (filtered from ${payload.system_info.gpus?.length || 0})`);

        // Normalize any older GPU information already stored in the database.
        const currentNodeData = this.db.getNodeById(node.id);
        if (currentNodeData && currentNodeData.system_info.gpus) {
          const alreadyFiltered = this.filterIntegratedGPUs(currentNodeData.system_info);
          if (alreadyFiltered.gpus.length !== currentNodeData.system_info.gpus.length) {
            this.logger.info(`Cleaned up integrated GPUs on re-registration: ${currentNodeData.system_info.gpus.length} -> ${alreadyFiltered.gpus.length}`);
            this.db.updateNodeSystemInfo(node.id, alreadyFiltered);
          }
        }

        // Preserve configured limits and add one usable slot for GPUs that
        // were newly discovered (notably Arc devices hidden by older builds).
        const refreshedNode = this.db.getNodeById(node.id);
        const detectedGpuCount = filteredSystemInfo.gpus?.length || 0;
        const currentLimits = refreshedNode?.max_workers || { cpu: 1, gpus: [] };
        if (currentLimits.gpus.length < detectedGpuCount) {
          this.db.updateNodeMaxWorkers(node.id, {
            cpu: currentLimits.cpu,
            gpus: [
              ...currentLimits.gpus,
              ...new Array(detectedGpuCount - currentLimits.gpus.length).fill(1),
            ],
          });
          this.logger.info(`Added worker slots for ${detectedGpuCount - currentLimits.gpus.length} newly detected GPU(s)`);
        } else if (currentLimits.gpus.length > detectedGpuCount) {
          // A previous node version may have registered the same physical GPU
          // twice. Keep the configured values for real devices but drop the
          // now-invalid trailing slots as soon as corrected hardware data
          // arrives, so scheduling cannot target a phantom GPU.
          this.db.updateNodeMaxWorkers(node.id, {
            cpu: currentLimits.cpu,
            gpus: currentLimits.gpus.slice(0, detectedGpuCount),
          });
          this.logger.info(`Removed ${currentLimits.gpus.length - detectedGpuCount} stale GPU worker slot(s)`);
        }
      } else {
        // Create new node
        node = this.db.createNode({
          name: payload.name,
          system_info: filteredSystemInfo,
          capabilities: payload.capabilities,
        });

        // Initialize max_workers and config for new node
        const gpuCount = filteredSystemInfo.gpus?.length || 0;

        this.db.updateNodeUsage(node.id, {
          gpu_usage: new Array(gpuCount).fill(0),
        });

        this.db.updateNodeConfig(node.id, {
          cpu_preset: null,
          gpu_presets: new Array(gpuCount).fill(null),
        });
        this.db.updateNodeMaxWorkers(node.id, {
          cpu: 1,
          gpus: new Array(filteredSystemInfo.gpus?.length || 0).fill(1),
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
      this.rejectedNodeRegistrations.delete(normalizedName);

      // Send ACK
      this.sendMessage(ws, createAckMessage(message.id!, true, node.id));

      // Notify event handlers
      this.eventHandlers.nodeRegistered?.(node.id, payload.name);

      // Broadcast update to web clients
      this.broadcastNodesUpdate();

      // A server restart or temporary disconnect may leave valid jobs queued.
      // Resume dispatch as soon as a worker has registered again.
      setImmediate(() => this.assignJobsNow());

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
    const cpuUsage = payload.system_load?.cpu_percent;
    const ramUsage = payload.system_load?.memory_percent;

    // Get current node info for static GPU info and to preserve existing active_jobs data
    const node = this.db.getAllNodes().find(n => n.id === connection.nodeId);
    const existingActiveJobs = node?.active_jobs || [];

    if (node && payload.drives) {
      node.system_info = { ...node.system_info, drives: payload.drives };
      this.db.updateNodeSystemInfo(connection.nodeId, node.system_info);
    }

    // Build active jobs info - preserve existing rich data (fps, eta, etc.) from DB
    const uniqueHeartbeatJobs = Array.from(new Map(
      (payload.active_jobs || []).map(job => [job.job_id, job]),
    ).values());
    const activeJobsInfo = uniqueHeartbeatJobs.flatMap(job => {
      const dbJob = this.db.getJobById(job.job_id);
      if (!dbJob || (dbJob.status !== 'assigned' && dbJob.status !== 'processing')) {
        return [];
      }
      const file = dbJob ? this.db.getFileById(dbJob.file_id) : null;

      // Find existing job data to preserve fps, eta, and other fields set by JOB_PROGRESS
      const existingJob = existingActiveJobs.find((j: any) => j.id === job.job_id);

      return [{
        id: job.job_id,
        file_name: file?.relative_path,
        progress: job.progress,
        // Always include GPU from the payload (node sets this correctly)
        gpu: job.gpu,
        // Prefer the node's current telemetry. Existing values are only a
        // fallback when a particular heartbeat field is unavailable.
        fps: job.fps ?? existingJob?.fps,
        eta: job.eta !== undefined ? this.formatDuration(job.eta) : existingJob?.eta,
        ratio: job.ratio ?? existingJob?.ratio,
        current_action: job.current_action || existingJob?.current_action,
        preset_name: existingJob?.preset_name,
        status: dbJob.status,
      } as any]; // Use 'as any' since active_jobs is dynamically typed
    });

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

        // Node telemetry is deliberately sent in the same order as its static
        // GPU list. Merge by index so Intel Arc (and mixed-vendor systems) do
        // not depend on a vendor-matching branch that previously only covered
        // NVIDIA and AMD.
        const updatedGpus = filteredSystemInfo.gpus.map((staticGpu: any, index: number) => {
          const liveGpu = payload.gpus![index];
          if (!liveGpu) return staticGpu;
          return {
            ...staticGpu,
            utilizationGpu: liveGpu.utilizationGpu ?? staticGpu.utilizationGpu,
            utilizationMemory: liveGpu.utilizationMemory ?? staticGpu.utilizationMemory,
            memoryUsed: liveGpu.memoryUsed ?? staticGpu.memoryUsed,
            memoryFree: liveGpu.memoryFree ?? staticGpu.memoryFree,
            temperatureGpu: liveGpu.temperatureGpu ?? staticGpu.temperatureGpu,
            powerDraw: liveGpu.powerDraw ?? staticGpu.powerDraw,
            powerLimit: liveGpu.powerLimit ?? staticGpu.powerLimit,
            clockCore: liveGpu.clockCore ?? staticGpu.clockCore,
            clockMemory: liveGpu.clockMemory ?? staticGpu.clockMemory,
          };
        });

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
      // Immediate lifecycle heartbeats intentionally omit system telemetry.
      // Leaving these undefined preserves the latest measured values instead
      // of flashing the dashboard to 0% between one-second samples.
      ...(cpuUsage !== undefined && { cpu_usage: cpuUsage }),
      ...(ramUsage !== undefined && { ram_usage: ramUsage }),
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

    // JOB_ACCEPT is the authoritative delivery acknowledgement. Once it
    // arrives, the database status accounts for the slot and the temporary
    // CPU reservation must not continue occupying it.
    this.releaseCpuAssignment(connection.nodeId, payload.job_id);

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
          gpu: this.getReservedGpuDevice(connection.nodeId, job.id),
        };
        const currentActiveJobs = (node.active_jobs || []).filter(item => item.id !== job.id);
        this.db.updateNodeUsage(connection.nodeId!, { active_jobs: [...currentActiveJobs, activeJob] });
      }

      this.logger.info(`Job ${payload.job_id} accepted by node ${connection.nodeId}`);
      // Broadcast updates
      this.broadcastNodesUpdate();
    } else {
      this.logger.warn(`Job ${payload.job_id} rejected by node ${connection.nodeId}: ${payload.reason}`);
      this.releaseGpuAssignment(connection.nodeId, payload.job_id);

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
    this.broadcastNodesUpdate();

    this.sendMessage(ws, createAckMessage(message.id!));
  }

  // Helper to resolve a file_id (from files table) to a library_file_id
  private resolveLibraryFileId(fileId: string): string | null {
    const file = this.db.getFileById(fileId);
    if (!file?.folder_mapping_id) return null;

    const mapping = this.db.getFolderMappingById(file.folder_mapping_id);
    if (!mapping?.server_path?.startsWith('library:')) return null;

    const fullPath = mapping.node_path && !mapping.node_path.includes('.mkv') && !mapping.node_path.includes('.mp4')
      ? `${mapping.node_path}/${file.relative_path}`
      : mapping.node_path || file.relative_path;

    let libFile = this.db.getLibraryFileByFilepath(fullPath);

    // Node and server roots can differ. Resolve through indexed library/path
    // columns instead of loading the entire library for a filename scan.
    if (!libFile) {
      const libraryId = mapping.server_path.replace('library:', '');
      const library = this.db.getLibraryById(libraryId);
      if (library) {
        libFile = this.db.getLibraryFileByRelativePath(libraryId, library.path, file.relative_path);
      }
    }

    return libFile?.id ?? null;
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

    // Get job details before completion for logging
    const jobBeforeComplete = this.db.getJobById(payload.job_id);
    const presetBeforeComplete = jobBeforeComplete ? this.db.getPresetById(jobBeforeComplete.preset_id) : null;
    const gpuDeviceId = presetBeforeComplete?.config?.gpu_device_id;

    this.logger.info(`[JOB_COMPLETE] Job ${payload.job_id} details before completion:`);
    this.logger.info(`[JOB_COMPLETE]   status: ${jobBeforeComplete?.status}`);
    this.logger.info(`[JOB_COMPLETE]   gpu_device_id: ${gpuDeviceId}`);
    this.logger.info(`[JOB_COMPLETE]   GPU assignments for node ${connection.nodeId}: ${this.formatGpuAssignments(connection.nodeId)}`);

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

      // Verify the job was marked as completed
      const jobAfterComplete = this.db.getJobById(payload.job_id);
      this.logger.info(`[JOB_COMPLETE] Job ${payload.job_id} status after completion: ${jobAfterComplete?.status}`);
    } else {
      this.logger.warn(`Job complete has neither metadata nor stats! Keys: ${Object.keys(payload).join(', ')}`);
    }

    // Update node status
    this.db.updateNodeStatus(connection.nodeId, 'online');
    this.releaseGpuAssignment(connection.nodeId, payload.job_id);
    this.releaseCpuAssignment(connection.nodeId, payload.job_id);

    // Remove job from active_jobs
    const node = this.db.getAllNodes().find(n => n.id === connection.nodeId);
    if (node && node.active_jobs) {
      const updatedActiveJobs = node.active_jobs.filter(job => job.id !== payload.job_id);
      this.db.updateNodeUsage(connection.nodeId!, { active_jobs: updatedActiveJobs });
    }

    // Several workers commonly finish in the same burst. Give the server a
    // short window to consume all completion messages, then refill every freed
    // slot in one pass. Refilling inside each completion handler creates a
    // one-job-at-a-time feedback loop.
    this.scheduleJobAssignment();

    // Log activity
    const metadata = payload.metadata || payload.stats;
    this.db.logActivity({
      level: 'info',
      category: 'job',
      message: `Job ${payload.job_id} completed successfully`,
      metadata: metadata,
    });

    // Create job report
    try {
      const node = connection.nodeId ? this.db.getNodeById(connection.nodeId) : null;
      const job = this.db.getJobById(payload.job_id);
      if (job) {
        const preset = this.db.getPresetById(job.preset_id);
        const isAnalyze = !!payload.metadata;
        const nodeRecord = connection.nodeId ? this.db.getAllNodes().find(n => n.id === connection.nodeId) : null;
        this.db.createJobReport({
          job_id: payload.job_id,
          file_id: job.file_id,
          library_file_id: this.resolveLibraryFileId(job.file_id),
          node_id: connection.nodeId ?? null,
          node_name: nodeRecord?.name ?? null,
          job_type: isAnalyze ? 'analyze' : 'transcode',
          preset_id: preset?.id ?? null,
          preset_name: preset?.name ?? null,
          status: 'completed',
          ffmpeg_logs: payload.ffmpeg_logs ?? null,
          node_logs: payload.decoder_info ?? null,
          original_size: payload.stats?.original_size ?? null,
          output_size: payload.stats?.transcoded_size ?? null,
          output_path: payload.stats ? payload.output_path : null,
          duration_seconds: payload.stats?.duration_seconds ?? null,
          avg_fps: payload.stats?.avg_fps ?? null,
          started_at: job.started_at ?? null,
          completed_at: Math.floor(Date.now() / 1000),
          config: preset ? JSON.stringify(preset.config) : null,
          metadata: JSON.stringify(payload.metadata || payload.stats || null),
        });
      }
    } catch (reportErr) {
      this.logger.error(`[REPORT] Failed to create report: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`);
    }

    if (payload.stats) {
      this.startPostTranscodeAction(payload.job_id);
    }

    this.eventHandlers.jobCompleted?.(payload.job_id, metadata);
    this.scheduleWebUpdates();

    this.sendMessage(ws, createAckMessage(message.id!));
  }

  private handleJobError(ws: WebSocket, message: NodeToServerMessage): void {
    const connection = this.connections.get(ws);
    if (!connection || !connection.nodeId) return;

    const payload = message.payload as JobErrorPayload;
    const parsedError = payload.ffmpeg_logs
      ? parseFFmpegError(payload.ffmpeg_logs, payload.error)
      : null;
    const errorMessage = parsedError?.message || payload.error;

    // Check if this job was already cancelled - if so, don't overwrite with 'failed'
    const existingJob = this.db.getJobById(payload.job_id);
    const isCancellation = payload.error === 'Cancelled by user';

    if (existingJob?.status === 'cancelled' && isCancellation) {
      this.logger.info(`Job ${payload.job_id} was already cancelled, skipping error handling`);
      // Still need to clean up active_jobs and update node status
      this.db.updateNodeStatus(connection.nodeId, 'online');
      const node = this.db.getAllNodes().find(n => n.id === connection.nodeId);
      if (node && node.active_jobs) {
        const updatedActiveJobs = node.active_jobs.filter(job => job.id !== payload.job_id);
        this.db.updateNodeUsage(connection.nodeId!, { active_jobs: updatedActiveJobs });
      }

      // Clear pending assignments for cancelled job
      const pending = this.pendingAssignments.get(connection.nodeId) || 0;
      if (pending > 0) {
        this.pendingAssignments.set(connection.nodeId, pending - 1);
        this.logger.info(`[CANCEL] Cleared pending assignment for node ${connection.nodeId}, now ${pending - 1}`);
      }

      this.releaseGpuAssignment(connection.nodeId, payload.job_id);
      this.releaseCpuAssignment(connection.nodeId, payload.job_id);

      this.sendMessage(ws, createAckMessage(message.id!));
      return;
    }

    this.logger.error(`Job ${payload.job_id} failed on node ${connection.nodeId}: ${errorMessage}`);

    this.db.failJob(payload.job_id, errorMessage);
    this.releaseGpuAssignment(connection.nodeId, payload.job_id);
    this.releaseCpuAssignment(connection.nodeId, payload.job_id);

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
      message: `Job ${payload.job_id} failed: ${errorMessage}`,
      metadata: {
        ...payload.details,
        ...(parsedError?.recognized ? { ffmpeg_error_code: parsedError.code } : {}),
      },
    });

    // Create job report for failure
    try {
      const job = this.db.getJobById(payload.job_id);
      if (job) {
        const preset = this.db.getPresetById(job.preset_id);
        const nodeRecord = connection.nodeId ? this.db.getAllNodes().find(n => n.id === connection.nodeId) : null;
        const isAnalyze = (preset?.config as any)?.action === 'analyze';
        this.db.createJobReport({
          job_id: payload.job_id,
          file_id: job.file_id,
          library_file_id: this.resolveLibraryFileId(job.file_id),
          node_id: connection.nodeId ?? null,
          node_name: nodeRecord?.name ?? null,
          job_type: isAnalyze ? 'analyze' : 'transcode',
          preset_id: preset?.id ?? null,
          preset_name: preset?.name ?? null,
          status: 'failed',
          error_message: errorMessage,
          ffmpeg_logs: payload.ffmpeg_logs ?? null,
          duration_seconds: null,
          avg_fps: null,
          started_at: job.started_at ?? null,
          completed_at: Math.floor(Date.now() / 1000),
          config: preset ? JSON.stringify(preset.config) : null,
        });
      }
    } catch (reportErr) {
      this.logger.error(`[REPORT] Failed to create failure report: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`);
    }

    this.eventHandlers.jobFailed?.(payload.job_id, errorMessage);

    this.scheduleWebUpdates();

    // Coalesce near-simultaneous worker failures/completions into one refill.
    this.scheduleJobAssignment();

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

  private handleFileReplaceResult(ws: WebSocket, message: NodeToServerMessage): void {
    const connection = this.connections.get(ws);
    if (!connection || !connection.nodeId) {
      this.logger.warn('[FILE_REPLACE_RESULT] Received message from unconnected node');
      this.sendMessage(ws, createErrorMessage('INVALID_NODE', 'Node not connected'));
      return;
    }

    const payload = message.payload as any; // FileReplaceResultPayload

    this.logger.info(`[FILE_REPLACE_RESULT] File replace result for file ${payload.file_id}: ${payload.operation} - ${payload.success ? 'success' : 'failed'}`);

    if (payload.success) {
      // Update file status based on operation
      if (payload.operation === 'backup_replace') {
        // Set status to backup_replaced so user can cleanup later
        if (payload.new_metadata) {
          this.db.updateLibraryFileAfterReplacement(payload.file_id, payload.new_metadata, 'backup_replaced');
        } else {
          this.db.updateLibraryFileStatus(payload.file_id, 'backup_replaced');
        }
        this.db.confirmStorageReplacement(payload.file_id, 'backup_replace');
      } else if (payload.operation === 'replace') {
        if (payload.new_metadata) {
          this.db.updateLibraryFileAfterReplacement(payload.file_id, payload.new_metadata, 'completed');
        } else {
          this.db.updateLibraryFileStatus(payload.file_id, 'completed');
        }
        this.db.confirmStorageReplacement(payload.file_id, 'replace');
      } else if (payload.operation === 'cleanup_backup') {
        // After cleanup, keep as completed
        this.db.updateLibraryFileStatus(payload.file_id, 'completed');
        this.db.confirmStorageBackupCleanup(payload.file_id);
      }

      this.logger.info(`[FILE_REPLACE_RESULT] File ${payload.file_id} status updated after ${payload.operation}`);
    } else {
      this.logger.error(`[FILE_REPLACE_RESULT] File ${payload.file_id} ${payload.operation} failed: ${payload.error}`);
      if (payload.operation === 'replace' || payload.operation === 'backup_replace') {
        const replacementError = payload.error || 'Replacement failed';
        this.db.failStorageReplacement(payload.file_id, payload.operation, replacementError);
        if (/source file not found/i.test(replacementError)) {
          this.db.markLatestTranscodeOutputUnavailable(payload.file_id, replacementError);
        }
      } else if (payload.operation === 'cleanup_backup') {
        this.db.failStorageBackupCleanup(payload.operation_id, payload.error || 'Backup removal failed');
      }
    }

    // Broadcast updates to web clients
    this.broadcastJobsUpdate();

    this.sendMessage(ws, createAckMessage(message.id!));
    this.logger.debug(`[FILE_REPLACE_RESULT] Sent ACK for message ${message.id}`);
  }

  private handleFileReplaceProgress(ws: WebSocket, message: NodeToServerMessage): void {
    const connection = this.connections.get(ws);
    if (!connection?.nodeId) return;
    const payload = message.payload as FileReplaceProgressPayload;
    this.db.updateStorageReclaimProgress(payload.operation_id, payload);
    this.scheduleWebUpdates(100);
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
              utilizationGpu: updateData.utilizationGpu ?? gpu.utilizationGpu,
              utilizationMemory: updateData.utilizationMemory ?? gpu.utilizationMemory,
              temperatureGpu: updateData.temperatureGpu ?? gpu.temperatureGpu,
              memoryUsed: updateData.memoryUsed ?? gpu.memoryUsed,
              memoryFree: updateData.memoryFree ?? gpu.memoryFree,
              powerDraw: updateData.powerDraw ?? gpu.powerDraw,
              powerLimit: updateData.powerLimit ?? gpu.powerLimit,
              clockCore: updateData.clockCore ?? gpu.clockCore,
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
    const payload = message.payload as { channels?: ('nodes' | 'jobs' | 'library')[] };
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
      if (channels.includes('library')) {
        this.sendActiveLibraryScans(ws);
      }

      this.sendMessage(ws, createAckMessage(message.id!, true, 'Subscribed'));
    } else if (!nodeConn) {
      // Already a web client, update subscriptions
      const webClient = this.webClients.get(ws);
      if (webClient) {
        channels.forEach(ch => webClient.subscriptions.add(ch));
        this.logger.info(`Web client updated subscriptions: ${Array.from(webClient.subscriptions).join(', ')}`);
        if (channels.includes('library')) {
          this.sendActiveLibraryScans(ws);
        }
        this.sendMessage(ws, createAckMessage(message.id!, true, 'Subscriptions updated'));
      }
    }
  }

  private sendNodesUpdate(ws: WebSocket): void {
    const nodes = this.getNodesForClients();
    const message = createMessage(MessageType.WEB_NODES_UPDATE, { nodes });
    this.sendMessage(ws, message);
  }

  private sendJobsUpdate(ws: WebSocket): void {
    const jobs = this.getEnrichedJobs();
    const message = createMessage(MessageType.WEB_JOBS_UPDATE, { jobs });
    this.sendMessage(ws, message);
  }

  private sendActiveLibraryScans(ws: WebSocket): void {
    for (const progress of this.activeLibraryScans.values()) {
      this.sendMessage(ws, createMessage(MessageType.WEB_LIBRARY_SCAN_UPDATE, progress));
    }
  }

  // Helper to enrich jobs with file, preset, and node info
  private getEnrichedJobs(): any[] {
    const jobs = this.db.getAllJobs();
    const files = new Map<string, any>();
    const presets = new Map<string, any>();
    const nodes = new Map<string, any>();
    const metadataByFile = new Map<string, any>();

    const enrichedJobs = jobs.map(job => {
      let file = files.get(job.file_id);
      if (!files.has(job.file_id)) {
        file = this.db.getFileById(job.file_id);
        files.set(job.file_id, file);
      }
      let preset = presets.get(job.preset_id);
      if (!presets.has(job.preset_id)) {
        preset = this.db.getPresetById(job.preset_id);
        presets.set(job.preset_id, preset);
      }
      const quickSelect = job.quick_select_id ? this.db.getQuickSelectPresetById(job.quick_select_id) : null;
      let node = null;
      if (job.node_id) {
        node = nodes.get(job.node_id);
        if (!nodes.has(job.node_id)) {
          node = this.db.getNodeById(job.node_id);
          nodes.set(job.node_id, node);
        }
      }

      // Check if this is a library file and get metadata
      let metadata = metadataByFile.get(job.file_id) ?? null;
      if (!metadataByFile.has(job.file_id) && file?.folder_mapping_id) {
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
      metadataByFile.set(job.file_id, metadata);

      // Get codec info from metadata or file
      const codec = metadata?.video_codec || file?.original_codec || '';
      const resolution = metadata?.width && metadata?.height
        ? `${metadata.width}x${metadata.height}`
        : (file?.resolution || '');

      return {
        ...job,
        library_file_id: this.resolveLibraryFileId(job.file_id),
        file_name: file?.relative_path,
        file_size: file?.original_size,
        preset_name: quickSelect ? `Quick Select · ${quickSelect.name}` : preset?.name,
        routed_preset_name: quickSelect ? preset?.name : null,
        job_type: preset?.config?.action === 'analyze' ? 'analyze' : 'transcode',
        encoding_type: preset?.config?.action === 'analyze'
          ? 'cpu'
          : (preset?.config?.encoding_type || 'cpu'),
        node_name: node?.name,
        original_codec: codec,
        resolution: resolution,
        container: metadata?.container || file?.original_format || '',
        duration: metadata?.duration || file?.duration || 0,
        target_codec: preset?.config?.video_codec || '',
        metadata: metadata,
      };
    });

    const fileOperations = this.db.getStorageReclaims(250).map((operation: any) => {
      const cleanupFailed = operation.status === 'backup_retained' && Boolean(operation.error_message);
      const cleanupInProgress = operation.status === 'backup_retained' && Number(operation.progress) < 100 && !cleanupFailed;
      const status = cleanupFailed ? 'failed' : operation.status === 'pending' || cleanupInProgress
        ? 'processing'
        : operation.status === 'failed' ? 'failed' : 'completed';
      const isCleanup = String(operation.current_action || '').toLowerCase().includes('backup')
        && String(operation.current_action || '').toLowerCase().includes('delet');
      return {
        id: `file-operation:${operation.id}`,
        operation_id: operation.id,
        file_id: operation.library_file_id,
        file_operation: true,
        operation: cleanupInProgress || cleanupFailed || isCleanup ? 'cleanup_backup' : operation.operation,
        job_type: 'file_operation',
        status,
        progress: Number(operation.progress || 0),
        current_action: operation.current_action || 'Waiting for node',
        bytes_processed: Number(operation.bytes_processed || 0),
        total_bytes: Number(operation.total_bytes || operation.replacement_size || 0),
        speed_mbps: Number(operation.speed_mbps || 0),
        file_name: operation.filename,
        file_size: Number(operation.original_size || 0),
        preset_name: operation.operation === 'backup_replace' ? 'Backup & Replace' : 'Replace Original',
        node_id: operation.node_id,
        node_name: operation.node_name,
        error_message: operation.error_message,
        created_at: operation.created_at,
        started_at: operation.started_at,
        completed_at: operation.completed_at || operation.reclaimed_at,
      };
    });

    return [...enrichedJobs, ...fileOperations];
  }

  public broadcastNodesUpdate(): void {
    const nodesWithStatus = this.getNodesForClients();

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

  public getNodesForClients(): any[] {
    const nodes = this.db.getAllNodes();
    const connectedNodeIds = this.getConnectedNodeIds();

    // Add connected status to each node (same as API endpoint)
    const nodesWithStatus = nodes.map(node => {
      const activeJobs = Array.from(new Map(
        (node.active_jobs || [])
          .filter(job => {
            const dbJob = this.db.getJobById(job.id);
            return dbJob?.status === 'assigned' || dbJob?.status === 'processing';
          })
          .map(job => [job.id, job]),
      ).values());
      return {
        ...node,
        active_jobs: activeJobs,
        connected: connectedNodeIds.includes(node.id),
      };
    });

    return [...nodesWithStatus, ...this.rejectedNodeRegistrations.values()];
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

  public broadcastLibraryScanUpdate(payload: WebLibraryScanUpdatePayload): void {
    if (payload.status === 'starting' || payload.status === 'scanning') {
      this.activeLibraryScans.set(payload.library_id, payload);
    }

    const message = createMessage(MessageType.WEB_LIBRARY_SCAN_UPDATE, payload);

    for (const [ws, client] of this.webClients) {
      if (client.subscriptions.has('library') && ws.readyState === WebSocket.OPEN) {
        this.sendMessage(ws, message);
      }
    }

    if (payload.status === 'completed' || payload.status === 'error') {
      this.activeLibraryScans.delete(payload.library_id);
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

          // NOW decrement pending assignments and clear GPU device tracking after job status is updated
          // This ensures the job is counted as 'assigned' or 'processing' before we decrement
          const jobAfterUpdate = this.db.getJobById(jobData.job_id);
          if (jobAfterUpdate && (jobAfterUpdate.status === 'processing' || jobAfterUpdate.status === 'assigned')) {
            const pending = this.pendingAssignments.get(nodeId) || 0;
            this.pendingAssignments.set(nodeId, Math.max(0, pending - 1));
            this.logger.info(`[JOB_ASSIGN_ACK] ACK for accepted job ${jobData.job_id}, decremented pending ${pending} -> ${Math.max(0, pending - 1)}`);

            // Keep the GPU reservation until the job completes, fails, or is
            // cancelled. ACK only confirms delivery; it does not free a slot.
          } else {
            this.logger.info(`[JOB_ASSIGN_ACK] ACK received for job ${jobData.job_id}, job status: ${jobAfterUpdate?.status}, pending unchanged`);
          }

          resolve(true);
        },
        reject: (error: Error) => {
          // Decrement pending assignment on failure
          const pending = this.pendingAssignments.get(nodeId) || 0;
          this.pendingAssignments.set(nodeId, Math.max(0, pending - 1));

          this.releaseGpuAssignment(nodeId, jobData.job_id);

          reject(error);
        },
        timeout,
      });

      this.sendMessage(connection.ws, message);
    });
  }

  cancelJob(jobId: string, reason?: string): void {
    const job = this.db.getJobById(jobId);
    if (!job) return;

    if (job.node_id) {
      const message = createMessage('JOB_CANCEL', { job_id: jobId, reason });
      this.sendToNode(job.node_id, message);
    }

    // Cancellation is authoritative in the server database even when the
    // worker disappeared (or an older malformed job never received node_id).
    this.db.cancelJob(jobId);

    const nodeId = job.node_id;
    if (nodeId) {
      // Decrement pending assignment count
      const pending = this.pendingAssignments.get(nodeId) || 0;
      if (pending > 0) {
        this.pendingAssignments.set(nodeId, pending - 1);
        this.logger.info(`[CANCEL] Cleared pending assignment for node ${nodeId}, now ${pending - 1}`);
      }

      this.releaseGpuAssignment(nodeId, jobId);
      this.releaseCpuAssignment(nodeId, jobId);
    }

    // Create job report for cancelled job
    try {
      const job = this.db.getJobById(jobId);
      if (job) {
        const preset = this.db.getPresetById(job.preset_id);
        const nodeRecord = job.node_id ? this.db.getAllNodes().find(n => n.id === job.node_id) : null;
        const isAnalyze = (preset?.config as any)?.action === 'analyze';
        this.logger.info(`[REPORT] Creating cancelled report for job ${jobId}, file_id=${job.file_id}`);
        this.db.createJobReport({
          job_id: jobId,
          file_id: job.file_id,
          library_file_id: this.resolveLibraryFileId(job.file_id),
          node_id: job.node_id ?? null,
          node_name: nodeRecord?.name ?? null,
          job_type: isAnalyze ? 'analyze' : 'transcode',
          preset_id: preset?.id ?? null,
          preset_name: preset?.name ?? null,
          status: 'cancelled',
          error_message: reason ?? 'Cancelled by user',
          started_at: job.started_at ?? null,
          completed_at: Math.floor(Date.now() / 1000),
          config: preset ? JSON.stringify(preset.config) : null,
        });
        this.logger.info(`[REPORT] Successfully created cancelled report for job ${jobId}`);
      } else {
        this.logger.warn(`[REPORT] Job ${jobId} not found, cannot create cancelled report`);
      }
    } catch (err) {
      this.logger.error(`Failed to create report for cancelled job ${jobId}:`, err instanceof Error ? err.message : String(err));
    }
  }

  getConnectedNodeIds(): string[] {
    return Array.from(this.connectionsByNodeId.keys());
  }

  isNodeConnected(nodeId: string): boolean {
    return this.connectionsByNodeId.has(nodeId);
  }

  prepareFullReset(): { cancelledJobs: number; disconnectedWorkers: number } {
    const activeJobs = [
      ...this.db.getAllJobs({ status: 'assigned' }),
      ...this.db.getAllJobs({ status: 'processing' }),
    ];
    for (const job of activeJobs) {
      this.cancelJob(job.id, 'Cancelled by full system reset');
    }

    const workerConnections = Array.from(this.connections.values())
      .filter(connection => Boolean(connection.nodeId));
    for (const connection of workerConnections) {
      connection.ws.close(1012, 'Encorr full reset');
    }

    this.pendingAssignments.clear();
    this.cpuJobReservations.clear();
    this.gpuJobAssignments.clear();
    this.activeLibraryScans.clear();
    this.logger.warn(`[RESET] Cancelled ${activeJobs.length} active job(s) and disconnected ${workerConnections.length} worker(s)`);
    return { cancelledJobs: activeJobs.length, disconnectedWorkers: workerConnections.length };
  }

  sendFileReplaceCommand(
    nodeId: string,
    data: {
      operation_id: string;
      file_id: string;
      operation: 'replace' | 'backup_replace' | 'cleanup_backup';
      source_path: string;
      target_path: string;
      original_filename: string;
    }
  ): boolean {
    const message = createMessage('FILE_REPLACE', data);
    return this.sendToNode(nodeId, message);
  }

  private startPostTranscodeAction(jobId: string): void {
    const job = this.db.getJobById(jobId);
    const operation = job?.post_action;
    if (!job || !job.output_path || !job.node_id || !operation || operation === 'keep') return;

    const libraryFileId = this.resolveLibraryFileId(job.file_id);
    const libraryFile = libraryFileId ? this.db.getLibraryFileById(libraryFileId) : null;
    const library = libraryFile ? this.db.getLibraryById(libraryFile.library_id) : null;
    const file = this.db.getFileById(job.file_id);
    const node = this.db.getNodeById(job.node_id);
    if (!libraryFile || !library || !file || !node) {
      this.logger.error(`[POST_ACTION] Could not resolve replacement paths for job ${jobId}`);
      return;
    }

    let mapping = this.db.getFolderMappingById(file.folder_mapping_id);
    if (mapping?.server_path?.startsWith('library:')) {
      const nodeMapping = this.db.getFolderMappingsByNode(node.id)
        .find(item => item.server_path === `library:${library.id}`);
      if (nodeMapping) mapping = nodeMapping;
    }
    const basePath = mapping?.node_path || library.path;
    const targetPath = /\.(mkv|mp4|avi|mov|webm)$/i.test(basePath)
      ? basePath
      : `${basePath.replace(/[\\/]$/, '')}/${file.relative_path}`;
    let stats: any = {};
    try {
      stats = typeof job.stats === 'string' ? JSON.parse(job.stats || '{}') : (job.stats || {});
    } catch {
      this.logger.warn(`[POST_ACTION] Could not parse completion stats for job ${jobId}`);
    }
    const reclaimId = this.db.createStorageReclaim({
      library_file_id: libraryFile.id,
      library_id: library.id,
      library_name: library.name,
      filename: libraryFile.filename,
      operation,
      original_size: Number(stats.original_size || libraryFile.filesize || 0),
      replacement_size: Number(stats.transcoded_size || 0),
      job_id: job.id,
      node_id: node.id,
      node_name: node.name,
      original_path: targetPath,
      replacement_path: job.output_path,
    });
    const sent = this.sendFileReplaceCommand(node.id, {
      operation_id: reclaimId,
      file_id: libraryFile.id,
      operation,
      source_path: job.output_path,
      target_path: targetPath,
      original_filename: libraryFile.filename,
    });
    if (!sent) {
      this.db.failStorageReplacement(libraryFile.id, operation, 'Node disconnected before automatic post-action was sent');
      this.logger.error(`[POST_ACTION] Node ${node.id} unavailable for job ${jobId}`);
    } else {
      this.logger.info(`[POST_ACTION] Started ${operation} for completed job ${jobId}`);
      this.scheduleWebUpdates();
    }
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
  getWorkerAvailability(): { hasCpuWorkers: boolean; hasGpuWorkers: boolean; cpuWorkersAvailable: number; gpuWorkersAvailable: number; details: any[] } {
    const allNodes = this.db.getAllNodes();
    const onlineNodes = allNodes.filter(n =>
      (n.status === 'online' || n.status === 'busy') && this.isNodeConnected(n.id)
    );

    let totalCpuWorkers = 0;
    let totalGpuWorkers = 0;
    let usedCpuWorkers = 0;
    let usedGpuWorkers = 0;
    const details: any[] = [];

    for (const node of onlineNodes) {
      const maxWorkers = node.max_workers || { cpu: 1, gpus: [] };
      const cpuWorkers = maxWorkers.cpu || 0;
      const gpuWorkers = (maxWorkers.gpus || []).reduce((sum: number, w: number) => sum + w, 0);

      const activeJobs = this.db.getJobsByNode(node.id).filter(
        (j: any) => j.status === 'assigned' || j.status === 'processing'
      );
      const available = this.getAvailableWorkers(node);

      totalCpuWorkers += cpuWorkers;
      totalGpuWorkers += gpuWorkers;
      usedCpuWorkers += Math.max(0, cpuWorkers - available.cpu);
      usedGpuWorkers += Math.max(0, gpuWorkers - available.gpus.reduce((sum, slots) => sum + slots, 0));

      details.push({
        nodeId: node.id,
        nodeName: node.name,
        maxCpuWorkers: cpuWorkers,
        maxGpuWorkers: gpuWorkers,
        availableCpuWorkers: available.cpu,
        availableGpuWorkers: available.gpus.reduce((sum, slots) => sum + slots, 0),
        availableGpuWorkersByDevice: available.gpus,
        activeJobs: activeJobs.length,
      });
    }

    return {
      hasCpuWorkers: totalCpuWorkers > 0,
      hasGpuWorkers: totalGpuWorkers > 0,
      cpuWorkersAvailable: Math.max(0, totalCpuWorkers - usedCpuWorkers),
      gpuWorkersAvailable: Math.max(0, totalGpuWorkers - usedGpuWorkers),
      details,
    };
  }

  // Public method to trigger job assignment immediately
  public assignJobsNow(): void {
    this.logger.info(`[GPU_STATE] Current GPU assignments:`);
    for (const [nodeId] of this.gpuJobAssignments.entries()) {
      const node = this.db.getAllNodes().find(n => n.id === nodeId);
      this.logger.info(`[GPU_STATE]   Node ${node?.name || nodeId} (${nodeId}): ${this.formatGpuAssignments(nodeId)}`);
    }

    this.assignQueuedJobs();
  }

  private scheduleJobAssignment(delayMs = 50): void {
    if (this.jobAssignmentTimer) {
      clearTimeout(this.jobAssignmentTimer);
    }

    this.jobAssignmentTimer = setTimeout(() => {
      this.jobAssignmentTimer = null;
      this.assignJobsNow();
    }, delayMs);
  }

  public scheduleWebUpdates(delayMs = 50): void {
    if (this.webUpdateTimer) {
      clearTimeout(this.webUpdateTimer);
    }

    this.webUpdateTimer = setTimeout(() => {
      this.webUpdateTimer = null;
      this.broadcastJobsUpdate();
      this.broadcastNodesUpdate();
    }, delayMs);
  }

  // Check if a job is an analyze job (CPU-only)
  private isAnalyzeJob(preset: any): boolean {
    return preset?.config?.action === 'analyze';
  }

  private joinNodePath(basePath: string, relativePath: string): string {
    const usesWindowsSeparators = /\\/.test(basePath) || /^[A-Za-z]:/.test(basePath);
    const separator = usesWindowsSeparators ? '\\' : '/';
    const cleanBase = basePath.replace(/[\\/]+$/, '');
    const cleanRelative = relativePath.replace(/^[\\/]+/, '').replace(/[\\/]+/g, separator);
    return cleanRelative ? `${cleanBase}${separator}${cleanRelative}` : cleanBase;
  }

  private getServerFilePath(file: any, sourceMapping: any): string | null {
    if (sourceMapping.server_path?.startsWith('library:')) {
      const libraryId = sourceMapping.server_path.slice('library:'.length);
      const library = this.db.getLibraryById(libraryId);
      return library ? this.joinNodePath(library.path, file.relative_path) : null;
    }
    return this.joinNodePath(sourceMapping.server_path, file.relative_path);
  }

  private resolveMappingForNode(nodeId: string, file: any): { mapping: any; sourcePath: string } | null {
    if (!file?.folder_mapping_id) return null;
    const sourceMapping = this.db.getFolderMappingById(file.folder_mapping_id);
    if (!sourceMapping) return null;

    const nodeMappings = this.db.getFolderMappingsByNode(nodeId);
    if (sourceMapping.server_path?.startsWith('library:')) {
      const libraryMapping = nodeMappings.find(mapping => mapping.server_path === sourceMapping.server_path);
      if (libraryMapping) {
        return {
          mapping: libraryMapping,
          sourcePath: this.joinNodePath(libraryMapping.node_path, file.relative_path),
        };
      }
    }

    const serverFilePath = this.getServerFilePath(file, sourceMapping);
    if (!serverFilePath) return null;
    const normalizedFilePath = serverFilePath.replace(/\\/g, '/');
    const pathMapping = nodeMappings
      .filter(mapping => !mapping.server_path?.startsWith('library:'))
      .map(mapping => ({
        mapping,
        normalizedServerPath: mapping.server_path.replace(/\\/g, '/').replace(/\/+$/, ''),
      }))
      .filter(({ normalizedServerPath }) =>
        normalizedFilePath === normalizedServerPath || normalizedFilePath.startsWith(`${normalizedServerPath}/`)
      )
      .sort((a, b) => b.normalizedServerPath.length - a.normalizedServerPath.length)[0];

    if (!pathMapping) return null;
    const suffix = normalizedFilePath.slice(pathMapping.normalizedServerPath.length);
    return {
      mapping: pathMapping.mapping,
      sourcePath: this.joinNodePath(pathMapping.mapping.node_path, suffix),
    };
  }

  private nodeCanAccessJob(node: any, job: any): boolean {
    const file = this.db.getFileById(job.file_id);
    return Boolean(this.resolveMappingForNode(node.id, file));
  }

  private setQueuedWaitingReason(job: any, nodes: any[], workerType: 'CPU' | 'GPU'): void {
    const connectedNodes = nodes.filter(node => this.isNodeConnected(node.id));
    const mappedNodes = connectedNodes.filter(node => this.nodeCanAccessJob(node, job));
    const reason = mappedNodes.length === 0
      ? 'No accessible folder mapping on any connected node'
      : `Waiting for a compatible ${workerType} slot`;
    if (job.current_action !== reason) this.db.updateJobProgress(job.id, 0, reason);
  }

  private reserveCpuAssignment(nodeId: string, jobId: string): void {
    const reservations = this.cpuJobReservations.get(nodeId) || new Set<string>();
    reservations.add(jobId);
    this.cpuJobReservations.set(nodeId, reservations);
  }

  private releaseCpuAssignment(nodeId: string, jobId: string): void {
    const reservations = this.cpuJobReservations.get(nodeId);
    if (!reservations) return;
    reservations.delete(jobId);
    if (reservations.size === 0) this.cpuJobReservations.delete(nodeId);
  }

  private isJobReserved(jobId: string): boolean {
    for (const reservations of this.cpuJobReservations.values()) {
      if (reservations.has(jobId)) return true;
    }
    for (const nodeAssignments of this.gpuJobAssignments.values()) {
      for (const jobIds of nodeAssignments.values()) {
        if (jobIds.has(jobId)) return true;
      }
    }
    return false;
  }

  private reserveGpuAssignment(nodeId: string, gpuDeviceId: number, jobId: string): void {
    const nodeAssignments = this.gpuJobAssignments.get(nodeId) || new Map<number, Set<string>>();
    const gpuAssignments = nodeAssignments.get(gpuDeviceId) || new Set<string>();
    gpuAssignments.add(jobId);
    nodeAssignments.set(gpuDeviceId, gpuAssignments);
    this.gpuJobAssignments.set(nodeId, nodeAssignments);
  }

  private releaseGpuAssignment(nodeId: string, jobId: string): void {
    const nodeAssignments = this.gpuJobAssignments.get(nodeId);
    if (!nodeAssignments) return;

    for (const [gpuDeviceId, jobIds] of nodeAssignments) {
      if (!jobIds.delete(jobId)) continue;
      this.logger.debug(`[GPU_TRACK] Released job ${jobId} from GPU ${gpuDeviceId} on node ${nodeId}`);
      if (jobIds.size === 0) nodeAssignments.delete(gpuDeviceId);
      break;
    }

    if (nodeAssignments.size === 0) this.gpuJobAssignments.delete(nodeId);
  }

  private getReservedGpuDevice(nodeId: string, jobId: string): number | undefined {
    const nodeAssignments = this.gpuJobAssignments.get(nodeId);
    if (!nodeAssignments) return undefined;

    for (const [gpuDeviceId, jobIds] of nodeAssignments) {
      if (jobIds.has(jobId)) return gpuDeviceId;
    }

    return undefined;
  }

  private formatGpuAssignments(nodeId: string): string {
    const nodeAssignments = this.gpuJobAssignments.get(nodeId);
    if (!nodeAssignments) return 'none';
    return Array.from(nodeAssignments.entries())
      .map(([gpuDeviceId, jobIds]) => `GPU ${gpuDeviceId}: ${jobIds.size}`)
      .join(', ');
  }

  // Get available worker slots for a node
  // Returns available slots per GPU device (index in array = GPU device ID)
  private getAvailableWorkers(node: any): { cpu: number; gpus: number[] } {
    const maxWorkers = node.max_workers || { cpu: 1, gpus: [] };
    const allJobs = this.db.getJobsByNode(node.id);
    const activeJobs = allJobs.filter(
      (j: any) => j.status === 'assigned' || j.status === 'processing'
    );

    // Pending CPU work is tracked by job ID so repeated assignment passes
    // cannot send the same queued job more than once.
    const cpuReservations = this.cpuJobReservations.get(node.id) || new Set<string>();
    // Self-heal reservations whose jobs have already reached a terminal
    // state. This also clears reservations left by an interrupted ACK flow.
    for (const jobId of Array.from(cpuReservations)) {
      const reservedJob = this.db.getJobById(jobId);
      if (!reservedJob || !['queued', 'assigned', 'processing'].includes(reservedJob.status)) {
        cpuReservations.delete(jobId);
      }
    }
    if (cpuReservations.size === 0) this.cpuJobReservations.delete(node.id);

    const reservedGpuJobs = this.gpuJobAssignments.get(node.id) || new Map<number, Set<string>>();

    this.logger.debug(`[WORKERS] Node ${node.name} (${node.id}):`);
    this.logger.debug(`[WORKERS]   max_workers: ${JSON.stringify(maxWorkers)}`);
    this.logger.debug(`[WORKERS]   activeJobs: ${activeJobs.length}, cpuReservations: ${cpuReservations.size}`);
    this.logger.debug(`[WORKERS]   gpuAssignments: ${this.formatGpuAssignments(node.id)}`);

    // Calculate available CPU workers
    const cpuJobs = new Set<string>();
    activeJobs.forEach((job: any) => {
      const preset = this.db.getPresetById(job.preset_id);
      if (preset?.config?.encoding_type !== 'gpu') cpuJobs.add(job.id);
    });
    cpuReservations.forEach(jobId => cpuJobs.add(jobId));
    const availableCpu = Math.max(0, (maxWorkers.cpu || 0) - cpuJobs.size);

    // Calculate available GPU slots per GPU device
    const availableGpus = (maxWorkers.gpus || []).map((maxSlots: number, gpuIndex: number) => {
      // Use job IDs so a job found in both persistent state and the in-memory
      // reservation tracker is counted only once.
      const jobsOnThisGpu = new Set<string>();
      activeJobs.forEach((j: any) => {
        const preset = this.db.getPresetById(j.preset_id);
        if (preset?.config?.encoding_type === 'gpu' && preset?.config?.gpu_device_id === gpuIndex) {
          jobsOnThisGpu.add(j.id);
        }
      });
      (node.active_jobs || []).forEach((j: any) => {
        if (j.gpu === gpuIndex) jobsOnThisGpu.add(j.id || j.job_id);
      });
      (reservedGpuJobs.get(gpuIndex) || new Set<string>()).forEach(jobId => jobsOnThisGpu.add(jobId));

      // Available slots for this GPU
      const available = Math.max(0, maxSlots - jobsOnThisGpu.size);

      this.logger.debug(`[WORKERS]   GPU ${gpuIndex}: max=${maxSlots}, jobs=${jobsOnThisGpu.size}, available=${available}`);

      return available;
    });

    // Detailed logging for active jobs
    if (activeJobs.length > 0) {
      this.logger.debug(`[WORKERS] Active jobs for node ${node.name}:`);
      activeJobs.forEach(j => {
        const preset = this.db.getPresetById(j.preset_id);
        const gpuInfo = preset?.config?.encoding_type === 'gpu'
          ? `, GPU ${preset.config.gpu_device_id ?? 'default'}`
          : ', CPU';
        this.logger.debug(`[WORKERS]   Job ${j.id}: status=${j.status}${gpuInfo}`);
      });
    }

    return {
      cpu: availableCpu,
      gpus: availableGpus,
    };
  }

  private gpuDeviceSupportsPreset(node: any, gpuDeviceId: number, preset: any): boolean {
    const requestedVendor = preset?.config?.gpu_type;
    const requestedCodec = preset?.config?.video_codec;
    if (!requestedVendor || !requestedCodec) return false;

    const gpu = node.system_info?.gpus?.[gpuDeviceId];
    const identity = `${gpu?.vendor || ''} ${gpu?.name || ''}`.toLowerCase();
    const actualVendor = /nvidia|geforce|quadro|tesla/.test(identity)
      ? 'nvidia'
      : /\bamd\b|advanced micro devices|\bradeon\b|\bati\b/.test(identity)
        ? 'amd'
        : /\bintel\b|\barc(?:\(tm\))?\b/.test(identity) ? 'intel' : null;
    if (actualVendor !== requestedVendor) return false;

    const advertisedEncoders = node.system_info?.ffmpeg_encoders;
    return !Array.isArray(advertisedEncoders) || advertisedEncoders.length === 0
      || advertisedEncoders.some((encoder: any) => encoder.available !== false
        && encoder.type === 'gpu'
        && encoder.gpu_type === requestedVendor
        && encoder.codec === requestedCodec);
  }

  // Find an available, vendor-compatible GPU device on a node.
  private findAvailableGpuDevice(node: any, preset?: any): number | null {
    const available = this.getAvailableWorkers(node);
    let bestGpuId: number | null = null;
    let mostFreeSlots = 0;
    for (let gpuId = 0; gpuId < available.gpus.length; gpuId++) {
      const freeSlots = available.gpus[gpuId];
      if (freeSlots <= 0 || (preset && !this.gpuDeviceSupportsPreset(node, gpuId, preset))) continue;
      if (freeSlots > mostFreeSlots) {
        bestGpuId = gpuId;
        mostFreeSlots = freeSlots;
      }
    }
    if (bestGpuId !== null) {
      this.logger.debug(`[GPU_SELECT] Node ${node.name}: Selected GPU ${bestGpuId} with ${mostFreeSlots} available slot(s)`);
    }
    return bestGpuId;
  }

  private resolveQuickSelectRoute(job: any, onlineNodes: any[]): { node: any; preset: any; gpuDeviceId?: number } | null {
    if (!job.quick_select_id) return null;
    const route = this.db.getQuickSelectPresetById(job.quick_select_id);
    if (!route) return null;

    let bestGpuRoute: { node: any; preset: any; gpuDeviceId: number; freeSlots: number; activeJobs: number } | null = null;
    let connectedNodes = 0;
    let mappedNodes = 0;

    if (job.allow_gpu !== false) for (const node of onlineNodes) {
      if (!this.isNodeConnected(node.id)) continue;
      connectedNodes++;
      if (!this.nodeCanAccessJob(node, job)) continue;
      mappedNodes++;

      const available = this.getAvailableWorkers(node);
      const gpus = node.system_info?.gpus || [];
      const activeJobs = this.db.getJobsByNode(node.id).filter(
        (candidate: any) => candidate.status === 'assigned' || candidate.status === 'processing'
      ).length;

      for (let gpuDeviceId = 0; gpuDeviceId < available.gpus.length; gpuDeviceId++) {
        const freeSlots = available.gpus[gpuDeviceId];
        if (freeSlots <= 0) continue;
        const identity = `${gpus[gpuDeviceId]?.vendor || ''} ${gpus[gpuDeviceId]?.name || ''}`.toLowerCase();
        const presetId = identity.includes('nvidia')
          ? route.nvidia_preset_id
          : /\bamd\b|advanced micro devices|\bradeon\b|\bati\b/.test(identity)
            ? route.amd_preset_id
            : /\bintel\b|\barc(?:\(tm\))?\b/.test(identity) ? route.intel_preset_id : null;
        const preset = presetId ? this.db.getPresetById(presetId) : null;
        if (preset?.config?.encoding_type !== 'gpu' || !this.gpuDeviceSupportsPreset(node, gpuDeviceId, preset)) continue;

        if (!bestGpuRoute
          || freeSlots > bestGpuRoute.freeSlots
          || (freeSlots === bestGpuRoute.freeSlots && activeJobs < bestGpuRoute.activeJobs)) {
          bestGpuRoute = { node, preset, gpuDeviceId, freeSlots, activeJobs };
        }
      }
    }

    if (bestGpuRoute) {
      this.logger.debug(`[QUICK_SELECT] Evaluated ${connectedNodes} connected node(s), ${mappedNodes} mapped; selected ${bestGpuRoute.node.name} GPU ${bestGpuRoute.gpuDeviceId} with ${bestGpuRoute.freeSlots} free slot(s)`);
      return {
        node: bestGpuRoute.node,
        preset: bestGpuRoute.preset,
        gpuDeviceId: bestGpuRoute.gpuDeviceId,
      };
    }

    const cpuPreset = route.cpu_preset_id ? this.db.getPresetById(route.cpu_preset_id) : null;
    if (job.allow_cpu !== false && cpuPreset) {
      const node = this.findNodeWithAvailableCpu(onlineNodes, job);
      if (node) return { node, preset: cpuPreset };
    }
    return null;
  }

  private assignQueuedJobs(): void {
    const queuedJobs = this.db.getJobsByStatus('queued').filter(job => {
      if (!job.depends_on_job_id) return true;
      const dependency = this.db.getJobById(job.depends_on_job_id);
      if (dependency?.status === 'completed') return true;
      if (!dependency || dependency.status === 'failed' || dependency.status === 'cancelled') {
        this.db.failJob(job.id, dependency ? `Required analysis ${dependency.status}` : 'Required analysis job was removed');
      }
      return false;
    });
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

    // Log ALL jobs in database for each online node to help debug slot tracking
    for (const node of onlineNodes) {
      const allJobsForNode = this.db.getJobsByNode(node.id);
      const jobsByStatus: Record<string, number> = {};
      allJobsForNode.forEach(j => {
        jobsByStatus[j.status] = (jobsByStatus[j.status] || 0) + 1;
      });
      this.logger.info(`[JOB_ASSIGN] Node ${node.name} (${node.id}) has ${allJobsForNode.length} total jobs: ${JSON.stringify(jobsByStatus)}`);

      // List each job with its GPU assignment if applicable
      allJobsForNode.forEach(j => {
        const preset = this.db.getPresetById(j.preset_id);
        const gpuInfo = preset?.config?.encoding_type === 'gpu' && preset.config.gpu_device_id !== undefined
          ? `, GPU ${preset.config.gpu_device_id}`
          : '';
        this.logger.debug(`[JOB_ASSIGN]   Job ${j.id}: status=${j.status}${gpuInfo}`);
      });
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
          this.releaseGpuAssignment(n.id, job.id);
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
      const nodeWithCpu = this.findNodeWithAvailableCpu(onlineNodes, job);
      if (!nodeWithCpu) {
        // Mapping compatibility is job-specific. One inaccessible file must
        // not block every later analysis job that another CPU worker can read.
        this.setQueuedWaitingReason(job, onlineNodes, 'CPU');
        this.logger.debug(`[ANALYZE_ASSIGN] No mapped CPU capacity for job ${job.id}; leaving only this job queued`);
        continue;
      }

      if (this.assignJobToNodeWithRetry(nodeWithCpu, job, preset)) {
        assignedCount++;
      }
    }

    // Process transcode jobs (can use GPU or CPU)
    for (const { job, preset } of transcodeJobs) {
      if (job.quick_select_id) {
        const route = this.resolveQuickSelectRoute(job, onlineNodes);
        if (!route) {
          this.setQueuedWaitingReason(job, onlineNodes, job.allow_gpu !== false ? 'GPU' : 'CPU');
          this.logger.debug(`[QUICK_SELECT] No compatible capacity currently available for job ${job.id}`);
          continue;
        }
        this.db.updateJobPreset(job.id, route.preset.id);
        job.preset_id = route.preset.id;
        if (this.assignJobToNodeWithRetry(route.node, job, route.preset, route.gpuDeviceId)) {
          assignedCount++;
          this.logger.info(`[QUICK_SELECT] Routed job ${job.id} through ${route.preset.name} on ${route.node.name}`);
        }
        continue;
      }
      // Check if preset uses GPU encoding
      const usesGpu = preset?.config?.encoding_type === 'gpu';

      this.logger.info(`[JOB_ASSIGN_LOOP] Processing job ${job.id}, usesGpu=${usesGpu}, assignedCount=${assignedCount}`);
      this.logger.info(`[GPU_STATE] Before processing job ${job.id}, GPU assignments:`);
      for (const [nodeId] of this.gpuJobAssignments.entries()) {
        this.logger.info(`[GPU_STATE]   Node ${nodeId}: ${this.formatGpuAssignments(nodeId)}`);
      }

      if (usesGpu) {
        // Find node with available GPU workers
        const nodeWithGpu = this.findNodeWithAvailableGpu(onlineNodes, preset, job);
        if (nodeWithGpu) {
          // Log available GPUs on this node BEFORE finding one
          const availableBefore = this.getAvailableWorkers(nodeWithGpu);
          this.logger.info(`[GPU_SELECT] Node ${nodeWithGpu.name} available GPUs: [${availableBefore.gpus.map((slots, i) => `GPU${i}:${slots}`).join(', ')}]`);
          this.logger.info(`[GPU_SELECT] Node ${nodeWithGpu.name} max_workers: ${JSON.stringify(nodeWithGpu.max_workers)}`);

          // Find specific GPU device on this node
          const gpuDeviceId = this.findAvailableGpuDevice(nodeWithGpu, preset);
          this.logger.info(`[GPU_SELECT] Selected GPU device ${gpuDeviceId} for job ${job.id}`);

          if (gpuDeviceId !== null) {
            // Double-check: is this GPU actually available?
            // Re-check availability after selecting to catch race conditions
            const availableAfter = this.getAvailableWorkers(nodeWithGpu);
            if (availableAfter.gpus[gpuDeviceId] <= 0) {
              this.logger.warn(`[GPU_SELECT] GPU ${gpuDeviceId} no longer available (race condition?), skipping job ${job.id}`);
              continue;
            }

            if (this.assignJobToNodeWithRetry(nodeWithGpu, job, preset, gpuDeviceId)) {
              assignedCount++;
              this.logger.info(`[JOB_ASSIGN_LOOP] Job ${job.id} assigned to GPU ${gpuDeviceId}, assignedCount now ${assignedCount}`);
              continue;
            }
          } else {
            this.logger.warn(`[GPU_SELECT] findAvailableGpuDevice returned null for node ${nodeWithGpu.name}`);
          }
        } else {
          this.setQueuedWaitingReason(job, onlineNodes, 'GPU');
          this.logger.debug(`[GPU_SELECT] No compatible ${preset?.config?.gpu_type || 'GPU'} capacity for job ${job.id}; leaving it queued`);
        }
        // Don't fall back to CPU for GPU jobs - keep them queued until GPU is available
        continue;
      }

      // CPU jobs - assign to CPU workers
      const nodeWithCpu = this.findNodeWithAvailableCpu(onlineNodes, job);
      if (nodeWithCpu) {
        if (this.assignJobToNodeWithRetry(nodeWithCpu, job, preset)) {
          assignedCount++;
        }
      } else {
        this.setQueuedWaitingReason(job, onlineNodes, 'CPU');
        this.logger.debug(`[CPU_SELECT] No mapped CPU capacity for job ${job.id}; leaving only this job queued`);
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

  private findNodeWithAvailableCpu(nodes: any[], job?: any): any | null {
    // Find the node with available CPU workers (load balanced)
    let bestNode: any | null = null;
    let maxAvailableCpu = 0;
    let minActiveJobs = Infinity;
    let connectedNodes = 0;
    let mappedNodes = 0;

    this.logger.debug(`[FIND_CPU] Checking ${nodes.length} nodes for available CPU workers`);

    for (const node of nodes) {
      // Skip nodes that are not actually connected (WebSocket disconnected)
      if (!this.isNodeConnected(node.id)) {
        this.logger.debug(`[FIND_CPU] Skipping node ${node.name} (${node.id}) - not connected via WebSocket`);
        continue;
      }
      connectedNodes++;
      if (job && !this.nodeCanAccessJob(node, job)) {
        this.logger.debug(`[FIND_CPU] Skipping node ${node.name} for job ${job.id} - no matching folder mapping`);
        continue;
      }
      mappedNodes++;

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
    } else if (job) {
      this.logger.info(`[CPU_AVAIL] Job ${job.id} awaiting worker: connected_nodes=${connectedNodes}, mapped_nodes=${mappedNodes}, free_cpu_slots=0`);
    }

    return bestNode;
  }

  private findNodeWithAvailableGpu(nodes: any[], preset?: any, job?: any): any | null {
    // Find the node with the MOST available GPU slots (load balancing)
    // When tied, prefer the node with fewer active jobs (better load distribution)
    let bestNode: any | null = null;
    let maxAvailableSlots = 0;
    let minActiveJobs = Infinity;

    for (const node of nodes) {
      // Skip nodes that are not actually connected (WebSocket disconnected)
      if (!this.isNodeConnected(node.id)) {
        this.logger.debug(`[GPU_AVAIL] Skipping node ${node.name} (${node.id}) - not connected via WebSocket`);
        continue;
      }
      if (job && !this.nodeCanAccessJob(node, job)) {
        this.logger.debug(`[GPU_AVAIL] Skipping node ${node.name} for job ${job.id} - no matching folder mapping`);
        continue;
      }

      const available = this.getAvailableWorkers(node);
      const totalGpuSlotsAvailable = available.gpus.reduce((sum: number, slots: number, gpuDeviceId: number) =>
        sum + ((!preset || this.gpuDeviceSupportsPreset(node, gpuDeviceId, preset)) ? slots : 0), 0);

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
    const latestJob = this.db.getJobById(job.id);
    if (latestJob?.status !== 'queued' || this.isJobReserved(job.id)) {
      this.logger.debug(`[JOB_ASSIGN] Skipping ${job.id}; status=${latestJob?.status}, reserved=${this.isJobReserved(job.id)}`);
      return false;
    }

    // Get job details
    const file = this.db.getFileById(job.file_id);
    if (!file) {
      this.logger.warn(`Job ${job.id}: file ${job.file_id} not found`);
      return false;
    }

    const sourceMapping = this.db.getFolderMappingById(file.folder_mapping_id);
    if (!sourceMapping) {
      this.logger.warn(`Job ${job.id}: folder mapping ${file.folder_mapping_id} not found`);
      return false;
    }

    const resolvedMapping = this.resolveMappingForNode(node.id, file);
    if (!resolvedMapping) {
      this.logger.warn(`[NODE_MAPPING] Not assigning job ${job.id} to ${node.name}: no mapping for ${sourceMapping.server_path}`);
      return false;
    }
    const { sourcePath } = resolvedMapping;
    this.logger.info(`[NODE_MAPPING] Job ${job.id} on ${node.name}: ${sourceMapping.server_path} -> ${sourcePath}`);

    // Check if this is an analyze-only job
    const isAnalyzeJob = preset.config?.action === 'analyze';

    // Get file metadata to extract source codec
    let sourceCodec: string | undefined;
    let metadata: any = undefined;

    // For library files, get metadata from library_files table
    if (sourceMapping.server_path?.startsWith('library:')) {
      const serverFilePath = this.getServerFilePath(file, sourceMapping) || '';
      const libFile = serverFilePath ? this.db.getLibraryFileByFilepath(serverFilePath) : undefined;
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

    // Determine destination path (only for transcode jobs, not analyze)
    let destPath: string | undefined;
    if (!isAnalyzeJob) {
      destPath = sourcePath.replace(/\.[^\\/.]+$/, '_enc.mkv');
    }

    this.logger.debug(`Assigning job ${job.id} to node ${node.name} (${node.id})${isAnalyzeJob ? ' (analyze only)' : ''}`);

    // Reserve the specific GPU slot before sending to prevent burst assignment
    // from exceeding the configured per-device worker limit.
    if (enhancedConfig.encoding_type === 'gpu' && enhancedConfig.gpu_device_id !== undefined) {
      this.reserveGpuAssignment(node.id, enhancedConfig.gpu_device_id, job.id);
      this.logger.debug(`[GPU_TRACK] Reserved GPU ${enhancedConfig.gpu_device_id} for job ${job.id} on node ${node.id}`);
    } else {
      this.reserveCpuAssignment(node.id, job.id);
      this.logger.debug(`[CPU_TRACK] Reserved CPU slot for job ${job.id} on node ${node.id}`);
    }

    // Persist dispatch immediately. "assigned" is an active state, so the
    // API/UI and subsequent scheduler passes see the same four occupied slots
    // without waiting for a network acknowledgement.
    this.db.assignJob(job.id, node.id);

    this.assignJobToNode(node.id, {
      job_id: job.id,
      file_id: file.id,
      preset_id: preset.id,
      source_path: sourcePath,
      dest_path: destPath,
      config: enhancedConfig,
    }).catch(error => {
      // Release the reservation on assignment failure.
      if (enhancedConfig.encoding_type === 'gpu' && enhancedConfig.gpu_device_id !== undefined) {
        this.releaseGpuAssignment(node.id, job.id);
        this.logger.warn(`[GPU_TRACK] Released GPU ${enhancedConfig.gpu_device_id} reservation for job ${job.id} after assignment failure`);
      }
      if (this.db.requeueAssignedJob(job.id)) {
        this.logger.warn(`[JOB_ASSIGN] Returned ${job.id} to the queue after delivery failure`);
        this.broadcastJobsUpdate();
        setImmediate(() => this.assignJobsNow());
      }
      this.logger.error(`Failed to assign job ${job.id}:`, error);
    }).finally(() => {
      this.releaseCpuAssignment(node.id, job.id);
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
    if (this.jobAssignmentTimer) {
      clearTimeout(this.jobAssignmentTimer);
      this.jobAssignmentTimer = null;
    }
    if (this.webUpdateTimer) {
      clearTimeout(this.webUpdateTimer);
      this.webUpdateTimer = null;
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
