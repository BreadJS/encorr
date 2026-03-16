import { HTMLAttributes } from 'react';
import { cn } from '@/utils/cn';

interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  value: number;
  max?: number;
}

export function Progress({ className, value, max = 100, ...props }: ProgressProps) {
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100);

  return (
    <div
      className={cn('relative h-2 w-full overflow-hidden rounded-full', className)}
      style={{ backgroundColor: 'rgba(116, 198, 157, 0.2)' }}
      {...props}
    >
      <div
        className="h-full transition-all duration-300 ease-in-out"
        style={{
          transform: `translateX(-${100 - percentage}%)`,
          backgroundColor: '#74c69d',
          width: '100%'
        }}
      />
    </div>
  );
}
