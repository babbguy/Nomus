import Badge from '../ui/Badge';
import type { AttestationLifecycleStatus } from '../../api/verify';

const lifecycleMap: Record<AttestationLifecycleStatus, { variant: 'success' | 'warning' | 'danger'; label: string }> = {
  valid: { variant: 'success', label: 'Valid' },
  expired: { variant: 'warning', label: 'Expired' },
  revoked: { variant: 'danger', label: 'Revoked' },
  superseded: { variant: 'warning', label: 'Superseded' },
};

/**
 * Lifecycle status pill for attestation records (attestation reliance network).
 * `lifecycle === null` means the record carries no lifecycle data —
 * rendered as an explicit unknown dash, never as "Valid".
 */
export default function LifecycleBadge({
  lifecycle,
  reason,
}: {
  lifecycle: AttestationLifecycleStatus | null;
  reason?: string | null;
}) {
  if (lifecycle === null) {
    return (
      <span
        className="text-xs text-text-muted"
        title="Lifecycle status not reported by the attestations list endpoint for this record"
      >
        —
      </span>
    );
  }
  const { variant, label } = lifecycleMap[lifecycle];
  return (
    <span title={lifecycle === 'revoked' && reason ? `Revoked: ${reason}` : undefined}>
      <Badge variant={variant}>{label}</Badge>
    </span>
  );
}
