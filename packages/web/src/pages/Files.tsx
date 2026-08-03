import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatBytes } from '@/utils/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SmartTranscodeDialog } from '@/components/ui/SmartTranscodeDialog';
import { Dialog } from '@/components/ui/Dialog';
import { RefreshCw, ChevronLeft, ChevronRight, Film, Folder, FolderOpen, Check, Search, Filter, Scan, Sparkles, Clock, Zap, AlertTriangle, FileText, MoreVertical, Replace, Copy, X, Ban, Columns2 } from 'lucide-react';
import { ReportDrawer } from '@/components/ReportDrawer';
import { useEffect, useState, useMemo, useRef } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { TranscodeMode } from '@encorr/shared';
import { useNavigate } from 'react-router-dom';

// Helper function to format duration as HH:MM:SS
function formatDuration(seconds: number | undefined, isAnalyzed: boolean = false): string {
  // If not analyzed, show dashes
  if (!isAnalyzed) return '--:--:--';

  // If analyzed but no duration data, show dashes
  if (!seconds || seconds <= 0) return '--:--:--';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

type ViewMode = 'all' | 'folder';
type ReplacementOperation = 'replace' | 'backup_replace' | 'cleanup_backup';

export function Files() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [selectedFolder, setSelectedFolder] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [showSmartTranscodeDialog, setShowSmartTranscodeDialog] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [perPage] = useState(50);
  const [reportFileId, setReportFileId] = useState<string | null>(null);
  const [reportFileName, setReportFileName] = useState('');
  const [showReportDrawer, setShowReportDrawer] = useState(false);

  // Track file replacement operations in progress
  const [pendingFileReplacements, setPendingFileReplacements] = useState<Set<string>>(new Set());
  const [replacementProgress, setReplacementProgress] = useState<{ current: number; total: number } | null>(null);
  const [replacementConfirmation, setReplacementConfirmation] = useState<{
    operation: ReplacementOperation;
    fileIds: string[];
  } | null>(null);
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const [replacementNotice, setReplacementNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const watchedReplacements = useRef<Map<string, number>>(new Map());
  const seenReplacementFailures = useRef<Set<string>>(new Set());
  const failedReplacementFiles = useRef<Set<string>>(new Set());
  const selectionAnchorFileId = useRef<string | null>(null);
  const [openActionsFileId, setOpenActionsFileId] = useState<string | null>(null);

  useEffect(() => {
    if (!openActionsFileId) return;
    const closeMenu = () => setOpenActionsFileId(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, [openActionsFileId]);

  // Enable WebSocket for real-time updates
  useWebSocket({ enabled: true });

  // Fetch libraries/folders from API
  const { data: libraries = [] } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => api.getLibraries(),
  });

  // Fetch the current page while the backend calculates counts and filtering
  // against the complete selected library.
  const { data: filesData, isLoading, refetch } = useQuery({
    queryKey: ['files', selectedFolder, selectedStatus, currentPage, perPage],
    queryFn: () => api.getAllLibraryFiles({
      page: currentPage,
      per_page: perPage,
      library_id: selectedFolder !== 'all' ? selectedFolder : undefined,
      status: selectedStatus !== 'all' ? selectedStatus : undefined,
    }),
    refetchInterval: 10000, // Refetch every 10s as fallback to WebSocket
  });

  // Fetch all jobs to correlate with library files
  const { data: jobs = [] } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.getJobs(),
    refetchInterval: 5000, // Refetch jobs every 5s for active jobs
  });

  // The POST request only confirms dispatch. The node reports the real result
  // asynchronously, so surface that result when it arrives over Jobs updates.
  useEffect(() => {
    const failedOperation = jobs.find((job: any) => {
      if (!job.file_operation || job.status !== 'failed' || seenReplacementFailures.current.has(job.id)) return false;
      const watchedAt = watchedReplacements.current.get(job.file_id);
      return watchedAt !== undefined && Number(job.created_at || 0) >= watchedAt - 1;
    });
    if (!failedOperation) return;

    seenReplacementFailures.current.add(failedOperation.id);
    failedReplacementFiles.current.add(failedOperation.file_id);
    watchedReplacements.current.delete(failedOperation.file_id);
    setReplacementNotice({
      type: 'error',
      message: `${failedOperation.file_name || 'File replacement'} failed: ${failedOperation.error_message || 'The node could not complete the operation.'}`,
    });
  }, [jobs]);

  // Fetch reports for each file to get correct transcode status
  // This runs after filesData is available to avoid circular dependency
  const { data: reportsByFileId = {} } = useQuery({
    queryKey: ['reports-by-file', filesData?.items?.map((f: any) => f.id)],
    queryFn: async () => {
      if (!filesData?.items || filesData.items.length === 0) return {};

      const fileIds = filesData.items.map((f: any) => f.id);
      const reportsPromises = fileIds.map((fileId) =>
        api.getReportsForFile(fileId, 5).catch(() => [])
      );
      const reportsArrays = await Promise.all(reportsPromises);

      // Build map of file_id -> latest transcode report
      const map: Record<string, any> = {};
      fileIds.forEach((fileId, index) => {
        const fileReports = reportsArrays[index] || [];
        // Find latest transcode report
        const transcodeReports = fileReports.filter((r: any) => r.job_type === 'transcode');
        if (transcodeReports.length > 0) {
          const latest = transcodeReports.sort((a: any, b: any) => {
            const aTime = a.completed_at || a.created_at || 0;
            const bTime = b.completed_at || b.created_at || 0;
            return bTime - aTime; // Newest first
          })[0];
          map[fileId] = latest;
        }
      });

      return map;
    },
    refetchInterval: 10000, // Refetch every 10s
    enabled: !!(filesData?.items && filesData.items.length > 0),
  });

  // Build folders list from libraries + "All Files"
  const folders = useMemo(() => {
    const allFilesCount = libraries.reduce((sum: number, lib: any) => sum + (lib.file_count || 0), 0);
    const folderList = [
      { id: 'all', name: 'All Files', path: '', file_count: allFilesCount },
      ...libraries.map((lib: any) => ({
        id: lib.id,
        name: lib.name,
        path: lib.path,
        file_count: lib.file_count || 0,
      })),
    ];
    return folderList;
  }, [libraries]);

  const files = filesData?.items || [];
  const totalPages = filesData?.total_pages || 1;
  const totalFiles = filesData?.total || 0;

  // Combine library files with job information for unified view
  const filesWithJobStatus = useMemo(() => {
    return files.map((file: any) => {
      // Find active job for real-time progress
      const activeJob = jobs.find((j: any) =>
        (j.library_file_id === file.id || j.file_id === file.id)
        && (j.status === 'queued' || j.status === 'assigned' || j.status === 'processing')
      );

      // Get latest transcode report for this file
      const latestReport = reportsByFileId[file.id];

      // Determine display status
      let displayStatus = file.display_status || file.status;
      let displayProgress = file.progress || 0;

      // Priority 1: Active job (processing/assigned)
      if (activeJob) {
        displayStatus = 'processing';
        displayProgress = activeJob.progress || 0;
      }
      // Priority 2: A replacement is the terminal library-file state.
      else if (file.status === 'completed' || file.status === 'backup_replaced') {
        displayStatus = 'completed';
        displayProgress = 100;
      }
      // Priority 3: Completed transcode output exists but is not installed yet.
      else if (!file.display_status && latestReport) {
        const outputAvailable = file.transcode_output_available !== false && latestReport.output_available !== 0;
        displayStatus = latestReport.status === 'completed'
          ? (outputAvailable ? 'transcoded' : 'failed')
          : latestReport.status;
        displayProgress = latestReport.status === 'completed' && outputAvailable ? 100 : 0;
      }
      // Priority 4: File status from backend
      else {
        // Map backend statuses to display statuses
        if (file.status === 'completed') {
          displayStatus = 'completed';
          displayProgress = 100;
        } else if (file.status === 'analyzed' || file.status === 'imported') {
          displayStatus = 'ready';
        } else if (file.status === 'pending') {
          displayStatus = 'pending';
        }
      }

      return {
        ...file,
        displayStatus,
        displayProgress,
        job: activeJob || latestReport,
        outputSize: latestReport?.output_size || latestReport?.transcoded_size || null,
        oldSize: file.old_size || latestReport?.original_size || null,
        displayError: file.display_error || latestReport?.error_message || file.error_message,
      };
    });
  }, [files, jobs, reportsByFileId]);

  // Count files by status for filter tabs
  const currentPageStatusCounts = useMemo(() => {
    const counts = {
      all: filesWithJobStatus.length,
      ready: 0,
      processing: 0,
      transcoded: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    filesWithJobStatus.forEach((file: any) => {
      if (file.displayStatus === 'ready') counts.ready++;
      else if (file.displayStatus === 'processing') counts.processing++;
      else if (file.displayStatus === 'transcoded') counts.transcoded++;
      else if (file.displayStatus === 'completed') counts.completed++;
      else if (file.displayStatus === 'failed') counts.failed++;
      else if (file.displayStatus === 'cancelled') counts.cancelled++;
    });
    return counts;
  }, [filesWithJobStatus]);
  const statusCounts = filesData?.status_counts || currentPageStatusCounts;

  // Analyze all files missing metadata in the selected library (or all libraries).
  const analyzeMutation = useMutation({
    mutationFn: () => api.analyzeLibraryFiles(selectedFolder !== 'all' ? selectedFolder : undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
    },
  });

  // Analyze selected mutation - creates analyze jobs for selected files
  const analyzeSelectedMutation = useMutation({
    mutationFn: async () => {
      const fileIds = Array.from(selectedFiles);
      await api.createJob({ file_ids: fileIds, preset_id: 'builtin-analyze' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
      setSelectedFiles(new Set());
    },
  });

  // Smart transcode mutation
  const smartTranscodeMutation = useMutation({
    mutationFn: async ({ mode, presetId, quickSelectId, postAction }: { mode: TranscodeMode; presetId?: string; quickSelectId?: string; postAction: 'keep' | 'replace' | 'backup_replace' }) => {
      const fileIds = Array.from(selectedFiles);
      return api.createSmartJob({
        file_ids: fileIds,
        mode,
        preset_id: mode === 'cpu' ? presetId : undefined,
        quick_select_id: mode === 'gpu' ? quickSelectId : undefined,
        post_action: postAction,
      });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
      setSelectedFiles(new Set());
      setShowSmartTranscodeDialog(false);
      // Optionally show a success message with the summary
      console.log('Smart transcode completed:', result.summary);
    },
  });

  // Replace original file mutation
  const replaceOriginalMutation = useMutation({
    mutationFn: async (fileId: string) => {
      setPendingFileReplacements(prev => new Set(prev).add(fileId));
      try {
        return await api.replaceOriginalFile(fileId);
      } finally {
        setPendingFileReplacements(prev => {
          const next = new Set(prev);
          next.delete(fileId);
          return next;
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error: Error) => {
      console.error('Failed to replace original file:', error);
      // Could add a toast notification here
    },
  });

  // Backup and replace mutation
  const backupAndReplaceMutation = useMutation({
    mutationFn: async (fileId: string) => {
      setPendingFileReplacements(prev => new Set(prev).add(fileId));
      try {
        return await api.backupAndReplaceFile(fileId);
      } finally {
        setPendingFileReplacements(prev => {
          const next = new Set(prev);
          next.delete(fileId);
          return next;
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error: Error) => {
      console.error('Failed to backup and replace file:', error);
    },
  });

  // Cleanup backup mutation
  const cleanupBackupMutation = useMutation({
    mutationFn: async (fileId: string) => {
      setPendingFileReplacements(prev => new Set(prev).add(fileId));
      try {
        return await api.cleanupOriginalFile(fileId);
      } finally {
        setPendingFileReplacements(prev => {
          const next = new Set(prev);
          next.delete(fileId);
          return next;
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
    },
    onError: (error: Error) => {
      console.error('Failed to cleanup backup file:', error);
    },
  });

  // Helper function to process files one by one for bulk operations
  const processFilesBulk = async (fileIds: string[], mutation: typeof replaceOriginalMutation) => {
    setReplacementProgress({ current: 0, total: fileIds.length });
    const successfulIds: string[] = [];
    const failures: string[] = [];
    try {
      for (let i = 0; i < fileIds.length; i++) {
        try {
          await mutation.mutateAsync(fileIds[i]);
          successfulIds.push(fileIds[i]);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : 'Unknown replacement error');
        }
        setReplacementProgress({ current: i + 1, total: fileIds.length });
      }
    } finally {
      setReplacementProgress(null);
    }

    if (successfulIds.length > 0) {
      setSelectedFiles(previous => {
        const next = new Set(previous);
        successfulIds.forEach(id => next.delete(id));
        return next;
      });
    }
    const asyncFailureCount = fileIds.filter(id => failedReplacementFiles.current.has(id)).length;
    if (failures.length > 0) {
      setReplacementNotice({
          type: 'error',
          message: `${successfulIds.length.toLocaleString()} queued, ${failures.length.toLocaleString()} failed. ${failures[0]}`,
        });
    } else if (asyncFailureCount === 0) {
      setReplacementNotice({
          type: 'success',
          message: `${successfulIds.length.toLocaleString()} file replacement${successfulIds.length === 1 ? '' : 's'} added to Jobs.`,
        });
    }
  };

  const requestReplacement = (operation: ReplacementOperation, fileIds: string[]) => {
    if (fileIds.length === 0) return;
    setOpenActionsFileId(null);
    setReplacementNotice(null);
    const requestedAt = Math.floor(Date.now() / 1000);
    fileIds.forEach(id => {
      watchedReplacements.current.set(id, requestedAt);
      failedReplacementFiles.current.delete(id);
    });
    setReplacementConfirmed(false);
    setReplacementConfirmation({ operation, fileIds });
  };

  const confirmReplacement = async () => {
    if (!replacementConfirmation || !replacementConfirmed) return;
    const { operation, fileIds } = replacementConfirmation;
    setReplacementConfirmation(null);
    if (operation === 'cleanup_backup') {
      try {
        await cleanupBackupMutation.mutateAsync(fileIds[0]);
        setSelectedFiles(previous => {
          const next = new Set(previous);
          next.delete(fileIds[0]);
          return next;
        });
        setReplacementNotice({ type: 'success', message: 'Original backup removal added to Jobs.' });
      } catch (error) {
        setReplacementNotice({
          type: 'error',
          message: error instanceof Error ? error.message : 'Could not queue original backup removal.',
        });
      }
      return;
    }
    await processFilesBulk(
      fileIds,
      operation === 'replace' ? replaceOriginalMutation : backupAndReplaceMutation,
    );
  };

  // Apply client-side search filter and status filter
  const filteredFiles = useMemo(() => {
    let result = filesWithJobStatus;

    // Apply status filter
    if (selectedStatus !== 'all') {
      result = result.filter((file: any) => file.displayStatus === selectedStatus);
    }

    // Apply search filter
    if (searchQuery) {
      result = result.filter((file: any) =>
        file.filename?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        file.library_name?.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    return result;
  }, [filesWithJobStatus, selectedStatus, searchQuery]);

  const handleToggleFile = (fileId: string, shiftKey = false) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      const anchorId = selectionAnchorFileId.current;
      if (shiftKey && anchorId && prev.has(anchorId)) {
        const anchorIndex = filteredFiles.findIndex((file: any) => file.id === anchorId);
        const targetIndex = filteredFiles.findIndex((file: any) => file.id === fileId);
        if (anchorIndex >= 0 && targetIndex >= 0) {
          const start = Math.min(anchorIndex, targetIndex);
          const end = Math.max(anchorIndex, targetIndex);
          filteredFiles.slice(start, end + 1).forEach((file: any) => next.add(file.id));
          return next;
        }
      }

      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      selectionAnchorFileId.current = fileId;
      return next;
    });
  };

  const handleToggleAll = () => {
    if (selectedFiles.size === filteredFiles.length) {
      setSelectedFiles(new Set());
      selectionAnchorFileId.current = null;
    } else {
      setSelectedFiles(new Set(filteredFiles.map(f => f.id)));
      selectionAnchorFileId.current = filteredFiles[0]?.id || null;
    }
  };

  const getCodecBadgeColor = (codec?: string) => {
    if (!codec) return '#6b7280';
    if (codec.includes('h265') || codec.includes('hevc')) return '#9C27B0';
    if (codec.includes('h264') || codec.includes('avc')) return '#74c69d';
    if (codec.includes('av1')) return '#ff6b6b';
    if (codec.includes('vp9')) return '#5eb78a';
    return '#6b7280';
  };

  const getResolutionBadgeColor = (resolution?: string) => {
    if (resolution === '2160p') return '#9C27B0';
    if (resolution === '1080p') return '#74c69d';
    if (resolution === '720p') return '#f59e0b';
    if (resolution === '480p') return '#6b7280';
    return '#38363a';
  };

  const getStatusDisplay = (file: any) => {
    const status = file.displayStatus;

    if (status === 'processing') {
      return (
        <div className="flex items-center gap-2">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
          </span>
          <span className="text-blue-400 text-xs">
            {file.displayProgress > 0 ? `${file.displayProgress.toFixed(1)}%` : 'Processing...'}
          </span>
        </div>
      );
    }

    if (status === 'pending') {
      return (
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
          <span className="text-xs text-amber-300">Pending</span>
        </div>
      );
    }

    if (status === 'completed') {
      if (file.status === 'backup_replaced') {
        return (
          <div className="flex items-center gap-2" title="Completed; original .org backup is still retained">
            <Copy className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
            <span className="text-amber-300 text-xs">Completed + backup</span>
          </div>
        );
      }
      return (
        <div className="flex items-center gap-2">
          <Check className="h-3.5 w-3.5 text-green-400 flex-shrink-0" />
          <span className="text-green-400 text-xs">Completed</span>
        </div>
      );
    }

    if (status === 'transcoded') {
      return (
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-violet-400" />
          <span className="text-violet-300 text-xs">Transcoded</span>
        </div>
      );
    }

    if (status === 'failed') {
      const completedOutputMissing = file.job?.status === 'completed'
        && file.transcode_output_available === false;
      return (
        <div className="flex items-center gap-2" title={file.displayError || 'Operation failed'}>
          <X className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />
          <span className="text-red-400 text-xs">{completedOutputMissing ? 'Output missing' : 'Failed'}</span>
        </div>
      );
    }

    if (status === 'cancelled') {
      return (
        <div className="flex items-center gap-2">
          <Ban className="h-3.5 w-3.5 text-orange-400 flex-shrink-0" />
          <span className="text-orange-400 text-xs">Cancelled</span>
        </div>
      );
    }

    // backup_replaced (has .org backup file)
    if (status === 'backup_replaced') {
      return (
        <div className="flex items-center gap-2">
          <Copy className="h-3.5 w-3.5 text-yellow-400 flex-shrink-0" />
          <span className="text-yellow-400 text-xs">Backup Created</span>
        </div>
      );
    }

    // ready (analyzed/imported)
    return (
      <div className="flex items-center gap-2">
        <Check className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
        <span className="text-gray-400 text-xs">Transcodeable</span>
      </div>
    );
  };

  const formatETA = (seconds: number) => {
    if (!seconds || seconds <= 0 || seconds > 86400) return 'Calc...';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  return (
    <>
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Files</h1>
          <p className="text-gray-400 text-sm sm:text-base">All files with real-time job status</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedFiles.size > 0 && (
            <>
              <span className="text-sm text-gray-400">
                {selectedFiles.size} file{selectedFiles.size !== 1 ? 's' : ''} selected
              </span>
            </>
          )}

          {/* File Management Buttons - show when transcoded outputs are selected */}
          {(() => {
            const transcodedSelectedCount = Array.from(selectedFiles).filter(id =>
              filesWithJobStatus.find((f: any) => f.id === id && f.displayStatus === 'transcoded')
            ).length;

            return transcodedSelectedCount > 0 ? (
              <>
                <div className="h-6 w-px bg-gray-500 mx-2 hidden sm:block" />
                <Button
                  onClick={() => {
                    const completedFileIds = Array.from(selectedFiles).filter(id =>
                      filesWithJobStatus.find((f: any) => f.id === id && f.displayStatus === 'transcoded')
                    );
                    requestReplacement('replace', completedFileIds);
                  }}
                  disabled={replaceOriginalMutation.isPending || pendingFileReplacements.size > 0}
                  style={{ borderColor: '#39363a', color: '#ffffff' }}
                  className="border flex items-center gap-2 animate-in slide-in-from-left-2 fade-in duration-300 text-sm"
                  title="Replace original files with transcoded versions"
                >
                  <Replace className={`h-4 w-4 ${replaceOriginalMutation.isPending || pendingFileReplacements.size > 0 ? 'animate-spin' : ''}`} />
                  <span className="hidden sm:inline">
                    {replacementProgress ? ` (${replacementProgress.current}/${replacementProgress.total})` : 'Replace Original'}
                  </span>
                  <span className="sm:hidden">Replace</span> ({transcodedSelectedCount})
                </Button>
                <Button
                  onClick={() => {
                    const completedFileIds = Array.from(selectedFiles).filter(id =>
                      filesWithJobStatus.find((f: any) => f.id === id && f.displayStatus === 'transcoded')
                    );
                    requestReplacement('backup_replace', completedFileIds);
                  }}
                  disabled={backupAndReplaceMutation.isPending || pendingFileReplacements.size > 0}
                  style={{ borderColor: '#39363a', color: '#ffffff' }}
                  className="border flex items-center gap-2 animate-in slide-in-from-left-2 fade-in duration-300 delay-100 text-sm"
                  title="Rename originals to .org and put new files in place"
                >
                  <Copy className={`h-4 w-4 ${backupAndReplaceMutation.isPending || pendingFileReplacements.size > 0 ? 'animate-spin' : ''}`} />
                  <span className="hidden sm:inline">
                    {replacementProgress ? ` (${replacementProgress.current}/${replacementProgress.total})` : 'Backup & Replace'}
                  </span>
                  <span className="sm:hidden">Backup</span> ({transcodedSelectedCount})
                </Button>
                <div className="h-6 w-px bg-gray-500 mx-2 hidden sm:block" />
              </>
            ) : null;
          })()}

          {/* Analyze All / Analyze Selected Button */}
          <Button
            onClick={() => selectedFiles.size > 0 ? analyzeSelectedMutation.mutate() : analyzeMutation.mutate()}
            disabled={analyzeMutation.isPending || analyzeSelectedMutation.isPending}
            style={{ borderColor: '#39363a', color: '#ffffff' }}
            className="border flex items-center gap-2 text-sm"
            title={selectedFiles.size > 0 ? 'Analyze selected files' : 'Analyze every file missing codec metadata'}
          >
            <Scan className={`h-4 w-4 ${analyzeMutation.isPending || analyzeSelectedMutation.isPending ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">
              {analyzeMutation.isPending || analyzeSelectedMutation.isPending ? 'Queueing...' : selectedFiles.size > 0 ? `Analyze Selected (${selectedFiles.size})` : 'Analyze All'}
            </span>
            <span className="sm:hidden">{analyzeMutation.isPending || analyzeSelectedMutation.isPending ? 'Queueing...' : 'Analyze'}</span>
          </Button>

          {/* Smart Transcode / Transcode All Button */}
          <Button
            onClick={() => {
              if (selectedFiles.size > 0) {
                setShowSmartTranscodeDialog(true);
              } else {
                // Select all ready files and open smart transcode
                const readyFileIds = filesWithJobStatus
                  .filter((f: any) => f.displayStatus === 'ready')
                  .map((f: any) => f.id);
                setSelectedFiles(new Set(readyFileIds));
                setShowSmartTranscodeDialog(true);
              }
            }}
            style={{ backgroundColor: '#74c69d', color: '#ffffff' }}
            className="flex items-center gap-2 text-sm"
            title={selectedFiles.size > 0 ? 'Smart Transcode - automatically optimize settings for your files' : 'Smart Transcode all transcodeable files'}
          >
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline">
              {selectedFiles.size > 0 ? `Transcode Selected (${selectedFiles.size})` : `Transcode All (${filesWithJobStatus.filter((f: any) => f.displayStatus === 'ready').length})`}
            </span>
            <span className="sm:hidden">
              {selectedFiles.size > 0 ? `Transcode (${selectedFiles.size})` : `Transcode All`}
            </span>
          </Button>

          <Button
            onClick={() => refetch()}
            disabled={isLoading}
            style={{ borderColor: '#39363a', color: '#ffffff' }}
            className="border"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {replacementNotice && (
        <div className={`flex items-start justify-between gap-4 rounded-xl border px-4 py-3 ${replacementNotice.type === 'success'
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
          : 'border-red-500/30 bg-red-500/10 text-red-200'}`}>
          <div className="flex items-start gap-2.5">
            {replacementNotice.type === 'success'
              ? <Check className="mt-0.5 h-4 w-4 shrink-0" />
              : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <p className="text-sm">{replacementNotice.message}</p>
          </div>
          <button type="button" onClick={() => setReplacementNotice(null)} className="rounded p-0.5 opacity-70 hover:bg-white/10 hover:opacity-100" aria-label="Dismiss message">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {(analyzeMutation.error || analyzeSelectedMutation.error) && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            {(analyzeMutation.error || analyzeSelectedMutation.error) instanceof Error
              ? (analyzeMutation.error || analyzeSelectedMutation.error)?.message
              : 'Unable to queue file analysis'}
          </span>
        </div>
      )}

      {/* Status Filter Tabs */}
      <div className="flex items-center gap-2 border-b border-[#39363a] pb-2 overflow-x-auto">
        <div className="flex items-center gap-2 min-w-max sm:min-w-0">
          <button
            onClick={() => { setSelectedStatus('all'); setCurrentPage(1); }}
            className={`px-3 sm:px-4 py-2 rounded-t-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              selectedStatus === 'all'
                ? 'bg-[#252326] text-white'
                : 'text-gray-400 hover:text-white hover:bg-[#252326]/50'
            }`}
          >
            All ({statusCounts.all})
          </button>
          <button
            onClick={() => { setSelectedStatus('ready'); setCurrentPage(1); }}
            className={`px-3 sm:px-4 py-2 rounded-t-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              selectedStatus === 'ready'
                ? 'bg-[#252326] text-white'
                : 'text-gray-400 hover:text-white hover:bg-[#252326]/50'
            }`}
          >
            Transcodeable ({statusCounts.ready})
          </button>
          <button
            onClick={() => { setSelectedStatus('processing'); setCurrentPage(1); }}
            className={`px-3 sm:px-4 py-2 rounded-t-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              selectedStatus === 'processing'
                ? 'bg-[#252326] text-white'
                : 'text-gray-400 hover:text-white hover:bg-[#252326]/50'
            }`}
          >
            Processing ({statusCounts.processing})
          </button>
          <button
            onClick={() => { setSelectedStatus('transcoded'); setCurrentPage(1); }}
            className={`px-3 sm:px-4 py-2 rounded-t-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              selectedStatus === 'transcoded'
                ? 'bg-[#252326] text-white'
                : 'text-gray-400 hover:text-white hover:bg-[#252326]/50'
            }`}
          >
            Transcoded ({statusCounts.transcoded})
          </button>
          <button
            onClick={() => { setSelectedStatus('completed'); setCurrentPage(1); }}
            className={`px-3 sm:px-4 py-2 rounded-t-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              selectedStatus === 'completed'
                ? 'bg-[#252326] text-white'
                : 'text-gray-400 hover:text-white hover:bg-[#252326]/50'
            }`}
          >
            Completed ({statusCounts.completed})
          </button>
          <button
            onClick={() => { setSelectedStatus('failed'); setCurrentPage(1); }}
            className={`px-3 sm:px-4 py-2 rounded-t-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              selectedStatus === 'failed'
                ? 'bg-[#252326] text-white'
                : 'text-gray-400 hover:text-white hover:bg-[#252326]/50'
            }`}
          >
            Failed ({statusCounts.failed})
          </button>
          <button
            onClick={() => { setSelectedStatus('cancelled'); setCurrentPage(1); }}
            className={`px-3 sm:px-4 py-2 rounded-t-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              selectedStatus === 'cancelled'
                ? 'bg-[#252326] text-white'
                : 'text-gray-400 hover:text-white hover:bg-[#252326]/50'
            }`}
          >
            Cancelled ({statusCounts.cancelled})
          </button>

          <div className="ml-auto flex items-center gap-2 pl-2 sm:pl-0">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search files..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 pr-4 py-2 bg-[#1a181b] border border-[#39363a] rounded-lg text-white text-sm placeholder:text-gray-500 focus:outline-none focus:border-[#74c69d] w-48 sm:w-64"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Bulk Transcode Options Panel - REMOVED, now using modal dialog */}

      <div className="flex gap-4 overflow-hidden">
        {/* Sidebar - Folder Navigation */}
        <Card className="hidden lg:block" style={{ backgroundColor: '#252326', border: 'none', width: '240px', flexShrink: 0 }}>
          <CardContent className="p-0">
            <div className="p-4 border-b border-[#39363a]">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Folders</h3>
            </div>
            <div className="p-2 max-h-[600px] overflow-y-auto">
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  onClick={() => {
                    setSelectedFolder(folder.id);
                    setCurrentPage(1);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-all ${
                    selectedFolder === folder.id
                      ? 'bg-[#38363a] text-white'
                      : 'text-gray-400 hover:bg-white/5'
                  }`}
                >
                  {selectedFolder === folder.id ? (
                    <FolderOpen className="h-4 w-4 flex-shrink-0" style={{ color: '#74c69d' }} />
                  ) : (
                    <Folder className="h-4 w-4 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{folder.name}</div>
                    <div className="text-xs text-gray-500">{folder.file_count} files</div>
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Main Content */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Search and Filters */}
          <Card style={{ backgroundColor: '#252326', border: 'none' }}>
            <CardContent className="p-3">
              <div className="flex items-center gap-4">
                {/* Search */}
                <div className="flex-1 relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                  <input
                    type="text"
                    placeholder="Search files..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 text-sm rounded-lg text-white placeholder-gray-500 focus:outline-none"
                    style={{ backgroundColor: '#1a181a', border: '1px solid #39363a' }}
                  />
                </div>

                {/* Status Filter */}
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-gray-500" />
                  <select
                    value={selectedStatus}
                    onChange={(e) => setSelectedStatus(e.target.value)}
                    className="px-3 py-2 text-sm rounded-lg text-white focus:outline-none"
                    style={{ backgroundColor: '#1a181a', border: '1px solid #39363a' }}
                  >
                    <option value="all">All Statuses</option>
                    <option value="ready">Transcodeable</option>
                    <option value="processing">Processing</option>
                    <option value="transcoded">Transcoded</option>
                    <option value="completed">Completed</option>
                    <option value="failed">Failed</option>
                    <option value="cancelled">Cancelled</option>
                    <option value="pending">Pending</option>
                  </select>
                </div>

                {/* View Toggle */}
                <div className="flex items-center border border-[#39363a] rounded-lg overflow-hidden">
                  <button
                    onClick={() => setViewMode('all')}
                    className={`px-3 py-2 text-sm transition-all ${
                      viewMode === 'all' ? 'bg-[#38363a] text-white' : 'text-gray-400 hover:bg-white/5'
                    }`}
                  >
                    All
                  </button>
                  <button
                    onClick={() => setViewMode('folder')}
                    className={`px-3 py-2 text-sm transition-all ${
                      viewMode === 'folder' ? 'bg-[#38363a] text-white' : 'text-gray-400 hover:bg-white/5'
                    }`}
                  >
                    By Folder
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Files List */}
          <Card style={{ backgroundColor: '#252326', border: 'none' }}>
            <CardContent className="p-0">
              {filteredFiles.length === 0 ? (
                <div className="py-16 text-center">
                  <Film className="mx-auto h-16 w-16 text-gray-700 mb-4" />
                  <p className="text-gray-500 text-lg">No files found</p>
                  <p className="text-sm text-gray-600 mt-2">
                    {searchQuery ? 'Try a different search term' : 'Add folders to scan for video files'}
                  </p>
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto -mx-4 sm:mx-0">
                    <div className="min-w-full sm:min-w-0">
                      {/* Table Header */}
                      <div className="px-4 py-3 border-b border-[#39363a] flex items-center gap-2" style={{ backgroundColor: '#2a282c', borderTopLeftRadius: '0.5rem', borderTopRightRadius: '0.5rem' }}>
                    <div className="flex items-center justify-center w-8 flex-shrink-0">
                      <input
                        type="checkbox"
                        checked={selectedFiles.size === filteredFiles.length && filteredFiles.length > 0}
                        onChange={handleToggleAll}
                        className="w-4 h-4 rounded"
                        style={{ accentColor: '#74c69d' }}
                      />
                    </div>
                    <div className="flex-1 min-w-0 pr-3 text-xs text-gray-300 uppercase font-medium">Filename</div>
                    <div className="text-xs text-gray-300 uppercase font-medium w-16 flex-shrink-0">Fmt</div>
                    <div className="text-xs text-gray-300 uppercase font-medium w-28 flex-shrink-0">Codec</div>
                    <div className="text-xs text-gray-300 uppercase font-medium w-28 flex-shrink-0">New Codec</div>
                    <div className="text-xs text-gray-300 uppercase font-medium w-20 flex-shrink-0">Res</div>
                    <div className="text-xs text-gray-300 uppercase font-medium w-32 flex-shrink-0">Sizes</div>
                    <div className="text-xs text-gray-300 uppercase font-medium w-24 flex-shrink-0">Status</div>
                    <div className="text-xs text-gray-300 uppercase font-medium w-16 flex-shrink-0 text-center">Actions</div>
                  </div>

                  {/* File Rows */}
                  <div className="divide-y divide-[#39363a]">
                    {filteredFiles.map((file: any) => (
                      <div
                        key={file.id}
                        onClick={(e) => {
                          // Don't toggle if clicking on checkbox, buttons, or inputs
                          if ((e.target as HTMLElement).tagName === 'INPUT' ||
                              (e.target as HTMLElement).tagName === 'BUTTON' ||
                              (e.target as HTMLElement).closest('button')) {
                            return;
                          }
                          handleToggleFile(file.id, e.shiftKey);
                        }}
                        className={`px-4 py-3 flex items-center gap-2 transition-all cursor-pointer select-none ${
                          selectedFiles.has(file.id) ? 'bg-white/5' : 'hover:bg-white/5'
                        }`}
                      >
                        {/* Checkbox */}
                        <div className="flex items-center justify-center w-8 flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={selectedFiles.has(file.id)}
                            onChange={(event) => handleToggleFile(file.id, (event.nativeEvent as MouseEvent).shiftKey)}
                            className="w-4 h-4 rounded"
                            style={{ accentColor: '#74c69d' }}
                          />
                        </div>

                        {/* Filename */}
                        <div className="flex-1 min-w-0 pr-3">
                          <div className="flex items-center gap-2">
                            <Film className="h-4 w-4 text-gray-600 flex-shrink-0" />
                            <span className="text-white text-sm truncate" title={file.filename || file.name}>
                              {file.filename || file.name}
                            </span>
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
                            <span className="truncate">{file.library_name || file.folder_name || 'Unknown'}</span>
                            <span className="flex-shrink-0">•</span>
                            <span className="flex-shrink-0">{formatDuration(file.duration, file.status === 'analyzed' || file.status === 'imported' || file.status === 'completed' || file.status === 'backup_replaced')}</span>
                          </div>
                          {/* Job info for processing files */}
                          {(file.displayStatus === 'processing' || file.displayStatus === 'failed') && file.job && (
                            <div className="mt-1 text-xs flex items-center gap-2">
                              {file.displayStatus === 'processing' && file.job.fps && (
                                <span className="text-blue-400">
                                  <Zap className="h-3 w-3 inline mr-1" />
                                  {file.job.fps} fps
                                </span>
                              )}
                              {file.displayStatus === 'processing' && file.job.eta && (
                                <span className="text-gray-400">
                                  <Clock className="h-3 w-3 inline mr-1" />
                                  {formatETA(file.job.eta)}
                                </span>
                              )}
                              {file.displayStatus === 'failed' && file.displayError && (
                                <span className="text-red-400 truncate" title={file.displayError}>
                                  <AlertTriangle className="h-3 w-3 inline mr-1" />
                                  {file.displayError}
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Format */}
                        <div className="w-16 flex-shrink-0">
                          <span className="text-xs px-1.5 py-0.5 rounded text-gray-300 text-center block" style={{ backgroundColor: '#2a2a2a' }}>
                            {(file.format || file.container || (file.metadata?.container) || '---').toUpperCase()}
                          </span>
                        </div>

                        {/* Codec */}
                        <div className="w-28 flex-shrink-0">
                          <span
                            className="text-xs px-1.5 py-0.5 rounded text-center block"
                            style={{ backgroundColor: getCodecBadgeColor(file.codec || file.video_codec || file.metadata?.video_codec), color: '#ffffff' }}
                          >
                            {(file.codec || file.video_codec || (file.metadata?.video_codec) || '----').toUpperCase()}
                          </span>
                        </div>

                        {/* New Codec (from transcode report) */}
                        <div className="w-28 flex-shrink-0">
                          {(() => {
                            if (file.displayStatus === 'transcoded' && file.job?.config) {
                              let config: any = null;
                              try {
                                config = typeof file.job.config === 'string' ? JSON.parse(file.job.config) : file.job.config;
                              } catch {
                                return <span className="text-gray-600 text-xs px-1.5 py-0.5 text-center block">—</span>;
                              }
                              const newCodec = config.video_codec || file.job.metadata?.video_codec;
                              if (newCodec) {
                                return (
                                  <span
                                    className="text-xs px-1.5 py-0.5 rounded text-center block"
                                    style={{ backgroundColor: getCodecBadgeColor(newCodec), color: '#ffffff' }}
                                  >
                                    {newCodec.toUpperCase()}
                                  </span>
                                );
                              }
                            }
                            return <span className="text-gray-600 text-xs px-1.5 py-0.5 text-center block">—</span>;
                          })()}
                        </div>

                        {/* Resolution */}
                        <div className="w-20 flex-shrink-0">
                          <span
                            className="text-xs px-1.5 py-0.5 rounded text-center block"
                            style={{ backgroundColor: getResolutionBadgeColor(file.resolution || (file.metadata?.width ? `${file.metadata?.width}x${file.metadata?.height}` : null)), color: '#ffffff' }}
                          >
                            {file.resolution || (file.metadata?.width ? `${file.metadata?.width}x${file.metadata?.height}` : (file.width ? `${file.width}p` : '---'))}
                          </span>
                        </div>

                        {/* Compact size history */}
                        <div className="w-32 flex-shrink-0 space-y-0.5 text-[11px]">
                          {file.oldSize && (
                            <div className="flex items-center justify-between gap-2 text-gray-500"><span>Old</span><span className="truncate text-gray-400">{formatBytes(file.oldSize)}</span></div>
                          )}
                          <div className="flex items-center justify-between gap-2 text-gray-500"><span>Current</span><span className="truncate text-gray-300">{formatBytes(file.filesize || file.file_size || file.size || 0)}</span></div>
                          {(file.displayStatus === 'transcoded' && file.outputSize) && (
                            <div className="flex items-center justify-between gap-2 text-gray-500"><span>Output</span><span className="truncate text-green-400">{formatBytes(file.outputSize)}</span></div>
                          )}
                        </div>

                        {/* Status */}
                        <div className="w-24 flex-shrink-0">
                          {getStatusDisplay(file)}
                          {file.displayStatus === 'processing' && file.displayProgress > 0 && (
                            <div className="mt-1 w-full h-1 bg-gray-700 rounded-full overflow-hidden">
                              <div
                                className="h-full transition-all"
                                style={{ width: `${file.displayProgress}%`, backgroundColor: '#74c69d' }}
                              />
                            </div>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="w-16 flex-shrink-0 flex items-center justify-center gap-1">
                          {(file.displayStatus === 'transcoded' || file.status === 'backup_replaced') && (
                            <button
                              type="button"
                              onClick={() => navigate(`/files/${encodeURIComponent(file.id)}/compare`)}
                              className="p-1 rounded transition-colors hover:bg-white/10"
                              style={{ color: '#74c69d' }}
                              title="Compare original and transcoded quality"
                              aria-label={`Compare original and transcoded versions of ${file.filename || file.name || 'file'}`}
                            >
                              <Columns2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {/* Replacement actions for pending outputs; cleanup for retained originals. */}
                          {(file.displayStatus === 'transcoded' || file.status === 'backup_replaced') ? (
                            <div className="relative" onClick={event => event.stopPropagation()}>
                              <button
                                type="button"
                                onClick={() => setOpenActionsFileId(current => current === file.id ? null : file.id)}
                                className="p-1 rounded transition-colors hover:bg-white/10"
                                style={{ color: '#9ca3af' }}
                                title="File actions"
                                aria-label={`Actions for ${file.filename || file.name || 'file'}`}
                                aria-haspopup="menu"
                                aria-expanded={openActionsFileId === file.id}
                              >
                                <MoreVertical className="h-3.5 w-3.5" />
                              </button>
                              {/* Dropdown menu */}
                              {openActionsFileId === file.id && <div role="menu" className="absolute right-0 top-full mt-1 w-56 rounded-lg shadow-xl z-50">
                                <div style={{ backgroundColor: '#252326', border: '1px solid #39363a' }}>
                                  <div className="p-1">
                                    <button
                                      onClick={() => requestReplacement('replace', [file.id])}
                                      disabled={replaceOriginalMutation.isPending || pendingFileReplacements.has(file.id)}
                                      className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/5 rounded transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                      title="Replace original file with transcoded version"
                                    >
                                      <Replace className={`h-4 w-4 ${pendingFileReplacements.has(file.id) ? 'animate-spin' : ''}`} />
                                      {pendingFileReplacements.has(file.id) ? 'Replacing...' : 'Replace Original'}
                                    </button>
                                    {file.status === 'backup_replaced' ? (
                                      <button
                                        onClick={() => requestReplacement('cleanup_backup', [file.id])}
                                        disabled={cleanupBackupMutation.isPending || pendingFileReplacements.has(file.id)}
                                        className="w-full text-left px-3 py-2 text-sm text-green-400 hover:bg-white/5 rounded transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                        title="Permanently remove the retained original .org file"
                                      >
                                        <Copy className={`h-4 w-4 ${pendingFileReplacements.has(file.id) ? 'animate-spin' : ''}`} />
                                        {pendingFileReplacements.has(file.id) ? 'Removing...' : 'Remove Original Backup (.org)'}
                                      </button>
                                    ) : (
                                      <button
                                        onClick={() => requestReplacement('backup_replace', [file.id])}
                                        disabled={backupAndReplaceMutation.isPending || pendingFileReplacements.has(file.id)}
                                        className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/5 rounded transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                        title="Rename original to .org and put new file in place"
                                      >
                                        <Copy className={`h-4 w-4 ${pendingFileReplacements.has(file.id) ? 'animate-spin' : ''}`} />
                                        {pendingFileReplacements.has(file.id) ? 'Backing up...' : 'Backup & Replace'}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>}
                            </div>
                          ) : null}

                          {/* Report button */}
                          <button
                            onClick={() => {
                              setReportFileId(file.id);
                              setReportFileName(file.filename || file.name || '');
                              setShowReportDrawer(true);
                            }}
                            className="p-1 rounded transition-colors hover:bg-white/10"
                            style={{ color: '#9ca3af' }}
                            title="View reports"
                          >
                            <FileText className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                    </div>
                  </div>
                </>
              )}

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="px-4 py-3 border-t border-[#39363a] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-0">
                  <div className="text-sm text-gray-400">
                    Showing {totalFiles > 0 ? (currentPage - 1) * perPage + 1 : 0} to {Math.min(currentPage * perPage, totalFiles)} of {totalFiles} files
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      onClick={() => setCurrentPage(1)}
                      disabled={currentPage === 1}
                      style={{ borderColor: '#39363a', color: '#ffffff' }}
                      className="border"
                    >
                      First
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                      disabled={currentPage === 1}
                      style={{ borderColor: '#39363a', color: '#ffffff' }}
                      className="border"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="px-3 text-sm text-gray-400">
                      Page {currentPage} of {totalPages}
                    </span>
                    <Button
                      size="sm"
                      onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                      disabled={currentPage === totalPages}
                      style={{ borderColor: '#39363a', color: '#ffffff' }}
                      className="border"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setCurrentPage(totalPages)}
                      disabled={currentPage === totalPages}
                      style={{ borderColor: '#39363a', color: '#ffffff' }}
                      className="border"
                    >
                      Last
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>

    <Dialog
      open={!!replacementConfirmation}
      onClose={() => {
        setReplacementConfirmation(null);
        setReplacementConfirmed(false);
      }}
      title={replacementConfirmation?.operation === 'cleanup_backup'
        ? 'Confirm Original Backup Removal'
        : replacementConfirmation?.operation === 'backup_replace' ? 'Confirm Backup & Replace' : 'Confirm Replace Original'}
      size="md"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            onClick={() => setReplacementConfirmation(null)}
            className="border border-[#39363a] text-gray-300"
          >
            Cancel
          </Button>
          <Button
            onClick={confirmReplacement}
            disabled={!replacementConfirmed}
            className={replacementConfirmation?.operation === 'replace' || replacementConfirmation?.operation === 'cleanup_backup'
              ? 'bg-red-600 text-white hover:bg-red-500 disabled:opacity-40'
              : 'bg-[#4f7d68] text-white hover:bg-[#5c8d76] disabled:opacity-40'}
          >
            {replacementConfirmation?.operation === 'cleanup_backup'
              ? 'Permanently Remove Original'
              : replacementConfirmation?.operation === 'backup_replace' ? 'Backup & Replace' : 'Replace Original'}
          </Button>
        </div>
      }
    >
      {replacementConfirmation && (
        <div className="space-y-4">
          <div className={`rounded-lg border p-4 ${replacementConfirmation.operation === 'replace' || replacementConfirmation.operation === 'cleanup_backup' ? 'border-red-500/35 bg-red-500/10' : 'border-amber-500/35 bg-amber-500/10'}`}>
            <div className="flex items-start gap-3">
              <AlertTriangle className={`mt-0.5 h-5 w-5 shrink-0 ${replacementConfirmation.operation === 'replace' || replacementConfirmation.operation === 'cleanup_backup' ? 'text-red-400' : 'text-amber-400'}`} />
              <div>
                <p className="font-medium text-white">
                  This will affect {replacementConfirmation.fileIds.length.toLocaleString()} file{replacementConfirmation.fileIds.length === 1 ? '' : 's'}.
                </p>
                <p className="mt-1.5 text-sm leading-6 text-gray-300">
                  {replacementConfirmation.operation === 'cleanup_backup'
                    ? 'The retained .org original will be permanently deleted. The installed transcoded file remains in place, but the original version cannot be restored afterward.'
                    : replacementConfirmation.operation === 'replace'
                      ? 'Each transcoded output will be moved into the original file path. The current original is overwritten and no automatic backup is kept. This cannot be undone from Encorr.'
                      : 'Each current original will first be renamed with a .org extension. The transcoded output is then moved into the original path. Both copies use disk space until you explicitly remove the original backup.'}
                </p>
              </div>
            </div>
          </div>

          <div className="max-h-32 overflow-auto rounded-lg border border-[#39363a] bg-[#1e1d1f] p-3">
            {replacementConfirmation.fileIds.slice(0, 10).map(id => {
              const file = filesWithJobStatus.find((item: any) => item.id === id);
              return <p key={id} className="truncate py-0.5 text-xs text-gray-400">{file?.filename || file?.name || id}</p>;
            })}
            {replacementConfirmation.fileIds.length > 10 && (
              <p className="pt-1 text-xs text-gray-500">and {(replacementConfirmation.fileIds.length - 10).toLocaleString()} more…</p>
            )}
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[#39363a] bg-[#252326] p-3">
            <input
              type="checkbox"
              checked={replacementConfirmed}
              onChange={event => setReplacementConfirmed(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#74c69d]"
            />
            <span className="text-sm text-gray-300">
              I understand exactly what will happen to {replacementConfirmation.fileIds.length === 1 ? 'this file' : 'these files'} and want to continue.
            </span>
          </label>

          <p className="text-xs text-gray-500">
            Once confirmed, every move appears on the Jobs page with its current step, exact progress, transferred bytes, and live MB/s.
          </p>
        </div>
      )}
    </Dialog>

    {/* Smart Transcode Dialog - outside space-y-4 to avoid margin */}
    <SmartTranscodeDialog
      open={showSmartTranscodeDialog}
      onOpenChange={setShowSmartTranscodeDialog}
      files={files.filter((f: any) => selectedFiles.has(f.id))}
      onConfirm={async (mode, presetId, quickSelectId, postAction) => {
        await smartTranscodeMutation.mutateAsync({ mode, presetId, quickSelectId, postAction });
      }}
    />

    {/* Report Drawer - outside space-y-4 to avoid margin */}
    <ReportDrawer
      fileId={reportFileId ?? ''}
      fileName={reportFileName}
      open={showReportDrawer && !!reportFileId}
      onClose={() => {
        setReportFileId(null);
        setShowReportDrawer(false);
      }}
    />
    </>
  );
}
