import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/utils/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { Trash2, Cpu, HardDrive, Monitor, Server } from 'lucide-react';
import { useWebSocket } from '@/hooks/useWebSocket';

export function Nodes() {
  const queryClient = useQueryClient();

  // Connect to WebSocket for real-time updates
  useWebSocket({ channels: ['nodes'] });

  const { data: nodes, isLoading } = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.getNodes(),
    staleTime: Infinity, // Data is fresh, WebSocket will update cache
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteNode(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] });
    },
  });

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-gray-400">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Nodes</h1>
          <p className="text-gray-400">Manage transcoding nodes</p>
        </div>
      </div>

      <div className="space-y-4">
        {nodes?.map((node: any) => (
          <Card key={node.id}>
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-4 mb-4">
                    <div className="flex items-center gap-3">
                      <Server className="h-6 w-6 text-gray-400" />
                      <h3 className="text-xl font-semibold text-white">{node.name}</h3>
                    </div>
                    <StatusBadge status={node.connected ? 'online' : 'offline'} />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    {/* OS */}
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg" style={{ backgroundColor: '#1E1D1F' }}>
                        <HardDrive className="h-5 w-5 text-gray-400" />
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wide">OS</p>
                        <p className="text-sm text-white font-medium">{node.system_info?.os || 'Unknown'}</p>
                        <p className="text-xs text-gray-500">{node.system_info?.os_version || ''}</p>
                      </div>
                    </div>

                    {/* CPU */}
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg" style={{ backgroundColor: '#1E1D1F' }}>
                        <Cpu className="h-5 w-5 text-gray-400" />
                      </div>
                      <div className="flex-1">
                        <p className="text-xs text-gray-500 uppercase tracking-wide">CPU</p>
                        <p className="text-sm text-white font-medium">{node.system_info?.cpu || 'Unknown'}</p>
                        <p className="text-xs text-gray-500">{node.system_info?.cpu_cores || '-'} cores</p>
                        {node.connected && node.cpu_usage !== undefined && (
                          <div className="mt-1 flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                              <div
                                className="h-full transition-all"
                                style={{ width: `${node.cpu_usage || 0}%`, backgroundColor: '#74c69d' }}
                              />
                            </div>
                            <span className="text-xs text-gray-500 w-8 text-right">{node.cpu_usage || 0}%</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* RAM */}
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg" style={{ backgroundColor: '#1E1D1F' }}>
                        <HardDrive className="h-5 w-5 text-gray-400" />
                      </div>
                      <div className="flex-1">
                        <p className="text-xs text-gray-500 uppercase tracking-wide">RAM</p>
                        <p className="text-sm text-white font-medium">
                          {Math.round((node.system_info?.ram_total || 0) / 1024 / 1024 / 1024)} GB
                        </p>
                        {node.connected && node.ram_usage !== undefined && (
                          <>
                            <div className="mt-1 flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                <div
                                  className="h-full transition-all"
                                  style={{ width: `${node.ram_usage || 0}%`, backgroundColor: '#74c69d' }}
                                />
                              </div>
                              <span className="text-xs text-gray-500 w-8 text-right">{node.ram_usage || 0}%</span>
                            </div>
                            {node.system_info?.ram_total && node.ram_usage > 0 && (
                              <div className="text-xs text-gray-500 mt-0.5">
                                {((node.system_info.ram_total * (node.ram_usage / 100)) / (1024 * 1024 * 1024)).toFixed(2)} GB / {(node.system_info.ram_total / (1024 * 1024 * 1024)).toFixed(2)} GB ({node.ram_usage}%)
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {/* GPUs */}
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg" style={{ backgroundColor: '#1E1D1F' }}>
                        <Monitor className="h-5 w-5 text-gray-400" />
                      </div>
                      <div className="flex-1">
                        <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">GPUs</p>
                        {node.system_info?.gpus && node.system_info.gpus.length > 0 ? (
                          <div className="space-y-2">
                            {node.system_info.gpus.map((gpu: any, idx: number) => {
                              // Normalize vendor name for color matching
                              const vendorLower = gpu.vendor?.toLowerCase() || '';
                              const isNvidia = vendorLower.includes('nvidia');
                              const isAMD = vendorLower.includes('amd') || vendorLower.includes('advanced micro') || vendorLower.includes('radeon');
                              const isIntel = vendorLower.includes('intel');
                              const isApple = vendorLower.includes('apple');

                              // Format VRAM
                              const vramGB = gpu.memory ? (gpu.memory / (1024 * 1024 * 1024)).toFixed(0) : null;

                              // GPU utilization - use utilizationGpu directly from systeminformation
                              const gpuUtil = gpu.utilizationGpu !== undefined ? gpu.utilizationGpu : 0;

                              // VRAM info
                              let vramInfo = null;
                              if (gpu.memory && gpu.memoryUsed !== undefined && node.connected) {
                                const usedGB = (gpu.memoryUsed / (1024 * 1024 * 1024)).toFixed(2);
                                const totalGB = (gpu.memory / (1024 * 1024 * 1024)).toFixed(2);
                                const vramPercent = Math.round((gpu.memoryUsed / gpu.memory) * 100);
                                vramInfo = `${usedGB} GB / ${totalGB} GB (${vramPercent}%)`;
                              }

                              return (
                                <div
                                  key={idx}
                                  className="flex items-center gap-2 px-2 py-1 rounded"
                                  style={{ backgroundColor: '#1E1D1F', border: '1px solid #38363a' }}
                                >
                                  <div
                                    className="w-2 h-2 rounded-full"
                                    style={{
                                      backgroundColor:
                                        isNvidia ? '#72B300' :
                                        isAMD ? '#D7002E' :
                                        isIntel ? '#0065AF' :
                                        isApple ? '#999999' :
                                        '#74c69d'
                                    }}
                                  />
                                  <div className="flex flex-col flex-1">
                                    <div className="flex items-center justify-between">
                                      <span className="text-sm text-white font-medium">
                                        {(() => {
                                          // Only add vendor prefix if name doesn't already start with vendor or common abbreviations
                                          const nameLower = gpu.name?.toLowerCase() || '';
                                          const vendorLower = gpu.vendor?.toLowerCase() || '';

                                          // Check if vendor is already in name (including common abbreviations)
                                          const vendorInName =
                                            nameLower.startsWith(vendorLower) ||
                                            (vendorLower.includes('nvidia') && nameLower.startsWith('nvidia')) ||
                                            (vendorLower.includes('amd') || vendorLower.includes('advanced micro')) && nameLower.startsWith('amd') ||
                                            (vendorLower.includes('intel') && nameLower.startsWith('intel')) ||
                                            (vendorLower.includes('apple') && nameLower.startsWith('apple'));

                                          const needsPrefix = vendorLower && !vendorInName;
                                          return `${needsPrefix ? (gpu.vendor || '') + ' ' : ''}${gpu.name || 'Unknown GPU'} (${vramGB}GB)`;
                                        })()}
                                      </span>
                                      {gpu.driver_version && node.connected && (
                                        <span className="text-xs text-gray-500">Driver: {gpu.driver_version}</span>
                                      )}
                                    </div>
                                    {node.connected && (
                                      <div className="mt-1 space-y-1">
                                        {/* GPU Utilization */}
                                        <div className="flex items-center gap-2">
                                          <span className="text-xs text-gray-500 w-16">GPU:</span>
                                          <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                            <div
                                              className="h-full transition-all"
                                              style={{
                                                width: `${gpuUtil}%`,
                                                backgroundColor: isNvidia ? '#72B300' : isAMD ? '#D7002E' : isIntel ? '#0065AF' : '#74c69d'
                                              }}
                                            />
                                          </div>
                                          <span className="text-xs text-gray-500 w-8 text-right">{gpuUtil}%</span>
                                        </div>
                                        {/* VRAM Usage */}
                                        {vramInfo && (
                                          <div className="text-xs text-gray-500">
                                            {vramInfo}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-sm text-gray-500">None detected</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (confirm(`Remove node "${node.name}"?`)) {
                      deleteMutation.mutate(node.id);
                    }
                  }}
                  disabled={deleteMutation.isPending}
                  style={{ borderColor: '#38363a', color: '#74c69d' }}
                  className="hover:bg-gray-800"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}

        {nodes?.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <Server className="mx-auto h-12 w-12 text-gray-600 mb-4" />
              <p className="text-gray-400">No nodes registered yet</p>
              <p className="text-sm text-gray-500 mt-2">
                Add a node using the CLI: <code className="bg-gray-800 px-2 py-1 rounded text-gray-400">encorr-node start</code>
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
