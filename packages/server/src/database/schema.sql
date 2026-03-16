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
    ('high-quality-h265', 'High Quality (H.265)', 'High quality with H.265/HEVC encoding', 1,
     '{"video_encoder":"x265","quality_mode":"cq","quality":22,"preset":"medium","tune":"film","container":"mp4","crop_mode":"auto","audio_encoder":"aac","audio_bitrate":160,"audio_channels":"auto","subtitles":"all"}'),
    ('maximum-compression', 'Maximum Compression', 'Smallest file size with 1080p cap', 1,
     '{"video_encoder":"x265","quality_mode":"cq","quality":28,"preset":"slow","container":"mp4","max_width":1920,"max_height":1080,"crop_mode":"auto","audio_encoder":"aac","audio_bitrate":128,"audio_channels":"stereo","subtitles":"first"}'),
    ('quick-convert', 'Quick Convert', 'Fast encoding with H.264, minimal quality loss', 1,
     '{"video_encoder":"x264","quality_mode":"cq","quality":23,"preset":"fast","container":"mp4","crop_mode":"auto","audio_encoder":"aac","audio_bitrate":160,"audio_channels":"auto","subtitles":"all"}'),
    ('mkv-to-mp4', 'MKV to MP4', 'Container only conversion, no quality loss', 1,
     '{"video_encoder":"copy","quality_mode":"cq","quality":0,"preset":"fast","container":"mp4","crop_mode":"none","audio_encoder":"aac","audio_bitrate":160,"audio_channels":"auto","subtitles":"all"}');

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
