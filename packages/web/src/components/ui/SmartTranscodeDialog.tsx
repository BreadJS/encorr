// ============================================================================
// Smart Transcode Dialog Component
// ============================================================================

import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Loader2, Cpu, Zap, Settings2, CheckCircle2, ChevronDown, AlertTriangle, Copy, Replace, HardDrive } from 'lucide-react';
import { BUILTIN_PRESETS } from '@/data/presets';
import { api } from '@/utils/api';
import type { TranscodeMode } from '@encorr/shared';

// ============================================================================
// Types
// ============================================================================

interface LibraryFile {
  id: string;
  filename: string;
  filesize: number | null;
  metadata: {
    container: string;
    video_codec: string;
    width: number;
    height: number;
    duration: number;
    bitrate: number;
    size: number;
  } | null;
}

interface SmartTranscodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: LibraryFile[];
  onConfirm: (mode: TranscodeMode, presetId: string, quickSelectId: string | undefined, postAction: 'keep' | 'replace' | 'backup_replace') => Promise<void>;
}

interface EstimateHistorySample {
  preset_id: string | null;
  original_codec: string | null;
  output_codec: string | null;
  original_resolution: string | null;
  original_size: number;
  output_size: number;
}

interface FileSizeEstimate {
  fileId: string;
  original: number;
  low: number;
  high: number;
  midpoint: number;
  basedOnHistory: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

// Helper to detect if a preset is GPU-based from config
function isGpuPreset(preset: any): boolean {
  // Check for HandBrake-style video_encoder field first (prioritize this for user presets)
  const videoEncoder = preset.config.video_encoder;
  if (videoEncoder) {
    return videoEncoder.includes('nvenc') ||
           videoEncoder.includes('vce') ||
           videoEncoder.includes('qsv') ||
           videoEncoder.includes('amf') ||
           videoEncoder.includes('quick');
  }

  // Check for encoding_type field (FFmpeg format)
  if (preset.config.encoding_type === 'gpu') return true;
  if (preset.config.encoding_type === 'cpu') return false;

  return false;
}

// Helper to detect GPU type from config
function getGpuType(preset: any): 'nvidia' | 'amd' | 'intel' | null {
  // Check for HandBrake-style video_encoder field first (prioritize for user presets)
  const videoEncoder = preset.config.video_encoder;
  if (videoEncoder) {
    if (videoEncoder.includes('nvenc') || videoEncoder.includes('nvidia')) return 'nvidia';
    if (videoEncoder.includes('vce') || videoEncoder.includes('amf') || videoEncoder.includes('amd')) return 'amd';
    if (videoEncoder.includes('qsv') || videoEncoder.includes('intel') || videoEncoder.includes('quick')) return 'intel';
  }

  // Check for gpu_type field (FFmpeg format)
  if (preset.config.gpu_type) {
    return preset.config.gpu_type;
  }

  return null;
}

// Helper to get video codec from config (handles both formats)
function getVideoCodec(preset: any): 'h264' | 'h265' | null {
  // Check for HandBrake-style video_encoder field first (prioritize for user presets)
  const videoEncoder = preset.config.video_encoder;
  if (videoEncoder) {
    if (videoEncoder.includes('h265') || videoEncoder.includes('hevc') || videoEncoder.includes('x265')) return 'h265';
    if (videoEncoder.includes('h264') || videoEncoder.includes('x264') || videoEncoder.includes('avc')) return 'h264';
  }

  // Check for video_codec field (FFmpeg format)
  if (preset.config.video_codec) {
    return preset.config.video_codec;
  }

  return null;
}

// Theme colors
const theme = {
  green: '#74c69d',
  greenHover: '#5fb382',
  bgPrimary: '#252326',
  bgSecondary: '#1E1D1F',
  bgTertiary: '#38363a',
  border: '#39363a',
  text: '#ffffff',
  textMuted: '#6b7280',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, unit)).toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`;
}

function normalizeCodec(codec: unknown): string {
  const value = String(codec || '').toLowerCase();
  if (value.includes('265') || value.includes('hevc')) return 'h265';
  if (value.includes('264') || value.includes('avc')) return 'h264';
  if (value.includes('av1')) return 'av1';
  return value || 'unknown';
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))];
}

function fallbackRatio(file: LibraryFile, targetCodec: string): number {
  const sourceCodec = normalizeCodec(file.metadata?.video_codec);
  const duration = Number(file.metadata?.duration || 0);
  const size = Number(file.filesize || file.metadata?.size || 0);
  const bitrate = Number(file.metadata?.bitrate || 0) || (duration > 0 ? (size * 8) / duration : 0);
  const highBitrate = bitrate >= 8_000_000;

  if (targetCodec === 'h265') {
    if (sourceCodec === 'h264') return highBitrate ? 0.48 : 0.60;
    if (sourceCodec === 'h265') return highBitrate ? 0.78 : 0.92;
    return highBitrate ? 0.55 : 0.70;
  }
  if (targetCodec === 'h264') {
    if (sourceCodec === 'h265' || sourceCodec === 'av1') return 1.25;
    if (sourceCodec === 'h264') return 0.92;
    return 0.75;
  }
  if (targetCodec === 'av1') return sourceCodec === 'av1' ? 0.92 : 0.52;
  return 0.75;
}

function estimateFileSize(
  file: LibraryFile,
  history: EstimateHistorySample[],
  presetIds: string[],
  targetCodec: string,
): FileSizeEstimate {
  const original = Number(file.filesize || file.metadata?.size || 0);
  const sourceCodec = normalizeCodec(file.metadata?.video_codec);
  const valid = history.filter(sample => {
    const ratio = sample.output_size / sample.original_size;
    return Number.isFinite(ratio) && ratio >= 0.08 && ratio <= 3;
  });
  const exactPreset = valid.filter(sample => sample.preset_id && presetIds.includes(sample.preset_id));
  const sameSource = (samples: EstimateHistorySample[]) => samples.filter(sample => normalizeCodec(sample.original_codec) === sourceCodec);
  const sameTarget = valid.filter(sample => normalizeCodec(sample.output_codec) === targetCodec);
  const candidates = sameSource(exactPreset).length >= 3
    ? sameSource(exactPreset)
    : exactPreset.length >= 3
      ? exactPreset
      : sameSource(sameTarget).length >= 3
        ? sameSource(sameTarget)
        : sameTarget.length >= 3
          ? sameTarget
          : [];

  if (candidates.length > 0) {
    const ratios = candidates.map(sample => sample.output_size / sample.original_size);
    const median = percentile(ratios, 0.5);
    const lowRatio = Math.min(median * 0.92, percentile(ratios, 0.2));
    const highRatio = Math.max(median * 1.08, percentile(ratios, 0.8));
    return {
      fileId: file.id,
      original,
      low: original * lowRatio,
      high: original * highRatio,
      midpoint: original * median,
      basedOnHistory: true,
    };
  }

  const ratio = fallbackRatio(file, targetCodec);
  return {
    fileId: file.id,
    original,
    low: original * ratio * 0.8,
    high: original * ratio * 1.2,
    midpoint: original * ratio,
    basedOnHistory: false,
  };
}

// ============================================================================
// Component
// ============================================================================

export function SmartTranscodeDialog({
  open,
  onOpenChange,
  files,
  onConfirm,
}: SmartTranscodeDialogProps) {
  const [mode, setMode] = useState<TranscodeMode>('auto');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedQuickSelectPresetId, setSelectedQuickSelectPresetId] = useState<string>('');
  const [postAction, setPostAction] = useState<'keep' | 'replace' | 'backup_replace'>('keep');
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPostAction('keep');
    setReplaceConfirmed(false);
  }, [open]);

  // GPU dropdown states
  const [nvidiaDropdownOpen, setNvidiaDropdownOpen] = useState(false);
  const [amdDropdownOpen, setAmdDropdownOpen] = useState(false);
  const [intelDropdownOpen, setIntelDropdownOpen] = useState(false);

  // Per-vendor preset selection states (for GPU mode)
  const [nvidiaPresetId, setNvidiaPresetId] = useState<string>('');
  const [amdPresetId, setAmdPresetId] = useState<string>('');
  const [intelPresetId, setIntelPresetId] = useState<string>('');
  const [cpuPresetId, setCpuPresetId] = useState<string>('');

  // Fetch all presets (built-in + user) from API
  const { data: apiPresets = [] } = useQuery({
    queryKey: ['presets'],
    queryFn: () => api.getPresets(),
    refetchOnWindowFocus: false,
  });

  // Fetch Quick Select Presets from API
  const { data: quickSelectPresets = [] } = useQuery({
    queryKey: ['quick-select-presets'],
    queryFn: () => api.getQuickSelectPresets(),
    refetchOnWindowFocus: false,
  });

  const { data: estimateHistory = [] } = useQuery({
    queryKey: ['transcode-estimate-history'],
    queryFn: () => api.getTranscodeEstimateHistory(),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Combine built-in presets with API presets (user presets)
  const allPresets = useMemo(() => {
    // Create a map to avoid duplicates by ID
    const presetMap = new Map();

    // Add built-in presets first
    BUILTIN_PRESETS.forEach(preset => {
      presetMap.set(preset.id, preset);
    });

    // Add/override with API presets (includes user presets)
    apiPresets.forEach((preset: any) => {
      presetMap.set(preset.id, preset);
    });

    return Array.from(presetMap.values());
  }, [apiPresets]);

  // Group presets by encoding type and gpu type (handles both FFmpeg and HandBrake formats)
  const gpuPresets = allPresets.filter(p => isGpuPreset(p));
  const cpuPresets = allPresets.filter(p => !isGpuPreset(p) && p.id !== 'builtin-analyze');

  // Group GPU presets by GPU type
  const nvidiaPresets = gpuPresets.filter(p => getGpuType(p) === 'nvidia');
  const amdPresets = gpuPresets.filter(p => getGpuType(p) === 'amd');
  const intelPresets = gpuPresets.filter(p => getGpuType(p) === 'intel');

  // Selected preset state
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');

  // Auto-select default preset based on mode
  const getDefaultPresetForMode = (currentMode: TranscodeMode): string => {
    if (currentMode === 'gpu') {
      // Default to NVIDIA H.265
      const nvidiaH265 = nvidiaPresets.find(p => getVideoCodec(p) === 'h265');
      return nvidiaH265?.id || nvidiaPresets[0]?.id || '';
    } else if (currentMode === 'cpu') {
      // Default to High Quality H.265 CPU
      const h265Cpu = cpuPresets.find(p => getVideoCodec(p) === 'h265');
      return h265Cpu?.id || cpuPresets[0]?.id || '';
    }
    return '';
  };

  // Initialize vendor-specific preset defaults
  const initializeVendorPresets = () => {
    // Prefer the built-in H.265 route; fall back to the first available route.
    if (quickSelectPresets.length > 0) {
      const defaultQuickSelect = quickSelectPresets.find((preset: any) => preset.id === 'quick-select-h265')
        || quickSelectPresets.find((preset: any) => preset.name === 'H.265 Quick Select')
        || quickSelectPresets[0];
      applyQuickSelectPreset(defaultQuickSelect);
      return;
    }

    // Fallback to manual initialization
    // NVIDIA default - H.265
    const nvidiaH265 = nvidiaPresets.find(p => getVideoCodec(p) === 'h265')
                      || nvidiaPresets.find(p => getVideoCodec(p) === 'h264')
                      || nvidiaPresets[0];
    setNvidiaPresetId(nvidiaH265?.id || '');

    // AMD default - H.265
    const amdH265 = amdPresets.find(p => getVideoCodec(p) === 'h265')
                   || amdPresets.find(p => getVideoCodec(p) === 'h264')
                   || amdPresets[0];
    setAmdPresetId(amdH265?.id || '');

    // Intel default - H.265
    const intelH265 = intelPresets.find(p => getVideoCodec(p) === 'h265')
                     || intelPresets.find(p => getVideoCodec(p) === 'h264')
                     || intelPresets[0];
    setIntelPresetId(intelH265?.id || '');

    // CPU default
    const cpuH265 = cpuPresets.find(p => getVideoCodec(p) === 'h265');
    setCpuPresetId(cpuH265?.id || cpuPresets[0]?.id || '');
  };

  // Apply Quick Select Preset to vendor dropdowns
  const applyQuickSelectPreset = (qsPreset: any) => {
    if (qsPreset.nvidia_preset_id) setNvidiaPresetId(qsPreset.nvidia_preset_id);
    if (qsPreset.amd_preset_id) setAmdPresetId(qsPreset.amd_preset_id);
    if (qsPreset.intel_preset_id) setIntelPresetId(qsPreset.intel_preset_id);
    if (qsPreset.cpu_preset_id) setCpuPresetId(qsPreset.cpu_preset_id);
    setSelectedQuickSelectPresetId(qsPreset.id);
  };

  // Apply the H.265 default whenever a new transcode dialog is opened.
  useEffect(() => {
    if (open && quickSelectPresets.length > 0) {
      initializeVendorPresets();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, quickSelectPresets]);

  // Update selected preset when mode changes
  const handleModeChange = (newMode: TranscodeMode) => {
    setMode(newMode);
    setSelectedPresetId(getDefaultPresetForMode(newMode));
    // Initialize vendor presets if not already set
    if (!nvidiaPresetId || !amdPresetId || !intelPresetId || !cpuPresetId) {
      initializeVendorPresets();
    }
    // Close all dropdowns when switching modes
    setNvidiaDropdownOpen(false);
    setAmdDropdownOpen(false);
    setIntelDropdownOpen(false);
  };

  // Get current preset info based on mode and vendor selection
  const getCurrentPreset = () => {
    if (mode === 'gpu') {
      return quickSelectPresets.find((preset: any) => preset.id === selectedQuickSelectPresetId);
    } else if (mode === 'cpu') {
      return allPresets.find(p => p.id === cpuPresetId);
    }
    return allPresets.find(p => p.id === selectedPresetId);
  };

  // Get the active preset ID to use for transcoding
  const getActivePresetId = (): string => {
    if (mode === 'gpu') {
      // Prioritize based on which vendor has presets
      if (nvidiaPresetId) return nvidiaPresetId;
      if (amdPresetId) return amdPresetId;
      if (intelPresetId) return intelPresetId;
      return nvidiaPresets[0]?.id || '';
    } else if (mode === 'cpu') {
      return cpuPresetId || cpuPresets[0]?.id || '';
    }
    return selectedPresetId;
  };

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm(
        mode,
        getActivePresetId(),
        mode === 'gpu' ? selectedQuickSelectPresetId || undefined : undefined,
        postAction,
      );
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to start transcoding:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const getFilteredPresets = () => {
    return mode === 'gpu' ? gpuPresets : cpuPresets;
  };

  // Get presets for each GPU type dropdown (no codec filtering for vendor dropdowns)
  const getFilteredGpuPresets = (gpuType: 'nvidia' | 'amd' | 'intel') => {
    // Return all presets for the vendor, without codec filtering
    return gpuPresets.filter(p => getGpuType(p) === gpuType);
  };

  const currentPreset = getCurrentPreset();

  const estimatePresetIds = useMemo(() => {
    if (mode === 'cpu') return cpuPresetId ? [cpuPresetId] : [];
    if (mode === 'gpu') {
      const route = quickSelectPresets.find((preset: any) => preset.id === selectedQuickSelectPresetId);
      return [route?.nvidia_preset_id, route?.amd_preset_id, route?.intel_preset_id]
        .filter((id): id is string => Boolean(id));
    }
    return allPresets
      .filter(preset => getVideoCodec(preset) === 'h265')
      .map(preset => preset.id);
  }, [mode, cpuPresetId, quickSelectPresets, selectedQuickSelectPresetId, allPresets]);

  const estimateTargetCodec = useMemo(() => {
    if (mode === 'cpu') return getVideoCodec(allPresets.find(preset => preset.id === cpuPresetId)) || 'h265';
    if (mode === 'gpu') {
      const routedPreset = allPresets.find(preset => estimatePresetIds.includes(preset.id));
      return getVideoCodec(routedPreset) || 'h265';
    }
    return 'h265';
  }, [mode, allPresets, cpuPresetId, estimatePresetIds]);

  const sizeEstimates = useMemo(
    () => files.map(file => estimateFileSize(file, estimateHistory, estimatePresetIds, estimateTargetCodec)),
    [files, estimateHistory, estimatePresetIds, estimateTargetCodec],
  );

  const estimateSummary = useMemo(() => sizeEstimates.reduce((summary, estimate) => ({
    original: summary.original + estimate.original,
    low: summary.low + estimate.low,
    high: summary.high + estimate.high,
    midpoint: summary.midpoint + estimate.midpoint,
    historicalFiles: summary.historicalFiles + (estimate.basedOnHistory ? 1 : 0),
  }), { original: 0, low: 0, high: 0, midpoint: 0, historicalFiles: 0 }), [sizeEstimates]);

  const estimatedChangePercent = estimateSummary.original > 0
    ? ((estimateSummary.midpoint - estimateSummary.original) / estimateSummary.original) * 100
    : 0;

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title="Smart Transcode"
      size="lg"
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isSubmitting || files.length === 0
              || (mode === 'gpu' && !selectedQuickSelectPresetId)
              || (mode === 'cpu' && !getActivePresetId())
              || (postAction === 'replace' && !replaceConfirmed)}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Starting...
              </>
            ) : (
              <>
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Start Transcoding ({files.length})
              </>
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Description */}
        <p className="text-sm text-gray-400">
          Select files to transcode and choose your preset.
        </p>

        {/* Mode Selection */}
        <div className="space-y-3">
          <h3 className="text-base font-semibold text-white">Processing Mode</h3>

          {/* Auto Mode */}
          <div
            onClick={() => handleModeChange('auto')}
            className={`flex items-start space-x-3 rounded-lg border p-4 transition-all cursor-pointer ${
              mode === 'auto' ? 'bg-primary/5' : 'hover:bg-white/5'
            }`}
            style={{
              borderColor: mode === 'auto' ? theme.green : theme.border,
              backgroundColor: mode === 'auto' ? `${theme.green}10` : undefined
            }}
          >
            <input
              type="radio"
              name="transcode-mode"
              value="auto"
              checked={mode === 'auto'}
              onChange={() => handleModeChange('auto')}
              className="mt-1"
              onClick={(e) => e.stopPropagation()}
            />
            <div className="flex-1">
              <div className="flex items-center gap-2 font-medium text-white">
                <Settings2 className="h-4 w-4" style={{ color: mode === 'auto' ? theme.green : undefined }} />
                Auto (Recommended)
              </div>
              <p className="mt-1 text-sm text-gray-400">
                System analyzes each file and chooses optimal settings. Uses GPU when available for best performance.
              </p>
            </div>
          </div>

          {/* GPU Mode with Preset Selection */}
          <div
            onClick={() => handleModeChange('gpu')}
            className={`rounded-lg border p-4 transition-all cursor-pointer ${
              mode === 'gpu' ? 'bg-primary/5' : 'hover:bg-white/5'
            }`}
            style={{
              borderColor: mode === 'gpu' ? theme.green : theme.border,
              backgroundColor: mode === 'gpu' ? `${theme.green}10` : undefined,
              overflow: (nvidiaDropdownOpen || amdDropdownOpen || intelDropdownOpen) ? 'visible' : undefined
            }}
          >
            <div className="flex items-start space-x-3 mb-3">
              <input
                type="radio"
                name="transcode-mode"
                value="gpu"
                checked={mode === 'gpu'}
                onChange={() => handleModeChange('gpu')}
                className="mt-1"
                onClick={(e) => e.stopPropagation()}
              />
              <div className="flex-1">
                <div className="flex items-center gap-2 font-medium text-white">
                  <Zap className="h-4 w-4" style={{ color: mode === 'gpu' ? theme.green : undefined }} />
                  GPU
                </div>
                <p className="mt-1 text-sm text-gray-400">
                  Force GPU encoding for fastest transcoding. Minimal CPU usage.
                </p>
              </div>
            </div>

            {/* GPU Preset Dropdown */}
            {mode === 'gpu' && (
              <div
                className="ml-8 space-y-2"
                onClick={(e) => e.stopPropagation()}
                style={{ overflow: (nvidiaDropdownOpen || amdDropdownOpen || intelDropdownOpen) ? 'visible' : undefined }}
              >
                {/* Quick Select Presets */}
                {quickSelectPresets.length > 0 && (
                  <div className="mb-3">
                    <p className="text-xs text-gray-400 mb-2">Quick Select routing:</p>
                    <div className="flex flex-wrap gap-2">
                      {quickSelectPresets.map((qsPreset: any) => (
                        <button
                          key={qsPreset.id}
                          onClick={() => applyQuickSelectPreset(qsPreset)}
                          className={`px-3 py-1.5 text-xs rounded transition-all flex items-center gap-1.5 ${
                            selectedQuickSelectPresetId === qsPreset.id
                              ? 'text-white'
                              : 'text-gray-300 hover:bg-white/5'
                          }`}
                          style={{
                            backgroundColor: selectedQuickSelectPresetId === qsPreset.id ? theme.green : theme.bgTertiary,
                          }}
                        >
                          <Zap className="h-3 w-3" />
                          <span>{qsPreset.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* GPU Type Dropdowns */}
                <div className="hidden">
                  {/* NVIDIA */}
                  {nvidiaPresets.length > 0 && (
                    <div className="relative">
                      <button
                        onClick={() => {
                          setNvidiaDropdownOpen(!nvidiaDropdownOpen);
                          setAmdDropdownOpen(false);
                          setIntelDropdownOpen(false);
                        }}
                        className={`w-full text-left px-3 py-2 text-sm rounded border transition-all flex items-center justify-between ${
                          nvidiaPresetId && nvidiaPresets.some(p => p.id === nvidiaPresetId)
                            ? 'text-white'
                            : 'text-gray-300'
                        }`}
                        style={{
                          backgroundColor: theme.bgSecondary,
                          borderColor: nvidiaDropdownOpen ? theme.green : theme.border,
                        }}
                      >
                        <span className="truncate">
                          {nvidiaPresetId && nvidiaPresets.some(p => p.id === nvidiaPresetId)
                            ? nvidiaPresets.find(p => p.id === nvidiaPresetId)!.name
                            : 'NVIDIA'}
                        </span>
                        <ChevronDown className={`h-4 w-4 flex-shrink-0 ml-1 transition-transform ${
                          nvidiaDropdownOpen ? 'rotate-180' : ''
                        }`} />
                      </button>
                      <div
                        className={`absolute left-0 right-0 top-full mt-1 rounded-md overflow-hidden transition-all duration-200 z-50 ${
                          nvidiaDropdownOpen
                            ? 'max-h-60 opacity-100'
                            : 'max-h-0 opacity-0'
                        }`}
                        style={{ backgroundColor: theme.bgSecondary, border: `1px solid ${theme.border}` }}
                      >
                        {getFilteredGpuPresets('nvidia').map(preset => (
                          <button
                            key={preset.id}
                            onClick={() => {
                              setNvidiaPresetId(preset.id);
                              setNvidiaDropdownOpen(false);
                            }}
                            className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                              nvidiaPresetId === preset.id
                                ? 'text-white'
                                : 'text-gray-300 hover:bg-white/5'
                            }`}
                            style={{
                              backgroundColor: nvidiaPresetId === preset.id ? `${theme.green}30` : 'transparent',
                            }}
                          >
                            <div className="font-medium">{preset.name}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* AMD */}
                  {amdPresets.length > 0 && (
                    <div className="relative">
                      <button
                        onClick={() => {
                          setAmdDropdownOpen(!amdDropdownOpen);
                          setNvidiaDropdownOpen(false);
                          setIntelDropdownOpen(false);
                        }}
                        className={`w-full text-left px-3 py-2 text-sm rounded border transition-all flex items-center justify-between ${
                          amdPresetId && amdPresets.some(p => p.id === amdPresetId)
                            ? 'text-white'
                            : 'text-gray-300'
                        }`}
                        style={{
                          backgroundColor: theme.bgSecondary,
                          borderColor: amdDropdownOpen ? theme.green : theme.border,
                        }}
                      >
                        <span className="truncate">
                          {amdPresetId && amdPresets.some(p => p.id === amdPresetId)
                            ? amdPresets.find(p => p.id === amdPresetId)!.name
                            : 'AMD'}
                        </span>
                        <ChevronDown className={`h-4 w-4 flex-shrink-0 ml-1 transition-transform ${
                          amdDropdownOpen ? 'rotate-180' : ''
                        }`} />
                      </button>
                      <div
                        className={`absolute left-0 right-0 top-full mt-1 rounded-md overflow-hidden transition-all duration-200 z-50 ${
                          amdDropdownOpen
                            ? 'max-h-60 opacity-100'
                            : 'max-h-0 opacity-0'
                        }`}
                        style={{ backgroundColor: theme.bgSecondary, border: `1px solid ${theme.border}` }}
                      >
                        {getFilteredGpuPresets('amd').map(preset => (
                          <button
                            key={preset.id}
                            onClick={() => {
                              setAmdPresetId(preset.id);
                              setAmdDropdownOpen(false);
                            }}
                            className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                              amdPresetId === preset.id
                                ? 'text-white'
                                : 'text-gray-300 hover:bg-white/5'
                            }`}
                            style={{
                              backgroundColor: amdPresetId === preset.id ? `${theme.green}30` : 'transparent',
                            }}
                          >
                            <div className="font-medium">{preset.name}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Intel */}
                  {intelPresets.length > 0 && (
                    <div className="relative">
                      <button
                        onClick={() => {
                          setIntelDropdownOpen(!intelDropdownOpen);
                          setNvidiaDropdownOpen(false);
                          setAmdDropdownOpen(false);
                        }}
                        className={`w-full text-left px-3 py-2 text-sm rounded border transition-all flex items-center justify-between ${
                          intelPresetId && intelPresets.some(p => p.id === intelPresetId)
                            ? 'text-white'
                            : 'text-gray-300'
                        }`}
                        style={{
                          backgroundColor: theme.bgSecondary,
                          borderColor: intelDropdownOpen ? theme.green : theme.border,
                        }}
                      >
                        <span className="truncate">
                          {intelPresetId && intelPresets.some(p => p.id === intelPresetId)
                            ? intelPresets.find(p => p.id === intelPresetId)!.name
                            : 'Intel'}
                        </span>
                        <ChevronDown className={`h-4 w-4 flex-shrink-0 ml-1 transition-transform ${
                          intelDropdownOpen ? 'rotate-180' : ''
                        }`} />
                      </button>
                      <div
                        className={`absolute left-0 right-0 top-full mt-1 rounded-md overflow-hidden transition-all duration-200 z-50 ${
                          intelDropdownOpen
                            ? 'max-h-60 opacity-100'
                            : 'max-h-0 opacity-0'
                        }`}
                        style={{ backgroundColor: theme.bgSecondary, border: `1px solid ${theme.border}` }}
                      >
                        {getFilteredGpuPresets('intel').map(preset => (
                          <button
                            key={preset.id}
                            onClick={() => {
                              setIntelPresetId(preset.id);
                              setIntelDropdownOpen(false);
                            }}
                            className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                              intelPresetId === preset.id
                                ? 'text-white'
                                : 'text-gray-300 hover:bg-white/5'
                            }`}
                            style={{
                              backgroundColor: intelPresetId === preset.id ? `${theme.green}30` : 'transparent',
                            }}
                          >
                            <div className="font-medium">{preset.name}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* CPU Mode with Preset Selection */}
          <div
            onClick={() => handleModeChange('cpu')}
            className={`rounded-lg border p-4 transition-all cursor-pointer ${
              mode === 'cpu' ? 'bg-primary/5' : 'hover:bg-white/5'
            }`}
            style={{
              borderColor: mode === 'cpu' ? theme.green : theme.border,
              backgroundColor: mode === 'cpu' ? `${theme.green}10` : undefined
            }}
          >
            <div className="flex items-start space-x-3 mb-3">
              <input
                type="radio"
                name="transcode-mode"
                value="cpu"
                checked={mode === 'cpu'}
                onChange={() => handleModeChange('cpu')}
                className="mt-1"
                onClick={(e) => e.stopPropagation()}
              />
              <div className="flex-1">
                <div className="flex items-center gap-2 font-medium text-white">
                  <Cpu className="h-4 w-4" style={{ color: mode === 'cpu' ? theme.green : undefined }} />
                  CPU
                </div>
                <p className="mt-1 text-sm text-gray-400">
                  CPU encoding. Works on any system.
                </p>
              </div>
            </div>

            {/* CPU Preset Dropdown */}
            {mode === 'cpu' && (
              <div className="ml-8 space-y-2" onClick={(e) => e.stopPropagation()}>
                {/* CPU Presets List */}
                <div className="space-y-1">
                  {getFilteredPresets().map(preset => (
                    <button
                      key={preset.id}
                      onClick={() => setCpuPresetId(preset.id)}
                      className={`w-full text-left px-3 py-2 text-sm rounded border transition-all ${
                        cpuPresetId === preset.id
                          ? 'text-white'
                          : 'text-gray-300 hover:bg-white/5'
                      }`}
                      style={{
                        backgroundColor: cpuPresetId === preset.id ? `${theme.green}30` : theme.bgSecondary,
                        borderColor: cpuPresetId === preset.id ? theme.green : theme.border,
                      }}
                    >
                      <div className="font-medium">{preset.name}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Selected Preset Info */}
        {currentPreset && mode !== 'auto' && (
          <div className="rounded-lg p-3" style={{ backgroundColor: theme.bgSecondary, border: `1px solid ${theme.border}` }}>
            <p className="text-sm font-medium text-white mb-1">Selected Preset</p>
            <p className="text-xs text-gray-400">{currentPreset.name}</p>
            <p className="text-xs text-gray-500 mt-1">{currentPreset.description}</p>
          </div>
        )}

        {estimateSummary.original > 0 && (
          <div className="rounded-lg border p-3" style={{ backgroundColor: theme.bgSecondary, borderColor: theme.border }}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  <HardDrive className="h-4 w-4 text-[#74c69d]" />
                  Instant size estimate
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Based on source metadata{estimateSummary.historicalFiles > 0 ? ' and completed Encorr transcodes' : ''}. No sample encode is run.
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-base font-semibold text-white">
                  {formatBytes(estimateSummary.low)}–{formatBytes(estimateSummary.high)}
                </p>
                <p className={`text-xs font-medium ${estimatedChangePercent <= 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {Math.abs(estimatedChangePercent).toFixed(0)}% {estimatedChangePercent <= 0 ? 'smaller' : 'larger'} estimated
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-base font-semibold text-white">After Each Transcode</h3>
          <p className="text-xs leading-5 text-gray-500">Choose what Encorr should do after each output is successfully created.</p>
          {([
            { id: 'keep', title: 'Keep output separate', detail: 'Keep the original and transcoded copy side by side for manual review.', icon: Copy },
            { id: 'backup_replace', title: 'Backup & Replace', detail: 'Rename the original to .org, then install the transcoded file. The backup can be removed later.', icon: Copy },
            { id: 'replace', title: 'Replace Original', detail: 'Install the transcoded file and permanently remove the original without retaining a backup.', icon: Replace },
          ] as const).map(option => {
            const Icon = option.icon;
            return (
              <label key={option.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${postAction === option.id ? 'border-[#5b8f75] bg-[#1b3027]' : 'border-[#39363a] bg-[#1E1D1F]'}`}>
                <input
                  type="radio"
                  name="smart-post-action"
                  checked={postAction === option.id}
                  onChange={() => { setPostAction(option.id); setReplaceConfirmed(false); }}
                  className="mt-1 accent-[#74c69d]"
                />
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${postAction === option.id ? 'text-[#74c69d]' : 'text-gray-500'}`} />
                <span><span className="block text-sm font-medium text-white">{option.title}</span><span className="mt-0.5 block text-xs leading-5 text-gray-500">{option.detail}</span></span>
              </label>
            );
          })}
        </div>

        {postAction === 'replace' && (
          <label className="flex cursor-pointer gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs leading-5 text-red-200">
            <input type="checkbox" checked={replaceConfirmed} onChange={event => setReplaceConfirmed(event.target.checked)} className="mt-1 shrink-0 accent-red-500" />
            <span><span className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-4 w-4" />Confirm automatic replacement</span><span className="mt-1 block">I understand each original will be permanently replaced when its transcode completes, without keeping a .org backup.</span></span>
          </label>
        )}

        {/* File List */}
        <div className="space-y-2">
          <h3 className="text-base font-semibold text-white">Files to Transcode ({files.length})</h3>
          <div className="max-h-40 overflow-y-auto rounded-md border" style={{ borderColor: theme.border, backgroundColor: theme.bgSecondary }}>
            <div className="grid grid-cols-12 gap-2 border-b p-2 text-xs font-medium text-gray-400" style={{ borderColor: theme.border, backgroundColor: theme.bgTertiary }}>
              <div className="col-span-7">File Name</div>
              <div className="col-span-2 text-right">Current</div>
              <div className="col-span-3 text-right">Estimated</div>
            </div>
            {files.map((file, index) => {
              const estimate = sizeEstimates[index];
              const change = estimate?.original > 0
                ? ((estimate.midpoint - estimate.original) / estimate.original) * 100
                : 0;
              return (
              <div
                key={file.id}
                className="grid grid-cols-12 items-center gap-2 border-b p-2 text-sm last:border-0"
                style={{ borderColor: theme.border }}
              >
                <div className="col-span-7 truncate text-gray-300" title={file.filename}>
                  {file.filename}
                </div>
                <div className="col-span-2 text-right text-xs text-gray-500">{formatBytes(estimate?.original || 0)}</div>
                <div className="col-span-3 text-right">
                  <div className="text-xs text-gray-300">{estimate ? `${formatBytes(estimate.low)}–${formatBytes(estimate.high)}` : 'Unknown'}</div>
                  {estimate?.original > 0 && (
                    <div className={`text-[10px] ${change <= 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {Math.abs(change).toFixed(0)}% {change <= 0 ? 'smaller' : 'larger'}
                    </div>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
