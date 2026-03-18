import { forwardRef } from 'react';
import { cn } from '@/utils/cn';

export interface RadioGroupProps {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}

export function RadioGroup({ children, className }: RadioGroupProps) {
  return (
    <div className={cn('space-y-2', className)}>
      {children}
    </div>
  );
}

export interface RadioGroupItemProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value'> {
  value: string;
  id: string;
}

export const RadioGroupItem = forwardRef<HTMLInputElement, RadioGroupItemProps>(
  ({ className, id, ...props }, ref) => {
    return (
      <input
        type="radio"
        id={id}
        className={cn(
          'h-4 w-4 shrink-0 rounded-full border transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 appearance-none cursor-pointer',
          className
        )}
        style={{
          accentColor: '#74c69d',
          border: '2px solid #38363a',
        }}
        ref={ref}
        {...props}
      />
    );
  }
);

RadioGroupItem.displayName = 'RadioGroupItem';
