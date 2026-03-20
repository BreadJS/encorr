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
import {
  getFFmpegVersion,
  getFFprobeVersion,
  detectAvailableEncoders,
  detectAvailableDecoders,
  detectAvailableHwaccels
} from './ffmpeg';
import { createLogger } from './utils/logger';
import { loadConfig, type NodeConfigFile } from './config';

// ============================================================================
// Helper Functions
// ============================================================================

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

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
  fps?: number;
  ratio?: string;
  eta?: number;
  gpu?: number;
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
    const presetConfig = config.ffmpeg || {};

    this.logger.info(`[JOB_ASSIGN] Job assigned: ${jobId}`);
    this.logger.info(`[JOB_ASSIGN]   full config: ${JSON.stringify(config, null, 2)}`);
    this.logger.info(`[JOB_ASSIGN]   preset config: ${JSON.stringify(presetConfig, null, 2)}`);
    this.logger.info(`[JOB_ASSIGN]   action: ${presetConfig.action || 'transcode'}`);
    this.logger.info(`[JOB_ASSIGN]   source: ${config.source_path}`);
    this.logger.info(`[JOB_ASSIGN]   dest: ${config.dest_path}`);

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

    // Determine GPU index from gpu_type (0-based internally, +1 for display)
    let gpuIndex: number | undefined = undefined;
    if (presetConfig.encoding_type === 'gpu' && presetConfig.gpu_type) {
      if (presetConfig.gpu_type === 'nvidia') gpuIndex = 0;  // GPU 1 for display
      else if (presetConfig.gpu_type === 'intel') gpuIndex = 1; // GPU 2 for display
      else if (presetConfig.gpu_type === 'amd') gpuIndex = 2;   // GPU 3 for display
    }

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
        gpu: gpuIndex,
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
        gpu: gpuIndex,
      });

      // Start transcoding
      this.runJob(jobId, config);
    }
  }

  private async runJob(jobId: string, config: any): Promise<void> {
    const activeJob = this.activeJobs.get(jobId);
    if (!activeJob) return;

    const startTime = Date.now();

    this.logger.info(`[JOB_START] Starting transcoding job ${jobId}`);
    this.logger.info(`[JOB_START]   source: ${activeJob.sourcePath}`);
    this.logger.info(`[JOB_START]   output: ${activeJob.destPath}`);
    this.logger.info(`[JOB_START]   config: ${JSON.stringify(activeJob.config)}`);

    try {
      // Run transcoding
      const result = await this.transcoder.transcode(
        {
          jobId,
          sourcePath: activeJob.sourcePath,
          destPath: activeJob.destPath,
          config: activeJob.config,
          ffmpegPath: this.systemInfo.ffmpeg_path || '',
          cacheDirectory: this.config.cache_dir,
          tempDirectory: this.config.temp_dir,
          availableEncoders: this.systemInfo.ffmpeg_encoders,
        },
        (progress, action, eta, fps, ratio) => {
          // Update progress - ALWAYS update fps, eta, and ratio (including undefined)
          // The transcoder now accumulates values, so we trust what it sends
          activeJob.progress = progress;
          activeJob.currentAction = action;
          activeJob.fps = fps;  // Always update (undefined is valid - means no FPS data yet)
          activeJob.eta = eta;  // Always update (undefined is valid - means no ETA data yet)
          activeJob.ratio = ratio;  // Always update (undefined is valid - means no ratio data yet)

          // Send to server
          this.wsClient.sendJobProgress(jobId, progress, action, eta, fps, ratio);

          // Log progress updates (every 10% or on action change to reduce spam)
          if (Math.floor(progress) % 10 === 0 || progress === 0) {
            const etaFormatted = eta ? formatDuration(eta) : undefined;
            this.logger.info(`[PROGRESS] Job ${jobId}: ${progress.toFixed(1)}% - ${action}${fps ? ` @ ${fps.toFixed(1)} fps` : ''}${ratio ? ` (Ratio: ${ratio})` : ''}${etaFormatted ? ` (ETA: ${etaFormatted})` : ''}`);
          }
        }
      );

      if (result.success) {
        this.logger.info(`[JOB_COMPLETE] Job ${jobId} completed successfully`);
        this.logger.info(`[JOB_COMPLETE]   original: ${result.original_size} bytes`);
        this.logger.info(`[JOB_COMPLETE]   transcoded: ${result.transcoded_size} bytes`);
        this.logger.info(`[JOB_COMPLETE]   duration: ${result.duration_seconds.toFixed(1)}s`);
        this.logger.info(`[JOB_COMPLETE]   avg_fps: ${result.avg_fps || 'N/A'}`);
        this.logger.info(`[JOB_COMPLETE]   output_path: ${result.output_path}`);

        this.wsClient.sendJobComplete(jobId, {
          original_size: result.original_size,
          transcoded_size: result.transcoded_size,
          duration_seconds: result.duration_seconds,
          avg_fps: result.avg_fps,
        }, result.output_path);
      } else {
        // Check if this was a user cancellation
        const isCancelled = result.error === 'Cancelled by user';
        if (isCancelled) {
          this.logger.info(`[JOB_CANCELLED] Job ${jobId} was cancelled by user`);
        } else {
          this.logger.error(`[JOB_ERROR] Job ${jobId} failed: ${result.error}`);
        }

        this.wsClient.sendJobError(jobId, result.error || 'Unknown error', false);
      }

    } catch (error) {
      // Check if this was a cancellation
      const isCancelled = error instanceof Error && error.message === 'CANCELLED';
      if (isCancelled) {
        this.logger.info(`[JOB_CANCELLED] Job ${jobId} was cancelled`);
      } else {
        this.logger.error(`[JOB_ERROR] Job ${jobId} error:`, error);
      }

      this.wsClient.sendJobError(
        jobId,
        isCancelled ? 'Cancelled by user' : (error instanceof Error ? error.message : String(error)),
        false
      );
    } finally {
      // Remove from active jobs
      this.activeJobs.delete(jobId);
      this.logger.info(`[JOB_CLEANUP] Job ${jobId} removed from active jobs`);

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
      file_name: job.sourcePath ? job.sourcePath.split(/[/\\]/).pop() || 'Unknown' : 'Unknown',
      progress: job.progress,
      current_action: job.currentAction,
      fps: job.fps,
      ratio: job.ratio,
      eta: job.eta,
      gpu: job.gpu,
    }));

    const status = this.activeJobs.size > 0 ? 'busy' : 'idle';

    // Log heartbeat details
    this.logger.debug(`[HEARTBEAT] Sending: status=${status}, active_jobs_count=${activeJobsArray.length}`);
    if (activeJobsArray.length > 0) {
      activeJobsArray.forEach(job => {
        this.logger.debug(`[HEARTBEAT]   job=${job.job_id}, progress=${job.progress?.toFixed(1)}%, action=${job.current_action}, fps=${job.fps}, eta=${job.eta}, ratio=${job.ratio}, gpu=${job.gpu}`);
      });
    }

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

    // Detect available FFmpeg encoders, decoders, and hwaccels
    const ffmpegEncoders = await detectAvailableEncoders(ffmpegPath);
    const ffmpegDecoders = await detectAvailableDecoders(ffmpegPath);
    const ffmpegHwaccels = await detectAvailableHwaccels(ffmpegPath);

    // Log hardware detection results
    this.logger.info(`[HW_DETECTION] Encoders: ${ffmpegEncoders.map(e => `${e.encoder_name} (${e.type}${e.gpu_type ? ':' + e.gpu_type : ''})`).join(', ') || 'none'}`);
    this.logger.info(`[HW_DETECTION] Decoders: ${ffmpegDecoders.filter(d => d.type === 'gpu').map(d => `${d.decoder_name} (${d.gpu_type})`).join(', ') || 'none (CPU only)'}`);
    this.logger.info(`[HW_DETECTION] Hwaccels: ${ffmpegHwaccels.filter(h => h.available).map(h => h.name).join(', ') || 'none'}`);

    return {
      os: osInfo.platform,
      os_version: osInfo.release,
      cpu: cpu.manufacturer + ' ' + cpu.brand || cpu.model || 'Unknown',
      cpu_cores: cpu.cores,
      ram_total: mem.total,
      gpus: gpus.length > 0 ? gpus : undefined,
      ffmpeg_version: ffmpegVersion,
      ffmpeg_path: existsSync(ffmpegPath) ? ffmpegPath : '',
      ffprobe_path: existsSync(ffprobePath) ? ffprobePath : '',
      ffmpeg_encoders: ffmpegEncoders.length > 0 ? ffmpegEncoders : undefined,
      ffmpeg_decoders: ffmpegDecoders.length > 0 ? ffmpegDecoders : undefined,
      ffmpeg_hwaccels: ffmpegHwaccels.length > 0 ? ffmpegHwaccels : undefined,
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

            // Detailed GPU logging - log every 10 seconds
            const shouldLog = Math.floor(Date.now() / 10000) % 2 === 0;
            if (shouldLog) {
              this.logger.debug(`[GPU] GPU usage data: ${JSON.stringify(gpuData)}`);
            }
          } else {
            // Only warn occasionally
            if (Math.floor(Date.now() / 30000) % 2 === 0) {
              this.logger.warn('[GPU] GPU monitor returned empty map');
            }
          }
        } catch (error) {
          this.logger.warn('[GPU] Failed to get GPU usage:', error);
        }
      }

      // Send usage update via heartbeat with system_load and GPU data
      // Include ALL job data (fps, eta, etc.) to preserve rich progress information
      this.wsClient.sendHeartbeat(
        this.activeJobs.size > 0 ? 'busy' : 'idle',
        Array.from(this.activeJobs.values()).map(job => ({
          job_id: job.id,
          progress: job.progress,
          current_action: job.currentAction,
          fps: job.fps,
          eta: job.eta,
          ratio: job.ratio,
          gpu: job.gpu,
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
