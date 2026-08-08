import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Activity,
  Clock3,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Monitor,
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

function formatDriveRate(value: unknown) {
  const bytesPerSecond = Math.max(0, numberValue(value));
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

function coreUsageColor(value: unknown) {
  const usage = percent(value);
  if (usage >= 90) return '#ef4444';
  if (usage >= 70) return '#f59e0b';
  return '#74c69d';
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

function gpuColor(vendor?: string, name?: string) {
  const normalized = `${vendor || ''} ${name || ''}`.toLowerCase();
  if (normalized.includes('nvidia')) return '#76b900';
  if (/\bintel\b|\barc(?:\(tm\))?\b/.test(normalized)) return '#3b82f6';
  if (/\bamd\b|advanced micro devices|\bradeon\b|\bati\b/.test(normalized)) return '#ef4444';
  if (normalized.includes('apple')) return '#a8a8ad';
  return '#74c69d';
}

function normalizeNodePath(path: unknown) {
  const normalized = String(path || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

function driveForPath(drives: any[], nodePath: unknown) {
  const mappedPath = normalizeNodePath(nodePath);
  if (!mappedPath) return null;

  return drives
    .filter(drive => {
      const mount = normalizeNodePath(drive.mount);
      if (!mount) return false;
      return mount === '/'
        || mappedPath === mount
        || mappedPath.startsWith(`${mount}/`);
    })
    .sort((left, right) => normalizeNodePath(right.mount).length - normalizeNodePath(left.mount).length)[0] || null;
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

function ThroughputBar({ read, write }: { read: unknown; write: unknown }) {
  const readRate = Math.max(0, numberValue(read));
  const writeRate = Math.max(0, numberValue(write));
  const totalRate = readRate + writeRate;
  const totalMegabytes = totalRate / 1024 / 1024;
  const activity = totalMegabytes > 0
    ? Math.min(100, Math.log10(totalMegabytes + 1) / Math.log10(1001) * 100)
    : 0;
  const readWidth = totalRate > 0 ? activity * readRate / totalRate : 0;
  const writeWidth = totalRate > 0 ? activity * writeRate / totalRate : 0;

  return (
    <div className="node-track flex h-1 overflow-hidden rounded-full" aria-label="Drive I/O activity">
      <div className="h-full bg-[#74c69d] transition-[width] duration-500" style={{ width: `${readWidth}%` }} />
      <div className="h-full bg-[#6ca9e6] transition-[width] duration-500" style={{ width: `${writeWidth}%` }} />
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

function NodeCard({
  node,
  mappings,
  onDelete,
  isDeleting,
}: {
  node: any;
  mappings: any[];
  onDelete: (node: any) => void;
  isDeleting: boolean;
}) {
  if (node.rejected) {
    return (
      <article className="overflow-hidden rounded-xl border border-red-500/35 bg-red-500/[0.035]">
        <header className="flex flex-col gap-3 border-b border-red-500/20 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-red-500/30 bg-red-500/10 text-red-300">
              <AlertCircle className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-white">{node.name || 'Unnamed node'}</h2>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-300">
                  Rejected
                </span>
              </div>
              <p className="mt-1 text-xs text-red-200/70">Connection was blocked to protect the active worker.</p>
            </div>
          </div>
          <span className="text-xs text-red-200/60">Duplicate name</span>
        </header>
        <div className="px-5 py-4">
          <p className="text-sm text-red-100">{node.rejection_reason || 'This node connection was rejected.'}</p>
          <p className="mt-2 text-xs text-red-200/65">Update the node name in its configuration, then reconnect it.</p>
        </div>
      </article>
    );
  }

  const online = Boolean(node.connected);
  const gpus = node.system_info?.gpus || [];
  const reportedDrives = node.system_info?.drives || [];
  const nodeMappings = mappings.filter(mapping => mapping.node_id === node.id && mapping.node_path);
  const relevantDriveMap = new Map<string, { drive: any; reasons: string[] }>();
  const includeDrive = (path: unknown, reason: string) => {
    const drive = driveForPath(reportedDrives, path);
    if (!drive) return;
    const key = `${normalizeNodePath(drive.mount)}|${drive.filesystem || ''}`;
    const entry = relevantDriveMap.get(key) || { drive, reasons: [] };
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    relevantDriveMap.set(key, entry);
  };
  nodeMappings.forEach(mapping => includeDrive(mapping.node_path, 'Mapped media'));
  includeDrive(node.system_info?.cache_path, 'Encorr cache');
  includeDrive(node.system_info?.temp_path, 'Encorr temp');
  const driveEntries = Array.from(relevantDriveMap.values());
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

      <div className="grid lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.3fr)_minmax(320px,1.05fr)]">
        <section className="min-w-0 p-5 lg:border-r node-divider">
          <div className="space-y-7">
            <div>
              <div className="mb-2 flex items-center justify-between gap-4 text-xs"><span className="flex min-w-0 items-center gap-2 text-gray-300"><Cpu className="h-3.5 w-3.5 shrink-0 text-gray-500" /><span className="truncate">{node.system_info?.cpu || 'Unknown CPU'}</span></span><span className="shrink-0 font-semibold tabular-nums text-gray-200">{online ? `${Math.round(percent(node.cpu_usage))}%` : '—'}</span></div>
              <UsageBar value={online ? node.cpu_usage : 0} />
              <p className="mt-2 text-xs text-gray-400">{node.system_info?.cpu_cores || '—'} logical cores</p>
              {Array.isArray(node.cpu_core_usage) && node.cpu_core_usage.length > 0 && (
                <div className="mt-4 border-t border-white/[0.06] pt-3">
                  <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.12em] text-gray-500"><span>Per-core usage</span><span>{node.cpu_core_usage.length} logical cores</span></div>
                  <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 xl:grid-cols-4 2xl:grid-cols-6">
                    {node.cpu_core_usage.map((core: number, index: number) => {
                      const usage = percent(core);
                      const color = coreUsageColor(usage);
                      return (
                        <div key={index} className="node-core-tile rounded-md px-1.5 py-1.5" title={`Logical core ${index + 1}: ${Math.round(usage)}%`}>
                          <div className="flex items-center justify-between gap-1 text-[9px] leading-none"><span className="text-gray-500">C{index + 1}</span><span className="font-semibold tabular-nums" style={{ color }}>{Math.round(usage)}%</span></div>
                          <div className="node-track mt-1.5 h-1 overflow-hidden rounded-full"><div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${usage}%`, backgroundColor: color }} /></div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between text-xs"><span className="flex items-center gap-2 text-gray-300"><Database className="h-3.5 w-3.5 text-gray-500" /> Memory</span><span className="font-semibold tabular-nums text-gray-200">{online ? `${Math.round(percent(node.ram_usage))}%` : '—'}</span></div>
              <UsageBar value={online ? node.ram_usage : 0} color="#6ca9e6" />
              <p className="mt-2 text-xs text-gray-400">{ramTotal > 0 ? `${formatBytes(ramTotal)} installed` : 'Capacity unavailable'}</p>
            </div>
          </div>
        </section>

        <section className="min-w-0 border-t p-5 lg:border-t-0 lg:border-r node-divider">
          <div className="mb-4 flex items-center justify-between gap-3"><h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Drive usage</h3><span className="text-xs text-gray-500">{driveEntries.length} detected</span></div>
          {driveEntries.length > 0 ? <div className="space-y-4">{driveEntries.map(({ drive, reasons }, index: number) => {
            const size = numberValue(drive.size); const used = numberValue(drive.used); const available = numberValue(drive.available, Math.max(0, size - used)); const usage = size > 0 ? (used / size) * 100 : numberValue(drive.use); const hasRate = drive.read_bytes_per_sec != null && drive.write_bytes_per_sec != null;
            return <div key={`${drive.filesystem}-${drive.mount}-${index}`}><div className="flex items-start justify-between gap-3 text-xs"><div className="flex min-w-0 items-start gap-2 text-gray-300"><HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-500" /><div className="min-w-0"><div className="flex flex-wrap items-center gap-1.5"><span className="truncate font-semibold">{drive.mount || drive.filesystem || 'Drive'}</span>{reasons.map(reason => <span key={reason} className="rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-px text-[9px] text-gray-400">{reason}</span>)}</div><p className="mt-1 truncate text-[11px] text-gray-500">{[drive.filesystem, drive.type].filter(Boolean).join(' · ')}</p></div></div><div className="shrink-0 text-right tabular-nums"><p className="text-gray-300">{formatBytes(used)} / {formatBytes(size)}</p><p className="mt-1 text-[11px] text-gray-500">{formatBytes(available)} free</p></div></div><div className="mt-2"><UsageBar value={usage} color={usage >= 90 ? '#ef4444' : usage >= 75 ? '#f59e0b' : '#74c69d'} /></div><div className="mt-2 flex items-center gap-2 text-[10px]"><span className="text-gray-500">I/O</span><div className="min-w-0 flex-1"><ThroughputBar read={drive.read_bytes_per_sec} write={drive.write_bytes_per_sec} /></div><span className="shrink-0 tabular-nums text-gray-400">{hasRate ? `R: ${formatDriveRate(drive.read_bytes_per_sec)} · W: ${formatDriveRate(drive.write_bytes_per_sec)}` : 'Unavailable'}</span></div></div>;
          })}</div> : <div className="flex min-h-28 items-center gap-2 text-xs text-gray-500"><HardDrive className="h-3.5 w-3.5" />{reportedDrives.length === 0 ? 'Drive information unavailable until this node reconnects' : 'No reported drive matches this node’s mapped or working paths'}</div>}
        </section>

        <section className="min-w-0 border-t p-4 lg:border-t-0 node-divider">
          {gpus.length > 0 ? <div className="space-y-2.5">{gpus.map((gpu: any, index: number) => {
            const color = gpuColor(gpu.vendor, gpu.name); const memoryTotal = numberValue(gpu.memory); const memoryUsed = numberValue(gpu.memoryUsed); const memoryUsage = memoryTotal > 0 ? (memoryUsed / memoryTotal) * 100 : percent(gpu.utilizationMemory);
            return <div key={`${gpu.name}-${index}`} className={`${insetSurface} p-3.5`}><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-2.5"><div className="node-icon-tile grid h-8 w-8 shrink-0 place-items-center rounded-md" style={{ color }}><Monitor className="h-4 w-4" /></div><div className="min-w-0"><p className="truncate text-xs font-semibold text-white">{cleanGpuName(gpu.name)}</p><p className="mt-0.5 truncate text-[10px] uppercase tracking-wider text-gray-500">{gpu.vendor || 'Unknown vendor'}{gpu.driver_version ? ` · ${gpu.driver_version}` : ''}</p></div></div><span className="text-xs font-semibold tabular-nums" style={{ color }}>{online ? `${Math.round(percent(gpu.utilizationGpu))}%` : '—'}</span></div><div className="mt-3 space-y-2.5"><div><div className="mb-1 flex justify-between text-[10px]"><span className="text-gray-500">GPU utilization</span><span className="text-gray-400">{Math.round(percent(gpu.utilizationGpu))}%</span></div><UsageBar value={gpu.utilizationGpu} color={color} /></div><div><div className="mb-1 flex justify-between gap-2 text-[10px]"><span className="text-gray-500">{gpu.memory_type === 'shared' ? 'Shared GPU memory' : 'VRAM'}</span><span className="truncate tabular-nums text-gray-400">{gpu.memory_type === 'shared' && memoryUsed <= 0 && memoryTotal > 0 ? `${formatBytes(memoryTotal)} available` : memoryTotal > 0 ? `${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)}` : 'Unavailable'}</span></div><UsageBar value={memoryUsage} color={gpu.memory_type === 'shared' ? color : '#8e7cc3'} /></div></div><div className="node-divider mt-3 flex items-center justify-between border-t pt-2.5 text-[11px] text-gray-400"><span className="flex items-center gap-1.5"><Thermometer className="h-3 w-3" />{gpu.temperatureGpu != null ? `${Math.round(numberValue(gpu.temperatureGpu))}°C` : 'No temp'}</span><span className="flex items-center gap-1.5"><Zap className="h-3 w-3" />{gpu.powerDraw != null ? `${numberValue(gpu.powerDraw).toFixed(0)} W` : 'No power data'}</span></div></div>;
          })}</div> : <div className="grid min-h-32 place-items-center text-center"><div><Monitor className="mx-auto h-5 w-5 text-gray-600" /><p className="mt-2 text-xs text-gray-500">No GPUs detected on this node</p></div></div>}
        </section>
      </div>

      {activeJobs.length > 0 && <section className="node-divider border-t px-5 py-3.5"><div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-gray-400"><Activity className="h-3.5 w-3.5 text-[#74c69d]" /> Active work · {activeJobs.length}</div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{activeJobs.slice(0, 3).map((job: any) => <div key={job.id} className="min-w-0"><div className="mb-1 flex items-center justify-between gap-3 text-xs"><span className="truncate text-gray-300">{job.file_name || job.name || job.id}</span><span className="shrink-0 tabular-nums text-gray-400">{Math.round(percent(job.progress))}%</span></div><UsageBar value={job.progress} /></div>)}</div></section>}

      <footer className="node-divider flex flex-wrap items-center gap-x-5 gap-y-1 border-t px-5 py-3 text-xs text-gray-500"><span>FFmpeg {node.system_info?.ffmpeg_version || 'version unavailable'}</span><span>Node ID {String(node.id).slice(0, 8)}</span></footer>
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

  const { data: mappings = [], isLoading: mappingsLoading } = useQuery({
    queryKey: ['mappings'],
    queryFn: () => api.getMappings(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteNode(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['nodes'] }),
  });

  const stats = useMemo(() => {
    const registeredNodes = nodes.filter((node: any) => !node.rejected);
    const online = registeredNodes.filter((node: any) => node.connected);
    const totalGpus = registeredNodes.reduce((sum: number, node: any) => sum + (node.system_info?.gpus?.length || 0), 0);
    const totalWorkers = registeredNodes.reduce((sum: number, node: any) => {
      const limits = workerLimits(node);
      return sum + limits.cpu + limits.gpus.reduce((gpuSum, value) => gpuSum + value, 0);
    }, 0);
    const activeJobs = registeredNodes.reduce((sum: number, node: any) => sum + (node.active_jobs?.length || 0), 0);
    const averageCpu = online.length
      ? Math.round(online.reduce((sum: number, node: any) => sum + percent(node.cpu_usage), 0) / online.length)
      : 0;
    return {
      online: online.length,
      total: registeredNodes.length,
      rejected: nodes.length - registeredNodes.length,
      totalGpus,
      totalWorkers,
      activeJobs,
      averageCpu,
    };
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

  if (isLoading || mappingsLoading) {
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
          value={`${stats.online}/${stats.total}`}
          detail={stats.rejected > 0
            ? `${stats.rejected} rejected connection${stats.rejected === 1 ? '' : 's'}`
            : stats.total === stats.online ? 'Entire fleet available' : `${stats.total - stats.online} unavailable`}
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
            mappings={mappings}
            onDelete={(targetNode) => {
              if (window.confirm(`Remove node "${targetNode.name}"? This only unregisters it from Encorr.`)) {
                deleteMutation.mutate(targetNode.id);
              }
            }}
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
