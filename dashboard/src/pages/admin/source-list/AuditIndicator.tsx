import { useState } from 'react';
import { Shield, ShieldCheck, ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react';
import type { AuditResult } from '../../../api/sources';
import { formatRelative } from '../../../lib/formatters';

// ---------------------------------------------------------------------------
// Audit quality indicator rendered inside a source card
// ---------------------------------------------------------------------------
export default function AuditIndicator({ audit }: { audit: AuditResult | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!audit) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
        <Shield size={12} className="text-text-muted/50" />
        <span>Pending audit</span>
      </div>
    );
  }

  const verdictConfig = {
    pass: { icon: ShieldCheck, color: 'text-success', bg: 'bg-success/10', label: 'Verified' },
    warn: { icon: ShieldAlert, color: 'text-warning', bg: 'bg-warning/10', label: `${audit.issueCount} issue${audit.issueCount !== 1 ? 's' : ''}` },
    fail: { icon: ShieldAlert, color: 'text-danger', bg: 'bg-danger/10', label: 'Quality alert' },
  }[audit.overallVerdict];

  const Icon = verdictConfig.icon;
  const hasIssues = audit.issues.length > 0;

  return (
    <div className="mt-2.5 pt-2.5 border-t border-border/40">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full ${verdictConfig.bg}`}>
            <Icon size={12} className={verdictConfig.color} />
            <span className={`text-[11px] font-medium ${verdictConfig.color}`}>{verdictConfig.label}</span>
          </div>
          {audit.ruleCount > 0 && (
            <span className="text-[11px] text-text-muted">
              {audit.ruleCount} rule{audit.ruleCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-muted">{formatRelative(audit.auditedAt)}</span>
          {hasIssues && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-0.5 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary transition"
              title={expanded ? 'Hide issues' : 'Show issues'}
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
        </div>
      </div>

      {/* Expandable issues list */}
      {expanded && hasIssues && (
        <div className="mt-2 space-y-1">
          {audit.issues.map((issue, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px]">
              <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${
                issue.severity === 'error' ? 'bg-danger' : issue.severity === 'warning' ? 'bg-warning' : 'bg-info'
              }`} />
              <span className="text-text-secondary">{issue.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
