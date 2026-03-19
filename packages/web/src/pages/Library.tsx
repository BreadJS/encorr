import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatBytes } from '@/utils/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FolderPlus, Trash2, RefreshCw, Film, X, Check, AlertCircle, FolderOpen, Folder, ChevronRight, HardDrive, ArrowLeft, ArrowRight, AlertTriangle } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';

export function Library() {
  const queryClient = useQueryClient();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newLibraryName, setNewLibraryName] = useState('');
  // Start at root - on Windows this will be the root of current drive (e.g., "C:\"), on Linux it's "/"
  const [currentBrowsePath, setCurrentBrowsePath] = useState('/');
  const [pathInputValue, setPathInputValue] = useState('/');
  const [selectedLibraryPath, setSelectedLibraryPath] = useState('');
  const [pathValidationError, setPathValidationError] = useState<string | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);

  // Connect to WebSocket for real-time updates
  useWebSocket({ channels: ['jobs'] });

  const { data: libraries, isLoading } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => api.getLibraries(),
    staleTime: 30000, // Libraries can be stale for 30 seconds
  });

  const { data: libraryFiles } = useQuery({
    queryKey: ['library-files', selectedLibraryId],
    queryFn: () => (selectedLibraryId ? api.getLibraryFiles(selectedLibraryId) : []),
    enabled: !!selectedLibraryId,
    staleTime: 10000, // Files can be stale for 10 seconds, jobs WebSocket updates will invalidate
  });

  // Get available drives (Windows only)
  const { data: drivesInfo } = useQuery({
    queryKey: ['drives'],
    queryFn: () => api.getDrives(),
    staleTime: Infinity, // Platform doesn't change
  });

  const { data: browseData, isLoading: browsing, error: browseQueryError } = useQuery({
    queryKey: ['browse', currentBrowsePath],
    queryFn: () => api.browseDirectory(currentBrowsePath),
    enabled: showAddDialog,
  });

  // Sync query error to local state
  useEffect(() => {
    if (browseQueryError) {
      setBrowseError(browseQueryError instanceof Error ? browseQueryError.message : 'Failed to browse directory');
    } else {
      setBrowseError(null);
    }
  }, [browseQueryError]);

  const validateMutation = useMutation({
    mutationFn: (path: string) => api.validatePath(path),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; path: string }) => api.createLibrary(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
      queryClient.invalidateQueries({ queryKey: ['mappings'] });
      closeAddDialog();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteLibrary(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
      queryClient.invalidateQueries({ queryKey: ['mappings'] });
      if (selectedLibraryId === deleteMutation.variables) {
        setSelectedLibraryId(null);
      }
    },
  });

  const importMutation = useMutation({
    mutationFn: (libraryId: string) => api.importLibrary(libraryId),
    onSuccess: (_, libraryId) => {
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
      queryClient.invalidateQueries({ queryKey: ['library-files', libraryId] });
    },
  });

  const deleteFileMutation = useMutation({
    mutationFn: (id: string) => api.deleteLibraryFile(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
      queryClient.invalidateQueries({ queryKey: ['library-files', selectedLibraryId] });
    },
  });

  const selectedLibrary = libraries?.find((lib: any) => lib.id === selectedLibraryId);
  const isWindows = drivesInfo?.platform === 'win32';

  const closeAddDialog = () => {
    setShowAddDialog(false);
    setNewLibraryName('');
    setSelectedLibraryPath('');
    setCurrentBrowsePath('/');
    setPathInputValue('/');
    setPathValidationError(null);
    setBrowseError(null);
  };

  const handleSelectPath = async (path: string) => {
    setSelectedLibraryPath(path);
    setPathValidationError(null);
    setBrowseError(null);

    // Validate the path
    try {
      const result = await validateMutation.mutateAsync(path);
      if (!result.valid) {
        setPathValidationError(result.error || 'Invalid path');
      }
    } catch (error: any) {
      setPathValidationError(error.message || 'Failed to validate path');
    }
  };

  const handleNavigateToPath = async (path: string) => {
    setCurrentBrowsePath(path);
    setPathInputValue(path);
    // Also update the selected path field
    await handleSelectPath(path);
  };

  const handleGoToPath = async () => {
    if (pathInputValue.trim()) {
      setBrowseError(null);
      try {
        await handleNavigateToPath(pathInputValue.trim());
      } catch (error: any) {
        setBrowseError(error.message || 'Failed to navigate to path');
      }
    }
  };

  const handlePathInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleGoToPath();
    }
  };

  const handleDriveChange = (drivePath: string) => {
    handleNavigateToPath(drivePath);
  };

  const handleAddLibrary = async () => {
    if (!newLibraryName || !selectedLibraryPath) {
      setPathValidationError('Please provide a name and select a path');
      return;
    }

    // Validate path again before creating
    try {
      const result = await validateMutation.mutateAsync(selectedLibraryPath);
      if (!result.valid) {
        setPathValidationError(result.error || 'Invalid path');
        return;
      }
      createMutation.mutate({ name: newLibraryName, path: selectedLibraryPath });
    } catch (error: any) {
      setPathValidationError(error.message || 'Failed to validate path');
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'text-gray-400';
      case 'queued': return 'text-blue-400';
      case 'processing': return 'text-yellow-400';
      case 'completed': return 'text-green-400';
      case 'failed': return 'text-red-400';
      case 'skipped': return 'text-gray-500';
      default: return 'text-gray-400';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <Check className="h-4 w-4" />;
      case 'failed': return <AlertCircle className="h-4 w-4" />;
      case 'processing': return <RefreshCw className="h-4 w-4 animate-spin" />;
      default: return null;
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-gray-400">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Library</h1>
          <p className="text-gray-400">Import and manage your video library</p>
        </div>
        <Button
          onClick={() => setShowAddDialog(true)}
          style={{ backgroundColor: '#74c69d', color: '#1a1a1a' }}
          className="hover:opacity-90"
        >
          <FolderPlus className="h-4 w-4 mr-2" />
          Add Library
        </Button>
      </div>

      {/* Add Library Dialog */}
      {showAddDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <Card className="w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col" style={{ backgroundColor: '#252326', border: '1px solid #38363a' }}>
            <CardHeader>
              <CardTitle className="text-white">Add New Library</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 flex-1 overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">Library Name</label>
                <Input
                  value={newLibraryName}
                  onChange={(e) => setNewLibraryName(e.target.value)}
                  placeholder="My Videos"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">Selected Path</label>
                <div className="flex gap-2">
                  <Input
                    value={selectedLibraryPath}
                    onChange={(e) => setSelectedLibraryPath(e.target.value)}
                    placeholder="Browse or enter path manually"
                  />
                  <Button
                    variant="outline"
                    onClick={() => handleSelectPath(selectedLibraryPath)}
                    disabled={validateMutation.isPending}
                    style={{ borderColor: '#38363a', color: '#ffffff' }}
                  >
                    Validate
                  </Button>
                </div>
                {pathValidationError && (
                  <p className="text-xs text-red-400 mt-1">{pathValidationError}</p>
                )}
                {selectedLibraryPath && !pathValidationError && validateMutation.data?.valid && (
                  <p className="text-xs text-green-400 mt-1">✓ Valid directory</p>
                )}
              </div>

              {/* Folder Browser */}
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">Browse Directory</label>
                <Card className="border border-gray-700" style={{ backgroundColor: '#1E1D1F' }}>
                  {/* Top Navigation Bar */}
                  <div className="p-3 border-b border-gray-700">
                    <div className="flex items-center gap-2">
                      {/* Root/Home button */}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleNavigateToPath('/')}
                        disabled={browsing}
                        style={{ borderColor: '#38363a', color: '#ffffff' }}
                        title="Go to root"
                      >
                        <HardDrive className="h-4 w-4" />
                      </Button>

                      {/* Windows Drive Switcher */}
                      {isWindows && drivesInfo?.drives && drivesInfo.drives.length > 0 && (
                        <select
                          value={currentBrowsePath.substring(0, 3)}
                          onChange={(e) => handleDriveChange(e.target.value)}
                          disabled={browsing}
                          className="px-2 py-1 text-sm rounded border"
                          style={{
                            backgroundColor: '#252326',
                            borderColor: '#38363a',
                            color: '#ffffff',
                            minWidth: '60px',
                          }}
                        >
                          {drivesInfo.drives.map((drive) => (
                            <option key={drive.letter} value={drive.path}>
                              {drive.letter}
                            </option>
                          ))}
                        </select>
                      )}

                      {/* Chevron separator */}
                      <ChevronRight className="h-4 w-4 text-gray-500" />

                      {/* Editable path input */}
                      <Input
                        value={pathInputValue}
                        onChange={(e) => {
                          setPathInputValue(e.target.value);
                          setBrowseError(null); // Clear error when user starts typing
                        }}
                        onKeyDown={handlePathInputKeyDown}
                        disabled={browsing}
                        className="flex-1"
                        placeholder="Type path and press Enter or click Go"
                        style={{
                          backgroundColor: '#1E1D1F',
                          border: browseError ? '1px solid #ef4444' : '1px solid #38363a',
                          color: '#ffffff'
                        }}
                      />

                      {/* Go button */}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleGoToPath}
                        disabled={browsing || !pathInputValue.trim()}
                        style={{ borderColor: '#38363a', color: '#ffffff' }}
                        title="Go to path"
                      >
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Browse error message */}
                  {browseError && (
                    <div className="px-3 py-2 bg-red-900/30 border-b border-red-900 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-red-400" />
                      <span className="text-xs text-red-400">{browseError}</span>
                    </div>
                  )}

                  {/* Directory listing */}
                  <div className="max-h-64 overflow-y-auto">
                    {browsing ? (
                      <div className="text-center text-gray-400 py-8">Loading...</div>
                    ) : (
                      <div className="p-2 space-y-1">
                        {/* Back button at top of directory list - always show when parent exists */}
                        {browseData?.parent_path && (
                          <div
                            className="flex items-center gap-2 p-2 rounded hover:bg-white/10 cursor-pointer transition-colors"
                            onClick={() => handleNavigateToPath(browseData.parent_path!)}
                          >
                            <ArrowLeft className="h-4 w-4 text-gray-400" />
                            <Folder className="h-4 w-4" />
                            <span className="text-sm text-gray-300">..</span>
                            <span className="text-xs text-gray-500 ml-1">(parent directory)</span>
                          </div>
                        )}

                        {/* Directory items or empty message */}
                        {browseData?.items.length === 0 ? (
                          <div className="text-center text-gray-400 py-4">Empty directory</div>
                        ) : (
                          browseData?.items.map((item) => (
                            <div
                              key={item.path}
                              className="flex items-center gap-2 p-2 rounded hover:bg-white/10 cursor-pointer transition-colors"
                              onClick={() => handleNavigateToPath(item.path)}
                            >
                              <Folder className="h-4 w-4 text-yellow-500" />
                              <span className="text-sm text-gray-300 truncate">{item.name}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </Card>
                <p className="text-xs text-gray-500 mt-2">
                  Edit the path above and press Enter or click Go, or click folders to navigate. Click a folder to select it as your library path.
                </p>
              </div>

              <div className="flex gap-2 justify-end pt-2">
                <Button
                  variant="outline"
                  onClick={closeAddDialog}
                  style={{ borderColor: '#38363a', color: '#ffffff' }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleAddLibrary}
                  disabled={createMutation.isPending || !newLibraryName || !selectedLibraryPath || !!pathValidationError}
                  style={{ backgroundColor: '#74c69d', color: '#1a1a1a' }}
                  className="hover:opacity-90"
                >
                  {createMutation.isPending ? 'Creating...' : 'Create'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Libraries List */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <h2 className="text-xl font-semibold text-white">Libraries</h2>
          {libraries?.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <FolderOpen className="mx-auto h-12 w-12 text-gray-600 mb-4" />
                <p className="text-gray-400">No libraries yet</p>
                <p className="text-sm text-gray-500 mt-2">Add a library to import your video files</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {libraries?.map((lib: any) => (
                <Card
                  key={lib.id}
                  className={`transition-all ${
                    selectedLibraryId === lib.id
                      ? 'ring-2 ring-[#74c69d]'
                      : ''
                  }`}
                  style={{ backgroundColor: '#252326', border: '1px solid #38363a' }}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div
                        className="flex-1 min-w-0"
                        onClick={() => setSelectedLibraryId(lib.id)}
                      >
                        <h3 className="text-white font-medium truncate">{lib.name}</h3>
                        <p className="text-xs text-gray-500 truncate">{lib.path}</p>
                        <p className="text-xs text-gray-400 mt-1">{lib.file_count || 0} files</p>
                      </div>
                      <div className="flex gap-1 ml-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            importMutation.mutate(lib.id);
                          }}
                          disabled={importMutation.isPending}
                          style={{ borderColor: '#38363a', color: '#74c69d' }}
                          className="hover:bg-green-900/20"
                          title="Scan library for files"
                        >
                          <RefreshCw className={`h-4 w-4 ${importMutation.isPending && importMutation.variables === lib.id ? 'animate-spin' : ''}`} />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Delete library "${lib.name}"?`)) {
                              deleteMutation.mutate(lib.id);
                            }
                          }}
                          disabled={deleteMutation.isPending}
                          style={{ borderColor: '#38363a', color: '#ef4444' }}
                          className="hover:bg-red-900/20"
                          title="Delete library"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Library Files */}
        <div className="lg:col-span-2">
          {selectedLibrary ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-white">{selectedLibrary.name}</h2>
                  <p className="text-sm text-gray-400">{selectedLibrary.path}</p>
                </div>
                <Button
                  onClick={() => selectedLibraryId && importMutation.mutate(selectedLibraryId)}
                  disabled={importMutation.isPending || !selectedLibraryId}
                  style={{ backgroundColor: '#74c69d', color: '#1a1a1a' }}
                  className="hover:opacity-90"
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${importMutation.isPending ? 'animate-spin' : ''}`} />
                  {importMutation.isPending ? 'Scanning...' : 'Import Files'}
                </Button>
              </div>

              {libraryFiles && libraryFiles.length > 0 ? (
                <Card style={{ backgroundColor: '#252326', border: '1px solid #38363a' }}>
                  <div className="max-h-[600px] overflow-y-auto">
                    <table className="w-full">
                      <thead className="sticky top-0" style={{ backgroundColor: '#1E1D1F' }}>
                        <tr className="text-left text-xs text-gray-400 uppercase">
                          <th className="px-4 py-3 font-medium">Filename</th>
                          <th className="px-4 py-3 font-medium">Format</th>
                          <th className="px-4 py-3 font-medium">Size</th>
                          <th className="px-4 py-3 font-medium">Status</th>
                          <th className="px-4 py-3 font-medium">Progress</th>
                          <th className="px-4 py-3 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {libraryFiles.map((file: any) => (
                          <tr
                            key={file.id}
                            className="border-t border-gray-800 hover:bg-white/5 transition-colors"
                          >
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <Film className="h-4 w-4 text-gray-500" />
                                <span className="text-white text-sm">{file.filename}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span className="text-xs text-gray-400 uppercase">{file.format || '—'}</span>
                            </td>
                            <td className="px-4 py-3">
                              <span className="text-xs text-gray-400">{file.filesize ? formatBytes(file.filesize) : '—'}</span>
                            </td>
                            <td className="px-4 py-3">
                              <div className={`flex items-center gap-1 text-xs ${getStatusColor(file.status)}`}>
                                {getStatusIcon(file.status)}
                                <span className="capitalize">{file.status}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              {file.status === 'processing' || file.status === 'completed' ? (
                                <div className="flex items-center gap-2">
                                  <div className="w-24 h-2 bg-gray-700 rounded-full overflow-hidden">
                                    <div
                                      className="h-full transition-all"
                                      style={{
                                        width: `${file.progress}%`,
                                        backgroundColor: '#74c69d'
                                      }}
                                    />
                                  </div>
                                  <span className="text-xs text-gray-400">{file.progress}%</span>
                                </div>
                              ) : (
                                <span className="text-xs text-gray-500">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  if (confirm(`Remove "${file.filename}" from library?`)) {
                                    deleteFileMutation.mutate(file.id);
                                  }
                                }}
                                disabled={deleteFileMutation.isPending}
                                style={{ borderColor: '#38363a', color: '#ef4444' }}
                                className="hover:bg-red-900/20"
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : (
                <Card>
                  <CardContent className="py-12 text-center">
                    <Film className="mx-auto h-12 w-12 text-gray-600 mb-4" />
                    <p className="text-gray-400">No files imported yet</p>
                    <p className="text-sm text-gray-500 mt-2">Click "Import Files" to scan the library folder</p>
                  </CardContent>
                </Card>
              )}
            </div>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <FolderOpen className="mx-auto h-12 w-12 text-gray-600 mb-4" />
                <p className="text-gray-400">Select a library to view its files</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
