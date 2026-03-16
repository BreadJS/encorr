import { forwardRef } from 'react';
import { cn } from '@/utils/cn';
import { Check } from 'lucide-react';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  checked?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked, onChange, ...props }, ref) => {
    return (
      <div className="relative">
        <input
          type="checkbox"
          className={cn(
            'peer h-4 w-4 shrink-0 rounded border transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 appearance-none cursor-pointer',
            className
          )}
          style={{
            backgroundColor: checked ? '#74c69d' : '#1E1D1F',
            border: '1px solid #38363a',
          }}
          ref={ref}
          checked={checked}
          onChange={onChange}
          {...props}
        />
        {checked && (
          <Check
            className="absolute left-0 top-0 h-4 w-4 text-black pointer-events-none"
            style={{ strokeWidth: 3 }}
          />
        )}
      </div>
    );
  }
);

Checkbox.displayName = 'Checkbox';

export { Checkbox };
