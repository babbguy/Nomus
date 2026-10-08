import { Copy, Trash2 } from 'lucide-react';
import Badge from '../ui/Badge';
import { formatDate, formatRelative } from '../../lib/formatters';

interface ApiKeyRowProps {
  id: string;
  prefix: string;
  label: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
  /** Set when the key is past its expiry (it no longer authenticates). */
  expired?: boolean;
  onRevoke: (id: string) => void;
}

export default function ApiKeyRow({ id, prefix, label, scopes, lastUsedAt, createdAt, expired, onRevoke }: ApiKeyRowProps) {
  function copyPrefix() {
    navigator.clipboard.writeText(prefix + '...');
  }

  return (
    <div className="flex items-center justify-between py-3 px-4 rounded-lg hover:bg-surface-hover transition">
      <div className="flex items-center gap-4 min-w-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-text-primary">{label}</p>
            {expired && <Badge variant="warning">Expired</Badge>}
            <button onClick={copyPrefix} className="text-text-muted hover:text-accent transition" title="Copy prefix">
              <Copy size={12} />
            </button>
          </div>
          <p className="font-mono text-xs text-text-muted">{prefix}•••</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex gap-1">
          {scopes.map((s) => (
            <Badge key={s} variant="default">{s}</Badge>
          ))}
        </div>
        <span className="text-xs text-text-muted">
          Created {formatDate(createdAt)} · {lastUsedAt ? `used ${formatRelative(lastUsedAt)}` : 'never used'}
        </span>
        <button
          onClick={() => onRevoke(id)}
          className="p-1.5 rounded text-text-muted hover:text-danger hover:bg-danger/10 transition"
          title="Revoke key"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
