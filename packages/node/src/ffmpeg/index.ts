import { existsSync } from 'fs';
import { platform } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import type { FFmpegEncoderInfo, FFmpegDecoderInfo, HwaccelInfo, EncoderType, GPUVendor, VideoCodec } from '@encorr/shared';

// Re-export types for convenience
export type { FFmpegEncoderInfo, FFmpegDecoderInfo, HwaccelInfo, EncoderType, GPUVendor, VideoCodec };

// ============================================================================
// FFmpeg Detection
// ============================================================================

export async function findFFmpeg(): Promise<string | null> {
  const plat = platform();
  const defaultPaths: string[] = [];

  if (plat === 'win32') {
    defaultPaths.push(
      'C:/ffmpeg/bin/ffmpeg.exe',
      'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
      'C:/Program Files (x86)/ffmpeg/bin/ffmpeg.exe',
      join(process.env.PROGRAMFILES || 'C:/Program Files', 'ffmpeg/bin/ffmpeg.exe'),
      join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'ffmpeg/bin/ffmpeg.exe')
    );
  } else if (plat === 'darwin') {
    defaultPaths.push(
      '/usr/local/bin/ffmpeg',
      '/opt/homebrew/bin/ffmpeg',
      '/opt/local/bin/ffmpeg'
    );
  } else {
    defaultPaths.push(
      '/usr/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/opt/homebrew/bin/ffmpeg'
    );
  }

  // Check default paths
  for (const path of defaultPaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  // Try to find using 'which' or 'where'
  try {
    const cmd = plat === 'win32' ? 'where' : 'which';
    const result = execSync(`${cmd} ffmpeg`, { encoding: 'utf-8' }).trim();
    if (result && existsSync(result.split('\n')[0])) {
      return result.split('\n')[0];
    }
  } catch {
    // Command failed, ignore
  }

  return null;
}

