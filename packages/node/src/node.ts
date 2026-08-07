import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { access } from 'fs/promises';
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

    // File replace
    this.wsClient.on('fileReplace', async (payload) => {
      await this.handleFileReplace(payload);
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
    this.logger.info(`[JOB_ASSIGN]   encoding_type: ${presetConfig.encoding_type}`);
    this.logger.info(`[JOB_ASSIGN]   gpu_type: ${presetConfig.gpu_type}`);
    this.logger.info(`[JOB_ASSIGN]   gpu_device_id: ${presetConfig.gpu_device_id}`);
    this.logger.info(`[JOB_ASSIGN]   action: ${presetConfig.action || 'transcode'}`);
    this.logger.info(`[JOB_ASSIGN]   source: ${config.source_path}`);
    this.logger.info(`[JOB_ASSIGN]   dest: ${config.dest_path}`);

    // Assignment delivery is at-least-once. A repeated message must be
    // acknowledged without starting a second ffprobe/ffmpeg process.
    if (this.activeJobs.has(jobId)) {
      this.logger.warn(`[JOB_ASSIGN] Ignoring duplicate assignment for active job ${jobId}`);
      this.wsClient.sendJobAccept(jobId, true);
      return;
    }

    // Server controls concurrency, so we accept all assigned jobs

    // Do not synchronously stat media from the WebSocket message handler.
    // Network-mounted libraries can block here long enough to prevent the
    // remaining assignments in a worker burst from being received.
    try {
      await access(config.source_path);
    } catch {
      const errorMsg = `Source file not found: ${config.source_path}`;
      this.logger.error(`Job ${jobId} rejected: ${errorMsg}`);
      this.wsClient.sendJobAccept(jobId, false, errorMsg);
      return;
    }

    // Accept job
    this.wsClient.sendJobAccept(jobId, true);

    // Use gpu_device_id from server - this is the specific GPU device to use
    // Server has already load-balanced across available GPU devices
    let gpuIndex: number | undefined = undefined;
    if (presetConfig.encoding_type === 'gpu' && presetConfig.gpu_device_id !== undefined) {
      gpuIndex = presetConfig.gpu_device_id;
      this.logger.info(`[JOB_ASSIGN] Using GPU device ${gpuIndex} (from server assignment)`);
    } else if (presetConfig.encoding_type === 'gpu' && presetConfig.gpu_type) {
      const requestedVendor = presetConfig.gpu_type;
      gpuIndex = this.systemInfo.gpus?.findIndex(gpu => {
        const identity = `${gpu.vendor || ''} ${gpu.name || ''}`.toLowerCase();
        if (requestedVendor === 'nvidia') return /nvidia|geforce|quadro|tesla/.test(identity);
        if (requestedVendor === 'amd') return /\bamd\b|advanced micro devices|\bradeon\b|\bati\b/.test(identity);
        return /\bintel\b|\barc(?:\(tm\))?\b/.test(identity);
      });
      if (gpuIndex === undefined || gpuIndex < 0) gpuIndex = 0;
      this.logger.warn(`[JOB_ASSIGN] No gpu_device_id provided, selected ${requestedVendor} GPU ${gpuIndex}`);
    }

    if (presetConfig.encoding_type === 'gpu'
      && (presetConfig.gpu_type === 'amd' || presetConfig.gpu_type === 'intel')
      && process.platform === 'linux') {
      const selectedGpu = this.systemInfo.gpus?.[gpuIndex ?? 0];
      if (selectedGpu?.device_path) {
        presetConfig.gpu_device_path = selectedGpu.device_path;
        this.logger.info(`[JOB_ASSIGN] Using ${presetConfig.gpu_type === 'intel' ? 'Intel QSV' : 'AMD VAAPI'} device ${selectedGpu.device_path}`);
      } else {
        this.logger.warn(`[JOB_ASSIGN] ${presetConfig.gpu_type === 'intel' ? 'Intel GPU' : 'AMD GPU'} has no resolved render node; falling back to /dev/dri/renderD128`);
      }
    }

    if (presetConfig.encoding_type === 'gpu' && presetConfig.gpu_type === 'intel' && process.platform === 'win32') {
      const selectedIndex = gpuIndex ?? 0;
      const intelAdapterIndex = (this.systemInfo.gpus || [])
        .slice(0, selectedIndex + 1)
        .filter(gpu => /intel|\barc\b/i.test(`${gpu.vendor || ''} ${gpu.name || ''}`))
        .length - 1;
      presetConfig.gpu_vendor_device_id = Math.max(0, intelAdapterIndex);
      this.logger.info(`[JOB_ASSIGN] Intel Arc/QSV adapter index ${presetConfig.gpu_vendor_device_id} selected`);
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
      const reportProgress = (progress: number, action: string, eta?: number, fps?: number, ratio?: string) => {
        activeJob.progress = progress;
        activeJob.currentAction = action;
        activeJob.fps = fps;
        activeJob.eta = eta;
        activeJob.ratio = ratio;
        this.wsClient.sendJobProgress(jobId, progress, action, eta, fps, ratio);

        if (Math.floor(progress) % 10 === 0 || progress === 0) {
          const etaFormatted = eta ? formatDuration(eta) : undefined;
          this.logger.info(`[PROGRESS] Job ${jobId}: ${progress.toFixed(1)}% - ${action}${fps ? ` @ ${fps.toFixed(1)} fps` : ''}${ratio ? ` (Ratio: ${ratio})` : ''}${etaFormatted ? ` (ETA: ${etaFormatted})` : ''}`);
        }
      };

      const transcodeOptions = {
        jobId,
        sourcePath: activeJob.sourcePath,
        destPath: activeJob.destPath,
        config: activeJob.config,
        ffmpegPath: this.systemInfo.ffmpeg_path || '',
        cacheDirectory: this.config.cache_dir,
        tempDirectory: this.config.temp_dir,
        availableEncoders: this.systemInfo.ffmpeg_encoders,
      };

      let result = await this.transcoder.transcode(
        transcodeOptions,
        reportProgress,
      );

      const vaapiDecodeUnsupported = !result.success
        && activeJob.config.encoding_type === 'gpu'
        && (activeJob.config.gpu_type === 'amd' || activeJob.config.gpu_type === 'intel')
        && /No support for codec .* profile|hwaccel initialisation returned error|Failed setup for format vaapi/i.test(result.ffmpeg_logs || '');

      if (vaapiDecodeUnsupported) {
        const retryAction = 'GPU decode unsupported · retrying with software decode';
        this.logger.warn(`[GPU_DECODE_FALLBACK] Job ${jobId}: VAAPI cannot decode this source profile; keeping GPU encoding and retrying with software decode`);
        this.wsClient.sendJobProgress(jobId, 0, retryAction);
        activeJob.currentAction = retryAction;
        result = await this.transcoder.transcode(
        {
          ...transcodeOptions,
          config: {
            ...activeJob.config,
            use_explicit_decoder: false,
            software_decode: true,
          },
        },
          reportProgress,
        );
      }

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
        // Check if this was a user cancellation
        const isCancelled = result.error === 'Cancelled by user';
        if (isCancelled) {
          this.logger.info(`[JOB_CANCELLED] Job ${jobId} was cancelled by user`);
        } else {
          this.logger.error(`[JOB_ERROR] Job ${jobId} failed: ${result.error}`);
        }

        this.wsClient.sendJobError(
          jobId,
          result.error || 'Unknown error',
          result.retry_possible ?? false,
          result.ffmpeg_logs
        );
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

  private async handleFileReplace(payload: {
    operation_id: string;
    file_id: string;
    operation: 'replace' | 'backup_replace' | 'cleanup_backup';
    source_path: string;
    target_path: string;
    original_filename: string;
  }): Promise<void> {
    const { operation_id, file_id, operation, source_path, target_path, original_filename } = payload;

    this.logger.info(`[FILE_REPLACE] ${operation} for file ${file_id}: ${original_filename}`);
    this.logger.info(`[FILE_REPLACE]   source: ${source_path}`);
    this.logger.info(`[FILE_REPLACE]   target: ${target_path}`);

    try {
      const fsModule = require('fs');
      const { promises: fs } = fsModule;
      const { dirname } = require('path');

      const reportProgress = (
        progress: number,
        current_action: string,
        bytes_processed = 0,
        total_bytes = 0,
        speed_mbps = 0,
      ) => {
        this.wsClient.send(createMessage('FILE_REPLACE_PROGRESS', {
          operation_id, file_id, operation, progress, current_action,
          bytes_processed, total_bytes, speed_mbps,
        }));
      };

      // Helper function to move files across devices
      const moveFile = async (src: string, dest: string, startProgress: number, endProgress: number): Promise<void> => {
        const sourceSize = Number((await fs.stat(src)).size || 0);
        reportProgress(startProgress, 'Moving transcoded file', 0, sourceSize, 0);
        try {
          // Try rename first (fast, works on same filesystem)
          await fs.rename(src, dest);
          reportProgress(endProgress, 'Transcoded file moved', sourceSize, sourceSize, 0);
          this.logger.debug(`[FILE_REPLACE] Moved file using rename (same device)`);
        } catch (error: any) {
          // If cross-device link error, use copy+delete
          if (error.code === 'EXDEV') {
            this.logger.info(`[FILE_REPLACE] Cross-device move detected, using copy+delete`);
            // Ensure target directory exists
            await fs.mkdir(dirname(dest), { recursive: true });
            const startedAt = Date.now();
            let copied = 0;
            let lastReport = 0;
            await new Promise<void>((resolveCopy, rejectCopy) => {
              const reader = fsModule.createReadStream(src);
              const writer = fsModule.createWriteStream(dest);
              reader.on('data', (chunk: Buffer) => {
                copied += chunk.length;
                const now = Date.now();
                if (now - lastReport >= 200 || copied >= sourceSize) {
                  lastReport = now;
                  const fraction = sourceSize > 0 ? copied / sourceSize : 1;
                  const progress = startProgress + fraction * (endProgress - startProgress);
                  const seconds = Math.max((now - startedAt) / 1000, 0.001);
                  const speed = copied / 1024 / 1024 / seconds;
                  reportProgress(progress, 'Copying transcoded file', copied, sourceSize, speed);
                }
              });
              reader.on('error', rejectCopy);
              writer.on('error', rejectCopy);
              writer.on('finish', resolveCopy);
              reader.pipe(writer);
            });
            // Delete source
            reportProgress(endProgress, 'Removing temporary transcoded file', sourceSize, sourceSize, 0);
            await fs.unlink(src);
            this.logger.debug(`[FILE_REPLACE] Moved file using copy+delete (cross-device)`);
          } else {
            throw error;
          }
        }
      };

      // Verify source file exists (for replace operations)
      if (operation === 'replace' || operation === 'backup_replace') {
        reportProgress(3, 'Checking transcoded file');
        const sourceExists = await fs.access(source_path).then(() => true).catch(() => false);
        if (!sourceExists) {
          throw new Error(`Source file not found: ${source_path}`);
        }
      }

      // Verify target file exists (for cleanup operations)
      if (operation === 'cleanup_backup') {
        reportProgress(10, 'Checking backup file');
        const targetExists = await fs.access(target_path).then(() => true).catch(() => false);
        if (!targetExists) {
          throw new Error(`Backup file not found: ${target_path}`);
        }
      }

      let replacementMetadata: Awaited<ReturnType<FileAnalyzer['analyzeFile']>> | undefined;

      // Perform the operation
      if (operation === 'replace') {
        // Direct replace: move transcoded file to original location
        await moveFile(source_path, target_path, 10, 92);
        reportProgress(97, 'Verifying replacement');
        await fs.stat(target_path);
        this.logger.info(`[FILE_REPLACE] Replaced original file with transcoded version`);
      } else if (operation === 'backup_replace') {
        // Backup original to .org, then move transcoded file to original location
        const backupPath = target_path + '.org';

        // Check if backup already exists
        const backupExists = await fs.access(backupPath).then(() => true).catch(() => false);
        if (backupExists) {
          this.logger.warn(`[FILE_REPLACE] Backup file already exists: ${backupPath}, removing old backup`);
          // Just remove the old backup
          await fs.unlink(backupPath);
        }

        // Rename original to .org (same device, should work)
        reportProgress(12, 'Backing up original file');
        await fs.rename(target_path, backupPath);
        reportProgress(25, 'Original backed up');
        this.logger.info(`[FILE_REPLACE] Backed up original to: ${backupPath}`);

        // Move transcoded file to original location (may be cross-device)
        await moveFile(source_path, target_path, 25, 92);
        reportProgress(97, 'Verifying replacement');
        await fs.stat(target_path);
        this.logger.info(`[FILE_REPLACE] Moved transcoded file to: ${target_path}`);
      } else if (operation === 'cleanup_backup') {
        // Delete the .org backup file
        reportProgress(60, 'Deleting original backup');
        await fs.unlink(target_path);
        this.logger.info(`[FILE_REPLACE] Deleted backup file: ${target_path}`);
      }

      if (operation === 'replace' || operation === 'backup_replace') {
        reportProgress(98, 'Reading installed file metadata');
        try {
          replacementMetadata = await this.fileAnalyzer?.analyzeFile(target_path);
        } catch (metadataError) {
          this.logger.warn(`[FILE_REPLACE] Replacement succeeded but metadata refresh failed: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}`);
        }
      }

      reportProgress(100, operation === 'cleanup_backup' ? 'Backup deleted' : 'Replacement complete');

      // Send success result
      this.wsClient.send(createMessage('FILE_REPLACE_RESULT', {
        operation_id,
        file_id: file_id,
        operation: operation,
        success: true,
        new_file_path: target_path,
        new_metadata: replacementMetadata,
      }));

      this.logger.info(`[FILE_REPLACE] Successfully completed ${operation} for file ${file_id}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[FILE_REPLACE] Failed to ${operation} for file ${file_id}: ${errorMsg}`);

      // Send failure result
      this.wsClient.send(createMessage('FILE_REPLACE_RESULT', {
        operation_id,
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
    const gpus = await this.detectGPUs(mem.total);

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
    const ffmpegEncoders = await detectAvailableEncoders(ffmpegPath, gpus);
    const ffmpegDecoders = await detectAvailableDecoders(ffmpegPath, gpus);
    const ffmpegHwaccels = await detectAvailableHwaccels(ffmpegPath, gpus);

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
      // Use available memory to calculate actual used memory (excludes cache/buffers)
      // mem.available is the memory actually available for applications
      const actualUsed = mem.total - mem.available;
      const ramPercent = Math.round((actualUsed / mem.total) * 100);

      // Get GPU usage data using vendor-specific tools (nvidia-smi, AMD sysfs)
      // nvidia-smi is very fast (~50ms) so we call it every second, no caching needed
      let gpuData: any[] | undefined;

      if (this.systemInfo.gpus && this.systemInfo.gpus.length > 0) {
        try {
          const gpuUsageMap = await this.gpuMonitor.getGPUUsage(this.systemInfo.gpus);

          if (gpuUsageMap.size > 0) {
            gpuData = [];

            // Preserve the system-info GPU order. The server merges this array
            // by index, so omitting an unmonitored GPU would shift Intel Arc
            // telemetry onto the wrong adapter.
            for (let i = 0; i < this.systemInfo.gpus.length; i++) {
              const usage = gpuUsageMap.get(i);
              gpuData.push(usage || {});
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

  private async detectGPUs(systemMemoryBytes = 0): Promise<GPUInfo[]> {
    const si = require('systeminformation');

    this.logger.info('Detecting GPUs...');
    const gpus: GPUInfo[] = [];

    try {
      const graphics = await si.graphics();
      const amdDrmDevices = this.detectDrmDevices('0x1002', 'AMD');
      const intelDrmDevices = this.detectDrmDevices('0x8086', 'Intel');
      let nextAmdDevice = 0;
      let nextIntelDevice = 0;

      // Process controllers (GPUs)
      if (graphics.controllers && graphics.controllers.length > 0) {
        for (let i = 0; i < graphics.controllers.length; i++) {
          const controller = graphics.controllers[i];
          const identity = `${controller.vendor || ''} ${controller.model || ''}`.toLowerCase();
          const isAmd = /\bamd\b|advanced micro devices|\bradeon\b|\bati\b/.test(identity);
          const isIntel = /\bintel\b|\barc(?:\(tm\))?\b/.test(identity);

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
          const usesSharedIntelMemory = process.platform === 'win32'
            && isIntel
            && (/\barc(?:\(tm\))?\s*\d{3}[tv]\b/i.test(controller.model || '') || !vramMB || vramMB <= 2048);
          const detectedMemory = usesSharedIntelMemory && systemMemoryBytes > 0
            ? Math.floor(systemMemoryBytes / 2)
            : vramMB ? vramMB * 1024 * 1024 : undefined;

          // Capture utilization metrics
          const utilizationGpu = (controller as any).utilizationGpu;
          const utilizationMemory = (controller as any).utilizationMemory;
          const temperatureGpu = (controller as any).temperatureGpu;
          const powerDraw = (controller as any).powerDraw;
          const powerLimit = (controller as any).powerLimit;
          const clockCore = (controller as any).clockCore;
          const clockMemory = (controller as any).clockMemory;
          const hardwareDevice = isAmd
            ? amdDrmDevices[nextAmdDevice++]
            : isIntel ? intelDrmDevices[nextIntelDevice++] : undefined;

          gpus.push({
            name: controller.model || 'Unknown GPU',
            vendor: controller.vendor || this.getGPUVendor(controller.model || ''),
            memory: detectedMemory,
            memory_type: usesSharedIntelMemory ? 'shared' : 'dedicated',
            memoryFree: !usesSharedIntelMemory && vramFreeMB ? vramFreeMB * 1024 * 1024 : undefined,
            memoryUsed: !usesSharedIntelMemory && vramUsedMB ? vramUsedMB * 1024 * 1024 : undefined,
            driver_version: controller.driverVersion,
            utilizationGpu,
            utilizationMemory,
            temperatureGpu,
            powerDraw,
            powerLimit,
            clockCore,
            clockMemory,
            drm_card: hardwareDevice?.drmCard,
            device_path: hardwareDevice?.renderNode,
            pci_bus: hardwareDevice?.pciBus,
          });
        }
      }

      // systeminformation occasionally omits headless AMD adapters. sysfs is
      // authoritative on Linux and still exposes their VAAPI render nodes.
      for (; nextAmdDevice < amdDrmDevices.length; nextAmdDevice++) {
        const device = amdDrmDevices[nextAmdDevice];
        gpus.push({
          name: device.name,
          vendor: 'AMD',
          memory: device.memory,
          memory_type: 'dedicated',
          drm_card: device.drmCard,
          device_path: device.renderNode,
          pci_bus: device.pciBus,
        });
      }

      // Headless Arc adapters may not appear in systeminformation but remain
      // available through Linux DRM and oneVPL/QSV.
      for (; nextIntelDevice < intelDrmDevices.length; nextIntelDevice++) {
        const device = intelDrmDevices[nextIntelDevice];
        gpus.push({
          name: device.name,
          vendor: 'Intel',
          memory: device.memory,
          memory_type: 'dedicated',
          drm_card: device.drmCard,
          device_path: device.renderNode,
          pci_bus: device.pciBus,
        });
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
      gpu.vendor?.toLowerCase().includes('advanced micro') ||
      /\bati\b/.test(gpu.vendor?.toLowerCase() || '') || gpu.name?.toLowerCase().includes('radeon')
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

    // Intel Arc and Intel integrated GPUs can both provide QSV workers. The
    // FFmpeg capability probe, rather than the display type, decides whether
    // they can be scheduled.
    if (/\bintel\b|\barc(?:\(tm\))?\b/.test(`${vendor} ${name}`)) return false;

    // AMD APUs also expose working AMF/VAAPI encoders. Do not discard them
    // based on shared-memory size or a generic "Radeon Graphics" name.
    if (/\bamd\b|advanced micro devices|\bradeon\b|\bati\b/.test(`${vendor} ${name}`)) {
      return false;
    }

    return false;
  }

  private getGPUVendor(name: string): string {
    const lowerName = name.toLowerCase();
    if (lowerName.includes('nvidia') || lowerName.includes('geforce') || lowerName.includes('quadro') || lowerName.includes('tesla')) {
      return 'NVIDIA';
    }
    if (/\bamd\b|advanced micro devices|\bradeon\b|\bati\b/.test(lowerName)) {
      return 'AMD';
    }
    if (/\bintel\b|\barc(?:\(tm\))?\b/.test(lowerName)) {
      return 'Intel';
    }
    if (lowerName.includes('apple') || lowerName.includes('m1') || lowerName.includes('m2') || lowerName.includes('m3')) {
      return 'Apple';
    }
    return 'Unknown';
  }

  private detectDrmDevices(vendorId: string, vendorName: 'AMD' | 'Intel'): Array<{
    drmCard: string;
    renderNode: string;
    pciBus?: string;
    name: string;
    memory?: number;
  }> {
    if (process.platform !== 'linux' || !existsSync('/sys/class/drm')) return [];

    const devices: Array<{
      drmCard: string;
      renderNode: string;
      pciBus?: string;
      name: string;
      memory?: number;
    }> = [];

    try {
      const cards = readdirSync('/sys/class/drm')
        .filter(entry => /^card\d+$/.test(entry))
        .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));

      for (const drmCard of cards) {
        const deviceRoot = `/sys/class/drm/${drmCard}/device`;
        const vendorPath = `${deviceRoot}/vendor`;
        if (!existsSync(vendorPath) || readFileSync(vendorPath, 'utf8').trim().toLowerCase() !== vendorId) continue;

        const drmEntries = existsSync(`${deviceRoot}/drm`) ? readdirSync(`${deviceRoot}/drm`) : [];
        const renderName = drmEntries.find(entry => /^renderD\d+$/.test(entry));
        if (!renderName) continue;

        const uevent = existsSync(`${deviceRoot}/uevent`) ? readFileSync(`${deviceRoot}/uevent`, 'utf8') : '';
        const pciBus = uevent.match(/^PCI_SLOT_NAME=(.+)$/m)?.[1];
        const pciId = uevent.match(/^PCI_ID=(.+)$/m)?.[1];
        const memoryValue = existsSync(`${deviceRoot}/mem_info_vram_total`)
          ? Number(readFileSync(`${deviceRoot}/mem_info_vram_total`, 'utf8').trim())
          : undefined;

        devices.push({
          drmCard,
          renderNode: `/dev/dri/${renderName}`,
          pciBus,
          name: pciId ? `${vendorName} GPU (${pciId})` : `${vendorName} GPU (${drmCard})`,
          memory: Number.isFinite(memoryValue) && memoryValue! > 0 ? memoryValue : undefined,
        });
      }
    } catch (error: any) {
      this.logger.warn(`[GPU] Failed to inspect ${vendorName} DRM devices: ${error?.message || error}`);
    }

    return devices;
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
