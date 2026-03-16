import { ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/utils/cn';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'outline' | 'ghost';
  size?: 'default' | 'sm' | 'lg' | 'icon';
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => {
    const getVariantStyles = () => {
      switch (variant) {
        case 'default':
          return { backgroundColor: '#74c69d', color: '#1E1D1F' };
        case 'outline':
          return { backgroundColor: 'transparent', border: '1px solid #74c69d', color: '#74c69d' };
        case 'ghost':
          return { backgroundColor: 'transparent', color: '#95d5b2' };
        default:
          return {};
      }
    };

    return (
      <button
        className={cn(
          'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-opacity-50 disabled:pointer-events-none disabled:opacity-50',
          {
            'h-10 px-4 py-2': size === 'default',
            'h-9 rounded-md px-3': size === 'sm',
            'h-11 rounded-md px-8': size === 'lg',
            'h-10 w-10': size === 'icon',
          },
          className
        )}
        style={getVariantStyles()}
        ref={ref}
        {...props}
      />
    );
  }
);

Button.displayName = 'Button';

export { Button };
