import { spawn, type ChildProcess } from 'child_process';
import { existsSync, copyFileSync, unlinkSync, renameSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { HandBrakeConfig } from '@encorr/shared';
import { buildHandBrakeArgs, parseHandBrakeOutput } from '../handbrake';
import type { Logger } from 'winston';

// ============================================================================
// Transcode Options
// ============================================================================

export interface TranscodeOptions {
  jobId: string;
  sourcePath: string;
  destPath: string;
  config: HandBrakeConfig;
  handbrakePath: string;
  cacheDirectory: string;
  tempDirectory: string;
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
}

// ============================================================================
// Progress Callback
// ============================================================================

export type ProgressCallback = (progress: number, action: string, eta?: number) => void;

// ============================================================================
// Transcoder Class
// ============================================================================

export class Transcoder {
  private activeJobs: Map<string, ChildProcess> = new Map();
  private logger: Logger;

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

    // Validate HandBrake exists
    if (!existsSync(options.handbrakePath)) {
      return {
        success: false,
        original_size: 0,
        transcoded_size: 0,
        duration_seconds: 0,
        error: `HandBrakeCLI not found at: ${options.handbrakePath}`,
        output_path: '',
      };
    }

    const original_size = statSync(options.sourcePath).size;
    const jobId = options.jobId;

    this.logger.info(`Starting transcoding job ${jobId}`);
    this.logger.info(`  Source: ${options.sourcePath}`);
    this.logger.info(`  Output: ${options.destPath}`);

    // Create temp file path
    const tempFileName = `.encorr_temp_${uuidv4()}_${basename(options.destPath)}`;
    const tempPath = join(options.tempDirectory, tempFileName);

    try {
      // Build HandBrake command
      const args = buildHandBrakeArgs({
        input: options.sourcePath,
        output: tempPath,
        config: options.config,
      });

      this.logger.debug(`HandBrake command: ${options.handbrakePath} ${args.join(' ')}`);

      // Spawn HandBrake process
      const proc = spawn(options.handbrakePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.activeJobs.set(jobId, proc);

      let startTime = Date.now();
      let lastProgress = 0;

      // Parse output for progress
      proc.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;

          const parsed = parseHandBrakeOutput(line);
          if (parsed) {
            onProgress(parsed.progress, parsed.current_action, parsed.eta_seconds);
            lastProgress = parsed.progress;
          }
        }
      });

      // Handle errors
      proc.stderr?.on('data', (data: Buffer) => {
        this.logger.warn(`HandBrake stderr: ${data.toString()}`);
      });

      // Wait for completion
      await new Promise<void>((resolve, reject) => {
        proc.on('close', (code) => {
          this.activeJobs.delete(jobId);

          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`HandBrake exited with code ${code}`));
          }
        });

        proc.on('error', (error) => {
          this.activeJobs.delete(jobId);
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

      // Ensure destination directory exists
      const destDir = dirname(options.destPath);
      if (!existsSync(destDir)) {
        // We can't create directories on remote paths, so we'll just use the cache
        // The server should handle moving the file
        this.logger.warn(`Destination directory does not exist: ${destDir}`);
        this.logger.warn(`Leaving file in cache: ${tempPath}`);
        return {
          success: true,
          original_size,
          transcoded_size: statSync(tempPath).size,
          duration_seconds: (Date.now() - startTime) / 1000,
          output_path: tempPath,
        };
      }

      // Move temp file to destination
      if (existsSync(options.destPath)) {
        unlinkSync(options.destPath);
      }
      renameSync(tempPath, options.destPath);

      const transcoded_size = statSync(options.destPath).size;
      const duration = (Date.now() - startTime) / 1000;

      this.logger.info(`Transcoding completed: ${jobId}`);
      this.logger.info(`  Original: ${this.formatBytes(original_size)}`);
      this.logger.info(`  Transcoded: ${this.formatBytes(transcoded_size)}`);
      this.logger.info(`  Saved: ${this.formatBytes(original_size - transcoded_size)} (${((1 - transcoded_size / original_size) * 100).toFixed(1)}%)`);
      this.logger.info(`  Duration: ${duration.toFixed(1)}s`);

      return {
        success: true,
        original_size: original_size,
        transcoded_size: transcoded_size,
        duration_seconds: duration,
        output_path: options.destPath,
      };

    } catch (error) {
      this.activeJobs.delete(jobId);

      this.logger.error(`Transcoding failed: ${jobId}`, error);

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
        error: error instanceof Error ? error.message : String(error),
        output_path: '',
      };
    }
  }

  // ========================================================================
  // Job Control
  // ========================================================================

  cancelJob(jobId: string): boolean {
    const proc = this.activeJobs.get(jobId);
    if (proc) {
      proc.kill('SIGTERM');
      this.activeJobs.delete(jobId);
      this.logger.info(`Cancelled job: ${jobId}`);
      return true;
    }
    return false;
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

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }
}
