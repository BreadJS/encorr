import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Cpu,
  Database,
  FileVideo,
  Folder,
  Gauge,
  HardDrive,
  ListTodo,
  RefreshCw,
  Server,
  Sparkles,
  Thermometer,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { api, formatBytes } from '@/utils/api';
import { useWebSocket } from '@/hooks/useWebSocket';

const PANEL = 'rounded-2xl border border-[#39363a] bg-[#282729]';
const MUTED_PANEL = 'rounded-xl border border-[#39363a]/80 bg-[#222123]';

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function percentage(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return 'Just now';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function shortFileName(path?: string): string {
  if (!path) return 'Unknown file';
  return path.split(/[\\/]/).pop() || path;
}

function formatActivityMessage(log: any, jobs: any[]): string {
  if (log.category !== 'job') return log.message;

  const metadataJobId = typeof log.metadata?.job_id === 'string' ? log.metadata.job_id : undefined;
  const job = metadataJobId
    ? jobs.find((item: any) => item.id === metadataJobId)
    : jobs.find((item: any) => typeof log.message === 'string' && log.message.includes(item.id));

  if (!job?.file_name) return log.message;

  const fileName = shortFileName(job.file_name);
  return log.message
    .replace(`Job ${job.id}`, fileName)
    .replace(job.id, fileName);
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  accent = '#74c69d',
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: typeof Server;
  accent?: string;
}) {
  return (
    <div className={`${PANEL} relative overflow-hidden p-5`}>
      <div
        className="absolute -right-8 -top-10 h-28 w-28 rounded-full opacity-[0.08] blur-2xl"
        style={{ backgroundColor: accent }}
      />
      <div className="relative flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">{label}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-white">{value}</p>
          <p className="mt-1.5 text-xs text-gray-400">{detail}</p>
        </div>
        <div className="rounded-xl p-2.5" style={{ backgroundColor: `${accent}18`, color: accent }}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function UsageBar({ value, color = '#74c69d' }: { value: number; color?: string }) {
  const normalized = Math.min(100, Math.max(0, value));
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${normalized}%`, backgroundColor: color }}
      />
    </div>
  );
}

export function Dashboard() {
  const { isConnected } = useWebSocket({ channels: ['nodes', 'jobs'] });

  const statsQuery = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.getStats(),
    refetchInterval: 15000,
  });
  const librariesQuery = useQuery({
    queryKey: ['libraries'],
    queryFn: () => api.getLibraries(),
    staleTime: 30000,
  });
  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.getNodes(),
    staleTime: 10000,
  });
  const jobsQuery = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.getJobs(),
    staleTime: 10000,
  });
  const logsQuery = useQuery({
    queryKey: ['dashboard-logs'],
    queryFn: () => api.getLogs({ limit: 8 }),
    refetchInterval: 15000,
  });

  const stats = statsQuery.data;
  const libraries = librariesQuery.data || [];
  const nodes = nodesQuery.data || [];
  const jobs = jobsQuery.data || [];
  const logs = logsQuery.data || [];
  const isLoading = statsQuery.isLoading || nodesQuery.isLoading || jobsQuery.isLoading;
  const isRefreshing = statsQuery.isFetching || librariesQuery.isFetching || nodesQuery.isFetching || jobsQuery.isFetching || logsQuery.isFetching;

  const activeJobs = jobs.filter((job: any) => job.status === 'processing' || job.status === 'assigned');
  const queuedJobs = jobs.filter((job: any) => job.status === 'queued');
  const onlineNodes = nodes.filter((node: any) => node.connected || node.status === 'online' || node.status === 'busy');
  const totalLibraryFiles = libraries.reduce((sum: number, library: any) => sum + safeNumber(library.file_count), 0);

  const completedJobs = safeNumber(stats?.jobs?.completed);
  const failedJobs = safeNumber(stats?.jobs?.failed);
  const processingJobs = safeNumber(stats?.jobs?.processing);
  const totalFinishedJobs = completedJobs + failedJobs;
  const successRate = percentage(completedJobs, totalFinishedJobs);
  const originalSize = safeNumber(stats?.storage?.original_size);
  const transcodedSize = safeNumber(stats?.storage?.transcoded_size);
  const savedSpace = safeNumber(stats?.storage?.saved_space);
  const replacedFiles = safeNumber(stats?.storage?.replaced_files);
  const retainedBackups = safeNumber(stats?.storage?.backup_retained);
  const storageReduction = percentage(savedSpace, originalSize);

  const totalWorkerSlots = nodes.reduce((sum: number, node: any) => {
    const cpuWorkers = safeNumber(node.max_workers?.cpu);
    const gpuWorkers = (node.max_workers?.gpus || []).reduce((gpuSum: number, slots: unknown) => gpuSum + safeNumber(slots), 0);
    return sum + cpuWorkers + gpuWorkers;
  }, 0);
  const activeWorkerSlots = activeJobs.length;

  const refreshAll = () => {
    void Promise.all([
      statsQuery.refetch(),
      librariesQuery.refetch(),
      nodesQuery.refetch(),
      jobsQuery.refetch(),
      logsQuery.refetch(),
    ]);
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-gray-400">
          <RefreshCw className="h-6 w-6 animate-spin text-[#74c69d]" />
          <span className="text-sm">Loading operations overview…</span>
        </div>
      </div>
    );
  }

  const systemHealthy = onlineNodes.length > 0 && failedJobs === 0;
  const systemLabel = onlineNodes.length === 0
    ? 'No nodes connected'
    : systemHealthy
      ? 'All systems operational'
      : failedJobs > 0
        ? `${failedJobs} failed ${failedJobs === 1 ? 'job' : 'jobs'} need attention`
        : 'System online';

  return (
    <div className="mx-auto max-w-[1600px] space-y-5 pb-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#74c69d]">
            <Activity className="h-3.5 w-3.5" />
            Operations center
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Dashboard</h1>
          <p className="mt-1.5 text-sm text-gray-400">Your transcoding fleet, queue, and storage impact at a glance.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-full border border-[#39363a] bg-[#282729] px-3 py-2 text-xs text-gray-300">
            {isConnected ? <Wifi className="h-3.5 w-3.5 text-[#74c69d]" /> : <WifiOff className="h-3.5 w-3.5 text-amber-400" />}
            {isConnected ? 'Live updates' : 'Polling updates'}
          </div>
          <button
            onClick={refreshAll}
            disabled={isRefreshing}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[#39363a] bg-[#282729] text-gray-400 transition-colors hover:border-[#74c69d]/50 hover:text-[#74c69d] disabled:opacity-50"
            aria-label="Refresh dashboard"
            title="Refresh dashboard"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <section className={`${PANEL} relative overflow-hidden px-5 py-5 sm:px-7 sm:py-6`}>
        <div className="absolute inset-y-0 right-0 hidden w-1/3 bg-gradient-to-l from-[#74c69d]/[0.07] to-transparent lg:block" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4">
            <div className={`mt-0.5 rounded-2xl p-3 ${onlineNodes.length > 0 ? 'bg-[#74c69d]/10 text-[#74c69d]' : 'bg-amber-500/10 text-amber-400'}`}>
              {onlineNodes.length > 0 ? <CheckCircle2 className="h-6 w-6" /> : <AlertTriangle className="h-6 w-6" />}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-white">{systemLabel}</h2>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${onlineNodes.length > 0 ? 'bg-[#74c69d]/10 text-[#95d5b2]' : 'bg-amber-500/10 text-amber-300'}`}>
                  {onlineNodes.length > 0 ? 'Online' : 'Attention'}
                </span>
              </div>
              <p className="mt-1 max-w-xl text-sm text-gray-400">
                {activeJobs.length > 0
                  ? `${activeJobs.length} ${activeJobs.length === 1 ? 'job is' : 'jobs are'} actively using ${onlineNodes.length} connected ${onlineNodes.length === 1 ? 'node' : 'nodes'}.`
                  : queuedJobs.length > 0
                    ? `${queuedJobs.length} queued ${queuedJobs.length === 1 ? 'job is' : 'jobs are'} waiting for an available worker.`
                    : 'The queue is clear and ready for new files.'}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 divide-x divide-[#39363a] rounded-xl border border-[#39363a] bg-black/10 px-2 py-3 sm:min-w-[390px]">
            <div className="px-3 text-center">
              <p className="text-xl font-semibold text-white">{activeJobs.length}</p>
              <p className="mt-0.5 text-[11px] text-gray-500">Active</p>
            </div>
            <div className="px-3 text-center">
              <p className="text-xl font-semibold text-white">{queuedJobs.length}</p>
              <p className="mt-0.5 text-[11px] text-gray-500">Queued</p>
            </div>
            <div className="px-3 text-center">
              <p className="text-xl font-semibold text-white">{totalWorkerSlots}</p>
              <p className="mt-0.5 text-[11px] text-gray-500">Worker slots</p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Node fleet"
          value={`${onlineNodes.length}/${nodes.length}`}
          detail={`${safeNumber(stats?.nodes?.busy)} busy · ${safeNumber(stats?.nodes?.offline)} offline`}
          icon={Server}
        />
        <MetricCard
          label="Queue workload"
          value={safeNumber(stats?.jobs?.queued) + processingJobs}
          detail={`${processingJobs} processing · ${safeNumber(stats?.jobs?.queued)} waiting`}
          icon={ListTodo}
          accent="#a78bfa"
        />
        <MetricCard
          label="Managed files"
          value={totalLibraryFiles || safeNumber(stats?.files?.total)}
          detail={`${safeNumber(stats?.files?.completed)} completed · ${safeNumber(stats?.files?.pending)} pending`}
          icon={FileVideo}
          accent="#60a5fa"
        />
        <MetricCard
          label="Storage reclaimed"
          value={formatBytes(savedSpace)}
          detail={replacedFiles > 0
            ? `${storageReduction}% across ${replacedFiles} confirmed ${replacedFiles === 1 ? 'replacement' : 'replacements'}`
            : 'No confirmed file replacements yet'}
          icon={HardDrive}
          accent="#fbbf24"
        />
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.75fr)]">
        <div className={`${PANEL} overflow-hidden`}>
          <div className="flex items-center justify-between border-b border-[#39363a] px-5 py-4">
            <div>
              <h2 className="font-semibold text-white">Active workload</h2>
              <p className="mt-0.5 text-xs text-gray-500">Jobs currently assigned to your fleet</p>
            </div>
            <Link to="/jobs" className="flex items-center gap-1.5 text-xs font-medium text-[#95d5b2] hover:text-[#b7e4c7]">
              Open queue <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="p-3">
            {activeJobs.length === 0 ? (
              <div className="flex min-h-52 flex-col items-center justify-center px-5 text-center">
                <div className="rounded-2xl bg-[#74c69d]/10 p-3 text-[#74c69d]"><CheckCircle2 className="h-6 w-6" /></div>
                <p className="mt-3 text-sm font-medium text-white">No active transcodes</p>
                <p className="mt-1 max-w-xs text-xs leading-5 text-gray-500">Your workers are idle. Add analyzed files to the queue when you are ready.</p>
                <Link to="/files" className="mt-4 flex items-center gap-1.5 text-xs font-medium text-[#95d5b2]">Browse files <ArrowRight className="h-3.5 w-3.5" /></Link>
              </div>
            ) : (
              <div className="space-y-2">
                {activeJobs.slice(0, 5).map((job: any) => {
                  const progress = Math.min(100, Math.max(0, safeNumber(job.progress)));
                  return (
                    <div key={job.id} className={`${MUTED_PANEL} p-4`}>
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="relative flex h-2 w-2 shrink-0">
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#74c69d] opacity-50" />
                              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#74c69d]" />
                            </span>
                            <p className="truncate text-sm font-medium text-white">{shortFileName(job.file_name)}</p>
                          </div>
                          <p className="mt-1 truncate pl-4 text-xs text-gray-500">{job.preset_name || 'Default preset'} · {job.node_name || 'Assigning node'}</p>
                        </div>
                        <span className="shrink-0 font-mono text-sm text-[#95d5b2]">{Math.round(progress)}%</span>
                      </div>
                      <div className="mt-3"><UsageBar value={progress} /></div>
                      <div className="mt-2 flex items-center justify-between text-[11px] text-gray-500">
                        <span className="truncate">{job.current_action || (job.status === 'assigned' ? 'Preparing worker…' : 'Transcoding…')}</span>
                        <span className="ml-3 shrink-0">{job.target_codec?.toUpperCase() || 'VIDEO'}</span>
                      </div>
                    </div>
                  );
                })}
                {activeJobs.length > 5 && <p className="py-2 text-center text-xs text-gray-500">+{activeJobs.length - 5} more active jobs</p>}
              </div>
            )}
          </div>
        </div>

        <div className={`${PANEL} overflow-hidden`}>
          <div className="border-b border-[#39363a] px-5 py-4">
            <h2 className="font-semibold text-white">Job performance</h2>
            <p className="mt-0.5 text-xs text-gray-500">Lifetime completion health</p>
          </div>
          <div className="space-y-6 p-5">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-4xl font-semibold tracking-tight text-white">{successRate}%</p>
                <p className="mt-1 text-xs text-gray-500">Successful finished jobs</p>
              </div>
              <div className="rounded-xl bg-[#74c69d]/10 p-2.5 text-[#74c69d]"><Gauge className="h-5 w-5" /></div>
            </div>
            <div>
              <div className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.05]">
                <div className="bg-[#74c69d]" style={{ width: `${percentage(completedJobs, Math.max(1, totalFinishedJobs))}%` }} />
                <div className="bg-red-400" style={{ width: `${percentage(failedJobs, Math.max(1, totalFinishedJobs))}%` }} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className={`${MUTED_PANEL} p-3`}>
                  <div className="flex items-center gap-2 text-xs text-gray-400"><span className="h-2 w-2 rounded-full bg-[#74c69d]" />Completed</div>
                  <p className="mt-2 text-xl font-semibold text-white">{completedJobs}</p>
                </div>
                <div className={`${MUTED_PANEL} p-3`}>
                  <div className="flex items-center gap-2 text-xs text-gray-400"><span className="h-2 w-2 rounded-full bg-red-400" />Failed</div>
                  <p className="mt-2 text-xl font-semibold text-white">{failedJobs}</p>
                </div>
              </div>
            </div>
            <div className="border-t border-[#39363a] pt-4">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="text-gray-400">Worker utilization</span>
                <span className="font-medium text-white">{activeWorkerSlots}/{totalWorkerSlots} slots</span>
              </div>
              <UsageBar value={percentage(activeWorkerSlots, totalWorkerSlots)} color="#a78bfa" />
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <div className={`${PANEL} overflow-hidden`}>
          <div className="flex items-center justify-between border-b border-[#39363a] px-5 py-4">
            <div>
              <h2 className="font-semibold text-white">Node fleet</h2>
              <p className="mt-0.5 text-xs text-gray-500">Live resource utilization</p>
            </div>
            <Link to="/nodes" className="flex items-center gap-1.5 text-xs font-medium text-[#95d5b2] hover:text-[#b7e4c7]">Manage nodes <ArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          <div className="space-y-2 p-3">
            {nodes.length === 0 ? (
              <div className="flex min-h-40 flex-col items-center justify-center text-center"><Server className="h-6 w-6 text-gray-600" /><p className="mt-3 text-sm text-gray-400">No nodes registered</p></div>
            ) : nodes.slice(0, 4).map((node: any) => {
              const online = node.connected || node.status === 'online' || node.status === 'busy';
              const gpus = node.system_info?.gpus || [];
              const gpuWorkerSlots = node.max_workers?.gpus || [];
              return (
                <div key={node.id} className={`${MUTED_PANEL} p-4`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className={`rounded-lg p-2 ${online ? 'bg-[#74c69d]/10 text-[#74c69d]' : 'bg-white/[0.04] text-gray-600'}`}><Server className="h-4 w-4" /></div>
                      <div className="min-w-0"><p className="truncate text-sm font-medium text-white">{node.name}</p><p className="mt-0.5 text-[11px] text-gray-500">{node.system_info?.platform || node.system_info?.os || 'Unknown system'} · {safeNumber(node.active_jobs?.length)} active</p></div>
                    </div>
                    <span className={`flex items-center gap-1.5 text-[11px] font-medium ${online ? 'text-[#95d5b2]' : 'text-gray-500'}`}><span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-[#74c69d]' : 'bg-gray-600'}`} />{online ? 'Online' : 'Offline'}</span>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div><div className="mb-1.5 flex justify-between text-[11px]"><span className="flex items-center gap-1 text-gray-500"><Cpu className="h-3 w-3" />CPU</span><span className="text-gray-300">{Math.round(safeNumber(node.cpu_usage))}%</span></div><UsageBar value={safeNumber(node.cpu_usage)} /></div>
                    <div><div className="mb-1.5 flex justify-between text-[11px]"><span className="flex items-center gap-1 text-gray-500"><Database className="h-3 w-3" />Memory</span><span className="text-gray-300">{Math.round(safeNumber(node.ram_usage))}%</span></div><UsageBar value={safeNumber(node.ram_usage)} color="#60a5fa" /></div>
                  </div>
                  {gpus.length > 0 && (
                    <div className="mt-4 space-y-2 border-t border-[#39363a]/80 pt-3">
                      {gpus.map((gpu: any, gpuIndex: number) => {
                        const utilization = safeNumber(gpu.utilizationGpu ?? node.gpu_usage?.[gpuIndex]);
                        const memoryTotal = safeNumber(gpu.memory);
                        const memoryUsed = safeNumber(gpu.memoryUsed) || Math.max(0, memoryTotal - safeNumber(gpu.memoryFree));
                        const temperature = safeNumber(gpu.temperatureGpu);
                        const powerDraw = safeNumber(gpu.powerDraw);
                        const workerSlots = safeNumber(gpuWorkerSlots[gpuIndex]);

                        return (
                          <div key={`${node.id}-gpu-${gpuIndex}`} className="rounded-lg bg-black/10 px-3 py-2.5">
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex min-w-0 items-center gap-2">
                                <Zap className="h-3.5 w-3.5 shrink-0 text-[#a78bfa]" />
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-medium text-gray-200">{gpu.name || `GPU ${gpuIndex + 1}`}</p>
                                  <p className="mt-0.5 text-[10px] uppercase tracking-wider text-gray-600">GPU {gpuIndex + 1} · {workerSlots} worker {workerSlots === 1 ? 'slot' : 'slots'}</p>
                                </div>
                              </div>
                              <span className="shrink-0 font-mono text-xs text-[#c4b5fd]">{Math.round(utilization)}%</span>
                            </div>
                            <div className="mt-2.5"><UsageBar value={utilization} color="#a78bfa" /></div>
                            <div className="mt-2.5 grid grid-cols-3 gap-2 text-[10px]">
                              <div>
                                <p className="text-gray-600">VRAM</p>
                                <p className="mt-0.5 truncate text-gray-400">{memoryTotal > 0 ? `${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)}` : 'Unavailable'}</p>
                              </div>
                              <div>
                                <p className="flex items-center gap-1 text-gray-600"><Thermometer className="h-2.5 w-2.5" />Temp</p>
                                <p className="mt-0.5 text-gray-400">{temperature > 0 ? `${Math.round(temperature)}°C` : 'Unavailable'}</p>
                              </div>
                              <div>
                                <p className="flex items-center gap-1 text-gray-600"><Zap className="h-2.5 w-2.5" />Power</p>
                                <p className="mt-0.5 text-gray-400">{powerDraw > 0 ? `${powerDraw.toFixed(0)} W` : 'Unavailable'}</p>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className={`${PANEL} overflow-hidden`}>
          <div className="flex items-center justify-between border-b border-[#39363a] px-5 py-4">
            <div><h2 className="font-semibold text-white">Recent activity</h2><p className="mt-0.5 text-xs text-gray-500">Latest system and job events</p></div>
            <Activity className="h-4 w-4 text-gray-600" />
          </div>
          <div className="divide-y divide-[#39363a]/70 px-5">
            {logs.length === 0 ? (
              <div className="flex min-h-40 flex-col items-center justify-center text-center"><Clock3 className="h-6 w-6 text-gray-600" /><p className="mt-3 text-sm text-gray-400">No recent activity</p></div>
            ) : logs.slice(0, 7).map((log: any) => {
              const isError = log.level === 'error';
              const isWarning = log.level === 'warning';
              const activityMessage = formatActivityMessage(log, jobs);
              return (
                <div key={log.id} className="flex gap-3 py-3.5">
                  <div className={`mt-1 h-2 w-2 shrink-0 rounded-full ${isError ? 'bg-red-400' : isWarning ? 'bg-amber-400' : 'bg-[#74c69d]'}`} />
                  <div className="min-w-0 flex-1"><p className="truncate text-sm text-gray-300" title={activityMessage}>{activityMessage}</p><p className="mt-1 text-[11px] capitalize text-gray-600">{log.category || 'system'} · {formatRelativeTime(log.timestamp)}</p></div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.65fr)]">
        <div className={`${PANEL} p-5`}>
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2"><HardDrive className="h-4 w-4 text-amber-300" /><h2 className="font-semibold text-white">Confirmed storage impact</h2></div>
              <p className="mt-1.5 text-xs text-gray-500">
                Based only on replaced originals{retainedBackups > 0 ? ` · ${retainedBackups} retained ${retainedBackups === 1 ? 'backup is' : 'backups are'} not counted yet` : ''}.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-6 sm:text-right">
              <div><p className="text-[10px] uppercase tracking-wider text-gray-600">Original</p><p className="mt-1 text-sm font-medium text-gray-300">{formatBytes(originalSize)}</p></div>
              <div><p className="text-[10px] uppercase tracking-wider text-gray-600">Output</p><p className="mt-1 text-sm font-medium text-gray-300">{formatBytes(transcodedSize)}</p></div>
              <div><p className="text-[10px] uppercase tracking-wider text-[#74c69d]">Saved</p><p className="mt-1 text-sm font-semibold text-[#95d5b2]">{formatBytes(savedSpace)}</p></div>
            </div>
          </div>
          <div className="mt-5"><UsageBar value={storageReduction} color="#fbbf24" /></div>
          <div className="mt-4 flex justify-end">
            <Link to="/storage" className="flex items-center gap-1.5 text-xs font-medium text-[#95d5b2] hover:text-[#b7e4c7]">
              View reclaim details <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        <div className={`${PANEL} flex flex-col justify-between p-5`}>
          <div className="flex items-center justify-between"><div><p className="text-xs font-medium text-gray-400">Media libraries</p><p className="mt-1 text-2xl font-semibold text-white">{libraries.length}</p></div><div className="rounded-xl bg-[#60a5fa]/10 p-2.5 text-[#60a5fa]"><Folder className="h-5 w-5" /></div></div>
          <div className="mt-4 flex items-center justify-between text-xs text-gray-500"><span>{totalLibraryFiles} indexed files</span><Link to="/library" className="flex items-center gap-1 text-[#95d5b2] hover:text-[#b7e4c7]">Manage <ArrowRight className="h-3 w-3" /></Link></div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <Link to="/files" className={`${MUTED_PANEL} flex items-center gap-3 p-4`}><div className="rounded-lg bg-[#74c69d]/10 p-2 text-[#74c69d]"><Sparkles className="h-4 w-4" /></div><div className="min-w-0 flex-1"><p className="text-sm font-medium text-white">Start transcoding</p><p className="truncate text-xs text-gray-500">Select analyzed files</p></div><ArrowRight className="h-4 w-4 text-gray-600" /></Link>
        <Link to="/jobs" className={`${MUTED_PANEL} flex items-center gap-3 p-4`}><div className="rounded-lg bg-[#a78bfa]/10 p-2 text-[#a78bfa]"><ListTodo className="h-4 w-4" /></div><div className="min-w-0 flex-1"><p className="text-sm font-medium text-white">Review queue</p><p className="truncate text-xs text-gray-500">{queuedJobs.length} waiting · {activeJobs.length} active</p></div><ArrowRight className="h-4 w-4 text-gray-600" /></Link>
        <Link to="/nodes" className={`${MUTED_PANEL} flex items-center gap-3 p-4`}><div className="rounded-lg bg-[#60a5fa]/10 p-2 text-[#60a5fa]"><Server className="h-4 w-4" /></div><div className="min-w-0 flex-1"><p className="text-sm font-medium text-white">Configure workers</p><p className="truncate text-xs text-gray-500">{totalWorkerSlots} slots across {nodes.length} nodes</p></div><ArrowRight className="h-4 w-4 text-gray-600" /></Link>
      </section>
    </div>
  );
}
