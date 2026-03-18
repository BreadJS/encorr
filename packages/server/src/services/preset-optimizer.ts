// ============================================================================
// Smart Preset Optimizer Service
// ============================================================================

import type {
  FileAnalysis,
  OptimizationResult,
  TranscodeMode,
  EncoderType,
  GPUVendor,
  Node,
  Preset,
  FFmpegDecoderInfo,
  HwaccelInfo,
  VideoMetadata,
  CpuUsageLevel,
  GpuUtilizationLevel,
  SpeedLevel,
} from '@encorr/shared';

// ============================================================================
// Preset Optimizer Service
// ============================================================================

export class PresetOptimizer {
  /**
   * Analyzes file metadata and returns a comprehensive file analysis.
   */
  analyzeFile(metadata: VideoMetadata, fileSize: number): FileAnalysis {
    // Normalize codec name
    const codecLower = metadata.video_codec.toLowerCase();
    let codecFamily: 'h264' | 'h265' | 'other';
    if (codecLower.includes('264') || codecLower.includes('avc')) {
      codecFamily = 'h264';
    } else if (codecLower.includes('265') || codecLower.includes('hevc')) {
      codecFamily = 'h265';
    } else {
      codecFamily = 'other';
    }

    // Categorize file size
    let sizeCategory: 'small' | 'medium' | 'large' | 'xlarge';
    if (fileSize < 500 * 1024 * 1024) { // < 500 MB
      sizeCategory = 'small';
    } else if (fileSize < 2 * 1024 * 1024 * 1024) { // < 2 GB
      sizeCategory = 'medium';
    } else if (fileSize < 5 * 1024 * 1024 * 1024) { // < 5 GB
      sizeCategory = 'large';
    } else {
      sizeCategory = 'xlarge';
    }

    // Categorize bitrate
    let bitrateCategory: 'low' | 'medium' | 'high' | 'veryhigh';
    if (metadata.bitrate < 2000000) { // < 2 Mbps
      bitrateCategory = 'low';
    } else if (metadata.bitrate < 5000000) { // < 5 Mbps
      bitrateCategory = 'medium';
    } else if (metadata.bitrate < 10000000) { // < 10 Mbps
      bitrateCategory = 'high';
    } else {
      bitrateCategory = 'veryhigh';
    }

    // Detect HDR from bit depth
    const bitDepth = metadata.bit_depth ?? 8; // Default to 8-bit if not specified
    const hasHdr = bitDepth > 8;

    // Get resolution
    const resolution = `${metadata.width}x${metadata.height}`;

    return {
      codec: metadata.video_codec,
      resolution,
      bitrate: metadata.bitrate,
      hasHdr,
      bitDepth,
      duration: metadata.duration,
      size: fileSize,
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
      container: metadata.container,
      codecFamily,
      sizeCategory,
      bitrateCategory,
    };
  }

  /**
   * Recommends the optimal preset for a given file based on analysis and available hardware.
   */
  recommendForFile(
    analysis: FileAnalysis,
    nodes: Node[],
    presets: Preset[],
    mode: TranscodeMode = 'auto'
  ): OptimizationResult {
    // Get available hardware capabilities from all online nodes
    const hardwareCaps = this.getHardwareCapabilities(nodes);

    // Determine the best encoding strategy
    const strategy = this.determineStrategy(analysis, hardwareCaps, mode);

    // Find the best preset for this strategy
    const preset = this.findBestPreset(presets, strategy);

    // Build the result
    return this.buildOptimizationResult(analysis, preset, strategy);
  }

  /**
   * Determines the best encoding strategy based on file analysis and hardware capabilities.
   */
  private determineStrategy(
    analysis: FileAnalysis,
    hardwareCaps: HardwareCapabilities,
    mode: TranscodeMode
  ): EncodingStrategy {
    // User explicitly chose CPU mode
    if (mode === 'cpu') {
      return {
        encodingType: 'cpu',
        gpuType: undefined,
        targetCodec: this.getTargetCodec(analysis, 'cpu'),
        reason: 'CPU encoding selected by user',
        forceExplicitDecoder: false,
      };
    }

    // User explicitly chose GPU mode
    if (mode === 'gpu') {
      const gpuType = this.selectBestGpu(hardwareCaps);
      if (gpuType) {
        return {
          encodingType: 'gpu',
          gpuType,
          targetCodec: this.getTargetCodec(analysis, 'gpu'),
          reason: `GPU encoding (${gpuType}) selected by user`,
          forceExplicitDecoder: true, // Use explicit decoder for true GPU pipeline
        };
      }
      // Fall back to CPU if no GPU available
      return {
        encodingType: 'cpu',
        gpuType: undefined,
        targetCodec: this.getTargetCodec(analysis, 'cpu'),
        reason: 'GPU encoding selected but no compatible GPU available, using CPU',
        forceExplicitDecoder: false,
      };
    }

    // Auto mode - intelligent selection
    return this.determineAutoStrategy(analysis, hardwareCaps);
  }

