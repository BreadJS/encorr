// Full HandBrake preset configuration
export interface PresetConfig {
  format: string;
  video_encoder: string;
  quality: number;
  quality_type: 'rf' | 'bitrate';
  resolution: string;
  width?: number;
  height?: number;
  framerate: string;
  framerate_mode: string;
  audio_encoder: string;
  audio_bitrate: number;
  audio_mixdown: string;
  encoder_preset?: string;
  encoder_tune?: string;
  multipass?: boolean;
  turbo?: boolean;
  denoise?: 'none' | 'ultralight' | 'light' | 'medium' | 'strong';
  sharpen?: 'none' | 'ultralight' | 'light' | 'medium' | 'strong';
  deinterlace?: boolean;
  decomb?: boolean;
  detelecine?: boolean;
  deblock?: boolean;
  grayscale?: boolean;
  optimize_mp4?: boolean;
  ipod_atom?: boolean;
  markers?: boolean;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  is_builtin: boolean;
  config: PresetConfig;
}

// Default configuration that all built-in presets extend from
export const defaultConfig: PresetConfig = {
  format: 'av_mp4',
  video_encoder: 'x265',
  quality: 22,
  quality_type: 'rf',
  resolution: 'source',
  width: undefined,
  height: undefined,
  framerate: 'source',
  framerate_mode: 'vfr',
  audio_encoder: 'av_aac',
  audio_bitrate: 160,
  audio_mixdown: 'stereo',
  encoder_preset: 'medium',
  multipass: false,
  denoise: 'none',
  sharpen: 'none',
  deinterlace: false,
  decomb: false,
  detelecine: false,
  deblock: false,
  grayscale: false,
  optimize_mp4: false,
  ipod_atom: false,
  markers: true,
};

// Built-in presets (cannot be deleted)
export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'builtin-high-quality',
    name: 'High Quality H.265',
    description: 'Best quality for archiving with good compression',
    is_builtin: true,
    config: { ...defaultConfig, format: 'av_mkv', video_encoder: 'x265', quality: 20, encoder_preset: 'slow' },
  },
  {
    id: 'builtin-max-compression',
    name: 'Maximum Compression',
    description: 'Smallest file size, slower encoding',
    is_builtin: true,
    config: { ...defaultConfig, format: 'av_mkv', video_encoder: 'x265', quality: 28, resolution: '1080', encoder_preset: 'slow', multipass: true },
  },
  {
    id: 'builtin-fast-1080p',
    name: 'Fast 1080p H.264',
    description: 'Quick conversion with good quality',
    is_builtin: true,
    config: { ...defaultConfig, format: 'av_mp4', video_encoder: 'x264', quality: 23, resolution: '1080', encoder_preset: 'fast' },
  },
  {
    id: 'builtin-gpu-nvenc',
    name: 'GPU Accelerated (NVENC)',
    description: 'Fast encoding using NVIDIA GPU',
    is_builtin: true,
    config: { ...defaultConfig, format: 'av_mp4', video_encoder: 'nvenc_h265', quality: 24 },
  },
  {
    id: 'builtin-mkv-to-mp4',
    name: 'MKV to MP4 (No Re-encode)',
    description: 'Fast container change, passthru video/audio',
    is_builtin: true,
    config: { ...defaultConfig, format: 'av_mp4', video_encoder: 'copy', audio_encoder: 'copy' },
  },
  {
    id: 'builtin-mobile',
    name: 'Mobile/Tablet',
    description: 'Optimized for mobile devices',
    is_builtin: true,
    config: { ...defaultConfig, format: 'av_mp4', video_encoder: 'x264', quality: 24, resolution: '720', encoder_preset: 'fast', optimize_mp4: true },
  },
];

// User presets (custom presets created by users)
// These would typically come from the API, but we have some examples here
export const USER_PRESETS: Preset[] = [
  {
    id: 'user-custom-1',
    name: 'My 4K Movies',
    description: 'Personal 4K movie preset',
    is_builtin: false,
    config: { ...defaultConfig, format: 'av_mkv', video_encoder: 'x265', quality: 18, resolution: '2160', encoder_preset: 'slow' },
  },
  {
    id: 'user-custom-2',
    name: 'TV Shows Fast',
    description: 'Quick TV show encoding',
    is_builtin: false,
    config: { ...defaultConfig, format: 'av_mp4', video_encoder: 'x264', quality: 22, resolution: '1080', encoder_preset: 'fast' },
  },
];

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
  format: string;
  encoder: string;
  quality: number;
}

// Get presets formatted for dropdown components
export function getPresetsForDropdown(): PresetDropdownOption[] {
  return [...BUILTIN_PRESETS, ...USER_PRESETS].map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    is_builtin: p.is_builtin,
    format: p.config.format.replace('av_', '') as any,
    encoder: p.config.video_encoder,
    quality: p.config.quality,
  }));
}
