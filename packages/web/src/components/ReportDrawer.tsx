import { useEffect, useState } from 'react';
import { api, formatBytes } from '@/utils/api';
import { StatusBadge } from '@/components/ui/Badge';
import { X, ChevronDown, ChevronRight, Clock, Cpu, HardDrive, Zap, FileText } from 'lucide-react';

interface ReportDrawerProps {
  fileId: string;
  fileName: string;
  open: boolean;
  onClose: () => void;
}

interface ReportData {
  id: string;
  job_id: string;
  file_id: string;
  node_id: string | null;
  node_name: string | null;
  job_type: 'analyze' | 'transcode';
  preset_id: string | null;
  preset_name: string | null;
  status: 'completed' | 'failed' | 'cancelled';
  error_message: string | null;
  ffmpeg_logs: string | null;
  node_logs: string | null;
  original_size: number | null;
  output_size: number | null;
  duration_seconds: number | null;
  avg_fps: number | null;
  started_at: number | null;
  completed_at: number | null;
  config: string | null;
  metadata: string | null;
  created_at: number;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

export function ReportDrawer({ fileId, fileName, open, onClose }: ReportDrawerProps) {
  const [reports, setReports] = useState<ReportData[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open && fileId) {
      setLoading(true);
      api.getReportsForFile(fileId)
        .then((data) => {
          setReports(data || []);
        })
        .catch(() => {
          setReports([]);
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [open, fileId]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Drawer */}
      <div
        className="absolute right-0 top-0 bottom-0 w-full max-w-xl flex flex-col"
        style={{ backgroundColor: '#252326', borderLeft: '1px solid #38363a' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: '#38363a' }}>
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-gray-400" />
            <div>
              <h3 className="text-lg font-semibold text-white">Reports</h3>
              <p className="text-sm text-gray-400 truncate">{fileName}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-gray-400">
              Loading reports...
            </div>
          ) : reports.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400">
              <FileText className="h-8 w-8 text-gray-600 mb-3" />
              <p>No reports yet</p>
              <p className="text-sm text-gray-500 mt-1">Reports will appear here after jobs are run</p>
            </div>
          ) : (
            <div className="space-y-3">
              {reports.map((report) => {
                const isExpanded = expandedLogs.has(report.id);

                return (
                  <div
                    key={report.id}
                    className="rounded-lg p-4"
                    style={{ backgroundColor: '#1E1D1F', border: '1px solid #38363a' }}
                  >
                    {/* Report Header */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={report.status} />
                        <span className="text-xs text-gray-500 uppercase font-medium px-1.5 py-0.5 rounded" style={{ backgroundColor: '#38363a' }}>
                          {report.job_type}
                        </span>
                        {report.preset_name && (
                          <span className="text-xs text-gray-500 truncate max-w-[150px]" title={report.preset_name}>
                            {report.preset_name}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-gray-500">
                        {formatTimestamp(report.created_at)}
                      </span>
                    </div>

                    {/* Report Details */}
                    <div className="grid grid-cols-2 gap-x2 text-xs">
                      {/* Node */}
                      {report.node_name && (
                        <div className="flex items-center gap-1.5">
                          <Cpu className="h-3 w-3 text-gray-500" />
                          <span className="text-gray-400 truncate">{report.node_name}</span>
                        </div>
                      )}

                      {/* Duration */}
                      {report.duration_seconds != null && (
                        <div className="flex items-center gap-1.5">
                          <Clock className="h-3 w-3 text-gray-500" />
                          <span className="text-gray-400">{formatDuration(report.duration_seconds)}</span>
                        </div>
                      )}

                      {/* FPS */}
                      {report.avg_fps != null && (
                        <div className="flex items-center gap-1.5">
                          <Zap className="h-3 w-3 text-gray-500" />
                          <span className="text-gray-400">{report.avg_fps.toFixed(1)} fps</span>
                        </div>
                      )}

                      {/* Size comparison */}
                      {report.original_size != null && (
                        <div className="flex items-center gap-1.5">
                          <HardDrive className="h-3 w-3 text-gray-500" />
                          <span className="text-gray-400">
                            {formatBytes(report.original_size)}
                            {report.output_size != null && (
                              <>
                                {' → '}
                                <span className="text-green-400">{formatBytes(report.output_size)}</span>
                                {report.output_size < report.original_size && (
                                  <span className="text-gray-500">
                                    {' (-'}{((1 - report.output_size / report.original_size) * 100).toFixed(0)}%{')'}
                                  </span>
                                )}
                              </>
                            )}
                          </span>
                        </div>
                      )}

                      {/* Time range */}
                      {report.started_at && report.completed_at && (
                        <div className="flex items-center gap-1.5">
                          <Clock className="h-3 w-3 text-gray-500" />
                          <span className="text-gray-400">
                            {formatTimestamp(report.started_at)} → {formatTimestamp(report.completed_at)}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Error */}
                    {report.error_message && (
                      <div className="mt-2 p-2 rounded text-xs text-red-400" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                        {report.error_message}
                      </div>
                    )}

                    {/* Expandable logs toggle */}
                    {report.ffmpeg_logs && (
                      <button
                        onClick={() =>
                          setExpandedLogs(prev => {
                            const next = new Set(prev);
                            if (next.has(report.id)) next.delete(report.id);
                            else next.add(report.id);
                            return next;
                          })
                        }
                        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors mt-1"
                      >
                        {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        <span>FFmpeg Logs</span>
                      </button>
                    )}

                    {/* FFmpeg Logs Content */}
                    {isExpanded && report.ffmpeg_logs && (
                      <pre className="mt-1 p-3 rounded text-xs text-gray-400 overflow-x-auto max-h-64 font-mono" style={{ backgroundColor: '#1a191c', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                        {report.ffmpeg_logs}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
