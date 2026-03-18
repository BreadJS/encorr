// ============================================================================
// Smart Transcoding Optimizer Types
// ============================================================================

import type { EncoderType, GPUVendor } from './index';

// Re-export VideoCodec for convenience
export type VideoCodec = 'h264' | 'h265';

// ============================================================================
// Hardware Detection Types
// ============================================================================

export interface FFmpegDecoderInfo {
  type: EncoderType;
  gpu_type?: GPUVendor;
  decoder_name: string;
  codec: VideoCodec;
  available: boolean;
}

export interface HwaccelInfo {
  name: string;
  available: boolean;
}

// ============================================================================
// File Analysis Types
// ============================================================================

export interface FileAnalysis {
  // Basic video properties
  codec: string;
  resolution: string;
  bitrate: number;
  hasHdr: boolean;
  bitDepth: number;
  duration: number;
  size: number;

  // Derived properties
  width: number;
  height: number;
  fps: number;
  container: string;

  // Codec family (normalized)
  codecFamily: 'h264' | 'h265' | 'other';

  // Size category
  sizeCategory: 'small' | 'medium' | 'large' | 'xlarge';

  // Bitrate category
  bitrateCategory: 'low' | 'medium' | 'high' | 'veryhigh';
}

// ============================================================================
// Optimization Result Types
// ============================================================================

export type TranscodeMode = 'auto' | 'gpu' | 'cpu';
export type CpuUsageLevel = 'low' | 'medium' | 'high';
export type GpuUtilizationLevel = 'none' | 'low' | 'medium' | 'high';
export type SpeedLevel = 'slow' | 'medium' | 'fast';

export interface OptimizationResult {
  recommendedPresetId: string;
  reason: string;
  expectedCompression: string;
  cpuUsage: CpuUsageLevel;
  gpuUtilization: GpuUtilizationLevel;
  speed: SpeedLevel;

  // Additional details
  details?: {
    sourceCodec: string;
    targetCodec: string;
    encodingType: EncoderType;
    gpuType?: GPUVendor;
    estimatedTime?: string;
    notes?: string[];
  };
}

// ============================================================================
// Smart Transcoding Request Types
// ============================================================================

export interface SmartTranscodeRequest {
  file_ids: string[];
  mode: TranscodeMode;
  preset_id?: string; // Optional: user-selected preset (for GPU/CPU modes)
}

export interface SmartTranscodeResult {
  success: boolean;
  jobs: SmartTranscodeJobResult[];
  summary: {
    total: number;
    gpu: number;
    cpu: number;
    totalOriginalSize: number;
    estimatedOutputSize: number;
    estimatedSpaceSaved: number;
  };
}

export interface SmartTranscodeJobResult {
  fileId: string;
  jobId: string;
  fileName: string;
  presetId: string;
  presetName: string;
  reason: string;
  expectedCompression: string;
  originalSize: number;
  estimatedSize: number;
  mode: TranscodeMode;
}

// ============================================================================
// User Settings Types
// ============================================================================

export interface TranscodeUserSettings {
  defaultTranscodeMode: TranscodeMode;
  preferredCodec: 'h264' | 'h265';
  qualityTarget: 'space' | 'speed' | 'balanced';
  autoDetectHdr: boolean;
  force8BitForGpu: boolean;
}
