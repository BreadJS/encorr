import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/utils/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FolderPlus, Trash2, RefreshCw, ArrowLeft, ArrowRight, AlertTriangle, FolderOpen, HardDrive } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';

export function Library() {
  const queryClient = useQueryClient();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newLibraryName, setNewLibraryName] = useState('');
  const [currentBrowsePath, setCurrentBrowsePath] = useState('/');
  const [pathInputValue, setPathInputValue] = useState('/');
  const [selectedLibraryPath, setSelectedLibraryPath] = useState('');
  const [pathValidationError, setPathValidationError] = useState<string | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);

  useWebSocket({ channels: ['jobs'] });

  const { data: libraries, isLoading } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => api.getLibraries(),
    staleTime: 30000,
  });

  const { data: drivesInfo } = useQuery({
    queryKey: ['drives'],
    queryFn: () => api.getDrives(),
    staleTime: Infinity,
  });

  const { data: browseData, isLoading: browsing, error: browseQueryError } = useQuery({
    queryKey: ['browse', currentBrowsePath],
    queryFn: () => api.browseDirectory(currentBrowsePath),
    enabled: showAddDialog,
  });

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
    },
  });

  const importMutation = useMutation({
    mutationFn: (libraryId: string) => api.importLibrary(libraryId),
    onSuccess: (_, libraryId) => {
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
      queryClient.invalidateQueries({ queryKey: ['library-files', libraryId] });
    },
  });

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

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-gray-400">Loading...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Library</h1>
          <p className="text-sm text-gray-400">Manage your video libraries</p>
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

      {/* Stats Summary */}
      {libraries && libraries.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg px-3 py-2" style={{ backgroundColor: '#252326' }}>
            <p className="text-xs text-gray-500">Libraries</p>
            <p className="text-lg font-bold text-white">{libraries.length}</p>
          </div>
          <div className="rounded-lg px-3 py-2" style={{ backgroundColor: '#252326' }}>
            <p className="text-xs text-gray-500">Total Files</p>
            <p className="text-lg font-bold text-white">
              {libraries.reduce((sum: number, lib: any) => sum + (lib.file_count || 0), 0)}
            </p>
          </div>
        </div>
      )}

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
                  <p className="text-xs text-green-400 mt-1">Valid directory</p>
                )}
              </div>

              {/* Folder Browser */}
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">Browse Directory</label>
                <Card style={{ backgroundColor: '#1E1D1F', border: 'none' }}>
                  <div className="p-3 border-b border-gray-700">
                    <div className="flex items-center gap-2">
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

                      {isWindows && drivesInfo?.drives && drivesInfo.drives.length > 0 && (
                        <select
                          value={currentBrowsePath.substring(0, 3)}
                          onChange={(e) => handleDriveChange(e.target.value)}
                          disabled={browsing}
                          className="px-2 py-1 text-sm rounded border"
                          style={{ backgroundColor: '#252326', borderColor: '#38363a', color: '#ffffff', minWidth: '60px' }}
                        >
                          {drivesInfo.drives.map((drive) => (
                            <option key={drive.letter} value={drive.path}>{drive.letter}</option>
                          ))}
                        </select>
                      )}

                      <ArrowRight className="h-4 w-4 text-gray-500" />

                      <Input
                        value={pathInputValue}
                        onChange={(e) => {
                          setPathInputValue(e.target.value);
                          setBrowseError(null);
                        }}
                        onKeyDown={handlePathInputKeyDown}
                        disabled={browsing}
                        className="flex-1"
                        placeholder="Type path and press Enter"
                        style={{ backgroundColor: '#1E1D1F', border: browseError ? '1px solid #ef4444' : '1px solid #38363a', color: '#ffffff' }}
                      />

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

                  {browseError && (
                    <div className="px-3 py-2 bg-red-900/30 border-b border-red-900 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-red-400" />
                      <span className="text-xs text-red-400">{browseError}</span>
                    </div>
                  )}

                  <div className="max-h-64 overflow-y-auto">
                    {browsing ? (
                      <div className="text-center text-gray-400 py-8">Loading...</div>
                    ) : (
                      <div className="p-2 space-y-1">
                        {browseData?.parent_path && (
                          <div
                            className="flex items-center gap-2 p-2 rounded hover:bg-white/10 cursor-pointer transition-colors"
                            onClick={() => handleNavigateToPath(browseData.parent_path!)}
                          >
                            <ArrowLeft className="h-4 w-4 text-gray-400" />
                            <FolderOpen className="h-4 w-4" />
                            <span className="text-sm text-gray-300">..</span>
                            <span className="text-xs text-gray-500 ml-1">(parent directory)</span>
                          </div>
                        )}

                        {browseData?.items.length === 0 ? (
                          <div className="text-center text-gray-400 py-4">Empty directory</div>
                        ) : (
                          browseData?.items.map((item) => (
                            <div
                              key={item.path}
                              className="flex items-center gap-2 p-2 rounded hover:bg-white/10 cursor-pointer transition-colors"
                              onClick={() => handleNavigateToPath(item.path)}
                            >
                              <FolderOpen className="h-4 w-4 text-yellow-500" />
                              <span className="text-sm text-gray-300 truncate">{item.name}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </Card>
                <p className="text-xs text-gray-500 mt-2">
                  Edit the path and press Enter, or click folders to navigate.
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
      {libraries?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <div className="p-3 rounded-full mb-3" style={{ backgroundColor: '#38363a' }}>
            <FolderOpen className="h-8 w-8 text-gray-500" />
          </div>
          <p className="text-gray-400">No libraries yet</p>
          <p className="text-sm text-gray-500 mt-1">Add a library to import your video files</p>
          <Button
            onClick={() => setShowAddDialog(true)}
            style={{ backgroundColor: '#74c69d', color: '#1a1a1a' }}
            className="hover:opacity-90 mt-3"
          >
            <FolderPlus className="h-4 w-4 mr-2" />
            Add Library
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {libraries?.map((lib: any) => (
            <div
              key={lib.id}
              className="rounded-lg px-3 py-2.5 transition-colors hover:bg-white/[0.02]"
              style={{ backgroundColor: '#252326' }}
            >
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg flex-shrink-0" style={{ backgroundColor: '#38363a' }}>
                  <FolderOpen className="h-4 w-4" style={{ color: '#74c69d' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-white font-medium truncate">{lib.name}</h3>
                  <p className="text-xs text-gray-500 truncate">{lib.path}</p>
                </div>
                <span className="text-xs text-gray-500 shrink-0">{lib.file_count || 0} files</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => importMutation.mutate(lib.id)}
                    disabled={importMutation.isPending}
                    style={{ borderColor: '#38363a', color: '#74c69d' }}
                    className="hover:bg-green-900/20"
                    title="Scan library for files"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${importMutation.isPending && importMutation.variables === lib.id ? 'animate-spin' : ''}`} />
                    <span className="ml-1.5 text-xs">Scan</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (confirm(`Delete library "${lib.name}"?`)) {
                        deleteMutation.mutate(lib.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    style={{ borderColor: '#38363a', color: '#ef4444' }}
                    className="hover:bg-red-900/20"
                    title="Delete library"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
