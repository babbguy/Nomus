import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, FileSignature, FolderGit2, GitCommitHorizontal, Lock, Route, Users } from 'lucide-react';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { endCase, getCase, getCaseRevision, type CaseDetail as CaseDetailData, type CpgMe, type RevisionDetail } from '../../api/cpg';
import { useCpgMe } from '../../hooks/useCpgMe';
import { cpgErrorCode } from '../../lib/cpg-errors';
import { formatUtc, policyErrorMessage } from '../../lib/cpg-policy';
import { SOURCE_LABEL, actorLabel, caseActions, closeReasonLabel, type CaseActions } from '../../lib/cpg-cases';
import GovernanceHeader from './GovernanceHeader';
import { Field, Mono } from './policies/parts';
import { CaseStateBadge, LaneList, PullRequest, RepoBranch } from './cases/parts';
import { FindingList } from './cases/Findings';
import { Blocked, Discussion, RequestChangesForm } from './cases/Discussion';

/**
 * /governance/cases/:id (E43, E44, E51, E52, E46, E47, E49, E50): one review
 * case with its lanes, revisions, findings (snippet, justification, reviewer
 * context), change requests and comments. Decisions arrive in Phase 5.
 */
export default function CaseDetail() {
  const { id = '' } = useParams();
  const { me } = useCpgMe();
  const [detail, setDetail] = useState<CaseDetailData | null>(null);
  const [error, setError] = useState<{ text: string; notFound: boolean } | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCase(id)
      .then((d) => { if (!cancelled) { setDetail(d); setError(null); setFetchedAt(new Date().toISOString()); } })
      .catch((err) => { if (!cancelled) setError({ text: policyErrorMessage(err, 'Failed to load the case'), notFound: cpgErrorCode(err) === 'not_found' }); });
    return () => { cancelled = true; };
  }, [id, reloadKey]);

  return (
    <div>
      <Link to="/governance/cases" className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-accent mb-3">
        <ArrowLeft size={12} /> All cases
      </Link>
      {error ? (
        error.notFound
          ? <EmptyState title="Case not found" description="It does not exist in your organization, or it is in a repository you cannot read." />
          : <ErrorState message={error.text} onRetry={() => { setError(null); setReloadKey((k) => k + 1); }} />
      ) : !detail ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <CaseView
          detail={detail}
          me={me}
          notice={notice}
          onChanged={(text) => { setNotice(text); setReloadKey((k) => k + 1); }}
          fetchedAt={fetchedAt}
        />
      )}
    </div>
  );
}

