import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatBytes } from '@/utils/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { TranscodeDialog } from '@/components/ui/TranscodeDialog';
import { SmartTranscodeDialog } from '@/components/ui/SmartTranscodeDialog';
import { RefreshCw, ChevronLeft, ChevronRight, Film, Folder, FolderOpen, Check, Search, Filter, Play, Scan, Database, Sparkles, Clock, Zap, X, AlertTriangle, FileText, Ban } from 'lucide-react';
import { ReportDrawer } from '@/components/ReportDrawer';
import { useState, useMemo } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { TranscodeMode } from '@encorr/shared';

// Helper function to format duration as HH:MM:SS
function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '—:--:--';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

type ViewMode = 'all' | 'folder';

export function Files() {
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [selectedFolder, setSelectedFolder] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [showTranscodeDialog, setShowTranscodeDialog] = useState(false);
  const [transcodeDialogMode, setTranscodeDialogMode] = useState<'all' | 'selected'>('selected');
  const [showSmartTranscodeDialog, setShowSmartTranscodeDialog] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [perPage] = useState(50);
  const [reportFileId, setReportFileId] = useState<string | null>(null);
  const [reportFileName, setReportFileName] = useState('');
  const [showReportDrawer, setShowReportDrawer] = useState(false);

  // Enable WebSocket for real-time updates
  useWebSocket({ enabled: true });

  // Fetch libraries/folders from API
  const { data: libraries = [] } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => api.getLibraries(),
  });

  // Fetch files from API
  // Note: status filter is applied on frontend, not sent to API
  const { data: filesData, isLoading, refetch } = useQuery({
    queryKey: ['files', selectedFolder, currentPage, perPage],
    queryFn: () => api.getAllLibraryFiles({
      page: currentPage,
      per_page: perPage,
      library_id: selectedFolder !== 'all' ? selectedFolder : undefined,
    }),
    refetchInterval: 10000, // Refetch every 10s as fallback to WebSocket
  });

  // Fetch all jobs to correlate with library files
  const { data: jobs = [] } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.getJobs(),
    refetchInterval: 5000, // Refetch jobs every 5s for active jobs
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
      // Find the job associated with this file (via file_id)
      const job = jobs.find((j: any) => j.file_id === file.id);

      // Determine display status and progress
      let displayStatus = file.status;
      let displayProgress = file.progress || 0;

      if (job) {
        if (job.status === 'assigned' || job.status === 'processing') {
          displayStatus = 'processing';
          displayProgress = job.progress || 0;
        } else if (job.status === 'completed') {
          displayStatus = 'completed';
          displayProgress = 100;
        } else if (job.status === 'failed') {
          displayStatus = 'failed';
        } else if (job.status === 'cancelled') {
          displayStatus = 'cancelled';
        }
      } else if (file.status === 'analyzed' || file.status === 'imported') {
        displayStatus = 'ready';
      }

      return {
        ...file,
        displayStatus,
        displayProgress,
        job,
      };
    });
  }, [files, jobs]);

  // Count files by status for filter tabs
  const statusCounts = useMemo(() => {
    const counts = {
      all: filesWithJobStatus.length,
      ready: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    filesWithJobStatus.forEach((file: any) => {
      if (file.displayStatus === 'ready') counts.ready++;
      else if (file.displayStatus === 'processing') counts.processing++;
      else if (file.displayStatus === 'completed') counts.completed++;
      else if (file.displayStatus === 'failed') counts.failed++;
      else if (file.displayStatus === 'cancelled') counts.cancelled++;
    });
    return counts;
  }, [filesWithJobStatus]);

  // Queue mutation
  const queueMutation = useMutation({
    mutationFn: ({ fileIds, presetId }: { fileIds: string[]; presetId: string }) =>
      api.createJob({ file_ids: fileIds, preset_id: presetId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
      setSelectedFiles(new Set());
      setShowTranscodeDialog(false);
    },
  });

  // Analyze mutation - only scans files, does not queue for transcoding
  const analyzeMutation = useMutation({
    mutationFn: async () => {
      await api.scanFiles();
      return { scanned: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
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

  // Analyze single file mutation
  const analyzeSingleMutation = useMutation({
    mutationFn: async (fileId: string) => {
      await api.createJob({ file_ids: [fileId], preset_id: 'builtin-analyze' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
    },
  });

  // Transcode single file mutation
  const transcodeSingleMutation = useMutation({
    mutationFn: async ({ fileId, presetId }: { fileId: string; presetId: string }) => {
      await api.createJob({ file_ids: [fileId], preset_id: presetId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
    },
  });

  // Smart transcode mutation
  const smartTranscodeMutation = useMutation({
    mutationFn: async ({ mode, presetId }: { mode: TranscodeMode; presetId?: string }) => {
      const fileIds = Array.from(selectedFiles);
      return api.createSmartJob({ file_ids: fileIds, mode, preset_id: presetId });
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

  const handleToggleFile = (fileId: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  };

  const handleToggleAll = () => {
    if (selectedFiles.size === filteredFiles.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(filteredFiles.map(f => f.id)));
    }
  };

  const handleTranscodeConfirm = (presetId: string) => {
    if (transcodeDialogMode === 'all') {
      // Transcode all ready files (analyzed or imported)
      const readyFileIds = filesWithJobStatus
        .filter((f: any) => f.displayStatus === 'ready')
        .map((f: any) => f.id);
      queueMutation.mutate({ fileIds: readyFileIds, presetId });
    } else {
      // Transcode selected ready files
      const readyFileIds = filesWithJobStatus
        .filter((f: any) => selectedFiles.has(f.id) && f.displayStatus === 'ready')
        .map((f: any) => f.id);
      queueMutation.mutate({ fileIds: readyFileIds, presetId });
    }
  };

  const handleOpenTranscodeDialog = (mode: 'all' | 'selected') => {
    setTranscodeDialogMode(mode);
    setShowTranscodeDialog(true);
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

    if (status === 'completed') {
      return (
        <div className="flex items-center gap-2">
          <Check className="h-3.5 w-3.5 text-green-400 flex-shrink-0" />
          <span className="text-green-400 text-xs">Completed</span>
        </div>
      );
    }

    if (status === 'failed') {
      return (
        <div className="flex items-center gap-2">
          <X className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />
          <span className="text-red-400 text-xs">Failed</span>
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Files</h1>
          <p className="text-gray-400">All files with real-time job status</p>
        </div>
        <div className="flex items-center gap-2">
          {selectedFiles.size > 0 && (
            <>
              <span className="text-sm text-gray-400">
                {selectedFiles.size} file{selectedFiles.size !== 1 ? 's' : ''} selected
              </span>
            </>
          )}

          {/* Analyze All / Analyze Selected Button */}
          <Button
            onClick={() => selectedFiles.size > 0 ? analyzeSelectedMutation.mutate() : analyzeMutation.mutate()}
            disabled={analyzeMutation.isPending || analyzeSelectedMutation.isPending}
            style={{ borderColor: '#39363a', color: '#ffffff' }}
            className="border flex items-center gap-2"
            title={selectedFiles.size > 0 ? 'Analyze selected files' : 'Scan for new video files'}
          >
            <Scan className={`h-4 w-4 ${analyzeMutation.isPending || analyzeSelectedMutation.isPending ? 'animate-spin' : ''}`} />
            {analyzeMutation.isPending || analyzeSelectedMutation.isPending ? 'Scanning...' : selectedFiles.size > 0 ? `Analyze Selected (${selectedFiles.size})` : 'Analyze All'}
          </Button>

          {/* Transcode All / Transcode Selected Button */}
          <Button
            onClick={() => handleOpenTranscodeDialog(selectedFiles.size > 0 ? 'selected' : 'all')}
            style={{ backgroundColor: '#9C27B0', color: '#ffffff' }}
            className="flex items-center gap-2"
          >
            <Database className="h-4 w-4" />
            {selectedFiles.size > 0 ? `Transcode Selected (${selectedFiles.size})` : `Transcode All (${filesWithJobStatus.filter((f: any) => f.displayStatus === 'ready').length})`}
          </Button>

          {/* Smart Transcode Button */}
          <Button
            onClick={() => setShowSmartTranscodeDialog(true)}
            disabled={selectedFiles.size === 0}
            style={{ backgroundColor: '#74c69d', color: '#ffffff' }}
            className="flex items-center gap-2"
            title="Smart Transcode - automatically optimize settings for your files"
          >
            <Sparkles className="h-4 w-4" />
            Smart Transcode ({selectedFiles.size})
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

      {/* Status Filter Tabs */}
      <div className="flex items-center gap-2 border-b border-[#39363a] pb-2">
        <button
          onClick={() => { setSelectedStatus('all'); setCurrentPage(1); }}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
            selectedStatus === 'all'
              ? 'bg-[#252326] text-white'
              : 'text-gray-400 hover:text-white hover:bg-[#252326]/50'
          }`}
        >
          All ({statusCounts.all})
        </button>
        <button
          onClick={() => { setSelectedStatus('ready'); setCurrentPage(1); }}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
            selectedStatus === 'ready'
              ? 'bg-[#252326] text-white'
              : 'text-gray-400 hover:text-white hover:bg-[#252326]/50'
          }`}
        >
          Transcodeable ({statusCounts.ready})
        </button>
        <button
          onClick={() => { setSelectedStatus('processing'); setCurrentPage(1); }}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
            selectedStatus === 'processing'
              ? 'bg-[#252326] text-white'
              : 'text-gray-400 hover:text-white hover:bg-[#252326]/50'
          }`}
        >
          Processing ({statusCounts.processing})
        </button>
        <button
          onClick={() => { setSelectedStatus('completed'); setCurrentPage(1); }}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
            selectedStatus === 'completed'
              ? 'bg-[#252326] text-white'
              : 'text-gray-400 hover:text-white hover:bg-[#252326]/50'
          }`}
        >
          Completed ({statusCounts.completed})
        </button>
        <button
          onClick={() => { setSelectedStatus('failed'); setCurrentPage(1); }}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
            selectedStatus === 'failed'
              ? 'bg-[#252326] text-white'
              : 'text-gray-400 hover:text-white hover:bg-[#252326]/50'
          }`}
        >
          Failed ({statusCounts.failed})
        </button>
        <button
          onClick={() => { setSelectedStatus('cancelled'); setCurrentPage(1); }}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
            selectedStatus === 'cancelled'
              ? 'bg-[#252326] text-white'
              : 'text-gray-400 hover:text-white hover:bg-[#252326]/50'
          }`}
        >
          Cancelled ({statusCounts.cancelled})
        </button>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 pr-4 py-2 bg-[#1a181b] border border-[#39363a] rounded-lg text-white text-sm placeholder:text-gray-500 focus:outline-none focus:border-[#74c69d] w-64"
            />
          </div>
        </div>
      </div>

      {/* Bulk Transcode Options Panel - REMOVED, now using modal dialog */}

      <div className="flex gap-4 overflow-hidden">
        {/* Sidebar - Folder Navigation */}
        <Card style={{ backgroundColor: '#252326', border: 'none', width: '240px', flexShrink: 0 }}>
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
                    <option value="pending">Pending</option>
                    <option value="queued">Queued</option>
                    <option value="processing">Processing</option>
                    <option value="completed">Completed</option>
                    <option value="failed">Failed</option>
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
                  {/* Table Header */}
                  <div className="px-4 py-3 border-b border-[#39363a] flex items-center gap-2" style={{ backgroundColor: '#2a282c' }}>
                    <div className="flex items-center justify-center w-8 flex-shrink-0">
                      <input
                        type="checkbox"
                        checked={selectedFiles.size === filteredFiles.length && filteredFiles.length > 0}
                        onChange={handleToggleAll}
                        className="w-4 h-4 rounded"
                        style={{ accentColor: '#74c69d' }}
                      />
                    </div>
                    <div className="flex-1 min-w-0 text-xs text-gray-300 uppercase font-medium">Filename</div>
                    <div className="text-xs text-gray-300 uppercase font-medium w-16 flex-shrink-0">Fmt</div>
                    <div className="text-xs text-gray-300 uppercase font-medium w-28 flex-shrink-0">Codec</div>
                    <div className="text-xs text-gray-300 uppercase font-medium w-20 flex-shrink-0">Res</div>
                    <div className="text-xs text-gray-300 uppercase font-medium w-20 flex-shrink-0">Size</div>
                    <div className="text-xs text-gray-300 uppercase font-medium w-24 flex-shrink-0">Status</div>
                    <div className="text-xs text-gray-300 uppercase font-medium w-12 flex-shrink-0">+</div>
                  </div>

                  {/* File Rows */}
                  <div className="divide-y divide-[#39363a]">
                    {filteredFiles.map((file: any) => (
                      <div
                        key={file.id}
                        className={`px-4 py-3 flex items-center gap-2 transition-all ${
                          selectedFiles.has(file.id) ? 'bg-white/5' : 'hover:bg-white/5'
                        }`}
                      >
                        {/* Checkbox */}
                        <div className="flex items-center justify-center w-8 flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={selectedFiles.has(file.id)}
                            onChange={() => handleToggleFile(file.id)}
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
                            <span className="flex-shrink-0">{formatDuration(file.duration)}</span>
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
                              {file.displayStatus === 'failed' && file.job.error && (
                                <span className="text-red-400 truncate" title={file.job.error}>
                                  <AlertTriangle className="h-3 w-3 inline mr-1" />
                                  {file.job.error}
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

                        {/* Resolution */}
                        <div className="w-20 flex-shrink-0">
                          <span
                            className="text-xs px-1.5 py-0.5 rounded text-center block"
                            style={{ backgroundColor: getResolutionBadgeColor(file.resolution || (file.metadata?.width ? `${file.metadata?.width}x${file.metadata?.height}` : null)), color: '#ffffff' }}
                          >
                            {file.resolution || (file.metadata?.width ? `${file.metadata?.width}x${file.metadata?.height}` : (file.width ? `${file.width}p` : '---'))}
                          </span>
                        </div>

                        {/* Size */}
                        <div className="w-20 flex-shrink-0 text-sm text-gray-400 truncate">
                          {formatBytes(file.filesize || file.file_size || file.size || 0)}
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
                        <div className="w-auto flex-shrink-0 flex justify-center gap-1">
                          {file.status === 'pending' ? (
                            // Needs analysis - show Analyze button
                            <button
                              onClick={() => analyzeSingleMutation.mutate(file.id)}
                              disabled={analyzeSingleMutation.isPending}
                              className="px-2 py-1 text-xs rounded transition-colors"
                              style={{ backgroundColor: '#38363a', color: '#ffffff' }}
                              title="Analyze file to get metadata"
                            >
                              <Scan className="h-3 w-3 inline mr-1" />
                              Analyze
                            </button>
                          ) : file.status === 'analyzed' ? (
                            // Analyzed - show Transcode button with preset dropdown
                            <div className="relative group">
                              <button
                                className="px-2 py-1 text-xs rounded transition-colors"
                                style={{ backgroundColor: '#74c69d', color: '#ffffff' }}
                                title="Transcode this file"
                              >
                                <Play className="h-3 w-3 inline mr-1" />
                                Transcode
                              </button>
                              {/* Preset Dropdown */}
                              <div className="absolute left-0 top-full mt-1 w-48 rounded-lg shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity z-50">
                                <div style={{ backgroundColor: '#252326', border: '1px solid #39363a' }}>
                                  <div className="p-1">
                                    {['High Quality H.265 (CPU)', 'Fast H.264 (CPU)', 'Maximum Compression H.265 (CPU)'].map((preset) => (
                                      <button
                                        key={preset}
                                        onClick={() => {
                                          const presetId = preset === 'High Quality H.265 (CPU)' ? 'builtin-high-quality-h265-cpu' :
                                            preset === 'Fast H.264 (CPU)' ? 'builtin-fast-h264-cpu' : 'builtin-max-compression-h265-cpu';
                                          transcodeSingleMutation.mutate({ fileId: file.id, presetId });
                                        }}
                                        className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/5 rounded transition-colors"
                                      >
                                        {preset}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>
                          ) : file.displayStatus === 'processing' ? (
                            // Processing - show progress
                            <span className="text-xs text-blue-400">{file.displayProgress.toFixed(1)}%</span>
                          ) : file.displayStatus === 'completed' ? (
                            // Completed - show check
                            <Check className="h-4 w-4 text-[#74c69d]" />
                          ) : file.displayStatus === 'failed' ? (
                            // Failed - show retry button
                            <button
                              onClick={() => analyzeSingleMutation.mutate(file.id)}
                              disabled={analyzeSingleMutation.isPending}
                              className="px-2 py-1 text-xs rounded transition-colors"
                              style={{ backgroundColor: '#dc2626', color: '#ffffff' }}
                              title="Retry analysis"
                            >
                              <RefreshCw className="h-3 w-3" />
                            </button>
                          ) : null}
                        </div>

                        {/* Report button */}
                        <button
                          onClick={() => {
                            setReportFileId(file.id);
                            setReportFileName(file.filename || file.name || '');
                            setShowReportDrawer(true);
                          }}
                          className="p-1.5 rounded transition-colors hover:bg-white/10"
                          style={{ color: '#9ca3af' }}
                          title="View reports"
                        >
                          <FileText className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="px-4 py-3 border-t border-[#39363a] flex items-center justify-between">
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
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>

    {/* Transcode Dialog - outside space-y-4 to avoid margin */}
    <TranscodeDialog
      isOpen={showTranscodeDialog}
      onClose={() => setShowTranscodeDialog(false)}
      onConfirm={handleTranscodeConfirm}
      isPending={queueMutation.isPending}
      mode={transcodeDialogMode}
      files={files}
      selectedFiles={selectedFiles}
    />

    {/* Smart Transcode Dialog - outside space-y-4 to avoid margin */}
    <SmartTranscodeDialog
      open={showSmartTranscodeDialog}
      onOpenChange={setShowSmartTranscodeDialog}
      files={files.filter((f: any) => selectedFiles.has(f.id))}
      onConfirm={async (mode, presetId) => {
        await smartTranscodeMutation.mutateAsync({ mode, presetId });
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
