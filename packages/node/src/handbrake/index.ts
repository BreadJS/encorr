// This file is deprecated - use packages/node/src/ffmpeg/index.ts instead
// All HandBrake functionality has been replaced with FFmpeg

export { getFFmpegVersion, getFFprobeVersion } from '../ffmpeg';

// Deprecated functions - kept for backward compatibility but should not be used
export async function findHandBrake(): Promise<null> {
  console.warn('findHandBrake is deprecated. FFmpeg is now used for all transcoding.');
  return null;
}

export function findHandBrakeInDir(): null {
  console.warn('findHandBrakeInDir is deprecated. FFmpeg is now used for all transcoding.');
  return null;
}

export function getHandBrakeVersion(): null {
  console.warn('getHandBrakeVersion is deprecated. FFmpeg is now used for all transcoding.');
  return null;
}
