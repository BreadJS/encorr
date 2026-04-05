import { z } from 'zod';
import type {
  Job,
  JobProgress,
  Node,
  SystemInfo,
  VideoFile,
  VideoMetadata,
  FFmpegConfig,
  NodeConfig,
} from '../types';

// ============================================================================
// Message Types
// ============================================================================

export const MessageType = {
  // Server -> Node
  JOB_ASSIGN: 'JOB_ASSIGN',
  JOB_CANCEL: 'JOB_CANCEL',
  PING: 'PING',
  CONFIG_UPDATE: 'CONFIG_UPDATE',
  SCAN_FOLDER: 'SCAN_FOLDER',

  // Node -> Server
  REGISTER: 'REGISTER',
  HEARTBEAT: 'HEARTBEAT',
  JOB_ACCEPT: 'JOB_ACCEPT',
  JOB_PROGRESS: 'JOB_PROGRESS',
  JOB_COMPLETE: 'JOB_COMPLETE',
  JOB_ERROR: 'JOB_ERROR',
  FILE_INFO: 'FILE_INFO',
  GPU_INFO: 'GPU_INFO',
  USAGE_UPDATE: 'USAGE_UPDATE',

  // Server -> Web Client
  WEB_NODES_UPDATE: 'WEB_NODES_UPDATE',
  WEB_JOBS_UPDATE: 'WEB_JOBS_UPDATE',

  // Web Client -> Server
  WEB_SUBSCRIBE: 'WEB_SUBSCRIBE',

  // Bidirectional
  ACK: 'ACK',
  ERROR: 'ERROR',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

// ============================================================================
// Base Message Schema
// ============================================================================

export const BaseMessageSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
  id: z.string().optional(),
  timestamp: z.number().optional(),
});

export type BaseMessage = z.infer<typeof BaseMessageSchema>;

// ============================================================================
// Message Payload Schemas
// ============================================================================

// REGISTER: Node registration
export const RegisterPayloadSchema = z.object({
  name: z.string().min(1),
  system_info: z.object({
    os: z.string(),
    os_version: z.string(),
    cpu: z.string(),
    cpu_cores: z.number().int().positive(),
    ram_total: z.number().int().positive(),
    ffmpeg_version: z.string().optional(),
    ffmpeg_path: z.string().optional(),
    ffprobe_path: z.string().optional(),
    ffmpeg_encoders: z.array(z.object({
      type: z.enum(['cpu', 'gpu']),
      gpu_type: z.enum(['nvidia', 'intel', 'amd']).optional(),
      encoder_name: z.string(),
      codec: z.enum(['h264', 'h265', 'mpeg2']),
      available: z.boolean(),
    })).optional(),
    ffmpeg_decoders: z.array(z.object({
      type: z.enum(['cpu', 'gpu']),
      gpu_type: z.enum(['nvidia', 'intel', 'amd']).optional(),
      decoder_name: z.string(),
      codec: z.enum(['h264', 'h265', 'mpeg2']),
      available: z.boolean(),
    })).optional(),
    ffmpeg_hwaccels: z.array(z.object({
      name: z.string(),
      available: z.boolean(),
      gpu_type: z.enum(['nvidia', 'intel', 'amd']).optional(),
    })).optional(),
    gpus: z.array(z.object({
      name: z.string(),
      vendor: z.string(),
      memory: z.number().int().positive().optional(),
      memoryFree: z.number().int().positive().optional(),
      memoryUsed: z.number().int().positive().optional(),
      driver_version: z.string().optional(),
      utilizationGpu: z.number().min(0).max(100).optional(),
      utilizationMemory: z.number().min(0).max(100).optional(),
      temperatureGpu: z.number().optional(),
      powerDraw: z.number().optional(),
      powerLimit: z.number().optional(),
      clockCore: z.number().optional(),
      clockMemory: z.number().optional(),
    })).optional(),
  }),
  capabilities: z.object({
    max_concurrent_jobs: z.number().int().min(1).default(1),
    supported_containers: z.array(z.string()).default(['mp4', 'mkv']),
    supported_video_codecs: z.array(z.string()).default(['h264', 'h265', 'hevc']),
  }),
});

