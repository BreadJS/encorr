import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import type { NodeConfig, SystemInfo, GPUInfo } from '@encorr/shared';
import { createMessage, MessageType } from '@encorr/shared';
import { WebSocketClient } from './client/websocket';
import { Transcoder } from './worker/transcoder';
import { FileAnalyzer } from './worker/file-scanner';
import { GPUMonitor } from './worker/gpu-monitor';
import { getHandBrakeVersion, getFFmpegVersion, getFFprobeVersion } from './handbrake';
import { createLogger } from './utils/logger';
import { loadConfig, type NodeConfigFile } from './config';

// ============================================================================
// Node Options
// ============================================================================

export interface EncorrNodeOptions {
  configPath?: string; // Optional path to config file
}

// ============================================================================
// Active Job State
// ============================================================================

interface ActiveJob {
  id: string;
  sourcePath: string;
  destPath: string;
  config: any;
  progress: number;
  currentAction: string;
}

// ============================================================================
// Encorr Node Class
// ============================================================================

export class EncorrNode {
  private config: NodeConfigFile;
  private logger = createLogger();
  private wsClient: WebSocketClient;
  private transcoder: Transcoder;
  private fileAnalyzer: FileAnalyzer | null = null;
  private gpuMonitor: GPUMonitor;
  private activeJobs: Map<string, ActiveJob> = new Map();
  private cpuMeasureStart: { idle: number; total: number } | null = null;
  private systemInfo!: SystemInfo; // Assigned in start()
  private nodeId?: string;
  private isRunning: boolean = false;
  private systemInfoUpdateInterval: NodeJS.Timeout | null = null;