export function findFFprobe(): string | null {
  const plat = platform();
  const defaultPaths: string[] = [];

  if (plat === 'win32') {
    defaultPaths.push(
      'C:/ffmpeg/bin/ffprobe.exe',
      'C:/Program Files/ffmpeg/bin/ffprobe.exe',
      'C:/Program Files (x86)/ffmpeg/bin/ffprobe.exe'
    );
  } else if (plat === 'darwin') {
    defaultPaths.push(
      '/usr/local/bin/ffprobe',
      '/opt/homebrew/bin/ffprobe',
      '/opt/local/bin/ffprobe'
    );
  } else {
    defaultPaths.push(
      '/usr/bin/ffprobe',
      '/usr/local/bin/ffprobe',
      '/opt/homebrew/bin/ffprobe'
    );
  }

  // Check default paths
  for (const path of defaultPaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  // Try to find using 'which' or 'where'
  try {
    const cmd = plat === 'win32' ? 'where' : 'which';
    const result = execSync(`${cmd} ffprobe`, { encoding: 'utf-8' }).trim();
    if (result && existsSync(result.split('\n')[0])) {
      return result.split('\n')[0];
    }
  } catch {
    // Command failed, ignore
  }

  return null;
}

export function getFFmpegVersion(ffmpegPath: string): string | null {
  try {
    const output = execSync(`"${ffmpegPath}" -version`, { encoding: 'utf-8' });
    const match = output.match(/ffmpeg version ([\d.]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function getFFprobeVersion(ffprobePath: string): string | null {
  try {
    const output = execSync(`"${ffprobePath}" -version`, { encoding: 'utf-8' });
    const match = output.match(/ffprobe version ([\d.]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ============================================================================
// FFmpeg Encoder Detection
// ============================================================================

export async function detectAvailableEncoders(ffmpegPath: string): Promise<FFmpegEncoderInfo[]> {
  const encoders: FFmpegEncoderInfo[] = [];

  try {
    // Get list of available encoders from FFmpeg
    const output = execSync(`"${ffmpegPath}" -encoders`, { encoding: 'utf-8' });

    // Check for CPU encoders
    if (output.includes('libx264')) {
      encoders.push({
        type: 'cpu',
        encoder_name: 'libx264',
        codec: 'h264',
        available: true,
      });
    }
    if (output.includes('libx265')) {
      encoders.push({
        type: 'cpu',
        encoder_name: 'libx265',
        codec: 'h265',
        available: true,
      });
    }

    // Check for NVIDIA encoders
    if (output.includes('h264_nvenc')) {
      encoders.push({
        type: 'gpu',
        gpu_type: 'nvidia',
        encoder_name: 'h264_nvenc',
        codec: 'h264',
        available: true,
      });
    }
    if (output.includes('hevc_nvenc')) {
      encoders.push({
        type: 'gpu',
        gpu_type: 'nvidia',
        encoder_name: 'hevc_nvenc',
        codec: 'h265',
        available: true,
      });
    }

    // Check for Intel encoders
    if (output.includes('h264_qsv')) {
      encoders.push({
        type: 'gpu',
        gpu_type: 'intel',
        encoder_name: 'h264_qsv',
        codec: 'h264',
        available: true,
      });
    }
    if (output.includes('hevc_qsv')) {
      encoders.push({
        type: 'gpu',
        gpu_type: 'intel',
        encoder_name: 'hevc_qsv',
        codec: 'h265',
        available: true,
      });
    }

    // Check for AMD encoders
    if (output.includes('h264_amf')) {
      encoders.push({
        type: 'gpu',
        gpu_type: 'amd',
        encoder_name: 'h264_amf',
        codec: 'h264',
        available: true,
      });
    }
    if (output.includes('hevc_amf')) {
      encoders.push({
        type: 'gpu',
        gpu_type: 'amd',
        encoder_name: 'hevc_amf',
        codec: 'h265',
        available: true,
      });
    }
  } catch (error) {
    // If encoder detection fails, return empty array
    console.error('Failed to detect FFmpeg encoders:', error);
  }

  return encoders;
}

// ============================================================================
// FFmpeg Decoder Detection
// ============================================================================

export async function detectAvailableDecoders(ffmpegPath: string): Promise<FFmpegDecoderInfo[]> {
  const decoders: FFmpegDecoderInfo[] = [];

  try {
    // Get list of available decoders from FFmpeg
    const output = execSync(`"${ffmpegPath}" -decoders`, { encoding: 'utf-8' });

    // Check for NVIDIA hardware decoders (cuvid)
    if (output.includes('h264_cuvid')) {
      decoders.push({
        type: 'gpu',
        gpu_type: 'nvidia',
        decoder_name: 'h264_cuvid',
        codec: 'h264',
        available: true,
      });
    }
    if (output.includes('hevc_cuvid')) {
      decoders.push({
        type: 'gpu',
        gpu_type: 'nvidia',
        decoder_name: 'hevc_cuvid',
        codec: 'h265',
        available: true,
      });
    }
    if (output.includes('mpeg2_cuvid')) {
      decoders.push({
        type: 'gpu',
        gpu_type: 'nvidia',
        decoder_name: 'mpeg2_cuvid',
        codec: 'mpeg2',
        available: true,
      });
    }

    // Check for Intel hardware decoders (qsv)
    if (output.includes('h264_qsv')) {
      decoders.push({
        type: 'gpu',
        gpu_type: 'intel',
        decoder_name: 'h264_qsv',
        codec: 'h264',
        available: true,
      });
    }
    if (output.includes('hevc_qsv')) {
      decoders.push({
        type: 'gpu',
        gpu_type: 'intel',
        decoder_name: 'hevc_qsv',
        codec: 'h265',
        available: true,
      });
    }
    if (output.includes('mpeg2_qsv')) {
      decoders.push({
        type: 'gpu',
        gpu_type: 'intel',
        decoder_name: 'mpeg2_qsv',
        codec: 'mpeg2',
        available: true,
      });
    }

    // Check for AMD hardware decoders (d3d11va, dxva2 - these use hwaccel, not explicit decoders)
    // AMD GPU decoding is typically done through hwaccel, not explicit decoder names
    // But we still add entries for completeness
    decoders.push({
      type: 'gpu',
      gpu_type: 'amd',
      decoder_name: 'h264_d3d11va',
      codec: 'h264',
      available: true, // Assume available if hwaccel is available
    });
    decoders.push({
      type: 'gpu',
      gpu_type: 'amd',
      decoder_name: 'hevc_d3d11va',
      codec: 'h265',
      available: true,
    });

    // CPU decoders are always available
    decoders.push({
      type: 'cpu',
      decoder_name: 'h264',
      codec: 'h264',
      available: true,
    });
    decoders.push({
      type: 'cpu',
      decoder_name: 'hevc',
      codec: 'h265',
      available: true,
    });
    decoders.push({
      type: 'cpu',
      decoder_name: 'mpeg2video',
      codec: 'mpeg2',
      available: true,
    });
  } catch (error) {
    // If decoder detection fails, return empty array
    console.error('Failed to detect FFmpeg decoders:', error);
  }

  return decoders;
}

// ============================================================================
// FFmpeg Hwaccel Detection
// ============================================================================

export async function detectAvailableHwaccels(ffmpegPath: string): Promise<HwaccelInfo[]> {
  const hwaccels: HwaccelInfo[] = [];

  try {
    // Get list of available hwaccels from FFmpeg
    const output = execSync(`"${ffmpegPath}" -hwaccels`, { encoding: 'utf-8' });

    // Check for NVIDIA CUDA
    if (output.includes('cuda')) {
      hwaccels.push({
        name: 'cuda',
        available: true,
        gpu_type: 'nvidia',
      });
    }

    // Check for Intel QSV
    if (output.includes('qsv')) {
      hwaccels.push({
        name: 'qsv',
        available: true,
        gpu_type: 'intel',
      });
    }

    // Check for Direct3D 11 Video Acceleration (Windows, AMD/NVIDIA)
    if (output.includes('d3d11va')) {
      hwaccels.push({
        name: 'd3d11va',
        available: true,
        gpu_type: 'amd', // Also works with NVIDIA on Windows
      });
    }

    // Check for DXVA2 (Windows, older)
    if (output.includes('dxva2')) {
      hwaccels.push({
        name: 'dxva2',
        available: true,
        gpu_type: 'amd',
      });
    }

    // Check for VideoToolbox (macOS)
    if (output.includes('videotoolbox')) {
      hwaccels.push({
        name: 'videotoolbox',
        available: true,
      });
    }

    // Check for VAAPI (Linux)
    if (output.includes('vaapi')) {
      hwaccels.push({
        name: 'vaapi',
        available: true,
      });
    }

    // Check for VDPAU (Linux, NVIDIA)
    if (output.includes('vdpau')) {
      hwaccels.push({
        name: 'vdpau',
        available: true,
        gpu_type: 'nvidia',
      });
    }
  } catch (error) {
    // If hwaccel detection fails, return empty array
    console.error('Failed to detect FFmpeg hwaccels:', error);
  }

  return hwaccels;
}

// ============================================================================
// FFmpeg Command Builder
// ============================================================================

export interface FFmpegOptions {
  input: string;
  output: string;
  config: any;
  onProgress?: (progress: number, action: string, eta?: number, fps?: number) => void;
}

export interface FFmpegConfig {
  // Video settings
  video_codec: 'h264' | 'h265';
  encoding_type: EncoderType;
  gpu_type?: GPUVendor;
  gpu_device_id?: number; // Specific GPU device ID to use (for multi-GPU systems)
  quality_mode: 'crf' | 'cq' | 'qp';
  quality: number;
  preset: string;

  // Output settings
  container: string;
  max_width?: number;
  max_height?: number;

  // Audio settings
  audio_encoder: string;
  audio_bitrate: number;

  // Subtitle settings
  subtitles: 'all' | 'first' | 'none';

  // Filter settings
  deinterlace?: boolean;

  // Advanced
  extra_args?: string[];

  // GPU-only pipeline settings (for explicit decoder selection)
  source_codec?: string; // Source codec to select appropriate decoder
  use_explicit_decoder?: boolean; // Use explicit decoder (e.g., hevc_cuvid) instead of -hwaccel
}

function getFFmpegEncoder(config: FFmpegConfig): string {
  const codec = config.video_codec;
  const type = config.encoding_type;

  if (type === 'cpu') {
    return codec === 'h264' ? 'libx264' : 'libx265';
  }

  // GPU encoders
  const gpuType = config.gpu_type;
  if (!gpuType) {
    throw new Error('GPU encoding requires gpu_type to be specified');
  }

  if (gpuType === 'nvidia') {
    return codec === 'h264' ? 'h264_nvenc' : 'hevc_nvenc';
  } else if (gpuType === 'intel') {
    return codec === 'h264' ? 'h264_qsv' : 'hevc_qsv';
  } else if (gpuType === 'amd') {
    return codec === 'h264' ? 'h264_amf' : 'hevc_amf';
  }

  throw new Error(`Unsupported GPU type: ${gpuType}`);
}

function getQualityParams(config: FFmpegConfig): string[] {
  const params: string[] = [];
  const encoder = getFFmpegEncoder(config);
  const codec = config.video_codec;

  // CPU encoders (libx264, libx265) use CRF
  if (encoder.startsWith('libx')) {
    params.push('-crf', config.quality.toString());
    params.push('-preset', config.preset);
  }
  // NVIDIA encoders
  else if (encoder.includes('nvenc')) {
    if (codec === 'h264') {
      params.push('-cq', config.quality.toString());
    } else {
      params.push('-cq', config.quality.toString());
    }
    params.push('-preset', config.preset);
  }
  // Intel QSV encoders
  else if (encoder.includes('qsv')) {
    params.push('-global_quality', config.quality.toString());
    params.push('-preset', config.preset);
  }
  // AMD AMF encoders
  else if (encoder.includes('amf')) {
    params.push('-qp', config.quality.toString());
    if (config.preset === 'slow') {
      params.push('-quality', 'slow');
    } else if (config.preset === 'fast') {
      params.push('-quality', 'speed');
    }
  }

  return params;
}

export function buildFFmpegArgs(options: FFmpegOptions): string[] {
  const { input, output, config } = options;
  const args: string[] = [];

  // For GPU encoding with explicit decoder selection (true GPU-only pipeline)
  // This uses hardware decoder + GPU memory output format = complete GPU pipeline
  if (config.encoding_type === 'gpu' && config.gpu_type && config.use_explicit_decoder && config.source_codec) {
    const sourceCodec = config.source_codec.toLowerCase();

    // Select the appropriate hardware decoder based on GPU type and source codec
    let hardwareDecoder: string | undefined;
    let hwaccelOutputFormat: string | undefined;

    if (config.gpu_type === 'nvidia') {
      // NVIDIA CUDA decoders (cuvid)
      if (sourceCodec.includes('265') || sourceCodec.includes('hevc')) {
        hardwareDecoder = 'hevc_cuvid';
        hwaccelOutputFormat = 'cuda';
      } else if (sourceCodec.includes('264') || sourceCodec.includes('avc')) {
        hardwareDecoder = 'h264_cuvid';
        hwaccelOutputFormat = 'cuda';
      } else if (sourceCodec.includes('mpeg2') || sourceCodec.includes('mpeg2video')) {
        hardwareDecoder = 'mpeg2_cuvid';
        hwaccelOutputFormat = 'cuda';
      }
    } else if (config.gpu_type === 'intel') {
      // Intel QSV decoders
      if (sourceCodec.includes('265') || sourceCodec.includes('hevc')) {
        hardwareDecoder = 'hevc_qsv';
        hwaccelOutputFormat = 'qsv';
      } else if (sourceCodec.includes('264') || sourceCodec.includes('avc')) {
        hardwareDecoder = 'h264_qsv';
        hwaccelOutputFormat = 'qsv';
      } else if (sourceCodec.includes('mpeg2') || sourceCodec.includes('mpeg2video')) {
        hardwareDecoder = 'mpeg2_qsv';
        hwaccelOutputFormat = 'qsv';
      }
    } else if (config.gpu_type === 'amd') {
      // AMD uses hwaccel (d3d11va) rather than explicit decoders
      // The decoder is selected automatically by hwaccel
    }

    // If we have an explicit hardware decoder, use it BEFORE the input
    if (hardwareDecoder && hwaccelOutputFormat) {
      console.log(`[buildFFmpegArgs] Using explicit GPU decoder: ${hardwareDecoder} for ${config.gpu_type} ${sourceCodec.toUpperCase()} source`);
      // Use -c:v decoder_name -i input (explicit decoder selection)
      // This forces FFmpeg to use the hardware decoder for decoding
      args.push('-c:v', hardwareDecoder);
      args.push('-i', input);
      // Note: Not using -hwaccel_output_format here as it causes argument order issues
      // The explicit decoder selection alone is sufficient to force GPU decoding
    } else {
      // Fallback to standard hwaccel method
      console.log(`[buildFFmpegArgs] No explicit decoder found for ${sourceCodec} on ${config.gpu_type}, using hwaccel`);
      useHwaccelDecode(args, config.gpu_type, config.gpu_device_id);
      args.push('-i', input);
    }
  } else {
    // Standard hardware acceleration (hint-based, may still use software decoding)
    if (config.encoding_type === 'gpu' && config.gpu_type) {
      useHwaccelDecode(args, config.gpu_type, config.gpu_device_id);
    }

    // Input
    args.push('-i', input);
  }

  // Video encoder
  const encoder = getFFmpegEncoder(config);
  args.push('-c:v', encoder);

  // Add GPU device selection for ENCODING (this is where -gpu belongs for NVENC)
  // For Intel and AMD, device selection is handled via -init_hw_device during decode setup
  if (config.encoding_type === 'gpu' && config.gpu_type === 'nvidia' && config.gpu_device_id !== undefined) {
    // -gpu is an NVENC encoder option, must come after -i and before -c:v
    // But since we already added -c:v, we need to insert it right after the encoder name
    // FFmpeg allows encoder options after -c:v encoder_name
    args.push('-gpu', config.gpu_device_id.toString());
    console.log(`[buildFFmpegArgs] NVENC GPU device ${config.gpu_device_id} selected`);
  }

  // Quality settings
  args.push(...getQualityParams(config));

  // Pixel format: For GPU encoders that don't support 10-bit, convert to 8-bit
  // H.264 NVENC, Intel QSV H.264, AMD AMF H.264 only support 8-bit
  const needs8BitConversion = (config.encoding_type === 'gpu' &&
    config.video_codec === 'h264' &&
    (config.gpu_type === 'nvidia' || config.gpu_type === 'intel' || config.gpu_type === 'amd'));

  // Video filters for scaling and pixel format conversion
  const filters: string[] = [];

  if (needs8BitConversion) {
    filters.push('format=yuv420p'); // Convert to 8-bit before encoding
  }

  if (config.deinterlace) {
    filters.push('yadif=0:-1:0');
  }

  if (config.max_width || config.max_height) {
    filters.push(`scale=${config.max_width || -1}:${config.max_height || -1}`);
  }

  if (filters.length > 0) {
    args.push('-vf', filters.join(','));
  }

  // Audio settings
  args.push('-c:a', config.audio_encoder);
  args.push('-b:a', `${config.audio_bitrate}`);

  // Subtitles
  // MKV supports all subtitle types (text and bitmap), so we can preserve them all
  // Use -c:s copy to copy subtitles without re-encoding (important for bitmap subtitles)
  if (config.subtitles === 'all') {
    args.push('-map', '0:v'); // Video
    args.push('-map', '0:a'); // Audio
    args.push('-map', '0:s?'); // All subtitles
    args.push('-c:s', 'copy'); // Copy subtitles without re-encoding
  } else if (config.subtitles === 'first') {
    args.push('-map', '0:v');
    args.push('-map', '0:a');
    args.push('-map', '0:s:0?'); // First subtitle
    args.push('-c:s', 'copy'); // Copy subtitle without re-encoding
  } else if (config.subtitles === 'none') {
    args.push('-sn'); // No subtitles
  }

  // Extra arguments
  if (config.extra_args && config.extra_args.length > 0) {
    args.push(...config.extra_args);
  }

  // Overwrite output without asking (must come before output file)
  args.push('-y');

  // Output (FFmpeg auto-detects format from file extension)
  args.push(output);

  // Log the generated command for debugging
  console.log(`[buildFFmpegArgs] Config:`, JSON.stringify(config, null, 2));
  console.log(`[buildFFmpegArgs] Hardware decode: ${config.encoding_type === 'gpu' ? config.gpu_type : 'none (software)'}`);
  if (config.encoding_type === 'gpu' && config.gpu_device_id !== undefined) {
    console.log(`[buildFFmpegArgs] GPU device ID: ${config.gpu_device_id}`);
  }
  console.log(`[buildFFmpegArgs] Explicit decoder: ${config.use_explicit_decoder ? 'enabled' : 'disabled'}`);
  console.log(`[buildFFmpegArgs] Generated ${args.length} args:`, args.join(' '));

  return args;
}

// Helper function to add hwaccel arguments for DECODING
// Note: GPU device selection for ENCODING is handled separately in buildFFmpegArgs
function useHwaccelDecode(args: string[], gpuType: GPUVendor, gpuDeviceId?: number): void {
  switch (gpuType) {
    case 'nvidia':
      args.push('-hwaccel', 'cuda');
      // For CUDA decoding with device selection (FFmpeg 6.0+)
      if (gpuDeviceId !== undefined) {
        args.push('-hwaccel_device', gpuDeviceId.toString());
      }
      break;
    case 'intel':
      args.push('-hwaccel', 'qsv');
      // For Intel QSV with device selection
      if (gpuDeviceId !== undefined) {
        // Initialize QSV device before using it
        args.push('-init_hw_device', `qsv=qsv:hw_${gpuDeviceId}`);
        args.push('-filter_hw_device', 'qsv');
      }
      break;
    case 'amd':
      // AMD on Windows uses d3d11va
      args.push('-hwaccel', 'd3d11va');
      // AMD d3d11va doesn't have a simple device selection flag in FFmpeg
      // The driver typically handles device selection
      break;
  }
}

// Helper function to add GPU encoding options (called separately, after input)
function addGpuEncoderOptions(args: string[], gpuType: GPUVendor, gpuDeviceId?: number): void {
  switch (gpuType) {
    case 'nvidia':
      // -gpu is an NVENC encoder option
      if (gpuDeviceId !== undefined) {
        args.push('-gpu', gpuDeviceId.toString());
      }
      break;
    // Intel QSV and AMD AMF don't have separate encoder device options
    // They use -init_hw_device during decoding setup
    case 'intel':
    case 'amd':
      // Device selection handled during decode setup
      break;
  }
}

// ============================================================================
// Progress Parsing
// ============================================================================

export interface ParsedProgress {
  progress: number;
  current_action: string;
  fps?: number;
  eta_seconds?: number;
  ratio?: string;
}

export function parseFFmpegOutput(line: string): ParsedProgress | null {
  // Parse FFmpeg progress output
  // Format: frame= 123 fps= 25 q=28.0 size=    1234kB time=00:00:05.12 bitrate= 1234.5kbits/s speed=1.23x

  const frameMatch = line.match(/frame=\s*(\d+)/);
  const fpsMatch = line.match(/fps=\s*([\d.]+)/);
  const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
  const speedMatch = line.match(/speed=\s*([\d.]+)x/);

  if (frameMatch && timeMatch) {
    const fps = fpsMatch ? parseFloat(fpsMatch[1]) : undefined;
    const speed = speedMatch ? parseFloat(speedMatch[1]) : 1.0;

    // Calculate elapsed time
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = parseFloat(timeMatch[3]);
    const elapsedSeconds = hours * 3600 + minutes * 60 + seconds;

    // Calculate progress (we'll estimate based on speed)
    // This is rough - we'd need duration for accurate progress
    // For now, use a simple heuristic
    const progress = Math.min(99, elapsedSeconds * 2); // Rough estimate

    return {
      progress,
      current_action: 'Encoding',
      fps,
      eta_seconds: undefined, // Would need total duration for accurate ETA
    };
  }

  // Check for progress using -progress pipe:1 format
  // progress=continue
  // frame=123
  // fps=25.0
  // time=00:00:05.12
  if (line.includes('progress=continue')) {
    return {
      progress: 0,
      current_action: 'Encoding',
    };
  }

  if (line.includes('duration=')) {
    return { progress: 0, current_action: 'Analyzing source' };
  }

  return null;
}

// Parse progress from FFmpeg's -progress pipe:1 format
export function parseFFmpegProgressLine(line: string, totalDuration?: number, originalSize?: number): ParsedProgress | null {
  // FFmpeg progress line format: frame= 123 fps= 25 q=28.0 size=    1234kB time=00:00:05.12 bitrate= 1234.5kbits/s speed=1.23x
  // We need to extract time to calculate progress, fps for display, and size for ratio

  // Extract time (most reliable for progress calculation)
  const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
  const fpsMatch = line.match(/fps=\s*([\d.]+)/);
  const speedMatch = line.match(/speed=\s*([\d.]+)x/);
  // FFmpeg outputs KiB/MiB/GiB (kibibytes/mebibytes/gibibytes) or kB/MB/GB
  const sizeMatch = line.match(/size=\s+([\d.]+)(KiB|MiB|GiB|kB|MB|GB)/i);
  const frameMatch = line.match(/frame=\s*(\d+)/);

  let ratio: string | undefined = undefined;
  if (sizeMatch && originalSize) {
    const sizeValue = parseFloat(sizeMatch[1]);
    const sizeUnit = sizeMatch[2].toUpperCase();

    let currentBytes = sizeValue;
    // Handle both KiB (kibibytes, binary) and kB (kilobytes, decimal) - they're the same value
    if (sizeUnit === 'KIB' || sizeUnit === 'KB') currentBytes *= 1024;
    else if (sizeUnit === 'MIB' || sizeUnit === 'MB') currentBytes *= 1024 * 1024;
    else if (sizeUnit === 'GIB' || sizeUnit === 'GB') currentBytes *= 1024 * 1024 * 1024;

    const ratioValue = (currentBytes / originalSize) * 100;
    ratio = ratioValue.toFixed(1) + '%';
  }

  if (timeMatch && totalDuration) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = parseFloat(timeMatch[3]);
    const elapsedSeconds = hours * 3600 + minutes * 60 + seconds;

    const progress = Math.min(99.9, (elapsedSeconds / totalDuration) * 100);

    // Calculate ETA using encoding speed
    // speed=366.0x means encoding is 366x faster than real-time
    const remainingSeconds = totalDuration - elapsedSeconds;
    let eta: number | undefined = undefined;

    if (speedMatch && remainingSeconds > 0) {
      const speed = parseFloat(speedMatch[1]);
      if (speed > 0) {
        // ETA = remaining video time / encoding speed
        eta = remainingSeconds / speed;
      }
    }

    // Extract FPS
    const fps = fpsMatch ? parseFloat(fpsMatch[1]) : undefined;

    return {
      progress,
      current_action: 'Encoding',
      fps,
      eta_seconds: eta,
      ratio,
    };
  }

  // Fallback: if we have frame data but no total duration, return 0 progress with FPS
  if (frameMatch && !totalDuration) {
    const fps = fpsMatch ? parseFloat(fpsMatch[1]) : undefined;
    return {
      progress: 0,
      current_action: 'Encoding',
      fps,
    };
  }

  return null;
}
