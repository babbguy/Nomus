import Badge from '../ui/Badge';

type FrameworkConfig = { label: string; variant: 'default' | 'info' | 'warning' | 'danger' | 'accent' | 'success' };

const frameworkPatterns: [RegExp, FrameworkConfig][] = [
  [/hipaa|164\.\d+/i, { label: 'HIPAA', variant: 'danger' }],
  [/eu.ai.act|annex.iii/i, { label: 'EU AI Act', variant: 'warning' }],
  [/gdpr|art\.?\s*\d+/i, { label: 'GDPR', variant: 'info' }],
  [/pci.dss/i, { label: 'PCI DSS', variant: 'accent' }],
  [/nis2/i, { label: 'NIS2', variant: 'info' }],
  [/dora/i, { label: 'DORA', variant: 'info' }],
  [/ccpa|cpra/i, { label: 'CCPA/CPRA', variant: 'warning' }],
  [/ferpa/i, { label: 'FERPA', variant: 'warning' }],
  [/glba/i, { label: 'GLBA', variant: 'accent' }],
  [/soc.2/i, { label: 'SOC 2', variant: 'default' }],
  [/iso.27001/i, { label: 'ISO 27001', variant: 'default' }],
  [/nist.csf/i, { label: 'NIST CSF', variant: 'info' }],
  [/nist.ai/i, { label: 'NIST AI RMF', variant: 'info' }],
  [/trism/i, { label: 'TRiSM', variant: 'default' }],
  [/fda|21.cfr/i, { label: 'FDA', variant: 'danger' }],
];

function detectFramework(ruleKey: string, legalReference: string | null): FrameworkConfig | null {
  const text = `${ruleKey} ${legalReference ?? ''}`;
  for (const [pattern, config] of frameworkPatterns) {
    if (pattern.test(text)) return config;
  }
  return null;
}

export default function FrameworkBadge({ ruleKey, legalReference }: { ruleKey: string; legalReference: string | null }) {
  const fw = detectFramework(ruleKey, legalReference);
  if (!fw) return null;
  return <Badge variant={fw.variant}>{fw.label}</Badge>;
}

export function RiskTierBadge({ ruleKey }: { ruleKey: string }) {
  const match = ruleKey.match(/eu_ai_act\.annex_iii\.(\d+)/);
  if (!match) return null;
  const category = match[1];
  const tierMap: Record<string, string> = {
    '1': 'Biometric ID',
    '2': 'Critical Infra',
    '3': 'Education',
    '4': 'Employment',
    '5': 'Essential Services',
    '6': 'Law Enforcement',
    '7': 'Migration',
    '8': 'Justice',
  };
  const label = tierMap[category] ?? `Category ${category}`;
  return <Badge variant="warning">Annex III: {label}</Badge>;
}
