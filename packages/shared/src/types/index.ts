// ============================================================================
// Core Types
// ============================================================================

export type NodeStatus = 'online' | 'offline' | 'busy' | 'error';

export interface Node {
  id: string;
  name: string;
  status: NodeStatus;
  last_heartbeat: number;
  system_info: SystemInfo;
  capabilities?: NodeCapabilities;
  cpu_usage?: number;
  ram_usage?: number;
  gpu_usage?: number[];
  active_jobs?: ActiveJobInfo[];
  max_workers?: { cpu: number; gpus: number[] };
  config?: NodeConfig;
  created_at: number;
}

export interface ActiveJobInfo {
  id: string;
  file_name?: string;
  name?: string;
  progress?: number;
  current_action?: string;
  fps?: number;
  eta?: string;
}

export interface NodeCapabilities {
  max_concurrent_jobs: number;
  supported_containers: string[];
  supported_video_codecs: string[];
}

export interface SystemInfo {
  os: string;
  os_version: string;
  cpu: string;
  cpu_cores: number;
  ram_total: number;
  gpus?: GPUInfo[];
  handbrake_version?: string;
  handbrake_path: string;
  ffmpeg_version?: string;
  ffmpeg_path?: string;
  ffprobe_path?: string;
}

export interface GPUInfo {
  name: string;
  vendor: string;
  memory?: number;
  memoryFree?: number;
  memoryUsed?: number;
  driver_version?: string;
  utilizationGpu?: number;
  utilizationMemory?: number;
  temperatureGpu?: number;
  powerDraw?: number;
  powerLimit?: number;
  clockCore?: number;
  clockMemory?: number;
}

// ============================================================================
// Folder Mappings
// ============================================================================

export interface FolderMapping {
  id: string;
  node_id: string;
  server_path: string;
  node_path: string;
  watch: boolean;
  created_at: number;
}

// ============================================================================
// Libraries
// ============================================================================

export interface Library {
  id: string;
  name: string;
  path: string;
  created_at: number;
}

export interface LibraryFile {
  id: string;
  library_id: string;
  filename: string;
  filepath: string;
  filesize: number | null;
  format: string | null;
  duration: number | null;
  status: FileStatus;
  job_id: string | null;
  progress: number;
  error_message: string | null;
  metadata: VideoMetadata | null;
  created_at: number;
  updated_at: number;
}

// ============================================================================
// Files
// ============================================================================

export type FileStatus = 'pending' | 'queued' | 'processing' | 'completed' | 'failed' | 'skipped' | 'analyzed';

export interface VideoFile {
  id: string;
  folder_mapping_id: string;
  relative_path: string;
  original_size: number;
  original_format: string;
  original_codec: string;
  duration: number;
  resolution: string;
  status: FileStatus;
  created_at: number;
}

export interface VideoMetadata {
  container: string;
  video_codec: string;
  audio_codecs: string[];
  subtitle_count: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  size: number;
}

// ============================================================================
// Jobs
// ============================================================================

export type JobStatus = 'queued' | 'assigned' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  file_id: string;
  node_id?: string;
  preset_id: string;
  status: JobStatus;
  progress: number;
  current_action: string | null;
  error_message: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
}

export interface JobProgress {
  job_id: string;
  progress: number; // 0-100
  current_action: string;
  eta_seconds?: number;
  fps?: number;
}

// ============================================================================
// Presets
// ============================================================================

export interface Preset {
  id: string;
  name: string;
  description: string | null;
  is_builtin: boolean;
  config: HandBrakeConfig;
  created_at: number;
}

export interface HandBrakeConfig {
  // Video settings
  video_encoder: string;
  quality_mode: 'vbr' | 'cq' | 'constant';
  quality: number; // CRF value
  preset: string; // speed preset
  tune?: string;

  // Output settings
  container: string;
  max_width?: number;
  max_height?: number;
  crop_mode?: 'auto' | 'none';

  // Audio settings
  audio_encoder: string;
  audio_bitrate: number;
  audio_channels?: 'auto' | 'stereo' | '5.1' | '7.1';
  audio_mixdown?: 'none' | 'stereo' | '5.1';

  // Subtitle settings
  subtitles: 'all' | 'first' | 'none';

  // Filter settings
  deinterlace?: boolean;
  denoise?: 'none' | 'weak' | 'medium' | 'strong';
  deblock?: boolean;

  // Advanced
  extra_args?: string[];
}

// ============================================================================
// Settings
// ============================================================================

export interface Settings {
  // Server settings
  port: number;
  database: string;
  cacheDirectory: string;

  // Auto-scan
  autoScan: {
    enabled: boolean;
    intervalMinutes: number;
  };

  // Job limits
  jobLimits: {
    maxConcurrent: number; // 0 = unlimited
    maxRetries: number;
  };

  // File retention
  fileRetention: {
    deleteOriginal: boolean;
    keepBackup: boolean;
  };

  // HandBrake detection
  handbrake: {
    autoDetect: boolean;
    defaultPaths: string[];
  };
}

// ============================================================================
// Activity Log
// ============================================================================

export type LogLevel = 'info' | 'warning' | 'error';
export type LogCategory = 'system' | 'node' | 'job' | 'file' | 'api';

export interface ActivityLog {
  id: string;
  timestamp: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  metadata: Record<string, unknown> | null;
}

// ============================================================================
// Statistics
// ============================================================================

export interface DashboardStats {
  nodes: {
    total: number;
    online: number;
    offline: number;
    busy: number;
  };
  files: {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
  jobs: {
    queued: number;
    processing: number;
    completed: number;
    failed: number;
  };
  storage: {
    original_size: number;
    transcoded_size: number;
    saved_space: number;
  };
}

// ============================================================================
// Node Configuration
// ============================================================================

export interface NodeConfig {
  serverAddress: string;
  serverPort: number;
  name: string;
  cache_dir: string;
  temp_dir: string;
  handbrakecli_path: string;
  ffmpeg_dir: string;
  reconnectInterval: number;
  heartbeatInterval: number;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface CreateNodeRequest {
  name: string;
  system_info: Partial<SystemInfo>;
}

export interface CreateMappingRequest {
  node_id: string;
  server_path: string;
  node_path: string;
  watch?: boolean;
}

export interface UpdateMappingRequest {
  server_path?: string;
  node_path?: string;
  watch?: boolean;
}

export interface CreateJobRequest {
  file_ids: string[];
  preset_id: string;
}

export interface CreatePresetRequest {
  name: string;
  description?: string;
  config: HandBrakeConfig;
}

export interface UpdateSettingsRequest {
  port?: number;
  cacheDirectory?: string;
  autoScan?: {
    enabled?: boolean;
    intervalMinutes?: number;
  };
  jobLimits?: {
    maxConcurrent?: number;
    maxRetries?: number;
  };
  fileRetention?: {
    deleteOriginal?: boolean;
    keepBackup?: boolean;
  };
}
