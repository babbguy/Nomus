import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileSignature, Gavel } from 'lucide-react';
import Card from '../../../components/ui/Card';
import Badge from '../../../components/ui/Badge';
import Button from '../../../components/ui/Button';
import Modal from '../../../components/ui/Modal';
import Spinner from '../../../components/ui/Spinner';
import ErrorState from '../../../components/ui/ErrorState';
import {
  getDecision, propose, type CaseDetail, type CaseFinding, type CpgMe, type Decision, type FindingResolution, type Proposal, type QuorumConfig,
} from '../../../api/cpg';
import { formatUtc, policyErrorMessage } from '../../../lib/cpg-policy';
import {
  OPEN_FOR_PROPOSAL, bulkGroups, decideBlocked, isoInDays, ownsFinding, parseDays, progressText, quorumProgress, scopeRule,
} from '../../../lib/cpg-approvals';
import { Blocked, ExpiryField, ProposalCard, RationaleField, RevokeModal } from '../decisions/parts';

/** What the decision views of one case share: the case, its proposals, the quorum in force and the caller. */
export interface DecisionContext {
  detail: CaseDetail;
  me: CpgMe | null;
  /** Null while loading or when the caller cannot read the quorum (policy.read). */
  quorum: QuorumConfig | null;
  proposals: Proposal[];
  /** Why nothing can be changed (closed, governance off); null when writable. */
  readOnly: string | null;
  boardName: (id: string) => string;
  onChanged: (text: string) => void;
}

const location = (f: Pick<CaseFinding, 'filePath' | 'startLine' | 'endLine'>) => `${f.filePath}:${f.startLine === f.endLine ? f.startLine : `${f.startLine}-${f.endLine}`}`;
const pendingFor = (proposals: Proposal[], fingerprint: string) => proposals.find((p) => p.status === 'pending' && p.fingerprints.includes(fingerprint));

/** Fingerprints the caller may put into a new proposal: open, not pending, on a board they belong to. */
function proposable(ctx: DecisionContext, findings: CaseFinding[]): Set<string> {
  const status = new Map(ctx.detail.case.resolutions.map((r) => [r.fingerprint, r.status]));
  return new Set(findings.filter((f) => f.blocking && OPEN_FOR_PROPOSAL.has(status.get(f.fingerprint) ?? '')
    && !pendingFor(ctx.proposals, f.fingerprint) && ownsFinding(ctx.me, f)).map((f) => f.fingerprint));
}

/** The decision state of one blocking finding of the latest revision, and what the caller may do about it. */
export function FindingDecision({ ctx, finding: f, resolution: r }: { ctx: DecisionContext; finding: CaseFinding; resolution: FindingResolution }) {
  const [proposing, setProposing] = useState<'approve' | 'reject' | null>(null);
  const pending = pendingFor(ctx.proposals, f.fingerprint);
  const blocked = ctx.readOnly ?? decideBlocked(ctx.detail, ctx.me)
    ?? (ownsFinding(ctx.me, f) ? null : 'Only members of a board that owns this policy can propose a decision on it.');
  return (
    <div className="border-t border-border pt-3 space-y-2" data-testid="finding-decision">
      <p className="text-xs text-text-muted flex items-center gap-1"><Gavel size={12} /> Decision</p>
      {r.decisionId && <SignedDecision ctx={ctx} decisionId={r.decisionId} />}
      {r.exceptionDecisionId && (
        <p className="text-xs text-text-secondary">
          Covered by a <Link to="/governance/exceptions" className="text-accent hover:underline">standing exception</Link> until {formatUtc(r.expiresAt)}.
        </p>
      )}
      {r.status === 'expired' && <p className="text-xs text-warning">Its approval expired; it needs a new decision.</p>}
      {pending && (
        <p className="text-xs text-text-secondary">
          {pending.outcome === 'approve' ? 'An approval' : 'A rejection'} is pending: {progressText(quorumProgress(pending), ctx.boardName)}.{' '}
          <a href={`#proposal-${pending.id}`} className="text-accent hover:underline">Vote below</a>
        </p>
      )}
      {!r.decisionId && !r.exceptionDecisionId && !pending && r.status !== 'expired' && <p className="text-xs text-text-secondary">No decision yet.</p>}
      {!pending && OPEN_FOR_PROPOSAL.has(r.status) && (blocked ? <Blocked text={blocked} /> : (
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="secondary" onClick={() => setProposing('approve')}>Propose approval</Button>
          <Button size="sm" variant="ghost" onClick={() => setProposing('reject')}>Propose rejection</Button>
        </div>
      ))}
      {proposing && <ProposeModal ctx={ctx} scope="snippet" outcome={proposing} candidates={[f]} onClose={() => setProposing(null)} />}
    </div>
  );
}

