import { spawn } from 'child_process';
import { extname } from 'path';
import type { Logger } from 'winston';

// ============================================================================
// Types
// ============================================================================

export interface VideoMetadata {
  container: string;
  video_codec: string;
  audio_codecs: string[];
  subtitle_count: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  size: number;
}

// ============================================================================
// File Analyzer
// ============================================================================
// NOTE: Scanning is now handled by the server. The node only analyzes
// individual files when explicitly told to (e.g., for analyze jobs).

export class FileAnalyzer {
  constructor(
    private ffprobePath: string,
    private logger: Logger
  ) {}

  /**
   * Analyze a single video file with ffprobe
   * Uses spawn instead of execSync to avoid creating visible shell windows
   */
  async analyzeFile(filePath: string): Promise<VideoMetadata> {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ];

      this.logger.debug(`Analyzing file: ${filePath}`);

      const ffprobe = spawn(this.ffprobePath, args, {
        windowsHide: true,  // Hide the command window on Windows
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      ffprobe.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ffprobe.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0 && stdout) {
          try {
            const data = JSON.parse(stdout);
            resolve(this.parseFfprobeOutput(data));
          } catch (error) {
            reject(new Error(`Failed to parse ffprobe output: ${error}`));
          }
        } else {
          reject(new Error(`ffprobe failed with code ${code}: ${stderr || 'Unknown error'}`));
        }
      });

      ffprobe.on('error', (error) => {
        reject(new Error(`Failed to spawn ffprobe: ${error.message}`));
      });

      // Set a timeout (30 seconds for large files)
      const timeout = setTimeout(() => {
        ffprobe.kill();
        reject(new Error('ffprobe analysis timeout'));
      }, 30000);

      ffprobe.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * Parse ffprobe JSON output
   */
  private parseFfprobeOutput(data: any): VideoMetadata {
    const format = data.format || {};
    const streams = data.streams || [];

    // Find video and audio streams
    const videoStream = streams.find((s: any) => s.codec_type === 'video');
    const audioStreams = streams.filter((s: any) => s.codec_type === 'audio');
    const subtitleStreams = streams.filter((s: any) => s.codec_type === 'subtitle');

    // Extract video codec
    let videoCodec = 'unknown';
    if (videoStream) {
      videoCodec = videoStream.codec_name || videoStream.codec || 'unknown';
    }

    // Extract audio codecs
    const audioCodecs = audioStreams.map((s: any) => s.codec_name || s.codec || 'unknown');

    // Container format - clean up common formats
    let container = format.format_name || format.format || 'unknown';
    // Convert "matroska,webm" to "mkv", "mp4" to "mp4", etc.
    const containerLower = container.toLowerCase();
    if (containerLower.includes('matroska') || containerLower.includes('webm')) {
      container = 'mkv';
    } else if (containerLower.includes('avi')) {
      container = 'avi';
    } else if (containerLower.includes('mov') || containerLower.includes('quicktime')) {
      container = 'mov';
    } else if (containerLower.includes('mp4')) {
      container = 'mp4';
    } else {
      // Use first part before comma for other formats
      container = container.split(',')[0];
    }

    // Duration (ffprobe returns in seconds)
    const duration = parseFloat(format.duration || '0') || 0;

    // Dimensions
    const width = videoStream?.width || 0;
    const height = videoStream?.height || 0;

    // FPS
    let fps = 0;
    if (videoStream?.r_frame_rate) {
      const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
      fps = den ? num / den : 0;
    }

    // Bitrate
    const bitrate = parseInt(format.bitrate || '0') || 0;

    // Size
    const size = parseInt(format.size || '0') || 0;

    return {
      container,
      video_codec: videoCodec,
      audio_codecs: audioCodecs,
      subtitle_count: subtitleStreams.length,
      duration,
      width,
      height,
      fps,
      bitrate,
      size,
    };
  }

  /**
   * Check if a file is a video file based on its extension
   */
  private isVideoFile(filename: string): boolean {
    const ext = extname(filename).toLowerCase();
    const videoExtensions = new Set([
      '.mp4', '.mpg', '.mpeg', '.mp2', '.m2v', '.m4v', '.mv2',
      '.avi', '.divx', '.xvid', '.mkv', '.webm', '.flv', '.f4v',
      '.swf', '.vob', '.ogv', '.ogg', '.drc', '.gif', '.gifv',
      '.mng', '.mov', '.qt', '.yuv', '.rm', '.rmvb', '.asf',
      '.amv', '.m1v', '.m2v', '.ts', '.m2ts', '.mts', '.mt2s',
      '.3gp', '.3g2', '.f4p', '.f4a', '.f4b', '.wmv', '.mxf',
      '.nsv', '.wtv', '.bik', '.smk', '.mka', '.m3u', '.m3u8',
      '.vro', '.flc', '.fli', '.dvr-ms', '.wtv', '.wmv',
    ]);
    return videoExtensions.has(ext);
  }
}