  constructor(options: EncorrNodeOptions = {}) {
    // Load config from file or use defaults
    this.config = loadConfig();

    // Create WebSocket client
    this.wsClient = new WebSocketClient({
      serverUrl: this.config.getServerUrl(),
      logger: this.logger,
      reconnectInterval: this.config.reconnectInterval,
      heartbeatInterval: this.config.heartbeatInterval,
    });

    // Create transcoder
    this.transcoder = new Transcoder(this.logger);

    // Create GPU monitor
    this.gpuMonitor = new GPUMonitor();

    // Set up event handlers
    this.setupEventHandlers();
  }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Node is already running');
      return;
    }

    this.isRunning = true;

    try {
      // Gather system info before connecting
      this.logger.info('Gathering system information...');
      this.systemInfo = await this.gatherSystemInfo();
      this.logger.info('System info gathered:', {
        os: this.systemInfo.os,
        cpu: this.systemInfo.cpu,
        ram: Math.round(this.systemInfo.ram_total / 1024 / 1024 / 1024) + ' GB',
        gpus: this.systemInfo.gpus?.length || 0,
      });

      // Initialize file analyzer with ffprobe path
      this.fileAnalyzer = new FileAnalyzer(this.systemInfo.ffprobe_path || 'ffprobe', this.logger);

      // Check GPU monitoring availability
      await this.checkGPUMonitoringAvailability();

      // Connect to server
      await this.connectToServer();

      // Start periodic GPU info updates (every 5 seconds)
      this.startPeriodicUpdates();
    } catch (error) {
      this.logger.error('Failed to start node:', error);
      this.isRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping node...');

    this.isRunning = false;

    // Stop periodic updates
    if (this.systemInfoUpdateInterval) {
      clearInterval(this.systemInfoUpdateInterval);
      this.systemInfoUpdateInterval = null;
    }

    // Cancel active jobs
    for (const jobId of this.activeJobs.keys()) {
      this.transcoder.cancelJob(jobId);
    }

    // Disconnect from server
    this.wsClient.disconnect();

    this.logger.info('Node stopped');
  }

  // ========================================================================
  // Server Connection
  // ========================================================================

  private async connectToServer(): Promise<void> {
    const payload = {
      name: this.config.name,
      system_info: this.systemInfo,
      capabilities: {
        max_concurrent_jobs: 1, // Server will control actual concurrency
        supported_containers: ['mp4', 'mkv', 'avi'],
        supported_video_codecs: ['h264', 'h265', 'hevc'],
      },
    };

    await this.wsClient.connect(payload);
  }

  private setupEventHandlers(): void {
    // Connected
    this.wsClient.on('connected', () => {
      this.logger.info('Connected to server');
    });

    // Disconnected
    this.wsClient.on('disconnected', () => {
      this.logger.warn('Disconnected from server');
    });

    // Reconnect
    this.wsClient.on('reconnect', async () => {
      if (!this.isRunning) return;

      this.logger.info(`Attempting to reconnect to ${this.config.getServerUrl()}...`);

      try {
        await this.connectToServer();
      } catch (error) {
        this.logger.error('Reconnection failed:', error);
      }
    });

    // Job assigned
    this.wsClient.on('jobAssigned', async (payload) => {
      await this.handleJobAssigned(payload);
    });

    // Job cancelled
    this.wsClient.on('jobCancelled', (payload) => {
      this.handleJobCancelled(payload);
    });

    // Scan folder - REMOVED: Server now handles scanning
    // Node only processes individual file jobs (analyze/transcode)
    this.wsClient.on('scanFolder', async (payload) => {
      this.logger.warn('Received SCAN_FOLDER message (deprecated). Server should handle scanning.');
    });
  }

  // ========================================================================
  // Job Handling
  // ========================================================================

  private async handleJobAssigned(payload: any): Promise<void> {
    const { job } = payload;
    const jobId = job.id;
    const config = job.config || {};
    const presetConfig = config.handbrake || {};

    this.logger.info(`Job assigned: ${jobId}, action: ${presetConfig.action || 'transcode'}`);

    // Server controls concurrency, so we accept all assigned jobs

    // Validate source file exists
    const { existsSync } = require('fs');
    if (!existsSync(config.source_path)) {
      const errorMsg = `Source file not found: ${config.source_path}`;
      this.logger.error(`Job ${jobId} rejected: ${errorMsg}`);
      this.wsClient.sendJobAccept(jobId, false, errorMsg);
      return;
    }

    // Accept job
    this.wsClient.sendJobAccept(jobId, true);

    // Check if this is an analyze job
    if (presetConfig.action === 'analyze') {
      // Add to active jobs for analyze
      this.activeJobs.set(jobId, {
        id: jobId,
        sourcePath: config.source_path,
        destPath: config.dest_path,
        config: presetConfig,
        progress: 0,
        currentAction: 'Analyzing...',
      });

      // Run analyze job
      this.runAnalyzeJob(jobId, config);
    } else {
      // Add to active jobs for transcode
      this.activeJobs.set(jobId, {
        id: jobId,
        sourcePath: config.source_path,
        destPath: config.dest_path,
        config: presetConfig,
        progress: 0,
        currentAction: 'Starting...',
      });

      // Start transcoding
      this.runJob(jobId, config);
    }
  }

  private async runJob(jobId: string, config: any): Promise<void> {
    const activeJob = this.activeJobs.get(jobId);
    if (!activeJob) return;

    const startTime = Date.now();

    try {
      // Run transcoding
      const result = await this.transcoder.transcode(
        {
          jobId,
          sourcePath: activeJob.sourcePath,
          destPath: activeJob.destPath,
          config: activeJob.config,
          handbrakePath: this.systemInfo.handbrake_path,
          cacheDirectory: this.config.cache_dir,
          tempDirectory: this.config.temp_dir,
        },
        (progress, action, eta) => {
          // Update progress
          activeJob.progress = progress;
          activeJob.currentAction = action;

          // Send to server
          this.wsClient.sendJobProgress(jobId, progress, action, eta);

          this.logger.debug(`Job ${jobId}: ${progress.toFixed(1)}% - ${action}`);
        }
      );

      if (result.success) {
        this.logger.info(`Job ${jobId} completed successfully`);

        this.wsClient.sendJobComplete(jobId, {
          original_size: result.original_size,
          transcoded_size: result.transcoded_size,
          duration_seconds: result.duration_seconds,
          avg_fps: result.avg_fps,
        }, result.output_path);
      } else {
        this.logger.error(`Job ${jobId} failed: ${result.error}`);

        this.wsClient.sendJobError(jobId, result.error || 'Unknown error', false);
      }

    } catch (error) {
      this.logger.error(`Job ${jobId} error:`, error);

      this.wsClient.sendJobError(
        jobId,
        error instanceof Error ? error.message : String(error),
        false
      );
    } finally {
      // Remove from active jobs
      this.activeJobs.delete(jobId);

      // Send heartbeat
      this.sendHeartbeat();
    }
  }

  private async runAnalyzeJob(jobId: string, config: any): Promise<void> {
    const activeJob = this.activeJobs.get(jobId);
    if (!activeJob) return;

    try {
      if (!this.fileAnalyzer) {
        throw new Error('File analyzer not initialized');
      }

      // Update progress to show we're analyzing
      activeJob.progress = 10;
      activeJob.currentAction = 'Analyzing file...';
      this.wsClient.sendJobProgress(jobId, 10, 'Analyzing file...', 0);

      // Analyze the file with ffprobe
      const metadata = await this.fileAnalyzer.analyzeFile(activeJob.sourcePath);

      activeJob.progress = 90;
      activeJob.currentAction = 'Analysis complete';
      this.wsClient.sendJobProgress(jobId, 90, 'Analysis complete', 0);

      this.logger.info(`Job ${jobId} analysis complete: ${JSON.stringify(metadata)}`);

      // Send job complete with metadata
      this.wsClient.sendJobCompleteWithMetadata(jobId, metadata, activeJob.sourcePath);

    } catch (error: any) {
      this.logger.error(`Job ${jobId} analysis error:`, error);

      this.wsClient.sendJobError(
        jobId,
        error instanceof Error ? error.message : String(error),
        false
      );
    } finally {
      // Remove from active jobs
      this.activeJobs.delete(jobId);

      // Send heartbeat
      this.sendHeartbeat();
    }
  }

  private handleJobCancelled(payload: { job_id: string; reason?: string }): void {
    const { job_id, reason } = payload;

    this.logger.info(`Job ${job_id} cancelled: ${reason || 'No reason provided'}`);

    if (this.transcoder.cancelJob(job_id)) {
      this.activeJobs.delete(job_id);
    }

    this.sendHeartbeat();
  }

  // ========================================================================
  // Heartbeat
  // ========================================================================

  private sendHeartbeat(): void {
    const activeJobsArray = Array.from(this.activeJobs.values()).map(job => ({
      job_id: job.id,
      progress: job.progress,
    }));

    const status = this.activeJobs.size > 0 ? 'busy' : 'idle';

    this.wsClient.sendHeartbeat(status, activeJobsArray);
  }

  private startPeriodicUpdates(): void {
    // NOTE: Disabled the 5-second GPU_INFO interval since we're now sending
    // all GPU data (including utilization) via heartbeat every second.
    // The heartbeat already includes fresh GPU data from reportUsage().

    // // Update GPU info every 5 seconds (static info only)
    // this.systemInfoUpdateInterval = setInterval(async () => {
    //   try {
    //     const gpus = await this.detectGPUs();
    //     if (gpus.length > 0) {
    //       this.systemInfo.gpus = gpus;
    //       // Send GPU update to server
    //       this.wsClient.send(createMessage(MessageType.GPU_INFO, { gpus }));
    //     }
    //   } catch (error: any) {
    //     this.logger.warn('Failed to update GPU info:', error.message);
    //   }
    // }, 5000);

    // Update usage data (CPU, RAM, GPU VRAM) every second
    setInterval(async () => {
      if (!this.isRunning || !this.wsClient.connected) {
        return;
      }

      try {
        await this.reportUsage();
      } catch (error: any) {
        this.logger.warn('Failed to report usage:', error?.message || error?.toString());
      }
    }, 1000);
  }

  // ========================================================================
  // System Info
  // ========================================================================

  private async gatherSystemInfo(): Promise<SystemInfo> {
    const si = require('systeminformation');

    // Get CPU, RAM, OS info
    const [cpu, mem, osInfo] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.osInfo(),
    ]);

    // Get GPUs
    const gpus = await this.detectGPUs();

    // Detect HandBrake
    const handbrakePath = this.config.handbrakecli_path;
    if (!existsSync(handbrakePath)) {
      throw new Error(`HandBrakeCLI not found at: ${handbrakePath}. Please update handbrakecli_path in node_config.json`);
    }
    const handbrakeVersion = getHandBrakeVersion(handbrakePath);

    // Detect FFmpeg and FFprobe
    const ffmpegDir = this.config.ffmpeg_dir;
    const ffmpegExe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const ffprobeExe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';

    const ffmpegPath = join(ffmpegDir, ffmpegExe);
    const ffprobePath = join(ffmpegDir, ffprobeExe);

    if (!existsSync(ffmpegPath)) {
      throw new Error(`FFmpeg not found at: ${ffmpegPath}. Please update ffmpeg_dir in node_config.json`);
    }
    if (!existsSync(ffprobePath)) {
      throw new Error(`FFprobe not found at: ${ffprobePath}. Please update ffmpeg_dir in node_config.json`);
    }

    const ffmpegVersion = getFFmpegVersion(ffmpegPath) || undefined;
    const ffprobeVersion = getFFprobeVersion(ffprobePath) || undefined;

    return {
      os: osInfo.platform,
      os_version: osInfo.release,
      cpu: cpu.manufacturer + ' ' + cpu.brand || cpu.model || 'Unknown',
      cpu_cores: cpu.cores,
      ram_total: mem.total,
      gpus: gpus.length > 0 ? gpus : undefined,
      handbrake_version: handbrakeVersion || undefined,
      handbrake_path: handbrakePath,
      ffmpeg_version: ffmpegVersion,
      ffmpeg_path: existsSync(ffmpegPath) ? ffmpegPath : '',
      ffprobe_path: existsSync(ffprobePath) ? ffprobePath : '',
    };
  }

  private async reportUsage(): Promise<void> {
    const si = require('systeminformation');

    try {
      // Get CPU usage using os module (simple approach)
      // Get CPU usage using os module (standard Stack Overflow approach)
      const cpus = os.cpus();
      let totalIdle = 0;
      let totalTick = 0;

      cpus.forEach((core) => {
        const times = core.times;
        totalTick += times.user + times.nice + times.sys + times.idle + times.irq;
        totalIdle += times.idle;
      });

      const currentMeasure = { idle: totalIdle, total: totalTick };

      let cpuPercent = 0;
      if (this.cpuMeasureStart) {
        const idleDiff = currentMeasure.idle - this.cpuMeasureStart.idle;
        const totalDiff = currentMeasure.total - this.cpuMeasureStart.total;

        if (totalDiff > 0) {
          cpuPercent = 100 - Math.floor((100 * idleDiff) / totalDiff);
          cpuPercent = Math.max(0, Math.min(100, cpuPercent));
        }
      }

      this.cpuMeasureStart = currentMeasure; // Update for next iteration

      // Get current memory usage (using systeminformation - reasonably fast)
      const mem = await si.mem();
      const ramPercent = Math.round((mem.used / mem.total) * 100);

      // Get GPU usage data using vendor-specific tools (nvidia-smi, AMD sysfs)
      // nvidia-smi is very fast (~50ms) so we call it every second, no caching needed
      let gpuData: any[] | undefined;

      if (this.systemInfo.gpus && this.systemInfo.gpus.length > 0) {
        try {
          const gpuUsageMap = await this.gpuMonitor.getGPUUsage(this.systemInfo.gpus);

          if (gpuUsageMap.size > 0) {
            gpuData = [];

            // Convert Map to array in GPU order
            for (let i = 0; i < this.systemInfo.gpus.length; i++) {
              const usage = gpuUsageMap.get(i);
              if (usage) {
                gpuData.push(usage);
              }
            }

            // Debug: Log every 10 seconds to avoid spam
            if (Math.floor(Date.now() / 10000) % 2 === 0) {
              this.logger.debug(`GPU data: ${JSON.stringify(gpuData)}`);
            }
          } else {
            this.logger.warn('GPU monitor returned empty map');
          }
        } catch (error) {
          this.logger.warn('Failed to get GPU usage:', error);
        }
      }

      // Send usage update via heartbeat with system_load and GPU data
      this.wsClient.sendHeartbeat(
        this.activeJobs.size > 0 ? 'busy' : 'idle',
        Array.from(this.activeJobs.values()).map(job => ({
          job_id: job.id,
          progress: job.progress,
        })),
        cpuPercent,
        ramPercent,
        gpuData
      );
    } catch (error: any) {
      this.logger.warn('Error in reportUsage:', error?.message || error?.toString());
      throw error;
    }
  }

  private async detectGPUs(): Promise<GPUInfo[]> {
    const si = require('systeminformation');

    this.logger.info('Detecting GPUs...');
    const gpus: GPUInfo[] = [];

    try {
      const graphics = await si.graphics();

      // Process controllers (GPUs)
      if (graphics.controllers && graphics.controllers.length > 0) {
        for (let i = 0; i < graphics.controllers.length; i++) {
          const controller = graphics.controllers[i];

          // Skip virtual displays
          if (this.isVirtualDisplay(controller.model || '')) {
            this.logger.debug(`Skipping virtual display: ${controller.model}`);
            continue;
          }

          // Skip integrated graphics (Intel HD, AMD integrated, etc.)
          if (this.isIntegratedGPU(controller)) {
            this.logger.debug(`Skipping integrated GPU: ${controller.model || controller.name || 'Unknown'}`);
            continue;
          }

          const vramMB = controller.vram;
          // systeminformation returns VRAM in megabytes (MB), not bytes
          const vramFreeMB = (controller as any).memoryFree;
          const vramUsedMB = (controller as any).memoryUsed;

          // Capture utilization metrics
          const utilizationGpu = (controller as any).utilizationGpu;
          const utilizationMemory = (controller as any).utilizationMemory;
          const temperatureGpu = (controller as any).temperatureGpu;
          const powerDraw = (controller as any).powerDraw;
          const powerLimit = (controller as any).powerLimit;
          const clockCore = (controller as any).clockCore;
          const clockMemory = (controller as any).clockMemory;

          gpus.push({
            name: controller.model || 'Unknown GPU',
            vendor: controller.vendor || this.getGPUVendor(controller.model || ''),
            memory: vramMB ? vramMB * 1024 * 1024 : undefined, // Convert MB to bytes
            memoryFree: vramFreeMB ? vramFreeMB * 1024 * 1024 : undefined, // Convert MB to bytes
            memoryUsed: vramUsedMB ? vramUsedMB * 1024 * 1024 : undefined, // Convert MB to bytes
            driver_version: controller.driverVersion,
            utilizationGpu,
            utilizationMemory,
            temperatureGpu,
            powerDraw,
            powerLimit,
            clockCore,
            clockMemory,
          });
        }
      }

      this.logger.info(`Detected ${gpus.length} GPU(s)`);
    } catch (error: any) {
      this.logger.error('GPU detection failed:', error?.message || error);
    }

    return gpus;
  }

  private async checkGPUMonitoringAvailability(): Promise<void> {
    if (!this.systemInfo.gpus || this.systemInfo.gpus.length === 0) {
      return;
    }

    const hasNvidia = this.systemInfo.gpus.some(gpu =>
      gpu.vendor?.toLowerCase().includes('nvidia') || gpu.name?.toLowerCase().includes('nvidia')
    );
    const hasAmd = this.systemInfo.gpus.some(gpu =>
      gpu.vendor?.toLowerCase().includes('amd') || gpu.name?.toLowerCase().includes('amd') ||
      gpu.vendor?.toLowerCase().includes('ati') || gpu.name?.toLowerCase().includes('radeon')
    );

    const methods: string[] = [];

    if (hasNvidia) {
      const nvidiaAvailable = await GPUMonitor.isNvidiaAvailable();
      if (nvidiaAvailable) {
        methods.push('nvidia-smi (NVIDIA GPUs)');
      }
    }

    if (hasAmd && process.platform === 'linux') {
      const amdAvailable = await GPUMonitor.isAmdAvailable();
      if (amdAvailable) {
        methods.push('sysfs (AMD GPUs)');
      }
    }

    if (methods.length > 0) {
      this.logger.info(`GPU monitoring enabled using: ${methods.join(', ')}`);
    } else {
      this.logger.warn('GPU monitoring disabled - no vendor tools available (nvidia-smi or AMD sysfs)');
    }
  }

  private isVirtualDisplay(name: string): boolean {
    const virtualDisplayPatterns = [
      /virtual/i,
      /parsec/i,
      /meta/i,
      /rdp/i,
      /remote/i,
      /teamviewer/i,
      /citrix/i,
      /microsoft basic display/i,
      /wireless display/i,
    ];
    return virtualDisplayPatterns.some(pattern => pattern.test(name));
  }

  private isIntegratedGPU(gpu: any): boolean {
    const name = (gpu.model || gpu.name || '').toLowerCase();
    const vendor = (gpu.vendor || '').toLowerCase();

    // Intel integrated graphics - ALL Intel GPUs are integrated
    if (vendor.includes('intel')) {
      return true;
    }

    // AMD integrated graphics detection
    // Check for AMD/ATI in vendor OR "advanced" (for "Advanced Micro Devices, Inc.")
    if (vendor.includes('amd') || vendor.includes('ati') || vendor.includes('radeon') || vendor.includes('advanced')) {
      // Remove special characters like (TM), (R), etc. then normalize whitespace
      const cleanName = name.replace(/[™®©\(tm\)\(r\)\(c\)]/gi, '').replace(/\s+/g, ' ').trim();

      // Pattern 1: Generic "Radeon Graphics" or "AMD Radeon Graphics" (no model number = integrated)
      // e.g., "AMD Radeon Graphics" or "AMD Radeon(TM) Graphics" -> "AMD Radeon Graphics"
      if (/^(amd\s+)?radeon\s+graphics$/.test(cleanName)) {
        return true;
      }

      // Pattern 2: Very low VRAM (integrated typically < 2GB, discrete typically >= 4GB)
      // gpu.vram is already in MB from systeminformation
      const vramMB = gpu.vram;
      if (vramMB && vramMB < 2048) {
        return true;
      }

      // Pattern 3: Contains "integrated" in name
      if (name.includes('integrated')) {
        return true;
      }
    }

    return false;
  }

  private getGPUVendor(name: string): string {
    const lowerName = name.toLowerCase();
    if (lowerName.includes('nvidia') || lowerName.includes('geforce') || lowerName.includes('quadro') || lowerName.includes('tesla')) {
      return 'NVIDIA';
    }
    if (lowerName.includes('amd') || lowerName.includes('radeon') || lowerName.includes('ati')) {
      return 'AMD';
    }
    if (lowerName.includes('intel')) {
      return 'Intel';
    }
    if (lowerName.includes('apple') || lowerName.includes('m1') || lowerName.includes('m2') || lowerName.includes('m3')) {
      return 'Apple';
    }
    return 'Unknown';
  }

  // ========================================================================
  // Public Getters
  // ========================================================================

  get connected(): boolean {
    return this.wsClient.connected;
  }

  get activeJobsCount(): number {
    return this.activeJobs.size;
  }
}