/** The signed decision that settles a finding, verified by the server now, with revocation for those allowed. */
function SignedDecision({ ctx, decisionId }: { ctx: DecisionContext; decisionId: string }) {
  const [state, setState] = useState<{ decision: Decision } | { error: string } | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getDecision(decisionId)
      .then((decision) => { if (!cancelled) setState({ decision }); })
      .catch((err) => { if (!cancelled) setState({ error: policyErrorMessage(err, 'Loading the decision failed') }); });
    return () => { cancelled = true; };
  }, [decisionId, retry]);
  if (!state) return <Spinner className="w-4 h-4" />;
  if ('error' in state) return <ErrorState compact message={state.error} onRetry={() => { setState(null); setRetry((n) => n + 1); }} />;
  const d = state.decision;
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap text-xs" data-testid="signed-decision">
      <div className="space-y-0.5">
        <p className="text-text-primary">
          {d.outcome === 'approve' ? 'Approved' : 'Rejected'} by a {d.scope} decision · {formatUtc(d.finalizedAt)} · quorum configuration v{d.quorumConfigVersion}
        </p>
        <p className="text-text-secondary">{d.outcome === 'approve' ? `Expires ${formatUtc(d.expiresAt)}` : 'A rejection never expires; only a later approval lifts it.'}</p>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={d.signatureValid ? 'success' : 'danger'} className="whitespace-nowrap">
          <FileSignature size={12} className="mr-1" />{d.signatureValid ? 'Signature verified' : 'Signature does not verify'}
        </Badge>
        {ctx.detail.viewer.revoke && !ctx.readOnly && <Button size="sm" variant="ghost" onClick={() => setRevoking(true)}>Revoke</Button>}
      </div>
      {revoking && <RevokeModal decisionId={d.id} what="decision" onClose={() => setRevoking(false)} onDone={(text) => { setRevoking(false); ctx.onChanged(text); }} />}
    </div>
  );
}

/** Every proposal of the case, newest first, with voting on pending ones and bulk proposals. */
export function DecisionsCard({ ctx, findings, error, onRetry }: { ctx: DecisionContext | null; findings: CaseFinding[] | null; error: string | null; onRetry: () => void }) {
  const [bulk, setBulk] = useState(false);
  const byFingerprint = new Map((findings ?? []).map((f) => [f.fingerprint, f]));
  const groups = ctx && findings && !ctx.readOnly && !decideBlocked(ctx.detail, ctx.me) ? bulkGroups(findings, proposable(ctx, findings)) : [];
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2"><Gavel size={16} className="text-accent" /> Decisions</h2>
        {groups.length > 0 && <Button size="sm" variant="secondary" onClick={() => setBulk(true)}>Propose a bulk decision</Button>}
      </div>
      <p className="text-xs text-text-muted mb-3">
        Proposals and votes on this case&apos;s findings, newest first. Each decided finding gets its own signed decision. Bulk decisions cover two or more
        findings of one review-required policy version; prohibited findings are always decided one at a time.
      </p>
      {error ? <ErrorState compact message={error} onRetry={onRetry} />
        : !ctx ? <div className="flex justify-center py-6"><Spinner /></div>
          : ctx.proposals.length === 0 ? <p className="text-sm text-text-muted">No decision has been proposed yet.</p>
            : (
              <ul className="space-y-3" data-testid="case-proposals">
                {[...ctx.proposals].reverse().map((p) => (
                  <ProposalCard key={p.id} proposal={p} boardName={ctx.boardName} onChanged={ctx.onChanged} voteHidden={ctx.readOnly}
                    subject={p.scope === 'standing'
                      ? <p className="text-xs text-text-secondary">Covers future findings matching <span className="font-mono">{p.pattern?.paths.join(', ')}</span>. <Link to="/governance/exceptions" className="text-accent hover:underline">See standing exceptions</Link></p>
                      : (
                        <ul className="text-xs font-mono text-text-secondary space-y-0.5">
                          {p.fingerprints.map((fp) => <li key={fp} className="break-all">{byFingerprint.get(fp) ? location(byFingerprint.get(fp)!) : fp}</li>)}
                        </ul>
                      )} />
                ))}
              </ul>
            )}
      {bulk && ctx && findings && <ProposeModal ctx={ctx} scope="bulk" outcome="approve" candidates={groups.flatMap((g) => g.findings)} onClose={() => setBulk(false)} />}
    </Card>
  );
}