  /**
   * Auto mode strategy determination - makes smart choices based on file and hardware.
   * Primary goal: SPACE REDUCTION using H.265
   */
  private determineAutoStrategy(
    analysis: FileAnalysis,
    hardwareCaps: HardwareCapabilities
  ): EncodingStrategy {
    const hasNvidiaGpu = hardwareCaps.nvidia.hasGpu;
    const hasIntelGpu = hardwareCaps.intel.hasGpu;
    const hasAmdGpu = hardwareCaps.amd.hasGpu;
    const hasAnyGpu = hasNvidiaGpu || hasIntelGpu || hasAmdGpu;

    // Primary strategy: Always target H.265 for space reduction
    // Use GPU when available for speed, otherwise use CPU
    if (hasNvidiaGpu) {
      return {
        encodingType: 'gpu',
        gpuType: 'nvidia',
        targetCodec: 'h265',
        reason: `Converting ${analysis.codecFamily.toUpperCase()} to H.265 with GPU for maximum space savings`,
        forceExplicitDecoder: true,
      };
    }

    if (hasIntelGpu) {
      return {
        encodingType: 'gpu',
        gpuType: 'intel',
        targetCodec: 'h265',
        reason: `Converting ${analysis.codecFamily.toUpperCase()} to H.265 with Intel QSV for space savings`,
        forceExplicitDecoder: true,
      };
    }

    if (hasAmdGpu) {
      return {
        encodingType: 'gpu',
        gpuType: 'amd',
        targetCodec: 'h265',
        reason: `Converting ${analysis.codecFamily.toUpperCase()} to H.265 with AMD AMF for space savings`,
        forceExplicitDecoder: true,
      };
    }

    // No GPU available - use CPU
    return {
      encodingType: 'cpu',
      gpuType: undefined,
      targetCodec: 'h265',
      reason: `Converting ${analysis.codecFamily.toUpperCase()} to H.265 with CPU for space savings (slower)`,
      forceExplicitDecoder: false,
    };
  }

  /**
   * Determines the target codec based on source codec and encoding type.
   * GPU mode ALWAYS targets H.265 for maximum space savings.
   */
  private getTargetCodec(analysis: FileAnalysis, encodingType: EncoderType): 'h264' | 'h265' {
    // GPU mode: ALWAYS use H.265 for space reduction
    // Even if source is H.265, we re-encode to potentially reduce bitrate
    if (encodingType === 'gpu') {
      return 'h265';
    }

    // CPU mode: be more selective due to processing time
    if (analysis.codecFamily === 'h265') {
      // H.265 source - keep as H.265 to reduce bitrate further
      return 'h265';
    }
    // H.264 source - convert to H.265 for space savings
    if (analysis.bitrateCategory === 'high' || analysis.bitrateCategory === 'veryhigh') {
      return 'h265'; // High bitrate files benefit from H.265 compression
    }
    return 'h265'; // Default to H.265 for compression
  }

  /**
   * Selects the best GPU type from available hardware.
   */
  private selectBestGpu(hardwareCaps: HardwareCapabilities): GPUVendor | undefined {
    // Priority: NVIDIA > Intel > AMD
    if (hardwareCaps.nvidia.hasGpu) {
      return 'nvidia';
    }
    if (hardwareCaps.intel.hasGpu) {
      return 'intel';
    }
    if (hardwareCaps.amd.hasGpu) {
      return 'amd';
    }
    return undefined;
  }

