import ComplianceStatusBadge from './ComplianceStatusBadge';
import { formatRelative } from '../../lib/formatters';

interface AttestationRowProps {
  id: string;
  result: string;
  jurisdiction: string;
  actionContext: Record<string, string>;
  evaluatedAt: string;
}

export default function AttestationRow({ result, jurisdiction, actionContext, evaluatedAt }: AttestationRowProps) {
  return (
    <div className="flex items-center justify-between py-3 px-4 rounded-lg hover:bg-surface-hover transition">
      <div className="flex items-center gap-4 min-w-0">
        <ComplianceStatusBadge status={result} />
        <div className="min-w-0">
          <p className="text-sm text-text-primary truncate">
            {actionContext.action || 'evaluation'} — {jurisdiction}
          </p>
          <p className="text-xs text-text-muted">{formatRelative(evaluatedAt)}</p>
        </div>
      </div>
    </div>
  );
}
