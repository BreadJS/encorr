import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/utils/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Trash2, Plus, Lock, Film, Sliders, ChevronDown, ChevronUp, ArrowLeft } from 'lucide-react';
import { BUILTIN_PRESETS, type PresetConfig, defaultConfig } from '@/data/presets';
import { useState } from 'react';

// HandBrake encoder options
const VIDEO_ENCODERS = [
  { value: 'x264', label: 'H.264 (x264)', category: 'software' },
  { value: 'x264_10bit', label: 'H.264 10-bit (x264)', category: 'software' },
  { value: 'x265', label: 'H.265 (x265)', category: 'software' },
  { value: 'x265_10bit', label: 'H.265 10-bit (x265)', category: 'software' },
  { value: 'x265_12bit', label: 'H.265 12-bit (x265)', category: 'software' },
  { value: 'svt_av1', label: 'AV1 (SVT-AV1)', category: 'software' },
  { value: 'svt_av1_10bit', label: 'AV1 10-bit (SVT-AV1)', category: 'software' },
  { value: 'nvenc_h264', label: 'H.264 (NVIDIA NVENC)', category: 'hardware' },
  { value: 'nvenc_h265', label: 'H.265 (NVIDIA NVENC)', category: 'hardware' },
  { value: 'nvenc_h265_10bit', label: 'H.265 10-bit (NVIDIA NVENC)', category: 'hardware' },
  { value: 'vce_h264', label: 'H.264 (AMD VCE)', category: 'hardware' },
  { value: 'vce_h265', label: 'H.265 (AMD VCE)', category: 'hardware' },
  { value: 'vce_h265_10bit', label: 'H.265 10-bit (AMD VCE)', category: 'hardware' },
  { value: 'mpeg4', label: 'MPEG-4', category: 'legacy' },
  { value: 'mpeg2', label: 'MPEG-2', category: 'legacy' },
  { value: 'VP8', label: 'VP8', category: 'legacy' },
  { value: 'VP9', label: 'VP9', category: 'legacy' },
];

const AUDIO_ENCODERS = [
  { value: 'av_aac', label: 'AAC (av_aac)' },
  { value: 'copy:aac', label: 'AAC (passthru)' },
  { value: 'ac3', label: 'AC3' },
  { value: 'copy:ac3', label: 'AC3 (passthru)' },
  { value: 'eac3', label: 'EAC3' },
  { value: 'copy:eac3', label: 'EAC3 (passthru)' },
  { value: 'truehd', label: 'TrueHD' },
  { value: 'copy:truehd', label: 'TrueHD (passthru)' },
  { value: 'copy:dts', label: 'DTS (passthru)' },
  { value: 'copy:dtshd', label: 'DTS-HD (passthru)' },
  { value: 'mp3', label: 'MP3' },
  { value: 'copy:mp3', label: 'MP3 (passthru)' },
  { value: 'opus', label: 'Opus' },
  { value: 'copy:opus', label: 'Opus (passthru)' },
  { value: 'flac16', label: 'FLAC 16-bit' },
  { value: 'flac24', label: 'FLAC 24-bit' },
  { value: 'copy:flac', label: 'FLAC (passthru)' },
];

const CONTAINERS = [
  { value: 'av_mp4', label: 'MP4' },
  { value: 'av_mkv', label: 'MKV' },
  { value: 'av_mov', label: 'MOV' },
  { value: 'av_webm', label: 'WebM' },
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

const MIXDOWNS = [
  { value: 'mono', label: 'Mono' },
  { value: 'stereo', label: 'Stereo' },
  { value: 'dpl1', label: 'Dolby Pro Logic II' },
  { value: 'dpl2', label: 'Dolby Pro Logic II' },
  { value: '5point1', label: '5.1 Surround' },
  { value: '6point1', label: '6.1 Surround' },
  { value: '7point1', label: '7.1 Surround' },
];

const ENCODER_PRESETS = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium',
  'slow', 'slower', 'veryslow', 'placebo'
];

const ENCODER_TUNES = [
  '', 'film', 'animation', 'grain', 'stillimage', 'psnr', 'ssim', 'fastdecode', 'zerolatency'
];

