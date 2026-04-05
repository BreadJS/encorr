import { ReactNode, useEffect, useState } from 'react';
import { X } from 'lucide-react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

export function Dialog({ open, onClose, title, children, footer, size = 'md' }: DialogProps) {
  const [isClosing, setIsClosing] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setIsVisible(true);
      setIsClosing(false);
    } else {
      setIsClosing(true);
      const timer = setTimeout(() => {
        setIsVisible(false);
        setIsClosing(false);
      }, 200); // Match animation duration
      return () => clearTimeout(timer);
    }
  }, [open]);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
    }, 200);
  };

  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/60 ${isClosing ? 'animate-dialog-backdrop-out' : 'animate-dialog-backdrop-in'}`}
        onClick={handleClose}
      />

      {/* Dialog */}
      <div
        className={`relative w-full rounded-lg shadow-lg flex flex-col max-h-[85vh] ${isClosing ? 'animate-dialog-content-out' : 'animate-dialog-content-in'}`}
        style={{
          backgroundColor: '#252326',
          border: '1px solid #38363a',
          maxWidth: size === 'lg' ? '42rem' : size === 'sm' ? '24rem' : '28rem',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: '#38363a' }}>
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto flex-1">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-2 p-4 border-t" style={{ borderColor: '#38363a' }}>
            {footer}
          </div>
        )}
      </div>

      <style>{`
        @keyframes dialog-backdrop-in {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        @keyframes dialog-backdrop-out {
          from {
            opacity: 1;
          }
          to {
            opacity: 0;
          }
        }

        @keyframes dialog-content-in {
          from {
            opacity: 0;
            transform: scale(0.95) translateY(10px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }

        @keyframes dialog-content-out {
          from {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
          to {
            opacity: 0;
            transform: scale(0.95) translateY(10px);
          }
        }

        .animate-dialog-backdrop-in {
          animation: dialog-backdrop-in 0.2s ease-out forwards;
        }

        .animate-dialog-backdrop-out {
          animation: dialog-backdrop-out 0.2s ease-in forwards;
        }

        .animate-dialog-content-in {
          animation: dialog-content-in 0.2s ease-out forwards;
        }

        .animate-dialog-content-out {
          animation: dialog-content-out 0.2s ease-in forwards;
        }
      `}</style>
    </div>
  );
}
