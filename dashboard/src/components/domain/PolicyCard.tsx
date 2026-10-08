import Card from '../ui/Card';
import Badge from '../ui/Badge';
import SeverityBadge from './SeverityBadge';
import EffectBadge from './EffectBadge';
import JurisdictionTag from './JurisdictionTag';

interface PolicyCardProps {
  ruleKey: string;
  jurisdiction: string;
  category: string;
  effect: string;
  severity: string;
  humanSummary: string;
  legalReference: string;
  version: number;
  industries?: string[];
}

const INDUSTRY_LABELS: Record<string, string> = {
  all: 'All', finance: 'Finance', healthcare: 'Healthcare',
  education: 'Education', employment: 'Employment', law_enforcement: 'Law Enforcement',
  critical_infrastructure: 'Infrastructure', defense: 'Defense',
  telecom: 'Telecom', insurance: 'Insurance', transportation: 'Transport',
  energy: 'Energy', government: 'Government', pharma: 'Pharma',
  manufacturing: 'Manufacturing', cybersecurity: 'Cyber',
};

export default function PolicyCard({
  ruleKey, jurisdiction, category, effect, severity, humanSummary, legalReference, version, industries,
}: PolicyCardProps) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-accent truncate">{ruleKey}</p>
          <p className="text-sm text-text-primary mt-1">{humanSummary}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <SeverityBadge severity={severity} />
          <EffectBadge effect={effect} />
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-text-muted flex-wrap">
        <JurisdictionTag code={jurisdiction} />
        <span className="capitalize">{category.replace(/_/g, ' ')}</span>
        <span>v{version}</span>
        <span className="truncate">{legalReference}</span>
        {industries && industries.length > 0 && !industries.includes('all') && (
          <div className="flex gap-1 ml-auto">
            {industries.slice(0, 3).map((ind) => (
              <Badge key={ind} variant="default" className="text-[10px]">
                {INDUSTRY_LABELS[ind] ?? ind}
              </Badge>
            ))}
            {industries.length > 3 && (
              <Badge variant="default" className="text-[10px]">+{industries.length - 3}</Badge>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