export type RegisterPayload = z.infer<typeof RegisterPayloadSchema>;

// HEARTBEAT: Node heartbeat
export const HeartbeatPayloadSchema = z.object({
  status: z.enum(['idle', 'busy', 'error']),
  active_jobs: z.array(z.object({
    job_id: z.string(),
    progress: z.number().min(0).max(100),
    fps: z.number().optional(),
    eta: z.number().optional(),
    ratio: z.string().optional(),
    current_action: z.string().optional(),
    gpu: z.number().optional(),
  })).default([]),
  system_load: z.object({
    cpu_percent: z.number().min(0).max(100),
    memory_percent: z.number().min(0).max(100),
  }).optional(),
  gpus: z.array(z.object({
    utilizationGpu: z.number().min(0).max(100).optional(),
    utilizationMemory: z.number().min(0).max(100).optional(),
    memoryUsed: z.number().int().positive().optional(),
    memoryFree: z.number().int().positive().optional(),
    temperatureGpu: z.number().optional(),
    powerDraw: z.number().optional(),
    clockCore: z.number().optional(),
    clockMemory: z.number().optional(),
  })).optional(),
});

export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

// JOB_ASSIGN: Server assigns job to node
export const JobAssignPayloadSchema = z.object({
  job: z.object({
    id: z.string(),
    file_id: z.string(),
    preset_id: z.string(),
    config: z.object({
      source_path: z.string(),
      dest_path: z.string().optional(), // Optional for analyze-only jobs
      ffmpeg: z.custom<FFmpegConfig>(),
    }),
  }),
});

export type JobAssignPayload = z.infer<typeof JobAssignPayloadSchema>;

// JOB_ACCEPT: Node acknowledges job assignment
export const JobAcceptPayloadSchema = z.object({
  job_id: z.string(),
  accepted: z.boolean(),
  reason: z.string().optional(),
});

export type JobAcceptPayload = z.infer<typeof JobAcceptPayloadSchema>;

// JOB_PROGRESS: Node reports transcoding progress
export const JobProgressPayloadSchema = z.object({
  job_id: z.string(),
  progress: z.number().min(0).max(100),
  current_action: z.string(),
  eta_seconds: z.number().int().optional(),
  fps: z.number().optional(),
  ratio: z.string().optional(),
});

export type JobProgressPayload = z.infer<typeof JobProgressPayloadSchema>;

// JOB_COMPLETE: Node reports job completion
export const JobCompletePayloadSchema = z.object({
  job_id: z.string(),
  // For transcoding jobs
  stats: z.object({
    original_size: z.number().int(),
    transcoded_size: z.number().int(),
    duration_seconds: z.number(),
    avg_fps: z.number().optional(),
  }).optional(),
  // For analyze jobs
  metadata: z.object({
    container: z.string(),
    video_codec: z.string(),
    audio_codecs: z.array(z.string()),
    subtitle_count: z.number(),
    duration: z.number(),
    width: z.number(),
    height: z.number(),
    fps: z.number(),
    bitrate: z.number(),
    size: z.number(),
  }).optional(),
  output_path: z.string(),
  ffmpeg_logs: z.string().optional(),
  decoder_info: z.string().optional(),
});

export type JobCompletePayload = z.infer<typeof JobCompletePayloadSchema>;

// JOB_ERROR: Node reports job failure
export const JobErrorPayloadSchema = z.object({
  job_id: z.string(),
  error: z.string(),
  retry_possible: z.boolean().default(false),
  details: z.record(z.unknown()).optional(),
  ffmpeg_logs: z.string().optional(),
});

export type JobErrorPayload = z.infer<typeof JobErrorPayloadSchema>;

