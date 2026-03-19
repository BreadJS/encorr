import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/utils/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Trash2, Plus, FolderTree, Edit2, Check, X, ChevronDown, Server, HardDrive } from 'lucide-react';

// Theme colors
const theme = {
  green: '#74c69d',
  bgPrimary: '#252326',
  bgSecondary: '#1E1D1F',
  bgTertiary: '#38363a',
  border: '#39363a',
};

export function Mappings() {
  const queryClient = useQueryClient();
  const [editingNodePath, setEditingNodePath] = useState<string | null>(null);
  const [editedPath, setEditedPath] = useState('');

  // Add mapping dialog state
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string>('');
  const [selectedNodeId, setSelectedNodeId] = useState<string>('');
  const [nodePath, setNodePath] = useState<string>('');
  const [libraryDropdownOpen, setLibraryDropdownOpen] = useState(false);
  const [nodeDropdownOpen, setNodeDropdownOpen] = useState(false);

  const { data: mappings, isLoading } = useQuery({
    queryKey: ['mappings'],
    queryFn: () => api.getMappings(),
  });

  const { data: libraries } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => api.getLibraries(),
  });

  const { data: nodes } = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.getNodes(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteMapping(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mappings'] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, node_path }: { id: string; node_path: string }) =>
      api.updateMapping(id, { node_path }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mappings'] });
      setEditingNodePath(null);
      setEditedPath('');
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: { node_id: string; server_path: string; node_path: string; watch: boolean }) =>
      api.createMapping(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mappings'] });
      setAddDialogOpen(false);
      // Reset form
      setSelectedLibraryId('');
      setSelectedNodeId('');
      setNodePath('');
    },
  });

  const handleAddMapping = () => {
    if (!selectedLibraryId || !selectedNodeId || !nodePath) {
      return;
    }
    createMutation.mutate({
      node_id: selectedNodeId,
      server_path: `library:${selectedLibraryId}`,
      node_path: nodePath,
      watch: false,
    });
  };

  const openAddDialog = () => {
    setAddDialogOpen(true);
    // Clear previous selections to avoid showing wrong available libraries
    setSelectedLibraryId('');
    setSelectedNodeId('');
    // Auto-select first node if available (this will then filter the libraries)
    if (nodes && nodes.length > 0) {
      setSelectedNodeId(nodes[0].id);
    }
  };

  // Get available libraries (those without mappings for the selected node)
  const availableLibraries = libraries?.filter((lib: any) => {
    // Only filter out libraries that have a mapping for the SELECTED node
    // Libraries with mappings for other nodes should still be shown
    const hasMappingForSelectedNode = mappings?.some((m: any) =>
      m.server_path === `library:${lib.id}` && m.node_id === selectedNodeId
    );
    return !hasMappingForSelectedNode;
  }) || [];

  // Helper to resolve server_path to actual path
  const getServerPathDisplay = (serverPath: string): string => {
    if (serverPath.startsWith('library:')) {
      const libraryId = serverPath.replace('library:', '');
      const library = libraries?.find((lib: any) => lib.id === libraryId);
      if (library) {
        return library.path;
      }
    }
    return serverPath;
  };

  // Helper to get library name for server_path
  const getServerPathLabel = (serverPath: string): string => {
    if (serverPath.startsWith('library:')) {
      const libraryId = serverPath.replace('library:', '');
      const library = libraries?.find((lib: any) => lib.id === libraryId);
      if (library) {
        return library.name;
      }
    }
    return 'Server Path';
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-gray-400">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Folder Mappings</h1>
          <p className="text-sm text-gray-400 mt-1">Map server libraries to node paths</p>
        </div>
        <Button onClick={openAddDialog}>
          <Plus className="mr-2 h-4 w-4" />
          Add Mapping
        </Button>
      </div>

      {/* Mappings Table */}
      <Card style={{ backgroundColor: '#272528', border: 'none' }}>
        <CardContent className="p-0 rounded-lg overflow-hidden">
          {mappings && mappings.length > 0 ? (
            <div className="overflow-hidden" style={{ backgroundColor: '#2f2c30' }}>
              <table className="w-full">
                <thead>
                  <tr className="border-b" style={{ borderColor: '#2a282a', backgroundColor: '#222022' }}>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Node</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Library (Server Path)</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Node Path</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-400" style={{ width: '100px' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((mapping: any) => (
                    <tr key={mapping.id} className="border-t hover:bg-white/5 transition-colors" style={{ borderColor: '#2a282a' }}>
                      {/* Node */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Server className="h-4 w-4 text-gray-400" />
                          <span className="text-sm text-white font-medium">{mapping.node_name}</span>
                        </div>
                      </td>

                      {/* Library/Server Path */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 mb-1">
                          <FolderTree className="h-3.5 w-3.5 text-gray-500" />
                          <span className="text-xs font-medium text-gray-300">{getServerPathLabel(mapping.server_path)}</span>
                        </div>
                        <div className="font-mono text-xs text-gray-400 truncate max-w-md" title={getServerPathDisplay(mapping.server_path)}>
                          {getServerPathDisplay(mapping.server_path)}
                        </div>
                      </td>

                      {/* Node Path */}
                      <td className="px-4 py-3">
                        {editingNodePath === mapping.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={editedPath}
                              onChange={(e) => setEditedPath(e.target.value)}
                              className="font-mono flex-1 px-3 py-1.5 rounded text-white placeholder-gray-500 focus:outline-none text-xs min-w-0"
                              style={{ backgroundColor: '#38363a', border: '1px solid #4a454a' }}
                              autoFocus
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-green-500 hover:bg-green-500/10"
                              onClick={() => updateMutation.mutate({ id: mapping.id, node_path: editedPath })}
                              disabled={updateMutation.isPending}
                            >
                              <Check className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-red-500 hover:bg-red-500/10"
                              onClick={() => {
                                setEditingNodePath(null);
                                setEditedPath('');
                              }}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <HardDrive className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="font-mono text-xs text-gray-300 truncate" title={mapping.node_path}>
                                {mapping.node_path}
                              </div>
                            </div>
                            <button
                              onClick={() => {
                                setEditingNodePath(mapping.id);
                                setEditedPath(mapping.node_path);
                              }}
                              className="flex-shrink-0 text-gray-500 hover:text-gray-300 transition-colors"
                            >
                              <Edit2 className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-gray-400 hover:text-red-400 hover:bg-red-500/10"
                          onClick={() => {
                            if (confirm('Delete this mapping?')) {
                              deleteMutation.mutate(mapping.id);
                            }
                          }}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-16 text-center" style={{ backgroundColor: '#2f2c30' }}>
              <FolderTree className="mx-auto h-12 w-12 mb-4 text-gray-600" />
              <p className="text-gray-400">No folder mappings configured</p>
              <p className="text-sm text-gray-500 mt-2">Add a mapping to connect libraries to nodes</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Mapping Dialog */}
      <Dialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        title="Add Folder Mapping"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setAddDialogOpen(false)}
              disabled={createMutation.isPending}
              style={{ backgroundColor: '#38363a', color: '#ffffff' }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddMapping}
              disabled={!selectedLibraryId || !selectedNodeId || !nodePath || createMutation.isPending}
            >
              {createMutation.isPending ? 'Adding...' : 'Add Mapping'}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          {/* Library Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              <div className="flex items-center gap-2">
                <FolderTree className="h-4 w-4 text-gray-400" />
                Library (Server Path)
              </div>
            </label>
            <div className="relative">
              <button
                onClick={() => {
                  setLibraryDropdownOpen(!libraryDropdownOpen);
                  setNodeDropdownOpen(false);
                }}
                className="w-full text-left px-4 py-2.5 rounded-lg border transition-all flex items-center justify-between"
                style={{
                  backgroundColor: theme.bgSecondary,
                  borderColor: libraryDropdownOpen ? theme.green : theme.border,
                }}
              >
                <span className={selectedLibraryId ? 'text-white' : 'text-gray-400'}>
                  {selectedLibraryId && availableLibraries
                    ? availableLibraries.find((lib: any) => lib.id === selectedLibraryId)?.name || 'Select Library'
                    : 'Select Library'}
                </span>
                <ChevronDown className={`h-4 w-4 flex-shrink-0 ml-2 transition-transform ${
                  libraryDropdownOpen ? 'rotate-180' : ''
                }`} />
              </button>
              {libraryDropdownOpen && (
                <div className="absolute left-0 right-0 top-full mt-1 rounded-md overflow-hidden z-50" style={{ backgroundColor: theme.bgSecondary, border: `1px solid ${theme.border}` }}>
                  {availableLibraries.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-gray-500">
                      No available libraries
                    </div>
                  ) : (
                    availableLibraries.map((library: any) => (
                      <button
                        key={library.id}
                        onClick={() => {
                          setSelectedLibraryId(library.id);
                          setLibraryDropdownOpen(false);
                        }}
                        className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                          selectedLibraryId === library.id ? 'text-white' : 'text-gray-300 hover:bg-white/5'
                        }`}
                        style={{
                          backgroundColor: selectedLibraryId === library.id ? `${theme.green}30` : 'transparent',
                        }}
                      >
                        <div className="font-medium">{library.name}</div>
                        <div className="text-xs text-gray-400 truncate">{library.path}</div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Node Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-gray-400" />
                Node
              </div>
            </label>
            <div className="relative">
              <button
                onClick={() => {
                  setNodeDropdownOpen(!nodeDropdownOpen);
                  setLibraryDropdownOpen(false);
                }}
                className="w-full text-left px-4 py-2.5 rounded-lg border transition-all flex items-center justify-between"
                style={{
                  backgroundColor: theme.bgSecondary,
                  borderColor: nodeDropdownOpen ? theme.green : theme.border,
                }}
              >
                <span className={selectedNodeId ? 'text-white' : 'text-gray-400'}>
                  {selectedNodeId && nodes
                    ? nodes.find((node: any) => node.id === selectedNodeId)?.name || 'Select Node'
                    : 'Select Node'}
                </span>
                <ChevronDown className={`h-4 w-4 flex-shrink-0 ml-2 transition-transform ${
                  nodeDropdownOpen ? 'rotate-180' : ''
                }`} />
              </button>
              {nodeDropdownOpen && (
                <div className="absolute left-0 right-0 top-full mt-1 rounded-md overflow-hidden z-50" style={{ backgroundColor: theme.bgSecondary, border: `1px solid ${theme.border}` }}>
                  {nodes?.map((node: any) => (
                    <button
                      key={node.id}
                      onClick={() => {
                        setSelectedNodeId(node.id);
                        // Clear library selection if it already has a mapping for this node
                        if (selectedLibraryId && mappings?.some((m: any) =>
                          m.server_path === `library:${selectedLibraryId}` && m.node_id === node.id
                        )) {
                          setSelectedLibraryId('');
                        }
                        setNodeDropdownOpen(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                        selectedNodeId === node.id ? 'text-white' : 'text-gray-300 hover:bg-white/5'
                      }`}
                      style={{
                        backgroundColor: selectedNodeId === node.id ? `${theme.green}30` : 'transparent',
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${
                          node.status === 'online' ? 'bg-green-500' :
                          node.status === 'offline' ? 'bg-gray-500' :
                          node.status === 'busy' ? 'bg-yellow-500' : 'bg-red-500'
                        }`} />
                        <span className="font-medium">{node.name}</span>
                      </div>
                      <div className="text-xs text-gray-400 ml-4">
                        {node.system_info?.cpu} • {node.system_info?.gpus?.length || 0} GPU(s)
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Node Path */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-gray-400" />
                Node Path (Prefix)
              </div>
            </label>
            <input
              type="text"
              value={nodePath}
              onChange={(e) => setNodePath(e.target.value)}
              placeholder="e.g., C:/Users/cuper/OneDrive/Bureaublad/Season 1"
              className="w-full px-4 py-2.5 rounded-lg text-white placeholder-gray-500 focus:outline-none transition-colors font-mono text-sm"
              style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
            />
            <p className="text-xs text-gray-500 mt-1.5">
              This path will be used as the prefix when accessing files from this node.
            </p>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
