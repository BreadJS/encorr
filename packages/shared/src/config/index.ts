import { z } from 'zod';
import type { Settings, NodeConfig, HandBrakeConfig } from '../types';

// ============================================================================
// Default Built-in Presets
// ============================================================================

export const BUILTIN_PRESETS: Record<string, HandBrakeConfig> = {
  'high-quality-h265': {
    video_encoder: 'x265',
    quality_mode: 'cq',
    quality: 22,
    preset: 'medium',
    tune: 'film',
    container: 'mp4',
    crop_mode: 'auto',
    audio_encoder: 'aac',
    audio_bitrate: 160,
    audio_channels: 'auto',
    audio_mixdown: 'none',
    subtitles: 'all',
    deinterlace: false,
    denoise: 'none',
    deblock: false,
  },
  'maximum-compression': {
    video_encoder: 'x265',
    quality_mode: 'cq',
    quality: 28,
    preset: 'slow',
    container: 'mp4',
    max_width: 1920,
    max_height: 1080,
    crop_mode: 'auto',
    audio_encoder: 'aac',
    audio_bitrate: 128,
    audio_channels: 'stereo',
    audio_mixdown: 'stereo',
    subtitles: 'first',
    deinterlace: false,
    denoise: 'weak',
    deblock: false,
  },
  'quick-convert': {
    video_encoder: 'x264',
    quality_mode: 'cq',
    quality: 23,
    preset: 'fast',
    container: 'mp4',
    crop_mode: 'auto',
    audio_encoder: 'aac',
    audio_bitrate: 160,
    audio_channels: 'auto',
    audio_mixdown: 'none',
    subtitles: 'all',
    deinterlace: false,
    denoise: 'none',
    deblock: false,
  },
  'mkv-to-mp4': {
    video_encoder: 'copy', // No re-encode
    quality_mode: 'cq',
    quality: 0,
    preset: 'fast',
    container: 'mp4',
    crop_mode: 'none',
    audio_encoder: 'aac',
    audio_bitrate: 160,
    audio_channels: 'auto',
    audio_mixdown: 'none',
    subtitles: 'all',
    deinterlace: false,
    denoise: 'none',
    deblock: false,
  },
};

export const BUILTIN_PRESET_DESCRIPTIONS: Record<string, string> = {
  'high-quality-h265': 'High Quality (H.265) - Best quality with H.265/HEVC encoding',
  'maximum-compression': 'Maximum Compression - Smallest file size with 1080p cap',
  'quick-convert': 'Quick Convert - Fast encoding with H.264, minimal quality loss',
  'mkv-to-mp4': 'MKV to MP4 - Container only conversion, no quality loss',
};

// ============================================================================
// Default Settings
// ============================================================================

export const DEFAULT_SETTINGS: Settings = {
  port: 3000,
  database: '~/.encorr/server/encorr.db',
  cacheDirectory: '~/.encorr/cache',
  autoScan: {
    enabled: true,
    intervalMinutes: 60,
  },
  jobLimits: {
    maxConcurrent: 0, // 0 = unlimited
    maxRetries: 2,
  },
  fileRetention: {
    deleteOriginal: false,
    keepBackup: true,
  },
  handbrake: {
    autoDetect: true,
    defaultPaths: [
      'C:/Program Files/HandBrake/HandBrakeCLI.exe',
      'C:/Program Files (x86)/HandBrake/HandBrakeCLI.exe',
      '/usr/bin/HandBrakeCLI',
      '/usr/local/bin/HandBrakeCLI',
      '/opt/homebrew/bin/HandBrakeCLI',
    ],
  },
};

// ============================================================================
// Default Node Configuration
// ============================================================================

export const DEFAULT_NODE_CONFIG: NodeConfig = {
  serverAddress: 'localhost',
  serverPort: 8101,
  name: '',
  cache_dir: './cache',
  temp_dir: './temp',
  handbrakecli_path: '',
  ffmpeg_dir: '',
  reconnectInterval: 5000,
  heartbeatInterval: 30000,
};

// ============================================================================
// Configuration Schemas
// ============================================================================

