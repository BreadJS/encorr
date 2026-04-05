import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatBytes } from '@/utils/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { StatusBadge } from '@/components/ui/Badge';
import { FolderPlus, Trash2, RefreshCw, Film, X, ChevronRight, ChevronDown, HardDrive, ArrowLeft, ArrowRight, AlertTriangle, FolderOpen, Folder, FileText } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { ReportDrawer } from '@/components/ReportDrawer';

export function Library() {
  const queryClient = useQueryClient();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newLibraryName, setNewLibraryName] = useState('');
  const [currentBrowsePath, setCurrentBrowsePath] = useState('/');
  const [pathInputValue, setPathInputValue] = useState('/');
  const [selectedLibraryPath, setSelectedLibraryPath] = useState('');
  const [pathValidationError, setPathValidationError] = useState<string | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [expandedLibraries, setExpandedLibraries] = useState<Set<string>>(new Set());
  const [selectedSubfolder, setSelectedSubfolder] = useState<string | null>(null);
  const [reportFileId, setReportFileId] = useState<string | null>(null);
  const [reportFileName, setReportFileName] = useState('');
  const [showReportDrawer, setShowReportDrawer] = useState(false);

  // Filter files by selected subfolder

  useWebSocket({ channels: ['jobs'] });

  const { data: libraries, isLoading } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => api.getLibraries(),
    staleTime: 30000,
  });

  const { data: libraryFiles } = useQuery({
    queryKey: ['library-files', selectedLibraryId],
    queryFn: () => (selectedLibraryId ? api.getLibraryFiles(selectedLibraryId) : []),
    enabled: !!selectedLibraryId,
    staleTime: 10000,
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

  // Filter files by selected subfolder
  const displayedFiles = useMemo(() => {
    if (!libraryFiles) return [];
    if (!selectedSubfolder || !selectedLibrary) return libraryFiles;
    const libPath = selectedLibrary.path.replace(/\/$/, '');
    const prefix = `${libPath}/${selectedSubfolder}/`;
    return libraryFiles.filter((file: any) => file.filepath.replace(/\\/g, '/').startsWith(prefix));
  }, [libraryFiles, selectedSubfolder, selectedLibrary]);

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

  const toggleLibraryExpand = (libId: string) => {
    setExpandedLibraries(prev => {
      const next = new Set(prev);
      if (next.has(libId)) {
        next.delete(libId);
      } else {
        next.add(libId);
      }
      return next;
    });
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

                      <ChevronRight className="h-4 w-4 text-gray-500" />

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
                            <Folder className="h-4 w-4" />
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

      {/* Libraries + Files Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sidebar */}
        <div className="lg:col-span-1 space-y-4">
          <h2 className="text-xl font-semibold text-white">Libraries</h2>
          {libraries?.length === 0 ? (
            <Card style={{ backgroundColor: '#252326', border: 'none' }}>
              <CardContent className="py-12 text-center">
                <FolderOpen className="mx-auto h-12 w-12 text-gray-600 mb-4" />
                <p className="text-gray-400">No libraries yet</p>
                <p className="text-sm text-gray-500 mt-2">Add a library to import your video files</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {libraries?.map((lib: any) => {
                const isExpanded = expandedLibraries.has(lib.id);
                const isSelected = selectedLibraryId === lib.id;
                // Compute folders for this specific library
                const libPath = lib.path?.replace(/\/$/, '') || '';
                const libFolders: Record<string, number> = {};
                if (isSelected && libraryFiles) {
                  for (const file of libraryFiles) {
                    const normalized = file.filepath.replace(/\\/g, '/');
                    if (normalized.startsWith(libPath + '/')) {
                      const relative = normalized.substring(libPath.length + 1);
                      const parts = relative.split('/');
                      if (parts.length > 1) {
                        // Only show top-level sub-folders
                        const topFolder = parts[0];
                        libFolders[topFolder] = (libFolders[topFolder] || 0) + 1;
                      }
                    }
                  }
                }
                const hasFolders = Object.keys(libFolders).length > 0;

                return (
                  <Card
                    key={lib.id}
                    className={`transition-all ${isSelected ? 'ring-2 ring-[#74c69d]' : ''}`}
                    style={{ backgroundColor: '#252326', border: 'none' }}
                  >
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          {/* Expand toggle */}
                          {isSelected && hasFolders ? (
                            <button
                              onClick={() => toggleLibraryExpand(lib.id)}
                              className="text-gray-400 hover:text-white transition-colors shrink-0"
                            >
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </button>
                          ) : (
                            <div className="w-4 shrink-0" />
                          )}
                          <div
                            className="flex-1 min-w-0 cursor-pointer"
                            onClick={() => {
                              setSelectedLibraryId(lib.id);
                              setSelectedSubfolder(null);
                            }}
                          >
                            <h3 className="text-white font-medium truncate">{lib.name}</h3>
                            <p className="text-xs text-gray-500 truncate">{lib.path}</p>
                            <p className="text-xs text-gray-400 mt-0.5">{lib.file_count || 0} files</p>
                          </div>
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

                      {/* Sub-folder tree */}
                      {isExpanded && isSelected && hasFolders && (
                        <div className="mt-2 ml-6 space-y-0.5">
                          <button
                            className={`flex items-center gap-2 w-full text-left p-1.5 rounded text-sm transition-colors ${
                              selectedSubfolder === null ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-white hover:bg-white/5'
                            }`}
                            onClick={() => setSelectedSubfolder(null)}
                          >
                            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                            <span>All files</span>
                          </button>
                          {Object.entries(libFolders).sort(([a], [b]) => a.localeCompare(b)).map(([folder, count]) => (
                            <button
                              key={folder}
                              className={`flex items-center gap-2 w-full text-left p-1.5 rounded text-sm transition-colors ${
                                selectedSubfolder === folder ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-white hover:bg-white/5'
                              }`}
                              onClick={() => setSelectedSubfolder(folder)}
                            >
                              <Folder className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{folder}</span>
                              <span className="text-xs text-gray-600 ml-auto shrink-0">{count}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Library Files */}
        <div className="lg:col-span-2">
          {selectedLibrary ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-white">
                    {selectedLibrary.name}
                    {selectedSubfolder && <span className="text-gray-400 font-normal"> / {selectedSubfolder}</span>}
                  </h2>
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

              {displayedFiles.length > 0 ? (
                <Card style={{ backgroundColor: '#252326', border: 'none' }}>
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
                        {displayedFiles.map((file: any) => (
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
                              <StatusBadge status={file.status === 'pending' ? 'pending' : file.status === 'analyzed' ? 'analyzed' : file.status} />
                            </td>
                            <td className="px-4 py-3">
                              {file.status === 'processing' || file.status === 'completed' ? (
                                <div className="flex items-center gap-2">
                                  <div className="w-24 h-2 bg-gray-700 rounded-full overflow-hidden">
                                    <div
                                      className="h-full transition-all"
                                      style={{ width: `${file.progress}%`, backgroundColor: '#74c69d' }}
                                    />
                                  </div>
                                  <span className="text-xs text-gray-400">{file.progress}%</span>
                                </div>
                              ) : (
                                <span className="text-xs text-gray-500">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    setReportFileId(file.id);
                                    setReportFileName(file.filename);
                                    setShowReportDrawer(true);
                                  }}
                                  style={{ borderColor: '#38363a', color: '#9ca3af' }}
                                  className="hover:bg-gray-800"
                                  title="View reports"
                                >
                                  <FileText className="h-4 w-4" />
                                </Button>
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
                                  title="Remove file"
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : (
                <Card style={{ backgroundColor: '#252326', border: 'none' }}>
                  <CardContent className="py-12 text-center">
                    <Film className="mx-auto h-12 w-12 text-gray-600 mb-4" />
                    <p className="text-gray-400">
                      {selectedSubfolder ? 'No files in this folder' : 'No files imported yet'}
                    </p>
                    <p className="text-sm text-gray-500 mt-2">
                      {selectedSubfolder ? 'Try selecting a different folder' : 'Click "Import Files" to scan the library folder'}
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          ) : (
            <Card style={{ backgroundColor: '#252326', border: 'none' }}>
              <CardContent className="py-12 text-center">
                <FolderOpen className="mx-auto h-12 w-12 text-gray-600 mb-4" />
                <p className="text-gray-400">Select a library to view its files</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Report Drawer */}
      <ReportDrawer
        fileId={reportFileId ?? ''}
        fileName={reportFileName}
        open={showReportDrawer && !!reportFileId}
        onClose={() => {
          setReportFileId(null);
          setShowReportDrawer(false);
        }}
      />
    </div>
  );
}
