import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/utils/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  AlertCircle,
  ArrowLeft,
  Box,
  ChevronDown,
  Cpu,
  Film,
  Gauge,
  Layers3,
  Lock,
  Monitor,
  Music2,
  Plus,
  Search,
  Sliders,
  Trash2,
  Zap,
} from 'lucide-react';
import { BUILTIN_PRESETS, type PresetConfig, defaultConfig } from '@/data/presets';
import { useState, useMemo, useEffect, useRef } from 'react';

// Hardware encoders - FFmpeg compatible
const VIDEO_ENCODERS = [
  // CPU/Software encoders
  { value: 'libx264', label: 'H.264 (x264)', category: 'software', gpu: null },
  { value: 'libx265', label: 'H.265 (x265)', category: 'software', gpu: null },
  { value: 'libvpx-vp9', label: 'VP9 (libvpx)', category: 'software', gpu: null },
  { value: 'libaom-av1', label: 'AV1 (libaom)', category: 'software', gpu: null },
  // NVIDIA NVENC
  { value: 'h264_nvenc', label: 'H.264 (NVIDIA NVENC)', category: 'hardware', gpu: 'nvidia' },
  { value: 'hevc_nvenc', label: 'H.265 (NVIDIA NVENC)', category: 'hardware', gpu: 'nvidia' },
  { value: 'hevc_nvenc_10bit', label: 'H.265 10-bit (NVIDIA)', category: 'hardware', gpu: 'nvidia' },
  // Intel Quick Sync
  { value: 'h264_qsv', label: 'H.264 (Intel QSV)', category: 'hardware', gpu: 'intel' },
  { value: 'hevc_qsv', label: 'H.265 (Intel QSV)', category: 'hardware', gpu: 'intel' },
  { value: 'hevc_qsv_10bit', label: 'H.265 10-bit (Intel)', category: 'hardware', gpu: 'intel' },
  // AMD AMF/VCE
  { value: 'h264_amf', label: 'H.264 (AMD AMF)', category: 'hardware', gpu: 'amd' },
  { value: 'hevc_amf', label: 'H.265 (AMD AMF)', category: 'hardware', gpu: 'amd' },
  { value: 'hevc_amf_10bit', label: 'H.265 10-bit (AMD)', category: 'hardware', gpu: 'amd' },
];

const AUDIO_ENCODERS = [
  { value: 'copy', label: 'Copy (Original)' },
  { value: 'aac', label: 'AAC' },
  { value: 'libmp3lame', label: 'MP3' },
  { value: 'libopus', label: 'Opus' },
  { value: 'libvorbis', label: 'Vorbis' },
  { value: 'flac', label: 'FLAC' },
  { value: 'ac3', label: 'AC3' },
  { value: 'eac3', label: 'EAC3' },
];

const CONTAINERS = [
  { value: 'mp4', label: 'MP4' },
  { value: 'mkv', label: 'MKV' },
  { value: 'mov', label: 'MOV' },
  { value: 'webm', label: 'WebM' },
];

const FRAMERATES = [
  { value: 'source', label: 'Same as source' },
  { value: '23.976', label: '23.976 fps' },
  { value: '24', label: '24 fps' },
  { value: '25', label: '25 fps' },
  { value: '29.97', label: '29.97 fps' },
  { value: '30', label: '30 fps' },
  { value: '50', label: '50 fps' },
  { value: '60', label: '60 fps' },
];

const RESOLUTIONS = [
  { value: 'source', label: 'Same as source' },
  { value: '2160', label: '4K (2160p)' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
  { value: '360', label: '360p' },
];

const PRESET_SPEEDS = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium',
  'slow', 'slower', 'veryslow'
];

// PresetConfig interface and defaultConfig are imported from @/data/presets
// BUILTIN_PRESETS are imported from @/data/presets

// Extended config for form with additional fields
interface FormPresetConfig {
  video_codec: 'h264' | 'h265';
  encoding_type: 'cpu' | 'gpu';
  gpu_type?: 'nvidia' | 'amd' | 'intel';
  quality_mode: 'crf' | 'cq' | 'qp';
  quality: number;
  preset: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower';
  format: string;
  framerate: string;
  resolution: string;
  quality_type: 'crf' | 'bitrate';
  video_encoder: string;
  audio_encoder_label: string;
  audio_bitrate: number;
  subtitles: 'all' | 'first' | 'none';
  max_width?: number;
  max_height?: number;
  deinterlace?: boolean;
  extra_args?: string[];
}

const defaultFormConfig: FormPresetConfig = {
  video_codec: 'h264',
  encoding_type: 'cpu',
  quality_mode: 'crf',
  quality: 23,
  preset: 'medium',
  format: 'mkv',
  framerate: 'source',
  resolution: 'source',
  quality_type: 'crf',
  video_encoder: 'libx264',
  audio_encoder_label: 'copy',
  audio_bitrate: 160,
  subtitles: 'all',
  deinterlace: false,
};

// Helper functions for preset categorization
function getPresetCategory(preset: any): string {
  const config = preset.config;
  if (config.encoding_type === 'cpu') return 'cpu';
  if (config.encoding_type === 'gpu') {
    if (config.gpu_type === 'nvidia') return 'nvidia';
    if (config.gpu_type === 'amd') return 'amd';
    if (config.gpu_type === 'intel') return 'intel';
  }
  return 'cpu';
}

