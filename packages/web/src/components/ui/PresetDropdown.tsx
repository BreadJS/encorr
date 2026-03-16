import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, Film } from 'lucide-react';

export interface PresetOption {
  id: string;
  name: string;
  description?: string;
  is_builtin?: boolean;
  format?: string;
  encoder?: string;
  quality?: number;
}

interface PresetDropdownProps {
  value: string | null;
  onChange: (value: string) => void;
  presets: PresetOption[];
  userPresets?: PresetOption[];
  label?: string;
  placeholder?: string;
  disabled?: boolean;
}

const ENCODER_COLORS: Record<string, string> = {
  'x264': '#74c69d',
  'x265': '#9C27B0',
  'nvenc_h264': '#76b900',
  'nvenc_h265': '#76b900',
  'svt_av1': '#ff6b6b',
  'copy': '#6b7280',
};

export function PresetDropdown({
  value,
  onChange,
  presets,
  userPresets = [],
  label: _label,
  placeholder = 'Select preset...',
  disabled = false,
}: PresetDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const allPresets = [...presets, ...userPresets];
  const selectedPreset = allPresets.find(p => p.id === value);

  const getEncoderLabel = (encoder?: string) => {
    if (!encoder) return '';
    if (encoder === 'copy') return 'Passthru';
    if (encoder.includes('x264')) return 'H.264';
    if (encoder.includes('x265')) return 'H.265';
    if (encoder.includes('av1')) return 'AV1';
    return encoder;
  };

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className="w-full px-3 py-2 text-sm rounded text-left focus:outline-none transition-all flex items-center justify-between"
        style={{
          backgroundColor: disabled ? '#2a2a2a' : '#38363a',
          border: '1px solid #38363a',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {selectedPreset ? (
            <>
              <span className="font-medium text-white truncate">{selectedPreset.name}</span>
              <span className="text-gray-500">•</span>
              {selectedPreset.encoder && (
                <span
                  className="text-xs px-1.5 py-0.5 rounded flex-shrink-0"
                  style={{
                    backgroundColor: ENCODER_COLORS[selectedPreset.encoder] || '#38363a',
                    color: '#ffffff'
                  }}
                >
                  {getEncoderLabel(selectedPreset.encoder)}
                </span>
              )}
              {selectedPreset.format && (
                <span className="text-xs px-1.5 py-0.5 rounded text-gray-400 flex-shrink-0" style={{ backgroundColor: '#2a2a2a' }}>
                  {selectedPreset.format.toUpperCase()}
                </span>
              )}
              {selectedPreset.quality !== undefined && selectedPreset.encoder !== 'copy' && (
                <span className="text-xs text-gray-500 flex-shrink-0">RF {selectedPreset.quality}</span>
              )}
            </>
          ) : (
            <span className="text-gray-500">{placeholder}</span>
          )}
        </div>
        <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform flex-shrink-0 ml-2 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div
          className="absolute w-full mt-1 rounded-lg shadow-xl max-h-64 overflow-y-auto"
          style={{ backgroundColor: '#252326', border: '1px solid #38363a', zIndex: 9999 }}
        >
          {/* User Presets Section */}
          {userPresets.length > 0 && (
            <div className="p-2">
              <div className="text-xs text-gray-500 uppercase px-2 py-1">User Presets</div>
              {userPresets.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => {
                    onChange(preset.id);
                    setIsOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2 py-2 rounded hover:bg-white/5 transition-colors"
                  style={{
                    backgroundColor: value === preset.id ? 'rgba(116, 198, 157, 0.1)' : 'transparent',
                  }}
                >
                  <div className="flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <Film className="h-3 w-3" style={{ color: '#74c69d' }} />
                      <span className="text-sm font-medium text-white">{preset.name}</span>
                      {value === preset.id && (
                        <Check className="h-3 w-3 ml-auto" style={{ color: '#74c69d' }} />
                      )}
                    </div>
                    {preset.description && (
                      <div className="text-xs text-gray-500 ml-5 mt-0.5">{preset.description}</div>
                    )}
                    {(preset.encoder || preset.format || preset.quality !== undefined) && (
                      <div className="flex items-center gap-2 ml-5 mt-1">
                        {preset.encoder && (
                          <span
                            className="text-xs px-1.5 py-0.5 rounded"
                            style={{
                              backgroundColor: ENCODER_COLORS[preset.encoder] || '#38363a',
                              color: '#ffffff'
                            }}
                          >
                            {getEncoderLabel(preset.encoder)}
                          </span>
                        )}
                        {preset.format && (
                          <span className="text-xs px-1.5 py-0.5 rounded text-gray-400" style={{ backgroundColor: '#38363a' }}>
                            {preset.format.toUpperCase()}
                          </span>
                        )}
                        {preset.quality !== undefined && preset.encoder !== 'copy' && (
                          <span className="text-xs text-gray-500">RF {preset.quality}</span>
                        )}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Built-in Presets Section */}
          {presets.length > 0 && (
            <div className={`p-2 ${userPresets.length > 0 ? 'border-t' : ''}`} style={{ borderColor: '#38363a' }}>
              <div className="text-xs text-gray-500 uppercase px-2 py-1">Presets</div>
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => {
                    onChange(preset.id);
                    setIsOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2 py-2 rounded hover:bg-white/5 transition-colors"
                  style={{
                    backgroundColor: value === preset.id ? 'rgba(116, 198, 157, 0.1)' : 'transparent',
                  }}
                >
                  <div className="flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <Film className="h-3 w-3 text-gray-400" />
                      <span className="text-sm font-medium text-white">{preset.name}</span>
                      {value === preset.id && (
                        <Check className="h-3 w-3 ml-auto" style={{ color: '#74c69d' }} />
                      )}
                    </div>
                    {preset.description && (
                      <div className="text-xs text-gray-500 ml-5 mt-0.5">{preset.description}</div>
                    )}
                    {(preset.encoder || preset.format || preset.quality !== undefined) && (
                      <div className="flex items-center gap-2 ml-5 mt-1">
                        {preset.encoder && (
                          <span
                            className="text-xs px-1.5 py-0.5 rounded"
                            style={{
                              backgroundColor: ENCODER_COLORS[preset.encoder] || '#38363a',
                              color: '#ffffff'
                            }}
                          >
                            {getEncoderLabel(preset.encoder)}
                          </span>
                        )}
                        {preset.format && (
                          <span className="text-xs px-1.5 py-0.5 rounded text-gray-400" style={{ backgroundColor: '#38363a' }}>
                            {preset.format.toUpperCase()}
                          </span>
                        )}
                        {preset.quality !== undefined && preset.encoder !== 'copy' && (
                          <span className="text-xs text-gray-500">RF {preset.quality}</span>
                        )}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* No presets available */}
          {presets.length === 0 && userPresets.length === 0 && (
            <div className="p-4 text-center text-gray-500 text-sm">
              No presets available
            </div>
          )}
        </div>
      )}
    </div>
  );
}
