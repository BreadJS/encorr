import { useState } from 'react';
import { Film, HardDrive, Clock, Settings, Check, X, Info } from 'lucide-react';
import { Button } from './Button';
import { PresetDropdown } from './PresetDropdown';
import { getPresetsForDropdown } from '@/data/presets';

const PRESET_OPTIONS = getPresetsForDropdown();

interface TranscodeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (presetId: string) => void;
  isPending: boolean;
  mode: 'all' | 'selected';
  files: any[];
  selectedFiles: Set<string>;
}

export function TranscodeDialog({
  isOpen,
  onClose,
  onConfirm,
  isPending,
  mode,
  files,
  selectedFiles,
}: TranscodeDialogProps) {
  if (!isOpen) return null;

  // Determine which files will be processed
  const filesToProcess = mode === 'all'
    ? files.filter((f: any) => f.status === 'analyzed')
    : files.filter((f: any) => selectedFiles.has(f.id) && f.status === 'analyzed');

  const filesNeedAnalysis = mode === 'all'
    ? files.filter((f: any) => f.status === 'pending').length
    : files.filter((f: any) => selectedFiles.has(f.id) && f.status === 'pending').length;

  // Calculate totals
  const totalSize = filesToProcess.reduce((sum: number, f: any) => sum + (f.filesize || f.file_size || f.size || 0), 0);
  const totalDuration = filesToProcess.reduce((sum: number, f: any) => sum + (f.duration || 0), 0);
  const totalFiles = filesToProcess.length;

  // Get unique codecs and resolutions
  const codecs = new Set(filesToProcess.map((f: any) => f.codec || f.video_codec || 'Unknown'));
  const resolutions = new Set(filesToProcess.map((f: any) => f.resolution || 'Unknown'));

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDuration = (seconds: number): string => {
    if (!seconds || seconds <= 0) return '0:00:00';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const getPresetInfo = () => {
    if (!selectedPreset) return null;
    return PRESET_OPTIONS.find(p => p.id === selectedPreset);
  };

  const presetInfo = getPresetInfo();

  const handleConfirm = () => {
    if (selectedPreset) {
      onConfirm(selectedPreset);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="relative w-full max-w-2xl mx-4 rounded-xl shadow-2xl"
        style={{ backgroundColor: '#252326', border: '1px solid #39363a' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#39363a]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg" style={{ backgroundColor: '#9C27B020' }}>
              <Film className="h-5 w-5" style={{ color: '#9C27B0' }} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">
                {mode === 'all' ? 'Transcode All Analyzed Files' : 'Transcode Selected Files'}
              </h2>
              <p className="text-sm text-gray-400">
                {totalFiles} file{totalFiles !== 1 ? 's' : ''} ready to transcode
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg transition-colors hover:bg-white/10"
          >
            <X className="h-5 w-5 text-gray-400" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-4">
          {/* Warning if files need analysis */}
          {filesNeedAnalysis > 0 && (
            <div className="flex items-start gap-3 p-3 rounded-lg" style={{ backgroundColor: '#f59e0b10', border: '1px solid #f59e0b30' }}>
              <Info className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-yellow-500">
                  {filesNeedAnalysis} file{filesNeedAnalysis !== 1 ? 's' : ''} need analysis first
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  These files will be skipped. Analyze them first to include in transcoding.
                </p>
              </div>
            </div>
          )}

          {/* Statistics */}
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 rounded-lg" style={{ backgroundColor: '#1a181a', border: '1px solid #39363a' }}>
              <div className="flex items-center gap-2 text-gray-400 mb-1">
                <HardDrive className="h-4 w-4" />
                <span className="text-xs uppercase font-medium">Total Size</span>
              </div>
              <p className="text-lg font-semibold text-white">{formatBytes(totalSize)}</p>
            </div>
            <div className="p-3 rounded-lg" style={{ backgroundColor: '#1a181a', border: '1px solid #39363a' }}>
              <div className="flex items-center gap-2 text-gray-400 mb-1">
                <Clock className="h-4 w-4" />
                <span className="text-xs uppercase font-medium">Duration</span>
              </div>
              <p className="text-lg font-semibold text-white">{formatDuration(totalDuration)}</p>
            </div>
            <div className="p-3 rounded-lg" style={{ backgroundColor: '#1a181a', border: '1px solid #39363a' }}>
              <div className="flex items-center gap-2 text-gray-400 mb-1">
                <Film className="h-4 w-4" />
                <span className="text-xs uppercase font-medium">File Count</span>
              </div>
              <p className="text-lg font-semibold text-white">{totalFiles}</p>
            </div>
          </div>

          {/* Format Info */}
          <div className="p-3 rounded-lg" style={{ backgroundColor: '#1a181a', border: '1px solid #39363a' }}>
            <div className="flex items-center gap-2 text-gray-400 mb-2">
              <Settings className="h-4 w-4" />
              <span className="text-xs uppercase font-medium">Source Information</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="text-xs">
                <span className="text-gray-500">Codecs: </span>
                <span className="text-gray-300">{Array.from(codecs).join(', ')}</span>
              </div>
              <div className="text-xs">
                <span className="text-gray-500">Resolutions: </span>
                <span className="text-gray-300">{Array.from(resolutions).join(', ')}</span>
              </div>
            </div>
          </div>

          {/* Preset Selection */}
          <div>
            <label className="block text-sm font-medium text-white mb-2">
              Select Transcode Preset
            </label>
            <PresetDropdown
              value={selectedPreset}
              onChange={setSelectedPreset}
              presets={PRESET_OPTIONS.filter(p => p.is_builtin)}
              userPresets={PRESET_OPTIONS.filter(p => !p.is_builtin)}
              placeholder="Choose a preset..."
            />
          </div>

          {/* Preset Info */}
          {presetInfo && (
            <div className="p-3 rounded-lg" style={{ backgroundColor: '#1a181a', border: '1px solid #39363a' }}>
              <div className="flex items-start gap-3">
                <div className="p-2 rounded" style={{ backgroundColor: '#9C27B020' }}>
                  <Film className="h-4 w-4" style={{ color: '#9C27B0' }} />
                </div>
                <div className="flex-1">
                  <h4 className="text-sm font-medium text-white">{presetInfo.name}</h4>
                  <p className="text-xs text-gray-400 mt-1">{presetInfo.description}</p>
                  <div className="flex gap-2 mt-2">
                    <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: '#2a2a2a', color: '#ffffff' }}>
                      {presetInfo.codec}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: '#2a2a2a', color: '#ffffff' }}>
                      Quality: {presetInfo.quality}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[#39363a]">
          <div className="text-sm text-gray-400">
            {totalFiles > 0 ? (
              <span className="flex items-center gap-1">
                <Check className="h-4 w-4 text-green-500" />
                Ready to start
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <X className="h-4 w-4 text-red-500" />
                No files to transcode
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={onClose}
              disabled={isPending}
              style={{ backgroundColor: '#38363a', color: '#ffffff' }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={!selectedPreset || totalFiles === 0 || isPending}
              style={{ backgroundColor: '#9C27B0', color: '#ffffff' }}
              className="disabled:opacity-50"
            >
              {isPending ? 'Starting...' : 'Start Transcoding'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
