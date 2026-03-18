import { z } from 'zod';
import type { Settings, NodeConfig, FFmpegConfig, FFmpegEncoderInfo } from '../types';

// ============================================================================
// Default Built-in Presets
// ============================================================================

export const BUILTIN_PRESETS: Record<string, FFmpegConfig> = {
  'high-quality-h265-cpu': {
    video_codec: 'h265',
    encoding_type: 'cpu',
    quality_mode: 'crf',
    quality: 22,
    preset: 'medium',
    container: 'mkv',
    audio_encoder: 'copy',
    audio_bitrate: 0,
    subtitles: 'all',
    deinterlace: false,
  },
  'maximum-compression-h265-cpu': {
    video_codec: 'h265',
    encoding_type: 'cpu',
    quality_mode: 'crf',
    quality: 28,
    preset: 'slow',
    container: 'mkv',
    max_width: 1920,
    max_height: 1080,
    audio_encoder: 'copy',
    audio_bitrate: 0, // Not used when copying
    subtitles: 'first',
    deinterlace: false,
  },
  'fast-h264-cpu': {
    video_codec: 'h264',
    encoding_type: 'cpu',
    quality_mode: 'crf',
    quality: 23,
    preset: 'fast',
    container: 'mkv',
    audio_encoder: 'copy',
    audio_bitrate: 0,
    subtitles: 'all',
    deinterlace: false,
  },
  'nvidia-h264-gpu': {
    video_codec: 'h264',
    encoding_type: 'gpu',
    gpu_type: 'nvidia',
    quality_mode: 'cq',
    quality: 22,
    preset: 'fast',
    container: 'mkv',
    audio_encoder: 'copy',
    audio_bitrate: 0,
    subtitles: 'all',
    deinterlace: false,
  },
  'nvidia-h265-gpu': {
    video_codec: 'h265',
    encoding_type: 'gpu',
    gpu_type: 'nvidia',
    quality_mode: 'cq',
    quality: 24,
    preset: 'fast',
    container: 'mkv',
    audio_encoder: 'copy',
    audio_bitrate: 0,
    subtitles: 'all',
    deinterlace: false,
  },
  'intel-h264-gpu': {
    video_codec: 'h264',
    encoding_type: 'gpu',
    gpu_type: 'intel',
    quality_mode: 'crf',
    quality: 22,
    preset: 'medium',
    container: 'mkv',
    audio_encoder: 'copy',
    audio_bitrate: 0,
    subtitles: 'all',
    deinterlace: false,
  },
  'intel-h265-gpu': {
    video_codec: 'h265',
    encoding_type: 'gpu',
    gpu_type: 'intel',
    quality_mode: 'crf',
    quality: 24,
    preset: 'medium',
    container: 'mkv',
    audio_encoder: 'copy',
    audio_bitrate: 0,
    subtitles: 'all',
    deinterlace: false,
  },
  'amd-h264-gpu': {
    video_codec: 'h264',
    encoding_type: 'gpu',
    gpu_type: 'amd',
    quality_mode: 'qp',
    quality: 22,
    preset: 'fast',
    container: 'mkv',
    audio_encoder: 'copy',
    audio_bitrate: 0,
    subtitles: 'all',
    deinterlace: false,
  },
  'amd-h265-gpu': {
    video_codec: 'h265',
    encoding_type: 'gpu',
    gpu_type: 'amd',
    quality_mode: 'qp',
    quality: 24,
    preset: 'fast',
    container: 'mkv',
    audio_encoder: 'copy',
    audio_bitrate: 0,
    subtitles: 'all',
    deinterlace: false,
  },
};

