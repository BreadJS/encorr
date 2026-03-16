import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatBytes } from '@/utils/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { TranscodeDialog } from '@/components/ui/TranscodeDialog';
import { RefreshCw, ChevronLeft, ChevronRight, Film, Folder, FolderOpen, Check, Search, Filter, Play, Scan, Database } from 'lucide-react';
import { useState, useMemo } from 'react';

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
  const [currentPage, setCurrentPage] = useState(1);
  const [perPage] = useState(25);

  // Fetch libraries/folders from API
  const { data: libraries = [] } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => api.getLibraries(),
  });

  // Fetch files from API
  const { data: filesData, isLoading, refetch } = useQuery({
    queryKey: ['files', selectedFolder, selectedStatus, currentPage, perPage],
    queryFn: () => api.getAllLibraryFiles({
      page: currentPage,
      per_page: perPage,
      status: selectedStatus !== 'all' ? selectedStatus : undefined,
      library_id: selectedFolder !== 'all' ? selectedFolder : undefined,
    }),
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

  // Apply client-side search filter
  const filteredFiles = useMemo(() => {
    if (!searchQuery) return files;
    return files.filter((file: any) =>
      file.filename?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      file.library_name?.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [files, searchQuery]);

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
      // Transcode all analyzed files
      const analyzedFileIds = files
        .filter((f: any) => f.status === 'analyzed')
        .map((f: any) => f.id);
      queueMutation.mutate({ fileIds: analyzedFileIds, presetId });
    } else {
      // Transcode selected analyzed files
      const analyzedFileIds = files
        .filter((f: any) => selectedFiles.has(f.id) && f.status === 'analyzed')
        .map((f: any) => f.id);
      queueMutation.mutate({ fileIds: analyzedFileIds, presetId });
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

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Files</h1>
          <p className="text-gray-400">Browse and queue video files for transcoding</p>
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
            {selectedFiles.size > 0 ? `Transcode Selected (${selectedFiles.size})` : `Transcode All (${files.filter((f: any) => f.status === 'analyzed').length})`}
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

      {/* Bulk Transcode Options Panel - REMOVED, now using modal dialog */}

      <div className="flex gap-4 overflow-hidden">
        {/* Sidebar - Folder Navigation */}
        <Card style={{ backgroundColor: '#252326', border: '1px solid #39363a', width: '240px', flexShrink: 0 }}>
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
          <Card style={{ backgroundColor: '#252326', border: '1px solid #39363a' }}>
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
          <Card style={{ backgroundColor: '#252326', border: '1px solid #39363a' }}>
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
                  <div className="px-4 py-3 border-b border-[#39363a] flex items-center gap-2" style={{ backgroundColor: '#1E1D1F' }}>
                    <div className="flex items-center justify-center w-8 flex-shrink-0">
                      <input
                        type="checkbox"
                        checked={selectedFiles.size === filteredFiles.length && filteredFiles.length > 0}
                        onChange={handleToggleAll}
                        className="w-4 h-4 rounded"
                        style={{ accentColor: '#74c69d' }}
                      />
                    </div>
                    <div className="flex-1 min-w-0 text-xs text-gray-400 uppercase font-medium">Filename</div>
                    <div className="text-xs text-gray-400 uppercase font-medium w-16 flex-shrink-0">Fmt</div>
                    <div className="text-xs text-gray-400 uppercase font-medium w-20 flex-shrink-0">Codec</div>
                    <div className="text-xs text-gray-400 uppercase font-medium w-20 flex-shrink-0">Res</div>
                    <div className="text-xs text-gray-400 uppercase font-medium w-20 flex-shrink-0">Size</div>
                    <div className="text-xs text-gray-400 uppercase font-medium w-24 flex-shrink-0">Status</div>
                    <div className="text-xs text-gray-400 uppercase font-medium w-12 flex-shrink-0">+</div>
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
                        </div>

                        {/* Format */}
                        <div className="w-16 flex-shrink-0">
                          <span className="text-xs px-1.5 py-0.5 rounded text-gray-300 text-center block" style={{ backgroundColor: '#2a2a2a' }}>
                            {(file.format || file.container || (file.metadata?.container) || '---').toUpperCase()}
                          </span>
                        </div>

                        {/* Codec */}
                        <div className="w-20 flex-shrink-0">
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
                          <StatusBadge status={file.status} />
                          {file.status === 'processing' && (
                            <div className="mt-1 w-full h-1 bg-gray-700 rounded-full overflow-hidden">
                              <div
                                className="h-full transition-all"
                                style={{ width: `${file.progress || 0}%`, backgroundColor: '#74c69d' }}
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
                                    {['High Quality H.265', 'Fast 1080p H.264', 'Maximum Compression'].map((preset) => (
                                      <button
                                        key={preset}
                                        onClick={() => {
                                          const presetId = preset === 'High Quality H.265' ? 'builtin-high-quality' :
                                            preset === 'Fast 1080p H.264' ? 'builtin-fast-1080p' : 'builtin-max-compression';
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
                          ) : file.status === 'queued' ? (
                            <span className="text-xs text-gray-500">...</span>
                          ) : file.status === 'processing' ? (
                            <span className="text-xs text-gray-500">{file.progress}%</span>
                          ) : file.status === 'completed' ? (
                            <Check className="h-4 w-4 text-[#74c69d]" />
                          ) : null}
                        </div>
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

      {/* Transcode Dialog */}
      <TranscodeDialog
        isOpen={showTranscodeDialog}
        onClose={() => setShowTranscodeDialog(false)}
        onConfirm={handleTranscodeConfirm}
        isPending={queueMutation.isPending}
        mode={transcodeDialogMode}
        files={files}
        selectedFiles={selectedFiles}
      />
    </div>
  );
}
