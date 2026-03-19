-- Encorr Database Schema
-- Version: 1.0.0

-- ============================================================================
-- Nodes Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'offline' CHECK(status IN ('online', 'offline', 'busy', 'error')),
    last_heartbeat INTEGER,
    system_info TEXT, -- JSON: OS, CPU, RAM, HandBrake version
    capabilities TEXT, -- JSON: max_concurrent_jobs, supported formats
    cpu_usage INTEGER DEFAULT 0, -- CPU usage percentage (0-100)
    ram_usage INTEGER DEFAULT 0, -- RAM usage percentage (0-100)
    gpu_usage TEXT, -- JSON array of GPU usage percentages
    active_jobs TEXT, -- JSON array of active job info
    config TEXT, -- JSON: node configuration (cpu_preset, gpu_presets, etc.)
    max_workers TEXT, -- JSON: max workers for cpu and gpu
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
CREATE INDEX IF NOT EXISTS idx_nodes_last_heartbeat ON nodes(last_heartbeat);

-- ============================================================================
-- Folder Mappings Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS folder_mappings (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    server_path TEXT NOT NULL,
    node_path TEXT NOT NULL,
    watch BOOLEAN DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- ============================================================================
-- Libraries Table (for direct file imports)
-- ============================================================================

CREATE TABLE IF NOT EXISTS libraries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_libraries_name ON libraries(name);

-- ============================================================================
-- Library Files Table (imported video files for transcoding)
-- ============================================================================

CREATE TABLE IF NOT EXISTS library_files (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    filesize INTEGER,
    format TEXT,
    duration INTEGER,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped', 'analyzed')),
    job_id TEXT,
    progress INTEGER DEFAULT 0 CHECK(progress >= 0 AND progress <= 100),
    error_message TEXT,
    metadata TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_library_files_library ON library_files(library_id);
CREATE INDEX IF NOT EXISTS idx_library_files_status ON library_files(status);
CREATE INDEX IF NOT EXISTS idx_library_files_format ON library_files(format);

CREATE INDEX IF NOT EXISTS idx_folder_mappings_node ON folder_mappings(node_id);

-- ============================================================================
-- Files Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    folder_mapping_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    original_size INTEGER,
    original_format TEXT,
    original_codec TEXT,
    duration INTEGER,
    resolution TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped', 'analyzed')),
    metadata TEXT, -- JSON: Full metadata
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (folder_mapping_id) REFERENCES folder_mappings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_mapping_id);
CREATE INDEX IF NOT EXISTS idx_files_format ON files(original_format);

-- ============================================================================
-- Jobs Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    node_id TEXT,
    preset_id TEXT NOT NULL,
    status TEXT DEFAULT 'queued' CHECK(status IN ('queued', 'assigned', 'processing', 'completed', 'failed', 'cancelled')),
    progress INTEGER DEFAULT 0 CHECK(progress >= 0 AND progress <= 100),
    current_action TEXT,
    error_message TEXT,
    stats TEXT, -- JSON: Completion stats
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL,
    FOREIGN KEY (preset_id) REFERENCES presets(id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_file ON jobs(file_id);
CREATE INDEX IF NOT EXISTS idx_jobs_node ON jobs(node_id);
CREATE INDEX IF NOT EXISTS idx_jobs_preset ON jobs(preset_id);

-- ============================================================================
-- Job History Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_history (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    node_id TEXT,
    preset_id TEXT NOT NULL,
    preset_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'cancelled')),
    error_message TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    duration_seconds INTEGER,
    original_size INTEGER,
    transcoded_size INTEGER,
    stats TEXT, -- JSON: Additional completion stats
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_job_history_file ON job_history(file_id);
CREATE INDEX IF NOT EXISTS idx_job_history_status ON job_history(status);
CREATE INDEX IF NOT EXISTS idx_job_history_created ON job_history(created_at);

-- ============================================================================
-- ============================================================================
-- Presets Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    is_builtin BOOLEAN DEFAULT 0,
    config TEXT NOT NULL, -- JSON: HandBrake parameters
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Insert built-in presets
INSERT OR IGNORE INTO presets (id, name, description, is_builtin, config) VALUES
    ('builtin-high-quality-h265-cpu', 'High Quality H.265 (CPU)', 'High quality with H.265/HEVC CPU encoding', 1,
     '{"video_codec":"h265","encoding_type":"cpu","quality_mode":"crf","quality":22,"preset":"medium","container":"mkv","audio_encoder":"copy","audio_bitrate":0,"subtitles":"all"}'),
    ('builtin-max-compression-h265-cpu', 'Maximum Compression H.265 (CPU)', 'Smallest file size with H.265 and 1080p cap', 1,
     '{"video_codec":"h265","encoding_type":"cpu","quality_mode":"crf","quality":28,"preset":"slow","container":"mkv","max_width":1920,"max_height":1080,"audio_encoder":"copy","audio_bitrate":0,"subtitles":"first"}'),
    ('builtin-fast-h264-cpu', 'Fast H.264 (CPU)', 'Fast encoding with H.264, minimal quality loss', 1,
     '{"video_codec":"h264","encoding_type":"cpu","quality_mode":"crf","quality":23,"preset":"fast","container":"mkv","audio_encoder":"copy","audio_bitrate":0,"subtitles":"all"}'),
    ('builtin-nvidia-h264-gpu', 'NVIDIA H.264 (GPU)', 'GPU-accelerated encoding with NVIDIA NVENC H.264', 1,
     '{"video_codec":"h264","encoding_type":"gpu","gpu_type":"nvidia","quality_mode":"cq","quality":22,"preset":"fast","container":"mkv","audio_encoder":"copy","audio_bitrate":0,"subtitles":"all"}'),
    ('builtin-nvidia-h265-gpu', 'NVIDIA H.265 (GPU)', 'GPU-accelerated encoding with NVIDIA NVENC H.265', 1,
     '{"video_codec":"h265","encoding_type":"gpu","gpu_type":"nvidia","quality_mode":"cq","quality":24,"preset":"fast","container":"mkv","audio_encoder":"copy","audio_bitrate":0,"subtitles":"all"}'),
    ('builtin-intel-h264-gpu', 'Intel Quick Sync H.264 (GPU)', 'GPU-accelerated encoding with Intel QSV H.264', 1,
     '{"video_codec":"h264","encoding_type":"gpu","gpu_type":"intel","quality_mode":"crf","quality":22,"preset":"medium","container":"mkv","audio_encoder":"copy","audio_bitrate":0,"subtitles":"all"}'),
    ('builtin-intel-h265-gpu', 'Intel Quick Sync H.265 (GPU)', 'GPU-accelerated encoding with Intel QSV H.265', 1,
     '{"video_codec":"h265","encoding_type":"gpu","gpu_type":"intel","quality_mode":"crf","quality":24,"preset":"medium","container":"mkv","audio_encoder":"copy","audio_bitrate":0,"subtitles":"all"}'),
    ('builtin-amd-h264-gpu', 'AMD AMF H.264 (GPU)', 'GPU-accelerated encoding with AMD AMF H.264', 1,
     '{"video_codec":"h264","encoding_type":"gpu","gpu_type":"amd","quality_mode":"qp","quality":22,"preset":"fast","container":"mkv","audio_encoder":"copy","audio_bitrate":0,"subtitles":"all"}'),
    ('builtin-amd-h265-gpu', 'AMD AMF H.265 (GPU)', 'GPU-accelerated encoding with AMD AMF H.265', 1,
     '{"video_codec":"h265","encoding_type":"gpu","gpu_type":"amd","quality_mode":"qp","quality":24,"preset":"fast","container":"mkv","audio_encoder":"copy","audio_bitrate":0,"subtitles":"all"}'),
    ('builtin-mobile-h264-cpu', 'Mobile Optimized H.264 (CPU)', 'Optimized for mobile devices with 720p cap', 1,
     '{"video_codec":"h264","encoding_type":"cpu","quality_mode":"crf","quality":24,"preset":"fast","container":"mkv","max_width":1280,"max_height":720,"audio_encoder":"copy","audio_bitrate":0,"subtitles":"first"}');

-- ============================================================================
-- Quick Select Presets Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS quick_select_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    is_builtin BOOLEAN DEFAULT 0,
    nvidia_preset_id TEXT,
    amd_preset_id TEXT,
    intel_preset_id TEXT,
    cpu_preset_id TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (nvidia_preset_id) REFERENCES presets(id) ON DELETE SET NULL,
    FOREIGN KEY (amd_preset_id) REFERENCES presets(id) ON DELETE SET NULL,
    FOREIGN KEY (intel_preset_id) REFERENCES presets(id) ON DELETE SET NULL,
    FOREIGN KEY (cpu_preset_id) REFERENCES presets(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_quick_select_presets_name ON quick_select_presets(name);

-- ============================================================================
-- Settings Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Insert default settings
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('backendPort', '8101'),
    ('frontendPort', '8100'),
    ('cacheDirectory', '~/.encorr/cache'),
    ('autoScan_enabled', 'true'),
    ('autoScan_intervalMinutes', '60'),
    ('jobLimits_maxConcurrent', '0'),
    ('jobLimits_maxRetries', '2'),
    ('fileRetention_deleteOriginal', 'false'),
    ('fileRetention_keepBackup', 'true');

-- ============================================================================
-- Activity Log Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    timestamp INTEGER DEFAULT (strftime('%s', 'now')),
    level TEXT DEFAULT 'info' CHECK(level IN ('info', 'warning', 'error')),
    category TEXT CHECK(category IN ('system', 'node', 'job', 'file', 'api')),
    message TEXT NOT NULL,
    metadata TEXT -- JSON: Additional context
);

CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_level ON activity_log(level);
CREATE INDEX IF NOT EXISTS idx_activity_log_category ON activity_log(category);

-- ============================================================================
-- Triggers
-- ============================================================================

-- Update file status when job starts
CREATE TRIGGER IF NOT EXISTS update_file_status_on_job_start
AFTER UPDATE OF status ON jobs
WHEN NEW.status = 'processing' AND OLD.status != 'processing'
BEGIN
    UPDATE files SET status = 'processing' WHERE id = NEW.file_id;
END;

-- Update file status when job completes
CREATE TRIGGER IF NOT EXISTS update_file_status_on_job_complete
AFTER UPDATE OF status ON jobs
WHEN NEW.status = 'completed' AND OLD.status != 'completed'
BEGIN
    UPDATE files SET status = 'completed' WHERE id = NEW.file_id;
END;

-- Update file status when job fails
CREATE TRIGGER IF NOT EXISTS update_file_status_on_job_fail
AFTER UPDATE OF status ON jobs
WHEN NEW.status = 'failed' AND OLD.status != 'failed'
BEGIN
    UPDATE files SET status = 'failed' WHERE id = NEW.file_id;
END;

-- Set node to offline if no heartbeat for 90 seconds
CREATE TRIGGER IF NOT EXISTS set_node_offline_no_heartbeat
UPDATE ON nodes
BEGIN
    UPDATE nodes SET status = 'offline'
    WHERE id = NEW.id
    AND NEW.status IN ('online', 'busy')
    AND (NEW.last_heartbeat IS NULL OR NEW.last_heartbeat < strftime('%s', 'now') - 90);
END;