export const HandBrakeConfigSchema = z.object({
  video_encoder: z.string(),
  quality_mode: z.enum(['vbr', 'cq', 'constant']),
  quality: z.number(),
  preset: z.string(),
  tune: z.string().optional(),
  container: z.string(),
  max_width: z.number().int().positive().optional(),
  max_height: z.number().int().positive().optional(),
  crop_mode: z.enum(['auto', 'none']).optional(),
  audio_encoder: z.string(),
  audio_bitrate: z.number().int().positive(),
  audio_channels: z.enum(['auto', 'stereo', '5.1', '7.1']).optional(),
  audio_mixdown: z.enum(['none', 'stereo', '5.1']).optional(),
  subtitles: z.enum(['all', 'first', 'none']),
  deinterlace: z.boolean().optional(),
  denoise: z.enum(['none', 'weak', 'medium', 'strong']).optional(),
  deblock: z.boolean().optional(),
  extra_args: z.array(z.string()).optional(),
});

export const NodeConfigSchema = z.object({
  serverAddress: z.string().min(1),
  serverPort: z.number().int().min(1).max(65535).default(8101),
  name: z.string().min(1),
  cache_dir: z.string(),
  temp_dir: z.string(),
  handbrakecli_path: z.string(),
  ffmpeg_dir: z.string(),
  reconnectInterval: z.number().int().min(1000).default(5000),
  heartbeatInterval: z.number().int().min(5000).default(30000),
});

export const SettingsSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3000),
  database: z.string().default('~/.encorr/server/encorr.db'),
  cacheDirectory: z.string().default('~/.encorr/cache'),
  autoScan: z.object({
    enabled: z.boolean().default(true),
    intervalMinutes: z.number().int().min(1).default(60),
  }).default({}),
  jobLimits: z.object({
    maxConcurrent: z.number().int().min(0).default(0),
    maxRetries: z.number().int().min(0).max(10).default(2),
  }).default({}),
  fileRetention: z.object({
    deleteOriginal: z.boolean().default(false),
    keepBackup: z.boolean().default(true),
  }).default({}),
  handbrake: z.object({
    autoDetect: z.boolean().default(true),
    defaultPaths: z.array(z.string()).default([]),
  }).default({}),
});

// ============================================================================
// Path Utilities
// ============================================================================

export function expandPath(path: string): string {
  if (path.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return path.replace('~', home);
  }
  return path;
}

export function normalizePath(path: string): string {
  const expanded = expandPath(path);
  return expanded.replace(/\\/g, '/');
}

// ============================================================================
// Video File Extensions
// ============================================================================

export const VIDEO_EXTENSIONS = [
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
  '.mpg', '.mpeg', '.m2ts', '.ts', '.mts', '.vob', '.ogv', '.3gp',
  '.rm', '.rmvb', '.asf', '.divx', '.xvid', '.f4v', '.mxf',
] as const;

export function isVideoFile(filename: string): boolean {
  const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
  return VIDEO_EXTENSIONS.includes(ext as any);
}

// ============================================================================
// Supported Container/Codec Formats
// ============================================================================

export const SUPPORTED_CONTAINERS = ['mp4', 'mkv', 'avi'] as const;
export const SUPPORTED_VIDEO_CODECS = ['h264', 'h265', 'hevc', 'mpeg2', 'mpeg4', 'vp8', 'vp9', 'av1'] as const;
export const SUPPORTED_AUDIO_CODECS = ['aac', 'ac3', 'dts', 'mp3', 'flac', 'vorbis', 'opus', 'eac3'] as const;

// ============================================================================
// HandBrake Command Builder
// ============================================================================

export interface HandBrakeCommandOptions {
  input: string;
  output: string;
  config: HandBrakeConfig;
}

