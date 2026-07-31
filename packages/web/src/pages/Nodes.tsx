import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Clock3,
  Cpu,
  Database,
  Gauge,
  Minus,
  Monitor,
  Plus,
  Search,
  Server,
  Thermometer,
  Trash2,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { api, formatBytes } from '@/utils/api';

type NodeFilter = 'all' | 'online' | 'offline';

interface WorkerLimits {
  cpu: number;
  gpus: number[];
}

const surface = 'node-surface rounded-xl border';
const insetSurface = 'node-inset rounded-lg border';

function numberValue(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function percent(value: unknown) {
  return Math.max(0, Math.min(100, numberValue(value)));
}

function cleanGpuName(name?: string) {
  if (!name) return 'Unknown GPU';
  const bracketMatch = name.match(/\[([^\]]+)\]/);
  if (bracketMatch) return bracketMatch[1];
  return name.replace(
    /^(NVIDIA Corporation|NVIDIA|Advanced Micro Devices, Inc\.|AMD|Intel Corporation|Intel|Apple)\s*/i,
    '',
  );
}

function gpuColor(vendor?: string) {
  const normalized = vendor?.toLowerCase() || '';
  if (normalized.includes('nvidia')) return '#76b900';
  if (normalized.includes('amd') || normalized.includes('radeon')) return '#ed1c24';
  if (normalized.includes('intel')) return '#00a6fb';
  if (normalized.includes('apple')) return '#a8a8ad';
  return '#74c69d';
}

function relativeTime(value?: string | number) {
  if (!value) return 'No heartbeat recorded';

  const numericValue = typeof value === 'number'
    ? value
    : /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : null;
  const timestamp = numericValue === null
    ? new Date(value).getTime()
    : numericValue < 1_000_000_000_000
      ? numericValue * 1000
      : numericValue;

  if (!Number.isFinite(timestamp)) return 'Heartbeat unavailable';
  const difference = Date.now() - timestamp;
  if (difference < -300_000) return 'Heartbeat clock out of sync';
  const seconds = Math.max(0, Math.round(difference / 1000));
  if (seconds < 10) return 'Heartbeat just now';
  if (seconds < 60) return `Heartbeat ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Heartbeat ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Heartbeat ${hours}h ago`;
  return `Heartbeat ${Math.floor(hours / 24)}d ago`;
}

function workerLimits(node: any): WorkerLimits {
  const gpuCount = node.system_info?.gpus?.length || 0;
  return {
    cpu: Math.max(0, numberValue(node.max_workers?.cpu, 1)),
    gpus: Array.from({ length: gpuCount }, (_, index) =>
      Math.max(0, numberValue(node.max_workers?.gpus?.[index], 1)),
    ),
  };
}

