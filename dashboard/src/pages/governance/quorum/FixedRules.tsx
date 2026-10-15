import { Lock } from 'lucide-react';
import Card from '../../../components/ui/Card';

/** The rules of the brief that no quorum setting can change (shown on the view and the editor). */
export default function FixedRules() {
  return (
    <Card className="border-info/30">
      <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-2"><Lock size={14} className="text-info" /> Fixed rules (no setting can change them)</h2>
      <ul className="list-disc pl-5 text-xs text-text-secondary space-y-0.5" data-testid="quorum-fixed-rules">
        <li>Nobody can approve their own proposal: not the author of a policy version, not the person who compiled it, not the developer who opened a case.</li>
        <li>Bulk decisions are never allowed on the Prohibited tier, not even through a per-policy override.</li>
        <li>Advisory findings never block CI and need no review.</li>
      </ul>
    </Card>
  );
}