// PresetConfig interface and defaultConfig are now imported from @/data/presets
// BUILTIN_PRESETS are now imported from @/data/presets

type AdvancedSection = 'video' | 'picture' | 'filters' | 'metadata' | null;

export function Presets() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<'list' | 'create' | 'edit'>('list');
  const [editingPreset, setEditingPreset] = useState<any | null>(null);
  const [isAdvanced, setIsAdvanced] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<AdvancedSection>>(new Set());

  const [presetName, setPresetName] = useState('');
  const [presetDescription, setPresetDescription] = useState('');
  const [config, setConfig] = useState<PresetConfig>(defaultConfig);

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

  const allPresets = [...BUILTIN_PRESETS, ...(presets || []).filter((p: any) => !p.is_builtin)];

  const handleOpenCreate = () => {
    setEditingPreset(null);
    setPresetName('');
    setPresetDescription('');
    setConfig({ ...defaultConfig });
    setIsAdvanced(false);
    setExpandedSections(new Set());
    setView('create');
  };

  const handleOpenEdit = (preset: any) => {
    if (preset.is_builtin) return;
    setEditingPreset(preset);
    setPresetName(preset.name);
    setPresetDescription(preset.description || '');
    setConfig(preset.config || { ...defaultConfig });
    setIsAdvanced(false);
    setExpandedSections(new Set());
    setView('edit');
  };

  const handleBack = () => {
    setView('list');
    setEditingPreset(null);
    setPresetName('');
    setPresetDescription('');
    setConfig({ ...defaultConfig });
    setIsAdvanced(false);
    setExpandedSections(new Set());
  };

  const handleSave = () => {
    const data = {
      name: presetName,
      description: presetDescription || undefined,
      config,
    };

    if (view === 'edit' && editingPreset) {
      updateMutation.mutate({ id: editingPreset.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const toggleSection = (section: AdvancedSection) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const updateConfig = <K extends keyof PresetConfig>(key: K, value: PresetConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  // List View
  if (view === 'list') {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white">Presets</h1>
            <p className="text-gray-400">Transcoding configuration presets for HandBrake</p>
          </div>
          <Button
            onClick={handleOpenCreate}
            style={{ borderColor: '#38363a', color: '#ffffff' }}
            className="hover:bg-gray-800"
          >
            <Plus className="mr-2 h-4 w-4" />
            Create Preset
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {allPresets.map((preset: any) => (
            <Card key={preset.id} style={{ backgroundColor: '#252326', border: '1px solid #38363a' }}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Film className="h-5 w-5 text-gray-400 flex-shrink-0" />
                    <h3 className="text-lg font-semibold text-white truncate">{preset.name}</h3>
                    {preset.is_builtin && (
                      <span title="Built-in preset">
                        <Lock className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
                      </span>
                    )}
                  </div>
                  {!preset.is_builtin && (
                    <button
                      onClick={() => handleOpenEdit(preset)}
                      className="text-gray-400 hover:text-white transition-colors ml-2"
                      title="Edit preset"
                    >
                      <Sliders className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {preset.description && (
                  <p className="text-sm text-gray-400 mb-3 line-clamp-2">{preset.description}</p>
                )}

                <div className="space-y-1.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Container:</span>
                    <span className="text-white font-medium">
                      {CONTAINERS.find(c => c.value === preset.config.format)?.label || preset.config.format}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Encoder:</span>
                    <span className="text-white font-medium">
                      {VIDEO_ENCODERS.find(e => e.value === preset.config.video_encoder)?.label || preset.config.video_encoder}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Quality:</span>
                    <span className="text-white font-medium">
                      {preset.config.video_encoder === 'copy' ? 'Passthru' :
                       preset.config.quality_type === 'rf' ? `RF ${preset.config.quality}` :
                       `${preset.config.quality} kbps`}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Resolution:</span>
                    <span className="text-white font-medium">
                      {RESOLUTIONS.find(r => r.value === preset.config.resolution)?.label || preset.config.resolution}
                    </span>
                  </div>
                </div>

                {!preset.is_builtin && (
                  <Button
                    onClick={() => {
                      if (confirm(`Delete preset "${preset.name}"?`)) {
                        deleteMutation.mutate(preset.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    style={{ backgroundColor: '#ef4444', color: '#ffffff', border: 'none' }}
                    className="w-full mt-3 hover:bg-red-600"
                    size="sm"
                  >
                    <Trash2 className="mr-2 h-3 w-3" />
                    Delete
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
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
          disabled={!presetName || createMutation.isPending || updateMutation.isPending}
          style={{ backgroundColor: '#74c69d', color: '#1a1a1a', border: 'none' }}
          className="hover:opacity-90"
        >
          {view === 'edit' ? 'Save Changes' : 'Create Preset'}
        </Button>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Main Form */}
        <div className="lg:col-span-2 space-y-6">
          <Card style={{ backgroundColor: '#252326', border: '1px solid #38363a' }}>
            <CardContent className="p-6 space-y-6">
              {/* Name and Description */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Preset Name *</label>
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
                    rows={3}
                    className="w-full px-4 py-2.5 rounded-lg text-white placeholder-gray-500 focus:outline-none transition-colors resize-none"
                    style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                  />
                </div>
              </div>

              {/* Mode Toggle */}
              <div className="flex items-center justify-between p-4 rounded-lg" style={{ backgroundColor: '#1E1D1F' }}>
                <span className="text-sm font-medium text-gray-300">Mode</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setIsAdvanced(false)}
                    className={`px-4 py-2 text-sm rounded-lg transition-all ${
                      !isAdvanced ? 'text-black font-medium' : 'text-gray-300'
                    }`}
                    style={{ backgroundColor: !isAdvanced ? '#74c69d' : '#38363a' }}
                  >
                    Basic
                  </button>
                  <button
                    onClick={() => setIsAdvanced(true)}
                    className={`px-4 py-2 text-sm rounded-lg transition-all ${
                      isAdvanced ? 'text-black font-medium' : 'text-gray-300'
                    }`}
                    style={{ backgroundColor: isAdvanced ? '#74c69d' : '#38363a' }}
                  >
                    Advanced
                  </button>
                </div>
              </div>

              {/* Basic Mode */}
              {!isAdvanced && (
                <div className="space-y-6">
                  {/* Container */}
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-3">Container Format</label>
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
                            border: config.format === container.value ? 'none' : '1px solid transparent'
                          }}
                        >
                          {container.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Video Encoder */}
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-3">Video Encoder</label>
                    <div className="space-y-3">
                      {['software', 'hardware', 'legacy'].map((category) => (
                        <div key={category}>
                          <div className="text-xs text-gray-500 uppercase mb-2">{category}</div>
                          <div className="grid grid-cols-2 gap-2">
                            {VIDEO_ENCODERS.filter(e => e.category === category).map((encoder) => (
                              <button
                                key={encoder.value}
                                onClick={() => updateConfig('video_encoder', encoder.value)}
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
                  {config.video_encoder !== 'copy' && (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <label className="block text-sm font-medium text-gray-300">Quality</label>
                        <div className="flex gap-2">
                          <button
                            onClick={() => updateConfig('quality_type', 'rf')}
                            className={`px-3 py-1.5 text-sm rounded-lg transition-all ${
                              config.quality_type === 'rf' ? 'text-black font-medium' : 'text-gray-400'
                            }`}
                            style={{ backgroundColor: config.quality_type === 'rf' ? '#74c69d' : '#38363a' }}
                          >
                            RF (Constant Quality)
                          </button>
                          <button
                            onClick={() => updateConfig('quality_type', 'bitrate')}
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
                          min={config.quality_type === 'rf' ? 0 : 500}
                          max={config.quality_type === 'rf' ? 51 : 20000}
                          step={config.quality_type === 'rf' ? 1 : 100}
                          value={config.quality}
                          onChange={(e) => updateConfig('quality', parseFloat(e.target.value))}
                          className="flex-1 h-2 rounded-lg appearance-none cursor-pointer"
                          style={{ backgroundColor: '#38363a', accentColor: '#74c69d' }}
                        />
                        <span className="text-white font-medium w-20 text-right text-lg">
                          {config.quality_type === 'rf' ? `RF ${config.quality}` : `${config.quality}k`}
                        </span>
                      </div>
                      <p className="text-sm text-gray-500 mt-2">
                        {config.quality_type === 'rf'
                          ? config.quality < 18 ? 'Very high quality, larger file'
                          : config.quality < 24 ? 'Good quality (recommended)'
                          : config.quality < 30 ? 'High compression'
                          : 'Maximum compression, lower quality'
                          : `${config.quality} kbps average bitrate`}
                      </p>
                    </div>
                  )}

                  {/* Resolution */}
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-3">Resolution</label>
                    <div className="grid grid-cols-3 gap-2">
                      {RESOLUTIONS.map((res) => (
                        <button
                          key={res.value}
                          onClick={() => updateConfig('resolution', res.value)}
                          className={`px-4 py-3 text-sm rounded-lg transition-all ${
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
                    <label className="block text-sm font-medium text-gray-300 mb-3">Framerate</label>
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
                    <label className="block text-sm font-medium text-gray-300 mb-3">Audio Encoder</label>
                    <select
                      value={config.audio_encoder}
                      onChange={(e) => updateConfig('audio_encoder', e.target.value)}
                      className="w-full px-4 py-2.5 rounded-lg text-white focus:outline-none transition-colors"
                      style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                      disabled={config.video_encoder === 'copy'}
                    >
                      {AUDIO_ENCODERS.map((encoder) => (
                        <option key={encoder.value} value={encoder.value}>{encoder.label}</option>
                      ))}
                    </select>
                  </div>

                  {/* Audio Settings */}
                  {config.audio_encoder !== 'copy' && config.audio_encoder !== 'none' && (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-3">Audio Bitrate</label>
                        <select
                          value={config.audio_bitrate}
                          onChange={(e) => updateConfig('audio_bitrate', parseInt(e.target.value))}
                          className="w-full px-4 py-2.5 rounded-lg text-white focus:outline-none transition-colors"
                          style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                        >
                          {[64, 80, 96, 128, 160, 192, 224, 256, 320, 384, 448, 512].map((bitrate) => (
                            <option key={bitrate} value={bitrate}>{bitrate} kbps</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-3">Audio Mixdown</label>
                        <select
                          value={config.audio_mixdown}
                          onChange={(e) => updateConfig('audio_mixdown', e.target.value)}
                          className="w-full px-4 py-2.5 rounded-lg text-white focus:outline-none transition-colors"
                          style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                        >
                          {MIXDOWNS.map((mix) => (
                            <option key={mix.value} value={mix.value}>{mix.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Advanced Mode */}
              {isAdvanced && (
                <div className="space-y-4">
                  {/* Video Section */}
                  <div className="border rounded-lg" style={{ borderColor: '#38363a' }}>
                    <button
                      onClick={() => toggleSection('video')}
                      className="w-full flex items-center justify-between p-4 text-left"
                    >
                      <span className="font-medium text-white">Video Settings</span>
                      {expandedSections.has('video') ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                    {expandedSections.has('video') && (
                      <div className="p-4 pt-0 space-y-4 border-t" style={{ borderColor: '#38363a' }}>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm text-gray-400 mb-2">Encoder Preset</label>
                            <select
                              value={config.encoder_preset || 'medium'}
                              onChange={(e) => updateConfig('encoder_preset', e.target.value)}
                              className="w-full px-3 py-2 rounded-lg text-white focus:outline-none transition-colors"
                              style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                            >
                              {ENCODER_PRESETS.map((preset) => (
                                <option key={preset} value={preset}>{preset}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-sm text-gray-400 mb-2">Encoder Tune</label>
                            <select
                              value={config.encoder_tune || ''}
                              onChange={(e) => updateConfig('encoder_tune', e.target.value)}
                              className="w-full px-3 py-2 rounded-lg text-white focus:outline-none transition-colors"
                              style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                            >
                              {ENCODER_TUNES.map((tune) => (
                                <option key={tune || 'default'} value={tune}>{tune || 'default'}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div className="flex items-center gap-6">
                          <label className="flex items-center gap-2 text-sm text-gray-300">
                            <input
                              type="checkbox"
                              checked={config.multipass || false}
                              onChange={(e) => updateConfig('multipass', e.target.checked)}
                              className="rounded"
                              style={{ backgroundColor: '#38363a', borderColor: '#38363a' }}
                            />
                            Multi-pass encoding
                          </label>
                          <label className="flex items-center gap-2 text-sm text-gray-300">
                            <input
                              type="checkbox"
                              checked={config.turbo || false}
                              onChange={(e) => updateConfig('turbo', e.target.checked)}
                              className="rounded"
                              style={{ backgroundColor: '#38363a', borderColor: '#38363a' }}
                            />
                            Turbo first pass
                          </label>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Picture Section */}
                  <div className="border rounded-lg" style={{ borderColor: '#38363a' }}>
                    <button
                      onClick={() => toggleSection('picture')}
                      className="w-full flex items-center justify-between p-4 text-left"
                    >
                      <span className="font-medium text-white">Picture Settings</span>
                      {expandedSections.has('picture') ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                    {expandedSections.has('picture') && (
                      <div className="p-4 pt-0 space-y-4 border-t" style={{ borderColor: '#38363a' }}>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm text-gray-400 mb-2">Max Width (pixels)</label>
                            <input
                              type="number"
                              value={config.width || ''}
                              onChange={(e) => updateConfig('width', e.target.value ? parseInt(e.target.value) : undefined)}
                              placeholder="Auto"
                              className="w-full px-3 py-2 rounded-lg text-white focus:outline-none transition-colors"
                              style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-400 mb-2">Max Height (pixels)</label>
                            <input
                              type="number"
                              value={config.height || ''}
                              onChange={(e) => updateConfig('height', e.target.value ? parseInt(e.target.value) : undefined)}
                              placeholder="Auto"
                              className="w-full px-3 py-2 rounded-lg text-white focus:outline-none transition-colors"
                              style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Filters Section */}
                  <div className="border rounded-lg" style={{ borderColor: '#38363a' }}>
                    <button
                      onClick={() => toggleSection('filters')}
                      className="w-full flex items-center justify-between p-4 text-left"
                    >
                      <span className="font-medium text-white">Filters</span>
                      {expandedSections.has('filters') ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                    {expandedSections.has('filters') && (
                      <div className="p-4 pt-0 space-y-4 border-t" style={{ borderColor: '#38363a' }}>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm text-gray-400 mb-2">Denoise</label>
                            <select
                              value={config.denoise || 'none'}
                              onChange={(e) => updateConfig('denoise', e.target.value as any)}
                              className="w-full px-3 py-2 rounded-lg text-white focus:outline-none transition-colors"
                              style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                            >
                              <option value="none">None</option>
                              <option value="ultralight">Ultra Light</option>
                              <option value="light">Light</option>
                              <option value="medium">Medium</option>
                              <option value="strong">Strong</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-sm text-gray-400 mb-2">Sharpen</label>
                            <select
                              value={config.sharpen || 'none'}
                              onChange={(e) => updateConfig('sharpen', e.target.value as any)}
                              className="w-full px-3 py-2 rounded-lg text-white focus:outline-none transition-colors"
                              style={{ backgroundColor: '#38363a', border: '1px solid #38363a' }}
                            >
                              <option value="none">None</option>
                              <option value="ultralight">Ultra Light</option>
                              <option value="light">Light</option>
                              <option value="medium">Medium</option>
                              <option value="strong">Strong</option>
                            </select>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-4">
                          <label className="flex items-center gap-2 text-sm text-gray-300">
                            <input
                              type="checkbox"
                              checked={config.deinterlace || false}
                              onChange={(e) => updateConfig('deinterlace', e.target.checked)}
                              className="rounded"
                              style={{ backgroundColor: '#38363a', borderColor: '#38363a' }}
                            />
                            Deinterlace
                          </label>
                          <label className="flex items-center gap-2 text-sm text-gray-300">
                            <input
                              type="checkbox"
                              checked={config.decomb || false}
                              onChange={(e) => updateConfig('decomb', e.target.checked)}
                              className="rounded"
                              style={{ backgroundColor: '#38363a', borderColor: '#38363a' }}
                            />
                            Decomb
                          </label>
                          <label className="flex items-center gap-2 text-sm text-gray-300">
                            <input
                              type="checkbox"
                              checked={config.detelecine || false}
                              onChange={(e) => updateConfig('detelecine', e.target.checked)}
                              className="rounded"
                              style={{ backgroundColor: '#38363a', borderColor: '#38363a' }}
                            />
                            Detelecine
                          </label>
                          <label className="flex items-center gap-2 text-sm text-gray-300">
                            <input
                              type="checkbox"
                              checked={config.deblock || false}
                              onChange={(e) => updateConfig('deblock', e.target.checked)}
                              className="rounded"
                              style={{ backgroundColor: '#38363a', borderColor: '#38363a' }}
                            />
                            Deblock
                          </label>
                          <label className="flex items-center gap-2 text-sm text-gray-300">
                            <input
                              type="checkbox"
                              checked={config.grayscale || false}
                              onChange={(e) => updateConfig('grayscale', e.target.checked)}
                              className="rounded"
                              style={{ backgroundColor: '#38363a', borderColor: '#38363a' }}
                            />
                            Grayscale
                          </label>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Metadata Section */}
                  <div className="border rounded-lg" style={{ borderColor: '#38363a' }}>
                    <button
                      onClick={() => toggleSection('metadata')}
                      className="w-full flex items-center justify-between p-4 text-left"
                    >
                      <span className="font-medium text-white">Metadata & Optimization</span>
                      {expandedSections.has('metadata') ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                    {expandedSections.has('metadata') && (
                      <div className="p-4 pt-0 space-y-3 border-t" style={{ borderColor: '#38363a' }}>
                        <label className="flex items-center gap-2 text-sm text-gray-300">
                          <input
                            type="checkbox"
                            checked={config.optimize_mp4 || false}
                            onChange={(e) => updateConfig('optimize_mp4', e.target.checked)}
                            className="rounded"
                              style={{ backgroundColor: '#38363a', borderColor: '#38363a' }}
                          />
                          Optimize MP4 (Web Fast Start)
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-300">
                          <input
                            type="checkbox"
                            checked={config.ipod_atom || false}
                            onChange={(e) => updateConfig('ipod_atom', e.target.checked)}
                            className="rounded"
                              style={{ backgroundColor: '#38363a', borderColor: '#38363a' }}
                          />
                          Add iPod 5G atom
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-300">
                          <input
                            type="checkbox"
                            checked={config.markers !== false}
                            onChange={(e) => updateConfig('markers', e.target.checked)}
                            className="rounded"
                              style={{ backgroundColor: '#38363a', borderColor: '#38363a' }}
                          />
                          Chapter markers
                        </label>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Preview Panel */}
        <div className="space-y-6">
          <Card style={{ backgroundColor: '#252326', border: '1px solid #38363a' }}>
            <CardContent className="p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Preset Summary</h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Name</span>
                  <span className="text-white font-medium">{presetName || 'Untitled'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Container</span>
                  <span className="text-white font-medium">
                    {CONTAINERS.find(c => c.value === config.format)?.label || config.format}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Video Encoder</span>
                  <span className="text-white font-medium">
                    {VIDEO_ENCODERS.find(e => e.value === config.video_encoder)?.label || config.video_encoder}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Quality</span>
                  <span className="text-white font-medium">
                    {config.video_encoder === 'copy' ? 'Passthru' :
                     config.quality_type === 'rf' ? `RF ${config.quality}` :
                     `${config.quality} kbps`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Resolution</span>
                  <span className="text-white font-medium">
                    {RESOLUTIONS.find(r => r.value === config.resolution)?.label || config.resolution}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Audio Encoder</span>
                  <span className="text-white font-medium">
                    {AUDIO_ENCODERS.find(e => e.value === config.audio_encoder)?.label || config.audio_encoder}
                  </span>
                </div>
              </div>

              {presetDescription && (
                <div className="mt-4 pt-4 border-t" style={{ borderColor: '#38363a' }}>
                  <span className="text-gray-400 text-sm">Description</span>
                  <p className="text-white text-sm mt-1">{presetDescription}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