// FILE_INFO: Node reports discovered file metadata
export const FileInfoPayloadSchema = z.object({
  files: z.array(z.object({
    relative_path: z.string(),
    metadata: z.object({
      container: z.string(),
      video_codec: z.string(),
      audio_codecs: z.array(z.string()),
      subtitle_count: z.number().int(),
      duration: z.number(),
      width: z.number().int(),
      height: z.number().int(),
      fps: z.number(),
      bitrate: z.number().int(),
      size: z.number().int(),
    }),
  })),
  folder_mapping_id: z.string(),
});

export type FileInfoPayload = z.infer<typeof FileInfoPayloadSchema>;

// GPU_INFO: Periodic GPU information updates
export const GPUInfoPayloadSchema = z.object({
  gpus: z.array(z.object({
    name: z.string(),
    vendor: z.string(),
    memory: z.number().int().positive().optional(),
    memoryFree: z.number().int().positive().optional(),
    memoryUsed: z.number().int().positive().optional(),
    driver_version: z.string().optional(),
    utilizationGpu: z.number().min(0).max(100).optional(),
    utilizationMemory: z.number().min(0).max(100).optional(),
    temperatureGpu: z.number().optional(),
    powerDraw: z.number().optional(),
    powerLimit: z.number().optional(),
    clockCore: z.number().optional(),
    clockMemory: z.number().optional(),
  })),
});

export type GPUInfoPayload = z.infer<typeof GPUInfoPayloadSchema>;

// USAGE_UPDATE: Node reports current CPU, RAM, GPU usage
export const UsageUpdatePayloadSchema = z.object({
  system_load: z.object({
    cpu_percent: z.number().min(0).max(100),
    memory_percent: z.number().min(0).max(100),
  }).optional(),
  gpus: z.array(z.object({
    utilizationGpu: z.number().min(0).max(100).optional(),
    utilizationMemory: z.number().min(0).max(100).optional(),
    memoryUsed: z.number().int().positive().optional(),
    memoryFree: z.number().int().positive().optional(),
    temperatureGpu: z.number().optional(),
    powerDraw: z.number().optional(),
    clockCore: z.number().optional(),
    clockMemory: z.number().optional(),
  })).optional(),
});

export type UsageUpdatePayload = z.infer<typeof UsageUpdatePayloadSchema>;

// PING: Server health check
export const PingPayloadSchema = z.object({
  timestamp: z.number().optional(),
});

export type PingPayload = z.infer<typeof PingPayloadSchema>;

// ACK: Generic acknowledgment
export const AckPayloadSchema = z.object({
  ack_id: z.string(),
  success: z.boolean().optional(),
  message: z.string().optional(),
});

export type AckPayload = z.infer<typeof AckPayloadSchema>;

// ERROR: Generic error message
export const ErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

// CONFIG_UPDATE: Server sends updated configuration
export const ConfigUpdatePayloadSchema = z.object({
  config: z.custom<Partial<NodeConfig>>(),
});

export type ConfigUpdatePayload = z.infer<typeof ConfigUpdatePayloadSchema>;

// JOB_CANCEL: Server cancels a job
export const JobCancelPayloadSchema = z.object({
  job_id: z.string(),
  reason: z.string().optional(),
});

export type JobCancelPayload = z.infer<typeof JobCancelPayloadSchema>;

// SCAN_FOLDER: Server requests node to scan a folder for video files
export const ScanFolderPayloadSchema = z.object({
  folder_mapping_id: z.string(),
  folder_path: z.string(), // Actual path to scan on the node
});

export type ScanFolderPayload = z.infer<typeof ScanFolderPayloadSchema>;

// WEB_SUBSCRIBE: Web client subscribes to updates
export const WebSubscribePayloadSchema = z.object({
  channels: z.array(z.enum(['nodes', 'jobs'])).optional(),
});

export type WebSubscribePayload = z.infer<typeof WebSubscribePayloadSchema>;

// WEB_NODES_UPDATE: Server sends nodes update to web clients
export const WebNodesUpdatePayloadSchema = z.object({
  nodes: z.array(z.any()), // Array of node objects
});

