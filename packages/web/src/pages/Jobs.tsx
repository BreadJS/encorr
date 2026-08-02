import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cpu,
  Database,
  Film,
  Gauge,
  HardDrive,
  Layers3,
  Minus,
  Monitor,
  Plus,
  Play,
  RefreshCw,
  Scan,
  Search,
  Server,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { useWebSocket } from '@/hooks/useWebSocket';
import { api, formatBytes } from '@/utils/api';

type JobTab = 'queue' | 'failed' | 'success';

interface WorkerLimits {
  cpu: number;
  gpus: number[];
}

const countFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const surfaceClass = 'rounded-xl border border-[#39363a] bg-[#222123]';

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percentage(value: unknown) {
  return Math.max(0, Math.min(100, numberValue(value)));
}

function cleanGpuName(name?: string) {
  if (!name) return 'Unknown GPU';
  const bracketMatch = name.match(/\[([^\]]+)\]/);
  return bracketMatch?.[1] || name.replace(/^(NVIDIA Corporation|NVIDIA|AMD|Intel Corporation|Intel)\s*/i, '');
}

function vendorColor(vendor?: string) {
  const value = vendor?.toLowerCase() || '';
  if (value.includes('nvidia')) return '#76b900';
  if (value.includes('amd') || value.includes('radeon')) return '#ed1c24';
  if (value.includes('intel')) return '#00a6fb';
  return '#74c69d';
}

function jobType(job: any) {
  if (job.file_operation || job.job_type === 'file_operation') {
    const cleanup = job.operation === 'cleanup_backup';
    return {
      label: cleanup ? 'Delete backup' : job.operation === 'backup_replace' ? 'Backup & Replace' : 'Replace Original',
      color: '#60a5fa',
      Icon: HardDrive,
    };
  }
  const analyze = job.type === 'analyze'
    || job.preset_id === 'builtin-analyze'
    || job.preset_name?.toLowerCase().includes('analyze');
  return analyze
    ? { label: 'Analyze', color: '#f59e0b', Icon: Scan }
    : { label: 'Transcode', color: '#74c69d', Icon: Film };
}

function jobName(job: any) {
  return job.file_name || job.name || job.filename || `Job ${String(job.id).slice(0, 8)}`;
}

function isActiveJobStatus(status: unknown) {
  return status === 'assigned' || status === 'processing';
}

