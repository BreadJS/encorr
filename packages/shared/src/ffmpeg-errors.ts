export type FFmpegErrorCode =
  | 'gpu_memory_exhausted'
  | 'gpu_encoder_busy'
  | 'gpu_unavailable'
  | 'disk_full'
  | 'permission_denied'
  | 'source_missing'
  | 'invalid_input'
  | 'encoder_configuration'
  | 'ffmpeg_failed';

export interface ParsedFFmpegError {
  code: FFmpegErrorCode;
  message: string;
  retryPossible: boolean;
  recognized: boolean;
}

/**
 * Turn common FFmpeg stderr signatures into an actionable message. FFmpeg
 * frequently prints secondary errors after the real cause, so the checks are
 * deliberately ordered from specific root causes to generic failures.
 */
export function parseFFmpegError(stderr: string, fallback = 'FFmpeg failed'): ParsedFFmpegError {
  const output = stderr || '';

  if (/CUDA_ERROR_OUT_OF_MEMORY|cuCtxCreate[^\n]*out of memory|NV_ENC_ERR_OUT_OF_MEMORY/i.test(output)) {
    return {
      code: 'gpu_memory_exhausted',
      message: 'NVIDIA GPU memory exhausted. The encoder could not reserve enough VRAM. Reduce the GPU worker count or close other GPU applications, then retry.',
      retryPossible: true,
      recognized: true,
    };
  }

  if (/OpenEncodeSessionEx failed|no free encode sessions|too many concurrent (?:encode )?sessions|NV_ENC_ERR_(?:ENCODER_BUSY|RESOURCE_NOT_AVAILABLE)/i.test(output)) {
    return {
      code: 'gpu_encoder_busy',
      message: 'NVIDIA encoder capacity is exhausted. Too many GPU transcodes may be running at once. Reduce the GPU worker count, then retry.',
      retryPossible: true,
      recognized: true,
    };
  }

  if (/Cannot load libcuda|CUDA driver version is insufficient|CUDA_ERROR_NO_DEVICE|cuInit[^\n]*failed|No capable devices found|Device setup failed for decoder/i.test(output)) {
    return {
      code: 'gpu_unavailable',
      message: 'The requested GPU encoder is unavailable. Check the selected GPU, its driver, and FFmpeg hardware-encoding support.',
      retryPossible: true,
      recognized: true,
    };
  }

  if (/No space left on device|disk (?:is )?full|not enough space/i.test(output)) {
    return {
      code: 'disk_full',
      message: 'The destination or temporary disk is full. Free some space, then retry.',
      retryPossible: true,
      recognized: true,
    };
  }

  if (/Permission denied|Operation not permitted/i.test(output)) {
    return {
      code: 'permission_denied',
      message: 'FFmpeg does not have permission to read the source or write the output. Check the node’s file and folder permissions.',
      retryPossible: true,
      recognized: true,
    };
  }

  if (/No such file or directory|Source file not found/i.test(output) || /Input\/output error/i.test(output)) {
    return {
      code: 'source_missing',
      message: 'The source file could not be read. It may have been moved, deleted, or disconnected from the node.',
      retryPossible: true,
      recognized: true,
    };
  }

  if (/Invalid data found when processing input|moov atom not found|could not find codec parameters|End of file/i.test(output)) {
    return {
      code: 'invalid_input',
      message: 'FFmpeg could not read valid media data from this file. The file may be incomplete, corrupt, or unsupported.',
      retryPossible: false,
      recognized: true,
    };
  }

  if (/Error while opening encoder|InitializeEncoder failed|Error initializing output stream|Invalid argument/i.test(output)) {
    return {
      code: 'encoder_configuration',
      message: 'FFmpeg could not start the selected encoder. Check the preset, codec settings, and hardware capabilities.',
      retryPossible: true,
      recognized: true,
    };
  }

  const cleanFallback = fallback.trim() || 'FFmpeg failed';
  return {
    code: 'ffmpeg_failed',
    message: /^FFmpeg exited with code/i.test(cleanFallback)
      ? 'Transcoding failed. Open the job report to view the FFmpeg logs for the exact cause.'
      : cleanFallback,
    retryPossible: false,
    recognized: false,
  };
}
