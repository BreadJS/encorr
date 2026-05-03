import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { promisify } from 'util';
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

  // ====== QUEUE ADDITIONS ======
  private jobQueue: Array<{ jobId: string; config: any; presetConfig: any }> = [];
  private isProcessingQueue: boolean = false;
  // =============================

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

    // Clear local queue
    this.jobQueue = [];

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

    // File replace
    this.wsClient.on('fileReplace', async (payload) => {
      await this.handleFileReplace(payload);
    });
  }

  // ========================================================================
  // Job Handling & Queue Processing
  // ========================================================================

  private async handleJobAssigned(payload: any): Promise<void> {
    const { job } = payload;
    const jobId = job.id;
    const config = job.config || {};
    const presetConfig = config.ffmpeg || {};

    // ====== START OF OVERRIDE ======
    // Intercept the server's config and force it to match our actual hardware
    if (presetConfig.encoding_type === 'gpu') {
      const hasNvidia = this.systemInfo.gpus?.some(g => g.vendor.toLowerCase().includes('nvidia'));
      const hasAmd = this.systemInfo.gpus?.some(g => g.vendor.toLowerCase().includes('amd'));

      if (presetConfig.gpu_type === 'nvidia' && !hasNvidia && hasAmd) {
        this.logger.warn(`[OVERRIDE] Server assigned an NVIDIA job, but this node only has AMD. Forcing AMD parameters!`);
        presetConfig.gpu_type = 'amd'; // This forces buildFFmpegArgs to use VAAPI/AMF instead of NVENC
      }
    }
    // ====== END OF OVERRIDE ======

    this.logger.info(`[JOB_ASSIGN] Job assigned: ${jobId}`);
    this.logger.info(`[JOB_ASSIGN]   encoding_type: ${presetConfig.encoding_type}`);
    this.logger.info(`[JOB_ASSIGN]   gpu_type: ${presetConfig.gpu_type}`);
    this.logger.info(`[JOB_ASSIGN]   gpu_device_id: ${presetConfig.gpu_device_id}`);
    this.logger.info(`[JOB_ASSIGN]   action: ${presetConfig.action || 'transcode'}`);
    this.logger.info(`[JOB_ASSIGN]   source: ${config.source_path}`);
    this.logger.info(`[JOB_ASSIGN]   dest: ${config.dest_path}`);

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

    // Use gpu_device_id from server
    let gpuIndex: number | undefined = undefined;
    if (presetConfig.encoding_type === 'gpu' && presetConfig.gpu_device_id !== undefined) {
      gpuIndex = presetConfig.gpu_device_id;
      this.logger.info(`[JOB_ASSIGN] Using GPU device ${gpuIndex} (from server assignment)`);
    } else if (presetConfig.encoding_type === 'gpu' && presetConfig.gpu_type) {
      if (presetConfig.gpu_type === 'nvidia') gpuIndex = 0;
      else if (presetConfig.gpu_type === 'intel') gpuIndex = 1;
      else if (presetConfig.gpu_type === 'amd') gpuIndex = 2;
      this.logger.warn(`[JOB_ASSIGN] No gpu_device_id provided, using fallback GPU ${gpuIndex} from gpu_type`);
    }

    // Add to active jobs in a "Queued" state
    this.activeJobs.set(jobId, {
      id: jobId,
      sourcePath: config.source_path,
      destPath: config.dest_path,
      config: presetConfig,
      progress: 0,
      currentAction: 'Queued',
      gpu: gpuIndex,
    });

    // ====== QUEUE ADDITION ======
    // Push into our local queue and attempt to process
    this.jobQueue.push({ jobId, config, presetConfig });
    this.logger.info(`[QUEUE] Job ${jobId} added to local queue. Current queue length: ${this.jobQueue.length}`);
    
    this.processQueue();
  }

  // ====== QUEUE PROCESSOR ======
  private async processQueue(): Promise<void> {
    // If we're already looping through jobs, don't start a second loop
    if (this.isProcessingQueue || this.jobQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      // Loop while there are jobs in the queue
      while (this.jobQueue.length > 0) {
        const nextJob = this.jobQueue.shift();
        if (!nextJob) continue;

        const { jobId, config, presetConfig } = nextJob;
        const activeJob = this.activeJobs.get(jobId);

        // If the job was cancelled while waiting in the queue, skip it
        if (!activeJob) continue;

        if (presetConfig.action === 'analyze') {
          activeJob.currentAction = 'Analyzing...';
          // AWAIT ensures the node waits for analysis to finish before grabbing the next queue item
          await this.runAnalyzeJob(jobId, config);
        } else {
          activeJob.currentAction = 'Starting...';
          // AWAIT ensures the node waits for transcoding to finish before grabbing the next queue item
          await this.runJob(jobId, config);
        }
      }
    } finally {
      // Done processing all queued jobs
      this.isProcessingQueue = false;
    }
  }
  // =============================

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
          activeJob.progress = progress;
          activeJob.currentAction = action;
          activeJob.fps = fps;  
          activeJob.eta = eta;  
          activeJob.ratio = ratio; 

          // Send to server
          this.wsClient.sendJobProgress(jobId, progress, action, eta, fps, ratio);

          // Log progress updates
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
        }, result.output_path, result.ffmpeg_logs, result.decoder_info);
      } else {
        const isCancelled = result.error === 'Cancelled by user';
        if (isCancelled) {
          this.logger.info(`[JOB_CANCELLED] Job ${jobId} was cancelled by user`);
        } else {
          this.logger.error(`[JOB_ERROR] Job ${jobId} failed: ${result.error}`);
        }

        this.wsClient.sendJobError(jobId, result.error || 'Unknown error', false, result.ffmpeg_logs);
      }

    } catch (error) {
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

      activeJob.progress = 10;
      activeJob.currentAction = 'Analyzing file...';
      this.wsClient.sendJobProgress(jobId, 10, 'Analyzing file...', 0);

      const metadata = await this.fileAnalyzer.analyzeFile(activeJob.sourcePath);

      activeJob.progress = 90;
      activeJob.currentAction = 'Analysis complete';
      this.wsClient.sendJobProgress(jobId, 90, 'Analysis complete', 0);

      this.logger.info(`Job ${jobId} analysis complete: ${JSON.stringify(metadata)}`);

      this.wsClient.sendJobCompleteWithMetadata(jobId, metadata, activeJob.sourcePath);

    } catch (error: any) {
      this.logger.error(`Job ${jobId} analysis error:`, error);

      this.wsClient.sendJobError(
        jobId,
        error instanceof Error ? error.message : String(error),
        false
      );
    } finally {
      this.activeJobs.delete(jobId);
      this.sendHeartbeat();
    }
  }

  private handleJobCancelled(payload: { job_id: string; reason?: string }): void {
    const { job_id, reason } = payload;

    this.logger.info(`Job ${job_id} cancelled: ${reason || 'No reason provided'}`);

    // ====== QUEUE CANCEL FIX ======
    // Check if the job is still waiting in the local queue
    const queueIndex = this.jobQueue.findIndex(j => j.jobId === job_id);
    if (queueIndex !== -1) {
      this.jobQueue.splice(queueIndex, 1);
      this.activeJobs.delete(job_id);
      this.logger.info(`[QUEUE] Job ${job_id} was removed from the wait queue before starting.`);
      this.sendHeartbeat();
      return; 
    }
    // ==============================

    // If it's not in the queue, it must be running. Try to cancel it in the transcoder.
    if (this.transcoder.cancelJob(job_id)) {
      this.activeJobs.delete(job_id);
    }

    this.sendHeartbeat();
  }

  private async handleFileReplace(payload: {
    file_id: string;
    operation: 'replace' | 'backup_replace' | 'cleanup_backup';
    source_path: string;
    target_path: string;
    original_filename: string;
  }): Promise<void> {
    const { file_id, operation, source_path, target_path, original_filename } = payload;

    this.logger.info(`[FILE_REPLACE] ${operation} for file ${file_id}: ${original_filename}`);
    this.logger.info(`[FILE_REPLACE]   source: ${source_path}`);
    this.logger.info(`[FILE_REPLACE]   target: ${target_path}`);

    try {
      const { promises: fs } = require('fs');
      const { resolve, dirname } = require('path');

      // Verify source file exists (for replace operations)
      if (operation === 'replace' || operation === 'backup_replace') {
        const sourceExists = await fs.access(source_path).then(() => true).catch(() => false);
        if (!sourceExists) {
          throw new Error(`Source file not found: ${source_path}`);
        }
      }

      // Verify target file exists (for cleanup operations)
      if (operation === 'cleanup_backup') {
        const targetExists = await fs.access(target_path).then(() => true).catch(() => false);
        if (!targetExists) {
          throw new Error(`Backup file not found: ${target_path}`);
        }
      }

      // Perform the operation
      if (operation === 'replace') {
        await fs.rename(source_path, target_path);
        this.logger.info(`[FILE_REPLACE] Replaced original file with transcoded version`);
      } else if (operation === 'backup_replace') {
        const backupPath = target_path + '.org';
        const backupExists = await fs.access(backupPath).then(() => true).catch(() => false);
        if (backupExists) {
          this.logger.warn(`[FILE_REPLACE] Backup file already exists: ${backupPath}, skipping backup creation`);
          await fs.unlink(backupPath);
        }

        await fs.rename(target_path, backupPath);
        this.logger.info(`[FILE_REPLACE] Backed up original to: ${backupPath}`);
        await fs.rename(source_path, target_path);
        this.logger.info(`[FILE_REPLACE] Moved transcoded file to: ${target_path}`);
      } else if (operation === 'cleanup_backup') {
        await fs.unlink(target_path);
        this.logger.info(`[FILE_REPLACE] Deleted backup file: ${target_path}`);
      }

      this.wsClient.send(createMessage('FILE_REPLACE_RESULT', {
        file_id: file_id,
        operation: operation,
        success: true,
        new_file_path: target_path,
      }));

      this.logger.info(`[FILE_REPLACE] Successfully completed ${operation} for file ${file_id}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[FILE_REPLACE] Failed to ${operation} for file ${file_id}: ${errorMsg}`);

      this.wsClient.send(createMessage('FILE_REPLACE_RESULT', {
        file_id: file_id,
        operation: operation,
        success: false,
        error: errorMsg,
      }));
    }
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

    this.logger.debug(`[HEARTBEAT] Sending: status=${status}, active_jobs_count=${activeJobsArray.length}`);
    if (activeJobsArray.length > 0) {
      activeJobsArray.forEach(job => {
        this.logger.debug(`[HEARTBEAT]   job=${job.job_id}, progress=${job.progress?.toFixed(1)}%, action=${job.current_action}, fps=${job.fps}, eta=${job.eta}, ratio=${job.ratio}, gpu=${job.gpu}`);
      });
    }

    this.wsClient.sendHeartbeat(status, activeJobsArray);
  }

  private startPeriodicUpdates(): void {
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

    const [cpu, mem, osInfo] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.osInfo(),
    ]);

    const gpus = await this.detectGPUs();

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

    const ffmpegEncoders = await detectAvailableEncoders(ffmpegPath, gpus);
    const ffmpegDecoders = await detectAvailableDecoders(ffmpegPath, gpus);
    const ffmpegHwaccels = await detectAvailableHwaccels(ffmpegPath, gpus);

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

      this.cpuMeasureStart = currentMeasure; 

      const mem = await si.mem();
      const actualUsed = mem.total - mem.available;
      const ramPercent = Math.round((actualUsed / mem.total) * 100);

      let gpuData: any[] | undefined;

      if (this.systemInfo.gpus && this.systemInfo.gpus.length > 0) {
        try {
          const gpuUsageMap = await this.gpuMonitor.getGPUUsage(this.systemInfo.gpus);

          if (gpuUsageMap.size > 0) {
            gpuData = [];

            for (let i = 0; i < this.systemInfo.gpus.length; i++) {
              const usage = gpuUsageMap.get(i);
              if (usage) {
                gpuData.push({
                  ...usage,
                  _gpuName: this.systemInfo.gpus[i].name,
                });
              }
            }

            const shouldLog = Math.floor(Date.now() / 10000) % 2 === 0;
            if (shouldLog) {
              this.logger.debug(`[GPU] GPU usage data: ${JSON.stringify(gpuData)}`);
            }
          } else {
            if (Math.floor(Date.now() / 30000) % 2 === 0) {
              this.logger.warn('[GPU] GPU monitor returned empty map');
            }
          }
        } catch (error) {
          this.logger.warn('[GPU] Failed to get GPU usage:', error);
        }
      }

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

      let lspciAmdGpus: Array<{ model: string; vendor: string; vram?: number; bus?: string }> = [];
      if (process.platform === 'linux') {
        lspciAmdGpus = await this.detectGPUsViaLspci();
      }
      const usedLspci = new Set<number>();

      this.logger.info(`[GPU] si.graphics() returned ${graphics.controllers?.length || 0} controller(s), lspci found ${lspciAmdGpus.length} AMD GPU(s)`);

      if (graphics.controllers && graphics.controllers.length > 0) {
        for (let i = 0; i < graphics.controllers.length; i++) {
          const controller = graphics.controllers[i];
          const modelName = controller.model || '';
          const vendor = (controller.vendor || '').toLowerCase();

          const isAmd = vendor.includes('amd') || vendor.includes('advanced') || vendor.includes('radeon') ||
            (controller.model && /amd|radeon|advanced micro/i.test(controller.model));

          if (isAmd && process.platform === 'linux' && lspciAmdGpus.length > 0) {
            let matchIdx = -1;

            if (modelName && modelName.length >= 10) {
              matchIdx = lspciAmdGpus.findIndex((g, j) => !usedLspci.has(j) &&
                g.model.toLowerCase() === modelName.toLowerCase());
              if (matchIdx < 0) {
                matchIdx = lspciAmdGpus.findIndex((g, j) => !usedLspci.has(j) &&
                  (modelName.toLowerCase().includes(g.model.toLowerCase()) || g.model.toLowerCase().includes(modelName.toLowerCase())));
              }
            }

            if (matchIdx < 0 && controller.vram) {
              let bestDist = Infinity;
              for (let j = 0; j < lspciAmdGpus.length; j++) {
                if (usedLspci.has(j)) continue;
                const lspciVram = lspciAmdGpus[j].vram;
                if (!lspciVram) continue;
                const dist = Math.abs(controller.vram * 1024 - lspciVram);
                if (dist < bestDist) {
                  bestDist = dist;
                  matchIdx = j;
                }
              }
            }

            const freeIdx = matchIdx >= 0 ? matchIdx : lspciAmdGpus.findIndex((_, j) => !usedLspci.has(j));
            if (freeIdx >= 0) {
              usedLspci.add(freeIdx);
              this.logger.info(`[GPU] AMD controller from si.graphics() -> lspci: ${lspciAmdGpus[freeIdx].model}`);
              gpus.push({
                name: lspciAmdGpus[freeIdx].model,
                vendor: lspciAmdGpus[freeIdx].vendor,
                memory: controller.vram ? controller.vram * 1024 * 1024 : undefined,
                driver_version: controller.driverVersion,
              });
              continue;
            }
          }

          if (this.isVirtualDisplay(modelName)) {
            this.logger.debug(`Skipping virtual display: ${modelName}`);
            continue;
          }

          if (this.isIntegratedGPU(controller)) {
            this.logger.debug(`Skipping integrated GPU: ${modelName}`);
            continue;
          }

          if (!modelName && !controller.vram && !controller.vendor) {
            this.logger.debug(`Skipping GPU with no data`);
            continue;
          }

          const vramMB = controller.vram;
          const vramFreeMB = (controller as any).memoryFree;
          const vramUsedMB = (controller as any).memoryUsed;
          const utilizationGpu = (controller as any).utilizationGpu;
          const utilizationMemory = (controller as any).utilizationMemory;
          const temperatureGpu = (controller as any).temperatureGpu;
          const powerDraw = (controller as any).powerDraw;
          const powerLimit = (controller as any).powerLimit;
          const clockCore = (controller as any).clockCore;
          const clockMemory = (controller as any).clockMemory;

          gpus.push({
            name: modelName || 'Unknown GPU',
            vendor: controller.vendor || this.getGPUVendor(modelName),
            memory: vramMB ? vramMB * 1024 * 1024 : undefined,
            memoryFree: vramFreeMB ? vramFreeMB * 1024 * 1024 : undefined,
            memoryUsed: vramUsedMB ? vramUsedMB * 1024 * 1024 : undefined,
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

      if (process.platform === 'linux') {
        for (let j = 0; j < lspciAmdGpus.length; j++) {
          if (!usedLspci.has(j)) {
            this.logger.info(`[GPU] Added AMD GPU from lspci (not in si.graphics()): ${lspciAmdGpus[j].model}`);
            gpus.push({ name: lspciAmdGpus[j].model, vendor: lspciAmdGpus[j].vendor });
          }
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
    const hasIntel = this.systemInfo.gpus.some(gpu =>
      gpu.vendor?.toLowerCase().includes('intel') || gpu.name?.toLowerCase().includes('intel')
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

    if (hasIntel && process.platform === 'linux') {
      const intelAvailable = await GPUMonitor.isIntelAvailable();
      if (intelAvailable) {
        methods.push('sysfs (Intel GPUs)');
      }
    }

    if (methods.length > 0) {
      this.logger.info(`GPU monitoring enabled using: ${methods.join(', ')}`);
    } else {
      this.logger.warn('GPU monitoring disabled - no vendor tools available (nvidia-smi, AMD sysfs, or Intel sysfs)');
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
    const vramMB = gpu.vram;

    if (vendor.includes('intel')) {
      if (vramMB && vramMB >= 2048) return false;
      return true;
    }

    if (vendor.includes('amd') || vendor.includes('ati') || vendor.includes('radeon') || vendor.includes('advanced')) {
      const cleanName = name.replace(/[™®©\(tm\)\(r\)\(c\)]/gi, '').replace(/\s+/g, ' ').trim();

      if (/^(amd\s+)?radeon\s+graphics$/.test(cleanName)) {
        return true;
      }

      if (name.includes('integrated')) {
        return true;
      }

      if (vramMB && vramMB < 1024) {
        return true;
      }

      return false;
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

  private async detectGPUsViaLspci(): Promise<Array<{ model: string; vendor: string; vram?: number; bus?: string }>> {
    if (process.platform !== 'linux') return [];

    try {
      const output = await new Promise<string>((resolve, reject) => {
        const proc = spawn('lspci', [], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.stderr.on('data', () => {});
        proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`lspci exited ${code}`))));
        setTimeout(() => { proc.kill(); reject(new Error('lspci timeout')); }, 3000);
      });

      const gpus: Array<{ model: string; vendor: string; vram?: number; bus?: string }> = [];
      const lines = output.split('\n').filter(l => l.trim());

      for (const line of lines) {
        const busMatch = line.match(/^([\da-f]+:[\da-f]+\.[\da-f]+)/);
        const clsMatch = line.match(/^[\da-f]+:[\da-f]+\.[\da-f]+\s+(VGA|3D|Display)/i);
        if (!clsMatch) continue;
        const cls = clsMatch[1].toLowerCase();
        if (!cls.includes('vga') && !cls.includes('3d') && !cls.includes('display')) continue;

        if (!line.includes('Advanced Micro Devices')) continue;

        const modelMatch = line.match(/Advanced Micro Devices.*?\[AMD.*?\]\s+(.+?)(?:\s+\(rev\s+\w+\))?$/);
        const model = modelMatch ? modelMatch[1].trim() : '';
        const bus = busMatch ? busMatch[1] : '';
        if (model) {
          gpus.push({ model, vendor: 'AMD', bus });
        }
      }

      for (let i = 0; i < gpus.length; i++) {
        const vram = await this.readAmdGpuVram(i);
        if (vram) {
          gpus[i].vram = vram;
        }
      }

      this.logger.info(`[GPU] lspci detected ${gpus.length} AMD GPU(s): ${gpus.map(g => g.model).join(', ')}`);
      return gpus;
    } catch (err: any) {
      this.logger.warn(`[GPU] lspci failed: ${err?.message || err}`);
      return [];
    }
  }

  private async readAmdGpuVram(cardIndex: number): Promise<number | null> {
    try {
      const fs = await import('fs').then(m => m.promises);
      const path = `/sys/class/drm/card${cardIndex}/device/mem_info_vram_total`;
      const data = await fs.readFile(path, 'utf8');
      const vram = parseInt(data.trim(), 10);
      return isNaN(vram) ? null : vram;
    } catch {
      return null;
    }
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