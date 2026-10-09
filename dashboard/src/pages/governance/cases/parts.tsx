import { Fragment } from 'react';
import { ExternalLink } from 'lucide-react';
import Badge from '../../../components/ui/Badge';
import type { CaseLane, CaseState } from '../../../api/cpg';
import { CASE_STATE_LABEL, CASE_STATE_VARIANT, LANE_STATE_LABEL, LANE_STATE_VARIANT, breakablePath, closeReasonLabel, pullRequestUrl } from '../../../lib/cpg-cases';

/** Building blocks shared by the case list and the case detail. */

export function CaseStateBadge({ state, closeReason }: { state: CaseState; closeReason: string | null }) {
  return (
    <>
      <Badge variant={CASE_STATE_VARIANT[state]} className="whitespace-nowrap">{CASE_STATE_LABEL[state]}</Badge>
      {state === 'closed' && <p className="text-xs text-text-muted mt-1">{closeReasonLabel(closeReason)}</p>}
    </>
  );
}

export function RepoBranch({ repo, branch }: { repo: string; branch: string }) {
  return (
    <span className="font-mono text-xs" title={`${repo} @ ${branch}`}>
      <span className="block text-text-primary"><Path value={repo} /></span>
      <span className="block text-text-secondary"><span className="text-text-muted">@ </span><Path value={branch} /></span>
    </span>
  );
}

/** A path that wraps only after `/` and `.` (each part is unbreakable, hyphens included). */
export function Path({ value }: { value: string }) {
  return <>{breakablePath(value).map((part, i) => <Fragment key={i}>{i > 0 && <wbr />}<span className="whitespace-nowrap">{part}</span></Fragment>)}</>;
}

export function PullRequest({ repo, prNumber, closed = false }: { repo: string; prNumber: number | null; closed?: boolean }) {
  if (prNumber === null) return <span className="text-text-muted">{closed ? 'None' : 'None yet'}</span>;
  const url = pullRequestUrl(repo, prNumber);
  return url
    ? <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">#{prNumber} <ExternalLink size={12} /></a>
    : <span className="text-text-secondary">#{prNumber}</span>;
}

/**
 * One line per lane (owning board): its state and how many of its blocking
 * findings are decided. A closed case's lanes have no live state.
 */
export function LaneList({ lanes, compact = false, closed = false }: { lanes: CaseLane[]; compact?: boolean; closed?: boolean }) {
  if (lanes.length === 0) return <span className="text-xs text-text-muted">No board owns a finding</span>;
  return (
    <ul className={compact ? 'space-y-1' : 'space-y-2'}>
      {lanes.map((l) => (
        <li key={l.boardId} className={`flex items-center gap-2 text-xs ${compact ? 'whitespace-nowrap' : 'flex-wrap'}`}>
          <span className="text-text-primary">{l.boardName || l.boardId}</span>
          {!closed && <Badge variant={LANE_STATE_VARIANT[l.state]} className="whitespace-nowrap">{LANE_STATE_LABEL[l.state]}</Badge>}
          <span className="text-text-muted whitespace-nowrap" title={`${l.decided} of ${l.blocking} blocking findings decided`}>
            {compact ? `${l.decided}/${l.blocking} decided` : `${l.decided} of ${l.blocking} blocking decided`}
          </span>
        </li>
      ))}
    </ul>
  );
}
