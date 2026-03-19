import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type {
  Logger
} from 'winston';
import type {
  Node,
  SystemInfo,
  FolderMapping,
  Library,
  LibraryFile,
  VideoFile,
  VideoMetadata,
  Job,
  JobProgress,
  JobStatus,
  Preset,
  QuickSelectPreset,
  HandBrakeConfig,
  Settings,
  ActivityLog,
  DashboardStats,
  FileStatus,
  NodeStatus,
} from '@encorr/shared';
import { expandPath, normalizePath } from '@encorr/shared';
import { createLogger } from '../utils/logger';

// ============================================================================
// Database Options
// ============================================================================

export interface DatabaseOptions {
  path?: string;
  memory?: boolean;
  logger?: Logger;
}

// ============================================================================
// Database Class
// ============================================================================

export class EncorrDatabase {
  private db: Database.Database;
  private logger: Logger;

  constructor(options: DatabaseOptions = {}) {
    const dbPath = options.memory
      ? ':memory:'
      : options.path
        ? expandPath(options.path)
        : './.encorr/server/encorr.db';

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');

    // Initialize logger
    this.logger = options.logger || createLogger();
  }

  // ========================================================================
  // Schema & Migrations
  // ========================================================================

  initialize(): void {
    const schemaPath = resolve(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);

    // Seed built-in presets
    this.seedBuiltinPresets();
  }