  /**
   * Finds the best preset for a given strategy from available presets.
   */
  private findBestPreset(presets: Preset[], strategy: EncodingStrategy): Preset {
    // Filter presets by encoding type and codec
    const matchingPresets = presets.filter(preset => {
      const config = preset.config;
      return config.encoding_type === strategy.encodingType &&
        config.video_codec === strategy.targetCodec &&
        (!strategy.gpuType || config.gpu_type === strategy.gpuType);
    });

    // Prioritize built-in presets for consistency
    const builtinPresets = matchingPresets.filter(p => p.is_builtin);
    const candidates = builtinPresets.length > 0 ? builtinPresets : matchingPresets;

    // Select based on file characteristics
    if (candidates.length === 0) {
      // Fallback to any preset that matches encoding type
      return presets.find(p => p.config.encoding_type === strategy.encodingType) || presets[0];
    }

    // For space optimization, prefer presets with higher quality (lower number = more compression)
    // For CPU, prefer slower presets (better compression)
    // For GPU, preset affects speed more than quality

    if (strategy.encodingType === 'cpu') {
      // Find "Maximum Compression" or "slow" preset
      const maxCompression = candidates.find(p =>
        p.id.includes('max-compression') || p.config.preset === 'slow'
      );
      if (maxCompression) return maxCompression;
    }

    // For GPU or fallback, use fast preset
    const fastPreset = candidates.find(p =>
      p.id.includes('fast') || p.config.preset === 'fast'
    );
    if (fastPreset) return fastPreset;

    // Default to first match
    return candidates[0];
  }

  /**
   * Builds the optimization result from analysis, preset, and strategy.
   */
  private buildOptimizationResult(
    analysis: FileAnalysis,
    preset: Preset,
    strategy: EncodingStrategy
  ): OptimizationResult {
    // Determine expected compression ratio
    const expectedCompression = this.estimateCompression(analysis, preset);

    // Determine CPU usage level
    const cpuUsage: CpuUsageLevel = strategy.encodingType === 'cpu' ? 'high' : 'low';

    // Determine GPU utilization level
    const gpuUtilization: GpuUtilizationLevel = strategy.encodingType === 'gpu' ? 'high' : 'none';

    // Determine speed
    const speed: SpeedLevel = strategy.encodingType === 'gpu' ? 'fast' : 'medium';

    // Build notes
    const notes: string[] = [];
    if (analysis.hasHdr && preset.config.video_codec === 'h264' && strategy.encodingType === 'gpu') {
      notes.push('HDR content will be converted to SDR for H.264 GPU encoding');
    }
    if (analysis.bitDepth > 8 && preset.config.video_codec === 'h264') {
      notes.push('10-bit source will be converted to 8-bit for H.264');
    }
    if (strategy.forceExplicitDecoder) {
      notes.push(`Using explicit ${strategy.gpuType} decoder for true GPU pipeline`);
    }

    return {
      recommendedPresetId: preset.id,
      reason: strategy.reason,
      expectedCompression,
      cpuUsage,
      gpuUtilization,
      speed,
      details: {
        sourceCodec: analysis.codec,
        targetCodec: preset.config.video_codec,
        encodingType: strategy.encodingType,
        gpuType: strategy.gpuType,
        notes,
      },
    };
  }

  /**
   * Estimates compression ratio based on source and target settings.
   * Now always targets H.265 for space reduction.
   */
  private estimateCompression(analysis: FileAnalysis, preset: Preset): string {
    const sourceBitrate = analysis.bitrate;
    const targetCodec = preset.config.video_codec;
    const quality = preset.config.quality;

    // We always target H.265 for space savings
    let compressionRatio: number;

    if (analysis.codecFamily === 'h265' && targetCodec === 'h265') {
      // H.265 to H.265: re-encode to reduce bitrate
      // Compression depends on source bitrate
      if (analysis.bitrateCategory === 'veryhigh') {
        compressionRatio = 0.65; // 35% reduction
      } else if (analysis.bitrateCategory === 'high') {
        compressionRatio = 0.75; // 25% reduction
      } else if (analysis.bitrateCategory === 'medium') {
        compressionRatio = 0.85; // 15% reduction
      } else {
        compressionRatio = 0.95; // 5% reduction (already compressed)
      }
    } else if (analysis.codecFamily === 'h264' && targetCodec === 'h265') {
      // H.264 to H.265: excellent compression
      if (analysis.bitrateCategory === 'veryhigh') {
        compressionRatio = 0.35; // 65% reduction
      } else if (analysis.bitrateCategory === 'high') {
        compressionRatio = 0.4; // 60% reduction
      } else if (analysis.bitrateCategory === 'medium') {
        compressionRatio = 0.5; // 50% reduction
      } else {
        compressionRatio = 0.6; // 40% reduction
      }
    } else if (analysis.codecFamily === 'other' && targetCodec === 'h265') {
      // MPEG-2 and other older codecs to H.265: excellent compression
      // MPEG-2 is very inefficient, so H.265 provides massive savings
      if (analysis.bitrateCategory === 'veryhigh') {
        compressionRatio = 0.25; // 75% reduction
      } else if (analysis.bitrateCategory === 'high') {
        compressionRatio = 0.3; // 70% reduction
      } else if (analysis.bitrateCategory === 'medium') {
        compressionRatio = 0.35; // 65% reduction
      } else {
        compressionRatio = 0.4; // 60% reduction
      }
    } else {
      // Same codec or other conversions
      compressionRatio = 0.7;
    }

    const targetBitrate = sourceBitrate * compressionRatio;
    const ratio = ((1 - compressionRatio) * 100).toFixed(0);

    return `${ratio}% reduction (${this.formatBitrate(targetBitrate)} vs ${this.formatBitrate(sourceBitrate)})`;
  }

