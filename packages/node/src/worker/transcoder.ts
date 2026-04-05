import { spawn, type ChildProcess } from 'child_process';
import { existsSync, unlinkSync, renameSync, statSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import type { FFmpegConfig } from '@encorr/shared';
import { buildFFmpegArgs, parseFFmpegProgressLine } from '../ffmpeg';
import type { Logger } from 'winston';

// ============================================================================
// Transcode Options
// ============================================================================

export interface TranscodeOptions {
  jobId: string;
  sourcePath: string;
  destPath: string;
  config: FFmpegConfig;
  ffmpegPath: string;
  cacheDirectory: string;
  tempDirectory: string;
  availableEncoders?: any[]; // FFmpeg encoders available on this system
}

// ============================================================================
// Transcode Result
// ============================================================================

export interface TranscodeResult {
  success: boolean;
  original_size: number;
  transcoded_size: number;
  duration_seconds: number;
  avg_fps?: number;
  error?: string;
  output_path: string;
  ffmpeg_logs?: string;
  decoder_info?: string;
}

// ============================================================================
// Progress Callback
// ============================================================================

export type ProgressCallback = (progress: number, action: string, eta?: number, fps?: number, ratio?: string) => void;

// ============================================================================
// Transcoder Class
// ============================================================================

export class Transcoder {
  private activeJobs: Map<string, ChildProcess> = new Map();
  private cancelledJobs: Set<string> = new Set(); // Track intentionally cancelled jobs
  private logger: Logger;
  private decoderLogged: boolean = false;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // ========================================================================
  // Transcode
  // ========================================================================

  async transcode(options: TranscodeOptions, onProgress: ProgressCallback): Promise<TranscodeResult> {
    // Validate source file exists
    if (!existsSync(options.sourcePath)) {
      return {
        success: false,
        original_size: 0,
        transcoded_size: 0,
        duration_seconds: 0,
        error: `Source file not found: ${options.sourcePath}`,
        output_path: '',
      };
    }

    // Validate FFmpeg exists
    if (!existsSync(options.ffmpegPath)) {
      return {
        success: false,
        original_size: 0,
        transcoded_size: 0,
        duration_seconds: 0,
        error: `FFmpeg not found at: ${options.ffmpegPath}`,
        output_path: '',
      };
    }

    // Validate GPU encoder availability BEFORE starting
    if (options.config.encoding_type === 'gpu') {
      const requiredEncoder = this.getRequiredEncoderName(options.config);
      const isAvailable = options.availableEncoders?.some((e: any) =>
        e.encoder_name === requiredEncoder && e.available === true
      );

      if (!isAvailable) {
        const gpuType = options.config.gpu_type?.toUpperCase() || 'GPU';
        return {
          success: false,
          original_size: 0,
          transcoded_size: 0,
          duration_seconds: 0,
          error: `GPU encoding failed: ${requiredEncoder} is not available. Please ensure your ${gpuType} GPU drivers are properly installed and FFmpeg was compiled with ${gpuType} support. DO NOT fall back to CPU encoding as requested.`,
          output_path: '',
        };
      }

      this.logger.info(`[GPU_VALIDATION] ✓ ${requiredEncoder} is available for ${options.config.gpu_type} encoding`);
    }

    const original_size = statSync(options.sourcePath).size;
    const jobId = options.jobId;

    // Reset decoder detection flag for new job
    this.decoderLogged = false;

    this.logger.info(`Starting transcoding job ${jobId}`);
    this.logger.info(`  Source: ${options.sourcePath}`);
    this.logger.info(`  Output: ${options.destPath}`);

    // Create job-specific directory in temp folder
    const jobDir = join(options.tempDirectory, jobId);
    if (!existsSync(jobDir)) {
      mkdirSync(jobDir, { recursive: true });
      this.logger.info(`Created job directory: ${jobDir}`);
    }

    // Create temp file path in job directory
    const tempFileName = basename(options.destPath);
    const tempPath = join(jobDir, tempFileName);
    let stderrOutput: string[] = []; // Collect stderr for reporting

    try {
      // Build FFmpeg command
      const args = buildFFmpegArgs({
        input: options.sourcePath,
        output: tempPath,
        config: options.config,
      });

      this.logger.info(`[FFMPEG] Starting transcoding...`);
      this.logger.info(`[FFMPEG] Command: ${options.ffmpegPath}`);
      this.logger.info(`[FFMPEG] Args: ${args.join(' ')}`);

      // Spawn FFmpeg process with progress reporting
      const proc = spawn(options.ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.activeJobs.set(jobId, proc);

      let startTime = Date.now();
      let lastProgress = 0;
      let lastLoggedTime = 0;
      let accumulatedFps: number | undefined = undefined;
      let accumulatedEta: number | undefined = undefined;
      let totalDuration: number | undefined = undefined;

      // Parse output for progress
      proc.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        stderrOutput.push(output); // Collect all stderr output

        const lines = output.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;

          // Detect which decoder is being used (GPU verification)
          const detectedDecoder = this.detectDecoderUsed(line);
          if (detectedDecoder && !this.decoderLogged) {
            this.logger.info(`[GPU_DETECTION] ${detectedDecoder}`);
            this.decoderLogged = true;
          }

          // Log raw FFmpeg output for debugging
          this.logger.debug(`[FFMPEG_RAW] ${line.trim().substring(0, 200)}`);

          // Try to extract duration first
          if (!totalDuration) {
            const durationMatch = line.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
            if (durationMatch) {
              const hours = parseInt(durationMatch[1], 10);
              const minutes = parseInt(durationMatch[2], 10);
              const seconds = parseFloat(durationMatch[3]);
              totalDuration = hours * 3600 + minutes * 60 + seconds;
              this.logger.info(`[FFMPEG] Duration: ${totalDuration.toFixed(1)}s`);
              continue;
            }
          }

          // Check for errors in FFmpeg output
          if (line.includes('Error') || line.includes('Invalid') || line.includes('Unknown')) {
            this.logger.warn(`[FFMPEG] ${line.trim()}`);
          }

          // Parse progress using FFmpeg progress format
          const parsed = parseFFmpegProgressLine(line, totalDuration, original_size);
          if (parsed) {
            // Accumulate data - only update FPS/ETA if new values are provided
            if (parsed.fps !== undefined) {
              accumulatedFps = parsed.fps;
            }
            if (parsed.eta_seconds !== undefined) {
              accumulatedEta = parsed.eta_seconds;
            }
            // Note: ratio is calculated per-line from FFmpeg's size output

            // Skip duplicate progress updates (same progress %)
            if (Math.abs(parsed.progress - lastProgress) < 0.1 && parsed.fps === undefined) {
              this.logger.debug(`[SKIPPED] Duplicate progress: ${parsed.progress.toFixed(1)}% (last: ${lastProgress.toFixed(1)}%)`);
              continue;
            }

            // Always send if we have FPS data, or if progress changed significantly
            const shouldSend = Math.abs(parsed.progress - lastProgress) >= 0.1 || parsed.fps !== undefined;

            if (shouldSend) {
              this.logger.debug(`[PARSE] progress=${parsed.progress.toFixed(1)}%, action=${parsed.current_action}, fps=${accumulatedFps}, eta=${accumulatedEta}, ratio=${parsed.ratio}`);
              onProgress(parsed.progress, parsed.current_action, accumulatedEta, accumulatedFps, parsed.ratio);
              lastProgress = parsed.progress;
            }
          }
        }
      });

      // Handle stdout (FFmpeg writes progress to stderr)
      proc.stdout?.on('data', (data: Buffer) => {
        this.logger.debug(`[FFMPEG stdout] ${data.toString()}`);
      });

      // Wait for completion
      await new Promise<void>((resolve, reject) => {
        proc.on('close', (code) => {
          this.activeJobs.delete(jobId);

          // Check if this was an intentional cancellation (SIGTERM = signal 15, typically exits with 255)
          const wasCancelled = this.cancelledJobs.has(jobId);
          this.cancelledJobs.delete(jobId); // Clean up tracking

          if (code === 0) {
            this.logger.info(`[FFMPEG] Completed successfully`);
            resolve();
          } else if (wasCancelled) {
            // Job was intentionally cancelled by user - not an error
            this.logger.info(`[FFMPEG] Job cancelled by user`);
            // Reject with a special error that won't be logged as failure
            reject(new Error('CANCELLED'));
          } else {
            // Log the stderr output for debugging
            const stderrLog = stderrOutput.join('\n');
            this.logger.error(`[FFMPEG] Failed with exit code ${code}`);
            this.logger.error(`[FFMPEG] Stderr output:\n${stderrLog}`);
            reject(new Error(`FFmpeg exited with code ${code}`));
          }
        });

        proc.on('error', (error) => {
          this.activeJobs.delete(jobId);
          this.logger.error(`[FFMPEG] Process error:`, error);
          reject(error);
        });
      });

      // Check if temp file was created
      if (!existsSync(tempPath)) {
        return {
          success: false,
          original_size,
          transcoded_size: 0,
          duration_seconds: 0,
          error: 'Transcoding completed but output file not found',
          output_path: '',
        };
      }

      const transcoded_size = statSync(tempPath).size;
      const duration = (Date.now() - startTime) / 1000;

      this.logger.info(`Transcoding completed: ${jobId}`);
      this.logger.info(`  Original: ${this.formatBytes(original_size)}`);
      this.logger.info(`  Transcoded: ${this.formatBytes(transcoded_size)}`);
      this.logger.info(`  Saved: ${this.formatBytes(original_size - transcoded_size)} (${((1 - transcoded_size / original_size) * 100).toFixed(1)}%)`);
      this.logger.info(`  Duration: ${duration.toFixed(1)}s`);
      this.logger.info(`  Output location: ${tempPath}`);

      // Return the path to the file in the temp folder
      // The server is responsible for moving it to the final destination
      return {
        success: true,
        original_size: original_size,
        transcoded_size: transcoded_size,
        duration_seconds: duration,
        output_path: tempPath,
        ffmpeg_logs: stderrOutput.slice(-500).join('\n'),
      };

    } catch (error) {
      this.activeJobs.delete(jobId);

      // Check if this was an intentional cancellation
      const wasCancelled = error instanceof Error && error.message === 'CANCELLED';

      if (wasCancelled) {
        this.logger.info(`Transcoding cancelled: ${jobId}`);
      } else {
        this.logger.error(`Transcoding failed: ${jobId}`, error);
      }

      // Clean up temp file
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
          // Ignore
        }
      }

      return {
        success: false,
        original_size: original_size,
        transcoded_size: 0,
        duration_seconds: 0,
        error: wasCancelled ? 'Cancelled by user' : (error instanceof Error ? error.message : String(error)),
        output_path: '',
        ffmpeg_logs: stderrOutput.slice(-500).join('\n'),
      };
    }
  }

  // ========================================================================
  // Job Control
  // ========================================================================

  cancelJob(jobId: string): boolean {
    const proc = this.activeJobs.get(jobId);
    if (proc) {
      this.cancelledJobs.add(jobId); // Mark as intentionally cancelled
      proc.kill('SIGTERM');
      this.activeJobs.delete(jobId);
      this.logger.info(`Cancelling job: ${jobId}`);
      return true;
    }
    return false;
  }

  // ========================================================================
  // Decoder Detection
  // ========================================================================

  /**
   * Detects which decoder FFmpeg is using by parsing stderr output.
   * This helps verify that GPU decoding is actually happening.
   */
  private detectDecoderUsed(line: string): string | null {
    // Check for NVIDIA cuvid decoders (explicit decoder in use)
    if (line.includes('hevc_cuvid') || line.includes('[hevc_cuvid @')) {
      return 'Using decoder: GPU (NVIDIA hevc_cuvid - H.265)';
    }
    if (line.includes('h264_cuvid') || line.includes('[h264_cuvid @')) {
      return 'Using decoder: GPU (NVIDIA h264_cuvid - H.264)';
    }

    // Check for Intel QSV decoders
    if (line.includes('hevc_qsv') || line.includes('[h264_qsv @')) {
      return 'Using decoder: GPU (Intel QSV - H.265)';
    }
    if (line.includes('h264_qsv') || line.includes('[hevc_qsv @')) {
      return 'Using decoder: GPU (Intel QSV - H.264)';
    }

    // Check for AMD AMF/D3D11VA decoders
    if (line.includes('h264_d3d11va') || line.includes('hevc_d3d11va')) {
      return 'Using decoder: GPU (AMD D3D11VA)';
    }

    // Check for hardware acceleration being used
    if (line.includes('HW accel context') || line.includes('Using AVCodecContext')) {
      if (line.includes('cuda')) {
        return 'Using decoder: GPU (NVIDIA CUDA hwaccel)';
      }
      if (line.includes('qsv')) {
        return 'Using decoder: GPU (Intel QSV hwaccel)';
      }
      if (line.includes('d3d11va')) {
        return 'Using decoder: GPU (AMD/Windows D3D11VA hwaccel)';
      }
    }

    // Check for software decoding (CPU)
    if (line.includes('Decoding with') || line.includes('Selected decoder')) {
      const match = line.match(/(?:Decoding with|Selected decoder)\s+(\w+)/);
      if (match) {
        const decoder = match[1];
        if (decoder === 'h264' || decoder === 'hevc' || decoder === 'avc') {
          return `Using decoder: CPU (software ${decoder})`;
        }
      }
    }

    // Look for decoder initialization messages
    if (line.includes('[h264 @') || line.includes('[hevc @') || line.includes('[avc @')) {
      // This is likely software decoding if we see this pattern
      // Only log if we haven't seen a GPU decoder yet
      if (!this.decoderLogged) {
        return 'Using decoder: CPU (software - likely libavcodec)';
      }
    }

    return null;
  }

  getActiveJobs(): string[] {
    return Array.from(this.activeJobs.keys());
  }

  isJobActive(jobId: string): boolean {
    return this.activeJobs.has(jobId);
  }

  // ========================================================================
  // Utilities
  // ========================================================================

  private getRequiredEncoderName(config: FFmpegConfig): string {
    // Returns the FFmpeg encoder name required for the given config
    if (config.encoding_type === 'cpu') {
      return config.video_codec === 'h265' ? 'libx265' : 'libx264';
    }

    // GPU encoders
    if (config.gpu_type === 'nvidia') {
      return config.video_codec === 'h265' ? 'hevc_nvenc' : 'h264_nvenc';
    }
    if (config.gpu_type === 'intel') {
      return config.video_codec === 'h265' ? 'hevc_qsv' : 'h264_qsv';
    }
    if (config.gpu_type === 'amd') {
      return config.video_codec === 'h265' ? 'hevc_amf' : 'h264_amf';
    }

    return 'unknown';
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }
}
