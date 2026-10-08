import { cn } from '../../lib/cn';

export default function Card({
  children,
  className,
  glow,
}: {
  children: React.ReactNode;
  className?: string;
  glow?: boolean;
}) {
  return (
    <div className={cn('glass rounded-xl p-5', glow && 'glow-accent', className)}>
      {children}
    </div>
  );
}