export function Presets() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<'list' | 'create' | 'edit' | 'quick-select-create' | 'quick-select-edit'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<'all' | 'quick' | 'cpu' | 'nvidia' | 'amd' | 'intel'>('all');
  const [editingPreset, setEditingPreset] = useState<any | null>(null);
  const [editingQuickSelectPreset, setEditingQuickSelectPreset] = useState<any | null>(null);

  const [presetName, setPresetName] = useState('');
  const [presetDescription, setPresetDescription] = useState('');
  const [config, setConfig] = useState<FormPresetConfig>(defaultFormConfig);

  // Quick Select Preset form state
  const [qsName, setQsName] = useState('');
  const [qsDescription, setQsDescription] = useState('');
  const [qsNvidiaPresetId, setQsNvidiaPresetId] = useState('');
  const [qsAmdPresetId, setQsAmdPresetId] = useState('');
  const [qsIntelPresetId, setQsIntelPresetId] = useState('');
  const [qsCpuPresetId, setQsCpuPresetId] = useState('');

  // Quick Select Preset dropdown states
  const [qsNvidiaDropdownOpen, setQsNvidiaDropdownOpen] = useState(false);
  const [qsAmdDropdownOpen, setQsAmdDropdownOpen] = useState(false);
  const [qsIntelDropdownOpen, setQsIntelDropdownOpen] = useState(false);
  const [qsCpuDropdownOpen, setQsCpuDropdownOpen] = useState(false);

  // Refs for click-outside detection
  const qsDropdownContainerRef = useRef<HTMLDivElement>(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (qsDropdownContainerRef.current && !qsDropdownContainerRef.current.contains(event.target as Node)) {
        setQsNvidiaDropdownOpen(false);
        setQsAmdDropdownOpen(false);
        setQsIntelDropdownOpen(false);
        setQsCpuDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Theme colors for Quick Select Preset form
  const qsTheme = {
    green: '#74c69d',
    bgPrimary: '#252326',
    bgSecondary: '#1E1D1F',
    border: '#38363a',
  };

  const { data: presets = [] } = useQuery({
    queryKey: ['presets'],
    queryFn: () => api.getPresets(),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description?: string; config: PresetConfig }) =>
      api.createPreset(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['presets'] });
      handleBack();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; description?: string; config?: PresetConfig } }) =>
      api.updatePreset(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['presets'] });
      handleBack();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deletePreset(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['presets'] });
    },
  });

  // Quick Select Presets mutations
  const createQSMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description?: string;
      nvidia_preset_id?: string;
      amd_preset_id?: string;
      intel_preset_id?: string;
      cpu_preset_id?: string;
    }) => api.createQuickSelectPreset(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quick-select-presets'] });
      handleBack();
    },
  });

  const updateQSMutation = useMutation({
    mutationFn: ({ id, data }: {
      id: string;
      data: {
        name?: string;
        description?: string;
        nvidia_preset_id?: string;
        amd_preset_id?: string;
        intel_preset_id?: string;
        cpu_preset_id?: string;
      };
    }) => api.updateQuickSelectPreset(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quick-select-presets'] });
      handleBack();
    },
  });

  const deleteQSMutation = useMutation({
    mutationFn: (id: string) => api.deleteQuickSelectPreset(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quick-select-presets'] });
    },
  });

  // Quick Select Presets
  const { data: quickSelectPresets = [] } = useQuery({
    queryKey: ['quick-select-presets'],
    queryFn: () => api.getQuickSelectPresets(),
  });

  const allPresets = useMemo(
    () => [...BUILTIN_PRESETS, ...(presets || []).filter((preset: any) => !preset.is_builtin)],
    [presets]
  );

  // Organize presets into categories and apply the list search.
  const categorizedPresets = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const filteredPresets = allPresets.filter((preset: any) => {
      if (preset.id === 'builtin-analyze') return false;
      if (!normalizedSearch) return true;
      const searchable = [
        preset.name,
        preset.description,
        preset.config?.video_codec,
        preset.config?.gpu_type,
        preset.config?.container,
        preset.config?.preset,
      ].filter(Boolean).join(' ').toLowerCase();
      return searchable.includes(normalizedSearch);
    });

    return {
      cpu: filteredPresets.filter((preset: any) => getPresetCategory(preset) === 'cpu'),
      nvidia: filteredPresets.filter((preset: any) => getPresetCategory(preset) === 'nvidia'),
      amd: filteredPresets.filter((preset: any) => getPresetCategory(preset) === 'amd'),
      intel: filteredPresets.filter((preset: any) => getPresetCategory(preset) === 'intel'),
    };
  }, [allPresets, searchQuery]);

  const filteredQuickSelectPresets = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    if (!normalizedSearch) return quickSelectPresets;

    return quickSelectPresets.filter((quickPreset: any) => {
      const mappedPresetNames = [
        quickPreset.nvidia_preset_id,
        quickPreset.amd_preset_id,
        quickPreset.intel_preset_id,
        quickPreset.cpu_preset_id,
      ].map(id => allPresets.find((preset: any) => preset.id === id)?.name);
      return [quickPreset.name, quickPreset.description, ...mappedPresetNames]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch);
    });
  }, [allPresets, quickSelectPresets, searchQuery]);

  // Check if container supports subtitles
  const containerSupportsSubtitles = (format: string) => {
    return format === 'mkv';
  };

  const handleOpenCreate = () => {
    setEditingPreset(null);
    setPresetName('');
    setPresetDescription('');
    setConfig({ ...defaultFormConfig });
    setView('create');
  };

  const handleOpenEdit = (preset: any) => {
    if (preset.is_builtin) return;
    setEditingPreset(preset);
    setPresetName(preset.name);
    setPresetDescription(preset.description || '');

    // Convert PresetConfig to FormPresetConfig
    const pConfig = preset.config || defaultConfig;
    setConfig({
      ...defaultFormConfig,
      video_codec: pConfig.video_codec,
      encoding_type: pConfig.encoding_type,
      gpu_type: pConfig.gpu_type,
      quality_mode: pConfig.quality_mode,
      quality: pConfig.quality,
      preset: pConfig.preset,
      format: pConfig.container || 'mkv',
      framerate: 'source',
      resolution: 'source',
      quality_type: pConfig.quality_mode === 'crf' ? 'crf' : 'bitrate',
      video_encoder: pConfig.video_encoder || 'libx264',
      audio_encoder_label: pConfig.audio_encoder || 'copy',
      audio_bitrate: pConfig.audio_bitrate,
      subtitles: pConfig.subtitles,
      max_width: pConfig.max_width,
      max_height: pConfig.max_height,
      deinterlace: pConfig.deinterlace,
      extra_args: pConfig.extra_args,
    });
    setView('edit');
  };

  const handleBack = () => {
    setView('list');
    setEditingPreset(null);
    setEditingQuickSelectPreset(null);
    setPresetName('');
    setPresetDescription('');
    setConfig({ ...defaultFormConfig });
    setQsName('');
    setQsDescription('');
    setQsNvidiaPresetId('');
    setQsAmdPresetId('');
    setQsIntelPresetId('');
    setQsCpuPresetId('');
  };

  const handleOpenQSCreate = () => {
    setEditingQuickSelectPreset(null);
    setQsName('');
    setQsDescription('');
    setQsNvidiaPresetId('');
    setQsAmdPresetId('');
    setQsIntelPresetId('');
    setQsCpuPresetId('');
    setView('quick-select-create');
  };

  const handleOpenQSEdit = (qp: any) => {
    if (qp.is_builtin) return;
    setEditingQuickSelectPreset(qp);
    setQsName(qp.name);
    setQsDescription(qp.description || '');
    setQsNvidiaPresetId(qp.nvidia_preset_id || '');
    setQsAmdPresetId(qp.amd_preset_id || '');
    setQsIntelPresetId(qp.intel_preset_id || '');
    setQsCpuPresetId(qp.cpu_preset_id || '');
    setView('quick-select-edit');
  };

  const handleQSSave = () => {
    const data = {
      name: qsName,
      description: qsDescription || undefined,
      nvidia_preset_id: qsNvidiaPresetId || undefined,
      amd_preset_id: qsAmdPresetId || undefined,
      intel_preset_id: qsIntelPresetId || undefined,
      cpu_preset_id: qsCpuPresetId || undefined,
    };

    if (view === 'quick-select-edit' && editingQuickSelectPreset) {
      updateQSMutation.mutate({ id: editingQuickSelectPreset.id, data });
    } else {
      createQSMutation.mutate(data);
    }
  };

  const handleSave = () => {
    // Convert FormPresetConfig to PresetConfig
    // Map 'bitrate' quality type to 'cq' for the config
    const qualityMode = config.quality_type === 'bitrate' ? 'cq' : config.quality_type;

    const presetConfig: PresetConfig = {
      video_codec: config.video_codec,
      encoding_type: config.encoding_type,
      gpu_type: config.gpu_type,
      quality_mode: qualityMode,
      quality: config.quality,
      preset: config.preset,
      container: config.format as any,
      audio_encoder: config.audio_encoder_label as any,
      audio_bitrate: config.audio_encoder_label === 'copy' ? 0 : config.audio_bitrate,
      subtitles: config.subtitles,
      max_width: config.max_width,
      max_height: config.max_height,
      deinterlace: config.deinterlace,
      extra_args: config.extra_args,
    };

    const data = {
      name: presetName,
      description: presetDescription || undefined,
      config: presetConfig,
    };

    if (view === 'edit' && editingPreset) {
      updateMutation.mutate({ id: editingPreset.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const updateConfig = <K extends keyof FormPresetConfig>(key: K, value: FormPresetConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  // Handle quality type toggle with value reset
  const handleQualityTypeChange = (type: 'crf' | 'bitrate') => {
    updateConfig('quality_type', type);
    // Reset quality to appropriate default
    if (type === 'crf') {
      updateConfig('quality', 23); // RF default
    } else {
      updateConfig('quality', 2000); // Bitrate default in kbps
    }
  };

  const handleResolutionChange = (resolution: string) => {
    const dimensions: Record<string, { max_width?: number; max_height?: number }> = {
      source: {},
      '2160': { max_width: 3840, max_height: 2160 },
      '1080': { max_width: 1920, max_height: 1080 },
      '720': { max_width: 1280, max_height: 720 },
      '480': { max_width: 854, max_height: 480 },
      '360': { max_width: 640, max_height: 360 },
    };
    const selectedDimensions = dimensions[resolution] || {};
    setConfig(previous => ({
      ...previous,
      resolution,
      max_width: selectedDimensions.max_width,
      max_height: selectedDimensions.max_height,
    }));
  };

  // Handle video encoder change
  const handleVideoEncoderChange = (encoder: string) => {
    updateConfig('video_encoder', encoder);

    // Auto-detect encoding type and GPU type from encoder
    const encoderInfo = VIDEO_ENCODERS.find(e => e.value === encoder);
    if (encoderInfo) {
      if (encoderInfo.category === 'hardware' && encoderInfo.gpu) {
        updateConfig('encoding_type', 'gpu');
        updateConfig('gpu_type', encoderInfo.gpu as 'nvidia' | 'amd' | 'intel');
        updateConfig('quality_mode', 'cq'); // GPU uses CQ usually
      } else {
        updateConfig('encoding_type', 'cpu');
        updateConfig('gpu_type', undefined);
        updateConfig('quality_mode', 'crf');
      }

      // Set codec based on encoder
      if (encoder.includes('265') || encoder.includes('hevc')) {
        updateConfig('video_codec', 'h265');
      } else {
        updateConfig('video_codec', 'h264');
      }
    }
  };

  // Check if form is valid
  const isFormValid = useMemo(() => {
    return (
      presetName.trim() !== '' &&
      config.format !== '' &&
      config.video_encoder !== '' &&
      config.audio_encoder_label !== '' &&
      config.resolution !== '' &&
      config.framerate !== ''
    );
  }, [presetName, config]);

  // Quick Select Preset Form Validation
  const isQSFormValid = useMemo(() => {
    return qsName.trim() !== '';
  }, [qsName]);

  // Quick Select Preset Create/Edit View
  if (view === 'quick-select-create' || view === 'quick-select-edit') {
    // Group presets by vendor for dropdowns
    const nvidiaPresets = presets.filter((p: any) => p.config?.encoding_type === 'gpu' && p.config?.gpu_type === 'nvidia');
    const amdPresets = presets.filter((p: any) => p.config?.encoding_type === 'gpu' && p.config?.gpu_type === 'amd');
    const intelPresets = presets.filter((p: any) => p.config?.encoding_type === 'gpu' && p.config?.gpu_type === 'intel');
    const cpuPresets = presets.filter((p: any) => p.config?.encoding_type === 'cpu' || !p.config?.encoding_type);

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button
            onClick={handleBack}
            style={{ borderColor: '#38363a', color: '#ffffff' }}
            className="hover:bg-gray-800"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <div className="flex-1">
            <h1 className="text-3xl font-bold text-white">
              {view === 'quick-select-edit' ? 'Edit Quick Select Preset' : 'Create Quick Select Preset'}
            </h1>
            <p className="text-gray-400">
              {view === 'quick-select-edit'
                ? 'Modify Quick Select Preset configuration'
                : 'Create a new Quick Select Preset for Smart Transcode'}
            </p>
          </div>
          <Button
            onClick={handleQSSave}
            disabled={!isQSFormValid || createQSMutation.isPending || updateQSMutation.isPending}
            style={{ backgroundColor: '#74c69d', color: '#1a1a1a', border: 'none' }}
            className="hover:opacity-90 disabled:opacity-50"
          >
            {view === 'quick-select-edit' ? 'Save Changes' : 'Create Quick Select Preset'}
          </Button>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <Card style={{ backgroundColor: '#252326', border: 'none' }}>
            <CardContent className="p-6 space-y-6">
              {/* Name and Description */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Preset Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={qsName}
                    onChange={(e) => setQsName(e.target.value)}
                    placeholder="e.g., My Gaming Setup"
                    className="w-full px-4 py-2.5 rounded-lg text-white placeholder-gray-500 focus:outline-none transition-colors"
                    style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Description</label>
                  <textarea
                    value={qsDescription}
                    onChange={(e) => setQsDescription(e.target.value)}
                    placeholder="Describe when to use this Quick Select Preset..."
                    rows={2}
                    className="w-full px-4 py-2.5 rounded-lg text-white placeholder-gray-500 focus:outline-none transition-colors resize-none"
                    style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                  />
                </div>
              </div>

              {/* Vendor Preset Selection */}
              <div className="space-y-4" ref={qsDropdownContainerRef}>
                {/* NVIDIA Preset Dropdown */}
                {nvidiaPresets.length > 0 && (
                  <div className="relative">
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-green-400">⟡</span>
                        NVIDIA Preset
                      </div>
                    </label>
                    <button
                      onClick={() => {
                        setQsNvidiaDropdownOpen(!qsNvidiaDropdownOpen);
                        setQsAmdDropdownOpen(false);
                        setQsIntelDropdownOpen(false);
                        setQsCpuDropdownOpen(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 text-sm rounded-lg border transition-all flex items-center justify-between ${
                        qsNvidiaPresetId && nvidiaPresets.some(p => p.id === qsNvidiaPresetId)
                          ? 'text-white'
                          : 'text-gray-300'
                      }`}
                      style={{
                        backgroundColor: qsTheme.bgSecondary,
                        borderColor: qsNvidiaDropdownOpen ? qsTheme.green : qsTheme.border,
                      }}
                    >
                      <span className="truncate">
                        {qsNvidiaPresetId && nvidiaPresets.some(p => p.id === qsNvidiaPresetId)
                          ? nvidiaPresets.find(p => p.id === qsNvidiaPresetId)!.name
                          : 'None'}
                      </span>
                      <ChevronDown className={`h-4 w-4 flex-shrink-0 ml-1 transition-transform ${
                        qsNvidiaDropdownOpen ? 'rotate-180' : ''
                      }`} />
                    </button>
                    <div
                      className={`absolute left-0 right-0 top-full mt-1 rounded-md overflow-hidden transition-all duration-200 z-50 ${
                        qsNvidiaDropdownOpen
                          ? 'max-h-60 opacity-100'
                          : 'max-h-0 opacity-0'
                      }`}
                      style={{ backgroundColor: qsTheme.bgSecondary, border: `1px solid ${qsTheme.border}` }}
                    >
                      <button
                        onClick={() => {
                          setQsNvidiaPresetId('');
                          setQsNvidiaDropdownOpen(false);
                        }}
                        className={`w-full text-left px-4 py-2.5 text-xs transition-all cursor-pointer ${
                          !qsNvidiaPresetId
                            ? 'text-white'
                            : 'text-gray-300'
                        } hover:bg-white/10`}
                        style={{
                          backgroundColor: !qsNvidiaPresetId ? `${qsTheme.green}30` : 'transparent',
                        }}
                      >
                        <div className="font-medium">None</div>
                      </button>
                      {nvidiaPresets.map(preset => (
                        <button
                          key={preset.id}
                          onClick={() => {
                            setQsNvidiaPresetId(preset.id);
                            setQsNvidiaDropdownOpen(false);
                          }}
                          className={`w-full text-left px-4 py-2.5 text-xs transition-all cursor-pointer ${
                            qsNvidiaPresetId === preset.id
                              ? 'text-white'
                              : 'text-gray-300'
                          } hover:bg-white/10`}
                          style={{
                            backgroundColor: qsNvidiaPresetId === preset.id ? `${qsTheme.green}30` : 'transparent',
                          }}
                        >
                          <div className="font-medium">{preset.name}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* AMD Preset Dropdown */}
                {amdPresets.length > 0 && (
                  <div className="relative">
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-red-400">⟡</span>
                        AMD Preset
                      </div>
                    </label>
                    <button
                      onClick={() => {
                        setQsAmdDropdownOpen(!qsAmdDropdownOpen);
                        setQsNvidiaDropdownOpen(false);
                        setQsIntelDropdownOpen(false);
                        setQsCpuDropdownOpen(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 text-sm rounded-lg border transition-all flex items-center justify-between ${
                        qsAmdPresetId && amdPresets.some(p => p.id === qsAmdPresetId)
                          ? 'text-white'
                          : 'text-gray-300'
                      }`}
                      style={{
                        backgroundColor: qsTheme.bgSecondary,
                        borderColor: qsAmdDropdownOpen ? qsTheme.green : qsTheme.border,
                      }}
                    >
                      <span className="truncate">
                        {qsAmdPresetId && amdPresets.some(p => p.id === qsAmdPresetId)
                          ? amdPresets.find(p => p.id === qsAmdPresetId)!.name
                          : 'None'}
                      </span>
                      <ChevronDown className={`h-4 w-4 flex-shrink-0 ml-1 transition-transform ${
                        qsAmdDropdownOpen ? 'rotate-180' : ''
                      }`} />
                    </button>
                    <div
                      className={`absolute left-0 right-0 top-full mt-1 rounded-md overflow-hidden transition-all duration-200 z-50 ${
                        qsAmdDropdownOpen
                          ? 'max-h-60 opacity-100'
                          : 'max-h-0 opacity-0'
                      }`}
                      style={{ backgroundColor: qsTheme.bgSecondary, border: `1px solid ${qsTheme.border}` }}
                    >
                      <button
                        onClick={() => {
                          setQsAmdPresetId('');
                          setQsAmdDropdownOpen(false);
                        }}
                        className={`w-full text-left px-4 py-2.5 text-xs transition-all cursor-pointer ${
                          !qsAmdPresetId
                            ? 'text-white'
                            : 'text-gray-300'
                        } hover:bg-white/10`}
                        style={{
                          backgroundColor: !qsAmdPresetId ? `${qsTheme.green}30` : 'transparent',
                        }}
                      >
                        <div className="font-medium">None</div>
                      </button>
                      {amdPresets.map(preset => (
                        <button
                          key={preset.id}
                          onClick={() => {
                            setQsAmdPresetId(preset.id);
                            setQsAmdDropdownOpen(false);
                          }}
                          className={`w-full text-left px-4 py-2.5 text-xs transition-all cursor-pointer ${
                            qsAmdPresetId === preset.id
                              ? 'text-white'
                              : 'text-gray-300'
                          } hover:bg-white/10`}
                          style={{
                            backgroundColor: qsAmdPresetId === preset.id ? `${qsTheme.green}30` : 'transparent',
                          }}
                        >
                          <div className="font-medium">{preset.name}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Intel Preset Dropdown */}
                {intelPresets.length > 0 && (
                  <div className="relative">
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-blue-400">⟡</span>
                        Intel Preset
                      </div>
                    </label>
                    <button
                      onClick={() => {
                        setQsIntelDropdownOpen(!qsIntelDropdownOpen);
                        setQsNvidiaDropdownOpen(false);
                        setQsAmdDropdownOpen(false);
                        setQsCpuDropdownOpen(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 text-sm rounded-lg border transition-all flex items-center justify-between ${
                        qsIntelPresetId && intelPresets.some(p => p.id === qsIntelPresetId)
                          ? 'text-white'
                          : 'text-gray-300'
                      }`}
                      style={{
                        backgroundColor: qsTheme.bgSecondary,
                        borderColor: qsIntelDropdownOpen ? qsTheme.green : qsTheme.border,
                      }}
                    >
                      <span className="truncate">
                        {qsIntelPresetId && intelPresets.some(p => p.id === qsIntelPresetId)
                          ? intelPresets.find(p => p.id === qsIntelPresetId)!.name
                          : 'None'}
                      </span>
                      <ChevronDown className={`h-4 w-4 flex-shrink-0 ml-1 transition-transform ${
                        qsIntelDropdownOpen ? 'rotate-180' : ''
                      }`} />
                    </button>
                    <div
                      className={`absolute left-0 right-0 top-full mt-1 rounded-md overflow-hidden transition-all duration-200 z-50 ${
                        qsIntelDropdownOpen
                          ? 'max-h-60 opacity-100'
                          : 'max-h-0 opacity-0'
                      }`}
                      style={{ backgroundColor: qsTheme.bgSecondary, border: `1px solid ${qsTheme.border}` }}
                    >
                      <button
                        onClick={() => {
                          setQsIntelPresetId('');
                          setQsIntelDropdownOpen(false);
                        }}
                        className={`w-full text-left px-4 py-2.5 text-xs transition-all cursor-pointer ${
                          !qsIntelPresetId
                            ? 'text-white'
                            : 'text-gray-300'
                        } hover:bg-white/10`}
                        style={{
                          backgroundColor: !qsIntelPresetId ? `${qsTheme.green}30` : 'transparent',
                        }}
                      >
                        <div className="font-medium">None</div>
                      </button>
                      {intelPresets.map(preset => (
                        <button
                          key={preset.id}
                          onClick={() => {
                            setQsIntelPresetId(preset.id);
                            setQsIntelDropdownOpen(false);
                          }}
                          className={`w-full text-left px-4 py-2.5 text-xs transition-all cursor-pointer ${
                            qsIntelPresetId === preset.id
                              ? 'text-white'
                              : 'text-gray-300'
                          } hover:bg-white/10`}
                          style={{
                            backgroundColor: qsIntelPresetId === preset.id ? `${qsTheme.green}30` : 'transparent',
                          }}
                        >
                          <div className="font-medium">{preset.name}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* CPU Preset Dropdown */}
                {cpuPresets.length > 0 && (
                  <div className="relative">
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-yellow-400">⟡</span>
                        CPU Preset (Fallback)
                      </div>
                    </label>
                    <button
                      onClick={() => {
                        setQsCpuDropdownOpen(!qsCpuDropdownOpen);
                        setQsNvidiaDropdownOpen(false);
                        setQsAmdDropdownOpen(false);
                        setQsIntelDropdownOpen(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 text-sm rounded-lg border transition-all flex items-center justify-between ${
                        qsCpuPresetId && cpuPresets.some(p => p.id === qsCpuPresetId)
                          ? 'text-white'
                          : 'text-gray-300'
                      }`}
                      style={{
                        backgroundColor: qsTheme.bgSecondary,
                        borderColor: qsCpuDropdownOpen ? qsTheme.green : qsTheme.border,
                      }}
                    >
                      <span className="truncate">
                        {qsCpuPresetId && cpuPresets.some(p => p.id === qsCpuPresetId)
                          ? cpuPresets.find(p => p.id === qsCpuPresetId)!.name
                          : 'None'}
                      </span>
                      <ChevronDown className={`h-4 w-4 flex-shrink-0 ml-1 transition-transform ${
                        qsCpuDropdownOpen ? 'rotate-180' : ''
                      }`} />
                    </button>
                    <div
                      className={`absolute left-0 right-0 top-full mt-1 rounded-md overflow-hidden transition-all duration-200 z-50 ${
                        qsCpuDropdownOpen
                          ? 'max-h-60 opacity-100'
                          : 'max-h-0 opacity-0'
                      }`}
                      style={{ backgroundColor: qsTheme.bgSecondary, border: `1px solid ${qsTheme.border}` }}
                    >
                      <button
                        onClick={() => {
                          setQsCpuPresetId('');
                          setQsCpuDropdownOpen(false);
                        }}
                        className={`w-full text-left px-4 py-2.5 text-xs transition-all cursor-pointer ${
                          !qsCpuPresetId
                            ? 'text-white'
                            : 'text-gray-300'
                        } hover:bg-white/10`}
                        style={{
                          backgroundColor: !qsCpuPresetId ? `${qsTheme.green}30` : 'transparent',
                        }}
                      >
                        <div className="font-medium">None</div>
                      </button>
                      {cpuPresets.map(preset => (
                        <button
                          key={preset.id}
                          onClick={() => {
                            setQsCpuPresetId(preset.id);
                            setQsCpuDropdownOpen(false);
                          }}
                          className={`w-full text-left px-4 py-2.5 text-xs transition-all cursor-pointer ${
                            qsCpuPresetId === preset.id
                              ? 'text-white'
                              : 'text-gray-300'
                          } hover:bg-white/10`}
                          style={{
                            backgroundColor: qsCpuPresetId === preset.id ? `${qsTheme.green}30` : 'transparent',
                          }}
                        >
                          <div className="font-medium">{preset.name}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <p className="text-sm text-gray-500">
                Select which preset to use for each GPU vendor. Smart Transcode will automatically choose the appropriate preset based on the available hardware.
                The CPU preset is used as a fallback when no GPU is available.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // List View
  if (view === 'list') {
    const presetSections = [
      {
        id: 'cpu' as const,
        title: 'CPU / Software',
        description: 'Universal software encoding with maximum compatibility',
        icon: Cpu,
        color: '#74c69d',
        presets: categorizedPresets.cpu,
      },
      {
        id: 'nvidia' as const,
        title: 'NVIDIA NVENC',
        description: 'Hardware-accelerated profiles for NVIDIA GPUs',
        icon: Zap,
        color: '#76b900',
        presets: categorizedPresets.nvidia,
      },
      {
        id: 'amd' as const,
        title: 'AMD AMF',
        description: 'Hardware-accelerated profiles for AMD Radeon GPUs',
        icon: Zap,
        color: '#ed4c5c',
        presets: categorizedPresets.amd,
      },
      {
        id: 'intel' as const,
        title: 'Intel Quick Sync',
        description: 'Efficient hardware encoding for Intel graphics',
        icon: Zap,
        color: '#60a5fa',
        presets: categorizedPresets.intel,
      },
    ];
    const visibleSections = presetSections.filter(section => activeCategory === 'all' || activeCategory === section.id);
    const visiblePresetCount = visibleSections.reduce((total, section) => total + section.presets.length, 0);
    const customPresetCount = allPresets.filter((preset: any) => !preset.is_builtin && preset.id !== 'builtin-analyze').length;
    const hardwarePresetCount = allPresets.filter((preset: any) => preset.config?.encoding_type === 'gpu').length;
    const categoryTabs = [
      { id: 'all' as const, label: 'All profiles', count: allPresets.length - 1 },
      { id: 'quick' as const, label: 'Quick Select', count: filteredQuickSelectPresets.length },
      { id: 'cpu' as const, label: 'CPU', count: categorizedPresets.cpu.length },
      { id: 'nvidia' as const, label: 'NVIDIA', count: categorizedPresets.nvidia.length },
      { id: 'amd' as const, label: 'AMD', count: categorizedPresets.amd.length },
      { id: 'intel' as const, label: 'Intel', count: categorizedPresets.intel.length },
    ];

    return (
      <div className="mx-auto max-w-[1600px] space-y-5 pb-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#74c69d]">
              <Sliders className="h-3.5 w-3.5" />
              Encoding profiles
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Presets</h1>
            <p className="mt-1.5 text-sm text-gray-400">Build reusable encoding profiles and route jobs to the right hardware.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              onClick={handleOpenQSCreate}
              variant="outline"
              className="border-[#4b5650] text-[#95d5b2]"
            >
              <Layers3 className="mr-2 h-4 w-4" />
              New Quick Select
            </Button>
            <Button
              onClick={handleOpenCreate}
              style={{ backgroundColor: '#74c69d', color: '#1a1a1a', border: 'none' }}
            >
              <Plus className="mr-2 h-4 w-4" />
              New Preset
            </Button>
          </div>
        </div>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-[#39363a] bg-[#282729] p-5">
            <div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">Total profiles</p><p className="mt-3 text-3xl font-semibold text-white">{allPresets.length - 1}</p></div><div className="rounded-xl bg-[#74c69d]/10 p-2.5 text-[#74c69d]"><Film className="h-5 w-5" /></div></div>
            <p className="mt-2 text-xs text-gray-500">Across CPU and GPU encoders</p>
          </div>
          <div className="rounded-2xl border border-[#39363a] bg-[#282729] p-5">
            <div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">Quick Select</p><p className="mt-3 text-3xl font-semibold text-white">{quickSelectPresets.length}</p></div><div className="rounded-xl bg-[#a78bfa]/10 p-2.5 text-[#a78bfa]"><Layers3 className="h-5 w-5" /></div></div>
            <p className="mt-2 text-xs text-gray-500">Automatic hardware routing</p>
          </div>
          <div className="rounded-2xl border border-[#39363a] bg-[#282729] p-5">
            <div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">GPU profiles</p><p className="mt-3 text-3xl font-semibold text-white">{hardwarePresetCount}</p></div><div className="rounded-xl bg-[#60a5fa]/10 p-2.5 text-[#60a5fa]"><Zap className="h-5 w-5" /></div></div>
            <p className="mt-2 text-xs text-gray-500">NVIDIA, AMD, and Intel</p>
          </div>
          <div className="rounded-2xl border border-[#39363a] bg-[#282729] p-5">
            <div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">Custom profiles</p><p className="mt-3 text-3xl font-semibold text-white">{customPresetCount}</p></div><div className="rounded-xl bg-amber-400/10 p-2.5 text-amber-300"><Sliders className="h-5 w-5" /></div></div>
            <p className="mt-2 text-xs text-gray-500">Editable profiles you created</p>
          </div>
        </section>

        <section className="rounded-2xl border border-[#39363a] bg-[#282729] p-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="relative min-w-0 flex-1 xl:max-w-md">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-600" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search by name, codec, vendor, or container…"
                className="h-10 w-full rounded-xl border border-[#39363a] bg-[#1e1d1f] pl-10 pr-4 text-sm text-white outline-none placeholder:text-gray-600 focus:border-[#74c69d]/60"
              />
            </div>
            <div className="flex gap-1 overflow-x-auto pb-1 xl:pb-0">
              {categoryTabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveCategory(tab.id)}
                  className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ${activeCategory === tab.id ? 'bg-[#74c69d] text-[#1e1d1f]' : 'text-gray-400'}`}
                >
                  {tab.label}
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${activeCategory === tab.id ? 'bg-black/10 text-[#1e1d1f]' : 'bg-white/[0.05] text-gray-500'}`}>{tab.count}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        {(activeCategory === 'all' || activeCategory === 'quick') && (
          <section className="overflow-hidden rounded-2xl border border-[#39363a] bg-[#282729]">
            <div className="flex flex-col gap-3 border-b border-[#39363a] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="rounded-xl bg-[#a78bfa]/10 p-2.5 text-[#a78bfa]"><Layers3 className="h-5 w-5" /></div>
                <div>
                  <div className="flex items-center gap-2"><h2 className="font-semibold text-white">Quick Select routing</h2><span className="rounded-full bg-[#a78bfa]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#c4b5fd]">Smart Transcode</span></div>
                  <p className="mt-1 text-xs text-gray-500">One choice that automatically maps to the correct hardware profile.</p>
                </div>
              </div>
              <button onClick={handleOpenQSCreate} className="flex items-center gap-1.5 text-xs font-medium text-[#c4b5fd]"><Plus className="h-3.5 w-3.5" />Add route</button>
            </div>
            {filteredQuickSelectPresets.length === 0 ? (
              <div className="flex min-h-40 flex-col items-center justify-center p-6 text-center"><Layers3 className="h-6 w-6 text-gray-600" /><p className="mt-3 text-sm text-gray-400">{searchQuery ? 'No matching Quick Select profiles' : 'No Quick Select profiles yet'}</p><p className="mt-1 text-xs text-gray-600">{searchQuery ? 'Try a different name, vendor, or mapped preset.' : 'Create one to route Smart Transcode jobs by GPU vendor.'}</p></div>
            ) : (
              <div className="grid gap-3 p-3 lg:grid-cols-2">
                {filteredQuickSelectPresets.map((quickPreset: any) => {
                  const mappings = [
                    { vendor: 'NVIDIA', id: quickPreset.nvidia_preset_id, color: '#76b900' },
                    { vendor: 'AMD', id: quickPreset.amd_preset_id, color: '#ed4c5c' },
                    { vendor: 'Intel', id: quickPreset.intel_preset_id, color: '#60a5fa' },
                    { vendor: 'CPU', id: quickPreset.cpu_preset_id, color: '#fbbf24' },
                  ];
                  return (
                    <div key={quickPreset.id} className="rounded-xl border border-[#39363a] bg-[#222123] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0"><div className="flex items-center gap-2"><h3 className="truncate text-sm font-semibold text-white">{quickPreset.name}</h3>{quickPreset.is_builtin && <span className="flex items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-gray-500"><Lock className="h-2.5 w-2.5" />Built-in</span>}</div><p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">{quickPreset.description || 'Automatic preset selection based on available hardware.'}</p></div>
                        {!quickPreset.is_builtin && <div className="flex shrink-0 gap-1"><button onClick={() => handleOpenQSEdit(quickPreset)} className="rounded-md p-1.5 text-gray-500" title="Edit Quick Select"><Sliders className="h-3.5 w-3.5" /></button><button onClick={() => { if (confirm(`Delete Quick Select preset "${quickPreset.name}"?`)) deleteQSMutation.mutate(quickPreset.id); }} disabled={deleteQSMutation.isPending} className="rounded-md p-1.5 text-gray-500 disabled:opacity-50" title="Delete Quick Select"><Trash2 className="h-3.5 w-3.5" /></button></div>}
                      </div>
                      <div className="mt-4 grid gap-2 sm:grid-cols-2">
                        {mappings.map(mapping => {
                          const mappedPreset = allPresets.find((preset: any) => preset.id === mapping.id);
                          return <div key={mapping.vendor} className="flex min-w-0 items-center gap-2 rounded-lg bg-black/10 px-2.5 py-2"><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: mapping.id ? mapping.color : '#4b5563' }} /><div className="min-w-0"><p className="text-[9px] font-semibold uppercase tracking-wider text-gray-600">{mapping.vendor}</p><p className="truncate text-[11px] text-gray-300">{mappedPreset?.name || 'Not configured'}</p></div></div>;
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {activeCategory !== 'quick' && visibleSections.map(section => (
          <PresetSection
            key={section.id}
            title={section.title}
            description={section.description}
            icon={section.icon}
            color={section.color}
            presets={section.presets}
            onEdit={handleOpenEdit}
            onDelete={(id) => deleteMutation.mutate(id)}
          />
        ))}

        {activeCategory !== 'quick' && visiblePresetCount === 0 && (
          <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-[#39363a] bg-[#282729]/40 p-6 text-center">
            <Search className="h-7 w-7 text-gray-600" />
            <p className="mt-3 text-sm font-medium text-gray-300">No matching presets</p>
            <p className="mt-1 text-xs text-gray-600">Try another search or hardware category.</p>
          </div>
        )}
      </div>
    );
  }

  // Create/Edit View
  return (
    <div className="mx-auto max-w-[1500px] space-y-5 pb-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-3">
          <button onClick={handleBack} className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#39363a] bg-[#282729] text-gray-400" aria-label="Back to presets"><ArrowLeft className="h-4 w-4" /></button>
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#74c69d]"><Sliders className="h-3.5 w-3.5" />Preset editor</div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">{view === 'edit' ? 'Edit preset' : 'Create preset'}</h1>
            <p className="mt-1 text-sm text-gray-400">Configure the output, encoder, quality, and media handling.</p>
          </div>
        </div>
        <Button onClick={handleSave} disabled={!isFormValid || createMutation.isPending || updateMutation.isPending} style={{ backgroundColor: '#74c69d', color: '#1a1a1a', border: 'none' }} className="disabled:opacity-50">
          {createMutation.isPending || updateMutation.isPending ? 'Saving…' : view === 'edit' ? 'Save changes' : 'Create preset'}
        </Button>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          <section className="overflow-hidden rounded-2xl border border-[#39363a] bg-[#282729]">
            <div className="flex items-center gap-3 border-b border-[#39363a] px-5 py-4"><div className="rounded-xl bg-[#74c69d]/10 p-2.5 text-[#74c69d]"><Film className="h-5 w-5" /></div><div><h2 className="font-semibold text-white">Identity & output</h2><p className="mt-0.5 text-xs text-gray-500">Name this profile and choose its output container.</p></div></div>
            <div className="space-y-5 p-5">
              <div className="grid gap-4 md:grid-cols-2">
                <div><label className="mb-2 block text-xs font-medium text-gray-300">Preset name <span className="text-red-400">*</span></label><input type="text" value={presetName} onChange={event => setPresetName(event.target.value)} placeholder="e.g. Archive H.265" className="h-11 w-full rounded-xl border border-[#39363a] bg-[#1e1d1f] px-3.5 text-sm text-white outline-none placeholder:text-gray-600 focus:border-[#74c69d]/60" disabled={editingPreset?.is_builtin} /></div>
                <div><label className="mb-2 block text-xs font-medium text-gray-300">Description</label><input type="text" value={presetDescription} onChange={event => setPresetDescription(event.target.value)} placeholder="What is this profile best for?" className="h-11 w-full rounded-xl border border-[#39363a] bg-[#1e1d1f] px-3.5 text-sm text-white outline-none placeholder:text-gray-600 focus:border-[#74c69d]/60" /></div>
              </div>
              <div><label className="mb-2 block text-xs font-medium text-gray-300">Container format <span className="text-red-400">*</span></label><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{CONTAINERS.map(container => <button key={container.value} onClick={() => updateConfig('format', container.value)} className={`rounded-xl border px-4 py-2.5 text-sm font-medium ${config.format === container.value ? 'border-[#74c69d] bg-[#74c69d] text-[#1e1d1f]' : 'border-[#39363a] bg-[#222123] text-gray-400'}`}>{container.label}</button>)}</div></div>
              {!containerSupportsSubtitles(config.format) && <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/[0.07] p-3 text-xs leading-5 text-amber-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{config.format.toUpperCase()} does not support embedded subtitles in Encorr. Subtitle tracks will be omitted.</div>}
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-[#39363a] bg-[#282729]">
            <div className="flex items-center justify-between border-b border-[#39363a] px-5 py-4"><div className="flex items-center gap-3"><div className="rounded-xl bg-[#60a5fa]/10 p-2.5 text-[#60a5fa]"><Monitor className="h-5 w-5" /></div><div><h2 className="font-semibold text-white">Video encoding</h2><p className="mt-0.5 text-xs text-gray-500">Select the engine and balance quality against output size.</p></div></div><span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${config.encoding_type === 'gpu' ? 'bg-[#a78bfa]/10 text-[#c4b5fd]' : 'bg-[#74c69d]/10 text-[#95d5b2]'}`}>{config.encoding_type === 'gpu' ? `${config.gpu_type || ''} GPU` : 'CPU'}</span></div>
            <div className="space-y-6 p-5">
              <div><label className="mb-3 block text-xs font-medium text-gray-300">Video encoder <span className="text-red-400">*</span></label><div className="space-y-4">{['software', 'hardware'].map(category => <div key={category}><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-600">{category === 'software' ? 'Software / CPU' : 'Hardware / GPU'}</p><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{VIDEO_ENCODERS.filter(encoder => encoder.category === category).map(encoder => <button key={encoder.value} onClick={() => handleVideoEncoderChange(encoder.value)} className={`rounded-xl border px-3 py-2.5 text-left text-xs font-medium ${config.video_encoder === encoder.value ? 'border-[#74c69d] bg-[#74c69d]/10 text-[#b7e4c7]' : 'border-[#39363a] bg-[#222123] text-gray-400'}`}>{encoder.label}</button>)}</div></div>)}</div></div>

              <div className="rounded-xl border border-[#39363a] bg-[#222123] p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-medium text-gray-300">Quality mode</p><p className="mt-1 text-[11px] text-gray-600">Constant quality is recommended for most content.</p></div><div className="grid grid-cols-2 rounded-lg bg-black/20 p-1"><button onClick={() => handleQualityTypeChange('crf')} className={`rounded-md px-3 py-1.5 text-xs font-medium ${config.quality_type === 'crf' ? 'bg-[#74c69d] text-[#1e1d1f]' : 'text-gray-500'}`}>RF quality</button><button onClick={() => handleQualityTypeChange('bitrate')} className={`rounded-md px-3 py-1.5 text-xs font-medium ${config.quality_type === 'bitrate' ? 'bg-[#74c69d] text-[#1e1d1f]' : 'text-gray-500'}`}>Bitrate</button></div></div>
                <div className="mt-5 flex items-center gap-4"><input type="range" min={config.quality_type === 'crf' ? 0 : 500} max={config.quality_type === 'crf' ? 51 : 10000} step={config.quality_type === 'crf' ? 1 : 100} value={config.quality} onChange={event => updateConfig('quality', Number(event.target.value))} className="h-2 flex-1 cursor-pointer appearance-none rounded-lg bg-[#39363a]" style={{ accentColor: '#74c69d' }} /><div className="min-w-24 rounded-lg bg-black/20 px-3 py-2 text-center font-mono text-sm text-white">{config.quality_type === 'crf' ? `RF ${config.quality}` : `${config.quality}k`}</div></div>
                <p className="mt-2 text-[11px] text-gray-600">{config.quality_type === 'crf' ? config.quality < 18 ? 'Visually lossless; larger output.' : config.quality < 24 ? 'Balanced quality and compression.' : config.quality < 30 ? 'Smaller output with visible compression.' : 'Maximum compression; lower quality.' : `${config.quality} kbps average video bitrate.`}</p>
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <div><label className="mb-2 block text-xs font-medium text-gray-300">Resolution <span className="text-red-400">*</span></label><div className="grid grid-cols-2 gap-2">{RESOLUTIONS.map(resolution => <button key={resolution.value} onClick={() => handleResolutionChange(resolution.value)} className={`rounded-lg border px-2.5 py-2 text-xs ${config.resolution === resolution.value ? 'border-[#74c69d] bg-[#74c69d]/10 text-[#b7e4c7]' : 'border-[#39363a] bg-[#222123] text-gray-500'}`}>{resolution.label}</button>)}</div></div>
                <div className="space-y-4"><div><label className="mb-2 block text-xs font-medium text-gray-300">Framerate <span className="text-red-400">*</span></label><select value={config.framerate} onChange={event => updateConfig('framerate', event.target.value)} className="h-11 w-full rounded-xl border border-[#39363a] bg-[#1e1d1f] px-3.5 text-sm text-white outline-none">{FRAMERATES.map(framerate => <option key={framerate.value} value={framerate.value}>{framerate.label}</option>)}</select></div><div><label className="mb-2 block text-xs font-medium text-gray-300">Encoder speed</label><select value={config.preset} onChange={event => updateConfig('preset', event.target.value as FormPresetConfig['preset'])} className="h-11 w-full rounded-xl border border-[#39363a] bg-[#1e1d1f] px-3.5 text-sm capitalize text-white outline-none">{PRESET_SPEEDS.map(speed => <option key={speed} value={speed}>{speed}</option>)}</select><p className="mt-1.5 text-[10px] text-gray-600">Slower presets improve compression but take longer.</p></div></div>
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-[#39363a] bg-[#282729]">
            <div className="flex items-center gap-3 border-b border-[#39363a] px-5 py-4"><div className="rounded-xl bg-[#a78bfa]/10 p-2.5 text-[#a78bfa]"><Music2 className="h-5 w-5" /></div><div><h2 className="font-semibold text-white">Audio & media</h2><p className="mt-0.5 text-xs text-gray-500">Control audio conversion, subtitle tracks, and filtering.</p></div></div>
            <div className="grid gap-5 p-5 md:grid-cols-2">
              <div><label className="mb-2 block text-xs font-medium text-gray-300">Audio encoder <span className="text-red-400">*</span></label><select value={config.audio_encoder_label} onChange={event => updateConfig('audio_encoder_label', event.target.value)} className="h-11 w-full rounded-xl border border-[#39363a] bg-[#1e1d1f] px-3.5 text-sm text-white outline-none">{AUDIO_ENCODERS.map(encoder => <option key={encoder.value} value={encoder.value}>{encoder.label}</option>)}</select><p className="mt-1.5 text-[10px] text-gray-600">Copy preserves the original audio without re-encoding.</p></div>
              <div className={config.audio_encoder_label === 'copy' ? 'opacity-40' : ''}><label className="mb-2 flex justify-between text-xs font-medium text-gray-300"><span>Audio bitrate</span><span className="font-mono text-gray-500">{config.audio_bitrate} kbps</span></label><input type="range" min={64} max={640} step={32} value={config.audio_bitrate} disabled={config.audio_encoder_label === 'copy'} onChange={event => updateConfig('audio_bitrate', Number(event.target.value))} className="mt-3 h-2 w-full cursor-pointer appearance-none rounded-lg bg-[#39363a] disabled:cursor-not-allowed" style={{ accentColor: '#a78bfa' }} /></div>
              <div><label className="mb-2 block text-xs font-medium text-gray-300">Subtitle tracks</label><div className="grid grid-cols-3 gap-2">{(['all', 'first', 'none'] as const).map(option => <button key={option} onClick={() => updateConfig('subtitles', option)} disabled={!containerSupportsSubtitles(config.format)} className={`rounded-lg border px-2 py-2.5 text-xs capitalize disabled:cursor-not-allowed disabled:opacity-35 ${config.subtitles === option ? 'border-[#a78bfa] bg-[#a78bfa]/10 text-[#c4b5fd]' : 'border-[#39363a] bg-[#222123] text-gray-500'}`}>{option}</button>)}</div></div>
              <div><label className="mb-2 block text-xs font-medium text-gray-300">Video filters</label><button onClick={() => updateConfig('deinterlace', !config.deinterlace)} className={`flex w-full items-center justify-between rounded-xl border px-3.5 py-3 text-left ${config.deinterlace ? 'border-[#74c69d]/60 bg-[#74c69d]/10' : 'border-[#39363a] bg-[#222123]'}`}><div><p className={`text-xs font-medium ${config.deinterlace ? 'text-[#b7e4c7]' : 'text-gray-400'}`}>Deinterlace source</p><p className="mt-1 text-[10px] text-gray-600">Remove interlacing artifacts from older media.</p></div><span className={`h-5 w-9 rounded-full p-0.5 ${config.deinterlace ? 'bg-[#74c69d]' : 'bg-[#39363a]'}`}><span className={`block h-4 w-4 rounded-full bg-white transition-transform ${config.deinterlace ? 'translate-x-4' : ''}`} /></span></button></div>
            </div>
          </section>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <div className="overflow-hidden rounded-2xl border border-[#39363a] bg-[#282729]">
            <div className="border-b border-[#39363a] p-5"><div className="flex items-center justify-between"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">Summary</p><span className={`h-2 w-2 rounded-full ${isFormValid ? 'bg-[#74c69d]' : 'bg-amber-400'}`} /></div><h2 className="mt-3 truncate text-xl font-semibold text-white">{presetName || 'Untitled preset'}</h2><p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">{presetDescription || 'Your preset description will appear here.'}</p></div>
            <div className="space-y-4 p-5">
              <div className="flex flex-wrap gap-1.5"><span className="rounded-md bg-[#74c69d]/10 px-2 py-1 text-[10px] font-semibold text-[#95d5b2]">{config.video_codec.toUpperCase()}</span><span className="rounded-md bg-white/[0.05] px-2 py-1 text-[10px] font-semibold uppercase text-gray-400">{config.format}</span><span className="rounded-md bg-[#a78bfa]/10 px-2 py-1 text-[10px] font-semibold uppercase text-[#c4b5fd]">{config.encoding_type === 'gpu' ? config.gpu_type : 'CPU'}</span></div>
              <div className="space-y-3 text-xs">{[
                ['Encoder', VIDEO_ENCODERS.find(encoder => encoder.value === config.video_encoder)?.label || config.video_encoder],
                ['Quality', config.quality_type === 'crf' ? `RF ${config.quality}` : `${config.quality} kbps`],
                ['Resolution', RESOLUTIONS.find(resolution => resolution.value === config.resolution)?.label || config.resolution],
                ['Framerate', FRAMERATES.find(framerate => framerate.value === config.framerate)?.label || config.framerate],
                ['Audio', AUDIO_ENCODERS.find(encoder => encoder.value === config.audio_encoder_label)?.label || config.audio_encoder_label],
                ['Subtitles', containerSupportsSubtitles(config.format) ? config.subtitles : 'Not supported'],
                ['Speed', config.preset],
              ].map(([label, value]) => <div key={label} className="flex items-start justify-between gap-4"><span className="text-gray-600">{label}</span><span className="text-right font-medium capitalize text-gray-300">{value}</span></div>)}</div>
            </div>
          </div>

          <div className={`rounded-2xl border p-4 ${isFormValid ? 'border-[#74c69d]/20 bg-[#74c69d]/[0.06]' : 'border-amber-500/20 bg-amber-500/[0.06]'}`}>
            <div className="flex items-start gap-3"><AlertCircle className={`mt-0.5 h-4 w-4 shrink-0 ${isFormValid ? 'text-[#74c69d]' : 'text-amber-400'}`} /><div><p className={`text-xs font-medium ${isFormValid ? 'text-[#b7e4c7]' : 'text-amber-300'}`}>{isFormValid ? 'Ready to save' : 'Preset needs attention'}</p><p className="mt-1 text-[11px] leading-5 text-gray-500">{isFormValid ? 'All required settings are configured.' : 'Complete the name and required encoding settings.'}</p></div></div>
          </div>

          <Button onClick={handleSave} disabled={!isFormValid || createMutation.isPending || updateMutation.isPending} style={{ backgroundColor: '#74c69d', color: '#1a1a1a', border: 'none' }} className="w-full disabled:opacity-50">{createMutation.isPending || updateMutation.isPending ? 'Saving…' : view === 'edit' ? 'Save changes' : 'Create preset'}</Button>
        </aside>
      </div>
    </div>
  );
}

interface PresetSectionProps {
  title: string;
  description: string;
  icon: typeof Cpu;
  color: string;
  presets: any[];
  onEdit: (preset: any) => void;
  onDelete: (id: string) => void;
}

function PresetSection({ title, description, icon: Icon, color, presets, onEdit, onDelete }: PresetSectionProps) {
  if (presets.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-[#39363a] bg-[#282729]">
      <div className="flex items-center justify-between border-b border-[#39363a] px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl p-2.5" style={{ backgroundColor: `${color}16`, color }}><Icon className="h-5 w-5" /></div>
          <div>
            <div className="flex items-center gap-2"><h2 className="font-semibold text-white">{title}</h2><span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-medium text-gray-500">{presets.length}</span></div>
            <p className="mt-1 text-xs text-gray-500">{description}</p>
          </div>
        </div>
      </div>
      <div className="grid gap-3 p-3 md:grid-cols-2 2xl:grid-cols-3">
        {presets.map(preset => <PresetCard key={preset.id} preset={preset} onEdit={onEdit} onDelete={onDelete} accent={color} />)}
      </div>
    </section>
  );
}

// Preset Card Component
interface PresetCardProps {
  preset: any;
  onEdit: (preset: any) => void;
  onDelete: (id: string) => void;
  accent: string;
}

function PresetCard({ preset, onEdit, onDelete, accent }: PresetCardProps) {
  const config = preset.config || {};
  const qualityMode = (config.quality_mode || 'crf').toUpperCase();
  const resolution = config.max_height ? `${config.max_height}p max` : 'Source';
  const audio = config.audio_encoder === 'copy' ? 'Audio copy' : (config.audio_encoder || 'AAC').toUpperCase();

  return (
    <article className="flex min-h-[220px] flex-col rounded-xl border border-[#39363a] bg-[#222123] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 rounded-lg p-2" style={{ backgroundColor: `${accent}14`, color: accent }}><Film className="h-4 w-4" /></div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-white">{preset.name}</h3>
              {preset.is_builtin && <span className="flex shrink-0 items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-gray-500"><Lock className="h-2.5 w-2.5" />Built-in</span>}
            </div>
            <p className="mt-1 line-clamp-2 min-h-[40px] text-xs leading-5 text-gray-500">{preset.description || 'Custom transcoding configuration.'}</p>
          </div>
        </div>
        {!preset.is_builtin && <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => onEdit(preset)}
              className="rounded-md p-1.5 text-gray-500"
              title="Edit preset"
            >
              <Sliders className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => {
                if (confirm(`Delete preset "${preset.name}"?`)) {
                  onDelete(preset.id);
                }
              }}
              className="rounded-md p-1.5 text-gray-500"
              title="Delete preset"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>}
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        <span className="rounded-md px-2 py-1 text-[10px] font-semibold" style={{ backgroundColor: `${accent}14`, color: accent }}>{config.video_codec?.toUpperCase() || 'H.264'}</span>
        <span className="rounded-md bg-white/[0.05] px-2 py-1 text-[10px] font-medium uppercase text-gray-400">{config.container || 'mkv'}</span>
        <span className="rounded-md bg-white/[0.05] px-2 py-1 text-[10px] font-medium text-gray-400">{config.encoding_type === 'gpu' ? `${config.gpu_type?.toUpperCase() || 'GPU'} hardware` : 'Software'}</span>
      </div>

      <div className="mt-auto grid grid-cols-2 gap-x-4 gap-y-2 border-t border-[#39363a]/80 pt-3 text-[11px]">
        <div className="flex items-center gap-2 text-gray-500"><Gauge className="h-3 w-3" /><span className="truncate">{qualityMode} {config.quality ?? 'Auto'}</span></div>
        <div className="flex items-center gap-2 text-gray-500"><Monitor className="h-3 w-3" /><span className="truncate">{resolution}</span></div>
        <div className="flex items-center gap-2 text-gray-500"><Music2 className="h-3 w-3" /><span className="truncate">{audio}</span></div>
        <div className="flex items-center gap-2 text-gray-500"><Box className="h-3 w-3" /><span className="truncate capitalize">{config.preset || 'medium'} speed</span></div>
      </div>
    </article>
  );
}