function UsageBar({ value, color = '#74c69d' }: { value: unknown; color?: string }) {
  const usage = percent(value);
  return (
    <div className="node-track h-1.5 overflow-hidden rounded-full">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${usage}%`, backgroundColor: color }}
      />
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  detail,
  color,
}: {
  icon: typeof Server;
  label: string;
  value: string | number;
  detail: string;
  color: string;
}) {
  return (
    <div className={`${surface} p-4`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-gray-500">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-white">{value}</p>
          <p className="mt-1 text-xs text-gray-500">{detail}</p>
        </div>
        <div className="node-icon-tile rounded-lg border p-2.5" style={{ color }}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}

function Stepper({
  value,
  onChange,
  disabled,
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="node-stepper flex items-center rounded-md border">
      <button
        type="button"
        aria-label={`Decrease ${label} workers`}
        className="grid h-8 w-8 place-items-center text-gray-400 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
        onClick={() => onChange(Math.max(0, value - 1))}
        disabled={disabled || value === 0}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="node-stepper-divider min-w-8 border-x text-center text-xs font-semibold tabular-nums text-white">
        {value}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label} workers`}
        className="grid h-8 w-8 place-items-center text-gray-400 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
        onClick={() => onChange(value + 1)}
        disabled={disabled}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function NodeCard({
  node,
  onWorkerChange,
  onDelete,
  isUpdating,
  isDeleting,
}: {
  node: any;
  onWorkerChange: (node: any, limits: WorkerLimits) => void;
  onDelete: (node: any) => void;
  isUpdating: boolean;
  isDeleting: boolean;
}) {
  const online = Boolean(node.connected);
  const limits = workerLimits(node);
  const gpus = node.system_info?.gpus || [];
  const activeJobs = node.active_jobs || [];
  const os = [node.system_info?.os, node.system_info?.os_version].filter(Boolean).join(' ') || 'Unknown OS';
  const ramTotal = numberValue(node.system_info?.ram_total);

  return (
    <article className={`${surface} overflow-hidden ${online ? '' : 'opacity-70'}`}>
      <header className="node-divider flex flex-col gap-4 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg border ${
              online
                ? 'node-online-panel text-[#74c69d]'
                : 'node-offline-panel text-gray-500'
            }`}
          >
            <Server className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold text-white">{node.name || 'Unnamed node'}</h2>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                  online
                    ? 'node-online-panel text-[#8bd5ad]'
                    : 'node-offline-panel text-gray-500'
                }`}
              >
                {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                {online ? 'Online' : 'Offline'}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
              <span>{os}</span>
              <span className="inline-flex items-center gap-1">
                <Clock3 className="h-3 w-3" />
                {relativeTime(node.last_heartbeat)}
              </span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDelete(node)}
          disabled={isDeleting}
          className="node-action inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-medium text-gray-400 transition-colors hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove
        </button>
      </header>

      <div className="grid gap-4 p-5 xl:grid-cols-2">
        <div className="space-y-4">
          <section className={`${insetSurface} p-4`}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">System load</h3>
              {activeJobs.length > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#8bd5ad]">
                  <Activity className="h-3.5 w-3.5" />
                  {activeJobs.length} active {activeJobs.length === 1 ? 'job' : 'jobs'}
                </span>
              )}
            </div>

            <div className="space-y-4">
              <div>
                <div className="mb-2 flex items-center justify-between gap-4 text-xs">
                  <span className="flex min-w-0 items-center gap-2 text-gray-400">
                    <Cpu className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{node.system_info?.cpu || 'Unknown CPU'}</span>
                  </span>
                  <span className="shrink-0 font-medium tabular-nums text-gray-300">
                    {online ? `${Math.round(percent(node.cpu_usage))}%` : '—'}
                  </span>
                </div>
                <UsageBar value={online ? node.cpu_usage : 0} />
                <p className="mt-1.5 text-[11px] text-gray-400">{node.system_info?.cpu_cores || '—'} logical cores</p>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2 text-gray-400">
                    <Database className="h-3.5 w-3.5" /> Memory
                  </span>
                  <span className="font-medium tabular-nums text-gray-300">
                    {online ? `${Math.round(percent(node.ram_usage))}%` : '—'}
                  </span>
                </div>
                <UsageBar value={online ? node.ram_usage : 0} color="#6ca9e6" />
                <p className="mt-1.5 text-[11px] text-gray-400">
                  {ramTotal > 0 ? `${formatBytes(ramTotal)} installed` : 'Capacity unavailable'}
                </p>
              </div>
            </div>
          </section>

          <section className={`${insetSurface} p-4`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Worker capacity</h3>
                <p className="mt-1 text-[11px] text-gray-600">Maximum concurrent jobs per device</p>
              </div>
              {isUpdating && <span className="text-[11px] text-[#74c69d]">Saving…</span>}
            </div>

            <div className="mt-4 space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs text-gray-300">
                  <Cpu className="h-3.5 w-3.5 text-gray-500" /> CPU workers
                </div>
                <Stepper
                  value={limits.cpu}
                  label="CPU"
                  disabled={!online || isUpdating}
                  onChange={(cpu) => onWorkerChange(node, { ...limits, cpu })}
                />
              </div>
              {gpus.map((gpu: any, index: number) => (
                <div key={`${gpu.name}-${index}`} className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2 text-xs text-gray-300">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: gpuColor(gpu.vendor) }} />
                    <span className="truncate">GPU {index + 1} · {cleanGpuName(gpu.name)}</span>
                  </div>
                  <Stepper
                    value={limits.gpus[index]}
                    label={`GPU ${index + 1}`}
                    disabled={!online || isUpdating}
                    onChange={(value) => {
                      const nextGpus = [...limits.gpus];
                      nextGpus[index] = value;
                      onWorkerChange(node, { ...limits, gpus: nextGpus });
                    }}
                  />
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="space-y-4">
          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">GPU inventory</h3>
              <span className="text-[11px] text-gray-600">{gpus.length} detected</span>
            </div>
            {gpus.length > 0 ? (
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
                {gpus.map((gpu: any, index: number) => {
                  const color = gpuColor(gpu.vendor);
                  const memoryTotal = numberValue(gpu.memory);
                  const memoryUsed = numberValue(gpu.memoryUsed);
                  const memoryUsage = memoryTotal > 0
                    ? (memoryUsed / memoryTotal) * 100
                    : percent(gpu.utilizationMemory);
                  return (
                    <div key={`${gpu.name}-${index}`} className={`${insetSurface} p-4`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div className="node-icon-tile grid h-8 w-8 shrink-0 place-items-center rounded-md" style={{ color }}>
                            <Monitor className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-white">{cleanGpuName(gpu.name)}</p>
                            <p className="mt-0.5 truncate text-[10px] uppercase tracking-wider text-gray-600">
                              {gpu.vendor || 'Unknown vendor'}{gpu.driver_version ? ` · ${gpu.driver_version}` : ''}
                            </p>
                          </div>
                        </div>
                        <span className="text-xs font-semibold tabular-nums" style={{ color }}>
                          {online ? `${Math.round(percent(gpu.utilizationGpu))}%` : '—'}
                        </span>
                      </div>

                      <div className="mt-4 space-y-3">
                        <div>
                          <div className="mb-1.5 flex justify-between text-[11px]">
                            <span className="text-gray-500">GPU utilization</span>
                            <span className="tabular-nums text-gray-400">{Math.round(percent(gpu.utilizationGpu))}%</span>
                          </div>
                          <UsageBar value={gpu.utilizationGpu} color={color} />
                        </div>
                        <div>
                          <div className="mb-1.5 flex justify-between gap-2 text-[11px]">
                            <span className="text-gray-500">VRAM</span>
                            <span className="truncate tabular-nums text-gray-400">
                              {memoryTotal > 0
                                ? `${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)}`
                                : 'Unavailable'}
                            </span>
                          </div>
                          <UsageBar value={memoryUsage} color="#8e7cc3" />
                        </div>
                      </div>

                      <div className="node-divider mt-4 grid grid-cols-2 gap-2 border-t pt-3 text-[11px]">
                        <span className="flex items-center gap-1.5 text-gray-500">
                          <Thermometer className="h-3 w-3" />
                          {gpu.temperatureGpu != null ? `${Math.round(numberValue(gpu.temperatureGpu))}°C` : 'No temp'}
                        </span>
                        <span className="flex items-center justify-end gap-1.5 text-gray-500">
                          <Zap className="h-3 w-3" />
                          {gpu.powerDraw != null ? `${numberValue(gpu.powerDraw).toFixed(0)} W` : 'No power data'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className={`${insetSurface} grid min-h-32 place-items-center px-4 text-center`}>
                <div>
                  <Monitor className="mx-auto h-5 w-5 text-gray-600" />
                  <p className="mt-2 text-xs text-gray-500">No GPUs detected on this node</p>
                  <p className="mt-1 text-[11px] text-gray-700">CPU transcoding remains available</p>
                </div>
              </div>
            )}
          </section>

          {activeJobs.length > 0 && (
            <section className={`${insetSurface} p-4`}>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Active work</h3>
              <div className="space-y-3">
                {activeJobs.slice(0, 3).map((job: any) => (
                  <div key={job.id}>
                    <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                      <span className="truncate font-medium text-gray-300">{job.file_name || job.name || job.id}</span>
                      <span className="shrink-0 tabular-nums text-gray-500">{Math.round(percent(job.progress))}%</span>
                    </div>
                    <UsageBar value={job.progress} />
                    <div className="mt-1.5 flex items-center justify-between gap-3 text-[10px] text-gray-600">
                      <span className="truncate">{job.current_action || job.preset_name || 'Transcoding'}</span>
                      <span className="shrink-0">{job.fps ? `${Math.round(numberValue(job.fps))} fps` : job.gpu || 'CPU'}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 text-[11px] text-gray-600">
            <span>FFmpeg {node.system_info?.ffmpeg_version || 'version unavailable'}</span>
            <span>Node ID {String(node.id).slice(0, 8)}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

export function Nodes() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<NodeFilter>('all');
  const [search, setSearch] = useState('');
  useWebSocket({ channels: ['nodes'] });

  const { data: nodes = [], isLoading } = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.getNodes(),
    staleTime: Infinity,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteNode(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['nodes'] }),
  });

  const updateNodeMutation = useMutation({
    mutationFn: ({ nodeId, limits }: { nodeId: string; limits: WorkerLimits }) =>
      api.updateNode(nodeId, { max_workers: limits }),
    onMutate: async ({ nodeId, limits }) => {
      await queryClient.cancelQueries({ queryKey: ['nodes'] });
      const previous = queryClient.getQueryData<any[]>(['nodes']);
      queryClient.setQueryData<any[]>(['nodes'], (current = []) =>
        current.map((node) => (node.id === nodeId ? { ...node, max_workers: limits } : node)),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['nodes'], context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['nodes'] }),
  });

  const stats = useMemo(() => {
    const online = nodes.filter((node: any) => node.connected);
    const totalGpus = nodes.reduce((sum: number, node: any) => sum + (node.system_info?.gpus?.length || 0), 0);
    const totalWorkers = nodes.reduce((sum: number, node: any) => {
      const limits = workerLimits(node);
      return sum + limits.cpu + limits.gpus.reduce((gpuSum, value) => gpuSum + value, 0);
    }, 0);
    const activeJobs = nodes.reduce((sum: number, node: any) => sum + (node.active_jobs?.length || 0), 0);
    const averageCpu = online.length
      ? Math.round(online.reduce((sum: number, node: any) => sum + percent(node.cpu_usage), 0) / online.length)
      : 0;
    return { online: online.length, totalGpus, totalWorkers, activeJobs, averageCpu };
  }, [nodes]);

  const visibleNodes = useMemo(() => {
    const term = search.trim().toLowerCase();
    return [...nodes]
      .filter((node: any) => {
        if (filter === 'online' && !node.connected) return false;
        if (filter === 'offline' && node.connected) return false;
        if (!term) return true;
        const searchable = [
          node.name,
          node.system_info?.os,
          node.system_info?.cpu,
          ...(node.system_info?.gpus || []).map((gpu: any) => gpu.name),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return searchable.includes(term);
      })
      .sort((a: any, b: any) => Number(b.connected) - Number(a.connected) || String(a.name).localeCompare(String(b.name)));
  }, [filter, nodes, search]);

  if (isLoading) {
    return (
      <div className="grid h-64 place-items-center">
        <div className="text-center">
          <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-[#343338] border-t-[#74c69d]" />
          <p className="mt-3 text-sm text-gray-500">Loading fleet telemetry…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="nodes-page space-y-6 pb-10">
      <header>
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#74c69d]">
            <Gauge className="h-3.5 w-3.5" /> Transcoding fleet
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Nodes</h1>
          <p className="mt-1.5 max-w-xl text-sm text-gray-500">
            Monitor hardware health, active workloads, and per-device concurrency from one place.
          </p>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          icon={Server}
          label="Online nodes"
          value={`${stats.online}/${nodes.length}`}
          detail={nodes.length === stats.online ? 'Entire fleet available' : `${nodes.length - stats.online} unavailable`}
          color="#74c69d"
        />
        <SummaryCard
          icon={Activity}
          label="Active jobs"
          value={stats.activeJobs}
          detail={stats.activeJobs === 1 ? 'Workload in progress' : 'Workloads in progress'}
          color="#e0a458"
        />
        <SummaryCard
          icon={Cpu}
          label="Worker slots"
          value={stats.totalWorkers}
          detail="CPU and GPU combined"
          color="#8e7cc3"
        />
        <SummaryCard
          icon={Gauge}
          label="Average CPU"
          value={`${stats.averageCpu}%`}
          detail={`${stats.totalGpus} GPUs across online nodes`}
          color="#d178b7"
        />
      </section>

      {nodes.length > 0 && (
        <section className={`${surface} flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between`}>
          <div className="node-filter-shell flex items-center gap-1 rounded-lg border p-1">
            {(['all', 'online', 'offline'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  filter === value ? 'node-filter-active text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {value}
              </button>
            ))}
          </div>
          <label className="relative block w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-600" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search nodes or hardware…"
              className="node-input h-9 w-full rounded-lg border pl-9 pr-3 text-xs text-white outline-none placeholder:text-gray-700"
            />
          </label>
        </section>
      )}

      <section className="space-y-4">
        {visibleNodes.map((node: any) => (
          <NodeCard
            key={node.id}
            node={node}
            onWorkerChange={(targetNode, limits) => updateNodeMutation.mutate({ nodeId: targetNode.id, limits })}
            onDelete={(targetNode) => {
              if (window.confirm(`Remove node "${targetNode.name}"? This only unregisters it from Encorr.`)) {
                deleteMutation.mutate(targetNode.id);
              }
            }}
            isUpdating={updateNodeMutation.isPending && updateNodeMutation.variables?.nodeId === node.id}
            isDeleting={deleteMutation.isPending && deleteMutation.variables === node.id}
          />
        ))}
      </section>

      {nodes.length === 0 && (
        <section className={`${surface} grid min-h-72 place-items-center p-8 text-center`}>
          <div>
            <div className="node-icon-tile mx-auto grid h-12 w-12 place-items-center rounded-xl border text-gray-500">
              <Server className="h-6 w-6" />
            </div>
            <h2 className="mt-4 text-base font-semibold text-white">No nodes registered</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
              Start an Encorr worker on another machine and it will appear here with its hardware inventory.
            </p>
            <code className="node-code mt-4 inline-block rounded-lg border px-3 py-2 text-xs text-[#8bd5ad]">
              encorr-node start
            </code>
          </div>
        </section>
      )}

      {nodes.length > 0 && visibleNodes.length === 0 && (
        <section className={`${surface} grid min-h-40 place-items-center p-8 text-center`}>
          <div>
            <Search className="mx-auto h-5 w-5 text-gray-600" />
            <p className="mt-2 text-sm text-gray-400">No nodes match this view</p>
            <button
              type="button"
              onClick={() => { setSearch(''); setFilter('all'); }}
              className="mt-2 text-xs font-medium text-[#74c69d]"
            >
              Clear filters
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
