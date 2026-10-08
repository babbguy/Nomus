import { cn } from '../../lib/cn';

type Variant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const variants: Record<Variant, string> = {
  default: 'bg-surface-hover text-text-secondary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  info: 'bg-info/15 text-info',
  accent: 'bg-accent-dim text-accent',
};

export default function Badge({
  children,
  variant = 'default',
  className,
}: {
  children: React.ReactNode;
  variant?: Variant;
  className?: string;
}) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full',
      variants[variant],
      className,
    )}>
      {children}
    </span>
  );
}
