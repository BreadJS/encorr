import { api } from '@/utils/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { Dialog } from '@/components/ui/Dialog';
import { RefreshCw, Cpu, HardDrive, Zap, Pause, Play, Trash2, ChevronLeft, ChevronRight, X, Settings, Plus, Minus, AlertTriangle, Scan, Film } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, Fragment as ReactFragment } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';

export function Jobs() {
  const queryClient = useQueryClient();

  // Tab state
  const [activeTab, setActiveTab] = useState<'queue' | 'failed' | 'success'>('queue');
  const [isQueuePaused, setIsQueuePaused] = useState(false);

  // Queue pagination state
  const [queuePage, setQueuePage] = useState(1);
  const queuePerPage = 20;

  // Failed pagination state
  const [failedPage, setFailedPage] = useState(1);
  const failedPerPage = 20;

  // Success pagination state
  const [successPage, setSuccessPage] = useState(1);
  const successPerPage = 20;

  // Node settings state
  const [expandedNodeSettings, setExpandedNodeSettings] = useState<string | null>(null);
  const [nodeWorkers, setNodeWorkers] = useState<Record<string, { cpu: number; gpus: number[] }>>({});
  const [pausedNodes, setPausedNodes] = useState<Set<string>>(new Set());
  const [showClearDialog, setShowClearDialog] = useState(false);

  // Connect to WebSocket for real-time updates
  useWebSocket({
    channels: ['nodes', 'jobs'],
  });

  // Fetch nodes from API (real-time updates via WebSocket)
  const { data: nodes = [], refetch: refetchNodes } = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.getNodes(),
    staleTime: Infinity, // Data is fresh, WebSocket will update cache
  });

  // Fetch jobs from API (real-time updates via WebSocket)
  const { data: allJobs = [], isLoading: jobsLoading, refetch: refetchJobs } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.getJobs(),
    staleTime: Infinity, // Data is fresh, WebSocket will update cache
  });

  // Fetch worker availability
  const { data: workerAvailability } = useQuery({
    queryKey: ['worker-availability'],
    queryFn: () => api.getWorkerAvailability(),
    staleTime: 5000, // Refresh every 5 seconds
  });

  // Filter online nodes only (by status or connected flag)
  const onlineNodes = useMemo(() => {
    return nodes.filter((node: any) => node.status === 'online' || node.connected === true);
  }, [nodes]);

  // Categorize jobs by status
  const { queue, failed, success } = useMemo(() => {
    // Queue only shows jobs waiting to be picked up (not assigned/processing)
    const queue = allJobs.filter((j: any) => j.status === 'queued');
    const failed = allJobs.filter((j: any) => j.status === 'failed');
    const success = allJobs.filter((j: any) => j.status === 'completed');
    return { queue, failed, success };
  }, [allJobs]);

  // Get current tab data
  const getCurrentData = () => {
    switch (activeTab) {
      case 'queue':
        return { items: queue, perPage: queuePerPage, page: queuePage };
      case 'failed':
        return { items: failed, perPage: failedPerPage, page: failedPage };
      case 'success':
        return { items: success, perPage: successPerPage, page: successPage };
    }
  };

  const currentData = getCurrentData();

  // Calculate pagination
  const totalItems = currentData.items.length;
  const totalPages = Math.ceil(totalItems / currentData.perPage);
  const startIndex = (currentData.page - 1) * currentData.perPage;
  const endIndex = startIndex + currentData.perPage;
  const displayedItems = currentData.items.slice(startIndex, endIndex);

  // Queue page change
  const handleQueuePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setQueuePage(newPage);
    }
  };

  // Failed page change
  const handleFailedPageChange = (newPage: number) => {
    const failedPages = Math.ceil(failed.length / failedPerPage);
    if (newPage >= 1 && newPage <= failedPages) {
      setFailedPage(newPage);
    }
  };

  // Success page change
  const handleSuccessPageChange = (newPage: number) => {
    const successPages = Math.ceil(success.length / successPerPage);
    if (newPage >= 1 && newPage <= successPages) {
      setSuccessPage(newPage);
    }
  };

  // Delete job mutation
  const deleteJobMutation = useMutation({
    mutationFn: (jobId: string) => api.deleteJob(jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['nodes'] });
    },
  });

  // Update node workers mutation
  const updateNodeMutation = useMutation({
    mutationFn: ({ nodeId, maxWorkers }: { nodeId: string; maxWorkers: { cpu: number; gpus: number[] } }) =>
      api.updateNode(nodeId, { max_workers: maxWorkers }),
    onSuccess: (data) => {
      console.log('Node update successful, received:', data);
      queryClient.invalidateQueries({ queryKey: ['nodes'] });
    },
    onError: (error) => {
      console.error('Failed to update node workers:', error);
      alert('Failed to update worker settings. Please try again.');
    },
  });

  // Save workers for a node instantly
  const saveNodeWorkers = (nodeId: string, cpu: number, gpus: number[]) => {
    console.log('Saving node workers:', { nodeId, cpu, gpus, maxWorkers: { cpu, gpus } });

    // Update local state immediately
    setNodeWorkers(prev => ({
      ...prev,
      [nodeId]: { cpu, gpus }
    }));

    updateNodeMutation.mutate({ nodeId, maxWorkers: { cpu, gpus } });
  };

  // Clear queue mutation
  const handleClearQueue = () => {
    setShowClearDialog(true);
  };

  const confirmClearQueue = () => {
    setShowClearDialog(false);
    // Delete all queued/assigned jobs
    const queuedJobs = allJobs.filter((j: any) => j.status === 'queued' || j.status === 'assigned');
    queuedJobs.forEach((job: any) => {
      deleteJobMutation.mutate(job.id);
    });
  };

  // Clear failed mutation
  const handleClearFailed = () => {
    const failedJobs = allJobs.filter((j: any) => j.status === 'failed');
    failedJobs.forEach((job: any) => {
      deleteJobMutation.mutate(job.id);
    });
  };

  // Clear success mutation
  const handleClearSuccess = () => {
    const successJobs = allJobs.filter((j: any) => j.status === 'completed');
    successJobs.forEach((job: any) => {
      deleteJobMutation.mutate(job.id);
    });
  };

  // Helper function to get vendor color
  const getVendorColor = (type: 'cpu' | 'gpu', cpuName?: string, gpuVendor?: string) => {
    if (type === 'cpu') {
      if (cpuName?.toLowerCase().includes('intel')) return '#0071C5'; // Intel blue
      if (cpuName?.toLowerCase().includes('amd') || cpuName?.toLowerCase().includes('ryzen')) return '#ED1C24'; // AMD red
      return '#74c69d'; // Default green
    } else {
      if (gpuVendor?.toLowerCase().includes('nvidia')) return '#76b900'; // NVIDIA green
      if (gpuVendor?.toLowerCase().includes('amd') || gpuVendor?.toLowerCase().includes('radeon')) return '#ED1C24'; // AMD red
      if (gpuVendor?.toLowerCase().includes('intel')) return '#0071C5'; // Intel blue
      return '#9C27B0'; // Default purple
    }
  };

  // Get job type info
  const getJobTypeInfo = (job: any) => {
    let type = 'transcode';
    if (job.type === 'analyze' || job.type === 'transcode') {
      type = job.type;
    } else if (job.preset_id?.includes('analyze') || job.preset_name?.toLowerCase().includes('analyze')) {
      type = 'analyze';
    }
    const isAnalyze = type === 'analyze';

    return {
      type,
      isAnalyze,
      icon: isAnalyze ? 'Scan' : 'Film',
      color: isAnalyze ? '#f59e0b' : '#74c69d',
      label: isAnalyze ? 'Analyze' : 'Transcode'
    };
  };

  return (
    <div className="space-y-6">
      {/* Warning banners for worker availability */}
      {workerAvailability && queue.length > 0 && (
        <>
          {/* Check for analyze jobs that need CPU workers */}
          {!workerAvailability.hasCpuWorkers && queue.some((job: any) => job.preset_id === 'builtin-analyze') && (
            <div className="bg-amber-900/30 border border-amber-600/50 rounded-lg p-4 flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0" />
              <div>
                <p className="text-amber-200 font-medium">No CPU Workers Available</p>
                <p className="text-amber-300/80 text-sm">
                  Analyze jobs require CPU processing but no nodes are available.
                  Make sure your nodes are online.
                </p>
              </div>
            </div>
          )}
          {/* Check for transcode jobs with no workers at all */}
          {!workerAvailability.hasCpuWorkers && !workerAvailability.hasGpuWorkers && queue.some((job: any) => job.preset_id !== 'builtin-analyze') && (
            <div className="bg-amber-900/30 border border-amber-600/50 rounded-lg p-4 flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0" />
              <div>
                <p className="text-amber-200 font-medium">No Workers Available</p>
                <p className="text-amber-300/80 text-sm">
                  There are queued jobs but no nodes are online to process them.
                  Make sure your nodes are running and connected.
                </p>
              </div>
            </div>
          )}
        </>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Jobs</h1>
          <p className="text-gray-400">Active transcoding jobs by node</p>
        </div>
        <Button
          onClick={() => {
            refetchNodes();
            refetchJobs();
          }}
          disabled={jobsLoading}
          style={{ borderColor: '#39363a', color: '#ffffff' }}
          className="border"
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${jobsLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Queue/Failed/Success Section */}
      <Card style={{ backgroundColor: '#272528', border: 'none' }}>
        <CardContent className="p-0 rounded-lg overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-[#39363a]" style={{ backgroundColor: '#242325', borderTopLeftRadius: '0.5rem', borderTopRightRadius: '0.5rem' }}>
            <button
              onClick={() => setActiveTab('queue')}
              className={`px-6 py-3 text-sm font-medium transition-colors relative ${
                activeTab === 'queue' ? 'text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              Queue ({queue.length})
              {activeTab === 'queue' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ backgroundColor: '#f59e0b' }} />
              )}
            </button>
            <button
              onClick={() => setActiveTab('failed')}
              className={`px-6 py-3 text-sm font-medium transition-colors relative ${
                activeTab === 'failed' ? 'text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              Failed ({failed.length})
              {activeTab === 'failed' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ backgroundColor: '#ef4444' }} />
              )}
            </button>
            <button
              onClick={() => setActiveTab('success')}
              className={`px-6 py-3 text-sm font-medium transition-colors relative ${
                activeTab === 'success' ? 'text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              Success ({success.length})
              {activeTab === 'success' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ backgroundColor: '#74c69d' }} />
              )}
            </button>

            {/* Tab controls */}
            <div className="ml-auto flex items-center gap-2 pr-4">
              {activeTab === 'queue' && (
                <>
                  <Button
                    onClick={() => setIsQueuePaused(!isQueuePaused)}
                    size="sm"
                    style={{
                      borderColor: isQueuePaused ? '#f59e0b' : '#38363a',
                      color: '#ffffff',
                      backgroundColor: isQueuePaused ? 'rgba(245, 158, 11, 0.2)' : 'transparent'
                    }}
                    className="border hover:bg-gray-800"
                  >
                    {isQueuePaused ? <Play className="mr-2 h-4 w-4" /> : <Pause className="mr-2 h-4 w-4" />}
                    {isQueuePaused ? 'Resume Queue' : 'Pause Queue'}
                  </Button>
                  <Button
                    onClick={handleClearQueue}
                    size="sm"
                    style={{ backgroundColor: '#ef4444', color: '#ffffff' }}
                    className="hover:bg-red-600"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Clear ({queue.length})
                  </Button>
                </>
              )}
              {activeTab === 'failed' && (
                <Button
                  onClick={handleClearFailed}
                  size="sm"
                  style={{ backgroundColor: '#ef4444', color: '#ffffff' }}
                  className="hover:bg-red-600"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Clear ({failed.length})
                </Button>
              )}
              {activeTab === 'success' && (
                <Button
                  onClick={handleClearSuccess}
                  size="sm"
                  style={{ backgroundColor: '#ef4444', color: '#ffffff' }}
                  className="hover:bg-red-600"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Clear ({success.length})
                </Button>
              )}
            </div>
          </div>

          {/* Jobs Table */}
          <div className="max-h-[500px] overflow-y-auto overflow-hidden">
            {displayedItems.length === 0 ? (
              <div className="py-16 text-center">
                <div className="text-gray-500">
                  {activeTab === 'queue' && (isQueuePaused ? 'Queue is paused' : 'Queue is empty')}
                  {activeTab === 'failed' && 'No failed jobs'}
                  {activeTab === 'success' && 'No completed jobs yet'}
                </div>
              </div>
            ) : (
              <table className="w-full">
                <thead className="sticky top-0 text-left text-xs text-gray-400 uppercase" style={{ backgroundColor: '#302d31', borderTopLeftRadius: '0.5rem', borderTopRightRadius: '0.5rem' }}>
                  <tr>
                    <th className="px-4 py-3 font-medium" style={{ width: '80px' }}>Type</th>
                    <th className="px-4 py-3 font-medium">File Name</th>
                    {activeTab !== 'queue' && (
                      <th className="px-4 py-3 font-medium" style={{ width: '100px' }}>Node</th>
                    )}
                    <th className="px-4 py-3 font-medium" style={{ width: '80px' }}>Progress</th>
                    <th className="px-4 py-3 font-medium" style={{ width: '120px' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedItems.map((job: any) => {
                    const jobType = getJobTypeInfo(job);
                    const node = onlineNodes.find((n: any) => n.id === job.node_id);
                    const nodeName = node?.name || (job.node_name || 'Unknown');
                    const progress = job.progress || 0;

                    return (
                      <tr
                        key={job.id}
                        className="border-t border-[#39363a] hover:bg-white/5 transition-colors"
                      >
                        {/* Type */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {jobType.icon === 'Scan' ? (
                              <Scan className="h-4 w-4" style={{ color: jobType.color }} />
                            ) : (
                              <Film className="h-4 w-4" style={{ color: jobType.color }} />
                            )}
                            <span className="text-xs font-medium" style={{ color: jobType.color }}>
                              {jobType.label}
                            </span>
                          </div>
                        </td>

                        {/* File Name */}
                        <td className="px-4 py-3">
                          <div className="text-white text-sm truncate" title={job.file_name || job.name}>
                            {job.file_name || job.name}
                          </div>
                          {/* Show codec conversion info for transcode jobs */}
                          {job.target_codec && (
                            <div className="text-xs text-gray-500">
                              {job.original_codec?.toUpperCase()} → {job.target_codec.toUpperCase()}
                            </div>
                          )}
                          {/* Show codec and resolution for analyze jobs or when available */}
                          {!job.target_codec && (job.original_codec || job.resolution) && (
                            <div className="text-xs text-gray-500">
                              {job.original_codec?.toUpperCase() || '---'}
                              {job.resolution && ` • ${job.resolution}`}
                            </div>
                          )}
                        </td>

                        {/* Node - only show for non-queue tabs */}
                        {activeTab !== 'queue' && (
                          <td className="px-4 py-3">
                            <span className="text-sm text-gray-300">
                              {nodeName}
                            </span>
                          </td>
                        )}

                        {/* Progress */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-2 bg-gray-700 rounded-full overflow-hidden">
                              <div
                                className="h-full transition-all"
                                style={{ width: `${progress}%`, backgroundColor: '#74c69d' }}
                              />
                            </div>
                            <span className="text-xs text-gray-400">{progress.toFixed(1)}%</span>
                          </div>
                        </td>

                        {/* Action */}
                        <td className="px-4 py-3">
                          {(activeTab === 'queue' || activeTab === 'failed') && (
                            <button
                              onClick={() => deleteJobMutation.mutate(job.id)}
                              className="h-8 w-8 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-95"
                              style={{ backgroundColor: '#ef4444', color: '#ffffff' }}
                              title="Remove job"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between p-3 border-t border-[#39363a]">
              <div className="text-sm text-gray-400">
                Showing {totalItems > 0 ? startIndex + 1 : 0} to {Math.min(endIndex, totalItems)} of {totalItems} jobs
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  onClick={() => {
                    if (activeTab === 'queue') handleQueuePageChange(1);
                    else if (activeTab === 'failed') handleFailedPageChange(1);
                    else handleSuccessPageChange(1);
                  }}
                  disabled={currentData.page === 1}
                  style={{ borderColor: '#39363a', color: '#ffffff' }}
                  className="border hover:bg-gray-800"
                >
                  First
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    if (activeTab === 'queue') handleQueuePageChange(Math.max(1, currentData.page - 1));
                    else if (activeTab === 'failed') handleFailedPageChange(Math.max(1, currentData.page - 1));
                    else handleSuccessPageChange(Math.max(1, currentData.page - 1));
                  }}
                  disabled={currentData.page === 1}
                  style={{ borderColor: '#39363a', color: '#ffffff' }}
                  className="border hover:bg-gray-800"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="px-3 text-sm text-gray-400">
                  Page {currentData.page} of {totalPages}
                </span>
                <Button
                  size="sm"
                  onClick={() => {
                    if (activeTab === 'queue') handleQueuePageChange(Math.min(totalPages, currentData.page + 1));
                    else if (activeTab === 'failed') handleFailedPageChange(Math.min(totalPages, currentData.page + 1));
                    else handleSuccessPageChange(Math.min(totalPages, currentData.page + 1));
                  }}
                  disabled={currentData.page === totalPages}
                  style={{ borderColor: '#39363a', color: '#ffffff' }}
                  className="border hover:bg-gray-800"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    if (activeTab === 'queue') handleQueuePageChange(totalPages);
                    else if (activeTab === 'failed') handleFailedPageChange(totalPages);
                    else handleSuccessPageChange(totalPages);
                  }}
                  disabled={currentData.page === totalPages}
                  style={{ borderColor: '#39363a', color: '#ffffff' }}
                  className="border hover:bg-gray-800"
                >
                  Last
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section Divider */}
      <div className="flex items-center gap-4">
        <div className="flex-1 h-px" style={{ backgroundColor: '#39363a' }}></div>
        <h2 className="text-lg font-semibold text-gray-400">Active Nodes ({onlineNodes.length})</h2>
        <div className="flex-1 h-px" style={{ backgroundColor: '#39363a' }}></div>
      </div>

      {/* Nodes and Jobs */}
      <div className="space-y-6">
        {onlineNodes.length === 0 ? (
          <Card style={{ backgroundColor: '#252326', border: '1px solid #39363a' }}>
            <CardContent className="p-8 text-center">
              <div className="text-gray-500">No online nodes</div>
              <div className="text-xs text-gray-600 mt-1">Add nodes to get started</div>
            </CardContent>
          </Card>
        ) : (
          onlineNodes.map((node: any) => (
            <Card key={node.id} style={{ border: 'none' }}>
              <CardContent className="p-0 rounded-lg overflow-hidden">
                {/* Node Header */}
                <div className="border-b border-[#39363a]" style={{ backgroundColor: '#252326', borderTopLeftRadius: '0.5rem', borderTopRightRadius: '0.5rem' }}>
                  {/* Settings Panel (Expandable) */}
                  <div
                    className={`transition-all duration-300 ease-in-out ${
                      expandedNodeSettings === node.id ? 'max-h-[800px] overflow-visible' : 'max-h-0 overflow-hidden'
                    }`}
                  >
                    <div className="p-4">
                      {/* Device Settings - Simple List */}
                      <div className="flex flex-wrap gap-y-4">
                        {/* CPU Device */}
                        <div className="flex items-center gap-3 pr-8">
                          <div className="flex items-center gap-2 w-32 flex-shrink-0">
                            <Cpu className="h-4 w-4" style={{ color: getVendorColor('cpu', node.system_info?.cpu) }} />
                            <div>
                              <div className="text-sm font-medium text-white">CPU</div>
                              <div className="text-xs text-gray-500">{node.system_info?.cpu_cores || '—'} cores</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => {
                                const currentValue = nodeWorkers[node.id]?.cpu ?? node.max_workers?.cpu ?? 1;
                                if (currentValue > 0) {
                                  const newValue = currentValue - 1;
                                  saveNodeWorkers(node.id, newValue, nodeWorkers[node.id]?.gpus || []);
                                }
                              }}
                              disabled={(nodeWorkers[node.id]?.cpu ?? node.max_workers?.cpu ?? 1) <= 0}
                              className="h-6 w-6 rounded-full flex items-center justify-center transition-all disabled:cursor-not-allowed"
                              style={{
                                backgroundColor: (nodeWorkers[node.id]?.cpu ?? node.max_workers?.cpu ?? 1) <= 0 ? '#38363a' : '#4a454a',
                              }}
                            >
                              <Minus className="h-2.5 w-2.5" />
                            </button>
                            <div className="w-12 text-center">
                              <span className="text-lg font-bold text-white">{nodeWorkers[node.id]?.cpu ?? node.max_workers?.cpu ?? 1}</span>
                            </div>
                            <button
                              onClick={() => {
                                const currentValue = nodeWorkers[node.id]?.cpu ?? node.max_workers?.cpu ?? 1;
                                const maxCpu = node.system_info?.cpu_cores || 1;
                                if (currentValue < maxCpu) {
                                  const newValue = currentValue + 1;
                                  saveNodeWorkers(node.id, newValue, nodeWorkers[node.id]?.gpus || []);
                                }
                              }}
                              disabled={(nodeWorkers[node.id]?.cpu ?? node.max_workers?.cpu ?? 1) >= (node.system_info?.cpu_cores || 1)}
                              className="h-6 w-6 rounded-full flex items-center justify-center transition-all disabled:cursor-not-allowed"
                              style={{
                                backgroundColor: (nodeWorkers[node.id]?.cpu ?? node.max_workers?.cpu ?? 1) >= (node.system_info?.cpu_cores || 1) ? '#38363a' : getVendorColor('cpu', node.system_info?.cpu),
                              }}
                            >
                              <Plus className="h-2.5 w-2.5" />
                            </button>
                          </div>
                        </div>

                        {/* Divider + GPU Devices */}
                        {node.system_info?.gpus && node.system_info.gpus.length > 0 && node.system_info.gpus.map((gpu: any, index: number) => {
                          const isLast = index === node.system_info.gpus.length - 1;
                          return (
                            <ReactFragment key={`gpu-${index}`}>
                              {/* Separator before GPU (not after last) */}
                              {!isLast && <div className="hidden sm:block w-px bg-[#39363a] mr-8" />}
                              <div className={`flex items-center gap-3 ${!isLast ? 'pr-8' : ''}`}>
                                <div className="flex items-center gap-2 w-32 flex-shrink-0">
                                <Zap className="h-4 w-4" style={{ color: getVendorColor('gpu', undefined, gpu.vendor) }} />
                                <div>
                                  <div className="text-sm font-medium text-white">GPU {index + 1}</div>
                                  <div className="text-xs text-gray-500 truncate max-w-28" title={gpu.name}>{gpu.name}</div>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => {
                                    const currentGpus = nodeWorkers[node.id]?.gpus || [];
                                    const currentValue = currentGpus[index] || 0;
                                    if (currentValue > 0) {
                                      const newGpus = [...currentGpus];
                                      newGpus[index] = currentValue - 1;
                                      saveNodeWorkers(node.id, nodeWorkers[node.id]?.cpu ?? 1, newGpus);
                                    }
                                  }}
                                  disabled={(nodeWorkers[node.id]?.gpus?.[index] || 0) <= 0}
                                  className="h-6 w-6 rounded-full flex items-center justify-center transition-all disabled:cursor-not-allowed"
                                  style={{
                                    backgroundColor: (nodeWorkers[node.id]?.gpus?.[index] || 0) <= 0 ? '#38363a' : '#4a454a',
                                  }}
                                >
                                  <Minus className="h-2.5 w-2.5" />
                                </button>
                                <div className="w-12 text-center">
                                  <span className="text-lg font-bold text-white">{nodeWorkers[node.id]?.gpus?.[index] || 0}</span>
                                </div>
                                <button
                                  onClick={() => {
                                    const currentGpus = nodeWorkers[node.id]?.gpus || [];
                                    const currentValue = currentGpus[index] || 0;
                                    const newGpus = [...currentGpus];
                                    newGpus[index] = currentValue + 1;
                                    saveNodeWorkers(node.id, nodeWorkers[node.id]?.cpu ?? 1, newGpus);
                                  }}
                                  className="h-6 w-6 rounded-full flex items-center justify-center transition-all"
                                  style={{ backgroundColor: getVendorColor('gpu', undefined, gpu.vendor) }}
                                >
                                  <Plus className="h-2.5 w-2.5" />
                                </button>
                              </div>
                            </div>
                            </ReactFragment>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Node Name Bar */}
                  <div className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                          <button
                            onClick={() => {
                              if (expandedNodeSettings === node.id) {
                                setExpandedNodeSettings(null);
                              } else {
                                setExpandedNodeSettings(node.id);
                                // Initialize workers if not set
                                if (!nodeWorkers[node.id]) {
                                  // Handle both old format (gpu: number) and new format (gpus: number[])
                                  const savedGpus = node.max_workers?.gpus;
                                  const gpuCount = node.system_info?.gpus?.length || 0;
                                  let gpuValues: number[] = [];
                                  if (savedGpus && Array.isArray(savedGpus)) {
                                    // New format: use saved gpus array directly
                                    gpuValues = savedGpus;
                                  } else if (node.max_workers?.gpu !== undefined) {
                                    // Old format: single gpu number, apply to all GPUs
                                    gpuValues = Array(gpuCount).fill(node.max_workers.gpu);
                                  }

                                  setNodeWorkers(prev => ({
                                    ...prev,
                                    [node.id]: {
                                      cpu: node.max_workers?.cpu !== undefined ? node.max_workers.cpu : 1,
                                      gpus: gpuValues
                                    }
                                  }));
                                }
                              }
                            }}
                            className={`h-7 w-7 rounded-full flex items-center justify-center transition-all duration-300 ${
                              expandedNodeSettings === node.id
                                ? 'bg-[#74c69d] text-white rotate-90'
                                : 'text-gray-400 hover:text-white hover:bg-white/10'
                            }`}
                            title="Toggle Settings"
                          >
                            <Settings className="h-4 w-4" />
                          </button>
                          {node.name}
                          <button
                            onClick={() => {
                              setPausedNodes(prev => {
                                const next = new Set(prev);
                                if (next.has(node.id)) {
                                  next.delete(node.id);
                                } else {
                                  next.add(node.id);
                                }
                                return next;
                              });
                            }}
                            className={`ml-2 h-6 w-6 rounded flex items-center justify-center transition-all ${
                              pausedNodes.has(node.id)
                                ? 'bg-[#f59e0b] text-white hover:bg-[#d97706]'
                                : 'bg-[#38363a] text-gray-400 hover:text-white hover:bg-white/10'
                            }`}
                            title={pausedNodes.has(node.id) ? 'Resume Node' : 'Pause Node'}
                          >
                            {pausedNodes.has(node.id) ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                          </button>
                          <StatusBadge status={
                            node.status === 'online' && node.active_jobs?.length > 0 ? 'busy' : node.status
                          } />
                        </h2>
                        <div className="flex items-center gap-4 mt-2 text-sm text-gray-400">
                          <span className="flex items-center gap-1">
                            <Cpu className="h-3 w-3" style={{ color: getVendorColor('cpu', node.system_info?.cpu) }} />
                            {node.system_info?.cpu || 'Unknown CPU'}
                          </span>
                          <span className="flex items-center gap-1">
                            <HardDrive className="h-3 w-3" />
                            {formatRAM(node.system_info?.ram_total || 0)}
                          </span>
                          {node.system_info?.gpus && node.system_info.gpus.length > 0 &&
                            node.system_info.gpus.map((gpu: any, i: number) => {
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
                              const displayName = `${needsPrefix ? (gpu.vendor || '') + ' ' : ''}${gpu.name || 'Unknown GPU'}`;
                              return (
                                <span key={i} className="flex items-center gap-1">
                                  <Zap className="h-3 w-3" style={{ color: getVendorColor('gpu', undefined, gpu.vendor) }} />
                                  {displayName} ({formatVRAM(gpu.memory)})
                                </span>
                              );
                            })
                          }
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* CPU, RAM & GPU Usage */}
                  <div className="px-4 pb-4">
                    <div className="flex items-start gap-4">
                        {/* CPU */}
                        <div className="text-left">
                          <div className="flex items-start gap-2 mb-1">
                            <Cpu className="h-3 w-3 mt-0.5" style={{ color: getVendorColor('cpu', node.system_info?.cpu) }} />
                            <span className="text-xs text-gray-400">CPU</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-20 h-2 bg-gray-700 rounded-full overflow-hidden">
                              <div
                                className="h-full transition-all"
                                style={{ width: `${node.cpu_usage || 0}%`, backgroundColor: '#74c69d' }}
                              />
                            </div>
                            <span className="text-xs text-gray-500">{node.cpu_usage || 0}%</span>
                          </div>
                        </div>

                        {/* RAM */}
                        <div className="text-left">
                          <div className="flex items-start gap-2 mb-1">
                            <HardDrive className="h-3 w-3 text-gray-400 mt-0.5" />
                            <span className="text-xs text-gray-400">RAM</span>
                          </div>
                          <div className="flex flex-col items-start gap-1">
                            <div className="flex items-center gap-2">
                              <div className="w-20 h-2 bg-gray-700 rounded-full overflow-hidden">
                                <div
                                  className="h-full transition-all"
                                  style={{ width: `${node.ram_usage || 0}%`, backgroundColor: '#74c69d' }}
                                />
                              </div>
                              <span className="text-xs text-gray-500">{node.ram_usage || 0}%</span>
                            </div>
                            {node.system_info?.ram_total && node.ram_usage > 0 && (
                              <span className="text-xs text-gray-500">
                                {((node.system_info.ram_total * (node.ram_usage / 100)) / (1024 * 1024 * 1024)).toFixed(2)} GB / {(node.system_info.ram_total / (1024 * 1024 * 1024)).toFixed(2)} GB ({node.ram_usage}%)
                              </span>
                            )}
                          </div>
                        </div>
                        {node.system_info?.gpus && node.system_info.gpus.length > 0 && node.system_info.gpus.map((gpu: any, index: number) => {
                          // GPU utilization - use utilizationGpu directly from systeminformation
                          const gpuUtil = gpu.utilizationGpu !== undefined ? gpu.utilizationGpu : 0;

                          // VRAM info
                          let vramInfo = null;
                          if (gpu.memory && gpu.memoryUsed !== undefined) {
                            const usedGB = (gpu.memoryUsed / (1024 * 1024 * 1024)).toFixed(2);
                            const totalGB = (gpu.memory / (1024 * 1024 * 1024)).toFixed(2);
                            const vramPercent = Math.round((gpu.memoryUsed / gpu.memory) * 100);
                            vramInfo = `${usedGB} GB / ${totalGB} GB (${vramPercent}%)`;
                          }

                          return (
                            <div key={index} className="text-left">
                              <div className="flex items-start gap-2 mb-1">
                                <Zap className="h-3 w-3" style={{ color: getVendorColor('gpu', undefined, gpu.vendor) }} />
                                <span className="text-xs text-gray-400">
                                  GPU {index + 1}
                                  {gpu.temperatureGpu !== undefined && (
                                    <span className="ml-1">({gpu.temperatureGpu}°C)</span>
                                  )}
                                </span>
                              </div>
                              <div className="flex flex-col items-start gap-1">
                                <div className="flex items-center gap-2">
                                  <div className="w-20 h-2 bg-gray-700 rounded-full overflow-hidden">
                                    <div
                                      className="h-full transition-all"
                                      style={{
                                        width: `${gpuUtil}%`,
                                        backgroundColor: '#74c69d'
                                      }}
                                    />
                                  </div>
                                  <span className="text-xs text-gray-500">
                                    {gpuUtil}%
                                  </span>
                                </div>
                                {vramInfo && (
                                  <span className="text-xs text-gray-500">
                                    {vramInfo}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Active Jobs */}
                  <div className="pt-3" style={{ backgroundColor: '#252326' }}>
                        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3 pl-4">Active Jobs</h3>
                        <div className="w-full overflow-hidden" style={{ backgroundColor: '#2f2c30' }}>
                          <table className="w-full">
                            <thead>
                              <tr className="border-b" style={{ borderColor: '#2a282a', backgroundColor: '#222022' }}>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-400" style={{ width: '60px' }}>Type</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Title</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-400" style={{ width: '70px' }}>GPU/CPU</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-400" style={{ width: '70px' }}>ETA</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-400" style={{ width: '120px' }}>Progress</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-400" style={{ width: '70px' }}>FPS</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-400" style={{ width: '70px' }}>Ratio</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(!node.active_jobs || node.active_jobs.length === 0) ? (
                                <tr>
                                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                                    No active jobs
                                  </td>
                                </tr>
                              ) : (
                                (node.active_jobs || []).map((job: any) => {
                                  const jobType = getJobTypeInfo(job);
                                  return (
                                    <tr key={job.id} className="border-t hover:bg-white/5 transition-colors" style={{ borderColor: '#2a282a' }}>
                                      <td className="px-4 py-3">
                                        {jobType.isAnalyze ? (
                                          <Scan className="h-4 w-4" style={{ color: jobType.color }} />
                                        ) : (
                                          <Film className="h-4 w-4" style={{ color: jobType.color }} />
                                        )}
                                      </td>
                                      <td className="px-4 py-3">
                                        <div className="text-sm text-white truncate" title={job.file_name}>
                                          {job.file_name}
                                        </div>
                                        <div className="text-xs text-gray-500 truncate">
                                          {job.preset_name}
                                        </div>
                                      </td>
                                      <td className="px-4 py-3">
                                        <span className={`text-xs font-medium ${job.gpu !== null ? 'text-green-400' : 'text-blue-400'}`}>
                                          {job.gpu !== null ? `GPU ${job.gpu + 1}` : 'CPU'}
                                        </span>
                                      </td>
                                      <td className="px-4 py-3">
                                        <span className="text-sm text-gray-400 tabular-nums">
                                          {job.eta || '—'}
                                        </span>
                                      </td>
                                      <td className="px-4 py-3">
                                        <div className="flex items-center gap-2">
                                          <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                            <div
                                              className="h-full transition-all"
                                              style={{ width: `${job.progress || 0}%`, backgroundColor: '#74c69d' }}
                                            />
                                          </div>
                                          <span className="text-xs text-gray-400 w-8 text-right">
                                            {Math.round(job.progress || 0)}%
                                          </span>
                                        </div>
                                      </td>
                                      <td className="px-4 py-3">
                                        <span className="text-sm text-gray-400">
                                          {job.fps || '—'}
                                        </span>
                                      </td>
                                      <td className="px-4 py-3">
                                        <span className="text-sm text-gray-400">
                                          {job.ratio || '—'}
                                        </span>
                                      </td>
                                    </tr>
                                  );
                                })
                              )}
                            </tbody>
                          </table>
                        </div>
                    </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Clear Queue Dialog */}
      {showClearDialog && (
        <Dialog
          open={showClearDialog}
          onClose={() => setShowClearDialog(false)}
          title="Clear Queue"
        >
          <div className="space-y-4">
            <p className="text-gray-300">
              Are you sure you want to clear the entire queue? This will remove all queued and assigned jobs.
            </p>
            <div className="flex items-center gap-3 justify-end">
              <Button
                onClick={() => setShowClearDialog(false)}
                style={{ backgroundColor: '#38363a', color: '#ffffff' }}
              >
                Cancel
              </Button>
              <Button
                onClick={confirmClearQueue}
                style={{ backgroundColor: '#ef4444', color: '#ffffff' }}
              >
                Clear Queue
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// Helper function to format RAM
function formatRAM(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)} GB`;
}

// Helper function to format VRAM
function formatVRAM(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(2)} GB`;
}
