import Badge from '../ui/Badge';

const severityMap = {
  critical: 'danger',
  high: 'warning',
  medium: 'warning',
  low: 'info',
} as const;

export default function SeverityBadge({ severity }: { severity: string }) {
  const variant = severityMap[severity as keyof typeof severityMap] ?? 'default';
  return <Badge variant={variant}>{severity}</Badge>;
}