export function CaseView({ detail, me, notice, onChanged, fetchedAt }: {
  detail: CaseDetailData;
  me: CpgMe | null;
  notice: string | null;
  onChanged: (text: string) => void;
  fetchedAt: string | null;
}) {
  const c = detail.case;
  const actions = caseActions(detail, me);
  /** The revision picked in the table; null follows the latest. */
  const [picked, setPicked] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; data: RevisionDetail } | { key: string; error: string } | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [ending, setEnding] = useState(false);
  const revision = picked ?? c.latestRevision;
  const isLatest = revision === c.latestRevision;
  // A reload (fetchedAt) refetches the findings too.
  const key = JSON.stringify([c.id, revision, retryKey, fetchedAt]);
  const current = loaded?.key === key ? loaded : null;
  const findings = current && 'data' in current ? current.data : null;
  const findingsError = current && 'error' in current ? current.error : null;

  useEffect(() => {
    if (revision < 1) return;
    let cancelled = false;
    getCaseRevision(c.id, revision)
      .then((data) => { if (!cancelled) setLoaded({ key, data }); })
      .catch((err) => { if (!cancelled) setLoaded({ key, error: policyErrorMessage(err, 'Failed to load the findings') }); });
    return () => { cancelled = true; };
  }, [c.id, revision, key]);

  const closed = c.state === 'closed';
  const resolutions = isLatest && !closed ? new Map(c.resolutions.map((r) => [r.fingerprint, r])) : null;

  return (
    <div className="space-y-4">
      <GovernanceHeader
        icon={FolderGit2}
        title={c.ref}
        subtitle={`${c.repo} @ ${c.branch}`}
        actions={!actions.readOnly && actions.end ? (
          <Button size="sm" variant="danger" onClick={() => setEnding(true)}>{actions.end === 'withdraw' ? 'Withdraw case' : 'Close case'}</Button>
        ) : undefined}
      />
      {notice && <p className="text-sm text-success" role="status" data-testid="case-notice">{notice}</p>}
      {actions.readOnly && (
        <p className="text-sm text-text-secondary flex items-center gap-2" role="status" data-testid="case-read-only"><Lock size={14} className="text-text-muted" /> {actions.readOnly}</p>
      )}

      <Card>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <Field label="State"><CaseStateBadge state={c.state} closeReason={c.closeReason} /></Field>
          <Field label="Repository @ branch"><RepoBranch repo={c.repo} branch={c.branch} /></Field>
          <Field label="Pull request"><span className="text-sm"><PullRequest repo={c.repo} prNumber={c.prNumber} closed={closed} /></span></Field>
          <Field label="Last activity"><span className="text-xs">{formatUtc(c.updatedAt)}</span></Field>
        </div>
        <People detail={detail} />
      </Card>

      {detail.closure && <ClosureCard closure={detail.closure} />}

      <Card>
        <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-1"><Route size={16} className="text-accent" /> Lanes</h2>
        <p className="text-xs text-text-muted mb-3">
          {closed ? 'The boards that owned a finding of the last revision when the case closed.'
            : 'Each board that owns a finding of the latest revision reviews its own lane. Decisions arrive in a later release.'}
        </p>
        <LaneList lanes={c.lanes} closed={closed} />
        {!actions.readOnly && <RequestChanges detail={detail} actions={actions} isLatest={isLatest} findings={findings?.findings ?? null} onPosted={onChanged} />}
      </Card>

      <Card className="p-0 overflow-x-auto">
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2"><GitCommitHorizontal size={16} className="text-accent" /> Revisions</h2>
          <p className="text-xs text-text-muted">A revision is a snapshot of the branch&apos;s corporate findings; one is added only when they change.</p>
        </div>
        <table className="w-full text-sm" data-testid="case-revisions">
          <thead>
            <tr className="border-y border-border text-left text-text-muted">
              <th className="px-4 py-2 font-medium">Revision</th>
              <th className="px-4 py-2 font-medium">From</th>
              <th className="px-4 py-2 font-medium">New</th>
              <th className="px-4 py-2 font-medium">Carried</th>
              <th className="px-4 py-2 font-medium">Resolved</th>
              <th className="px-4 py-2 font-medium">Head commit</th>
              <th className="px-4 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {[...detail.revisions].reverse().map((r) => (
              <tr key={r.revision} className={r.revision === revision ? 'bg-accent-dim/40' : 'hover:bg-surface-hover'}>
                <td className="px-4 py-2">
                  <button type="button" className="text-text-primary font-medium hover:text-accent" aria-pressed={r.revision === revision} onClick={() => setPicked(r.revision === c.latestRevision ? null : r.revision)}>
                    {r.revision}{r.revision === c.latestRevision ? ' (latest)' : ''}
                  </button>
                </td>
                <td className="px-4 py-2 text-xs text-text-secondary">{SOURCE_LABEL[r.source]}</td>
                <td className="px-4 py-2 text-xs">{r.addedCount}</td>
                <td className="px-4 py-2 text-xs">{r.carriedCount}</td>
                <td className="px-4 py-2 text-xs">{r.resolvedCount}</td>
                <td className="px-4 py-2">{r.headSha ? <Mono>{r.headSha}</Mono> : <span className="text-xs text-text-muted">Not recorded</span>}</td>
                <td className="px-4 py-2 text-xs text-text-secondary whitespace-nowrap">{formatUtc(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-text-primary mb-1">Findings of revision {revision}</h2>
        <p className="text-xs text-text-muted mb-3">{closed ? (isLatest ? 'The findings when the case closed.' : 'An earlier revision of the closed case.')
          : isLatest ? 'The current findings of the branch.' : 'An earlier revision; review statuses are shown for the latest revision only.'}</p>
        {revision < 1 ? <p className="text-sm text-text-muted">No revision has been submitted yet.</p>
          : findingsError ? <ErrorState compact message={findingsError} onRetry={() => setRetryKey((k) => k + 1)} />
            : !findings ? <div className="flex justify-center py-6"><Spinner /></div>
              : <FindingList caseId={c.id} findings={findings.findings} resolutions={resolutions} />}
      </Card>

      <Discussion detail={detail} actions={actions} onPosted={onChanged} />
      <DataFreshness fetchedAt={fetchedAt} />

      {ending && actions.end && (
        <EndCaseModal caseId={c.id} how={actions.end} onClose={() => setEnding(false)} onDone={(text) => { setEnding(false); onChanged(text); }} />
      )}
    </div>
  );
}

/** Everyone involved: the opener, the justification authors and everyone who requested changes or commented. */
function People({ detail }: { detail: CaseDetailData }) {
  const roles = new Map<string, Set<string>>();
  const add = (name: string, role: string) => roles.set(name, (roles.get(name) ?? new Set()).add(role));
  add(actorLabel(detail.openedBy), 'opened the case');
  for (const j of detail.justifications) add(j.authorName || j.authorUserId, 'justified findings');
  for (const m of detail.comments) add(m.authorName || m.authorUserId, m.kind === 'change_request' ? 'requested changes' : m.kind === 'reply' ? 'replied' : 'commented');
  if (detail.closure) add(actorLabel(detail.closure.closedBy), detail.closure.reason === 'withdrawn' ? 'withdrew the case' : 'closed the case');
  return (
    <div className="mt-4 pt-3 border-t border-border">
      <p className="text-xs text-text-muted mb-1 flex items-center gap-1"><Users size={12} /> People involved</p>
      <ul className="text-xs text-text-secondary space-y-0.5" data-testid="case-people">
        {[...roles].map(([name, what]) => <li key={name}><span className="text-text-primary">{name}</span>: {[...what].join(', ')}</li>)}
      </ul>
      <p className="text-xs text-text-muted mt-2">Opened {formatUtc(detail.openedAt)}</p>
    </div>
  );
}

function RequestChanges({ detail, actions, isLatest, findings, onPosted }: {
  detail: CaseDetailData; actions: CaseActions; isLatest: boolean; findings: RevisionDetail['findings'] | null; onPosted: (t: string) => void;
}) {
  if (actions.reviewLanes.length === 0) return actions.reviewBlocked ? <div className="mt-3"><Blocked text={actions.reviewBlocked} /></div> : null;
  return (
    <div className="mt-4 pt-3 border-t border-border">
      <h3 className="text-xs font-semibold text-text-primary mb-2">Request changes</h3>
      {!isLatest ? <p className="text-xs text-text-muted">Show the latest revision to choose its findings.</p>
        : findings ? <RequestChangesForm detail={detail} actions={actions} findings={findings} onPosted={onPosted} />
          : <Spinner className="w-4 h-4" />}
    </div>
  );
}

function ClosureCard({ closure }: { closure: NonNullable<CaseDetailData['closure']> }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2"><FileSignature size={16} className="text-accent" /> Closure record</h2>
        <Badge variant={closure.signatureValid ? 'success' : 'danger'}>{closure.signatureValid ? 'Signature verified' : 'Signature does not verify'}</Badge>
      </div>
      <p className="text-xs text-text-muted mt-1">
        Signed with this Nomus instance&apos;s Ed25519 key when the case closed. The record is rebuilt from the stored case history, so it can be checked again at any time.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs mt-3">
        <div><p className="text-text-muted">Reason</p><p className="text-text-primary">{closeReasonLabel(closure.reason)}</p></div>
        <div><p className="text-text-muted">Closed by</p><p className="text-text-primary">{actorLabel(closure.closedBy)} · {formatUtc(closure.closedAt)}</p></div>
        {closure.note && <div><p className="text-text-muted">Note</p><p className="text-text-primary whitespace-pre-wrap">{closure.note}</p></div>}
      </div>
      <p className="text-xs text-text-muted mt-3 mb-1">Signature</p>
      <Mono>{closure.signature}</Mono>
      <details className="mt-3">
        <summary className="text-xs text-text-secondary cursor-pointer hover:text-accent">Show the signed record (JSON)</summary>
        <pre className="mt-2 text-xs font-mono bg-surface border border-border rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(closure.record, null, 2)}</pre>
      </details>
    </Card>
  );
}

function EndCaseModal({ caseId, how, onClose, onDone }: { caseId: string; how: 'withdraw' | 'close'; onClose: () => void; onDone: (text: string) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verb = how === 'withdraw' ? 'Withdraw' : 'Close';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await endCase(caseId, how, reason.trim());
      onDone(how === 'withdraw' ? 'Case withdrawn. Its closure record is signed below.' : 'Case closed. Its closure record is signed below.');
    } catch (err) {
      setError(policyErrorMessage(err, `${verb === 'Withdraw' ? 'Withdrawing' : 'Closing'} the case failed`));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`${verb} this case`}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <p className="text-xs text-text-secondary">
          A closed case can no longer change, and its closure record is signed. New findings on the branch open a new case. Decisions already made stay valid.
        </p>
        <label htmlFor="end-reason" className="block text-xs text-text-muted">Reason *</label>
        <textarea id="end-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)}
          className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" />
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>{busy ? 'Saving...' : `${verb} case`}</Button>
        </div>
      </form>
    </Modal>
  );
}
