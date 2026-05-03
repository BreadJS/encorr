// ============================================================================
// Smart Transcode Dialog Component
// ============================================================================

import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Loader2, Cpu, Zap, Settings2, CheckCircle2, ChevronDown } from 'lucide-react';
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
  onConfirm: (mode: TranscodeMode, presetId: string) => Promise<void>;
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

  // GPU dropdown states
  const [nvidiaDropdownOpen, setNvidiaDropdownOpen] = useState(false);
  const [amdDropdownOpen, setAmdDropdownOpen] = useState(false);
  const [intelDropdownOpen, setIntelDropdownOpen] = useState(false);

  // Per-vendor preset selection states (for GPU mode)
  const [nvidiaPresetId, setNvidiaPresetId] = useState<string>('');
  const [amdPresetId, setAmdPresetId] = useState<string>('');
  const [intelPresetId, setIntelPresetId] = useState<string>('');

  // Track which vendor was last selected by the user
  const [selectedGpuVendor, setSelectedGpuVendor] = useState<'nvidia' | 'amd' | 'intel' | null>(null);
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

  // Determine if any files are audio-only (no video codec)
  const hasAudioOnlyFiles = useMemo(() => {
    return files.some(f => !f.metadata?.video_codec);
  }, [files]);

  // Determine if any files are video
  const hasVideoFiles = useMemo(() => {
    return files.some(f => (f as any).metadata?.video_codec || (f as any).video_codec || (f as any).original_codec);
  }, [files]);

  // Helper to check if a preset is audio-only
  const isAudioPreset = (p: any) => p.config?.audio_only === true;

  // Helper to get presets filtered by mode and file types
  const getPresetsForMode = (mode: TranscodeMode) => {
    const all = allPresets.filter(p => p.id !== 'builtin-analyze');
    if (mode === 'gpu') {
      // GPU mode: video GPU presets + audio presets if audio files are selected
      const videoGpu = all.filter(p => isGpuPreset(p) && !isAudioPreset(p));
      if (hasAudioOnlyFiles) {
        return [...videoGpu, ...all.filter(p => isAudioPreset(p))];
      }
      return videoGpu;
    } else {
      // CPU mode: video CPU presets + audio presets if audio files are selected
      const videoCpu = all.filter(p => !isGpuPreset(p) && !isAudioPreset(p));
      if (hasAudioOnlyFiles && !hasVideoFiles) {
        return all.filter(p => isAudioPreset(p));
      }
      if (hasAudioOnlyFiles) {
        return [...videoCpu, ...all.filter(p => isAudioPreset(p))];
      }
      return hasVideoFiles ? videoCpu : all.filter(p => isAudioPreset(p));
    }
  };

  // Group GPU presets by GPU type (only video GPU presets)
  const videoGpuPresets = allPresets.filter(p => isGpuPreset(p) && !isAudioPreset(p));
  const nvidiaPresets = videoGpuPresets.filter(p => getGpuType(p) === 'nvidia');
  const amdPresets = videoGpuPresets.filter(p => getGpuType(p) === 'amd');
  const intelPresets = videoGpuPresets.filter(p => getGpuType(p) === 'intel');

  // Selected preset state
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');

  // Auto-select default preset based on mode
  const getDefaultPresetForMode = (currentMode: TranscodeMode): string => {
    const presets = getPresetsForMode(currentMode);
    if (currentMode === 'gpu') {
      // Default to NVIDIA H.265
      const nvidiaH265 = nvidiaPresets.find(p => getVideoCodec(p) === 'h265');
      return nvidiaH265?.id || nvidiaPresets[0]?.id || presets[0]?.id || '';
    } else if (currentMode === 'cpu') {
      // Default to High Quality H.265 CPU or first audio preset
      const h265Cpu = presets.find(p => getVideoCodec(p) === 'h265');
      return h265Cpu?.id || presets[0]?.id || '';
    }
    return '';
  };

  // Initialize vendor-specific preset defaults
  const initializeVendorPresets = () => {
    // Try to use the first Quick Select Preset if available
    if (quickSelectPresets.length > 0) {
      applyQuickSelectPreset(quickSelectPresets[0]);
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

    // CPU default - prefer video presets, fall back to audio presets
    const cpuModePresets = getPresetsForMode('cpu');
    const cpuH265 = cpuModePresets.find(p => getVideoCodec(p) === 'h265');
    setCpuPresetId(cpuH265?.id || cpuModePresets[0]?.id || '');
  };

  // Track which vendor was last selected by the user
  const handleVendorSelect = (vendor: 'nvidia' | 'amd' | 'intel') => {
    setSelectedGpuVendor(vendor);
  };

  // Apply Quick Select Preset to vendor dropdowns
  const applyQuickSelectPreset = (qsPreset: any) => {
    if (qsPreset.nvidia_preset_id) setNvidiaPresetId(qsPreset.nvidia_preset_id);
    if (qsPreset.amd_preset_id) setAmdPresetId(qsPreset.amd_preset_id);
    if (qsPreset.intel_preset_id) setIntelPresetId(qsPreset.intel_preset_id);
    if (qsPreset.cpu_preset_id) setCpuPresetId(qsPreset.cpu_preset_id);
    setSelectedQuickSelectPresetId(qsPreset.id);
  };

  // Auto-apply first Quick Select Preset when loaded
  useEffect(() => {
    if (quickSelectPresets.length > 0 && !selectedQuickSelectPresetId) {
      initializeVendorPresets();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickSelectPresets]);

  // Update selected preset when mode changes
  const handleModeChange = (newMode: TranscodeMode) => {
    // GPU mode is only relevant for video transcoding
    if (newMode === 'gpu' && !hasVideoFiles) return;
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
      // For GPU mode, find which vendor has a selection and return that preset
      if (nvidiaPresetId && nvidiaPresets.some(p => p.id === nvidiaPresetId)) {
        return allPresets.find(p => p.id === nvidiaPresetId);
      }
      if (amdPresetId && amdPresets.some(p => p.id === amdPresetId)) {
        return allPresets.find(p => p.id === amdPresetId);
      }
      if (intelPresetId && intelPresets.some(p => p.id === intelPresetId)) {
        return allPresets.find(p => p.id === intelPresetId);
      }
      // Fallback to first GPU preset
      return allPresets.find(p => p.id === nvidiaPresets[0]?.id);
    } else if (mode === 'cpu') {
      return allPresets.find(p => p.id === cpuPresetId);
    }
    return allPresets.find(p => p.id === selectedPresetId);
  };

  // Get the active preset ID to use for transcoding
  const getActivePresetId = (): string => {
    if (mode === 'gpu') {
      // Use the vendor the user actually selected, not just whichever has a preset set
      if (selectedGpuVendor === 'nvidia' && nvidiaPresetId) return nvidiaPresetId;
      if (selectedGpuVendor === 'amd' && amdPresetId) return amdPresetId;
      if (selectedGpuVendor === 'intel' && intelPresetId) return intelPresetId;
      // Fallback: use whatever vendor has presets
      if (nvidiaPresetId) return nvidiaPresetId;
      if (amdPresetId) return amdPresetId;
      if (intelPresetId) return intelPresetId;
      return nvidiaPresets[0]?.id || '';
    } else if (mode === 'cpu') {
      const cpuModePresets = getPresetsForMode('cpu');
      return cpuPresetId || cpuModePresets[0]?.id || '';
    }
    return selectedPresetId;
  };

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm(mode, getActivePresetId());
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to start transcoding:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const getFilteredPresets = () => {
    return getPresetsForMode(mode);
  };

  // Get presets for each GPU type dropdown (no codec filtering for vendor dropdowns)
  const getFilteredGpuPresets = (gpuType: 'nvidia' | 'amd' | 'intel') => {
    // Return all presets for the vendor, without codec filtering
    return videoGpuPresets.filter(p => getGpuType(p) === gpuType);
  };

  const currentPreset = getCurrentPreset();

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
            disabled={isSubmitting || files.length === 0 || (!getActivePresetId() && mode !== 'auto')}
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
          {hasVideoFiles && (
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
                    <p className="text-xs text-gray-400 mb-2">Quick Select Presets:</p>
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
                <div className="flex flex-col gap-2">
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
                              handleVendorSelect('nvidia');
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
                              handleVendorSelect('amd');
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
                              handleVendorSelect('intel');
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
          )}

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

        {/* File List */}
        <div className="space-y-2">
          <h3 className="text-base font-semibold text-white">Files to Transcode ({files.length})</h3>
          <div className="max-h-40 overflow-y-auto rounded-md border" style={{ borderColor: theme.border, backgroundColor: theme.bgSecondary }}>
            <div className="grid grid-cols-12 gap-2 border-b p-2 text-xs font-medium text-gray-400" style={{ borderColor: theme.border, backgroundColor: theme.bgTertiary }}>
              <div className="col-span-12">File Name</div>
            </div>
            {files.map((file) => (
              <div
                key={file.id}
                className="border-b p-2 text-sm last:border-0"
                style={{ borderColor: theme.border }}
              >
                <div className="truncate text-gray-300" title={file.filename}>
                  {file.filename}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
