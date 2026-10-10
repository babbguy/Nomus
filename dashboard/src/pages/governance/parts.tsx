import { Info, type LucideIcon } from 'lucide-react';
import Card from '../../components/ui/Card';
import { cn } from '../../lib/cn';

/** The outcome of a page action, shown above its content. */
export type Notice = { type: 'ok' | 'err'; text: string } | null;

export function NoticeLine({ notice, className, testId }: { notice: Notice; className: string; testId?: string }) {
  if (!notice) return null;
  return (
    <p className={`${className} ${notice.type === 'ok' ? 'text-success' : 'text-danger'}`} role={notice.type === 'err' ? 'alert' : 'status'} data-testid={testId}>
      {notice.text}
    </p>
  );
}

/** An informational card above a page's content. */
export function InfoNote({ children, icon: Icon = Info, role }: { children: React.ReactNode; icon?: LucideIcon; role?: 'status' }) {
  return (
    <Card className="mb-4 border-info/30">
      <p className="text-sm text-text-secondary flex items-start gap-2" role={role}>
        <Icon size={16} className="text-info shrink-0 mt-0.5" />
        {children}
      </p>
    </Card>
  );
}

/** A row of filter buttons (tabs); the empty value means "All". */
export function FilterTabs<T extends string>({ label, options, value, onChange, className }: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex gap-1 flex-wrap', className)} role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value || 'all'}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 text-xs rounded-lg transition ${value === o.value ? 'bg-accent-dim text-accent' : 'text-text-secondary hover:bg-surface-hover'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

type Column = string | false | { label: React.ReactNode; className?: string; title?: string; ariaLabel?: string };

/** A table's header row; `dense` is the tighter variant used for tables inside a card. Falsy columns are left out. */
export function TableHead({ columns, dense = false }: { columns: Column[]; dense?: boolean }) {
  return (
    <thead>
      <tr className={`${dense ? 'border-y' : 'border-b'} border-border text-left text-text-muted`}>
        {columns.map((c, i) => {
          if (c === false) return null;
          const col = typeof c === 'string' ? { label: c } : c;
          return (
            <th key={i} className={cn(dense ? 'px-4 py-2' : 'px-4 py-3', 'font-medium', col.className)} title={col.title} aria-label={col.ariaLabel}>
              {col.label}
            </th>
          );
        })}
      </tr>
    </thead>
  );
}
