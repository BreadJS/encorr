import { FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'fs';
import { readdir, rename, stat, unlink } from 'fs/promises';
import { extname, join } from 'path';
import { createHash } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import type { EncorrDatabase } from '../database';
import type { EncorrWebSocketServer } from '../websocket/server';
import type { Logger } from 'winston';
import type {
  CreateNodeRequest,
  CreateMappingRequest,
  UpdateMappingRequest,
  CreateJobRequest,
  CreatePresetRequest,
  UpdateSettingsRequest,
  SmartTranscodeRequest,
  SmartTranscodeResult,
  TranscodeMode,
} from '@encorr/shared';
import { parseFFmpegError } from '@encorr/shared';
import { loadConfig } from '../config';
import { presetOptimizer } from '../services/preset-optimizer';

// ============================================================================
// Plugin Options
// ============================================================================

interface RoutesOptions {
  db: EncorrDatabase;
  wsServer: EncorrWebSocketServer;
  logger: Logger;
}

const COMPARISON_PREVIEW_SECONDS = 60;

// ============================================================================
// Helper Functions
// ============================================================================

function sendSuccess<T>(data: T, message?: string) {
  return { success: true, data, message };
}

function sendError(error: string, statusCode = 400) {
  return { success: false, error };
}

function withParsedFFmpegError<T extends Record<string, any>>(report: T): T {
  if (report.status !== 'failed' || !report.ffmpeg_logs) return report;
  const parsed = parseFFmpegError(report.ffmpeg_logs, report.error_message || 'FFmpeg failed');
  return parsed.recognized ? { ...report, error_message: parsed.message } : report;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function videoContentType(path: string): string {
  const mediaPath = path.toLowerCase().endsWith('.org') ? path.slice(0, -4) : path;
  const extension = extname(mediaPath).toLowerCase();
  if (extension === '.mp4' || extension === '.m4v') return 'video/mp4';
  if (extension === '.webm') return 'video/webm';
  if (extension === '.mov') return 'video/quicktime';
  if (extension === '.avi') return 'video/x-msvideo';
  if (extension === '.mkv') return 'video/x-matroska';
  return 'application/octet-stream';
}

async function sendSeekableVideo(
  request: FastifyRequest,
  reply: FastifyReply,
  path: string,
  filename: string,
) {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new Error('Source is not a file');
  const total = fileStat.size;
  const range = request.headers.range;
  const commonHeaders = {
    'Accept-Ranges': 'bytes',
    'Content-Type': videoContentType(path),
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
  };

  if (!range) {
    reply.headers({ ...commonHeaders, 'Content-Length': String(total) });
    return reply.send(createReadStream(path));
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    reply.status(416).header('Content-Range', `bytes */${total}`);
    return reply.send();
  }
  let requestedStart: number;
  let requestedEnd: number;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    requestedStart = Math.max(0, total - suffixLength);
    requestedEnd = total - 1;
  } else {
    requestedStart = Number(match[1]);
    requestedEnd = match[2] ? Number(match[2]) : total - 1;
  }
  const start = Math.max(0, requestedStart);
  const end = Math.min(total - 1, requestedEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    reply.status(416).header('Content-Range', `bytes */${total}`);
    return reply.send();
  }

  reply.code(206).headers({
    ...commonHeaders,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Content-Length': String(end - start + 1),
  });
  return reply.send(createReadStream(path, { start, end }));
}

// ============================================================================
// API Routes
// ============================================================================

export async function apiRoutes(fastify: FastifyInstance, options: RoutesOptions) {
  const { db, wsServer, logger } = options;

  const resolveComparisonSources = (libraryFileId: string) => {
    const file = db.getLibraryFileById(libraryFileId);
    if (!file) return { ok: false, error: 'File not found' } as const;
    const report = db.getJobReportsByFileId(libraryFileId, 100)
      .filter((item: any) => item.job_type === 'transcode' && item.status === 'completed')
      .sort((a: any, b: any) => (b.completed_at || b.created_at || 0) - (a.completed_at || a.created_at || 0))[0];
    const retainedBackup = db.getOpenStorageBackup(libraryFileId);
    if (retainedBackup?.status === 'backup_retained' && retainedBackup.original_path) {
      const recordedOriginalPath = String(retainedBackup.original_path);
      const backupPath = recordedOriginalPath.endsWith('.org')
        ? recordedOriginalPath
        : `${recordedOriginalPath}.org`;
      const installedPath = recordedOriginalPath.endsWith('.org')
        ? recordedOriginalPath.slice(0, -4)
        : recordedOriginalPath;
      return {
        ok: true,
        sourceKind: 'retained_backup',
        file,
        report: report || null,
        originalPath: backupPath,
        transcodedPath: installedPath,
      } as const;
    }
    if (!report || report.output_available === 0 || !report.output_path) {
      return { ok: false, error: 'No available transcoded output exists for comparison' } as const;
    }
    return {
      ok: true,
      sourceKind: 'pending_output',
      file,
      report,
      originalPath: file.filepath,
      transcodedPath: report.output_path as string,
    } as const;
  };

  type ComparisonPreviewState = {
    status: 'processing' | 'ready' | 'failed';
    progress: number;
    error?: string;
    processes: Set<ChildProcess>;
  };
  const comparisonPreviewJobs = new Map<string, ComparisonPreviewState>();

  const resolveComparisonPreviewTargets = async (libraryFileId: string) => {
    const sources = resolveComparisonSources(libraryFileId);
    if (!sources.ok) throw new Error(sources.error);
    const [originalStat, transcodedStat] = await Promise.all([
      stat(sources.originalPath),
      stat(sources.transcodedPath),
    ]);
    const cacheDirectory = db.getComparisonCacheDirectory();
    const targetFor = (variant: 'original' | 'transcoded', path: string, size: number, modified: number) => {
      const fingerprint = createHash('sha256')
        .update(`preview-v2:${COMPARISON_PREVIEW_SECONDS}:${path}:${size}:${modified}`)
        .digest('hex')
        .slice(0, 16);
      return join(cacheDirectory, `${libraryFileId}-${variant}-${fingerprint}.mp4`);
    };
    return {
      sources,
      original: targetFor('original', sources.originalPath, originalStat.size, originalStat.mtimeMs),
      transcoded: targetFor('transcoded', sources.transcodedPath, transcodedStat.size, transcodedStat.mtimeMs),
    };
  };

  const generateComparisonPreview = (
    inputPath: string,
    outputPath: string,
    durationSeconds: number,
    onProgress: (progress: number) => void,
    processes: Set<ChildProcess>,
  ) => new Promise<void>((resolve, reject) => {
    const temporaryPath = `${outputPath}.tmp.mp4`;
    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-y',
      '-i', inputPath,
      '-t', String(COMPARISON_PREVIEW_SECONDS),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '12',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-sn',
      '-dn',
      '-movflags', '+faststart',
      '-progress', 'pipe:2',
      temporaryPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    processes.add(child);
    let stderr = '';
    let progressBuffer = '';

    child.stderr?.on('data', chunk => {
      const text = chunk.toString();
      stderr = `${stderr}${text}`.slice(-8000);
      progressBuffer += text;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || '';
      for (const line of lines) {
        const match = /^out_time_(?:ms|us)=(\d+)$/.exec(line.trim());
        if (!match || durationSeconds <= 0) continue;
        const seconds = Number(match[1]) / 1_000_000;
        onProgress(Math.max(0, Math.min(99, (seconds / durationSeconds) * 100)));
      }
    });
    child.once('error', error => {
      processes.delete(child);
      void unlink(temporaryPath).catch(() => undefined);
      reject(error);
    });
    child.once('close', code => {
      processes.delete(child);
      if (code !== 0) {
        void unlink(temporaryPath).catch(() => undefined);
        reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
        return;
      }
      rename(temporaryPath, outputPath).then(() => resolve(), reject);
    });
  });

  const startComparisonPreview = async (libraryFileId: string) => {
    const existing = comparisonPreviewJobs.get(libraryFileId);
    if (existing?.status === 'processing') return existing;

    const targets = await resolveComparisonPreviewTargets(libraryFileId);
    const cacheDirectory = db.getComparisonCacheDirectory();
    const currentTargets = new Set([targets.original, targets.transcoded]);
    const cachedEntries = await readdir(cacheDirectory).catch(() => [] as string[]);
    await Promise.all(cachedEntries
      .filter(entry => entry.startsWith(`${libraryFileId}-`))
      .map(entry => join(cacheDirectory, entry))
      .filter(path => !currentTargets.has(path))
      .map(path => unlink(path).catch(() => undefined)));
    const existingFiles = await Promise.all([
      stat(targets.original).then(value => value.isFile()).catch(() => false),
      stat(targets.transcoded).then(value => value.isFile()).catch(() => false),
    ]);
    if (existingFiles.every(Boolean)) {
      const ready: ComparisonPreviewState = { status: 'ready', progress: 100, processes: new Set() };
      comparisonPreviewJobs.set(libraryFileId, ready);
      return ready;
    }

    const state: ComparisonPreviewState = { status: 'processing', progress: 0, processes: new Set() };
    comparisonPreviewJobs.set(libraryFileId, state);
    const sourceDuration = Number(targets.sources.file.metadata?.duration || targets.sources.file.duration || 0);
    const duration = sourceDuration > 0
      ? Math.min(COMPARISON_PREVIEW_SECONDS, sourceDuration)
      : COMPARISON_PREVIEW_SECONDS;
    const progress = { original: existingFiles[0] ? 100 : 0, transcoded: existingFiles[1] ? 100 : 0 };
    const updateProgress = () => {
      state.progress = Math.round((progress.original + progress.transcoded) / 2);
    };

    const tasks: Promise<void>[] = [];
    if (!existingFiles[0]) {
      tasks.push(generateComparisonPreview(
        targets.sources.originalPath,
        targets.original,
        duration,
        value => { progress.original = value; updateProgress(); },
        state.processes,
      ));
    }
    if (!existingFiles[1]) {
      tasks.push(generateComparisonPreview(
        targets.sources.transcodedPath,
        targets.transcoded,
        duration,
        value => { progress.transcoded = value; updateProgress(); },
        state.processes,
      ));
    }

    void Promise.all(tasks).then(() => {
      state.status = 'ready';
      state.progress = 100;
      logger.info(`[COMPARE] Browser-compatible previews ready for ${libraryFileId}`);
    }).catch(error => {
      for (const process of state.processes) process.kill('SIGTERM');
      state.status = 'failed';
      state.error = error instanceof Error ? error.message : 'Preview generation failed';
      logger.error(`[COMPARE] Preview generation failed for ${libraryFileId}: ${state.error}`);
    });
    return state;
  };

  const cancelComparisonPreviews = () => {
    for (const state of comparisonPreviewJobs.values()) {
      for (const process of state.processes) process.kill('SIGTERM');
    }
    comparisonPreviewJobs.clear();
  };
  fastify.addHook('onClose', async () => {
    cancelComparisonPreviews();
  });

  const scheduleBackupCleanupConfirmationTimeout = (libraryFileId: string, operationId: string) => {
    const timeout = setTimeout(() => {
      const operation = db.getOpenStorageBackup(libraryFileId);
      if (!operation || operation.id !== operationId || operation.status !== 'backup_retained') return;
      db.failStorageBackupCleanup(operationId, 'The node did not confirm backup deletion within 30 seconds. Retry the removal.');
      logger.warn(`[FILE_REPLACE] Backup cleanup ${operationId} timed out waiting for node confirmation`);
      wsServer.scheduleWebUpdates();
    }, 30_000);
    timeout.unref();
  };

  // ========================================================================
  // Config (for frontend)
  // ========================================================================

  fastify.get('/config', async (request, reply) => {
    const config = loadConfig();
    return sendSuccess({
      backendPort: config.backendPort,
      frontendPort: config.frontendPort,
      host: config.host,
    });
  });

  // ========================================================================
  // Nodes
  // ========================================================================

  fastify.get('/nodes', async (request, reply) => {
    const nodes = db.getAllNodes();
    const connectedNodes = wsServer.getConnectedNodeIds();

    const nodesWithStatus = nodes.map(node => ({
      ...node,
      active_jobs: (node.active_jobs || []).filter(activeJob => {
        const job = db.getJobById(activeJob.id);
        return job?.status === 'assigned' || job?.status === 'processing';
      }),
      connected: connectedNodes.includes(node.id),
    }));

    return sendSuccess(nodesWithStatus);
  });

  fastify.get('/nodes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = db.getNodeById(id);

    if (!node) {
      reply.status(404);
      return sendError('Node not found');
    }

    const connected = wsServer.isNodeConnected(id);

    return sendSuccess({
      ...node,
      active_jobs: (node.active_jobs || []).filter(activeJob => {
        const job = db.getJobById(activeJob.id);
        return job?.status === 'assigned' || job?.status === 'processing';
      }),
      connected,
    });
  });

  fastify.delete('/nodes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const node = db.getNodeById(id);

    if (!node) {
      reply.status(404);
      return sendError('Node not found');
    }

    db.deleteNode(id);

    logger.info(`Node ${id} deleted`);

    return sendSuccess(null, 'Node deleted');
  });

  fastify.put('/nodes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = request.body as { max_workers?: { cpu: number; gpus?: number[]; gpu?: number }; config?: any };

    logger.info(`Updating node ${id}:`, data);

    const node = db.getNodeById(id);
    if (!node) {
      reply.status(404);
      return sendError('Node not found');
    }

    if (data.max_workers) {
      // Support both old format (gpu) and new format (gpus array)
      const maxWorkers = data.max_workers.gpus !== undefined
        ? { cpu: data.max_workers.cpu, gpus: data.max_workers.gpus }
        : { cpu: data.max_workers.cpu, gpus: [data.max_workers.gpu || 0] };
      db.updateNodeMaxWorkers(id, maxWorkers);
      logger.info(`Updated max_workers for node ${id}:`, maxWorkers);

      // Trigger immediate job assignment since worker availability changed
      wsServer.assignJobsNow();
    }
    if (data.config) {
      db.updateNodeConfig(id, data.config);
    }

    const updatedNode = db.getNodeById(id);
    return sendSuccess(updatedNode, 'Node updated');
  });

  // ========================================================================
  // Folder Mappings
  // ========================================================================

  fastify.get('/mappings', async (request, reply) => {
    const mappings = db.getAllFolderMappings();

    const mappingsWithDetails = mappings.map(mapping => {
      const node = db.getNodeById(mapping.node_id);
      return {
        ...mapping,
        node_name: node?.name,
      };
    });

    return sendSuccess(mappingsWithDetails);
  });

  fastify.post('/mappings', async (request, reply) => {
    const data = request.body as CreateMappingRequest;

    // Validate node exists
    const node = db.getNodeById(data.node_id);
    if (!node) {
      reply.status(400);
      return sendError('Node not found');
    }

    const mapping = db.createFolderMapping({
      node_id: data.node_id,
      server_path: data.server_path,
      node_path: data.node_path,
      watch: data.watch,
    });

    logger.info(`Folder mapping created: ${mapping.id}`);

    return sendSuccess(mapping);
  });

  fastify.get('/mappings/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mapping = db.getFolderMappingById(id);

    if (!mapping) {
      reply.status(404);
      return sendError('Mapping not found');
    }

    const node = db.getNodeById(mapping.node_id);

    return sendSuccess({
      ...mapping,
      node_name: node?.name,
    });
  });

  fastify.put('/mappings/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = request.body as UpdateMappingRequest;

    const mapping = db.getFolderMappingById(id);
    if (!mapping) {
      reply.status(404);
      return sendError('Mapping not found');
    }

    db.updateFolderMapping(id, data);

    const updated = db.getFolderMappingById(id);
    return sendSuccess(updated);
  });

  fastify.delete('/mappings/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mapping = db.getFolderMappingById(id);

    if (!mapping) {
      reply.status(404);
      return sendError('Mapping not found');
    }

    db.deleteFolderMapping(id);

    logger.info(`Folder mapping ${id} deleted`);

    return sendSuccess(null, 'Mapping deleted');
  });

  // ========================================================================
  // Libraries
  // ========================================================================

  const activeLibraryScans = new Set<string>();

  // Get all libraries
  fastify.get('/libraries', async (request, reply) => {
    const libraries = db.getAllLibraries();

    // Include file count for each library
    const librariesWithCounts = libraries.map(lib => ({
      ...lib,
      file_count: db.getLibraryFiles(lib.id).length,
    }));

    return sendSuccess(librariesWithCounts);
  });

  // Get a single library
  fastify.get('/libraries/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const library = db.getLibraryById(id);

    if (!library) {
      reply.status(404);
      return sendError('Library not found');
    }

    const files = db.getLibraryFiles(id);

    return sendSuccess({
      ...library,
      files,
    });
  });

  // Create a library
  fastify.post('/libraries', async (request, reply) => {
    const { name, path } = request.body as { name: string; path: string };

    if (!name || !path) {
      return sendError('Name and path are required');
    }

    const library = db.createLibrary({ name, path });

    logger.info(`Library created: ${library.id} (${name}) at ${path}`);
    db.logActivity({
      level: 'info',
      category: 'system',
      message: `Library "${name}" created`,
      metadata: { library_id: library.id, path },
    });

    return sendSuccess(library);
  });

  // Delete a library
  fastify.delete('/libraries/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const library = db.getLibraryById(id);

    if (!library) {
      reply.status(404);
      return sendError('Library not found');
    }

    // Delete folder mappings associated with this library
    const mappings = db.getAllFolderMappings().filter(m => m.server_path === `library:${id}`);
    mappings.forEach(mapping => db.deleteFolderMapping(mapping.id));

    db.deleteLibrary(id);

    logger.info(`Library deleted: ${id} (${library.name})`);
    db.logActivity({
      level: 'info',
      category: 'system',
      message: `Library "${library.name}" deleted`,
      metadata: { library_id: id },
    });

    return sendSuccess({ deleted: true });
  });

  // Import files from a library path
  fastify.post('/libraries/:id/import', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { recursive = true } = request.body as { recursive?: boolean };

    const library = db.getLibraryById(id);
    if (!library) {
      reply.status(404);
      return sendError('Library not found');
    }

    if (activeLibraryScans.has(id)) {
      reply.status(409);
      return sendError('This library is already being scanned');
    }

    // Video file extensions to support (comprehensive list)
    const videoExtensions = new Set([
      '.mp4', '.mpg', '.mpeg', '.mp2', '.m2v', '.m4v', '.mv2',
      '.avi', '.divx', '.xvid', '.mkv', '.webm', '.flv', '.f4v',
      '.swf', '.vob', '.ogv', '.ogg', '.drc', '.gif', '.gifv',
      '.mng', '.mov', '.qt', '.yuv', '.rm', '.rmvb', '.asf',
      '.amv', '.m1v', '.m2v', '.ts', '.m2ts', '.mts', '.mt2s',
      '.3gp', '.3g2', '.f4p', '.f4a', '.f4b', '.wmv', '.mxf',
      '.nsv', '.wtv', '.bik', '.smk', '.mka', '.m3u', '.m3u8',
      '.vro', '.flc', '.fli', '.dvr-ms', '.wtv', '.wmv',
    ]);

    let importedCount = 0;
    let skippedCount = 0;
    let directoriesScanned = 0;
    let lastBroadcast = 0;

    const publishProgress = (
      status: 'starting' | 'scanning' | 'completed' | 'error',
      currentFile?: string,
      message?: string,
    ) => {
      wsServer.broadcastLibraryScanUpdate({
        library_id: id,
        status,
        imported: importedCount,
        skipped: skippedCount,
        file_count: db.getLibraryFiles(id).length,
        directories_scanned: directoriesScanned,
        current_file: currentFile,
        message,
      });
      lastBroadcast = Date.now();
    };

    activeLibraryScans.add(id);
    publishProgress('starting', undefined, `Scanning ${library.name}`);

    try {
      const pendingDirectories = [library.path];

      while (pendingDirectories.length > 0) {
        const directory = pendingDirectories.pop()!;
        let entries: any[];

        try {
          entries = await readdir(directory, { withFileTypes: true });
          directoriesScanned++;
        } catch (error) {
          if (directory === library.path) throw error;
          skippedCount++;
          logger.warn(`Failed to scan directory ${directory}:`, error);
          continue;
        }

        for (const entry of entries) {
          const fullPath = join(directory, entry.name);

          if (entry.isDirectory()) {
            if (recursive) pendingDirectories.push(fullPath);
            continue;
          }

          if (!entry.isFile()) continue;
          const extensionIndex = entry.name.lastIndexOf('.');
          const ext = extensionIndex >= 0 ? entry.name.slice(extensionIndex).toLowerCase() : '';
          if (!videoExtensions.has(ext)) continue;

          try {
            const stats = await stat(fullPath);
            db.upsertLibraryFile({
              library_id: id,
              filename: entry.name,
              filepath: fullPath,
              filesize: stats.size,
              format: ext.substring(1),
            });
            importedCount++;
          } catch (error) {
            skippedCount++;
            logger.warn(`Failed to import file ${entry.name}:`, error);
          }

          if (importedCount % 10 === 0 || Date.now() - lastBroadcast >= 150) {
            publishProgress('scanning', entry.name);
          }
        }

        publishProgress('scanning');
        await new Promise<void>(resolve => setImmediate(resolve));
      }

      const message = `Imported ${importedCount} file${importedCount !== 1 ? 's' : ''}`;
      publishProgress('completed', undefined, message);
      logger.info(`Library import completed: ${importedCount} imported, ${skippedCount} skipped`);
      db.logActivity({
        level: 'info',
        category: 'file',
        message: `Library "${library.name}" import completed: ${importedCount} files`,
        metadata: { library_id: id, imported_count: importedCount, skipped_count: skippedCount },
      });

      return sendSuccess({ imported: importedCount, skipped: skippedCount, message });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Library scan failed';
      publishProgress('error', undefined, message);
      logger.error(`Library import failed for ${library.name}:`, error);
      reply.status(500);
      return sendError(message);
    } finally {
      activeLibraryScans.delete(id);
    }
  });

  // Get library files
  fastify.get('/libraries/:id/files', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.query as { status?: string };

    const library = db.getLibraryById(id);
    if (!library) {
      reply.status(404);
      return sendError('Library not found');
    }

    let files = db.getLibraryFiles(id);

    if (status) {
      files = files.filter(f => f.status === status);
    }

    return sendSuccess(files);
  });

  // Queue metadata analysis for every library file that has not been analyzed yet.
  fastify.post('/library-files/analyze', async (request, reply) => {
    const { library_id } = (request.body || {}) as { library_id?: string };

    if (library_id && !db.getLibraryById(library_id)) {
      reply.status(404);
      return sendError('Library not found');
    }

    const libraryFiles = library_id
      ? db.getLibraryFiles(library_id)
      : db.getAllLibraries().flatMap(library => db.getLibraryFiles(library.id));
    const candidates = libraryFiles.filter(file => !file.metadata?.video_codec);

    let queued = 0;
    let skipped = libraryFiles.length - candidates.length;

    for (let index = 0; index < candidates.length; index++) {
      const job = db.createJobForLibraryFile(candidates[index].id, 'builtin-analyze');
      if (job) queued++;
      else skipped++;

      // Keep HTTP and WebSocket traffic responsive during very large libraries.
      if ((index + 1) % 100 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }

    wsServer.broadcastJobsUpdate();
    wsServer.assignJobsNow();

    logger.info(`Bulk analysis queued: ${queued} jobs, ${skipped} skipped${library_id ? ` for library ${library_id}` : ''}`);
    return sendSuccess({
      queued,
      skipped,
      total: libraryFiles.length,
      message: queued > 0
        ? `Queued ${queued} file${queued === 1 ? '' : 's'} for analysis`
        : 'All files already have metadata or are queued',
    });
  });

  // Update library file status
  fastify.put('/library-files/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status, job_id, error_message } = request.body as {
      status: string;
      job_id?: string;
      error_message?: string;
    };

    const file = db.getLibraryFileById(id);
    if (!file) {
      reply.status(404);
      return sendError('File not found');
    }

    db.updateLibraryFileStatus(id, status as any, job_id, error_message);

    return sendSuccess({ updated: true });
  });

  // Update library file progress
  fastify.put('/library-files/:id/progress', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { progress } = request.body as { progress: number };

    if (typeof progress !== 'number' || progress < 0 || progress > 100) {
      return sendError('Progress must be between 0 and 100');
    }

    const file = db.getLibraryFileById(id);
    if (!file) {
      reply.status(404);
      return sendError('File not found');
    }

    db.updateLibraryFileProgress(id, progress);

    return sendSuccess({ updated: true });
  });

  // Delete library file
  fastify.delete('/library-files/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const file = db.getLibraryFileById(id);
    if (!file) {
      reply.status(404);
      return sendError('File not found');
    }

    db.deleteLibraryFile(id);

    return sendSuccess({ deleted: true });
  });

  // Quality comparison metadata and seekable media streams. Paths are never
  // accepted from the client; both sources must resolve from trusted DB rows.
  fastify.get('/library-files/:id/compare', async (request, reply) => {
    const { id } = request.params as { id: string };
    const sources = resolveComparisonSources(id);
    if (!sources.ok) {
      reply.status(404);
      return sendError(sources.error);
    }

    try {
      const [originalStat, transcodedStat] = await Promise.all([
        stat(sources.originalPath),
        stat(sources.transcodedPath),
      ]);
      if (!originalStat.isFile() || !transcodedStat.isFile()) throw new Error('A comparison source is not a file');

      let config: any = {};
      try { config = sources.report?.config ? JSON.parse(sources.report.config) : {}; } catch { /* optional report metadata */ }
      const originalMediaPath = sources.originalPath.endsWith('.org') ? sources.originalPath.slice(0, -4) : sources.originalPath;
      const originalResolution = sources.report?.original_resolution?.split('x').map(Number) || [];
      const outputResolution = sources.report?.output_resolution?.split('x').map(Number) || [];
      const usesRetainedBackup = sources.sourceKind === 'retained_backup';
      return sendSuccess({
        id,
        filename: sources.file.filename,
        source_kind: sources.sourceKind,
        original: {
          size: originalStat.size,
          codec: usesRetainedBackup
            ? (sources.report?.original_codec || null)
            : (sources.file.metadata?.video_codec || null),
          width: usesRetainedBackup
            ? (originalResolution[0] || null)
            : (sources.file.metadata?.width || null),
          height: usesRetainedBackup
            ? (originalResolution[1] || null)
            : (sources.file.metadata?.height || null),
          duration: sources.file.metadata?.duration || sources.file.duration || null,
          container: extname(originalMediaPath).slice(1).toLowerCase(),
          stream_url: `/library-files/${id}/compare/original`,
        },
        transcoded: {
          size: transcodedStat.size,
          codec: usesRetainedBackup
            ? (sources.file.metadata?.video_codec || config.video_codec || sources.report?.output_codec || null)
            : (config.video_codec || sources.report?.output_codec || null),
          width: usesRetainedBackup
            ? (sources.file.metadata?.width || outputResolution[0] || config.max_width || null)
            : (outputResolution[0] || config.max_width || null),
          height: usesRetainedBackup
            ? (sources.file.metadata?.height || outputResolution[1] || config.max_height || null)
            : (outputResolution[1] || config.max_height || null),
          duration: sources.file.metadata?.duration || sources.file.duration || null,
          container: extname(sources.transcodedPath).slice(1).toLowerCase(),
          stream_url: `/library-files/${id}/compare/transcoded`,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Comparison media is unavailable';
      logger.warn(`[COMPARE] Could not open sources for ${id}: ${message}`);
      reply.status(404);
      return sendError(`Comparison media is unavailable: ${message}`);
    }
  });

  fastify.post('/library-files/:id/compare/prepare', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const state = await startComparisonPreview(id);
      reply.code(state.status === 'processing' ? 202 : 200);
      return sendSuccess({ status: state.status, progress: state.progress, error: state.error || null });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not prepare compatible previews';
      logger.error(`[COMPARE] Could not start preview generation for ${id}: ${message}`);
      reply.status(500);
      return sendError(message);
    }
  });

  fastify.get('/library-files/:id/compare/preview-status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const active = comparisonPreviewJobs.get(id);
    if (active) {
      return sendSuccess({ status: active.status, progress: active.progress, error: active.error || null });
    }
    try {
      const targets = await resolveComparisonPreviewTargets(id);
      const ready = (await Promise.all([
        stat(targets.original).then(value => value.isFile()).catch(() => false),
        stat(targets.transcoded).then(value => value.isFile()).catch(() => false),
      ])).every(Boolean);
      return sendSuccess({ status: ready ? 'ready' : 'idle', progress: ready ? 100 : 0, error: null });
    } catch (error) {
      reply.status(404);
      return sendError(error instanceof Error ? error.message : 'Comparison sources are unavailable');
    }
  });

  fastify.get('/library-files/:id/compare/:variant/compatible', async (request, reply) => {
    const { id, variant } = request.params as { id: string; variant: 'original' | 'transcoded' };
    if (variant !== 'original' && variant !== 'transcoded') {
      reply.status(400);
      return sendError('Invalid comparison stream');
    }
    try {
      const targets = await resolveComparisonPreviewTargets(id);
      const path = variant === 'original' ? targets.original : targets.transcoded;
      return await sendSeekableVideo(request, reply, path, `${targets.sources.file.filename}.comparison.mp4`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Compatible preview is unavailable';
      logger.warn(`[COMPARE] Compatible ${variant} stream failed for ${id}: ${message}`);
      reply.status(404);
      return sendError('Browser-compatible preview is not ready');
    }
  });

  fastify.get('/library-files/:id/compare/:variant', async (request, reply) => {
    const { id, variant } = request.params as { id: string; variant: 'original' | 'transcoded' };
    if (variant !== 'original' && variant !== 'transcoded') {
      reply.status(400);
      return sendError('Invalid comparison stream');
    }
    const sources = resolveComparisonSources(id);
    if (!sources.ok) {
      reply.status(404);
      return sendError(sources.error);
    }

    const path = variant === 'original' ? sources.originalPath : sources.transcodedPath;
    try {
      return await sendSeekableVideo(request, reply, path, sources.file.filename);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Stream unavailable';
      logger.warn(`[COMPARE] ${variant} stream failed for ${id}: ${message}`);
      reply.status(404);
      return sendError(`${variant === 'original' ? 'Original' : 'Transcoded'} stream is unavailable`);
    }
  });

  // Replace original file with transcoded version
  fastify.post('/library-files/:id/replace', async (request, reply) => {
    const { id } = request.params as { id: string };

    const file = db.getLibraryFileById(id);
    if (!file) {
      reply.status(404);
      return sendError('File not found');
    }

    // Get the latest completed transcode report for this file
    const reports = db.getJobReportsByFileId(id);
    const completedReports = reports.filter((r: any) => r.status === 'completed' && r.job_type === 'transcode');

    if (completedReports.length === 0) {
      reply.status(400);
      return sendError('No completed transcode found for this file');
    }

    // Get the most recent completed report
    const latestReport = completedReports.sort((a: any, b: any) => {
      const aTime = a.completed_at || a.created_at || 0;
      const bTime = b.completed_at || b.created_at || 0;
      return bTime - aTime;
    })[0];

    // Reports are permanent while completed jobs may be cleared from the Jobs
    // page. Prefer the job when it still exists, otherwise use report data.
    const job = db.getJobById(latestReport.job_id);

    // Get the node that processed this job
    const completedNodeId = job?.node_id || latestReport.node_id;
    const node = completedNodeId ? db.getNodeById(completedNodeId) : null;
    if (!node) {
      reply.status(400);
      return sendError('Node that processed this job is not available');
    }

    // Check if the node is connected
    if (!wsServer.isNodeConnected(node.id)) {
      reply.status(400);
      return sendError('Node is not connected. Please ensure the node is online.');
    }

    // Determine the target path on the node using the same logic as job assignment
    // This replicates the logic from assignJobToNodeWithRetry in websocket/server.ts
    const { relative, resolve } = require('path');
    const library = db.getLibraryById(file.library_id);

    if (!library) {
      reply.status(404);
      return sendError('Library not found');
    }

    // Get the file entry to find the folder mapping used for this job
    const fileEntry = (job ? db.getFileById(job.file_id) : undefined)
      || db.getFileForLibraryFile(id, node.id);

    if (!fileEntry) {
      reply.status(404);
      return sendError('File entry not found');
    }

    let mapping = db.getFolderMappingById(fileEntry.folder_mapping_id);
    let useLibraryServerPath = false;
    let libraryServerPath: string | undefined;

    // For library mappings, check if there's a node-specific mapping for the target node
    if (mapping?.server_path?.startsWith('library:')) {
      const libraryId = mapping.server_path.replace('library:', '');
      const nodeMappings = db.getFolderMappingsByNode(node.id);
      const nodeSpecificMapping = nodeMappings.find((m: any) => m.server_path === `library:${libraryId}`);

      if (nodeSpecificMapping) {
        logger.info(`[FILE_REPLACE] Found node-specific mapping for node ${node.name} and library ${libraryId}`);
        mapping = nodeSpecificMapping;
      } else {
        // No node-specific mapping exists - use the library's server path directly
        logger.info(`[FILE_REPLACE] No node-specific mapping for node ${node.name} and library ${libraryId}, using library server path`);
        useLibraryServerPath = true;
        libraryServerPath = library.path;
      }
    }

    // Determine target path using the same logic as job assignment
    let targetPath: string;
    if (mapping?.server_path?.startsWith('library:')) {
      const basePath = useLibraryServerPath ? libraryServerPath! : mapping.node_path;
      if (basePath && (basePath.includes('.mkv') || basePath.includes('.mp4') || basePath.includes('.avi'))) {
        targetPath = basePath;
      } else {
        targetPath = `${basePath}/${fileEntry.relative_path}`;
      }
    } else {
      targetPath = `${mapping?.node_path || library.path}/${fileEntry.relative_path}`;
    }

    const outputPath = job?.output_path || latestReport.output_path;
    if (!outputPath) {
      const outputError = 'Transcoded output path was not recorded; transcode the file again';
      db.markLatestTranscodeOutputUnavailable(id, outputError);
      wsServer.scheduleWebUpdates();
      reply.status(409);
      return sendError(outputError);
    }

    logger.info(`[FILE_REPLACE] Target path for node ${node.id}: ${targetPath}`);

    const reclaimId = db.createStorageReclaim({
      library_file_id: id,
      library_id: library.id,
      library_name: library.name,
      filename: file.filename,
      operation: 'replace',
      original_size: Number(latestReport.original_size || file.filesize || 0),
      replacement_size: Number(latestReport.output_size || 0),
      job_id: latestReport.job_id,
      node_id: node.id,
      node_name: node.name,
      original_path: targetPath,
      replacement_path: outputPath,
    });

    const sent = wsServer.sendFileReplaceCommand(node.id, {
      operation_id: reclaimId,
      file_id: id,
      operation: 'replace',
      source_path: outputPath,
      target_path: targetPath,
      original_filename: file.filename,
    });

    if (!sent) {
      db.failStorageReplacement(id, 'replace', 'Node disconnected before replacement command was sent');
      reply.status(503);
      return sendError('Could not send replacement command to node');
    }

    logger.info(`File replace command sent for file ${id} to node ${node.id}`);

    return sendSuccess({
      message: 'File replacement command sent to node',
      node_id: node.id,
      reclaim_id: reclaimId,
    });
  });

  // Backup original file and replace with transcoded version
  fastify.post('/library-files/:id/backup-replace', async (request, reply) => {
    const { id } = request.params as { id: string };

    const file = db.getLibraryFileById(id);
    if (!file) {
      reply.status(404);
      return sendError('File not found');
    }

    // Get the latest completed transcode report for this file
    const reports = db.getJobReportsByFileId(id);
    const completedReports = reports.filter((r: any) => r.status === 'completed' && r.job_type === 'transcode');

    if (completedReports.length === 0) {
      reply.status(400);
      return sendError('No completed transcode found for this file');
    }

    // Get the most recent completed report
    const latestReport = completedReports.sort((a: any, b: any) => {
      const aTime = a.completed_at || a.created_at || 0;
      const bTime = b.completed_at || b.created_at || 0;
      return bTime - aTime;
    })[0];

    // Reports are permanent while completed jobs may be cleared from the Jobs
    // page. Prefer the job when it still exists, otherwise use report data.
    const job = db.getJobById(latestReport.job_id);

    // Get the node that processed this job
    const completedNodeId = job?.node_id || latestReport.node_id;
    const node = completedNodeId ? db.getNodeById(completedNodeId) : null;
    if (!node) {
      reply.status(400);
      return sendError('Node that processed this job is not available');
    }

    // Check if the node is connected
    if (!wsServer.isNodeConnected(node.id)) {
      reply.status(400);
      return sendError('Node is not connected. Please ensure the node is online.');
    }

    // Determine the target path on the node using the same logic as job assignment
    // This replicates the logic from assignJobToNodeWithRetry in websocket/server.ts
    const { relative, resolve } = require('path');
    const library = db.getLibraryById(file.library_id);

    if (!library) {
      reply.status(404);
      return sendError('Library not found');
    }

    // Get the file entry to find the folder mapping used for this job
    const fileEntry = (job ? db.getFileById(job.file_id) : undefined)
      || db.getFileForLibraryFile(id, node.id);

    if (!fileEntry) {
      reply.status(404);
      return sendError('File entry not found');
    }

    let mapping = db.getFolderMappingById(fileEntry.folder_mapping_id);
    let useLibraryServerPath = false;
    let libraryServerPath: string | undefined;

    // For library mappings, check if there's a node-specific mapping for the target node
    if (mapping?.server_path?.startsWith('library:')) {
      const libraryId = mapping.server_path.replace('library:', '');
      const nodeMappings = db.getFolderMappingsByNode(node.id);
      const nodeSpecificMapping = nodeMappings.find((m: any) => m.server_path === `library:${libraryId}`);

      if (nodeSpecificMapping) {
        logger.info(`[FILE_REPLACE] Found node-specific mapping for node ${node.name} and library ${libraryId}`);
        mapping = nodeSpecificMapping;
      } else {
        // No node-specific mapping exists - use the library's server path directly
        logger.info(`[FILE_REPLACE] No node-specific mapping for node ${node.name} and library ${libraryId}, using library server path`);
        useLibraryServerPath = true;
        libraryServerPath = library.path;
      }
    }

    // Determine target path using the same logic as job assignment
    let targetPath: string;
    if (mapping?.server_path?.startsWith('library:')) {
      const basePath = useLibraryServerPath ? libraryServerPath! : mapping.node_path;
      if (basePath && (basePath.includes('.mkv') || basePath.includes('.mp4') || basePath.includes('.avi'))) {
        targetPath = basePath;
      } else {
        targetPath = `${basePath}/${fileEntry.relative_path}`;
      }
    } else {
      targetPath = `${mapping?.node_path || library.path}/${fileEntry.relative_path}`;
    }

    const outputPath = job?.output_path || latestReport.output_path;
    if (!outputPath) {
      const outputError = 'Transcoded output path was not recorded; transcode the file again';
      db.markLatestTranscodeOutputUnavailable(id, outputError);
      wsServer.scheduleWebUpdates();
      reply.status(409);
      return sendError(outputError);
    }

    logger.info(`[FILE_REPLACE] Target path for node ${node.id}: ${targetPath}`);

    const reclaimId = db.createStorageReclaim({
      library_file_id: id,
      library_id: library.id,
      library_name: library.name,
      filename: file.filename,
      operation: 'backup_replace',
      original_size: Number(latestReport.original_size || file.filesize || 0),
      replacement_size: Number(latestReport.output_size || 0),
      job_id: latestReport.job_id,
      node_id: node.id,
      node_name: node.name,
      original_path: targetPath,
      replacement_path: outputPath,
    });

    const sent = wsServer.sendFileReplaceCommand(node.id, {
      operation_id: reclaimId,
      file_id: id,
      operation: 'backup_replace',
      source_path: outputPath,
      target_path: targetPath,
      original_filename: file.filename,
    });

    if (!sent) {
      db.failStorageReplacement(id, 'backup_replace', 'Node disconnected before replacement command was sent');
      reply.status(503);
      return sendError('Could not send backup replacement command to node');
    }

    logger.info(`File backup & replace command sent for file ${id} to node ${node.id}`);

    return sendSuccess({
      message: 'File backup & replace command sent to node',
      node_id: node.id,
      reclaim_id: reclaimId,
    });
  });

  // Cleanup original backup file (.org)
  fastify.post('/library-files/:id/cleanup-backup', async (request, reply) => {
    const { id } = request.params as { id: string };

    const file = db.getLibraryFileById(id);
    if (!file) {
      reply.status(404);
      return sendError('File not found');
    }

    const trackedBackup = db.getOpenStorageBackup(id);
    if (file.status !== 'backup_replaced' && trackedBackup?.status !== 'backup_retained') {
      reply.status(400);
      return sendError('File does not have a backup to clean up');
    }

    // The storage ledger remains after completed jobs are cleared and is the
    // authoritative source for retained-backup cleanup.
    if (trackedBackup?.status === 'backup_retained') {
      const node = trackedBackup.node_id ? db.getNodeById(trackedBackup.node_id) : null;
      if (!node) {
        reply.status(400);
        return sendError('Node that retains this backup is not available');
      }
      if (!wsServer.isNodeConnected(node.id)) {
        reply.status(400);
        return sendError('Node is not connected. Please ensure the node is online.');
      }
      if (!trackedBackup.original_path) {
        reply.status(400);
        return sendError('The retained backup path was not recorded');
      }

      const targetPath = String(trackedBackup.original_path).endsWith('.org')
        ? trackedBackup.original_path
        : `${trackedBackup.original_path}.org`;
      db.beginStorageBackupCleanup(trackedBackup.id);
      const sent = wsServer.sendFileReplaceCommand(node.id, {
        operation_id: trackedBackup.id,
        file_id: id,
        operation: 'cleanup_backup',
        source_path: '',
        target_path: targetPath,
        original_filename: file.filename,
      });
      if (!sent) {
        db.failStorageBackupCleanup(trackedBackup.id, 'Node disconnected before backup removal was sent');
        reply.status(503);
        return sendError('Could not send backup cleanup command to node');
      }

      scheduleBackupCleanupConfirmationTimeout(id, trackedBackup.id);
      wsServer.scheduleWebUpdates();
      return sendSuccess({
        message: 'Backup removal added to Jobs',
        node_id: node.id,
        reclaim_id: trackedBackup.id,
      });
    }

    // Get the latest completed transcode report for this file
    const reports = db.getJobReportsByFileId(id);
    const completedReports = reports.filter((r: any) => r.status === 'completed' && r.job_type === 'transcode');

    if (completedReports.length === 0) {
      reply.status(400);
      return sendError('No completed transcode found for this file');
    }

    // Get the most recent completed report
    const latestReport = completedReports.sort((a: any, b: any) => {
      const aTime = a.completed_at || a.created_at || 0;
      const bTime = b.completed_at || b.created_at || 0;
      return bTime - aTime;
    })[0];

    // Get the job to find the node
    const job = db.getJobById(latestReport.job_id);
    if (!job) {
      reply.status(400);
      return sendError('Job information not found');
    }

    // Get the node that processed this job
    const node = job.node_id ? db.getNodeById(job.node_id) : null;
    if (!node) {
      reply.status(400);
      return sendError('Node that processed this job is not available');
    }

    // Check if the node is connected
    if (!wsServer.isNodeConnected(node.id)) {
      reply.status(400);
      return sendError('Node is not connected. Please ensure the node is online.');
    }

    // Determine the target path on the node using the same logic as job assignment
    // This replicates the logic from assignJobToNodeWithRetry in websocket/server.ts
    const { relative, resolve } = require('path');
    const library = db.getLibraryById(file.library_id);

    if (!library) {
      reply.status(404);
      return sendError('Library not found');
    }

    // Get the file entry to find the folder mapping used for this job
    const fileEntry = db.getFileById(job.file_id);

    if (!fileEntry) {
      reply.status(404);
      return sendError('File entry not found');
    }

    let mapping = db.getFolderMappingById(fileEntry.folder_mapping_id);
    let useLibraryServerPath = false;
    let libraryServerPath: string | undefined;

    // For library mappings, check if there's a node-specific mapping for the target node
    if (mapping?.server_path?.startsWith('library:')) {
      const libraryId = mapping.server_path.replace('library:', '');
      const nodeMappings = db.getFolderMappingsByNode(node.id);
      const nodeSpecificMapping = nodeMappings.find((m: any) => m.server_path === `library:${libraryId}`);

      if (nodeSpecificMapping) {
        logger.info(`[FILE_REPLACE] Found node-specific mapping for node ${node.name} and library ${libraryId}`);
        mapping = nodeSpecificMapping;
      } else {
        // No node-specific mapping exists - use the library's server path directly
        logger.info(`[FILE_REPLACE] No node-specific mapping for node ${node.name} and library ${libraryId}, using library server path`);
        useLibraryServerPath = true;
        libraryServerPath = library.path;
      }
    }

    // Determine target path using the same logic as job assignment
    // For cleanup, we need to target the .org backup file
    let targetPath: string;
    if (mapping?.server_path?.startsWith('library:')) {
      const basePath = useLibraryServerPath ? libraryServerPath! : mapping.node_path;
      if (basePath && (basePath.includes('.mkv') || basePath.includes('.mp4') || basePath.includes('.avi'))) {
        targetPath = basePath + '.org';
      } else {
        targetPath = `${basePath}/${fileEntry.relative_path}.org`;
      }
    } else {
      targetPath = `${mapping?.node_path || library.path}/${fileEntry.relative_path}.org`;
    }

    logger.info(`[FILE_REPLACE] Target path for node ${node.id}: ${targetPath}`);

    // Older backup replacements may predate storage accounting. The retained
    // backup status is proof that replacement succeeded, so establish its
    // baseline before cleanup without claiming any reclaimed bytes yet.
    if (!db.hasOpenStorageBackup(id)) {
      db.createStorageReclaim({
        library_file_id: id,
        library_id: library.id,
        library_name: library.name,
        filename: file.filename,
        operation: 'backup_replace',
        original_size: Number(latestReport.original_size || file.filesize || 0),
        replacement_size: Number(latestReport.output_size || 0),
        job_id: job.id,
        node_id: node.id,
        node_name: node.name,
        original_path: targetPath.replace(/\.org$/, ''),
        replacement_path: targetPath.replace(/\.org$/, ''),
      });
      db.confirmStorageReplacement(id, 'backup_replace');
    }

    const reclaim = db.getOpenStorageBackup(id);
    if (!reclaim) {
      reply.status(500);
      return sendError('Could not create a tracked backup cleanup operation');
    }
    db.updateStorageReclaimProgress(reclaim.id, {
      progress: 0,
      current_action: 'Waiting for node',
      bytes_processed: 0,
      total_bytes: Number(reclaim.original_size || 0),
      speed_mbps: 0,
    });

    const sent = wsServer.sendFileReplaceCommand(node.id, {
      operation_id: reclaim.id,
      file_id: id,
      operation: 'cleanup_backup',
      source_path: '', // Not needed for cleanup
      target_path: targetPath,
      original_filename: file.filename,
    });

    if (!sent) {
      reply.status(503);
      return sendError('Could not send backup cleanup command to node');
    }

    scheduleBackupCleanupConfirmationTimeout(id, reclaim.id);
    logger.info(`File cleanup backup command sent for file ${id} to node ${node.id}`);

    return sendSuccess({
      message: 'File cleanup backup command sent to node',
      node_id: node.id,
      reclaim_id: reclaim.id,
    });
  });

  // Get all library files with pagination
  fastify.get('/library-files', async (request, reply) => {
    const { page = '1', per_page = '20', status, library_id } = request.query as {
      page?: string;
      per_page?: string;
      status?: string;
      library_id?: string;
    };

    const pageNum = parseInt(page, 10) || 1;
    const perPageNum = parseInt(per_page, 10) || 20;

    if (perPageNum > 1000) {
      reply.status(400);
      return sendError('Maximum per page is 1000');
    }

    // Get all library files from all libraries
    let allFiles: any[] = [];
    const libraries = db.getAllLibraries();

    for (const lib of libraries) {
      if (library_id && lib.id !== library_id) continue;

      const libFiles = db.getLibraryFiles(lib.id);
      allFiles = allFiles.concat(libFiles.map((f: any) => ({ ...f, library_name: lib.name, library_path: lib.path })));
    }

    // Resolve the latest transcode outcome and live work once for the complete
    // result set. Counts must describe the selected library, not only the
    // current pagination slice.
    const latestTranscodeReports = new Map<string, any>();
    for (const storedReport of db.getLatestTranscodeReports()) {
      const report = withParsedFFmpegError(storedReport);
      const libraryFileId = report.library_file_id || report.file_id;
      if (libraryFileId) latestTranscodeReports.set(libraryFileId, report);
    }
    const latestStorageReclaims = new Map<string, any>();
    for (const reclaim of db.getLatestStorageReclaims()) {
      if (reclaim.library_file_id) latestStorageReclaims.set(reclaim.library_file_id, reclaim);
    }

    const activeAnalysisFileIds = new Set<string>();
    const activeTranscodeFileIds = new Set<string>();
    const activeJobs = [
      ...db.getAllJobs({ status: 'queued' }),
      ...db.getAllJobs({ status: 'assigned' }),
      ...db.getAllJobs({ status: 'processing' }),
    ];
    for (const job of activeJobs) {
      const file = db.getFileById(job.file_id);
      if (!file?.folder_mapping_id) continue;
      const mapping = db.getFolderMappingById(file.folder_mapping_id);
      if (!mapping?.server_path?.startsWith('library:')) continue;
      const libraryId = mapping.server_path.replace('library:', '');
      const library = db.getLibraryById(libraryId);
      if (!library) continue;
      const libraryFile = db.getLibraryFileByRelativePath(libraryId, library.path, file.relative_path);
      if (!libraryFile) continue;
      const preset = db.getPresetById(job.preset_id);
      if ((preset?.config as any)?.action === 'analyze') activeAnalysisFileIds.add(libraryFile.id);
      else activeTranscodeFileIds.add(libraryFile.id);
    }

    const statusCounts = {
      all: allFiles.length,
      ready: 0,
      processing: 0,
      transcoded: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    allFiles = allFiles.map((file: any) => {
      const latestReclaim = latestStorageReclaims.get(file.id);
      let displayStatus = file.status;
      if (activeTranscodeFileIds.has(file.id)) {
        displayStatus = 'processing';
      } else if (activeAnalysisFileIds.has(file.id)) {
        displayStatus = 'processing';
      } else if (latestReclaim?.status === 'pending'
        || (latestReclaim?.status === 'backup_retained' && Number(latestReclaim.progress) < 100 && !latestReclaim.error_message)) {
        displayStatus = 'processing';
      } else if (file.status === 'completed' || file.status === 'backup_replaced') {
        displayStatus = 'completed';
      } else {
        const latestReport = latestTranscodeReports.get(file.id);
        if (latestReport) {
          const outputIsAvailable = latestReport.output_available !== 0
            && typeof latestReport.output_path === 'string'
            && latestReport.output_path.trim().length > 0;
          displayStatus = latestReport.status === 'completed'
            ? (outputIsAvailable ? 'transcoded' : 'failed')
            : latestReport.status;
        } else if (file.status === 'analyzed' || file.status === 'imported') {
          displayStatus = 'ready';
        }
      }

      if (displayStatus === 'ready') statusCounts.ready++;
      else if (displayStatus === 'processing') statusCounts.processing++;
      else if (displayStatus === 'transcoded') statusCounts.transcoded++;
      else if (displayStatus === 'completed') statusCounts.completed++;
      else if (displayStatus === 'failed') statusCounts.failed++;
      else if (displayStatus === 'cancelled') statusCounts.cancelled++;

      const latestReport = latestTranscodeReports.get(file.id);
      const outputIsAvailable = latestReport?.output_available !== 0
        && typeof latestReport?.output_path === 'string'
        && latestReport.output_path.trim().length > 0;
      return {
        ...file,
        display_status: displayStatus,
        display_error: latestReport && !outputIsAvailable
          ? (latestReport.error_message || 'Transcoded output is no longer available')
          : file.error_message,
        transcode_output_available: latestReport ? outputIsAvailable : undefined,
        old_size: Number(latestReclaim?.original_size || latestReport?.original_size || 0) || null,
      };
    });

    if (status && status !== 'all') {
      allFiles = allFiles.filter((file: any) => file.display_status === status);
    }

    // Sort by created_at (newest first)
    allFiles.sort((a: any, b: any) => b.created_at - a.created_at);

    // Get total count
    const total = allFiles.length;

    // Paginate
    const startIndex = (pageNum - 1) * perPageNum;
    const endIndex = startIndex + perPageNum;
    const paginatedFiles = allFiles.slice(startIndex, endIndex);

    return sendSuccess({
      items: paginatedFiles,
      total,
      page: pageNum,
      per_page: perPageNum,
      total_pages: Math.ceil(total / perPageNum),
      status_counts: statusCounts,
    });
  });

  // Browse directory
  fastify.post('/filesystem/browse', async (request, reply) => {
    const { path = '.' } = request.body as { path?: string };

    try {
      const { readdirSync, statSync, existsSync } = require('fs');
      const { resolve, sep } = require('path');
      const { platform } = require('os');

      const targetPath = resolve(path);

      if (!existsSync(targetPath)) {
        reply.status(404);
        return sendError('Path does not exist');
      }

      const stats = statSync(targetPath);

      if (!stats.isDirectory()) {
        reply.status(400);
        return sendError('Path is not a directory');
      }

      const entries = readdirSync(targetPath, { withFileTypes: true });
      const items: { name: string; path: string; type: 'directory' }[] = [];

      // Only include directories, not files
      for (const entry of entries) {
        try {
          const entryPath = resolve(targetPath, entry.name);
          const entryStats = statSync(entryPath);

          if (entryStats.isDirectory()) {
            items.push({
              name: entry.name,
              path: entryPath,
              type: 'directory',
            });
          }
        } catch (err) {
          // Skip entries we can't read
          continue;
        }
      }

      // Sort alphabetically
      items.sort((a, b) => a.name.localeCompare(b.name));

      // Get parent directory path (only if not at root)
      const parentPath = resolve(targetPath, '..');

      return sendSuccess({
        platform: platform(),
        current_path: targetPath,
        // Only show parent if it's different from current path (we're not at root)
        parent_path: parentPath !== targetPath ? parentPath : null,
        items,
      });
    } catch (error: any) {
      logger.error('Error browsing directory:', error);
      reply.status(500);
      return sendError(error.message || 'Failed to browse directory');
    }
  });

  // Validate path
  fastify.post('/filesystem/validate', async (request, reply) => {
    const { path } = request.body as { path: string };

    if (!path) {
      return sendError('Path is required');
    }

    try {
      const { existsSync, statSync } = require('fs');
      const { resolve } = require('path');

      const targetPath = resolve(path);

      if (!existsSync(targetPath)) {
        return sendSuccess({
          valid: false,
          error: 'Path does not exist',
        });
      }

      const stats = statSync(targetPath);

      if (!stats.isDirectory()) {
        return sendSuccess({
          valid: false,
          error: 'Path is not a directory',
        });
      }

      return sendSuccess({
        valid: true,
        path: targetPath,
      });
    } catch (error: any) {
      return sendSuccess({
        valid: false,
        error: error.message || 'Failed to validate path',
      });
    }
  });

  // Get available drives (Windows only)
  fastify.get('/filesystem/drives', async (request, reply) => {
    try {
      const { existsSync, statSync } = require('fs');
      const { platform } = require('os');

      // Only return drives on Windows
      if (platform() !== 'win32') {
        return sendSuccess({
          platform: platform(),
          drives: [],
        });
      }

      // Check common Windows drive letters (C-Z)
      const drives: { letter: string; path: string; label?: string }[] = [];
      const driveLetters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

      for (const letter of driveLetters) {
        const drivePath = `${letter}:\\`;
        try {
          if (existsSync(drivePath)) {
            const stats = statSync(drivePath);
            drives.push({
              letter: `${letter}:`,
              path: drivePath,
            });
          }
        } catch (err) {
          // Drive doesn't exist or is inaccessible
          continue;
        }
      }

      return sendSuccess({
        platform: platform(),
        drives,
      });
    } catch (error: any) {
      logger.error('Error getting drives:', error);
      return sendSuccess({
        platform: require('os').platform(),
        drives: [],
      });
    }
  });

  // ========================================================================
  // Files
  // ========================================================================

  fastify.get('/files', async (request, reply) => {
    const { status, limit, offset } = request.query as {
      status?: string;
      limit?: string;
      offset?: string;
    };

    const options: any = {};
    if (status) options.status = status;
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);

    const files = db.getAllFiles(options);
    const total = db.getFileCount(options);

    return sendSuccess({
      items: files,
      total,
      page: offset ? Math.floor(parseInt(offset, 10) / (parseInt(limit || '50', 10))) + 1 : 1,
      per_page: parseInt(limit || '50', 10),
      total_pages: Math.ceil(total / parseInt(limit || '50', 10)),
    });
  });

  fastify.get('/files/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const file = db.getFileById(id);

    if (!file) {
      reply.status(404);
      return sendError('File not found');
    }

    const mapping = db.getFolderMappingById(file.folder_mapping_id);
    const node = mapping ? db.getNodeById(mapping.node_id) : null;
    const jobs = db.getJobsByFile(id);

    return sendSuccess({
      ...file,
      folder_mapping: mapping,
      node_name: node?.name,
      jobs,
    });
  });

  // NOTE: Scanning endpoint disabled - nodes no longer handle scanning
  // TODO: Implement server-side scanning using local ffprobe
  fastify.post('/files/scan', async (request, reply) => {
    return sendError(
      'Scanning is currently disabled. Nodes no longer handle directory scanning. ' +
      'File scanning will be implemented server-side in a future update.',
      501
    );
  });

  // ========================================================================
  // Jobs
  // ========================================================================

  fastify.post('/jobs/library', async (request, reply) => {
    const data = (request.body || {}) as {
      library_id: string;
      analyze: boolean;
      transcode: boolean;
      quick_select_id?: string;
      allow_gpu?: boolean;
      allow_cpu?: boolean;
      post_action?: 'keep' | 'replace' | 'backup_replace';
      include_transcoded?: boolean;
    };
    const libraries = data.library_id === 'all'
      ? db.getAllLibraries()
      : [db.getLibraryById(data.library_id)].filter(Boolean) as any[];
    if (libraries.length === 0) {
      reply.status(404);
      return sendError('Library not found');
    }
    if (!data.analyze && !data.transcode) {
      reply.status(400);
      return sendError('Choose analysis, transcoding, or both');
    }
    const quickSelect = data.quick_select_id ? db.getQuickSelectPresetById(data.quick_select_id) : null;
    const routingPresetId = quickSelect
      ? quickSelect.cpu_preset_id || quickSelect.nvidia_preset_id || quickSelect.amd_preset_id || quickSelect.intel_preset_id
      : null;
    if (data.transcode && (!quickSelect || !routingPresetId || !db.getPresetById(routingPresetId))) {
      reply.status(400);
      return sendError('Choose a valid Quick Select routing preset');
    }
    if (data.transcode && data.allow_gpu === false && data.allow_cpu === false) {
      reply.status(400);
      return sendError('Enable GPU routing, CPU routing, or both');
    }

    const libraryFiles = libraries.flatMap(library => db.getLibraryFiles(library.id));
    const alreadyTranscoded = new Set(
      db.getLatestTranscodeReports()
        .filter((report: any) => report.status === 'completed')
        .map((report: any) => report.library_file_id || report.file_id),
    );
    let queued = 0;
    let filesQueued = 0;
    for (let index = 0; index < libraryFiles.length; index++) {
      const file = libraryFiles[index];
      const replaced = file.status === 'completed' || file.status === 'backup_replaced';
      let createdForFile = false;
      let analysisJob: any = null;

      if (data.analyze && !file.metadata?.video_codec && !replaced) {
        analysisJob = db.createJobForLibraryFile(file.id, 'builtin-analyze');
        if (analysisJob) {
          queued++;
          createdForFile = true;
        }
      }

      const canTranscode = !replaced
        && (file.metadata?.video_codec || analysisJob)
        && (data.include_transcoded || !alreadyTranscoded.has(file.id));
      if (data.transcode && canTranscode) {
        const transcodeJob = db.createJobForLibraryFile(
          file.id,
          routingPresetId!,
          undefined,
          data.post_action || 'keep',
          analysisJob?.id,
          quickSelect!.id,
          data.allow_gpu !== false,
          data.allow_cpu === true,
        );
        if (transcodeJob) {
          queued++;
          createdForFile = true;
        }
      }

      if (createdForFile) filesQueued++;
      if ((index + 1) % 100 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }

    wsServer.broadcastJobsUpdate();
    wsServer.assignJobsNow();
    return sendSuccess({ queued, skipped: libraryFiles.length - filesQueued, total: libraryFiles.length });
  });

  fastify.get('/jobs', async (request, reply) => {
    const { status, limit, offset } = request.query as {
      status?: string;
      limit?: string;
      offset?: string;
    };

    const options: any = {};
    if (status) options.status = status;
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);

    const jobs = db.getAllJobs(options);

    // Enrich with file and preset info
    const enrichedJobs = jobs.map(job => {
      const file = db.getFileById(job.file_id);
      const preset = db.getPresetById(job.preset_id);
      const quickSelect = job.quick_select_id ? db.getQuickSelectPresetById(job.quick_select_id) : null;
      const node = job.node_id ? db.getNodeById(job.node_id) : null;

      // Check if this is a library file and get metadata
      let metadata = null;
      let libraryFileId: string | null = null;
      if (file?.folder_mapping_id) {
        const mapping = db.getFolderMappingById(file.folder_mapping_id);
        if (mapping?.server_path?.startsWith('library:')) {
          const libraryId = mapping.server_path.replace('library:', '');
          const library = db.getLibraryById(libraryId);
          const libFile = library
            ? db.getLibraryFileByRelativePath(libraryId, library.path, file.relative_path)
            : undefined;
          libraryFileId = libFile?.id || null;
          if (libFile?.metadata) {
            metadata = libFile.metadata;
          }
        }
      }

      // Get codec info from metadata or file
      const codec = metadata?.video_codec || file?.original_codec || '';
      const resolution = metadata?.width && metadata?.height
        ? `${metadata.width}x${metadata.height}`
        : (file?.resolution || '');

      return {
        ...job,
        library_file_id: libraryFileId,
        file_name: file?.relative_path,
        file_size: file?.original_size,
        preset_name: quickSelect ? `Quick Select · ${quickSelect.name}` : preset?.name,
        routed_preset_name: quickSelect ? preset?.name : null,
        job_type: (preset?.config as any)?.action === 'analyze' ? 'analyze' : 'transcode',
        encoding_type: (preset?.config as any)?.action === 'analyze'
          ? 'cpu'
          : ((preset?.config as any)?.encoding_type || 'cpu'),
        node_name: node?.name,
        // Include metadata fields for display
        original_codec: codec,
        resolution: resolution,
        container: metadata?.container || file?.original_format || '',
        duration: metadata?.duration || file?.duration || 0,
        // Target codec from preset config
        target_codec: preset?.config?.video_codec || '',
        // Include full metadata for detailed view
        metadata: metadata,
      };
    });

    const fileOperations = db.getStorageReclaims(250).map((operation: any) => {
      const cleanupFailed = operation.status === 'backup_retained' && Boolean(operation.error_message);
      const cleanupInProgress = operation.status === 'backup_retained' && Number(operation.progress) < 100 && !cleanupFailed;
      const mappedStatus = cleanupFailed ? 'failed' : operation.status === 'pending' || cleanupInProgress
        ? 'processing'
        : operation.status === 'failed' ? 'failed' : 'completed';
      return {
        id: `file-operation:${operation.id}`,
        operation_id: operation.id,
        file_id: operation.library_file_id,
        file_operation: true,
        operation: cleanupInProgress || cleanupFailed ? 'cleanup_backup' : operation.operation,
        job_type: 'file_operation',
        status: mappedStatus,
        progress: Number(operation.progress || 0),
        current_action: operation.current_action || 'Waiting for node',
        bytes_processed: Number(operation.bytes_processed || 0),
        total_bytes: Number(operation.total_bytes || operation.replacement_size || 0),
        speed_mbps: Number(operation.speed_mbps || 0),
        file_name: operation.filename,
        file_size: Number(operation.original_size || 0),
        preset_name: operation.operation === 'backup_replace' ? 'Backup & Replace' : 'Replace Original',
        node_id: operation.node_id,
        node_name: operation.node_name,
        error_message: operation.error_message,
        created_at: operation.created_at,
        started_at: operation.started_at,
        completed_at: operation.completed_at || operation.reclaimed_at,
      };
    });

    return sendSuccess([...enrichedJobs, ...fileOperations]);
  });

  fastify.get('/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = db.getJobById(id);

    if (!job) {
      reply.status(404);
      return sendError('Job not found');
    }

    const file = db.getFileById(job.file_id);
    const preset = db.getPresetById(job.preset_id);
    const node = job.node_id ? db.getNodeById(job.node_id) : null;

    // Check if this is a library file and get metadata
    let metadata = null;
    if (file?.folder_mapping_id) {
      const mapping = db.getFolderMappingById(file.folder_mapping_id);
      if (mapping?.server_path?.startsWith('library:')) {
        // Construct the full filepath
        const fullPath = mapping.node_path && !mapping.node_path.includes('.mkv') && !mapping.node_path.includes('.mp4')
          ? `${mapping.node_path}/${file.relative_path}`
          : mapping.node_path || file.relative_path;

        const libFile = db.getLibraryFileByFilepath(fullPath);
        if (libFile?.metadata) {
          metadata = libFile.metadata;
        }
      }
    }

    // Enrich the file object with metadata
    const enrichedFile = file ? {
      ...file,
      metadata: metadata || (file as any).metadata,
    } : null;

    return sendSuccess({
      ...job,
      file: enrichedFile,
      preset,
      node,
      original_codec: metadata?.video_codec || file?.original_codec || '',
      resolution: metadata?.width && metadata?.height
        ? `${metadata.width}x${metadata.height}`
        : (file?.resolution || ''),
      container: metadata?.container || file?.original_format || '',
      target_codec: preset?.config?.video_codec || '',
      job_type: (preset?.config as any)?.action === 'analyze' ? 'analyze' : 'transcode',
    });
  });

  fastify.post('/jobs', async (request, reply) => {
    const data = request.body as CreateJobRequest;

    logger.info(`Creating jobs with preset_id: ${data.preset_id}`);

    // List all available presets for debugging
    const allPresets = db.getAllPresets();
    logger.info(`Available presets: ${allPresets.map(p => `${p.id} (${p.name})`).join(', ')}`);

    // Validate preset exists
    const preset = db.getPresetById(data.preset_id);
    if (!preset) {
      logger.error(`Preset '${data.preset_id}' not found. Available presets:`, allPresets.map(p => p.id));
      reply.status(400);
      return sendError('Preset not found');
    }

    const jobs = [];

    for (const file_id of data.file_ids) {
      // First try to get file from files table
      let file = db.getFileById(file_id);

      if (file) {
        // Regular file from folder mapping
        const job = db.createJob({
          file_id,
          preset_id: data.preset_id,
        });
        jobs.push(job);
        logger.info(`Job ${job.id} created for file ${file_id}`);
      } else {
        // Try library file
        const libFile = db.getLibraryFileById(file_id);
        if (libFile) {
          // Library file - create job with special handling
          const job = db.createJobForLibraryFile(file_id, data.preset_id);
          if (job) {
            jobs.push(job);
            logger.info(`Job ${job.id} created for library file ${file_id}`);
          } else {
            logger.warn(`Could not create job for library file ${file_id}`);
          }
        } else {
          logger.warn(`File ${file_id} not found in either files or library_files table, skipping`);
        }
      }
    }

    // Broadcast job list immediately so clients see new jobs in queue
    wsServer.broadcastJobsUpdate();

    // Trigger immediate job assignment
    wsServer.assignJobsNow();

    return sendSuccess(jobs);
  });

  // Smart transcoding endpoint - automatically selects optimal presets or uses user-selected preset
  fastify.post('/jobs/smart', async (request, reply) => {
    const data = request.body as SmartTranscodeRequest;
    const {
      file_ids,
      mode = 'auto',
      preset_id: userPresetId,
      quick_select_id: quickSelectId,
      post_action: postAction = 'keep',
    } = data;

    if (!['keep', 'replace', 'backup_replace'].includes(postAction)) {
      reply.status(400);
      return sendError('Choose a valid action for completed transcodes');
    }

    logger.info(`[SMART_TRANSCODE] Creating smart transcoding jobs for ${file_ids.length} files with mode: ${mode}${userPresetId ? `, preset: ${userPresetId}` : ''}`);

    // Get all available presets
    const presets = db.getAllPresets();
    if (presets.length === 0) {
      reply.status(500);
      return sendError('No presets available');
    }

    const quickSelect = quickSelectId ? db.getQuickSelectPresetById(quickSelectId) : null;
    const routingPresetId = quickSelect
      ? quickSelect.nvidia_preset_id || quickSelect.amd_preset_id || quickSelect.intel_preset_id || quickSelect.cpu_preset_id
      : null;
    if (mode === 'gpu' && (!quickSelect || !routingPresetId || !db.getPresetById(routingPresetId))) {
      reply.status(400);
      return sendError('Choose a valid Quick Select routing preset');
    }

    // Get all online nodes for hardware capability detection
    // Include both 'online' and 'busy' nodes (busy nodes are still connected and can accept jobs)
    const allNodes = db.getAllNodes();
    const onlineNodes = allNodes.filter(node => node.status === 'online' || node.status === 'busy');

    if (onlineNodes.length === 0) {
      reply.status(400);
      return sendError('No online nodes available for transcoding');
    }

    const availableGpuVendors = new Set<string>();
    for (const node of onlineNodes) {
      for (const gpu of node.system_info?.gpus || []) {
        const identity = `${gpu.vendor || ''} ${gpu.name || ''}`.toLowerCase();
        if (/nvidia|geforce|quadro|tesla/.test(identity)) availableGpuVendors.add('nvidia');
        else if (/amd|advanced micro|radeon|ati/.test(identity)) availableGpuVendors.add('amd');
        else if (/intel/.test(identity)) availableGpuVendors.add('intel');
      }
    }
    const compatibleGpuPreset = presets.find(preset =>
      preset.config.encoding_type === 'gpu'
      && preset.config.video_codec === 'h265'
      && preset.config.gpu_type
      && availableGpuVendors.has(preset.config.gpu_type)
    ) || presets.find(preset =>
      preset.config.encoding_type === 'gpu'
      && preset.config.gpu_type
      && availableGpuVendors.has(preset.config.gpu_type)
    );

    // Track processed source files to prevent duplicates
    // (different library files may point to the same physical file)
    const processedSourcePaths = new Set<string>();
    logger.info(`[SMART_TRANSCODE] Deduplication tracking initialized for ${file_ids.length} files`);

    // Process each file and create jobs
    const jobResults: any[] = [];
    let totalOriginalSize = 0;
    let totalEstimatedSize = 0;

    for (const file_id of file_ids) {
      // Try to get file from library_files table first
      let libFile = db.getLibraryFileById(file_id);
      let metadata = libFile?.metadata;
      let fileName = libFile?.filename || 'Unknown';
      let fileSize = libFile?.filesize || 0;
      let sourcePath: string | undefined = libFile?.filepath;

      if (!libFile) {
        // Try regular files table
        const videoFile = db.getFileById(file_id);
        if (videoFile) {
          // Get metadata from folder mapping if available
          const mapping = db.getFolderMappingById(videoFile.folder_mapping_id);
          let fullPath: string | undefined;
          if (mapping?.server_path?.startsWith('library:')) {
            fullPath = mapping.node_path && !mapping.node_path.includes('.mkv') && !mapping.node_path.includes('.mp4')
              ? `${mapping.node_path}/${videoFile.relative_path}`
              : mapping.node_path || videoFile.relative_path;

            const foundLibFile = db.getLibraryFileByFilepath(fullPath);
            if (foundLibFile?.metadata) {
              metadata = foundLibFile.metadata;
            }
            if (foundLibFile) {
              fileSize = foundLibFile.filesize || 0;
            }
          }
          fileName = videoFile.relative_path || 'Unknown';
          fileSize = fileSize || videoFile.original_size || 0;

          // For regular files, use the mapped path as the source path for deduplication
          const regularFileSourcePath = fullPath || `${mapping?.node_path || ''}/${videoFile.relative_path}`;

          // Check if we've already processed this source file (avoid duplicates)
          if (processedSourcePaths.has(regularFileSourcePath)) {
            logger.warn(`[SMART_TRANSCODE] Skipping duplicate source file: ${regularFileSourcePath} (file ${file_id})`);
            continue;
          }
          processedSourcePaths.add(regularFileSourcePath);
          logger.debug(`[SMART_TRANSCODE] Tracking source file: ${regularFileSourcePath}`);

          // Create job for regular file using createJob
          if (metadata) {
            let presetId: string;
            let reason: string;
            let expectedCompression: string;

            if (quickSelect && routingPresetId) {
              presetId = routingPresetId;
              reason = `Quick Select routing: ${quickSelect.name}`;
              expectedCompression = 'Depends on the matched GPU preset';
              logger.info(`[SMART_TRANSCODE] File ${file_id}: ${reason}`);
            } else if (userPresetId) {
              // User explicitly selected a preset
              presetId = userPresetId;
              const preset = db.getPresetById(presetId);
              reason = `User selected preset: ${preset?.name || presetId}`;
              expectedCompression = 'Unknown (user preset)';
              logger.info(`[SMART_TRANSCODE] File ${file_id}: ${reason}`);
            } else {
              // Auto-select optimal preset
              const analysis = presetOptimizer.analyzeFile(metadata, fileSize);
              const recommendation = presetOptimizer.recommendForFile(analysis, onlineNodes, presets, mode);

              logger.info(`[SMART_TRANSCODE] File ${file_id}: ${recommendation.reason}`);

              presetId = recommendation.recommendedPresetId;
              reason = recommendation.reason;
              expectedCompression = recommendation.expectedCompression;
            }

            const job = db.createJob({
              file_id,
              preset_id: presetId,
              post_action: postAction,
              quick_select_id: quickSelect?.id,
              allow_gpu: true,
              allow_cpu: mode !== 'gpu',
            });

            // Parse expected compression to estimate size
            const compressionMatch = expectedCompression.match(/(\d+)%/);
            const compressionPercent = compressionMatch ? parseInt(compressionMatch[1], 10) : 50;
            const originalSize = fileSize;
            const estimatedSize = Math.round(originalSize * (1 - compressionPercent / 100));

            totalOriginalSize += originalSize;
            totalEstimatedSize += estimatedSize;

            jobResults.push({
              fileId: file_id,
              jobId: job.id,
              fileName,
              presetId: presetId,
              presetName: db.getPresetById(presetId)?.name || 'Unknown',
              reason: reason,
              expectedCompression: expectedCompression,
              originalSize,
              estimatedSize,
              mode,
            });
            continue;
          }
        }
      }

      if (!libFile && !db.getFileById(file_id)) {
        logger.warn(`[SMART_TRANSCODE] File ${file_id} not found, skipping`);
        continue;
      }

      // For library files, use createJobForLibraryFile
      if (libFile) {
        // Check if we've already processed this source file (avoid duplicates)
        if (sourcePath && processedSourcePaths.has(sourcePath)) {
          logger.warn(`[SMART_TRANSCODE] Skipping duplicate source file: ${sourcePath} (library file ${file_id})`);
          continue;
        }

        // Mark this source file as processed
        if (sourcePath) {
          processedSourcePaths.add(sourcePath);
          logger.debug(`[SMART_TRANSCODE] Tracking source file: ${sourcePath}`);
        }

        let job;
        let presetId: string;
        let reason: string;
        let expectedCompression: string;

        if (quickSelect && routingPresetId) {
          presetId = routingPresetId;
          reason = `Quick Select routing: ${quickSelect.name}`;
          expectedCompression = 'Depends on the matched GPU preset';
          logger.info(`[SMART_TRANSCODE] Library file ${file_id}: ${reason}`);
          job = db.createJobForLibraryFile(
            file_id,
            presetId,
            undefined,
            postAction,
            undefined,
            quickSelect.id,
            true,
            mode !== 'gpu',
          );
        } else if (userPresetId) {
          // User explicitly selected a preset
          presetId = userPresetId;
          const preset = db.getPresetById(presetId);
          reason = `User selected preset: ${preset?.name || presetId}`;
          expectedCompression = 'Unknown (user preset)';
          logger.info(`[SMART_TRANSCODE] Library file ${file_id}: ${reason}`);
          job = db.createJobForLibraryFile(file_id, presetId, undefined, postAction);
        } else if (metadata) {
          // Auto-select optimal preset based on file analysis
          const analysis = presetOptimizer.analyzeFile(metadata, fileSize);
          const recommendation = presetOptimizer.recommendForFile(analysis, onlineNodes, presets, mode);

          logger.info(`[SMART_TRANSCODE] Library file ${file_id}: ${recommendation.reason}`);

          presetId = recommendation.recommendedPresetId;
          reason = recommendation.reason;
          expectedCompression = recommendation.expectedCompression;

          job = db.createJobForLibraryFile(file_id, presetId, undefined, postAction);
        } else {
          // No metadata available - use default preset based on mode
          if (mode === 'gpu') {
            const nvidiaPreset = presets.find(p =>
              p.config.encoding_type === 'gpu' &&
              p.config.gpu_type === 'nvidia' &&
              p.config.video_codec === 'h265'
            );
            presetId = nvidiaPreset?.id || presets.find(p => p.config.encoding_type === 'gpu')?.id || presets[0].id;
            reason = 'No metadata available - using NVIDIA GPU preset';
          } else if (mode === 'cpu') {
            const cpuPreset = presets.find(p =>
              p.config.encoding_type === 'cpu' &&
              p.config.video_codec === 'h265'
            );
            presetId = cpuPreset?.id || presets[0].id;
            reason = 'No metadata available - using CPU H.265 preset';
          } else {
            const gpuPreset = compatibleGpuPreset;
            presetId = gpuPreset?.id || presets.find(p => p.config.encoding_type === 'cpu')?.id || presets[0].id;
            reason = gpuPreset
              ? `No metadata available - using ${gpuPreset.config.gpu_type?.toUpperCase()} GPU preset`
              : 'No metadata available - using CPU preset';
          }
          expectedCompression = 'Unknown (no metadata)';

          job = db.createJobForLibraryFile(file_id, presetId, undefined, postAction);
        }

        if (!job) {
          logger.warn(`[SMART_TRANSCODE] Failed to create job for library file ${file_id}`);
          continue;
        }

        const preset = db.getPresetById(presetId);
        const originalSize = fileSize;
        const estimatedSize = Math.round(originalSize * 0.5); // Rough estimate when no metadata

        totalOriginalSize += originalSize;
        totalEstimatedSize += estimatedSize;

        jobResults.push({
          fileId: file_id,
          jobId: job.id,
          fileName,
          presetId,
          presetName: preset?.name || 'Unknown',
          reason,
          expectedCompression,
          originalSize,
          estimatedSize,
          mode,
        });
      }
    }

    // Broadcast job list immediately so clients see new jobs in queue
    wsServer.broadcastJobsUpdate();

    // Trigger immediate job assignment
    wsServer.assignJobsNow();

    const result: SmartTranscodeResult = {
      success: true,
      jobs: jobResults,
      summary: {
        total: jobResults.length,
        gpu: jobResults.filter(j => presets.find(p => p.id === j.presetId)?.config.encoding_type === 'gpu').length,
        cpu: jobResults.filter(j => presets.find(p => p.id === j.presetId)?.config.encoding_type === 'cpu').length,
        totalOriginalSize,
        estimatedOutputSize: totalEstimatedSize,
        estimatedSpaceSaved: totalOriginalSize - totalEstimatedSize,
      },
    };

    logger.info(`[SMART_TRANSCODE] Created ${result.jobs.length} jobs, estimated space saved: ${formatBytes(result.summary.estimatedSpaceSaved)}`);

    return sendSuccess(result);
  });

  // Get worker availability for UI warnings
  fastify.get('/workers/availability', async (request, reply) => {
    const availability = wsServer.getWorkerAvailability();
    return sendSuccess(availability);
  });

  fastify.post('/jobs/bulk-delete', async (request, reply) => {
    const body = request.body as { job_ids?: unknown; cancel_active?: boolean };
    if (!Array.isArray(body?.job_ids) || body.job_ids.some(id => typeof id !== 'string')) {
      reply.status(400);
      return sendError('job_ids must be an array of job IDs');
    }

    const jobIds = Array.from(new Set(body.job_ids as string[]));
    const jobs = jobIds.map(id => db.getJobById(id)).filter(Boolean);
    const activeJobs = jobs.filter(job => job!.status === 'assigned' || job!.status === 'processing');
    const inactiveJobIds = jobs
      .filter(job => job!.status !== 'assigned' && job!.status !== 'processing')
      .map(job => job!.id);

    if (body.cancel_active) {
      for (const job of activeJobs) {
        wsServer.cancelJob(job!.id, 'Cancelled by user');
      }
    }
    const deleted = db.deleteJobs(inactiveJobIds);
    const cancelled = body.cancel_active ? activeJobs.length : 0;
    const skipped = body.cancel_active ? 0 : activeJobs.length;

    logger.info(`Bulk job cleanup: cancelled ${cancelled}, deleted ${deleted}, left active ${skipped}`);
    wsServer.scheduleWebUpdates();

    return sendSuccess({ cancelled, deleted, skipped });
  });

  fastify.delete('/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = db.getJobById(id);

    if (!job) {
      reply.status(404);
      return sendError('Job not found');
    }

    // Cancel if running
    if (job.status === 'assigned' || job.status === 'processing') {
      wsServer.cancelJob(id, 'Cancelled by user');
    } else {
      db.deleteJob(id);
    }

    logger.info(`Job ${id} deleted`);

    // Broadcast update to all connected clients
    wsServer.broadcastJobsUpdate();

    return sendSuccess(null, 'Job deleted');
  });

  // Get job history for a file
  fastify.get('/files/:fileId/job-history', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const { limit } = request.query as { limit?: string };

    const historyLimit = limit ? parseInt(limit, 10) : 50;
    const history = db.getJobHistoryByFile(fileId, historyLimit);

    return sendSuccess(history);
  });

  // Get all job history
  fastify.get('/job-history', async (request, reply) => {
    const { limit } = request.query as { limit?: string };

    const historyLimit = limit ? parseInt(limit, 10) : 100;
    const history = db.getAllJobHistory(historyLimit);

    return sendSuccess(history);
  });

  // Get reports for a file (by file_id or library_file_id)
  fastify.get('/reports/:fileId', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const { limit } = request.query as { limit?: string };

    const reportLimit = limit ? parseInt(limit, 10) : 50;
    const reports = db.getJobReportsByFileId(fileId, reportLimit).map(withParsedFFmpegError);

    return sendSuccess(reports);
  });

  // Get a single report
  fastify.get('/report/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const storedReport = db.getJobReportById(id);
    const report = storedReport ? withParsedFFmpegError(storedReport) : undefined;
    if (!report) {
      reply.status(404);
      return sendError('Report not found');
    }
    return sendSuccess(report);
  });

  // ========================================================================
  // Presets
  // ========================================================================

  fastify.get('/presets', async (request, reply) => {
    const presets = db.getAllPresets();
    return sendSuccess(presets);
  });

  fastify.get('/presets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const preset = db.getPresetById(id);

    if (!preset) {
      reply.status(404);
      return sendError('Preset not found');
    }

    return sendSuccess(preset);
  });

  fastify.post('/presets', async (request, reply) => {
    const data = request.body as CreatePresetRequest;

    // Check if name already exists
    const existing = db.getPresetByName(data.name);
    if (existing) {
      reply.status(400);
      return sendError('Preset name already exists');
    }

    const preset = db.createPreset({
      name: data.name,
      description: data.description,
      config: data.config,
    });

    logger.info(`Preset ${preset.id} created: ${data.name}`);

    return sendSuccess(preset);
  });

  fastify.put('/presets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = request.body as CreatePresetRequest;

    const preset = db.getPresetById(id);
    if (!preset) {
      reply.status(404);
      return sendError('Preset not found');
    }

    if (preset.is_builtin) {
      reply.status(400);
      return sendError('Cannot modify built-in presets');
    }

    db.updatePreset(id, {
      name: data.name,
      description: data.description,
      config: data.config,
    });

    const updated = db.getPresetById(id);
    return sendSuccess(updated);
  });

  fastify.delete('/presets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const preset = db.getPresetById(id);

    if (!preset) {
      reply.status(404);
      return sendError('Preset not found');
    }

    if (preset.is_builtin) {
      reply.status(400);
      return sendError('Cannot delete built-in presets');
    }

    db.deletePreset(id);

    logger.info(`Preset ${id} deleted`);

    return sendSuccess(null, 'Preset deleted');
  });

  // ========================================================================
  // Quick Select Presets
  // ========================================================================

  fastify.get('/quick-select-presets', async (request, reply) => {
    const quickSelectPresets = db.getAllQuickSelectPresets();
    return sendSuccess(quickSelectPresets);
  });

  fastify.get('/quick-select-presets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const quickSelectPreset = db.getQuickSelectPresetById(id);

    if (!quickSelectPreset) {
      reply.status(404);
      return sendError('Quick Select Preset not found');
    }

    return sendSuccess(quickSelectPreset);
  });

  fastify.post('/quick-select-presets', async (request, reply) => {
    const data = request.body as {
      name: string;
      description?: string;
      nvidia_preset_id?: string;
      amd_preset_id?: string;
      intel_preset_id?: string;
      cpu_preset_id?: string;
    };

    const quickSelectPreset = db.createQuickSelectPreset({
      name: data.name,
      description: data.description,
      nvidia_preset_id: data.nvidia_preset_id,
      amd_preset_id: data.amd_preset_id,
      intel_preset_id: data.intel_preset_id,
      cpu_preset_id: data.cpu_preset_id,
    });

    logger.info(`Quick Select Preset ${quickSelectPreset.id} created: ${data.name}`);

    return sendSuccess(quickSelectPreset);
  });

  fastify.put('/quick-select-presets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = request.body as {
      name?: string;
      description?: string;
      nvidia_preset_id?: string;
      amd_preset_id?: string;
      intel_preset_id?: string;
      cpu_preset_id?: string;
    };

    const quickSelectPreset = db.getQuickSelectPresetById(id);
    if (!quickSelectPreset) {
      reply.status(404);
      return sendError('Quick Select Preset not found');
    }

    if (quickSelectPreset.is_builtin) {
      reply.status(400);
      return sendError('Cannot modify built-in Quick Select Presets');
    }

    db.updateQuickSelectPreset(id, {
      name: data.name,
      description: data.description,
      nvidia_preset_id: data.nvidia_preset_id,
      amd_preset_id: data.amd_preset_id,
      intel_preset_id: data.intel_preset_id,
      cpu_preset_id: data.cpu_preset_id,
    });

    const updated = db.getQuickSelectPresetById(id);
    return sendSuccess(updated);
  });

  fastify.delete('/quick-select-presets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const quickSelectPreset = db.getQuickSelectPresetById(id);

    if (!quickSelectPreset) {
      reply.status(404);
      return sendError('Quick Select Preset not found');
    }

    if (quickSelectPreset.is_builtin) {
      reply.status(400);
      return sendError('Cannot delete built-in Quick Select Presets');
    }

    db.deleteQuickSelectPreset(id);

    logger.info(`Quick Select Preset ${id} deleted`);

    return sendSuccess(null, 'Quick Select Preset deleted');
  });

  // ========================================================================
  // Settings
  // ========================================================================

  fastify.get('/settings', async (request, reply) => {
    const settings = db.getAllSettings();

    // Group by prefix
    const grouped: Record<string, any> = {};
    for (const [key, value] of Object.entries(settings)) {
      const parts = key.split('_');
      if (parts.length > 1) {
        const group = parts[0];
        const subKey = parts.slice(1).join('_');
        if (!grouped[group]) grouped[group] = {};
        grouped[group][subKey] = value;
      } else {
        grouped[key] = value;
      }
    }

    return sendSuccess(grouped);
  });

  fastify.put('/settings', async (request, reply) => {
    const data = request.body as UpdateSettingsRequest;

    if (data.port !== undefined) {
      db.setSetting('port', data.port.toString());
    }
    if (data.cacheDirectory !== undefined) {
      db.setSetting('cacheDirectory', data.cacheDirectory);
    }
    if (data.autoScan?.enabled !== undefined) {
      db.setSetting('autoScan_enabled', data.autoScan.enabled.toString());
    }
    if (data.autoScan?.intervalMinutes !== undefined) {
      db.setSetting('autoScan_intervalMinutes', data.autoScan.intervalMinutes.toString());
    }
    if (data.jobLimits?.maxConcurrent !== undefined) {
      db.setSetting('jobLimits_maxConcurrent', data.jobLimits.maxConcurrent.toString());
    }
    if (data.jobLimits?.maxRetries !== undefined) {
      db.setSetting('jobLimits_maxRetries', data.jobLimits.maxRetries.toString());
    }
    if (data.fileRetention?.deleteOriginal !== undefined) {
      db.setSetting('fileRetention_deleteOriginal', data.fileRetention.deleteOriginal.toString());
    }
    if (data.fileRetention?.keepBackup !== undefined) {
      db.setSetting('fileRetention_keepBackup', data.fileRetention.keepBackup.toString());
    }

    logger.info('Settings updated');

    return sendSuccess(null, 'Settings updated');
  });

  fastify.post('/settings/full-reset', async (request, reply) => {
    const { confirmation } = (request.body || {}) as { confirmation?: string };
    if (confirmation !== 'RESET ENCORR') {
      reply.status(400);
      return sendError('Type RESET ENCORR exactly to confirm the full reset');
    }

    logger.warn('[RESET] Full system reset requested');
    cancelComparisonPreviews();
    const workers = wsServer.prepareFullReset();
    const dataRoot = db.fullReset();

    // Keep browser clients connected to the same server process and replace
    // every cached collection with the newly initialized empty state.
    wsServer.broadcastNodesUpdate();
    wsServer.broadcastJobsUpdate();
    logger.warn('[RESET] Full system reset completed');

    return sendSuccess({
      reset: true,
      cancelled_jobs: workers.cancelledJobs,
      disconnected_workers: workers.disconnectedWorkers,
      data_directory: dataRoot,
    }, 'Encorr was reset and reinitialized');
  });

  // ========================================================================
  // Statistics & Logs
  // ========================================================================

  fastify.get('/stats', async (request, reply) => {
    const stats = db.getDashboardStats();
    return sendSuccess(stats);
  });

  fastify.get('/storage-reclaims', async (request, reply) => {
    const { limit, file_id } = request.query as { limit?: string; file_id?: string };
    const parsedLimit = Math.min(1000, Math.max(1, Number.parseInt(limit || '250', 10) || 250));
    return sendSuccess({
      summary: db.getStorageReclaimStats(),
      records: db.getStorageReclaims(parsedLimit, file_id),
    });
  });

  fastify.get('/logs', async (request, reply) => {
    const { level, category, limit } = request.query as {
      level?: string;
      category?: string;
      limit?: string;
    };

    const options: any = {};
    if (level) options.level = level;
    if (category) options.category = category;
    if (limit) options.limit = parseInt(limit, 10);

    const logs = db.getLogs(options);

    return sendSuccess(logs);
  });

  // ========================================================================
  // Server Control
  // ========================================================================

  fastify.post('/server/shutdown', async (request, reply) => {
    logger.info('Shutdown requested via API');

    // Give some time for response
    setTimeout(() => {
      process.exit(0);
    }, 100);

    return sendSuccess(null, 'Server shutting down');
  });

  fastify.post('/server/restart', async (request, reply) => {
    logger.info('Restart requested via API');

    // Give some time for response
    setTimeout(() => {
      process.exit(1); // Exit code 1 can be used to trigger restart
    }, 100);

    return sendSuccess(null, 'Server restarting');
  });
}
