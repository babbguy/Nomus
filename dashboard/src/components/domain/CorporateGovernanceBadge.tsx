import Badge from '../ui/Badge';
import type { Attestation } from '../../api/attestations';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The attestation's corporate-governance manifest, when it has one: the
 * exception count, with every signed record it lists on hover. Nothing when
 * the attestation has no manifest.
 */
export default function CorporateGovernanceBadge({ governance }: { governance: Attestation['corporateGovernance'] }) {
  if (!governance) return null;
  const { exceptions, caseClosures, ciRuns } = governance;
  return (
    <span title={`Signed corporate-governance manifest: ${plural(exceptions, 'exception')}, ${plural(caseClosures, 'case closure')}, ${plural(ciRuns, 'CI run')}`}>
      <Badge variant="info" className="whitespace-nowrap">Corporate governance: {plural(exceptions, 'exception')}</Badge>
    </span>
  );
}
