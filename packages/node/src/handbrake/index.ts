import { existsSync } from 'fs';
import { platform } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

// ============================================================================
// HandBrake Detection
// ============================================================================

export async function findHandBrake(): Promise<string | null> {
  const plat = platform();
  const defaultPaths: string[] = [];

  if (plat === 'win32') {
    defaultPaths.push(
      'C:/Program Files/HandBrake/HandBrakeCLI.exe',
      'C:/Program Files (x86)/HandBrake/HandBrakeCLI.exe',
      join(process.env.PROGRAMFILES || 'C:/Program Files', 'HandBrake/HandBrakeCLI.exe'),
      join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'HandBrake/HandBrakeCLI.exe')
    );
  } else if (plat === 'darwin') {
    defaultPaths.push(
      '/Applications/HandBrakeCLI',
      '/usr/local/bin/HandBrakeCLI',
      '/opt/homebrew/bin/HandBrakeCLI'
    );
  } else {
    defaultPaths.push(
      '/usr/bin/HandBrakeCLI',
      '/usr/local/bin/HandBrakeCLI',
      '/opt/homebrew/bin/HandBrakeCLI',
      '/usr/bin/HandBrake',
      '/usr/local/bin/HandBrake'
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
    const result = execSync(`${cmd} HandBrakeCLI`, { encoding: 'utf-8' }).trim();
    if (result && existsSync(result.split('\n')[0])) {
      return result.split('\n')[0];
    }
  } catch {
    // Command failed, ignore
  }

  return null;
}

export function findHandBrakeInDir(dir: string): string | null {
  const plat = platform();
  const executable = plat === 'win32' ? 'HandBrakeCLI.exe' : 'HandBrakeCLI';
  const path = join(dir, executable);

  if (existsSync(path)) {
    return path;
  }

  // Also check for just 'HandBrake' on some systems
  const altPath = join(dir, plat === 'win32' ? 'HandBrake.exe' : 'HandBrake');
  if (existsSync(altPath)) {
    return altPath;
  }

  return null;
}

export function getHandBrakeVersion(handbrakePath: string): string | null {
  try {
    const output = execSync(`"${handbrakePath}" --version`, { encoding: 'utf-8' });
    const match = output.match(/HandBrake ([\d.]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ============================================================================
// FFmpeg Detection
// ============================================================================

export function findFFmpegInDir(dir: string): string | null {
  const plat = platform();
  const executable = plat === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const path = join(dir, executable);

  if (existsSync(path)) {
    return path;
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
// HandBrake Command Builder
// ============================================================================

export interface HandBrakeOptions {
  input: string;
  output: string;
  config: any;
  onProgress?: (progress: number, action: string, eta?: number) => void;
}

export function buildHandBrakeArgs(options: HandBrakeOptions): string[] {
  const { input, output, config } = options;
  const args: string[] = [];

  // Input and output
  args.push('-i', input, '-o', output);

  // Container
  const containerMap: Record<string, string> = {
    mp4: 'mp4',
    mkv: 'mkv',
    avi: 'mp4',
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

    // Quality
    if (config.quality_mode === 'cq') {
      args.push('-q', config.quality.toString());
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

    // Deblock
    if (config.deblock) {
      args.push('--deblock', '1:0:2:1');
    }
  } else {
    args.push('-e', 'copy');
  }

  // Audio settings
  args.push('-E', config.audio_encoder || 'aac');

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

  // Subtitles
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
// Progress Parsing
// ============================================================================

export interface ParsedProgress {
  progress: number;
  current_action: string;
  fps?: number;
  avg_fps?: number;
  eta_seconds?: number;
}

export function parseHandBrakeOutput(line: string): ParsedProgress | null {
  // Encoding: task 1 of 1, 23.45 % (150.23 fps, avg 145.67 fps, ETA 00h02m15s)
  const encodingMatch = line.match(/Encoding:\s+task\s+(\d+)\s+of\s+(\d+),\s+([\d.]+)\s+%/);

  if (encodingMatch) {
    const progress = parseFloat(encodingMatch[3]);
    const currentPass = parseInt(encodingMatch[1], 10);
    const totalPasses = parseInt(encodingMatch[2], 10);

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
    };
  }

  if (line.includes('Scanning')) {
    return { progress: 0, current_action: 'Scanning source file' };
  }

  if (line.includes('Encoding') && !line.includes('%')) {
    return { progress: 0, current_action: 'Starting encode' };
  }

  return null;
}