export function buildHandBrakeCommand(options: HandBrakeCommandOptions): string[] {
  const { input, output, config } = options;
  const args: string[] = [];

  // Input and output
  args.push('-i', input, '-o', output);

  // Container format
  const containerMap: Record<string, string> = {
    mp4: 'mp4',
    mkv: 'mkv',
    avi: 'mp4', // HandBrake doesn't support AVI output
  };
  args.push('-f', containerMap[config.container] || 'mp4');

  // Video encoder
  const encoderMap: Record<string, string> = {
    copy: 'copy',
    x264: 'x264',
    x265: 'x265',
    'h.264': 'x264',
    'h.265': 'x265',
    hevc: 'x265',
  };
  const encoder = encoderMap[config.video_encoder.toLowerCase()] || config.video_encoder;

  if (encoder !== 'copy') {
    args.push('-e', encoder);

    // Quality mode
    if (config.quality_mode === 'cq') {
      args.push('-q', config.quality.toString());
    } else if (config.quality_mode === 'vbr') {
      args.push('-q', config.quality.toString());
    } else if (config.quality_mode === 'constant') {
      args.push('-Q', config.quality.toString());
    }

    // Preset
    args.push('--preset', config.preset);

    // Tune (optional)
    if (config.tune) {
      args.push('--tune', config.tune);
    }

    // Max resolution
    if (config.max_width && config.max_height) {
      args.push('-w', config.max_width.toString(), '-l', config.max_height.toString());
    }

    // Deblock filter
    if (config.deblock) {
      args.push('--deblock', '1:0:2:1');
    }
  } else {
    // Direct copy
    args.push('-e', 'copy');
  }

  // Audio settings
  args.push('-E', config.audio_encoder);

  if (config.audio_channels === 'stereo') {
    args.push('--audio-channels', '2');
  } else if (config.audio_channels === '5.1') {
    args.push('--audio-channels', '6');
  } else if (config.audio_channels === '7.1') {
    args.push('--audio-channels', '8');
  }

  if (config.audio_mixdown && config.audio_mixdown !== 'none') {
    args.push('--audio-mixdown', config.audio_mixdown);
  }

  if (config.audio_bitrate) {
    args.push('-B', config.audio_bitrate.toString());
  }

  // Subtitle settings
  if (config.subtitles === 'all') {
    args.push('--all-subtitles');
  } else if (config.subtitles === 'first') {
    args.push('--first-subtitle');
  } else if (config.subtitles === 'none') {
    args.push('-N', 'none');
  }

  // Filters
  if (config.deinterlace) {
    args.push('--deinterlace', 'slow');
  }

  if (config.denoise && config.denoise !== 'none') {
    const strength: Record<string, string> = {
      weak: '0:1:1:1',
      medium: '2:1:2:1',
      strong: '3:2:2:3',
    };
    args.push('--denoise', strength[config.denoise] || 'weak');
  }

  // Extra arguments
  if (config.extra_args && config.extra_args.length > 0) {
    args.push(...config.extra_args);
  }

  return args;
}

// ============================================================================
// CLI Progress Parsing
// ============================================================================

export interface HandBrakeProgress {
  progress: number; // 0-100
  current_action: string;
  fps?: number;
  avg_fps?: number;
  eta_seconds?: number;
  current_pass?: number;
  total_passes?: number;
}

export function parseHandBrakeProgress(line: string): HandBrakeProgress | null {
  // Example HandBrake output:
  // Encoding: task 1 of 1, 23.45 % (150.23 fps, avg 145.67 fps, ETA 00h02m15s)
  // Encoding: task 1 of 2, 45.67 % (123.45 fps, avg 120.34 fps, ETA 00h01m30s)
  // Scanning title 1 of 1...
  // Encoding movie...

  const encodingMatch = line.match(/Encoding:\s+task\s+(\d+)\s+of\s+(\d+),\s+([\d.]+)\s+%/);

  if (encodingMatch) {
    const currentPass = parseInt(encodingMatch[1], 10);
    const totalPasses = parseInt(encodingMatch[2], 10);
    const progress = parseFloat(encodingMatch[3]);

    // Extract FPS and ETA
    const fpsMatch = line.match(/\(([\d.]+)\s+fps/);
    const avgFpsMatch = line.match(/avg\s+([\d.]+)\s+fps/);
    const etaMatch = line.match(/ETA\s+(\d+)h(\d+)m(\d+)s/);

    let eta_seconds: number | undefined;
    if (etaMatch) {
      const hours = parseInt(etaMatch[1], 10);
      const minutes = parseInt(etaMatch[2], 10);
      const seconds = parseInt(etaMatch[3], 10);
      eta_seconds = hours * 3600 + minutes * 60 + seconds;
    }

    return {
      progress,
      current_action: totalPasses > 1 ? `Encoding pass ${currentPass}/${totalPasses}` : 'Encoding',
      fps: fpsMatch ? parseFloat(fpsMatch[1]) : undefined,
      avg_fps: avgFpsMatch ? parseFloat(avgFpsMatch[1]) : undefined,
      eta_seconds,
      current_pass: currentPass,
      total_passes: totalPasses,
    };
  }

  // Scan in progress
  if (line.includes('Scanning')) {
    return {
      progress: 0,
      current_action: 'Scanning source file',
    };
  }

  // Work started
  if (line.includes('Encoding') && !line.includes('%')) {
    return {
      progress: 0,
      current_action: 'Starting encode',
    };
  }

  return null;
}
