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

  const onlineNodes = nodes?.filter((n: any) => n.connected) ?? [];
  const offlineNodes = nodes?.filter((n: any) => !n.connected) ?? [];

  const renderNode = (node: any) => {
    const getGpuColor = (vendor: string) => {
      const v = vendor?.toLowerCase() || '';
      if (v.includes('nvidia')) return '#72B300';
      if (v.includes('amd') || v.includes('advanced micro') || v.includes('radeon')) return '#D7002E';
      if (v.includes('intel')) return '#0065AF';
      if (v.includes('apple')) return '#999999';
      return '#74c69d';
    };

    // Clean GPU name: extract bracket content like "[GeForce GTX 1080]" from
    // "NVIDIA Corporation GP104 [GeForce GTX 1080]", otherwise strip known vendor prefixes
    const cleanGpuName = (name: string) => {
      if (!name) return 'Unknown GPU';
      const bracketMatch = name.match(/\[([^\]]+)\]/);
      if (bracketMatch) return bracketMatch[1];
      return name
        .replace(/^(NVIDIA Corporation|NVIDIA|Advanced Micro Devices, Inc\.|AMD|Intel Corporation|Intel|Apple)\s*/i, '');
    };

    return (
      <Card key={node.id}>
        <CardContent className="px-4 py-3">
          <div className="flex items-center gap-4">
            {/* Node name + status */}
            <div className="flex items-center gap-2 w-[200px] shrink-0">
              <Server className="h-4 w-4 text-gray-400 shrink-0" />
              <span className="text-sm font-semibold text-white truncate">{node.name}</span>
              <StatusBadge status={node.connected ? 'online' : 'offline'} />
            </div>

            {/* OS */}
            <div className="flex items-center gap-1.5 w-[130px] shrink-0">
              <HardDrive className="h-3.5 w-3.5 text-gray-500 shrink-0" />
              <span className="text-xs text-gray-400 truncate">
                {node.system_info?.os || 'Unknown'} {node.system_info?.os_version || ''}
              </span>
            </div>

            {/* CPU + usage */}
            <div className="flex items-center gap-1.5 w-[240px] shrink-0">
              <Cpu className="h-3.5 w-3.5 text-gray-500 shrink-0" />
              <span className="text-xs text-gray-400 truncate">{node.system_info?.cpu || 'Unknown'}</span>
              <span className="text-xs text-gray-600 shrink-0">({node.system_info?.cpu_cores || '-'}c)</span>
              {node.connected && node.cpu_usage !== undefined && (
                <div className="flex items-center gap-1 shrink-0">
                  <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div className="h-full transition-all" style={{ width: `${node.cpu_usage || 0}%`, backgroundColor: '#74c69d' }} />
                  </div>
                  <span className="text-xs text-gray-500 w-7 text-right">{node.cpu_usage || 0}%</span>
                </div>
              )}
            </div>

            {/* RAM + usage */}
            <div className="flex items-center gap-1.5 w-[150px] shrink-0">
              <HardDrive className="h-3.5 w-3.5 text-gray-500 shrink-0" />
              <span className="text-xs text-gray-400 shrink-0">
                {Math.round((node.system_info?.ram_total || 0) / 1024 / 1024 / 1024)} GB
              </span>
              {node.connected && node.ram_usage !== undefined && (
                <div className="flex items-center gap-1 shrink-0">
                  <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div className="h-full transition-all" style={{ width: `${node.ram_usage || 0}%`, backgroundColor: '#74c69d' }} />
                  </div>
                  <span className="text-xs text-gray-500 w-7 text-right">{node.ram_usage || 0}%</span>
                </div>
              )}
            </div>

            {/* GPUs */}
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <Monitor className="h-3.5 w-3.5 text-gray-500 shrink-0" />
              {node.system_info?.gpus && node.system_info.gpus.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 min-w-0">
                  {node.system_info.gpus.map((gpu: any, idx: number) => {
                    const vramGB = gpu.memory ? (gpu.memory / (1024 * 1024 * 1024)).toFixed(0) : null;
                    const gpuUtil = gpu.utilizationGpu !== undefined ? gpu.utilizationGpu : 0;
                    const gpuColor = getGpuColor(gpu.vendor);

                    return (
                      <div
                        key={idx}
                        className="flex items-center gap-1.5 px-2 py-0.5 rounded"
                        style={{ backgroundColor: '#1E1D1F', border: '1px solid #38363a' }}
                      >
                        <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: gpuColor }} />
                        <span className="text-xs text-white truncate">
                          {cleanGpuName(gpu.name)}{vramGB ? ` (${vramGB}GB)` : ''}
                        </span>
                        {node.connected && (
                          <div className="flex items-center gap-1 shrink-0">
                            <div className="w-10 h-1 bg-gray-700 rounded-full overflow-hidden">
                              <div className="h-full transition-all" style={{ width: `${gpuUtil}%`, backgroundColor: gpuColor }} />
                            </div>
                            <span className="text-xs text-gray-500 w-7 text-right">{gpuUtil}%</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <span className="text-xs text-gray-600">No GPUs</span>
              )}
            </div>

            {/* Delete */}
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
              className="hover:bg-gray-800 shrink-0"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Nodes</h1>
          <p className="text-gray-400">Manage transcoding nodes</p>
        </div>
      </div>

      {/* Online Nodes */}
      {onlineNodes.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-2">
            Online ({onlineNodes.length})
          </h2>
          <div className="space-y-2">{onlineNodes.map(renderNode)}</div>
        </div>
      )}

      {/* Offline Nodes */}
      {offlineNodes.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
            Offline ({offlineNodes.length})
          </h2>
          <div className="space-y-2 opacity-60">{offlineNodes.map(renderNode)}</div>
        </div>
      )}

      {/* Empty State */}
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
  );
}
