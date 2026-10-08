import Badge from '../ui/Badge';

const effectMap = {
  deny: 'danger',
  require_disclosure: 'warning',
  allow_with_audit: 'info',
  flag: 'default',
} as const;

const effectLabels: Record<string, string> = {
  deny: 'Deny',
  require_disclosure: 'Require Disclosure',
  allow_with_audit: 'Audit Required',
  flag: 'Flag',
};

export default function EffectBadge({ effect }: { effect: string }) {
  const variant = effectMap[effect as keyof typeof effectMap] ?? 'default';
  return <Badge variant={variant}>{effectLabels[effect] ?? effect}</Badge>;
}
