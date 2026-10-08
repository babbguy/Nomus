import Badge from '../ui/Badge';

const detectorLabels: Record<string, { label: string; variant: 'default' | 'info' | 'warning' | 'danger' | 'accent' | 'success' }> = {
  'import-detector': { label: 'Import', variant: 'default' },
  'sdk-usage-detector': { label: 'SDK Usage', variant: 'info' },
  'phi-pattern-detector': { label: 'PHI/PII', variant: 'danger' },
  'risk-classifier': { label: 'Risk Classification', variant: 'warning' },
  'data-flow-detector': { label: 'Data Flow', variant: 'accent' },
};

export default function DetectorBadge({ source }: { source: string | null }) {
  if (!source) return null;
  const config = detectorLabels[source] ?? { label: source, variant: 'default' as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
