import Badge from '../ui/Badge';

const statusMap = {
  compliant: { variant: 'success' as const, label: 'Obligations Clear' },
  non_compliant: { variant: 'danger' as const, label: 'Obligations Identified' },
  requires_review: { variant: 'warning' as const, label: 'Review Required' },
};

export default function ComplianceStatusBadge({ status }: { status: string }) {
  const { variant, label } = statusMap[status as keyof typeof statusMap] ?? { variant: 'default' as const, label: status };
  return <Badge variant={variant}>{label}</Badge>;
}