export const BUILTIN_PRESET_DESCRIPTIONS: Record<string, string> = {
  'high-quality-h265-cpu': 'High Quality H.265 (CPU) - Best quality with H.265/HEVC CPU encoding',
  'maximum-compression-h265-cpu': 'Maximum Compression H.265 (CPU) - Smallest file size with H.265 and 1080p cap',
  'fast-h264-cpu': 'Fast H.264 (CPU) - Fast encoding with H.264, minimal quality loss',
  'nvidia-h264-gpu': 'NVIDIA H.264 (GPU) - GPU-accelerated encoding with NVIDIA NVENC H.264',
  'nvidia-h265-gpu': 'NVIDIA H.265 (GPU) - GPU-accelerated encoding with NVIDIA NVENC H.265',
  'intel-h264-gpu': 'Intel Quick Sync H.264 (GPU) - GPU-accelerated encoding with Intel QSV H.264',
  'intel-h265-gpu': 'Intel Quick Sync H.265 (GPU) - GPU-accelerated encoding with Intel QSV H.265',
  'amd-h264-gpu': 'AMD AMF H.264 (GPU) - GPU-accelerated encoding with AMD AMF H.264',
  'amd-h265-gpu': 'AMD AMF H.265 (GPU) - GPU-accelerated encoding with AMD AMF H.265',
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
  ffmpeg_dir: '',
  reconnectInterval: 5000,
  heartbeatInterval: 30000,
};

// ============================================================================
// Configuration Schemas
// ============================================================================

export const FFmpegConfigSchema = z.object({
  video_codec: z.enum(['h264', 'h265']),
  encoding_type: z.enum(['cpu', 'gpu']),
  gpu_type: z.enum(['nvidia', 'intel', 'amd']).optional(),
  quality_mode: z.enum(['crf', 'cq', 'qp']),
  quality: z.number(),
  preset: z.string(),
  container: z.string(),
  max_width: z.number().int().positive().optional(),
  max_height: z.number().int().positive().optional(),
  audio_encoder: z.string(),
  audio_bitrate: z.number().int().positive(),
  subtitles: z.enum(['all', 'first', 'none']),
  deinterlace: z.boolean().optional(),
  extra_args: z.array(z.string()).optional(),
});

export const NodeConfigSchema = z.object({
  serverAddress: z.string().min(1),
  serverPort: z.number().int().min(1).max(65535).default(8101),
  name: z.string().min(1),
  cache_dir: z.string(),
  temp_dir: z.string(),
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
  // Common formats
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
  '.mpg', '.mpeg', '.m2ts', '.ts', '.mts', '.vob', '.ogv', '.3gp',
  '.rm', '.rmvb', '.asf', '.divx', '.xvid', '.f4v', '.mxf',
  // Additional MPEG formats
  '.mp2', '.m2v', '.m1v', '.mv2', '.mt2s',
  // Mobile/portable formats
  '.3g2', '.amv',
  // Flash/F4V variants
  '.f4p', '.f4a', '.f4b',
  // QuickTime variants
  '.qt', '.yuv',
  // Windows TV/recording formats
  '.wtv', '.dvr-ms', '.vro',
  // Old game video formats
  '.bik', '.smk',
  // Nullsoft video
  '.nsv',
  // Ogg video (rare but valid)
  '.drc',
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
// FFmpeg Encoder Configuration
// ============================================================================

// Re-export FFmpegEncoderInfo from types for convenience
export type { FFmpegEncoderInfo } from '../types';

export const ENCODER_MAP: Record<string, FFmpegEncoderInfo> = {
  'cpu-h264': {
    type: 'cpu',
    encoder_name: 'libx264',
    codec: 'h264',
    available: true,
  },
  'cpu-h265': {
    type: 'cpu',
    encoder_name: 'libx265',
    codec: 'h265',
    available: true,
  },
  'nvidia-h264': {
    type: 'gpu',
    gpu_type: 'nvidia',
    encoder_name: 'h264_nvenc',
    codec: 'h264',
    available: true,
  },
  'nvidia-h265': {
    type: 'gpu',
    gpu_type: 'nvidia',
    encoder_name: 'hevc_nvenc',
    codec: 'h265',
    available: true,
  },
  'intel-h264': {
    type: 'gpu',
    gpu_type: 'intel',
    encoder_name: 'h264_qsv',
    codec: 'h264',
    available: true,
  },
  'intel-h265': {
    type: 'gpu',
    gpu_type: 'intel',
    encoder_name: 'hevc_qsv',
    codec: 'h265',
    available: true,
  },
  'amd-h264': {
    type: 'gpu',
    gpu_type: 'amd',
    encoder_name: 'h264_amf',
    codec: 'h264',
    available: true,
  },
  'amd-h265': {
    type: 'gpu',
    gpu_type: 'amd',
    encoder_name: 'hevc_amf',
    codec: 'h265',
    available: true,
  },
};