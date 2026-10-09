import type { LucideIcon } from 'lucide-react';

/** Page header used by every governance page (matches Team and Profile). */
export default function GovernanceHeader({ icon: Icon, title, subtitle, actions }: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-accent-dim">
          <Icon size={20} className="text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">{title}</h1>
          <p className="text-sm text-text-secondary">{subtitle}</p>
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
