// ============================================================================
// Smart Transcode Dialog Component
// ============================================================================

import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Loader2, Cpu, Zap, Settings2, HardDrive, CheckCircle2 } from 'lucide-react';
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
  onConfirm: (mode: TranscodeMode) => Promise<void>;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function estimateSize(file: LibraryFile, mode: TranscodeMode): number {
  const originalSize = file.filesize || file.metadata?.size || 0;
  if (!originalSize) return 0;

  const codec = file.metadata?.video_codec?.toLowerCase() || '';
  const bitrate = file.metadata?.bitrate || 0;

  // Estimate compression ratio - all modes now target H.265 for space savings
  let compressionRatio = 0.5; // Default: 50% reduction

  if (codec.includes('265') || codec.includes('hevc')) {
    // H.265 source - already compressed, but we can still reduce bitrate
    // H.265 to H.265 re-encoding can achieve 10-30% additional compression
    if (bitrate > 5000000) {
      // High bitrate H.265 - more compression possible
      compressionRatio = 0.7; // 30% reduction
    } else if (bitrate > 3000000) {
      // Medium bitrate H.265
      compressionRatio = 0.8; // 20% reduction
    } else {
      // Low bitrate H.265 - minimal compression
      compressionRatio = 0.9; // 10% reduction
    }
  } else if (codec.includes('264') || codec.includes('avc')) {
    // H.264 source - excellent candidate for H.265 conversion
    // H.264 to H.265 typically achieves 40-60% compression
    if (bitrate > 8000000) {
      // Very high bitrate H.264 - maximum compression
      compressionRatio = 0.35; // 65% reduction
    } else if (bitrate > 5000000) {
      // High bitrate H.264
      compressionRatio = 0.4; // 60% reduction
    } else {
      // Normal bitrate H.264
      compressionRatio = 0.5; // 50% reduction
    }
  } else if (codec.includes('mpeg2') || codec.includes('mpeg2video')) {
    // MPEG-2 source (DVD rips) - excellent candidate for H.265 conversion
    // MPEG-2 is very inefficient, so H.265 provides massive compression
    if (bitrate > 8000000) {
      // Very high bitrate MPEG-2 - maximum compression
      compressionRatio = 0.25; // 75% reduction
    } else if (bitrate > 5000000) {
      // High bitrate MPEG-2
      compressionRatio = 0.3; // 70% reduction
    } else {
      // Normal bitrate MPEG-2 (typical DVD)
      compressionRatio = 0.35; // 65% reduction
    }
  }

  return Math.round(originalSize * compressionRatio);
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

  // Calculate previews based on selected mode
  const previews = files.map(file => ({
    fileId: file.id,
    fileName: file.filename,
    originalSize: file.filesize || file.metadata?.size || 0,
    estimatedSize: estimateSize(file, mode),
    codec: file.metadata?.video_codec || 'Unknown',
  }));

  const totalOriginalSize = previews.reduce((sum, p) => sum + p.originalSize, 0);
  const totalEstimatedSize = previews.reduce((sum, p) => sum + p.estimatedSize, 0);
  const spaceSaved = totalOriginalSize - totalEstimatedSize;
  const spaceSavedPercent = totalOriginalSize > 0
    ? ((spaceSaved / totalOriginalSize) * 100).toFixed(0)
    : '0';

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm(mode);
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to start transcoding:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title="Smart Transcode"
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
            disabled={isSubmitting || files.length === 0}
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
          Select files to transcode. The system will automatically optimize settings for your files.
        </p>

        {/* Mode Selection */}
        <div className="space-y-3">
          <h3 className="text-base font-semibold text-white">Processing Mode</h3>

          {/* Auto Mode */}
          <label
            className={`flex items-start space-x-3 rounded-lg border p-4 transition-colors cursor-pointer ${
              mode === 'auto' ? 'border-primary bg-primary/5' : 'hover:bg-white/5'
            }`}
            style={{ borderColor: mode === 'auto' ? '#74c69d' : '#39363a' }}
          >
            <input
              type="radio"
              name="transcode-mode"
              value="auto"
              checked={mode === 'auto'}
              onChange={() => setMode('auto')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="flex items-center gap-2 font-medium text-white">
                <Settings2 className="h-4 w-4" />
                Auto (Recommended)
              </div>
              <p className="mt-1 text-sm text-gray-400">
                System analyzes each file and chooses optimal settings. Uses GPU when available for best performance.
              </p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  Automatic
                </span>
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                  Optimal compression
                </span>
              </div>
            </div>
          </label>

          {/* GPU Mode */}
          <label
            className={`flex items-start space-x-3 rounded-lg border p-4 transition-colors cursor-pointer ${
              mode === 'gpu' ? 'border-primary bg-primary/5' : 'hover:bg-white/5'
            }`}
            style={{ borderColor: mode === 'gpu' ? '#74c69d' : '#39363a' }}
          >
            <input
              type="radio"
              name="transcode-mode"
              value="gpu"
              checked={mode === 'gpu'}
              onChange={() => setMode('gpu')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="flex items-center gap-2 font-medium text-white">
                <Zap className="h-4 w-4" />
                GPU (Maximum Speed)
              </div>
              <p className="mt-1 text-sm text-gray-400">
                Force GPU encoding for fastest transcoding. Minimal CPU usage. Requires compatible GPU.
              </p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-purple-100 px-2 py-0.5 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
                  Very fast
                </span>
                <span className="rounded-full bg-orange-100 px-2 py-0.5 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                  Low CPU usage
                </span>
              </div>
            </div>
          </label>

          {/* CPU Mode */}
          <label
            className={`flex items-start space-x-3 rounded-lg border p-4 transition-colors cursor-pointer ${
              mode === 'cpu' ? 'border-primary bg-primary/5' : 'hover:bg-white/5'
            }`}
            style={{ borderColor: mode === 'cpu' ? '#74c69d' : '#39363a' }}
          >
            <input
              type="radio"
              name="transcode-mode"
              value="cpu"
              checked={mode === 'cpu'}
              onChange={() => setMode('cpu')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="flex items-center gap-2 font-medium text-white">
                <Cpu className="h-4 w-4" />
                CPU (Maximum Compatibility)
              </div>
              <p className="mt-1 text-sm text-gray-400">
                Force CPU encoding. Works on any system but slower and higher CPU usage.
              </p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400">
                  Universal
                </span>
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                  Higher CPU usage
                </span>
              </div>
            </div>
          </label>
        </div>

        {/* File Preview */}
        <div className="space-y-2">
          <h3 className="text-base font-semibold text-white">Files to Transcode ({files.length})</h3>
          <div className="max-h-60 overflow-y-auto rounded-md border" style={{ borderColor: '#39363a' }}>
            <div className="grid grid-cols-12 gap-2 border-b p-2 text-xs font-medium text-gray-400" style={{ borderColor: '#39363a', backgroundColor: '#1E1D1F' }}>
              <div className="col-span-6">File Name</div>
              <div className="col-span-3 text-right">Original</div>
              <div className="col-span-3 text-right">Est. Output</div>
            </div>
            {previews.map((preview) => (
              <div
                key={preview.fileId}
                className="grid grid-cols-12 gap-2 border-b p-2 text-sm last:border-0"
                style={{ borderColor: '#39363a' }}
              >
                <div className="col-span-6 truncate text-gray-300" title={preview.fileName}>
                  {preview.fileName}
                </div>
                <div className="col-span-3 text-right text-gray-400">
                  {formatBytes(preview.originalSize)}
                </div>
                <div className="col-span-3 text-right text-green-400">
                  ~{formatBytes(preview.estimatedSize)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Summary */}
        <div className="rounded-lg p-4" style={{ backgroundColor: '#1E1D1F', border: '1px solid #39363a' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <HardDrive className="h-5 w-5 text-gray-400" />
              <div>
                <p className="text-sm font-medium text-white">Estimated Space Savings</p>
                <p className="text-xs text-gray-400">
                  Total: {formatBytes(totalEstimatedSize)} from {formatBytes(totalOriginalSize)}
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold text-green-400">
                {spaceSavedPercent}%
              </p>
              <p className="text-xs text-gray-400">
                {formatBytes(spaceSaved)} saved
              </p>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