/** Propose a snippet decision on one finding, or a bulk decision over findings of one policy version. */
function ProposeModal({ ctx, scope, outcome: initialOutcome, candidates, onClose }: {
  ctx: DecisionContext; scope: 'snippet' | 'bulk'; outcome: 'approve' | 'reject'; candidates: CaseFinding[]; onClose: () => void;
}) {
  const [now] = useState(() => Date.now());
  const [outcome, setOutcome] = useState(initialOutcome);
  const [picked, setPicked] = useState<string[]>(scope === 'snippet' ? [candidates[0].fingerprint] : []);
  const [rationale, setRationale] = useState('');
  const first = candidates.find((f) => f.fingerprint === picked[0]) ?? candidates[0];
  const rule = ctx.quorum ? scopeRule(ctx.quorum, first.policyId, first.tier, scope) : null;
  const [days, setDays] = useState(rule ? String(rule.defaultDays) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A bulk proposal is homogeneous: once one finding is picked, only its policy version can join.
  const version = (f: CaseFinding) => `${f.policyKey} v${f.policyVersion}`;
  const selectable = picked.length === 0 ? candidates : candidates.filter((f) => version(f) === version(first));
  const expiryDays = rule ? parseDays(days, rule.maxDays) : null;
  const problem = scope === 'bulk' && picked.length < 2 ? 'Pick at least two findings of the same policy version.'
    : outcome === 'approve' && !ctx.quorum ? 'Proposing an approval needs the quorum configuration, which your role cannot read (policy.read).'
      : outcome === 'approve' && !rule ? 'The quorum configuration does not allow this kind of approval for this policy.'
        : outcome === 'approve' && expiryDays === null ? 'Choose a valid expiry.'
          : rationale.trim().length < 20 ? 'Write a rationale of at least 20 characters.' : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await propose({
        caseId: ctx.detail.case.id, scope, outcome, fingerprints: picked, rationale: rationale.trim(),
        ...(outcome === 'approve' ? { expiresAt: isoInDays(expiryDays!, now) } : {}),
      });
      onClose();
      ctx.onChanged(p.status === 'finalized' ? `Decided at once: ${p.decisionIds.length} signed decision${p.decisionIds.length === 1 ? '' : 's'} recorded.`
        : `Proposed. Your vote is counted: ${progressText(quorumProgress(p), ctx.boardName)}.`);
    } catch (err) {
      setError(policyErrorMessage(err, 'Proposing failed'));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={scope === 'bulk' ? 'Propose a bulk decision' : `Propose ${outcome === 'approve' ? 'approval' : 'rejection'}`} width="max-w-2xl">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-xs text-text-secondary">
          Your own vote is recorded with the proposal. {outcome === 'reject' ? 'A rejection is final at once and never expires.' : rule ? `This approval needs ${rule.approvals} approval${rule.approvals === 1 ? '' : 's'} in all.` : ''}
        </p>
        {scope === 'bulk' && (
          <fieldset className="flex gap-4 text-sm text-text-primary">
            <legend className="text-xs text-text-muted mb-1">Outcome</legend>
            {(['approve', 'reject'] as const).map((o) => (
              <label key={o} className="flex items-center gap-2"><input type="radio" name="bulk-outcome" checked={outcome === o} onChange={() => setOutcome(o)} />{o === 'approve' ? 'Approve' : 'Reject'}</label>
            ))}
          </fieldset>
        )}
        <fieldset>
          <legend className="text-xs text-text-muted mb-1">{scope === 'bulk' ? 'Findings (one policy version)' : 'Finding'}</legend>
          <ul className="space-y-1 max-h-48 overflow-y-auto">
            {candidates.map((f) => (
              <li key={f.fingerprint}>
                <label className={`flex items-start gap-2 text-xs ${selectable.includes(f) || picked.includes(f.fingerprint) ? 'text-text-primary' : 'text-text-muted'}`}>
                  {scope === 'bulk' && (
                    <input type="checkbox" checked={picked.includes(f.fingerprint)} disabled={!selectable.includes(f) && !picked.includes(f.fingerprint)}
                      onChange={(e) => setPicked(e.target.checked ? [...picked, f.fingerprint] : picked.filter((x) => x !== f.fingerprint))} />
                  )}
                  <span><span className="font-mono break-all">{location(f)}</span> · {f.policyTitle} <span className="font-mono">({version(f)})</span></span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        {outcome === 'approve' && rule && <ExpiryField id="propose-expiry" days={days} setDays={setDays} maxDays={rule.maxDays} now={now} />}
        <RationaleField id="propose-rationale" value={rationale} setValue={setRationale} />
        {problem && <p className="text-xs text-text-muted" data-testid="propose-problem">{problem}</p>}
        {error && <p className="text-sm text-danger" role="alert" data-testid="propose-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={outcome === 'reject' ? 'danger' : 'primary'} disabled={busy || problem !== null}>{busy ? 'Proposing...' : 'Propose'}</Button>
        </div>
      </form>
    </Modal>
  );
}