function formatTimestamp(value?: string | number) {
  if (!value) return 'Time unavailable';
  const numeric = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : null;
  const timestamp = numeric === null ? new Date(value).getTime() : numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  if (!Number.isFinite(timestamp)) return 'Time unavailable';
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatElapsed(value?: string | number) {
  if (!value) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  const timestamp = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function parseStats(value: unknown) {
  if (!value) return null;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function limitsForNode(node: any): WorkerLimits {
  const gpuCount = node.system_info?.gpus?.length || 0;
  const legacyGpu = numberValue(node.max_workers?.gpu, 0);
  return {
    cpu: Math.max(0, numberValue(node.max_workers?.cpu, 1)),
    gpus: Array.from({ length: gpuCount }, (_, index) =>
      Math.max(0, numberValue(node.max_workers?.gpus?.[index], legacyGpu || 1)),
    ),
  };
}

function ProgressBar({ value, color = '#74c69d' }: { value: unknown; color?: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-[#39363a]">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${percentage(value)}%`, backgroundColor: color }}
      />
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  color,
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  detail: string;
  color: string;
}) {
  return (
    <div className={`${surfaceClass} p-4`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-gray-500">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-white">{value}</p>
          <p className="mt-1 text-xs text-gray-500">{detail}</p>
        </div>
        <div className="rounded-lg border border-[#39363a] bg-[#282729] p-2.5" style={{ color }}>
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
  max,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  max?: number;
  label: string;
}) {
  return (
    <div className="flex items-center rounded-md border border-[#39363a] bg-[#282729]">
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        onClick={() => onChange(Math.max(0, value - 1))}
        disabled={disabled || value <= 0}
        className="grid h-7 w-7 place-items-center text-gray-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="min-w-7 border-x border-[#39363a] text-center text-[11px] font-semibold tabular-nums text-white">
        {value}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        onClick={() => onChange(value + 1)}
        disabled={disabled || (max !== undefined && value >= max)}
        className="grid h-7 w-7 place-items-center text-gray-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function JobRow({ job, tab, onDelete, deleting }: {
  job: any;
  tab: JobTab;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const type = jobType(job);
  const stats = parseStats(job.stats);
  const originalSize = numberValue(stats?.original_size || job.file_size);
  const transcodedSize = numberValue(stats?.transcoded_size);
  const saving = originalSize > 0 && transcodedSize > 0
    ? Math.max(0, Math.round((1 - transcodedSize / originalSize) * 100))
    : null;

  return (
    <div className="grid gap-3 border-t border-[#39363a] px-4 py-3.5 first:border-t-0 lg:grid-cols-[110px_minmax(0,1fr)_170px_140px_40px] lg:items-center">
      <div className="flex items-center gap-2">
        <type.Icon className="h-4 w-4" style={{ color: type.color }} />
        <span className="text-xs font-semibold" style={{ color: type.color }}>{type.label}</span>
      </div>

      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-white" title={jobName(job)}>{jobName(job)}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-500">
          <span>{job.preset_name || 'No preset information'}</span>
          {job.post_action && job.post_action !== 'keep' && (
            <span className="text-blue-300">After: {job.post_action === 'backup_replace' ? 'Backup & Replace' : 'Replace Original'}</span>
          )}
          {job.original_codec && job.target_codec && (
            <span>{String(job.original_codec).toUpperCase()} → {String(job.target_codec).toUpperCase()}</span>
          )}
          {job.resolution && <span>{job.resolution}</span>}
          {job.error_message && <span className="truncate text-red-400">{job.error_message}</span>}
        </div>
      </div>

      <div className="text-xs text-gray-400">
        <p className="truncate">{job.node_name || (tab === 'queue' ? 'Awaiting worker' : 'Unknown node')}</p>
        <p className="mt-1 text-[11px] text-gray-600">
          {tab === 'success' ? `Finished ${formatTimestamp(job.completed_at)}` : `Created ${formatTimestamp(job.created_at)}`}
        </p>
      </div>

      <div>
        {tab === 'success' ? (
          <div className="text-xs">
            <p className="font-medium text-[#8bd5ad]">Completed</p>
            <p className="mt-1 text-[11px] text-gray-500">
              {job.file_operation
                ? `${job.current_action || 'File operation complete'} · ${formatBytes(numberValue(job.total_bytes))}`
                : saving !== null ? `${saving}% smaller` : transcodedSize > 0 ? formatBytes(transcodedSize) : 'Output ready'}
            </p>
          </div>
        ) : tab === 'failed' ? (
          <div className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
            <XCircle className="h-3.5 w-3.5" /> Failed
          </div>
        ) : (
          <div>
            <div className="mb-1.5 flex justify-between text-[11px] text-gray-500">
              <span>{job.depends_on_job_id ? 'Waiting for analysis' : 'Queued'}</span><span>{percentage(job.progress).toFixed(0)}%</span>
            </div>
            <ProgressBar value={job.progress} color="#f59e0b" />
          </div>
        )}
      </div>

      {!job.file_operation ? (
        <button
          type="button"
          onClick={() => onDelete(job.id)}
          disabled={deleting}
          className="grid h-8 w-8 place-items-center rounded-lg border border-[#39363a] text-gray-500 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
          title={tab === 'queue' ? 'Cancel job' : 'Remove from history'}
        >
          {tab === 'queue' ? <X className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      ) : <div className="h-8 w-8" />}
    </div>
  );
}

function WorkerCard({
  node,
  onLimitsChange,
  updating,
  onCancelJob,
  jobDetails,
  authoritativeJobs,
}: {
  node: any;
  onLimitsChange: (node: any, limits: WorkerLimits) => void;
  updating: boolean;
  onCancelJob: (id: string) => void;
  jobDetails: Map<string, any>;
  authoritativeJobs: any[];
}) {
  const limits = limitsForNode(node);
  const gpus = node.system_info?.gpus || [];
  const telemetryById = new Map<string, any>();
  (node.active_jobs || []).forEach((job: any) => {
    if (job?.id) telemetryById.set(job.id, job);
  });
  const activeJobs = authoritativeJobs.map((detail: any) => {
    const telemetry = telemetryById.get(detail.id) || {};
    return {
      ...detail,
      ...telemetry,
      // Lifecycle state comes from the jobs table; high-frequency execution
      // fields come from the node heartbeat.
      status: detail.status,
      file_name: detail.file_name || telemetry.file_name,
    };
  });
  const totalSlots = limits.cpu + limits.gpus.reduce((sum, value) => sum + value, 0);
  const computeJobsInUse = activeJobs.filter((job: any) => !job.file_operation).length;
  const ramTotal = numberValue(node.system_info?.ram_total);
  const ramUsage = percentage(node.ram_usage);

  return (
    <article className="overflow-hidden rounded-xl border border-[#39363a] bg-[#282729]">
      <header className="flex flex-col gap-3 border-b border-[#39363a] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[#365a49] bg-[#1b3027] text-[#74c69d]">
            <Server className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-white">{node.name}</h3>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                activeJobs.length > 0
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                  : 'border-[#365a49] bg-[#1b3027] text-[#8bd5ad]'
              }`}>
                {activeJobs.length > 0 ? 'Working' : 'Available'}
              </span>
            </div>
            <p className="mt-1 truncate text-[11px] text-gray-500">
              {computeJobsInUse}/{totalSlots} slots in use · {node.system_info?.cpu_cores || '—'} cores · {gpus.length} GPU{gpus.length === 1 ? '' : 's'}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold tabular-nums text-white">{Math.max(0, totalSlots - computeJobsInUse)} free</p>
          <p className="text-[10px] uppercase tracking-wider text-gray-600">worker slots</p>
        </div>
      </header>

      <div className="jobs-worker-grid grid gap-3 p-4">
        <section className="rounded-lg border border-[#39363a] bg-[#222123] p-3">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Resource load</h4>
              <p className="mt-1 text-[11px] text-gray-600">Live device utilization</p>
            </div>
            <Gauge className="h-4 w-4 text-gray-600" />
          </div>

          <div
            className="grid gap-x-4 gap-y-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
          >
            <div>
              <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                <span className="flex min-w-0 items-center gap-2 text-gray-400">
                  <Cpu className="h-3.5 w-3.5 shrink-0 text-[#74c69d]" />
                  <span className="truncate">{node.system_info?.cpu || 'CPU'}</span>
                </span>
                <span className="tabular-nums text-gray-300">{Math.round(percentage(node.cpu_usage))}%</span>
              </div>
              <ProgressBar value={node.cpu_usage} />
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="flex items-center gap-2 text-gray-400"><Database className="h-3.5 w-3.5 text-[#60a5fa]" />Memory</span>
                <span className="tabular-nums text-gray-300">{Math.round(ramUsage)}%</span>
              </div>
              <ProgressBar value={ramUsage} color="#60a5fa" />
              <p className="mt-1 text-[10px] text-gray-500">{ramTotal ? `${formatBytes(ramTotal)} installed` : 'Capacity unavailable'}</p>
            </div>

            {gpus.map((gpu: any, index: number) => {
              const color = vendorColor(gpu.vendor);
              return (
                <div key={`${gpu.name}-${index}`}>
                  <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                    <span className="flex min-w-0 items-center gap-2 text-gray-400">
                      <Monitor className="h-3.5 w-3.5 shrink-0" style={{ color }} />
                      <span className="truncate">GPU {index + 1} · {cleanGpuName(gpu.name)}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-gray-300">
                      {Math.round(percentage(gpu.utilizationGpu))}%{gpu.temperatureGpu != null ? ` · ${Math.round(numberValue(gpu.temperatureGpu))}°C` : ''}
                    </span>
                  </div>
                  <ProgressBar value={gpu.utilizationGpu} color={color} />
                  <p className="mt-1 text-[10px] text-gray-500">
                    {gpu.memory ? `${formatBytes(numberValue(gpu.memoryUsed))} / ${formatBytes(numberValue(gpu.memory))} VRAM` : 'VRAM unavailable'}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-lg border border-[#39363a] bg-[#222123] p-3">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Worker allocation</h4>
              <p className="mt-1 text-[10px] text-gray-600">Concurrent jobs</p>
            </div>
            {updating && <span className="text-[11px] text-[#74c69d]">Saving…</span>}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-gray-300"><Cpu className="h-3.5 w-3.5 text-gray-500" />CPU workers</div>
              <Stepper
                value={limits.cpu}
                max={numberValue(node.system_info?.cpu_cores, 1)}
                label={`${node.name} CPU workers`}
                disabled={updating}
                onChange={(cpu) => onLimitsChange(node, { ...limits, cpu })}
              />
            </div>
            {gpus.map((gpu: any, index: number) => (
              <div key={`${gpu.name}-workers-${index}`} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2 text-xs text-gray-300">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: vendorColor(gpu.vendor) }} />
                  <span className="truncate">GPU {index + 1}</span>
                </div>
                <Stepper
                  value={limits.gpus[index]}
                  label={`${node.name} GPU ${index + 1} workers`}
                  disabled={updating}
                  onChange={(value) => {
                    const nextGpus = [...limits.gpus];
                    nextGpus[index] = value;
                    onLimitsChange(node, { ...limits, gpus: nextGpus });
                  }}
                />
              </div>
            ))}
          </div>

        </section>
      </div>

      <section className="border-t border-[#39363a] bg-[#222123] px-4 py-3">
        <div className={`flex items-center justify-between ${activeJobs.length > 0 ? 'mb-2.5' : ''}`}>
          <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Active work</h4>
          <span className="text-[11px] text-gray-600">{activeJobs.length} running</span>
        </div>
        {activeJobs.length === 0 ? (
          <div className="flex items-center gap-2 text-[11px] text-gray-500">
            <Clock3 className="h-3.5 w-3.5" /> Idle · waiting for queued work
          </div>
        ) : (
          <div className="space-y-3">
            {activeJobs.map((activeJob: any) => {
              const job = { ...(jobDetails.get(activeJob.id) || {}), ...activeJob };
              const type = jobType(job);
              const elapsed = formatElapsed(job.started_at);
              return (
                <div key={job.id} className="grid gap-3 rounded-lg border border-[#39363a] bg-[#282729] p-3 lg:grid-cols-[minmax(0,1fr)_100px_125px_220px_32px] lg:items-center">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <type.Icon className="h-3.5 w-3.5 shrink-0" style={{ color: type.color }} />
                      <p className="truncate text-xs font-medium text-white" title={jobName(job)}>{jobName(job)}</p>
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden pl-5 text-[10px] text-gray-500">
                      <span className="shrink-0 text-gray-400">{job.current_action || type.label}</span>
                      {job.preset_name && <><span>·</span><span className="truncate">{job.preset_name}</span></>}
                      {job.target_codec && <><span>·</span><span className="shrink-0 uppercase">{job.target_codec}</span></>}
                      {job.file_size && <><span>·</span><span className="shrink-0">{formatBytes(numberValue(job.file_size))}</span></>}
                    </div>
                  </div>
                  <div>
                    <p className="text-[9px] font-medium uppercase tracking-wider text-gray-600">Device</p>
                    <p className="mt-1 text-xs font-medium text-gray-300">{job.file_operation ? 'Storage' : job.gpu != null ? `GPU ${numberValue(job.gpu) + 1}` : 'CPU'}</p>
                    {elapsed && <p className="mt-0.5 text-[10px] tabular-nums text-gray-600">running {elapsed}</p>}
                  </div>
                  <div>
                    <p className="text-[9px] font-medium uppercase tracking-wider text-gray-600">Throughput</p>
                    <p className="mt-1 text-xs tabular-nums text-gray-300">
                      {job.file_operation ? `${numberValue(job.speed_mbps).toFixed(1)} MB/s` : job.fps ? `${Math.round(numberValue(job.fps))} fps` : '— fps'}
                    </p>
                    <p className="mt-0.5 text-[10px] tabular-nums text-gray-600">
                      {job.file_operation
                        ? `${formatBytes(numberValue(job.bytes_processed))} / ${formatBytes(numberValue(job.total_bytes))}`
                        : job.ratio ? `${job.ratio} output` : 'Ratio unavailable'}
                    </p>
                  </div>
                  <div>
                    <div className="mb-1.5 flex justify-between text-[11px] text-gray-500">
                      <span>{job.file_operation ? job.current_action : job.eta ? `ETA ${job.eta}` : 'ETA unavailable'}</span><span className="font-medium text-gray-300">{percentage(job.progress).toFixed(1)}%</span>
                    </div>
                    <ProgressBar value={job.progress} />
                  </div>
                  {!job.file_operation ? <button
                    type="button"
                    onClick={() => onCancelJob(job.id)}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-[#39363a] text-gray-500 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300"
                    title="Cancel active job"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button> : <div className="grid h-8 w-8 place-items-center text-[#60a5fa]" title="Managed file operation"><HardDrive className="h-3.5 w-3.5" /></div>}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </article>
  );
}

export function Jobs() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<JobTab>('queue');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [clearTarget, setClearTarget] = useState<JobTab | null>(null);
  const [showStartJob, setShowStartJob] = useState(false);
  const [jobLibraryId, setJobLibraryId] = useState('all');
  const [analyzeSelected, setAnalyzeSelected] = useState(true);
  const [transcodeSelected, setTranscodeSelected] = useState(false);
  const [newJobQuickSelectId, setNewJobQuickSelectId] = useState('');
  const [allowGpuRouting, setAllowGpuRouting] = useState(true);
  const [allowCpuRouting, setAllowCpuRouting] = useState(false);
  const [newJobPostAction, setNewJobPostAction] = useState<'keep' | 'replace' | 'backup_replace'>('keep');
  const [includeTranscoded, setIncludeTranscoded] = useState(false);
  const [autoReplaceConfirmed, setAutoReplaceConfirmed] = useState(false);
  const [startResult, setStartResult] = useState<{ queued: number; skipped: number; total: number } | null>(null);
  const perPage = activeTab === 'queue' ? 5 : 15;

  useWebSocket({ channels: ['nodes', 'jobs'] });

  const { data: nodes = [], isFetching: nodesFetching, refetch: refetchNodes } = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.getNodes(),
    staleTime: Infinity,
  });

  const { data: libraries = [] } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => api.getLibraries(),
  });

  const { data: quickSelectPresets = [] } = useQuery({
    queryKey: ['quick-select-presets'],
    queryFn: () => api.getQuickSelectPresets(),
  });

  useEffect(() => {
    if (!newJobQuickSelectId && quickSelectPresets.length > 0) setNewJobQuickSelectId(quickSelectPresets[0].id);
  }, [newJobQuickSelectId, quickSelectPresets]);

  const { data: allJobs = [], isLoading, isFetching: jobsFetching, refetch: refetchJobs } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.getJobs(),
    staleTime: Infinity,
  });

  const { data: workerAvailability } = useQuery({
    queryKey: ['worker-availability'],
    queryFn: () => api.getWorkerAvailability(),
    staleTime: 5000,
    refetchInterval: 5000,
  });

  const onlineNodes = useMemo(
    () => nodes.filter((node: any) => node.connected || node.status === 'online'),
    [nodes],
  );

  const categorized = useMemo(() => ({
    queue: allJobs.filter((job: any) => job.status === 'queued'),
    failed: allJobs.filter((job: any) => job.status === 'failed'),
    success: allJobs.filter((job: any) => job.status === 'completed'),
  }), [allJobs]);

  const activeJobs = useMemo(
    () => allJobs.filter((job: any) => isActiveJobStatus(job.status)),
    [allJobs],
  );

  const jobDetails = useMemo(
    () => new Map<string, any>(allJobs.map((job: any) => [job.id, job])),
    [allJobs],
  );

  const stats = useMemo(() => {
    const slots = onlineNodes.reduce((sum: number, node: any) => {
      const limits = limitsForNode(node);
      return sum + limits.cpu + limits.gpus.reduce((gpuSum, value) => gpuSum + value, 0);
    }, 0);
    return {
      slots,
      free: Math.max(0, slots - activeJobs.filter((job: any) => !job.file_operation).length),
      online: onlineNodes.length,
    };
  }, [activeJobs, onlineNodes]);

  const selectedJobs = categorized[activeTab];
  const filteredJobs = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return selectedJobs;
    return selectedJobs.filter((job: any) => [
      jobName(job),
      job.preset_name,
      job.node_name,
      job.error_message,
      job.target_codec,
    ].filter(Boolean).join(' ').toLowerCase().includes(term));
  }, [search, selectedJobs]);

  const totalPages = Math.max(1, Math.ceil(filteredJobs.length / perPage));
  const currentPage = Math.min(page, totalPages);
  const displayedJobs = filteredJobs.slice((currentPage - 1) * perPage, currentPage * perPage);

  const deleteMutation = useMutation({
    mutationFn: (jobId: string) => api.deleteJob(jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['nodes'] });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (jobIds: string[]) => api.deleteJobs(jobIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['nodes'] });
    },
  });

  const updateNodeMutation = useMutation({
    mutationFn: ({ nodeId, limits }: { nodeId: string; limits: WorkerLimits }) =>
      api.updateNode(nodeId, { max_workers: limits }),
    onMutate: async ({ nodeId, limits }) => {
      await queryClient.cancelQueries({ queryKey: ['nodes'] });
      const previous = queryClient.getQueryData<any[]>(['nodes']);
      queryClient.setQueryData<any[]>(['nodes'], (current = []) =>
        current.map(node => node.id === nodeId ? { ...node, max_workers: limits } : node),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['nodes'], context.previous);
      window.alert('Failed to update worker settings. Please try again.');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['nodes'] }),
  });

  const startJobMutation = useMutation({
    mutationFn: () => api.createLibraryJob({
      library_id: jobLibraryId,
      analyze: analyzeSelected,
      transcode: transcodeSelected,
      quick_select_id: transcodeSelected ? newJobQuickSelectId : undefined,
      allow_gpu: transcodeSelected ? allowGpuRouting : undefined,
      allow_cpu: transcodeSelected ? allowCpuRouting : undefined,
      post_action: transcodeSelected ? newJobPostAction : 'keep',
      include_transcoded: transcodeSelected ? includeTranscoded : false,
    }),
    onSuccess: result => {
      setStartResult(result);
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      queryClient.invalidateQueries({ queryKey: ['files'] });
    },
  });

  const confirmClear = () => {
    if (!clearTarget) return;
    const jobs = clearTarget === 'queue'
      ? categorized.queue
      : categorized[clearTarget];
    bulkDeleteMutation.mutate(jobs.filter((job: any) => !job.file_operation).map((job: any) => job.id));
    setClearTarget(null);
  };

  const refreshing = nodesFetching || jobsFetching;
  const noWorkers = categorized.queue.length > 0
    && workerAvailability
    && !workerAvailability.hasCpuWorkers
    && !workerAvailability.hasGpuWorkers;
  const analyzeJobsBlocked = categorized.queue.some((job: any) => jobType(job).label === 'Analyze')
    && workerAvailability
    && !workerAvailability.hasCpuWorkers;

  if (isLoading) {
    return (
      <div className="grid h-64 place-items-center">
        <div className="text-center">
          <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-[#39363a] border-t-[#74c69d]" />
          <p className="mt-3 text-sm text-gray-500">Loading job orchestration…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#74c69d]">
            <Gauge className="h-3.5 w-3.5" /> Work orchestration
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Jobs</h1>
          <p className="mt-1.5 text-sm text-gray-500">Follow queued work, active encodes, and worker capacity in real time.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { setStartResult(null); setAutoReplaceConfirmed(false); setAllowGpuRouting(true); setAllowCpuRouting(false); setShowStartJob(true); }}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[#74c69d] px-4 text-xs font-semibold text-[#102019] hover:bg-[#8bd5ad]"
          >
            <Play className="h-3.5 w-3.5 fill-current" /> Start job
          </button>
          <button
            type="button"
            onClick={() => { refetchNodes(); refetchJobs(); }}
            disabled={refreshing}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[#39363a] bg-[#222123] px-3 text-xs font-medium text-gray-300 hover:bg-[#282729] disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Activity} label="Processing" value={activeJobs.length} detail="Jobs currently running" color="#74c69d" />
        <MetricCard icon={Layers3} label="Queued" value={categorized.queue.length} detail="Waiting for an available slot" color="#f59e0b" />
        <MetricCard icon={Cpu} label="Worker capacity" value={`${stats.free}/${stats.slots}`} detail="Free slots across the fleet" color="#a78bfa" />
        <MetricCard icon={Server} label="Online nodes" value={`${stats.online}/${nodes.length}`} detail={`${categorized.success.length} completed · ${categorized.failed.length} failed`} color="#60a5fa" />
      </section>

      {(noWorkers || analyzeJobsBlocked) && (
        <section className="flex items-start gap-3 rounded-xl border border-amber-600/40 bg-amber-900/20 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div>
            <p className="text-sm font-medium text-amber-200">
              {noWorkers ? 'Queued jobs have no available workers' : 'Analyze jobs need a CPU worker'}
            </p>
            <p className="mt-1 text-xs text-amber-300/70">
              {noWorkers
                ? 'Connect a node or increase its CPU/GPU worker allocation to resume assignment.'
                : 'Increase CPU worker allocation on an online node to process the waiting analysis jobs.'}
            </p>
          </div>
        </section>
      )}

      <section className={`${surfaceClass} overflow-hidden`}>
        <div className="flex flex-col gap-3 border-b border-[#39363a] p-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-1 rounded-lg bg-[#1e1d1f] p-1">
            {([
              { id: 'queue', label: 'Queue', count: categorized.queue.length, color: '#f59e0b' },
              { id: 'failed', label: 'Failed', count: categorized.failed.length, color: '#ef4444' },
              { id: 'success', label: 'Completed', count: categorized.success.length, color: '#74c69d' },
            ] as const).map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => { setActiveTab(tab.id); setPage(1); }}
                className={`rounded-md px-3 py-2 text-xs font-medium transition-colors ${activeTab === tab.id ? 'bg-[#39363a] text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >
                {tab.label} <span className="ml-1 tabular-nums" style={{ color: activeTab === tab.id ? tab.color : undefined }}>{countFormatter.format(tab.count)}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="relative block sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-600" />
              <input
                value={search}
                onChange={(event) => { setSearch(event.target.value); setPage(1); }}
                placeholder="Search jobs…"
                className="h-9 w-full rounded-lg border border-[#39363a] bg-[#1e1d1f] pl-9 pr-3 text-xs text-white outline-none placeholder:text-gray-600 focus:border-[#5b7869]"
              />
            </label>
            {selectedJobs.length > 0 && (
              <button
                type="button"
                onClick={() => setClearTarget(activeTab)}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[#39363a] px-3 text-xs font-medium text-gray-400 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear {activeTab === 'success' ? 'history' : activeTab}
              </button>
            )}
          </div>
        </div>

        {displayedJobs.length === 0 ? (
          <div className="grid min-h-52 place-items-center px-6 py-10 text-center">
            <div>
              {activeTab === 'queue' ? <Layers3 className="mx-auto h-6 w-6 text-gray-600" />
                : activeTab === 'failed' ? <CheckCircle2 className="mx-auto h-6 w-6 text-[#74c69d]" />
                  : <Clock3 className="mx-auto h-6 w-6 text-gray-600" />}
              <p className="mt-3 text-sm font-medium text-gray-300">
                {search ? 'No matching jobs' : activeTab === 'queue' ? 'Queue is clear' : activeTab === 'failed' ? 'No failed jobs' : 'No completed jobs yet'}
              </p>
              <p className="mt-1 text-xs text-gray-600">
                {search ? 'Try another filename, node, or preset.' : activeTab === 'queue' ? 'New jobs will appear here while they wait for a worker.' : 'Job history will appear here.'}
              </p>
            </div>
          </div>
        ) : (
          <div>
            {displayedJobs.map((job: any) => (
              <JobRow
                key={job.id}
                job={job}
                tab={activeTab}
                onDelete={(id) => deleteMutation.mutate(id)}
                deleting={deleteMutation.isPending && deleteMutation.variables === job.id}
              />
            ))}
          </div>
        )}

        {filteredJobs.length > perPage && (
          <footer className="flex items-center justify-between border-t border-[#39363a] px-4 py-3">
            <p className="text-xs text-gray-500">
              {countFormatter.format((currentPage - 1) * perPage + 1)}–{countFormatter.format(Math.min(currentPage * perPage, filteredJobs.length))} of {countFormatter.format(filteredJobs.length)}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage(value => Math.max(1, value - 1))}
                disabled={currentPage === 1}
                className="grid h-8 w-8 place-items-center rounded-lg border border-[#39363a] text-gray-400 disabled:opacity-30"
              ><ChevronLeft className="h-4 w-4" /></button>
              <span className="min-w-20 text-center text-xs text-gray-400">{currentPage} / {totalPages}</span>
              <button
                type="button"
                onClick={() => setPage(value => Math.min(totalPages, value + 1))}
                disabled={currentPage === totalPages}
                className="grid h-8 w-8 place-items-center rounded-lg border border-[#39363a] text-gray-400 disabled:opacity-30"
              ><ChevronRight className="h-4 w-4" /></button>
            </div>
          </footer>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">Worker execution</h2>
            <p className="mt-1 text-xs text-gray-500">Live utilization and concurrency for connected nodes.</p>
          </div>
          <span className="text-xs text-gray-500">{onlineNodes.length} online</span>
        </div>

        {onlineNodes.length === 0 ? (
          <div className={`${surfaceClass} grid min-h-48 place-items-center p-8 text-center`}>
            <div>
              <Server className="mx-auto h-6 w-6 text-gray-600" />
              <p className="mt-3 text-sm font-medium text-gray-300">No nodes online</p>
              <p className="mt-1 text-xs text-gray-600">Start an Encorr node to process queued work.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {onlineNodes.map((node: any) => (
              <WorkerCard
                key={node.id}
                node={node}
                updating={updateNodeMutation.isPending && updateNodeMutation.variables?.nodeId === node.id}
                onLimitsChange={(targetNode, limits) => updateNodeMutation.mutate({ nodeId: targetNode.id, limits })}
                onCancelJob={(id) => deleteMutation.mutate(id)}
                jobDetails={jobDetails}
                authoritativeJobs={activeJobs.filter((job: any) => job.node_id === node.id)}
              />
            ))}
          </div>
        )}
      </section>

      {showStartJob && (
        <Dialog
          open
          onClose={() => { if (!startJobMutation.isPending) setShowStartJob(false); }}
          title="Start a library job"
          size="lg"
        >
          {startResult ? (
            <div className="space-y-5">
              <div className="rounded-xl border border-[#365a49] bg-[#1b3027] p-5 text-center">
                <CheckCircle2 className="mx-auto h-8 w-8 text-[#74c69d]" />
                <p className="mt-3 text-xl font-semibold text-white">{countFormatter.format(startResult.queued)} jobs queued</p>
                <p className="mt-1 text-sm text-gray-400">
                  {countFormatter.format(startResult.skipped)} of {countFormatter.format(startResult.total)} files were skipped because they were not eligible or already queued.
                </p>
              </div>
              <div className="flex justify-end">
                <button type="button" onClick={() => setShowStartJob(false)} className="h-9 rounded-lg bg-[#74c69d] px-5 text-xs font-semibold text-[#102019]">Done</button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">Library</label>
                <select
                  value={jobLibraryId}
                  onChange={event => setJobLibraryId(event.target.value)}
                  className="mt-2 h-10 w-full rounded-lg border border-[#39363a] bg-[#1e1d1f] px-3 text-sm text-white outline-none focus:border-[#5b7869]"
                >
                  <option value="all">All libraries</option>
                  {libraries.map((library: any) => <option key={library.id} value={library.id}>{library.name} · {countFormatter.format(library.file_count || 0)} files</option>)}
                </select>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">What should Encorr do?</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {([
                    { id: 'analyze', selected: analyzeSelected, toggle: () => setAnalyzeSelected(value => !value), title: 'Analyze files', detail: 'Read metadata where it is missing. When combined with transcode, each transcode waits for its analysis.', Icon: Scan },
                    { id: 'transcode', selected: transcodeSelected, toggle: () => setTranscodeSelected(value => !value), title: 'Transcode files', detail: 'Process analyzed files—or files analyzed by this same workflow—with the selected preset.', Icon: Film },
                  ] as const).map(option => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={option.toggle}
                      aria-pressed={option.selected}
                      className={`relative rounded-xl border p-4 text-left ${option.selected ? 'border-[#5b8f75] bg-[#1b3027]' : 'border-[#39363a] bg-[#222123]'}`}
                    >
                      <span className={`absolute right-3 top-3 grid h-5 w-5 place-items-center rounded border ${option.selected ? 'border-[#74c69d] bg-[#74c69d] text-[#102019]' : 'border-[#4a474b] text-transparent'}`}><CheckCircle2 className="h-3.5 w-3.5" /></span>
                      <option.Icon className={`h-5 w-5 ${option.selected ? 'text-[#74c69d]' : 'text-gray-500'}`} />
                      <p className="mt-3 text-sm font-semibold text-white">{option.title}</p>
                      <p className="mt-1 text-xs leading-5 text-gray-500">{option.detail}</p>
                    </button>
                  ))}
                </div>
                {!analyzeSelected && !transcodeSelected && <p className="mt-2 text-xs text-amber-300">Select at least one operation. You can select both.</p>}
              </div>

              {transcodeSelected && (
                <>
                  <div>
                    <label className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">Quick Select routing</label>
                    <select
                      value={newJobQuickSelectId}
                      onChange={event => setNewJobQuickSelectId(event.target.value)}
                      className="mt-2 h-10 w-full rounded-lg border border-[#39363a] bg-[#1e1d1f] px-3 text-sm text-white outline-none focus:border-[#5b7869]"
                    >
                      {quickSelectPresets.map((preset: any) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                    </select>
                    {quickSelectPresets.find((preset: any) => preset.id === newJobQuickSelectId)?.description && (
                      <p className="mt-2 text-xs leading-5 text-gray-500">{quickSelectPresets.find((preset: any) => preset.id === newJobQuickSelectId)?.description}</p>
                    )}
                    <p className="mt-2 text-xs leading-5 text-blue-300/80">The server resolves this route against compatible workers at assignment time, using only the worker types enabled below.</p>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">Allowed worker types</p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={allowGpuRouting}
                        onClick={() => setAllowGpuRouting(value => !value)}
                        className={`flex items-center justify-between rounded-lg border p-3 text-left ${allowGpuRouting ? 'border-[#5b8f75] bg-[#1b3027]' : 'border-[#39363a] bg-[#222123]'}`}
                      >
                        <span><span className="block text-sm font-medium text-white">GPU transcoding</span><span className="mt-0.5 block text-xs text-gray-500">NVIDIA, AMD, and Intel routes</span></span>
                        <span className={`relative h-5 w-9 rounded-full transition-colors ${allowGpuRouting ? 'bg-[#74c69d]' : 'bg-[#454247]'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${allowGpuRouting ? 'translate-x-[18px]' : 'translate-x-0.5'}`} /></span>
                      </button>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={allowCpuRouting}
                        onClick={() => setAllowCpuRouting(value => !value)}
                        className={`flex items-center justify-between rounded-lg border p-3 text-left ${allowCpuRouting ? 'border-[#5b8f75] bg-[#1b3027]' : 'border-[#39363a] bg-[#222123]'}`}
                      >
                        <span><span className="block text-sm font-medium text-white">CPU transcoding</span><span className="mt-0.5 block text-xs text-gray-500">Portable fallback route</span></span>
                        <span className={`relative h-5 w-9 rounded-full transition-colors ${allowCpuRouting ? 'bg-[#74c69d]' : 'bg-[#454247]'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${allowCpuRouting ? 'translate-x-[18px]' : 'translate-x-0.5'}`} /></span>
                      </button>
                    </div>
                    {!allowGpuRouting && !allowCpuRouting && <p className="mt-2 text-xs text-amber-300">Enable at least one worker type.</p>}
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">After each transcode</p>
                    <div className="mt-2 space-y-2">
                      {([
                        { id: 'keep', title: 'Keep output separate', detail: 'Safest option. The transcoded output remains available in the Transcoded section for manual review.' },
                        { id: 'backup_replace', title: 'Backup & Replace', detail: 'Rename the original to .org, then install the transcoded file. You can remove the backup later.' },
                        { id: 'replace', title: 'Replace Original', detail: 'Automatically install the transcoded file without retaining an original backup.' },
                      ] as const).map(option => (
                        <label key={option.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${newJobPostAction === option.id ? 'border-[#5b8f75] bg-[#1b3027]' : 'border-[#39363a] bg-[#222123]'}`}>
                          <input type="radio" name="post-action" checked={newJobPostAction === option.id} onChange={() => { setNewJobPostAction(option.id); setAutoReplaceConfirmed(false); }} className="mt-1 accent-[#74c69d]" />
                          <span><span className="block text-sm font-medium text-white">{option.title}</span><span className="mt-0.5 block text-xs leading-5 text-gray-500">{option.detail}</span></span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <label className="flex items-start gap-3 rounded-lg border border-[#39363a] bg-[#222123] p-3">
                    <input type="checkbox" checked={includeTranscoded} onChange={event => setIncludeTranscoded(event.target.checked)} className="mt-0.5 accent-[#74c69d]" />
                    <span><span className="block text-sm text-gray-300">Include files that already have a completed transcode</span><span className="mt-0.5 block text-xs text-gray-500">Normally these are skipped to avoid generating duplicate outputs.</span></span>
                  </label>

                  {newJobPostAction === 'replace' && (
                    <label className="flex cursor-pointer gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs leading-5 text-red-200">
                      <input type="checkbox" checked={autoReplaceConfirmed} onChange={event => setAutoReplaceConfirmed(event.target.checked)} className="mt-1 shrink-0 accent-red-500" />
                      <span><span className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-4 w-4" /> Confirm automatic replacement</span><span className="mt-1 block">I understand that originals will be replaced automatically as each transcode completes and no .org backup will be retained.</span></span>
                    </label>
                  )}
                </>
              )}

              {startJobMutation.isError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{startJobMutation.error instanceof Error ? startJobMutation.error.message : 'Could not create jobs.'}</div>
              )}

              <div className="flex justify-end gap-2 border-t border-[#39363a] pt-4">
                <button type="button" onClick={() => setShowStartJob(false)} disabled={startJobMutation.isPending} className="h-9 rounded-lg border border-[#39363a] px-4 text-xs font-medium text-gray-300 disabled:opacity-40">Cancel</button>
                <button
                  type="button"
                  onClick={() => startJobMutation.mutate()}
                  disabled={startJobMutation.isPending || libraries.length === 0 || (!analyzeSelected && !transcodeSelected) || (transcodeSelected && (!newJobQuickSelectId || (!allowGpuRouting && !allowCpuRouting) || (newJobPostAction === 'replace' && !autoReplaceConfirmed)))}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#74c69d] px-5 text-xs font-semibold text-[#102019] disabled:opacity-40"
                >
                  {startJobMutation.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />}
                  {startJobMutation.isPending ? 'Queueing…' : 'Start jobs'}
                </button>
              </div>
            </div>
          )}
        </Dialog>
      )}

      {clearTarget && (
        <Dialog
          open
          onClose={() => setClearTarget(null)}
          title={clearTarget === 'queue' ? 'Cancel queued jobs' : `Clear ${clearTarget === 'success' ? 'completed' : 'failed'} history`}
        >
          <div className="space-y-5">
            <p className="text-sm text-gray-300">
              {clearTarget === 'queue'
                ? `Remove all ${categorized.queue.length} jobs that are still queued? Active work will continue.`
                : `Remove all ${categorized[clearTarget].length} ${clearTarget === 'success' ? 'completed' : 'failed'} jobs from history?`}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setClearTarget(null)}
                className="h-9 rounded-lg border border-[#39363a] px-4 text-xs font-medium text-gray-300"
              >Keep jobs</button>
              <button
                type="button"
                onClick={confirmClear}
                className="h-9 rounded-lg bg-red-600 px-4 text-xs font-medium text-white hover:bg-red-500"
              >{clearTarget === 'queue' ? 'Cancel jobs' : 'Clear history'}</button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
