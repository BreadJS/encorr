import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/utils/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Trash2, Plus, Lock, Film, Sliders, ArrowLeft, Cpu, Zap, AlertCircle, ChevronDown } from 'lucide-react';
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

  // Organize presets into categories
  const categorizedPresets = useMemo(() => {
    const allPresets = [...BUILTIN_PRESETS, ...(presets || []).filter((p: any) => !p.is_builtin)];
    return {
      cpu: allPresets.filter((p: any) => getPresetCategory(p) === 'cpu' && p.id !== 'builtin-analyze'),
      nvidia: allPresets.filter((p: any) => getPresetCategory(p) === 'nvidia'),
      amd: allPresets.filter((p: any) => getPresetCategory(p) === 'amd'),
      intel: allPresets.filter((p: any) => getPresetCategory(p) === 'intel'),
    };
  }, [presets]);

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
      audio_bitrate: config.audio_bitrate,
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
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white">Presets</h1>
            <p className="text-gray-400">Transcoding configuration presets</p>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handleOpenCreate}
              style={{ backgroundColor: '#74c69d', color: '#1a1a1a', border: 'none' }}
              className="hover:opacity-90"
            >
              <Plus className="mr-2 h-4 w-4" />
              Create Preset
            </Button>
            <Button
              onClick={handleOpenQSCreate}
              style={{ backgroundColor: '#74c69d', color: '#1a1a1a', border: 'none' }}
              className="hover:opacity-90"
            >
              <Zap className="mr-2 h-4 w-4" />
              Create Quick Select Preset
            </Button>
          </div>
        </div>

        {/* Quick Select Presets */}
        {quickSelectPresets.length > 0 && (
          <Card style={{ backgroundColor: '#252326', border: 'none' }}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Zap className="h-5 w-5 text-[#74c69d]" />
                  <h3 className="text-lg font-semibold text-white">Quick Select Presets</h3>
                </div>
              </div>
              <p className="text-sm text-gray-400 mb-4">
                Pre-configured profiles for Smart Transcode that automatically select the appropriate preset based on available GPU hardware
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {quickSelectPresets.map((qp: any) => (
                  <div
                    key={qp.id}
                    className="p-4 rounded-lg relative"
                    style={{ backgroundColor: '#1E1D1F' }}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Zap className="h-4 w-4 text-[#74c69d]" />
                          <h4 className="font-semibold text-white">{qp.name}</h4>
                          {qp.is_builtin && (
                            <Lock className="h-3 w-3 text-gray-500" />
                          )}
                        </div>
                        {qp.description && (
                          <p className="text-sm text-gray-400">{qp.description}</p>
                        )}
                      </div>
                      {!qp.is_builtin && (
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleOpenQSEdit(qp)}
                            className="p-1.5 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                            title="Edit"
                          >
                            <Sliders className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => deleteQSMutation.mutate(qp.id)}
                            disabled={deleteQSMutation.isPending}
                            className="p-1.5 rounded hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors disabled:opacity-50"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="mt-3 space-y-1 text-xs">
                      {qp.nvidia_preset_id && (
                        <div className="flex items-center gap-2 text-gray-400">
                          <span className="text-green-400">NVIDIA:</span>
                          <span>{presets?.find((p: any) => p.id === qp.nvidia_preset_id)?.name || 'Not set'}</span>
                        </div>
                      )}
                      {qp.amd_preset_id && (
                        <div className="flex items-center gap-2 text-gray-400">
                          <span className="text-red-400">AMD:</span>
                          <span>{presets?.find((p: any) => p.id === qp.amd_preset_id)?.name || 'Not set'}</span>
                        </div>
                      )}
                      {qp.intel_preset_id && (
                        <div className="flex items-center gap-2 text-gray-400">
                          <span className="text-blue-400">Intel:</span>
                          <span>{presets?.find((p: any) => p.id === qp.intel_preset_id)?.name || 'Not set'}</span>
                        </div>
                      )}
                      {qp.cpu_preset_id && (
                        <div className="flex items-center gap-2 text-gray-400">
                          <span className="text-yellow-400">CPU:</span>
                          <span>{presets?.find((p: any) => p.id === qp.cpu_preset_id)?.name || 'Not set'}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* CPU Presets */}
        {categorizedPresets.cpu.length > 0 && (
          <Card style={{ backgroundColor: '#252326', border: 'none' }}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Cpu className="h-5 w-5 text-blue-400" />
                <h3 className="text-lg font-semibold text-white">CPU Presets</h3>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {categorizedPresets.cpu.map((preset: any) => (
                  <PresetCard
                    key={preset.id}
                    preset={preset}
                    onEdit={handleOpenEdit}
                    onDelete={(id) => deleteMutation.mutate(id)}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* NVIDIA GPU Presets */}
        {categorizedPresets.nvidia.length > 0 && (
          <Card style={{ backgroundColor: '#252326', border: 'none' }}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-5 w-5 rounded bg-[#76b900]" />
                <h3 className="text-lg font-semibold text-white">NVIDIA GPU Presets</h3>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {categorizedPresets.nvidia.map((preset: any) => (
                  <PresetCard
                    key={preset.id}
                    preset={preset}
                    onEdit={handleOpenEdit}
                    onDelete={(id) => deleteMutation.mutate(id)}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* AMD GPU Presets */}
        {categorizedPresets.amd.length > 0 && (
          <Card style={{ backgroundColor: '#252326', border: 'none' }}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-5 w-5 rounded bg-[#ED1C24]" />
                <h3 className="text-lg font-semibold text-white">AMD GPU Presets</h3>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {categorizedPresets.amd.map((preset: any) => (
                  <PresetCard
                    key={preset.id}
                    preset={preset}
                    onEdit={handleOpenEdit}
                    onDelete={(id) => deleteMutation.mutate(id)}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Intel GPU Presets */}
        {categorizedPresets.intel.length > 0 && (
          <Card style={{ backgroundColor: '#252326', border: 'none' }}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-5 w-5 rounded bg-[#0068B5]" />
                <h3 className="text-lg font-semibold text-white">Intel GPU Presets</h3>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {categorizedPresets.intel.map((preset: any) => (
                  <PresetCard
                    key={preset.id}
                    preset={preset}
                    onEdit={handleOpenEdit}
                    onDelete={(id) => deleteMutation.mutate(id)}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  // Create/Edit View
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
            {view === 'edit' ? 'Edit Preset' : 'Create Preset'}
          </h1>
          <p className="text-gray-400">
            {view === 'edit' ? 'Modify existing preset configuration' : 'Create a new transcoding preset'}
          </p>
        </div>
        <Button
          onClick={handleSave}
          disabled={!isFormValid || createMutation.isPending || updateMutation.isPending}
          style={{ backgroundColor: '#74c69d', color: '#1a1a1a', border: 'none' }}
          className="hover:opacity-90 disabled:opacity-50"
        >
          {view === 'edit' ? 'Save Changes' : 'Create Preset'}
        </Button>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Main Form */}
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
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    placeholder="e.g., My Custom Preset"
                    className="w-full px-4 py-2.5 rounded-lg text-white placeholder-gray-500 focus:outline-none transition-colors"
                    style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                    disabled={editingPreset?.is_builtin}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Description</label>
                  <textarea
                    value={presetDescription}
                    onChange={(e) => setPresetDescription(e.target.value)}
                    placeholder="Describe what this preset is best for..."
                    rows={2}
                    className="w-full px-4 py-2.5 rounded-lg text-white placeholder-gray-500 focus:outline-none transition-colors resize-none"
                    style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                  />
                </div>
              </div>

              {/* Container */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-3">
                  Container Format <span className="text-red-400">*</span>
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {CONTAINERS.map((container) => (
                    <button
                      key={container.value}
                      onClick={() => updateConfig('format', container.value)}
                      className={`px-4 py-3 text-sm rounded-lg transition-all ${
                        config.format === container.value
                          ? 'bg-[#74c69d] text-black font-medium'
                          : 'text-gray-300 hover:text-white hover:bg-white/5'
                      }`}
                      style={{
                        backgroundColor: config.format === container.value ? '#74c69d' : '#38363a',
                      }}
                    >
                      {container.label}
                    </button>
                  ))}
                </div>
                {!containerSupportsSubtitles(config.format) && (
                  <div className="mt-2 flex items-start gap-2 p-3 rounded-lg" style={{ backgroundColor: '#fff3cd20' }}>
                    <AlertCircle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-yellow-400">
                      {config.format.toUpperCase()} does not support embedded subtitles. Subtitles will not be included in the output file.
                    </p>
                  </div>
                )}
              </div>

              {/* Video Encoder */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-3">
                  Video Encoder <span className="text-red-400">*</span>
                </label>
                <div className="space-y-3">
                  {['software', 'hardware'].map((category) => (
                    <div key={category}>
                      <div className="text-xs text-gray-500 uppercase mb-2">{category === 'software' ? 'CPU (Software)' : 'GPU (Hardware)'}</div>
                      <div className="grid grid-cols-2 gap-2">
                        {VIDEO_ENCODERS.filter(e => e.category === category).map((encoder) => (
                          <button
                            key={encoder.value}
                            onClick={() => handleVideoEncoderChange(encoder.value)}
                            className={`px-4 py-2.5 text-sm rounded-lg transition-all text-left ${
                              config.video_encoder === encoder.value
                                ? 'text-black font-medium'
                                : 'text-gray-300 hover:text-white'
                            }`}
                            style={{
                              backgroundColor: config.video_encoder === encoder.value ? '#74c69d' : '#38363a'
                            }}
                          >
                            {encoder.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quality */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="block text-sm font-medium text-gray-300">
                    Quality Mode <span className="text-red-400">*</span>
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleQualityTypeChange('crf')}
                      className={`px-3 py-1.5 text-sm rounded-lg transition-all ${
                        config.quality_type === 'crf' ? 'text-black font-medium' : 'text-gray-400'
                      }`}
                      style={{ backgroundColor: config.quality_type === 'crf' ? '#74c69d' : '#38363a' }}
                    >
                      RF (Quality)
                    </button>
                    <button
                      onClick={() => handleQualityTypeChange('bitrate')}
                      className={`px-3 py-1.5 text-sm rounded-lg transition-all ${
                        config.quality_type === 'bitrate' ? 'text-black font-medium' : 'text-gray-400'
                      }`}
                      style={{ backgroundColor: config.quality_type === 'bitrate' ? '#74c69d' : '#38363a' }}
                    >
                      Bitrate
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min={config.quality_type === 'crf' ? 0 : 500}
                    max={config.quality_type === 'crf' ? 51 : 10000}
                    step={config.quality_type === 'crf' ? 1 : 100}
                    value={config.quality}
                    onChange={(e) => updateConfig('quality', parseFloat(e.target.value))}
                    className="flex-1 h-2 rounded-lg appearance-none cursor-pointer"
                    style={{ backgroundColor: '#38363a', accentColor: '#74c69d' }}
                  />
                  <span className="text-white font-medium w-24 text-right">
                    {config.quality_type === 'crf' ? `RF ${config.quality}` : `${config.quality} kbps`}
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-2">
                  {config.quality_type === 'crf'
                    ? config.quality < 18 ? 'Very high quality, larger file'
                    : config.quality < 24 ? 'Good quality (recommended)'
                    : config.quality < 30 ? 'High compression'
                    : 'Maximum compression, lower quality'
                    : `${config.quality} kbps average bitrate`}
                </p>
              </div>

              {/* Resolution */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-3">
                  Resolution <span className="text-red-400">*</span>
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {RESOLUTIONS.map((res) => (
                    <button
                      key={res.value}
                      onClick={() => updateConfig('resolution', res.value)}
                      className={`px-4 py-2.5 text-sm rounded-lg transition-all ${
                        config.resolution === res.value
                          ? 'text-black font-medium'
                          : 'text-gray-300 hover:text-white'
                      }`}
                      style={{
                        backgroundColor: config.resolution === res.value ? '#74c69d' : '#38363a'
                      }}
                    >
                      {res.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Framerate */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-3">
                  Framerate <span className="text-red-400">*</span>
                </label>
                <select
                  value={config.framerate}
                  onChange={(e) => updateConfig('framerate', e.target.value)}
                  className="w-full px-4 py-2.5 rounded-lg text-white focus:outline-none transition-colors"
                  style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                >
                  {FRAMERATES.map((fr) => (
                    <option key={fr.value} value={fr.value}>{fr.label}</option>
                  ))}
                </select>
              </div>

              {/* Audio Encoder */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-3">
                  Audio Encoder <span className="text-red-400">*</span>
                </label>
                <select
                  value={config.audio_encoder_label}
                  onChange={(e) => updateConfig('audio_encoder_label', e.target.value)}
                  className="w-full px-4 py-2.5 rounded-lg text-white focus:outline-none transition-colors"
                  style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                >
                  {AUDIO_ENCODERS.map((encoder) => (
                    <option key={encoder.value} value={encoder.value}>{encoder.label}</option>
                  ))}
                </select>
              </div>

              {/* Encoder Preset */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-3">
                  Encoder Speed
                </label>
                <select
                  value={config.preset}
                  onChange={(e) => updateConfig('preset', e.target.value as any)}
                  className="w-full px-4 py-2.5 rounded-lg text-white focus:outline-none transition-colors"
                  style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                >
                  {PRESET_SPEEDS.map((speed) => (
                    <option key={speed} value={speed}>{speed}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">Faster = lower quality, Slower = higher quality</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Preset Summary */}
        <div className="space-y-6">
          <Card style={{ backgroundColor: '#252326', border: 'none' }}>
            <CardContent className="p-4">
              <h3 className="text-lg font-semibold text-white mb-4">Preset Summary</h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Name</span>
                  <span className="text-white font-medium truncate ml-2">{presetName || 'Untitled'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Container</span>
                  <span className="text-white font-medium">
                    {CONTAINERS.find(c => c.value === config.format)?.label || config.format}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Video Encoder</span>
                  <span className="text-white font-medium text-right">
                    {VIDEO_ENCODERS.find(e => e.value === config.video_encoder)?.label || config.video_encoder}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Quality</span>
                  <span className="text-white font-medium">
                    {config.quality_type === 'crf' ? `RF ${config.quality}` : `${config.quality} kbps`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Resolution</span>
                  <span className="text-white font-medium">
                    {RESOLUTIONS.find(r => r.value === config.resolution)?.label || config.resolution}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Framerate</span>
                  <span className="text-white font-medium">
                    {FRAMERATES.find(f => f.value === config.framerate)?.label || config.framerate}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Audio Encoder</span>
                  <span className="text-white font-medium">
                    {AUDIO_ENCODERS.find(e => e.value === config.audio_encoder_label)?.label || config.audio_encoder_label}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Speed Preset</span>
                  <span className="text-white font-medium">{config.preset}</span>
                </div>
              </div>

              {presetDescription && (
                <div className="mt-4 pt-4 border-t" style={{ borderColor: '#38363a' }}>
                  <span className="text-gray-400 text-sm">Description</span>
                  <p className="text-white text-sm mt-1">{presetDescription}</p>
                </div>
              )}

              {/* Validation warning */}
              {!isFormValid && (
                <div className="mt-4 pt-4 border-t" style={{ borderColor: '#38363a' }}>
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-red-400">
                      Please fill in all required fields (marked with *)
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// Preset Card Component
interface PresetCardProps {
  preset: any;
  onEdit: (preset: any) => void;
  onDelete: (id: string) => void;
}

function PresetCard({ preset, onEdit, onDelete }: PresetCardProps) {
  return (
    <div
      className="p-3 rounded-lg transition-all hover:shadow-lg group"
      style={{ backgroundColor: '#1E1D1F' }}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Film className="h-4 w-4 text-gray-400 flex-shrink-0" />
          <h4 className="text-sm font-medium text-white truncate">{preset.name}</h4>
          {preset.is_builtin && (
            <Lock className="h-3 w-3 text-gray-500 flex-shrink-0" />
          )}
        </div>
        {!preset.is_builtin && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => onEdit(preset)}
              className="text-gray-400 hover:text-white p-1 transition-colors"
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
              className="text-gray-400 hover:text-red-400 p-1 transition-colors"
              title="Delete preset"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {preset.description && (
        <p className="text-xs text-gray-400 line-clamp-2 mb-2">{preset.description}</p>
      )}

      <div className="flex items-center gap-2 text-xs">
        <span className="px-2 py-0.5 rounded text-white" style={{ backgroundColor: '#38363a' }}>
          {preset.config.video_codec?.toUpperCase() || 'H264'}
        </span>
        <span className="text-gray-500">
          {preset.config.encoding_type === 'gpu' ? 'GPU' : 'CPU'}
        </span>
        {preset.config.encoding_type === 'gpu' && preset.config.gpu_type && (
          <span className="text-gray-500 uppercase">{preset.config.gpu_type}</span>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
        <span>RF {preset.config.quality}</span>
        <span>{preset.config.preset}</span>
      </div>
    </div>
  );
}