export type WebNodesUpdatePayload = z.infer<typeof WebNodesUpdatePayloadSchema>;

// WEB_JOBS_UPDATE: Server sends jobs update to web clients
export const WebJobsUpdatePayloadSchema = z.object({
  jobs: z.array(z.any()), // Array of job objects
});

export type WebJobsUpdatePayload = z.infer<typeof WebJobsUpdatePayloadSchema>;

// ============================================================================
// Typed Message Constructors
// ============================================================================

export interface Message<T = unknown> extends BaseMessage {
  type: MessageType;
  payload: T;
}

export type ServerToNodeMessage =
  | Message<JobAssignPayload>
  | Message<JobCancelPayload>
  | Message<PingPayload>
  | Message<ConfigUpdatePayload>
  | Message<ScanFolderPayload>
  | Message<AckPayload>
  | Message<ErrorPayload>;

export type NodeToServerMessage =
  | Message<RegisterPayload>
  | Message<HeartbeatPayload>
  | Message<JobAcceptPayload>
  | Message<JobProgressPayload>
  | Message<JobCompletePayload>
  | Message<JobErrorPayload>
  | Message<FileInfoPayload>
  | Message<GPUInfoPayload>
  | Message<UsageUpdatePayload>
  | Message<AckPayload>
  | Message<ErrorPayload>;

export type ServerToWebClientMessage =
  | Message<WebNodesUpdatePayload>
  | Message<WebJobsUpdatePayload>
  | Message<AckPayload>
  | Message<ErrorPayload>;

export type WebClientToServerMessage =
  | Message<WebSubscribePayload>
  | Message<AckPayload>
  | Message<ErrorPayload>;

export type WebSocketMessage = ServerToNodeMessage | NodeToServerMessage | ServerToWebClientMessage | WebClientToServerMessage;

// ============================================================================
// Message Creation Helpers
// ============================================================================

export function createMessage<T>(
  type: MessageType,
  payload: T,
  id?: string
): Message<T> {
  return {
    type,
    payload,
    id: id || generateMessageId(),
    timestamp: Date.now(),
  };
}

export function createAckMessage(ackId: string, success?: boolean, message?: string): Message<AckPayload> {
  return createMessage(MessageType.ACK, { ack_id: ackId, success, message });
}

export function createErrorMessage(code: string, message: string, details?: Record<string, unknown>): Message<ErrorPayload> {
  return createMessage(MessageType.ERROR, { code, message, details });
}

export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================================
// Message Validators
// ============================================================================

export const MessagePayloadValidators = {
  [MessageType.REGISTER]: RegisterPayloadSchema,
  [MessageType.HEARTBEAT]: HeartbeatPayloadSchema,
  [MessageType.JOB_ASSIGN]: JobAssignPayloadSchema,
  [MessageType.JOB_ACCEPT]: JobAcceptPayloadSchema,
  [MessageType.JOB_PROGRESS]: JobProgressPayloadSchema,
  [MessageType.JOB_COMPLETE]: JobCompletePayloadSchema,
  [MessageType.JOB_ERROR]: JobErrorPayloadSchema,
  [MessageType.FILE_INFO]: FileInfoPayloadSchema,
  [MessageType.GPU_INFO]: GPUInfoPayloadSchema,
  [MessageType.USAGE_UPDATE]: UsageUpdatePayloadSchema,
  [MessageType.PING]: PingPayloadSchema,
  [MessageType.ACK]: AckPayloadSchema,
  [MessageType.ERROR]: ErrorPayloadSchema,
  [MessageType.CONFIG_UPDATE]: ConfigUpdatePayloadSchema,
  [MessageType.JOB_CANCEL]: JobCancelPayloadSchema,
  [MessageType.SCAN_FOLDER]: ScanFolderPayloadSchema,
  [MessageType.WEB_SUBSCRIBE]: WebSubscribePayloadSchema,
  [MessageType.WEB_NODES_UPDATE]: WebNodesUpdatePayloadSchema,
  [MessageType.WEB_JOBS_UPDATE]: WebJobsUpdatePayloadSchema,
} as const;

