import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  ArrowDownRight,
  CheckCircle2,
  Database,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import { api, formatBytes } from '@/utils/api';

const PANEL = 'rounded-2xl border border-[#39363a] bg-[#282729]';
const numberFormatter = new Intl.NumberFormat();

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function percentage(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
}

function formatDate(timestamp?: number | null): string {
  if (!timestamp) return 'Pending';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp * 1000));
}

function statusPresentation(status: string) {
  if (status === 'reclaimed') return { label: 'Reclaimed', color: 'bg-[#74c69d]/10 text-[#95d5b2]', icon: CheckCircle2 };
  if (status === 'backup_retained') return { label: 'Backup retained', color: 'bg-amber-400/10 text-amber-300', icon: Archive };
  if (status === 'failed') return { label: 'Failed', color: 'bg-red-400/10 text-red-300', icon: AlertTriangle };
  return { label: 'Replacement pending', color: 'bg-blue-400/10 text-blue-300', icon: RefreshCw };
}

function SummaryCard({ label, value, detail, icon: Icon, accent }: {
  label: string;
  value: string;
  detail: string;
  icon: typeof HardDrive;
  accent: string;
}) {
  return (
    <div className={`${PANEL} p-5`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500">{label}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-white">{value}</p>
          <p className="mt-1.5 text-xs leading-5 text-gray-400">{detail}</p>
        </div>
        <div className="rounded-xl p-2.5" style={{ color: accent, backgroundColor: `${accent}18` }}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

export function Storage() {
  const query = useQuery({
    queryKey: ['storage-reclaims'],
    queryFn: () => api.getStorageReclaims(500),
    refetchInterval: 15000,
  });

  const summary = query.data?.summary;
  const records = query.data?.records || [];
  const originalSize = safeNumber(summary?.original_size);
  const replacementSize = safeNumber(summary?.replacement_size);
  const reclaimed = safeNumber(summary?.saved_space);
  const increased = safeNumber(summary?.storage_increased);
  const confirmedFiles = safeNumber(summary?.replaced_files);
  const retainedBackups = safeNumber(summary?.backup_retained);
  const reduction = percentage(reclaimed, originalSize);
  const replacementShare = originalSize > 0 ? Math.min(100, (replacementSize / originalSize) * 100) : 0;

  if (query.isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <div className="flex items-center gap-3 text-sm text-gray-400">
          <RefreshCw className="h-5 w-5 animate-spin text-[#74c69d]" /> Loading storage records…
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-5 pb-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#74c69d]">
            <Database className="h-3.5 w-3.5" /> Storage accounting
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Reclaimed storage</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-gray-400">
            Verified savings from originals that were actually replaced. Completed transcodes are excluded until replacement succeeds.
          </p>
        </div>
        <button
          onClick={() => query.refetch()}
          disabled={query.isFetching}
          className="flex h-9 items-center gap-2 rounded-lg border border-[#39363a] bg-[#282729] px-3 text-xs font-medium text-gray-300 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${query.isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Storage reclaimed" value={formatBytes(reclaimed)} detail="Positive size difference from confirmed replacements" icon={ArrowDownRight} accent="#74c69d" />
        <SummaryCard label="Confirmed files" value={numberFormatter.format(confirmedFiles)} detail="Direct replacements and cleaned backup replacements" icon={ShieldCheck} accent="#60a5fa" />
        <SummaryCard label="Weighted reduction" value={`${reduction}%`} detail={`${formatBytes(originalSize)} original → ${formatBytes(replacementSize)} replacement`} icon={HardDrive} accent="#fbbf24" />
        <SummaryCard label="Backups retained" value={numberFormatter.format(retainedBackups)} detail="Not counted as reclaimed until the .org backup is deleted" icon={Archive} accent="#a78bfa" />
      </section>

      <section className={`${PANEL} p-5 sm:p-6`}>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-semibold text-white">Confirmed footprint comparison</h2>
            <p className="mt-1 text-xs text-gray-500">Only finalized replacement records are included.</p>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
            <div><p className="text-[10px] uppercase tracking-wider text-gray-600">Original</p><p className="mt-1 text-sm font-medium text-gray-300">{formatBytes(originalSize)}</p></div>
            <div><p className="text-[10px] uppercase tracking-wider text-gray-600">Replacement</p><p className="mt-1 text-sm font-medium text-gray-300">{formatBytes(replacementSize)}</p></div>
            <div><p className="text-[10px] uppercase tracking-wider text-[#74c69d]">Reclaimed</p><p className="mt-1 text-sm font-semibold text-[#95d5b2]">{formatBytes(reclaimed)}</p></div>
            <div><p className="text-[10px] uppercase tracking-wider text-amber-400">Size increases</p><p className="mt-1 text-sm font-medium text-amber-300">{formatBytes(increased)}</p></div>
          </div>
        </div>
        <div className="mt-6 h-3 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full bg-gradient-to-r from-[#60a5fa] to-[#74c69d]" style={{ width: `${replacementShare}%` }} />
        </div>
        <div className="mt-2 flex justify-between text-[10px] uppercase tracking-wider text-gray-600"><span>Replacement footprint</span><span>{replacementShare.toFixed(1)}% of original</span></div>
      </section>

      <section className={`${PANEL} overflow-hidden`}>
        <div className="border-b border-[#39363a] px-5 py-4">
          <h2 className="font-semibold text-white">Replacement ledger</h2>
          <p className="mt-1 text-xs text-gray-500">Per-file proof of what was replaced, retained, reclaimed, or failed.</p>
        </div>
        {records.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
            <div className="rounded-2xl bg-[#74c69d]/10 p-3 text-[#74c69d]"><HardDrive className="h-6 w-6" /></div>
            <p className="mt-4 text-sm font-medium text-white">No confirmed replacements yet</p>
            <p className="mt-1 max-w-md text-xs leading-5 text-gray-500">Transcoding alone does not reclaim storage. Records appear here after Replace Original succeeds, or after a retained backup is cleaned up.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-left">
              <thead className="border-b border-[#39363a] bg-black/10 text-[10px] uppercase tracking-[0.13em] text-gray-600">
                <tr>
                  <th className="px-5 py-3 font-semibold">File</th>
                  <th className="px-4 py-3 font-semibold">State</th>
                  <th className="px-4 py-3 text-right font-semibold">Original</th>
                  <th className="px-4 py-3 text-right font-semibold">Replacement</th>
                  <th className="px-4 py-3 text-right font-semibold">Difference</th>
                  <th className="px-4 py-3 text-right font-semibold">Reduction</th>
                  <th className="px-5 py-3 font-semibold">Confirmed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#39363a]/70">
                {records.map(record => {
                  const presentation = statusPresentation(record.status);
                  const StatusIcon = presentation.icon;
                  const difference = safeNumber(record.bytes_reclaimed);
                  const rowReduction = percentage(Math.max(0, difference), safeNumber(record.original_size));
                  return (
                    <tr key={record.id}>
                      <td className="max-w-[360px] px-5 py-4">
                        <p className="truncate text-sm font-medium text-gray-200" title={record.filename}>{record.filename}</p>
                        <p className="mt-1 truncate text-[11px] text-gray-600">{record.library_name || 'Unknown library'}{record.node_name ? ` · ${record.node_name}` : ''}</p>
                      </td>
                      <td className="px-4 py-4"><span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${presentation.color}`}><StatusIcon className={`h-3 w-3 ${record.status === 'pending' ? 'animate-spin' : ''}`} />{presentation.label}</span></td>
                      <td className="px-4 py-4 text-right text-sm text-gray-400">{formatBytes(record.original_size)}</td>
                      <td className="px-4 py-4 text-right text-sm text-gray-400">{formatBytes(record.replacement_size)}</td>
                      <td className={`px-4 py-4 text-right text-sm font-medium ${difference > 0 ? 'text-[#95d5b2]' : difference < 0 ? 'text-amber-300' : 'text-gray-500'}`}>{record.status === 'reclaimed' ? `${difference >= 0 ? '' : '+'}${formatBytes(Math.abs(difference))}` : 'Not counted'}</td>
                      <td className="px-4 py-4 text-right text-sm text-gray-400">{record.status === 'reclaimed' ? `${rowReduction}%` : '—'}</td>
                      <td className="px-5 py-4 text-xs text-gray-500">{formatDate(record.reclaimed_at || record.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