  /**
   * Seed built-in presets - use INSERT OR REPLACE to update existing presets
   * This ensures that FFmpeg migration updates old HandBrake-style presets
   */
  private seedBuiltinPresets(): void {
    const builtinPresets = [
      {
        id: 'builtin-high-quality-h265-cpu',
        name: 'High Quality H.265 (CPU)',
        description: 'High quality with H.265/HEVC CPU encoding',
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
        id: 'builtin-nvidia-h264-gpu',
        name: 'NVIDIA H.264 (GPU)',
        description: 'GPU-accelerated encoding with NVIDIA NVENC H.264',
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
      {
        id: 'builtin-intel-h264-gpu',
        name: 'Intel Quick Sync H.264 (GPU)',
        description: 'GPU-accelerated encoding with Intel QSV H.264',
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
      {
        id: 'builtin-amd-h264-gpu',
        name: 'AMD AMF H.264 (GPU)',
        description: 'GPU-accelerated encoding with AMD AMF H.264',
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
      {
        id: 'builtin-mobile-h264-cpu',
        name: 'Mobile Optimized H.264 (CPU)',
        description: 'Optimized for mobile devices with 720p cap',
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
      {
        id: 'builtin-analyze',
        name: 'Analyze Only',
        description: 'Extract file metadata without transcoding',
        config: {
          action: 'analyze',
        },
      },
    ];

    const now = Math.floor(Date.now() / 1000);

    for (const preset of builtinPresets) {
      // Use INSERT OR REPLACE to update existing presets
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO presets (id, name, description, is_builtin, config, created_at)
        VALUES (?, ?, ?, 1, ?, COALESCE((SELECT created_at FROM presets WHERE id = ?), ?))
      `);
      stmt.run(
        preset.id,
        preset.name,
        preset.description,
        JSON.stringify(preset.config),
        preset.id,
        now
      );
      this.logger.info(`Seeded built-in preset: ${preset.name}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // ========================================================================
  // Nodes
  // ========================================================================

  createNode(data: {
    name: string;
    system_info: SystemInfo;
    capabilities?: {
      max_concurrent_jobs: number;
      supported_containers: string[];
      supported_video_codecs: string[];
    };
  }): Node {
    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, name, system_info, capabilities, last_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.name,
      JSON.stringify(data.system_info),
      JSON.stringify(data.capabilities || { max_concurrent_jobs: 1, supported_containers: ['mp4', 'mkv'], supported_video_codecs: ['h264', 'h265'] }),
      now,
      now
    );

    return this.getNodeById(id)!;
  }

  getNodeById(id: string): Node | undefined {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.parseNode(row) : undefined;
  }

  getAllNodes(): Node[] {
    const stmt = this.db.prepare('SELECT * FROM nodes ORDER BY created_at DESC');
    const rows = stmt.all() as any[];
    return rows.map(row => this.parseNode(row));
  }

  updateNodeStatus(id: string, status: NodeStatus, lastHeartbeat?: number): void {
    const stmt = this.db.prepare(`
      UPDATE nodes
      SET status = ?, last_heartbeat = COALESCE(?, last_heartbeat)
      WHERE id = ?
    `);
    stmt.run(status, lastHeartbeat, id);
  }

  updateNodeHeartbeat(id: string): void {
    const stmt = this.db.prepare('UPDATE nodes SET last_heartbeat = ? WHERE id = ?');
    stmt.run(Math.floor(Date.now() / 1000), id);
  }

  updateNodeSystemInfo(id: string, systemInfo: SystemInfo): void {
    const stmt = this.db.prepare(`
      UPDATE nodes
      SET system_info = ?
      WHERE id = ?
    `);

    // Log GPU utilization before update
    if (systemInfo.gpus && systemInfo.gpus.length > 0) {
      this.logger.debug(`Updating system_info for node ${id}: GPU utilizations =`, systemInfo.gpus.map(g => g.utilizationGpu));
    }

    stmt.run(JSON.stringify(systemInfo), id);
  }

  updateNodeUsage(id: string, usage: {
    cpu_usage?: number;
    ram_usage?: number;
    gpu_usage?: number[];
    active_jobs?: any[];
  }): void {
    const updates: string[] = [];
    const values: any[] = [];

    if (usage.cpu_usage !== undefined) {
      updates.push('cpu_usage = ?');
      values.push(usage.cpu_usage);
    }
    if (usage.ram_usage !== undefined) {
      updates.push('ram_usage = ?');
      values.push(usage.ram_usage);
    }
    if (usage.gpu_usage !== undefined) {
      updates.push('gpu_usage = ?');
      values.push(JSON.stringify(usage.gpu_usage));
    }
    if (usage.active_jobs !== undefined) {
      updates.push('active_jobs = ?');
      values.push(JSON.stringify(usage.active_jobs));
    }

    if (updates.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  updateNodeConfig(id: string, config: any): void {
    const stmt = this.db.prepare(`
      UPDATE nodes
      SET config = ?
      WHERE id = ?
    `);
    stmt.run(JSON.stringify(config), id);
  }

  updateNodeMaxWorkers(id: string, maxWorkers: { cpu: number; gpus: number[] }): void {
    const stmt = this.db.prepare(`
      UPDATE nodes
      SET max_workers = ?
      WHERE id = ?
    `);
    stmt.run(JSON.stringify(maxWorkers), id);
  }

  deleteNode(id: string): void {
    const stmt = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    stmt.run(id);
  }

  private parseNode(row: any): Node {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      last_heartbeat: row.last_heartbeat,
      system_info: JSON.parse(row.system_info),
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : undefined,
      cpu_usage: row.cpu_usage || 0,
      ram_usage: row.ram_usage || 0,
      gpu_usage: row.gpu_usage ? JSON.parse(row.gpu_usage) : undefined,
      active_jobs: row.active_jobs ? JSON.parse(row.active_jobs) : undefined,
      config: row.config ? JSON.parse(row.config) : undefined,
      max_workers: row.max_workers ? JSON.parse(row.max_workers) : undefined,
      created_at: row.created_at,
    };
  }

  // ========================================================================
  // Folder Mappings
  // ========================================================================

  createFolderMapping(data: {
    node_id: string;
    server_path: string;
    node_path: string;
    watch?: boolean;
  }): FolderMapping {
    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO folder_mappings (id, node_id, server_path, node_path, watch, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.node_id,
      normalizePath(data.server_path),
      data.node_path,
      data.watch ?? true,
      now
    );

    return this.getFolderMappingById(id)!;
  }

  getFolderMappingById(id: string): FolderMapping | undefined {
    const stmt = this.db.prepare('SELECT * FROM folder_mappings WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.parseFolderMapping(row) : undefined;
  }

  getFolderMappingsByNode(nodeId: string): FolderMapping[] {
    const stmt = this.db.prepare('SELECT * FROM folder_mappings WHERE node_id = ? ORDER BY created_at DESC');
    const rows = stmt.all(nodeId) as any[];
    return rows.map(row => this.parseFolderMapping(row));
  }

  getAllFolderMappings(): FolderMapping[] {
    const stmt = this.db.prepare('SELECT * FROM folder_mappings ORDER BY created_at DESC');
    const rows = stmt.all() as any[];
    return rows.map(row => this.parseFolderMapping(row));
  }

  updateFolderMapping(id: string, data: {
    server_path?: string;
    node_path?: string;
    watch?: boolean;
  }): void {
    const updates: string[] = [];
    const values: any[] = [];

    if (data.server_path !== undefined) {
      updates.push('server_path = ?');
      values.push(normalizePath(data.server_path));
    }
    if (data.node_path !== undefined) {
      updates.push('node_path = ?');
      values.push(data.node_path);
    }
    if (data.watch !== undefined) {
      updates.push('watch = ?');
      values.push(data.watch ? 1 : 0);
    }

    if (updates.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE folder_mappings SET ${updates.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  deleteFolderMapping(id: string): void {
    const stmt = this.db.prepare('DELETE FROM folder_mappings WHERE id = ?');
    stmt.run(id);
  }

  private parseFolderMapping(row: any): FolderMapping {
    return {
      id: row.id,
      node_id: row.node_id,
      server_path: row.server_path,
      node_path: row.node_path,
      watch: Boolean(row.watch),
      created_at: row.created_at,
    };
  }

  // ========================================================================
  // Libraries
  // ========================================================================

  getAllLibraries(): Library[] {
    const stmt = this.db.prepare('SELECT * FROM libraries ORDER BY created_at DESC');
    const rows = stmt.all() as any[];
    return rows.map(row => this.parseLibrary(row));
  }

  getLibraryById(id: string): Library | undefined {
    const stmt = this.db.prepare('SELECT * FROM libraries WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.parseLibrary(row) : undefined;
  }

  createLibrary(data: { name: string; path: string }): Library {
    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO libraries (id, name, path, created_at)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(id, data.name, normalizePath(data.path), now);

    return this.getLibraryById(id)!;
  }

  deleteLibrary(id: string): void {
    const stmt = this.db.prepare('DELETE FROM libraries WHERE id = ?');
    stmt.run(id);
  }

  private parseLibrary(row: any): Library {
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      created_at: row.created_at,
    };
  }

  // ========================================================================
  // Library Files
  // ========================================================================

  getLibraryFiles(libraryId: string): LibraryFile[] {
    const stmt = this.db.prepare('SELECT * FROM library_files WHERE library_id = ? ORDER BY filename ASC');
    const rows = stmt.all(libraryId) as any[];
    return rows.map(row => this.parseLibraryFile(row));
  }

  getLibraryFileById(id: string): LibraryFile | undefined {
    const stmt = this.db.prepare('SELECT * FROM library_files WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.parseLibraryFile(row) : undefined;
  }

  getLibraryFilesByStatus(status: FileStatus): LibraryFile[] {
    const stmt = this.db.prepare('SELECT * FROM library_files WHERE status = ? ORDER BY created_at DESC');
    const rows = stmt.all(status) as any[];
    return rows.map(row => this.parseLibraryFile(row));
  }

  /**
   * Get library file by filepath
   */
  getLibraryFileByFilepath(filepath: string): LibraryFile | undefined {
    const normalizedPath = normalizePath(filepath);
    const stmt = this.db.prepare('SELECT * FROM library_files WHERE filepath = ?');
    const row = stmt.get(normalizedPath) as any;
    return row ? this.parseLibraryFile(row) : undefined;
  }

  createLibraryFile(data: {
    library_id: string;
    filename: string;
    filepath: string;
    filesize?: number;
    format?: string;
    duration?: number;
  }): LibraryFile {
    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO library_files (id, library_id, filename, filepath, filesize, format, duration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.library_id,
      data.filename,
      normalizePath(data.filepath),
      data.filesize || null,
      data.format || null,
      data.duration || null,
      now,
      now
    );

    return this.getLibraryFileById(id)!;
  }

  upsertLibraryFile(data: {
    library_id: string;
    filename: string;
    filepath: string;
    filesize?: number;
    format?: string;
    duration?: number;
  }): LibraryFile {
    // Check if file already exists
    const existing = this.db.prepare(
      'SELECT * FROM library_files WHERE library_id = ? AND filepath = ?'
    ).get(data.library_id, normalizePath(data.filepath)) as any;

    if (existing) {
      // Update existing file
      const stmt = this.db.prepare(`
        UPDATE library_files
        SET filename = ?, filesize = ?, format = ?, duration = ?, updated_at = ?
        WHERE id = ?
      `);

      stmt.run(
        data.filename,
        data.filesize || null,
        data.format || null,
        data.duration || null,
        Math.floor(Date.now() / 1000),
        existing.id
      );

      return this.getLibraryFileById(existing.id)!;
    }

    return this.createLibraryFile(data);
  }

  updateLibraryFileStatus(id: string, status: FileStatus, jobId?: string, errorMessage?: string): void {
    const stmt = this.db.prepare(`
      UPDATE library_files
      SET status = ?, job_id = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(status, jobId || null, errorMessage || null, Math.floor(Date.now() / 1000), id);
  }

  updateLibraryFileProgress(id: string, progress: number): void {
    const stmt = this.db.prepare(`
      UPDATE library_files
      SET progress = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(progress, Math.floor(Date.now() / 1000), id);
  }

  deleteLibraryFile(id: string): void {
    const stmt = this.db.prepare('DELETE FROM library_files WHERE id = ?');
    stmt.run(id);
  }

  deleteLibraryFilesByLibrary(libraryId: string): void {
    const stmt = this.db.prepare('DELETE FROM library_files WHERE library_id = ?');
    stmt.run(libraryId);
  }

  private parseLibraryFile(row: any): LibraryFile {
    return {
      id: row.id,
      library_id: row.library_id,
      filename: row.filename,
      filepath: row.filepath,
      filesize: row.filesize,
      format: row.format,
      duration: row.duration,
      status: row.status,
      job_id: row.job_id,
      progress: row.progress,
      error_message: row.error_message,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // ========================================================================
  // Files
  // ========================================================================

  createFile(data: {
    folder_mapping_id: string;
    relative_path: string;
    original_size: number;
    original_format: string;
    original_codec: string;
    duration: number;
    resolution: string;
    metadata?: VideoMetadata;
  }): VideoFile {
    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO files (id, folder_mapping_id, relative_path, original_size, original_format,
                         original_codec, duration, resolution, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.folder_mapping_id,
      data.relative_path,
      data.original_size,
      data.original_format,
      data.original_codec,
      data.duration,
      data.resolution,
      data.metadata ? JSON.stringify(data.metadata) : null,
      now
    );

    return this.getFileById(id)!;
  }

  getFileById(id: string): VideoFile | undefined {
    const stmt = this.db.prepare('SELECT * FROM files WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.parseFile(row) : undefined;
  }

  getFilesByFolderMapping(folderMappingId: string): VideoFile[] {
    const stmt = this.db.prepare('SELECT * FROM files WHERE folder_mapping_id = ? ORDER BY created_at DESC');
    const rows = stmt.all(folderMappingId) as any[];
    return rows.map(row => this.parseFile(row));
  }

  getFilesByStatus(status: FileStatus): VideoFile[] {
    const stmt = this.db.prepare('SELECT * FROM files WHERE status = ? ORDER BY created_at DESC');
    const rows = stmt.all(status) as any[];
    return rows.map(row => this.parseFile(row));
  }

  getAllFiles(options?: { limit?: number; offset?: number; status?: FileStatus }): VideoFile[] {
    let query = 'SELECT * FROM files';
    const params: any[] = [];

    if (options?.status) {
      query += ' WHERE status = ?';
      params.push(options.status);
    }

    query += ' ORDER BY created_at DESC';

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
      if (options.offset) {
        query += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.parseFile(row));
  }

  getFileCount(options?: { status?: FileStatus }): number {
    let query = 'SELECT COUNT(*) as count FROM files';
    const params: any[] = [];

    if (options?.status) {
      query += ' WHERE status = ?';
      params.push(options.status);
    }

    const stmt = this.db.prepare(query);
    const result = stmt.get(...params) as { count: number };
    return result.count;
  }

  updateFileStatus(id: string, status: FileStatus): void {
    const stmt = this.db.prepare('UPDATE files SET status = ? WHERE id = ?');
    stmt.run(status, id);
  }

  upsertFile(data: {
    folder_mapping_id: string;
    relative_path: string;
    original_size: number;
    original_format: string;
    original_codec: string;
    duration: number;
    resolution: string;
    metadata?: VideoMetadata;
  }): VideoFile {
    // Check if file exists
    const existing = this.db.prepare(`
      SELECT id FROM files
      WHERE folder_mapping_id = ? AND relative_path = ?
    `).get(data.folder_mapping_id, data.relative_path) as { id: string } | undefined;

    if (existing) {
      // Update existing file
      const stmt = this.db.prepare(`
        UPDATE files
        SET original_size = ?, original_format = ?, original_codec = ?,
            duration = ?, resolution = ?, metadata = ?
        WHERE id = ?
      `);
      stmt.run(
        data.original_size,
        data.original_format,
        data.original_codec,
        data.duration,
        data.resolution,
        data.metadata ? JSON.stringify(data.metadata) : null,
        existing.id
      );
      return this.getFileById(existing.id)!;
    }

    return this.createFile(data);
  }

  deleteFile(id: string): void {
    const stmt = this.db.prepare('DELETE FROM files WHERE id = ?');
    stmt.run(id);
  }

  private parseFile(row: any): VideoFile {
    return {
      id: row.id,
      folder_mapping_id: row.folder_mapping_id,
      relative_path: row.relative_path,
      original_size: row.original_size,
      original_format: row.original_format,
      original_codec: row.original_codec,
      duration: row.duration,
      resolution: row.resolution,
      status: row.status,
      created_at: row.created_at,
    };
  }

  // ========================================================================
  // Jobs
  // ========================================================================

  createJob(data: {
    file_id: string;
    preset_id: string;
    node_id?: string;
  }): Job {
    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO jobs (id, file_id, node_id, preset_id, status, created_at)
      VALUES (?, ?, ?, ?, 'queued', ?)
    `);

    stmt.run(id, data.file_id, data.node_id ?? null, data.preset_id, now);

    // Update file status to queued
    this.updateFileStatus(data.file_id, 'queued');

    return this.getJobById(id)!;
  }

  /**
   * Create a job for a library file
   * Creates a corresponding entry in the files table first
   */
  createJobForLibraryFile(libraryFileId: string, presetId: string, nodeId?: string): Job | null {
    // Get the library file
    const libFile = this.getLibraryFileById(libraryFileId);
    if (!libFile) {
      this.logger.warn(`Library file ${libraryFileId} not found`);
      return null;
    }

    // Get the library to determine the root path
    const library = this.getLibraryById(libFile.library_id);
    if (!library) {
      this.logger.warn(`Library ${libFile.library_id} not found`);
      return null;
    }

    // Calculate the relative path from the library root to the file
    const libraryPath = library.path;
    const filePath = libFile.filepath;

    // Normalize paths for comparison
    const normalizedLibPath = libraryPath.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedFilePath = filePath.replace(/\\/g, '/');

    // Calculate relative path (includes subdirectories)
    let relativePath: string;
    if (normalizedFilePath.startsWith(normalizedLibPath + '/')) {
      relativePath = normalizedFilePath.substring(normalizedLibPath.length + 1);
    } else if (normalizedFilePath === normalizedLibPath) {
      relativePath = libFile.filename;
    } else {
      // Fallback: file is not under library path, use filename only
      this.logger.warn(`File ${filePath} is not under library path ${libraryPath}, using filename only`);
      relativePath = libFile.filename;
    }

    // Get or create a folder mapping for this library
    // For library files, we'll create a special folder mapping
    let folderMapping = this.getAllFolderMappings().find(m => m.server_path === `library:${libFile.library_id}`);

    if (!folderMapping) {
      // Create a folder mapping for this library using the library's root path
      const mappingId = uuidv4();
      const now = Math.floor(Date.now() / 1000);
      const stmt = this.db.prepare(`
        INSERT INTO folder_mappings (id, node_id, server_path, node_path, watch, created_at)
        VALUES (?, ?, ?, ?, 0, ?)
      `);
      // Use the first available node or null
      const nodes = this.getAllNodes();
      const firstNodeId = nodes.length > 0 ? nodes[0].id : null;

      if (!firstNodeId) {
        this.logger.warn(`No nodes available, cannot create job for library file ${libraryFileId}`);
        return null;
      }

      // Use the library's root path as node_path (not the file's directory!)
      stmt.run(mappingId, firstNodeId, `library:${libFile.library_id}`, libraryPath, now);
      folderMapping = this.getFolderMappingById(mappingId)!;
    }

    // Check if a file entry already exists for this library file
    const existingFile = this.db.prepare(`
      SELECT * FROM files WHERE folder_mapping_id = ? AND relative_path = ?
    `).get(folderMapping!.id, relativePath) as { id: string } | undefined;

    let fileId: string;

    if (existingFile) {
      fileId = existingFile.id;
    } else {
      // Create a file entry for this library file
      fileId = uuidv4();
      const now = Math.floor(Date.now() / 1000);
      const fileStmt = this.db.prepare(`
        INSERT INTO files (id, folder_mapping_id, relative_path, original_size, original_format, original_codec, duration, resolution, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `);
      fileStmt.run(
        fileId,
        folderMapping!.id,
        relativePath,
        libFile.filesize || 0,
        libFile.format || 'unknown',
        '', // codec - will be filled by analysis
        libFile.duration || 0,
        '', // resolution - will be filled by analysis
        now
      );
    }

    // Now create the job
    return this.createJob({ file_id: fileId, preset_id: presetId, node_id: nodeId });
  }

  getJobById(id: string): Job | undefined {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.parseJob(row) : undefined;
  }

  getJobsByFile(fileId: string): Job[] {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE file_id = ? ORDER BY created_at DESC');
    const rows = stmt.all(fileId) as any[];
    return rows.map(row => this.parseJob(row));
  }

  getJobsByNode(nodeId: string): Job[] {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE node_id = ? ORDER BY created_at DESC');
    const rows = stmt.all(nodeId) as any[];
    return rows.map(row => this.parseJob(row));
  }

  getJobsByStatus(status: JobStatus): Job[] {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC');
    const rows = stmt.all(status) as any[];
    return rows.map(row => this.parseJob(row));
  }

  getAllJobs(options?: { limit?: number; offset?: number; status?: JobStatus }): Job[] {
    let query = 'SELECT * FROM jobs';
    const params: any[] = [];

    if (options?.status) {
      query += ' WHERE status = ?';
      params.push(options.status);
    }

    query += ' ORDER BY created_at DESC';

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
      if (options.offset) {
        query += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.parseJob(row));
  }

  assignJob(jobId: string, nodeId: string): void {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      UPDATE jobs
      SET node_id = ?, status = 'assigned', started_at = ?
      WHERE id = ?
    `);
    stmt.run(nodeId, now, jobId);
  }

  updateJobProgress(jobId: string, progress: number, currentAction: string): void {
    const stmt = this.db.prepare(`
      UPDATE jobs
      SET progress = ?, current_action = ?
      WHERE id = ?
    `);
    stmt.run(progress, currentAction, jobId);
  }

  setJobProcessing(jobId: string): void {
    const stmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'processing'
      WHERE id = ?
    `);
    stmt.run(jobId);
  }

  completeJob(jobId: string, stats: {
    original_size: number;
    transcoded_size: number;
    duration_seconds: number;
    avg_fps?: number;
  }, outputPath?: string): void {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'completed', progress = 100, completed_at = ?, stats = ?, output_path = ?
      WHERE id = ?
    `);
    stmt.run(now, JSON.stringify(stats), outputPath || null, jobId);
  }

  completeAnalyzeJob(jobId: string, metadata: {
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
  }): void {
    const now = Math.floor(Date.now() / 1000);

    // First, get the file_id from the job
    const job = this.getJobById(jobId);
    if (!job) {
      this.logger.warn(`Job ${jobId} not found, cannot complete analyze job`);
      return;
    }

    // Update the job status
    const jobStmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'completed', progress = 100, completed_at = ?
      WHERE id = ?
    `);
    jobStmt.run(now, jobId);

    // Update the file's metadata in the files table
    const fileStmt = this.db.prepare(`
      UPDATE files
      SET original_format = ?,
          original_codec = ?,
          duration = ?,
          resolution = ?,
          metadata = ?,
          status = 'analyzed'
      WHERE id = ?
    `);
    fileStmt.run(
      metadata.container,
      metadata.video_codec,
      metadata.duration,
      `${metadata.width}x${metadata.height}`,
      JSON.stringify(metadata),
      job.file_id
    );

    // Also update library_files if this file exists there
    // Get the file to find the folder mapping
    const file = this.getFileById(job.file_id);
    if (file) {
      const mapping = this.getFolderMappingById(file.folder_mapping_id);

      // Check if this is a library mapping
      if (mapping && mapping.server_path?.startsWith('library:')) {
        // Construct the full filepath that should be in library_files
        // For old mappings: node_path is the full file path
        // For new mappings: node_path is directory + relative_path is filename
        let libraryFilepath = mapping.node_path;
        if (!libraryFilepath.includes('.mkv') && !libraryFilepath.includes('.mp4') && !libraryFilepath.includes('.avi')) {
          libraryFilepath = `${mapping.node_path}/${file.relative_path}`;
        }

        // Update the library file directly
        const libFileStmt = this.db.prepare(`
          UPDATE library_files
          SET format = ?,
              duration = ?,
              status = 'analyzed',
              metadata = ?,
              updated_at = ?
          WHERE filepath = ?
        `);
        const result = libFileStmt.run(
          metadata.container,
          metadata.duration,
          JSON.stringify(metadata),
          now,
          libraryFilepath
        );

        if (result.changes > 0) {
          this.logger.info(`Also updated library_file: ${libraryFilepath} with metadata`);
        } else {
          this.logger.warn(`Could not find library_file with filepath: ${libraryFilepath}`);
        }
      }
    }

    this.logger.info(`Analyze job ${jobId} completed, file ${job.file_id} metadata updated (status: analyzed)`);
  }

  failJob(jobId: string, errorMessage: string): void {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'failed', error_message = ?, completed_at = ?
      WHERE id = ?
    `);
    stmt.run(errorMessage, now, jobId);

    // Also update the file status to failed
    const job = this.getJobById(jobId);
    if (job) {
      this.updateFileStatus(job.file_id, 'failed');

      // Update library_files status too
      const libFileStmt = this.db.prepare(`
        UPDATE library_files
        SET status = 'failed',
            error_message = ?,
            updated_at = ?
        WHERE filepath IN (
          SELECT relative_path FROM files WHERE id = ?
        )
      `);
      libFileStmt.run(errorMessage, now, job.file_id);

      this.logger.info(`Job ${jobId} failed, file ${job.file_id} status set to failed`);
    }
  }

  cancelJob(jobId: string): void {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'cancelled', completed_at = ?
      WHERE id = ?
    `);
    stmt.run(now, jobId);
  }

  deleteJob(jobId: string): void {
    const stmt = this.db.prepare('DELETE FROM jobs WHERE id = ?');
    stmt.run(jobId);
  }

  private parseJob(row: any): Job {
    return {
      id: row.id,
      file_id: row.file_id,
      node_id: row.node_id ?? undefined,
      preset_id: row.preset_id,
      status: row.status,
      progress: row.progress,
      current_action: row.current_action,
      error_message: row.error_message,
      started_at: row.started_at,
      completed_at: row.completed_at,
      created_at: row.created_at,
    };
  }

  // ========================================================================
  // Presets
  // ========================================================================

  createPreset(data: {
    name: string;
    description?: string;
    config: HandBrakeConfig;
    quick_select?: boolean;
  }): Preset {
    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO presets (id, name, description, is_builtin, quick_select, config, created_at)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `);

    stmt.run(id, data.name, data.description ?? null, data.quick_select ? 1 : 0, JSON.stringify(data.config), now);

    return this.getPresetById(id)!;
  }

  getPresetById(id: string): Preset | undefined {
    const stmt = this.db.prepare('SELECT * FROM presets WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.parsePreset(row) : undefined;
  }

  getPresetByName(name: string): Preset | undefined {
    const stmt = this.db.prepare('SELECT * FROM presets WHERE name = ?');
    const row = stmt.get(name) as any;
    return row ? this.parsePreset(row) : undefined;
  }

  getAllPresets(): Preset[] {
    const stmt = this.db.prepare('SELECT * FROM presets ORDER BY is_builtin DESC, name ASC');
    const rows = stmt.all() as any[];
    return rows.map(row => this.parsePreset(row));
  }

  updatePreset(id: string, data: {
    name?: string;
    description?: string;
    config?: HandBrakeConfig;
    quick_select?: boolean;
  }): void {
    const updates: string[] = [];
    const values: any[] = [];

    if (data.name !== undefined) {
      updates.push('name = ?');
      values.push(data.name);
    }
    if (data.description !== undefined) {
      updates.push('description = ?');
      values.push(data.description);
    }
    if (data.config !== undefined) {
      updates.push('config = ?');
      values.push(JSON.stringify(data.config));
    }
    if (data.quick_select !== undefined) {
      updates.push('quick_select = ?');
      values.push(data.quick_select ? 1 : 0);
    }

    if (updates.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE presets SET ${updates.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  deletePreset(id: string): void {
    const stmt = this.db.prepare('DELETE FROM presets WHERE id = ? AND is_builtin = 0');
    stmt.run(id);
  }

  private parsePreset(row: any): Preset {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      is_builtin: Boolean(row.is_builtin),
      config: JSON.parse(row.config),
      created_at: row.created_at,
    };
  }

  // ========================================================================
  // Quick Select Presets
  // ========================================================================

  createQuickSelectPreset(data: {
    name: string;
    description?: string;
    nvidia_preset_id?: string;
    amd_preset_id?: string;
    intel_preset_id?: string;
    cpu_preset_id?: string;
  }): QuickSelectPreset {
    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO quick_select_presets (id, name, description, is_builtin, nvidia_preset_id, amd_preset_id, intel_preset_id, cpu_preset_id, created_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.name,
      data.description ?? null,
      data.nvidia_preset_id ?? null,
      data.amd_preset_id ?? null,
      data.intel_preset_id ?? null,
      data.cpu_preset_id ?? null,
      now
    );

    return this.getQuickSelectPresetById(id)!;
  }

  getQuickSelectPresetById(id: string): QuickSelectPreset | undefined {
    const stmt = this.db.prepare('SELECT * FROM quick_select_presets WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.parseQuickSelectPreset(row) : undefined;
  }

  getAllQuickSelectPresets(): QuickSelectPreset[] {
    const stmt = this.db.prepare('SELECT * FROM quick_select_presets ORDER BY is_builtin DESC, name ASC');
    const rows = stmt.all() as any[];
    return rows.map(row => this.parseQuickSelectPreset(row));
  }

  updateQuickSelectPreset(id: string, data: {
    name?: string;
    description?: string;
    nvidia_preset_id?: string;
    amd_preset_id?: string;
    intel_preset_id?: string;
    cpu_preset_id?: string;
  }): void {
    const updates: string[] = [];
    const values: any[] = [];

    if (data.name !== undefined) {
      updates.push('name = ?');
      values.push(data.name);
    }
    if (data.description !== undefined) {
      updates.push('description = ?');
      values.push(data.description);
    }
    if (data.nvidia_preset_id !== undefined) {
      updates.push('nvidia_preset_id = ?');
      values.push(data.nvidia_preset_id);
    }
    if (data.amd_preset_id !== undefined) {
      updates.push('amd_preset_id = ?');
      values.push(data.amd_preset_id);
    }
    if (data.intel_preset_id !== undefined) {
      updates.push('intel_preset_id = ?');
      values.push(data.intel_preset_id);
    }
    if (data.cpu_preset_id !== undefined) {
      updates.push('cpu_preset_id = ?');
      values.push(data.cpu_preset_id);
    }

    if (updates.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE quick_select_presets SET ${updates.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  deleteQuickSelectPreset(id: string): void {
    const stmt = this.db.prepare('DELETE FROM quick_select_presets WHERE id = ? AND is_builtin = 0');
    stmt.run(id);
  }

  private parseQuickSelectPreset(row: any): QuickSelectPreset {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      is_builtin: Boolean(row.is_builtin),
      nvidia_preset_id: row.nvidia_preset_id,
      amd_preset_id: row.amd_preset_id,
      intel_preset_id: row.intel_preset_id,
      cpu_preset_id: row.cpu_preset_id,
      created_at: row.created_at,
    };
  }

  // ========================================================================
  // Settings
  // ========================================================================

  getSetting(key: string): string | undefined {
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, value);
  }

  getAllSettings(): Record<string, string> {
    const stmt = this.db.prepare('SELECT key, value FROM settings');
    const rows = stmt.all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  // ========================================================================
  // Activity Log
  // ========================================================================

  logActivity(data: {
    level: 'info' | 'warning' | 'error';
    category: 'system' | 'node' | 'job' | 'file' | 'api';
    message: string;
    metadata?: Record<string, unknown>;
  }): ActivityLog {
    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO activity_log (id, timestamp, level, category, message, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      now,
      data.level,
      data.category,
      data.message,
      data.metadata ? JSON.stringify(data.metadata) : null
    );

    return this.getLogById(id)!;
  }

  getLogById(id: string): ActivityLog | undefined {
    const stmt = this.db.prepare('SELECT * FROM activity_log WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.parseLog(row) : undefined;
  }

  getLogs(options?: {
    limit?: number;
    offset?: number;
    level?: 'info' | 'warning' | 'error';
    category?: 'system' | 'node' | 'job' | 'file' | 'api';
  }): ActivityLog[] {
    let query = 'SELECT * FROM activity_log';
    const params: any[] = [];
    const conditions: string[] = [];

    if (options?.level) {
      conditions.push('level = ?');
      params.push(options.level);
    }
    if (options?.category) {
      conditions.push('category = ?');
      params.push(options.category);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY timestamp DESC';

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
      if (options.offset) {
        query += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.parseLog(row));
  }

  cleanOldLogs(olderThanSeconds: number = 30 * 24 * 60 * 60): number {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
    const stmt = this.db.prepare('DELETE FROM activity_log WHERE timestamp < ?');
    const result = stmt.run(cutoff);
    return result.changes;
  }

  private parseLog(row: any): ActivityLog {
    return {
      id: row.id,
      timestamp: row.timestamp,
      level: row.level,
      category: row.category,
      message: row.message,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    };
  }

  // ========================================================================
  // Statistics
  // ========================================================================

  getDashboardStats(): DashboardStats {
    // Node stats
    const nodeStats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
        SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline,
        SUM(CASE WHEN status = 'busy' THEN 1 ELSE 0 END) as busy
      FROM nodes
    `).get() as { total: number; online: number; offline: number; busy: number };

    // File stats
    const fileStats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM files
    `).get() as { total: number; pending: number; processing: number; completed: number; failed: number };

    // Job stats
    const jobStats = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM jobs
    `).get() as { queued: number; processing: number; completed: number; failed: number };

    // Storage stats
    const storageStats = this.db.prepare(`
      SELECT
        COALESCE(SUM(f.original_size), 0) as original_size,
        COALESCE(SUM(CAST(j.stats->>'transcoded_size' AS INTEGER)), 0) as transcoded_size
      FROM files f
      LEFT JOIN jobs j ON j.file_id = f.id AND j.status = 'completed'
      WHERE f.status = 'completed'
    `).get() as { original_size: number; transcoded_size: number };

    return {
      nodes: {
        total: nodeStats.total,
        online: nodeStats.online,
        offline: nodeStats.offline,
        busy: nodeStats.busy,
      },
      files: {
        total: fileStats.total,
        pending: fileStats.pending,
        processing: fileStats.processing,
        completed: fileStats.completed,
        failed: fileStats.failed,
      },
      jobs: {
        queued: jobStats.queued ?? 0,
        processing: jobStats.processing ?? 0,
        completed: jobStats.completed ?? 0,
        failed: jobStats.failed ?? 0,
      },
      storage: {
        original_size: storageStats.original_size,
        transcoded_size: storageStats.transcoded_size,
        saved_space: Math.max(0, storageStats.original_size - storageStats.transcoded_size),
      },
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let dbInstance: EncorrDatabase | null = null;

export function getDatabase(options?: DatabaseOptions): EncorrDatabase {
  if (!dbInstance) {
    dbInstance = new EncorrDatabase(options);
    dbInstance.initialize();
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
