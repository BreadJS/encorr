// FFmpeg preset configuration
export interface PresetConfig {
  video_codec: 'h264' | 'h265';
  encoding_type: 'cpu' | 'gpu';
  gpu_type?: 'nvidia' | 'intel' | 'amd';
  quality_mode: 'crf' | 'cq' | 'qp';
  quality: number;
  preset: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower';
  container: 'mp4' | 'mkv';
  audio_encoder: 'aac' | 'opus' | 'mp3';
  audio_bitrate: number;
  subtitles: 'all' | 'first' | 'none';
  max_width?: number;
  max_height?: number;
  deinterlace?: boolean;
  extra_args?: string[];
}

// Default configuration for new presets
export const defaultConfig: PresetConfig = {
  video_codec: 'h264',
  encoding_type: 'cpu',
  quality_mode: 'crf',
  quality: 23,
  preset: 'medium',
  container: 'mkv',
  audio_encoder: 'copy',
  audio_bitrate: 0, // Not used when copying
  subtitles: 'all',
  deinterlace: false,
};

export interface Preset {
  id: string;
  name: string;
  description: string;
  is_builtin: boolean;
  config: PresetConfig;
}

// Built-in presets (cannot be deleted) - FFmpeg compatible
export const BUILTIN_PRESETS: Preset[] = [
  // CPU Presets
  {
    id: 'builtin-high-quality-h265-cpu',
    name: 'High Quality H.265 (CPU)',
    description: 'High quality with H.265/HEVC CPU encoding',
    is_builtin: true,
    config: {
      video_codec: 'h265',
      encoding_type: 'cpu',
      quality_mode: 'crf',
      quality: 22,
      preset: 'medium',
      container: 'mkv',
      audio_encoder: 'copy',
      audio_bitrate: 0, // Not used when copying
      subtitles: 'all',
    },
  },
  {
    id: 'builtin-max-compression-h265-cpu',
    name: 'Maximum Compression H.265 (CPU)',
    description: 'Smallest file size with H.265 and 1080p cap',
    is_builtin: true,
    config: {
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
    },
  },
  {
    id: 'builtin-fast-h264-cpu',
    name: 'Fast H.264 (CPU)',
    description: 'Fast encoding with H.264, minimal quality loss',
    is_builtin: true,
    config: {
      video_codec: 'h264',
      encoding_type: 'cpu',
      quality_mode: 'crf',
      quality: 23,
      preset: 'fast',
      container: 'mkv',
      audio_encoder: 'copy',
      audio_bitrate: 0, // Not used when copying
      subtitles: 'all',
    },
  },
  {
    id: 'builtin-mobile-h264-cpu',
    name: 'Mobile Optimized H.264 (CPU)',
    description: 'Optimized for mobile devices with 720p cap',
    is_builtin: true,
    config: {
      video_codec: 'h264',
      encoding_type: 'cpu',
      quality_mode: 'crf',
      quality: 24,
      preset: 'fast',
      container: 'mkv',
      max_width: 1280,
      max_height: 720,
      audio_encoder: 'copy',
      audio_bitrate: 0, // Not used when copying
      subtitles: 'first',
    },
  },
  // NVIDIA GPU Presets
  {
    id: 'builtin-nvidia-h264-gpu',
    name: 'NVIDIA H.264 (GPU)',
    description: 'GPU-accelerated encoding with NVIDIA NVENC H.264',
    is_builtin: true,
    config: {
      video_codec: 'h264',
      encoding_type: 'gpu',
      gpu_type: 'nvidia',
      quality_mode: 'cq',
      quality: 22,
      preset: 'fast',
      container: 'mkv',
      audio_encoder: 'copy',
      audio_bitrate: 0, // Not used when copying
      subtitles: 'all',
    },
  },
  {
    id: 'builtin-nvidia-h265-gpu',
    name: 'NVIDIA H.265 (GPU)',
    description: 'GPU-accelerated encoding with NVIDIA NVENC H.265',
    is_builtin: true,
    config: {
      video_codec: 'h265',
      encoding_type: 'gpu',
      gpu_type: 'nvidia',
      quality_mode: 'cq',
      quality: 24,
      preset: 'fast',
      container: 'mkv',
      audio_encoder: 'copy',
      audio_bitrate: 0, // Not used when copying
      subtitles: 'all',
    },
  },
  // Intel GPU Presets
  {
    id: 'builtin-intel-h264-gpu',
    name: 'Intel Quick Sync H.264 (GPU)',
    description: 'GPU-accelerated encoding with Intel QSV H.264',
    is_builtin: true,
    config: {
      video_codec: 'h264',
      encoding_type: 'gpu',
      gpu_type: 'intel',
      quality_mode: 'crf',
      quality: 22,
      preset: 'medium',
      container: 'mkv',
      audio_encoder: 'copy',
      audio_bitrate: 0, // Not used when copying
      subtitles: 'all',
    },
  },
  {
    id: 'builtin-intel-h265-gpu',
    name: 'Intel Quick Sync H.265 (GPU)',
    description: 'GPU-accelerated encoding with Intel QSV H.265',
    is_builtin: true,
    config: {
      video_codec: 'h265',
      encoding_type: 'gpu',
      gpu_type: 'intel',
      quality_mode: 'crf',
      quality: 24,
      preset: 'medium',
      container: 'mkv',
      audio_encoder: 'copy',
      audio_bitrate: 0, // Not used when copying
      subtitles: 'all',
    },
  },
  // AMD GPU Presets
  {
    id: 'builtin-amd-h264-gpu',
    name: 'AMD AMF H.264 (GPU)',
    description: 'GPU-accelerated encoding with AMD AMF H.264',
    is_builtin: true,
    config: {
      video_codec: 'h264',
      encoding_type: 'gpu',
      gpu_type: 'amd',
      quality_mode: 'qp',
      quality: 22,
      preset: 'fast',
      container: 'mkv',
      audio_encoder: 'copy',
      audio_bitrate: 0, // Not used when copying
      subtitles: 'all',
    },
  },
  {
    id: 'builtin-amd-h265-gpu',
    name: 'AMD AMF H.265 (GPU)',
    description: 'GPU-accelerated encoding with AMD AMF H.265',
    is_builtin: true,
    config: {
      video_codec: 'h265',
      encoding_type: 'gpu',
      gpu_type: 'amd',
      quality_mode: 'qp',
      quality: 24,
      preset: 'fast',
      container: 'mkv',
      audio_encoder: 'copy',
      audio_bitrate: 0, // Not used when copying
      subtitles: 'all',
    },
  },
  // Analyze preset
  {
    id: 'builtin-analyze',
    name: 'Analyze Only',
    description: 'Extract file metadata without transcoding',
    is_builtin: true,
    config: {
      video_codec: 'h264',
      encoding_type: 'cpu',
      quality_mode: 'crf',
      quality: 23,
      preset: 'medium',
      container: 'mkv',
      audio_encoder: 'copy',
      audio_bitrate: 0, // Not used when copying
      subtitles: 'all',
    } as PresetConfig & { action: 'analyze' },
  },
];

// User presets (custom presets created by users)
export const USER_PRESETS: Preset[] = [];

// Helper to get all presets (combined)
export function getAllPresets(): Preset[] {
  return [...BUILTIN_PRESETS, ...USER_PRESETS];
}

// Format for preset dropdowns (simplified info)
export interface PresetDropdownOption {
  id: string;
  name: string;
  description: string;
  is_builtin: boolean;
  codec: string;
  type: string;
  gpu?: string;
  quality: number;
}

// Get presets formatted for dropdown components
export function getPresetsForDropdown(): PresetDropdownOption[] {
  return getAllPresets().map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    is_builtin: p.is_builtin,
    codec: p.config.video_codec,
    type: p.config.encoding_type,
    gpu: p.config.gpu_type,
    quality: p.config.quality,
  }));
}