export function validateMessagePayload(
  messageType: MessageType,
  payload: unknown
): { success: true; data: unknown } | { success: false; error: string } {
  const validator = MessagePayloadValidators[messageType as keyof typeof MessagePayloadValidators];

  if (!validator) {
    return { success: false, error: `Unknown message type: ${messageType}` };
  }

  const result = validator.safeParse(payload);

  if (!result.success) {
    return {
      success: false,
      error: `Invalid payload for ${messageType}: ${result.error.errors.map(e => e.message).join(', ')}`,
    };
  }

  return { success: true, data: result.data };
}

// ============================================================================
// Message Type Guards
// ============================================================================

export function isRegisterMessage(msg: Message): msg is Message<RegisterPayload> {
  return msg.type === MessageType.REGISTER;
}

export function isHeartbeatMessage(msg: Message): msg is Message<HeartbeatPayload> {
  return msg.type === MessageType.HEARTBEAT;
}

export function isJobAcceptMessage(msg: Message): msg is Message<JobAcceptPayload> {
  return msg.type === MessageType.JOB_ACCEPT;
}

export function isJobAssignMessage(msg: Message): msg is Message<JobAssignPayload> {
  return msg.type === MessageType.JOB_ASSIGN;
}

export function isJobCancelMessage(msg: Message): msg is Message<JobCancelPayload> {
  return msg.type === MessageType.JOB_CANCEL;
}

export function isPingMessage(msg: Message): msg is Message<PingPayload> {
  return msg.type === MessageType.PING;
}

export function isConfigUpdateMessage(msg: Message): msg is Message<ConfigUpdatePayload> {
  return msg.type === MessageType.CONFIG_UPDATE;
}

export function isScanFolderMessage(msg: Message): msg is Message<ScanFolderPayload> {
  return msg.type === MessageType.SCAN_FOLDER;
}

export function isJobProgressMessage(msg: Message): msg is Message<JobProgressPayload> {
  return msg.type === MessageType.JOB_PROGRESS;
}

export function isJobCompleteMessage(msg: Message): msg is Message<JobCompletePayload> {
  return msg.type === MessageType.JOB_COMPLETE;
}

export function isJobErrorMessage(msg: Message): msg is Message<JobErrorPayload> {
  return msg.type === MessageType.JOB_ERROR;
}

export function isFileInfoMessage(msg: Message): msg is Message<FileInfoPayload> {
  return msg.type === MessageType.FILE_INFO;
}

export function isGpuInfoMessage(msg: Message): msg is Message<GPUInfoPayload> {
  return msg.type === MessageType.GPU_INFO;
}

export function isAckMessage(msg: Message): msg is Message<AckPayload> {
  return msg.type === MessageType.ACK;
}

export function isErrorMessage(msg: Message): msg is Message<ErrorPayload> {
  return msg.type === MessageType.ERROR;
}

export function isServerToNodeMessage(msg: Message): msg is ServerToNodeMessage {
  return [
    MessageType.JOB_ASSIGN,
    MessageType.JOB_CANCEL,
    MessageType.PING,
    MessageType.CONFIG_UPDATE,
    MessageType.SCAN_FOLDER,
    MessageType.ACK,
    MessageType.ERROR,
  ].includes(msg.type as any);
}

export function isNodeToServerMessage(msg: Message): msg is NodeToServerMessage {
  return [
    MessageType.REGISTER,
    MessageType.HEARTBEAT,
    MessageType.JOB_ACCEPT,
    MessageType.JOB_PROGRESS,
    MessageType.JOB_COMPLETE,
    MessageType.JOB_ERROR,
    MessageType.FILE_INFO,
    MessageType.GPU_INFO,
    MessageType.ACK,
    MessageType.ERROR,
  ].includes(msg.type as any);
}