  /**
   * Formats bitrate for display.
   */
  private formatBitrate(bps: number): string {
    if (bps >= 1000000) {
      return `${(bps / 1000000).toFixed(1)} Mbps`;
    }
    return `${(bps / 1000).toFixed(0)} kbps`;
  }

  /**
   * Extracts hardware capabilities from all nodes.
   */
  private getHardwareCapabilities(nodes: Node[]): HardwareCapabilities {
    const caps: HardwareCapabilities = {
      nvidia: { hasGpu: false, hasDecoder: false, hasHwaccel: false },
      intel: { hasGpu: false, hasDecoder: false, hasHwaccel: false },
      amd: { hasGpu: false, hasDecoder: false, hasHwaccel: false },
    };

    for (const node of nodes) {
      if (node.status !== 'online') continue;

      // Check for GPUs
      if (node.system_info?.gpus) {
        for (const gpu of node.system_info.gpus) {
          const vendor = gpu.vendor?.toLowerCase() || '';
          if (vendor.includes('nvidia')) {
            caps.nvidia.hasGpu = true;
          } else if (vendor.includes('intel')) {
            caps.intel.hasGpu = true;
          } else if (vendor.includes('amd') || vendor.includes('ati') || vendor.includes('radeon')) {
            caps.amd.hasGpu = true;
          }
        }
      }

      // Check for decoders
      if (node.system_info?.ffmpeg_decoders) {
        for (const decoder of node.system_info.ffmpeg_decoders) {
          if (decoder.available && decoder.type === 'gpu') {
            if (decoder.gpu_type === 'nvidia' && decoder.codec === 'h265') {
              caps.nvidia.hasDecoder = true;
            } else if (decoder.gpu_type === 'intel' && decoder.codec === 'h265') {
              caps.intel.hasDecoder = true;
            } else if (decoder.gpu_type === 'amd' && decoder.codec === 'h265') {
              caps.amd.hasDecoder = true;
            }
          }
        }
      }

      // Check for hwaccels
      if (node.system_info?.ffmpeg_hwaccels) {
        for (const hwaccel of node.system_info.ffmpeg_hwaccels) {
          if (hwaccel.available) {
            if (hwaccel.gpu_type === 'nvidia' || hwaccel.name === 'cuda') {
              caps.nvidia.hasHwaccel = true;
            } else if (hwaccel.gpu_type === 'intel' || hwaccel.name === 'qsv') {
              caps.intel.hasHwaccel = true;
            } else if (hwaccel.gpu_type === 'amd' || hwaccel.name === 'd3d11va') {
              caps.amd.hasHwaccel = true;
            }
          }
        }
      }
    }

    return caps;
  }
}

// ============================================================================
// Helper Types
// ============================================================================

interface HardwareCapabilities {
  nvidia: GpuCapabilities;
  intel: GpuCapabilities;
  amd: GpuCapabilities;
}

interface GpuCapabilities {
  hasGpu: boolean;
  hasDecoder: boolean;
  hasHwaccel: boolean;
}

interface EncodingStrategy {
  encodingType: EncoderType;
  gpuType?: GPUVendor;
  targetCodec: 'h264' | 'h265';
  reason: string;
  forceExplicitDecoder: boolean;
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const presetOptimizer = new PresetOptimizer();
