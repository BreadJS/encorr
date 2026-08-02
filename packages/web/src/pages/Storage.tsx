import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowDownRight,
  CheckCircle2,
  Database,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  Trash2,
} from 'lucide-react';
import { api, formatBytes } from '@/utils/api';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

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

function statusPresentation(status: string, errorMessage?: string | null) {
  if (status === 'reclaimed') return { label: 'Reclaimed', color: 'bg-[#74c69d]/10 text-[#95d5b2]', icon: CheckCircle2 };
  if (status === 'backup_retained' && errorMessage) return { label: 'Removal failed', color: 'bg-red-400/10 text-red-300', icon: AlertTriangle };
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
  const queryClient = useQueryClient();
  const [selectedBackups, setSelectedBackups] = useState<Set<string>>(new Set());
  const [showCleanupDialog, setShowCleanupDialog] = useState(false);
  const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
  const [cleanupNotice, setCleanupNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const query = useQuery({
    queryKey: ['storage-reclaims'],
    queryFn: () => api.getStorageReclaims(500),
    refetchInterval: 15000,
  });

  const summary = query.data?.summary;
  const records = useMemo(() => query.data?.records || [], [query.data?.records]);
  const retainedRecords = useMemo(() => records.filter(record => record.status === 'backup_retained'), [records]);
  const selectedRecords = retainedRecords.filter(record => selectedBackups.has(record.id));
  const allRetainedSelected = retainedRecords.length > 0 && selectedRecords.length === retainedRecords.length;

  useEffect(() => {
    const retainedIds = new Set(retainedRecords.map(record => record.id));
    setSelectedBackups(previous => new Set(Array.from(previous).filter(id => retainedIds.has(id))));
  }, [retainedRecords]);

  const cleanupMutation = useMutation({
    mutationFn: async (items: typeof retainedRecords) => {
      const succeeded: string[] = [];
      const failures: string[] = [];
      for (const item of items) {
        try {
          await api.cleanupOriginalFile(item.library_file_id);
          succeeded.push(item.id);
        } catch (error) {
          failures.push(`${item.filename}: ${error instanceof Error ? error.message : 'Could not queue removal'}`);
        }
      }
      return { succeeded, failures };
    },
    onSuccess: ({ succeeded, failures }) => {
      setSelectedBackups(previous => {
        const next = new Set(previous);
        succeeded.forEach(id => next.delete(id));
        return next;
      });
      setShowCleanupDialog(false);
      setCleanupConfirmed(false);
      setCleanupNotice(failures.length > 0
        ? { type: 'error', message: `${succeeded.length.toLocaleString()} queued, ${failures.length.toLocaleString()} failed. ${failures[0]}` }
        : { type: 'success', message: `${succeeded.length.toLocaleString()} backup removal${succeeded.length === 1 ? '' : 's'} added to Jobs.` });
      void queryClient.invalidateQueries({ queryKey: ['storage-reclaims'] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
  const originalSize = safeNumber(summary?.original_size);
  const replacementSize = safeNumber(summary?.replacement_size);
  const reclaimed = safeNumber(summary?.saved_space);
  const confirmedFiles = safeNumber(summary?.replaced_files);
  const retainedBackups = safeNumber(summary?.backup_retained);
  const retainedOriginalSize = safeNumber(summary?.retained_original_size);
  const retainedReplacementSize = safeNumber(summary?.retained_replacement_size);
  const claimedFootprint = safeNumber(summary?.claimed_footprint);
  const reduction = percentage(reclaimed, originalSize);
  const trackedOriginalBaseline = originalSize + retainedOriginalSize;
  const installedReplacementSize = replacementSize + retainedReplacementSize;
  const claimedShare = trackedOriginalBaseline > 0 ? (claimedFootprint / trackedOriginalBaseline) * 100 : 0;

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
        <SummaryCard label="Claimed footprint" value={formatBytes(claimedFootprint)} detail="Installed replacements plus originals still retained on disk" icon={HardDrive} accent="#60a5fa" />
        <SummaryCard label="Retained originals" value={formatBytes(retainedOriginalSize)} detail={`${numberFormatter.format(retainedBackups)} .org ${retainedBackups === 1 ? 'file still needs' : 'files still need'} review`} icon={Archive} accent="#fbbf24" />
        <SummaryCard label="Confirmed files" value={numberFormatter.format(confirmedFiles)} detail={`${reduction}% weighted reduction after original removal`} icon={ShieldCheck} accent="#a78bfa" />
      </section>

      <section className={`${PANEL} p-5 sm:p-6`}>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-semibold text-white">Confirmed footprint comparison</h2>
            <p className="mt-1 text-xs text-gray-500">Includes retained originals so the actual claimed space is never hidden.</p>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
            <div><p className="text-[10px] uppercase tracking-wider text-gray-600">Original baseline</p><p className="mt-1 text-sm font-medium text-gray-300">{formatBytes(trackedOriginalBaseline)}</p></div>
            <div><p className="text-[10px] uppercase tracking-wider text-gray-600">Replacements</p><p className="mt-1 text-sm font-medium text-gray-300">{formatBytes(installedReplacementSize)}</p></div>
            <div><p className="text-[10px] uppercase tracking-wider text-amber-400">Originals retained</p><p className="mt-1 text-sm font-semibold text-amber-300">{formatBytes(retainedOriginalSize)}</p></div>
            <div><p className="text-[10px] uppercase tracking-wider text-[#74c69d]">Claimed now</p><p className="mt-1 text-sm font-semibold text-[#95d5b2]">{formatBytes(claimedFootprint)}</p></div>
          </div>
        </div>
        <div className="mt-6 h-3 overflow-hidden rounded-full bg-white/[0.06]">
          <div className={`h-full rounded-full ${claimedShare > 100 ? 'bg-amber-400' : 'bg-gradient-to-r from-[#60a5fa] to-[#74c69d]'}`} style={{ width: `${Math.min(100, claimedShare)}%` }} />
        </div>
        <div className="mt-2 flex justify-between text-[10px] uppercase tracking-wider text-gray-600"><span>Current claimed footprint</span><span>{claimedShare.toFixed(1)}% of original baseline</span></div>
      </section>

      <section className={`${PANEL} overflow-hidden`}>
        <div className="flex flex-col gap-3 border-b border-[#39363a] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold text-white">Replacement ledger</h2>
            <p className="mt-1 text-xs text-gray-500">Per-file proof of what was replaced, retained, reclaimed, or failed.</p>
          </div>
          {selectedRecords.length > 0 && (
            <Button
              onClick={() => {
                setCleanupConfirmed(false);
                setCleanupNotice(null);
                setShowCleanupDialog(true);
              }}
              className="shrink-0 border border-red-500/35 bg-red-500/10 text-red-200 hover:bg-red-500/20"
            >
              <Trash2 className="mr-2 h-4 w-4" />Remove selected backups ({selectedRecords.length.toLocaleString()})
            </Button>
          )}
        </div>
        {cleanupNotice && (
          <div className={`mx-5 mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${cleanupNotice.type === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-red-500/30 bg-red-500/10 text-red-200'}`}>
            {cleanupNotice.type === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{cleanupNotice.message}</span>
          </div>
        )}
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
                  <th className="w-12 px-4 py-3 text-center font-semibold">
                    <input
                      type="checkbox"
                      checked={allRetainedSelected}
                      disabled={retainedRecords.length === 0}
                      onChange={() => setSelectedBackups(allRetainedSelected ? new Set() : new Set(retainedRecords.map(record => record.id)))}
                      className="h-4 w-4 accent-[#74c69d] disabled:opacity-30"
                      aria-label="Select all retained backups"
                    />
                  </th>
                  <th className="px-5 py-3 font-semibold">File</th>
                  <th className="px-4 py-3 font-semibold">State</th>
                  <th className="px-4 py-3 text-right font-semibold">Original</th>
                  <th className="px-4 py-3 text-right font-semibold">Replacement</th>
                  <th className="px-4 py-3 text-right font-semibold">Difference</th>
                  <th className="px-4 py-3 text-right font-semibold">Savings / action</th>
                  <th className="px-5 py-3 font-semibold">Confirmed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#39363a]/70">
                {records.map(record => {
                  const presentation = statusPresentation(record.status, record.error_message);
                  const StatusIcon = presentation.icon;
                  const difference = safeNumber(record.bytes_reclaimed);
                  const retainedImpact = record.status === 'backup_retained' ? safeNumber(record.replacement_size) : 0;
                  const rowReduction = percentage(Math.max(0, difference), safeNumber(record.original_size));
                  return (
                    <tr key={record.id}>
                      <td className="px-4 py-4 text-center">
                        {record.status === 'backup_retained' && (
                          <input
                            type="checkbox"
                            checked={selectedBackups.has(record.id)}
                            onChange={() => setSelectedBackups(previous => {
                              const next = new Set(previous);
                              if (next.has(record.id)) next.delete(record.id);
                              else next.add(record.id);
                              return next;
                            })}
                            className="h-4 w-4 accent-[#74c69d]"
                            aria-label={`Select retained backup for ${record.filename}`}
                          />
                        )}
                      </td>
                      <td className="max-w-[360px] px-5 py-4">
                        <p className="truncate text-sm font-medium text-gray-200" title={record.filename}>{record.filename}</p>
                        <p className="mt-1 truncate text-[11px] text-gray-600">{record.library_name || 'Unknown library'}{record.node_name ? ` · ${record.node_name}` : ''}</p>
                      </td>
                      <td className="px-4 py-4"><span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${presentation.color}`}><StatusIcon className={`h-3 w-3 ${record.status === 'pending' ? 'animate-spin' : ''}`} />{presentation.label}</span></td>
                      <td className="px-4 py-4 text-right text-sm text-gray-400">{formatBytes(record.original_size)}</td>
                      <td className="px-4 py-4 text-right text-sm text-gray-400">{formatBytes(record.replacement_size)}</td>
                      <td className={`px-4 py-4 text-right text-sm font-medium ${record.status === 'backup_retained' ? 'text-amber-300' : difference > 0 ? 'text-[#95d5b2]' : difference < 0 ? 'text-amber-300' : 'text-gray-500'}`}>{record.status === 'reclaimed' ? `${difference >= 0 ? '' : '+'}${formatBytes(Math.abs(difference))}` : record.status === 'backup_retained' ? `+${formatBytes(retainedImpact)} claimed` : 'Not counted'}</td>
                      <td className="px-4 py-4 text-right text-sm text-gray-400">{record.status === 'reclaimed' ? `${rowReduction}%` : record.status === 'backup_retained' ? `Remove ${formatBytes(record.original_size)}` : '—'}</td>
                      <td className="px-5 py-4 text-xs text-gray-500">{formatDate(record.reclaimed_at || record.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog
        open={showCleanupDialog}
        onClose={() => !cleanupMutation.isPending && setShowCleanupDialog(false)}
        title="Remove retained originals?"
        size="md"
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button onClick={() => setShowCleanupDialog(false)} disabled={cleanupMutation.isPending} className="border border-[#39363a] text-gray-300">Cancel</Button>
            <Button
              onClick={() => cleanupMutation.mutate(selectedRecords)}
              disabled={!cleanupConfirmed || selectedRecords.length === 0 || cleanupMutation.isPending}
              className="bg-red-600 text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 className="mr-2 h-4 w-4" />{cleanupMutation.isPending ? 'Adding to Jobs…' : `Remove ${selectedRecords.length.toLocaleString()} backups`}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-red-500/35 bg-red-500/10 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
              <div>
                <p className="font-semibold text-red-100">This permanently deletes the retained .org originals.</p>
                <p className="mt-1.5 text-sm leading-6 text-red-100/70">The installed transcoded files stay in place. After removal, Encorr cannot restore the original versions.</p>
              </div>
            </div>
          </div>
          <div className="max-h-36 overflow-auto rounded-lg border border-[#39363a] bg-[#1e1d1f] p-3">
            {selectedRecords.map(record => <p key={record.id} className="truncate py-0.5 text-xs text-gray-400">{record.filename} · {formatBytes(record.original_size)}</p>)}
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[#39363a] bg-[#252326] p-3">
            <input type="checkbox" checked={cleanupConfirmed} onChange={event => setCleanupConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4 accent-[#74c69d]" />
            <span className="text-sm text-gray-300">I understand these retained originals will be permanently deleted.</span>
          </label>
        </div>
      </Dialog>
    </div>
  );
}
