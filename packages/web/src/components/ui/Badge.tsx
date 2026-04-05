import { HTMLAttributes } from 'react';
import { cn } from '@/utils/cn';

export function Badge({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors whitespace-nowrap',
        className
      )}
      style={{ backgroundColor: 'rgba(116, 198, 157, 0.1)', borderColor: 'rgba(116, 198, 157, 0.3)', color: '#95d5b2' }}
      {...props}
    />
  );
}

export function StatusBadge({ status }: { status: string }) {
  // User-friendly status names
  const friendlyNames: Record<string, string> = {
    'pending': 'Needs Analysis',
    'analyzed': 'Transcodeable',
    'queued': 'Queued',
    'processing': 'Processing',
    'completed': 'Completed',
    'failed': 'Failed',
    'cancelled': 'Cancelled',
    'skipped': 'Skipped',
    'online': 'Online',
    'offline': 'Offline',
    'busy': 'Busy',
    'error': 'Error',
    'misconfigured': 'Misconfigured',
  };

  const displayStatus = friendlyNames[status.toLowerCase()] || status;

  const variants: Record<string, { bg: string; color: string }> = {
    // File statuses
    'pending': { bg: '#f59e0b', color: '#ffffff' },        // Orange - Needs Analysis
    'analyzed': { bg: '#3b82f6', color: '#ffffff' },       // Blue - Ready to transcode
    'queued': { bg: '#6b7280', color: '#ffffff' },         // Gray - In queue
    'processing': { bg: '#8b5cf6', color: '#ffffff' },     // Purple - Currently processing
    'completed': { bg: '#10b981', color: '#ffffff' },      // Green - Success
    'failed': { bg: '#ef4444', color: '#ffffff' },         // Red - Failed
    'cancelled': { bg: '#6b7280', color: '#ffffff' },      // Gray - Cancelled
    'skipped': { bg: '#6b7280', color: '#ffffff' },        // Gray - Skipped

    // Node statuses
    'online': { bg: '#10b981', color: '#ffffff' },         // Green - Online
    'offline': { bg: '#6b7280', color: '#ffffff' },        // Gray - Offline
    'busy': { bg: '#f59e0b', color: '#ffffff' },           // Orange - Busy
    'error': { bg: '#ef4444', color: '#ffffff' },          // Red - Error
    'misconfigured': { bg: '#f59e0b', color: '#ffffff' },  // Orange - Misconfigured
    'wrong settings': { bg: '#f59e0b', color: '#ffffff' }, // Orange - Wrong settings
  };

  const style = variants[status.toLowerCase()] || variants['pending'];

  return (
    <Badge
      style={{ backgroundColor: style.bg, color: style.color, borderColor: 'transparent' }}
    >
      {displayStatus}
    </Badge>
  );
}
