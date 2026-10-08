import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const variants: Record<Variant, string> = {
  primary: 'bg-accent hover:bg-accent-hover hover:shadow-lg hover:shadow-accent/20 active:scale-[0.98] text-accent-text font-semibold',
  secondary: 'bg-surface-raised hover:bg-surface-overlay hover:border-border-bright active:scale-[0.98] text-text-primary border border-border',
  ghost: 'hover:bg-surface-hover hover:text-text-primary active:scale-[0.98] text-text-secondary',
  danger: 'bg-danger/15 hover:bg-danger/25 hover:shadow-lg hover:shadow-danger/15 active:scale-[0.98] text-danger border border-danger/30',
};

const sizes: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
};

interface CommonProps {
  variant?: Variant;
  size?: Size;
}

type ButtonAsButton = CommonProps &
  React.ButtonHTMLAttributes<HTMLButtonElement> & { as?: 'button' };

type ButtonAsAnchor = CommonProps &
  React.AnchorHTMLAttributes<HTMLAnchorElement> & { as: 'a' };

type ButtonProps = ButtonAsButton | ButtonAsAnchor;

export default function Button(props: ButtonProps) {
  const { variant = 'primary', size = 'md' } = props;

  const classes = cn(
    'inline-flex items-center justify-center gap-2 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed',
    sizes[size],
    variants[variant],
    props.className,
  );

  if (props.as === 'a') {
    const { as: _as, variant: _variant, size: _size, className: _className, children, ...anchorProps } = props;
    return (
      <a className={classes} {...anchorProps}>
        {children}
      </a>
    );
  }

  const { as: _as, variant: _variant, size: _size, className: _className, children, ...buttonProps } = props;
  return (
    <button className={classes} {...buttonProps}>
      {children}
    </button>
  );
}
