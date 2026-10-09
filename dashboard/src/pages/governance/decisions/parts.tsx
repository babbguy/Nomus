import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import Badge from '../../../components/ui/Badge';
import Button from '../../../components/ui/Button';
import Modal from '../../../components/ui/Modal';
import { revokeDecision, voteOnProposal, type Proposal } from '../../../api/cpg';
import { formatUtc, policyErrorMessage } from '../../../lib/cpg-policy';
import { asSentence } from '../../../lib/cpg-cases';
import {
  PROPOSAL_STATUS_LABEL, PROPOSAL_STATUS_VARIANT, invalidationText, isoInDays, parseDays, progressText, quorumProgress, voteBlockedText,
} from '../../../lib/cpg-approvals';
import { TierBadge } from '../policies/parts';

/** Building blocks shared by the case decisions and the standing exceptions page. */

export const inputCls = 'w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary';

const SCOPE_LABEL = { snippet: 'Snippet', bulk: 'Bulk', standing: 'Standing exception' } as const;

/** A proposal: what it decides, its quorum progress, votes, revocations and, while pending, the vote form. */
export function ProposalCard({ proposal: p, subject, boardName, onChanged, voteHidden = null, status }: {
  proposal: Proposal;
  /** A badge in place of the proposal's own status (the exceptions page shows the exception's). */
  status?: React.ReactNode;
  /** What the proposal decides (findings or a pattern). */
  subject: React.ReactNode;
  boardName: (id: string) => string;
  onChanged: (text: string) => void;
  /** Why voting is not offered on this page at all (a closed case, governance off), instead of the server's reason. */
  voteHidden?: string | null;
}) {
  const progress = quorumProgress(p);
  return (
    <li id={`proposal-${p.id}`} className="border border-border rounded-lg p-4 space-y-3" data-testid="proposal">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm text-text-primary font-medium">
            {SCOPE_LABEL[p.scope]} {p.outcome === 'approve' ? 'approval' : 'rejection'} · <span className="font-mono text-xs">{p.policyKey} v{p.policyVersion}</span>
          </p>
          <p className="text-xs text-text-muted">Proposed by {p.proposer.name || p.proposer.userId} · {formatUtc(p.createdAt)}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <TierBadge tier={p.tier} />
          {status ?? <Badge variant={PROPOSAL_STATUS_VARIANT[p.status]} className="whitespace-nowrap">{PROPOSAL_STATUS_LABEL[p.status]}</Badge>}
        </div>
      </div>
      {subject}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <div><p className="text-text-muted">Expires</p><p className="text-text-primary">{p.outcome === 'reject' ? 'Never (rejections do not expire)' : formatUtc(p.requestedExpiresAt)}</p></div>
        {p.outcome === 'approve' && (
          <div className="md:col-span-2">
            <p className="text-text-muted">Quorum (configuration v{p.quorumConfigVersionAtCreation})</p>
            <p className="text-text-primary" data-testid="proposal-progress">{progressText(progress, boardName)}</p>
          </div>
        )}
        <div className="md:col-span-3"><p className="text-text-muted">Rationale</p><p className="text-text-primary whitespace-pre-wrap">{p.rationale}</p></div>
      </div>
      {p.votes.length > 0 && (
        <ul className="space-y-1 text-xs" data-testid="proposal-votes">
          {p.votes.map((v) => (
            <li key={v.id} className="flex items-start gap-2">
              <Badge variant={v.vote === 'approve' ? 'success' : 'danger'}>{v.vote === 'approve' ? 'Approved' : 'Rejected'}</Badge>
              <span className="text-text-secondary">
                {v.voterName || v.voterUserId}
                {v.boards.length > 0 ? ` (${v.boards.map(boardName).join(', ')})` : ''} · {formatUtc(v.createdAt)}{v.comment ? `: "${v.comment}"` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {p.status === 'vetoed' && <p className="text-xs text-text-secondary">One eligible rejection vetoed it; no decision was recorded.</p>}
      {p.status === 'lapsed' && <p className="text-xs text-text-secondary">It lapsed on {formatUtc(p.lapsesAt)} without reaching its quorum.</p>}
      {p.invalidation && <p className="text-xs text-warning">Invalidated {formatUtc(p.invalidation.at)}: {invalidationText(p.invalidation.reason)}. Propose it again.</p>}
      {p.revocations.length > 0 && (
        <ul className="space-y-1 text-xs" data-testid="proposal-revocations">
          {p.revocations.map((r) => (
            <li key={r.decisionId} className="flex items-start gap-2">
              <Badge variant="danger">Revoked</Badge>
              <span className="text-text-secondary">{r.revokedByName || 'Unknown user'} · {formatUtc(r.revokedAt)}: &quot;{r.reason}&quot;</span>
            </li>
          ))}
        </ul>
      )}
      {p.status === 'pending' && (voteHidden ? <Blocked text={voteHidden} /> : <VoteForm proposal={p} onChanged={onChanged} />)}
    </li>
  );
}

function VoteForm({ proposal: p, onChanged }: { proposal: Proposal; onChanged: (text: string) => void }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!p.viewer.canVote) return <Blocked text={voteBlockedText(p.viewer.reason)} />;

  async function vote(choice: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      const r = await voteOnProposal(p.id, choice, comment);
      onChanged(r.proposalStatus === 'finalized' ? `Decided: ${r.decisionIds.length} signed decision${r.decisionIds.length === 1 ? '' : 's'} recorded.`
        : r.proposalStatus === 'vetoed' ? 'Your rejection vetoed the proposal; no decision was recorded.'
          : r.proposalStatus === 'invalidated' ? 'The proposal no longer meets the quorum configuration and was invalidated. Propose it again.'
            : 'Your vote is recorded; more approvals are needed.');
    } catch (err) {
      setError(asSentence(policyErrorMessage(err, 'The vote failed')));
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border pt-3 space-y-2" data-testid="vote-form">
      <label htmlFor={`vote-${p.id}`} className="block text-xs text-text-muted">Comment (optional, recorded with your vote)</label>
      <textarea id={`vote-${p.id}`} rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} className={inputCls} />
      <div className="flex gap-2 justify-end">
        <Button variant="danger" size="sm" disabled={busy} onClick={() => void vote('reject')}>Reject</Button>
        <Button size="sm" disabled={busy} onClick={() => void vote('approve')}>{busy ? 'Saving...' : 'Approve'}</Button>
      </div>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

export function Blocked({ text }: { text: string }) {
  return <p className="text-xs text-text-secondary flex items-start gap-2" data-testid="decide-blocked"><ShieldAlert size={14} className="text-warning shrink-0" /> {text}</p>;
}

/** Days until expiry, bounded by the configured maximum, with the resulting UTC instant. */
export function ExpiryField({ id, days, setDays, maxDays, now }: { id: string; days: string; setDays: (v: string) => void; maxDays: number; now: number }) {
  const parsed = parseDays(days, maxDays);
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-text-muted mb-1">Expires after (days, at most {maxDays}) *</label>
      <input id={id} type="number" min={1} max={maxDays} value={days} onChange={(e) => setDays(e.target.value)} className={`${inputCls} max-w-[8rem]`} />
      <p className={`text-xs mt-1 ${parsed === null ? 'text-danger' : 'text-text-muted'}`}>
        {parsed === null ? `Enter a whole number from 1 to ${maxDays}.` : `Expires ${formatUtc(isoInDays(parsed, now))}.`}
      </p>
    </div>
  );
}

export function RationaleField({ id, value, setValue }: { id: string; value: string; setValue: (v: string) => void }) {
  const short = value.trim().length < 20;
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-text-muted mb-1">Rationale (at least 20 characters) *</label>
      <textarea id={id} rows={3} maxLength={4000} value={value} onChange={(e) => setValue(e.target.value)} className={inputCls} />
      {short && value.length > 0 && <p className="text-xs text-text-muted mt-1">{20 - value.trim().length} more characters needed.</p>}
    </div>
  );
}

/** Revoke a decision or standing exception: immediate, final and signed. */
export function RevokeModal({ decisionId, what, onClose, onDone }: { decisionId: string; what: string; onClose: () => void; onDone: (text: string) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await revokeDecision(decisionId, reason.trim());
      onDone(`Revoked. The ${what} no longer applies; the findings it settled need review again.`);
    } catch (err) {
      setError(policyErrorMessage(err, 'Revoking failed'));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Revoke this ${what}`}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <p className="text-xs text-text-secondary">Revocation takes effect at once, is signed and cannot be undone. To restore it, propose it again.</p>
        <label htmlFor="revoke-reason" className="block text-xs text-text-muted">Reason (at least 10 characters) *</label>
        <textarea id="revoke-reason" rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" disabled={busy || reason.trim().length < 10}>{busy ? 'Revoking...' : 'Revoke'}</Button>
        </div>
      </form>
    </Modal>
  );
}
