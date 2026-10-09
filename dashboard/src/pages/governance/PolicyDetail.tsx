import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ScrollText, ArrowLeft, ShieldCheck, ShieldAlert, Users, GitCompare, History, FileSignature } from 'lucide-react';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import {
  getCompileRecord, getPolicy, getQuorum, proposeRetirement, voteOnVersion, withdrawVersion,
  type CompileRecord, type CpgMe, type PolicyDetail as PolicyDetailData, type PolicyVersion, type PolicyVote,
} from '../../api/cpg';
import { useCpgMe } from '../../hooks/useCpgMe';
import { useOrgUsers } from '../../hooks/useOrgUsers';
import { cpgErrorCode } from '../../lib/cpg-errors';
import { formatActor, hasOrgPermission } from '../../lib/cpg-permissions';
import {
  EVENT_LABEL, enforcementSummary, formatUtc, fourEyesStatus, policyErrorMessage, versionDiff, type FourEyes,
} from '../../lib/cpg-policy';
import GovernanceHeader from './GovernanceHeader';
import CompileResult from './policies/CompileResult';
import { Mono, RuleView, StateBadge, TierBadge, VersionStatusBadge } from './policies/parts';

type Names = ReadonlyMap<string, { name: string; email: string }>;

/**
 * /governance/policies/:id (E33, E36, E37, E35): one policy with every
 * version, the diff between versions, approval votes and the four-eyes
 * status of a pending version, the grace period, activation signatures and
 * the supersede history.
 */
export default function PolicyDetail() {
  const { id = '' } = useParams();
  const location = useLocation();
  const justProposed = (location.state as { proposed?: boolean } | null)?.proposed === true;
  const { me } = useCpgMe();
  const { byId: names, error: namesError } = useOrgUsers(hasOrgPermission(me, 'org.members.read'));
  const [detail, setDetail] = useState<PolicyDetailData | null>(null);
  const [error, setError] = useState<{ text: string; notFound: boolean } | null>(null);
  const [lapseDays, setLapseDays] = useState<number | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPolicy(id)
      .then((d) => { if (!cancelled) { setDetail(d); setError(null); setFetchedAt(new Date().toISOString()); } })
      .catch((err) => {
        if (!cancelled) setError({ text: policyErrorMessage(err, 'Failed to load the policy'), notFound: cpgErrorCode(err) === 'not_found' });
      });
    return () => { cancelled = true; };
  }, [id, reloadKey]);

  // The proposal lapse window (quorum), for the pending version's deadline. Best effort.
  useEffect(() => {
    let cancelled = false;
    getQuorum().then((q) => { if (!cancelled) setLapseDays(q.config.proposalLapseDays); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const reload = () => setReloadKey((k) => k + 1);

  return (
    <div>
      <Link to="/governance/policies" className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-accent mb-3">
        <ArrowLeft size={12} /> All policies
      </Link>
      {error ? (
        error.notFound
          ? <EmptyState title="Policy not found" description="It does not exist in your organization." />
          : <ErrorState message={error.text} onRetry={() => { setError(null); reload(); }} />
      ) : !detail ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <PolicyDetailView
          detail={detail}
          me={me}
          names={names}
          namesError={namesError}
          lapseDays={lapseDays}
          justProposed={justProposed}
          notice={notice}
          onNotice={setNotice}
          onChanged={reload}
          fetchedAt={fetchedAt}
        />
      )}
    </div>
  );
}

export function PolicyDetailView({ detail, me, names, namesError, lapseDays, justProposed, notice, onNotice, onChanged, fetchedAt, now: nowProp }: {
  detail: PolicyDetailData;
  me: CpgMe | null;
  names: Names;
  namesError: string | null;
  lapseDays: number | null;
  justProposed: boolean;
  notice: { type: 'ok' | 'err'; text: string } | null;
  onNotice: (n: { type: 'ok' | 'err'; text: string } | null) => void;
  onChanged: () => void;
  fetchedAt: string | null;
  now?: number;
}) {
  const navigate = useNavigate();
  const [mountedAt] = useState(() => Date.now());
  const now = nowProp ?? mountedAt;
  const p = detail.policy;
  const fourEyes = fourEyesStatus(detail, me);
  const canAuthor = hasOrgPermission(me, 'policy.author');
  const enforcement = enforcementSummary(p, now);
  const [retiring, setRetiring] = useState(false);
  const versionsDesc = [...detail.versions].sort((a, b) => b.version - a.version);
  const shownVersion = detail.versions.find((v) => v.id === p.pendingVersionId)
    ?? detail.versions.find((v) => v.version === p.activeVersion)
    ?? versionsDesc[0];
  const ruleVersion = [shownVersion, ...versionsDesc].find((v) => v?.rule) ?? null;

  return (
    <div className="space-y-4">
      <GovernanceHeader
        icon={ScrollText}
        title={p.title}
        subtitle={p.policyKey}
        actions={canAuthor && p.state !== 'retired' && !p.pendingVersionId ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => navigate(`/governance/policies/new?policy=${p.policyId}`)}>New version</Button>
            {p.state === 'active' && <Button size="sm" variant="danger" onClick={() => setRetiring(true)}>Propose retirement</Button>}
          </>
        ) : undefined}
      />

      {justProposed && p.pendingVersionId && (
        <Card className="border-accent/40">
          <p className="text-sm text-text-primary" role="status" data-testid="proposed-notice">
            Proposed. Version {p.pendingVersion} is <strong>not active</strong>: it waits for approval by someone other than you.
          </p>
        </Card>
      )}
      {notice && (
        <p className={`text-sm ${notice.type === 'ok' ? 'text-success' : 'text-danger'}`} role={notice.type === 'err' ? 'alert' : 'status'} data-testid="policy-notice">{notice.text}</p>
      )}
      {namesError && <ErrorState compact message={`${namesError}; user ids are shown instead.`} />}

      <Card>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
          <Field label="State"><StateBadge state={p.state} /></Field>
          <Field label="Tier"><TierBadge tier={p.tier} /></Field>
          <Field label="Owning boards">{p.owningBoards.length === 0 ? '—' : p.owningBoards.map((b) => b.name || b.id).join(', ')}</Field>
          <Field label="Active version">{p.activeVersion !== null ? `v${p.activeVersion}` : 'none'}{p.pendingVersion !== null ? `, v${p.pendingVersion} pending` : ''}</Field>
          <Field label="Enforcement">
            <Badge variant={enforcement.variant}>{enforcement.label}</Badge>
            <p className="text-xs text-text-muted mt-1" data-testid="enforcement-detail">{enforcement.detail}</p>
          </Field>
        </div>
      </Card>

      {fourEyes && (
        <PendingPanel
          fourEyes={fourEyes}
          detail={detail}
          names={names}
          lapseDays={lapseDays}
          onNotice={onNotice}
          onChanged={onChanged}
        />
      )}

      {ruleVersion?.rule && (
        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-1">Rule of version {ruleVersion.version} ({ruleVersion.status === 'pending' ? 'awaiting approval' : ruleVersion.status})</h2>
          <p className="text-xs text-text-muted mb-3">
            Compiled from the policy text by an LLM{ruleVersion.editedFromCompile ? ' and then edited by the author' : ''}; it became a rule only through approval. Scans evaluate it deterministically.
          </p>
          <p className="text-xs text-text-muted mb-1">Policy text</p>
          <p className="text-sm text-text-primary mb-3 whitespace-pre-wrap">{ruleVersion.plainText}</p>
          <RuleView rule={ruleVersion.rule} testId="policy-rule" />
        </Card>
      )}

      <VersionsCard detail={detail} names={names} me={me} />
      <DiffCard versions={detail.versions} />
      <HistoryCard detail={detail} names={names} />
      <DataFreshness fetchedAt={fetchedAt} />

      {retiring && (
        <RetireModal
          policyId={p.policyId}
          policyKey={p.policyKey}
          onClose={() => setRetiring(false)}
          onDone={(text) => { setRetiring(false); onNotice({ type: 'ok', text }); onChanged(); }}
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-text-muted mb-1">{label}</p>
      <div className="text-text-primary">{children}</div>
    </div>
  );
}

function PendingPanel({ fourEyes, detail, names, lapseDays, onNotice, onChanged }: {
  fourEyes: FourEyes;
  detail: PolicyDetailData;
  names: Names;
  lapseDays: number | null;
  onNotice: (n: { type: 'ok' | 'err'; text: string } | null) => void;
  onChanged: () => void;
}) {
  const v = fourEyes.version;
  const votes = detail.votes.filter((x) => x.versionId === v.id);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lapsesAt = lapseDays !== null ? new Date(Date.parse(v.createdAt) + lapseDays * 86_400_000).toISOString() : null;

  async function vote(choice: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    onNotice(null);
    try {
      const r = await voteOnVersion(v.id, choice, comment);
      const text = r.versionState === 'active' ? `Approved. Version ${v.version} is now active and signed.`
        : r.versionState === 'retired' ? 'Approved. The policy is now retired.'
          : r.versionState === 'rejected' ? `Rejected. Version ${v.version} will not become active.`
            : `Your ${choice === 'approve' ? 'approval' : 'rejection'} is recorded; more approvals are needed.`;
      onNotice({ type: 'ok', text });
      onChanged();
    } catch (err) {
      setError(policyErrorMessage(err, 'The vote failed'));
    }
    setBusy(false);
  }

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      await withdrawVersion(v.id);
      onNotice({ type: 'ok', text: `Version ${v.version} withdrawn.` });
      onChanged();
    } catch (err) {
      setError(policyErrorMessage(err, 'Withdrawing failed'));
    }
    setBusy(false);
  }

  return (
    <Card className="border-accent/40">
      <div className="flex items-start justify-between gap-3 flex-wrap" data-testid="four-eyes">
        <div>
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Users size={16} className="text-accent" />
            Version {v.version} awaits approval{v.kind === 'retire' ? ' (retirement)' : ''}
          </h2>
          <p className="text-xs text-text-muted mt-1">
            Four-eyes: {fourEyes.approvals} of {fourEyes.required} approval{fourEyes.required === 1 ? '' : 's'} so far, from people holding policy.approve
            who did not propose or compile it. One rejection rejects it.
          </p>
        </div>
        <Badge variant="accent">{fourEyes.approvals} / {fourEyes.required} approvals</Badge>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs mt-3">
        <div><p className="text-text-muted">Proposed by</p><p className="text-text-primary">{formatActor(fourEyes.author, names)} · {formatUtc(v.createdAt)}</p></div>
        {fourEyes.requester && <div><p className="text-text-muted">Compiled by</p><p className="text-text-primary">{formatActor(fourEyes.requester, names)}</p></div>}
        <div><p className="text-text-muted">Lapses</p><p className="text-text-primary">{lapsesAt ? `${formatUtc(lapsesAt)} if not decided` : '—'}</p></div>
        {v.kind === 'retire' && <div className="md:col-span-3"><p className="text-text-muted">Reason for retiring</p><p className="text-text-primary">{v.plainText}</p></div>}
        {v.kind === 'define' && (
          <div className="md:col-span-3">
            <p className="text-text-muted">Grace period once approved</p>
            <p className="text-text-primary">
              {v.enforceFromRequested ? `Enforced from ${formatUtc(v.enforceFromRequested)} (or from approval, if later)`
                : v.graceDays !== null ? `${v.graceDays} day${v.graceDays === 1 ? '' : 's'} after approval`
                  : 'The quorum default for this policy at the time of approval'}
            </p>
          </div>
        )}
      </div>

      {votes.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs" data-testid="pending-votes">
          {votes.map((x) => (
            <li key={x.id} className="flex items-start gap-2">
              <Badge variant={x.vote === 'approve' ? 'success' : 'danger'}>{x.vote === 'approve' ? 'Approved' : 'Rejected'}</Badge>
              <span className="text-text-secondary">{x.voterName || formatActor(`user:${x.voterUserId}`, names)} · {formatUtc(x.createdAt)}{x.comment ? `: "${x.comment}"` : ''}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-border pt-3">
        {fourEyes.canVote ? (
          <div className="space-y-2">
            <label htmlFor="vote-comment" className="block text-xs text-text-muted">Comment (optional, recorded with your vote)</label>
            <textarea id="vote-comment" rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" />
            <div className="flex gap-2 justify-end">
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void vote('reject')}>Reject</Button>
              <Button size="sm" disabled={busy} onClick={() => void vote('approve')}>{busy ? 'Saving...' : 'Approve'}</Button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-text-secondary flex items-start gap-2" data-testid="vote-blocked">
            <ShieldAlert size={14} className="text-warning shrink-0" /> {fourEyes.voteBlockedReason}
          </p>
        )}
        {fourEyes.canWithdraw && (
          <div className="flex justify-end mt-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void withdraw()}>Withdraw my proposal</Button>
          </div>
        )}
        {error && <p className="text-sm text-danger mt-2" role="alert" data-testid="vote-error">{error}</p>}
      </div>
    </Card>
  );
}

function VersionsCard({ detail, names, me }: { detail: PolicyDetailData; names: Names; me: CpgMe | null }) {
  const canReadCompile = hasOrgPermission(me, 'policy.author') || hasOrgPermission(me, 'policy.approve');
  const [openRecord, setOpenRecord] = useState<string | null>(null);
  const byId = new Map(detail.versions.map((v) => [v.id, v.version]));
  const supersededBy = new Map<string, number>();
  for (const e of detail.events) {
    if (e.event === 'superseded' && typeof e.details.supersededBy === 'string') {
      const n = byId.get(e.details.supersededBy);
      if (n !== undefined) supersededBy.set(e.versionId, n);
    }
  }
  const versions = [...detail.versions].sort((a, b) => b.version - a.version);
  return (
    <Card className="p-0 overflow-x-auto">
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2"><FileSignature size={16} className="text-accent" /> Versions</h2>
        <p className="text-xs text-text-muted">Every version is kept. An approved version is signed with this Nomus instance&apos;s Ed25519 key; verify signatures offline with the signed policy export.</p>
      </div>
      <table className="w-full text-sm" data-testid="policy-versions">
        <thead>
          <tr className="border-y border-border text-left text-text-muted">
            <th className="px-4 py-2 font-medium">Version</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Tier and owners</th>
            <th className="px-4 py-2 font-medium">Proposed</th>
            <th className="px-4 py-2 font-medium">Votes</th>
            <th className="px-4 py-2 font-medium">Activated / enforced from</th>
            <th className="px-4 py-2 font-medium">Signature</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {versions.map((v) => (
            <VersionRow
              key={v.id}
              v={v}
              names={names}
              votes={detail.votes.filter((x) => x.versionId === v.id)}
              supersededBy={supersededBy.get(v.id) ?? null}
              canReadCompile={canReadCompile}
              open={openRecord === v.id}
              onToggle={() => setOpenRecord(openRecord === v.id ? null : v.id)}
            />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function VersionRow({ v, names, votes, supersededBy, canReadCompile, open, onToggle }: {
  v: PolicyVersion; names: Names; votes: PolicyVote[]; supersededBy: number | null; canReadCompile: boolean; open: boolean; onToggle: () => void;
}) {
  return (
    <>
      <tr className="align-top">
        <td className="px-4 py-3 whitespace-nowrap">
          <p className="text-text-primary font-medium">v{v.version}</p>
          <p className="text-xs text-text-muted">{v.kind === 'retire' ? 'Retirement' : v.editedFromCompile ? 'Edited after compile' : 'As compiled'}</p>
        </td>
        <td className="px-4 py-3">
          <VersionStatusBadge status={v.status} />
          {supersededBy !== null && <p className="text-xs text-text-muted mt-1">by v{supersededBy}</p>}
        </td>
        <td className="px-4 py-3 text-xs text-text-secondary">
          <TierBadge tier={v.tier} />
          <p className="mt-1">{v.owningBoards.map((b) => b.name || b.id).join(', ')}</p>
        </td>
        <td className="px-4 py-3 text-xs text-text-secondary">
          <p>{formatActor(v.createdBy, names)}</p>
          <p className="text-text-muted">{formatUtc(v.createdAt)}</p>
          {v.compileRecordId && canReadCompile && (
            <button type="button" className="text-accent hover:underline mt-1" onClick={onToggle} aria-expanded={open}>
              {open ? 'Hide compile record' : 'Compile record'}
            </button>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-text-secondary">
          {votes.length === 0 ? <span className="text-text-muted">None</span> : (
            <ul className="space-y-1" data-testid={`votes-v${v.version}`}>
              {votes.map((x) => (
                <li key={x.id}>
                  <span className={x.vote === 'approve' ? 'text-success' : 'text-danger'}>{x.vote === 'approve' ? 'Approved' : 'Rejected'}</span>
                  {' by '}{x.voterName || formatActor(`user:${x.voterUserId}`, names)}
                  <span className="text-text-muted"> · {formatUtc(x.createdAt)} · quorum v{x.quorumConfigVersion}</span>
                  {x.comment && <p className="text-text-muted">&ldquo;{x.comment}&rdquo;</p>}
                </li>
              ))}
            </ul>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-text-secondary">
          {v.activatedAt ? (
            <>
              <p>{v.kind === 'retire' ? 'Retired' : 'Activated'} {formatUtc(v.activatedAt)}</p>
              {v.enforceFrom && <p className="text-text-muted">Enforced from {formatUtc(v.enforceFrom)}</p>}
            </>
          ) : <p className="text-text-muted">Never activated</p>}
        </td>
        <td className="px-4 py-3 text-xs">
          {v.signature ? (
            <details>
              <summary className="text-success cursor-pointer flex items-center gap-1"><ShieldCheck size={12} /> Signed</summary>
              <p className="mt-1 text-text-muted">Ed25519, base64; rule hash <Mono>{v.ruleHash ?? '(retirement)'}</Mono></p>
              <Mono className="text-text-secondary">{v.signature}</Mono>
            </details>
          ) : <span className="text-text-muted">Not signed (only approved versions are)</span>}
        </td>
      </tr>
      {open && v.compileRecordId && (
        <tr>
          <td colSpan={7} className="px-4 pb-4"><CompileRecordPanel recordId={v.compileRecordId} /></td>
        </tr>
      )}
    </>
  );
}

function CompileRecordPanel({ recordId }: { recordId: string }) {
  const [record, setRecord] = useState<CompileRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getCompileRecord(recordId)
      .then((r) => { if (!cancelled) { setRecord(r); setError(null); } })
      .catch((err) => { if (!cancelled) setError(policyErrorMessage(err, 'Failed to load the compile record')); });
    return () => { cancelled = true; };
  }, [recordId, key]);
  if (error) return <ErrorState compact message={error} onRetry={() => { setError(null); setKey((k) => k + 1); }} />;
  if (!record) return <div className="flex justify-center py-4"><Spinner className="w-5 h-5" /></div>;
  return <CompileResult record={record} />;
}

export function DiffCard({ versions }: { versions: PolicyVersion[] }) {
  const sorted = useMemo(() => [...versions].sort((a, b) => a.version - b.version), [versions]);
  const last = sorted[sorted.length - 1];
  const [toV, setToV] = useState<number>(last?.version ?? 1);
  const [fromV, setFromV] = useState<number>(sorted.length > 1 ? sorted[sorted.length - 2].version : (last?.version ?? 1));
  if (sorted.length < 2) {
    return (
      <Card>
        <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-1"><GitCompare size={16} className="text-accent" /> Compare versions</h2>
        <p className="text-xs text-text-muted">There is only one version, so there is nothing to compare yet.</p>
      </Card>
    );
  }
  const a = sorted.find((v) => v.version === fromV) ?? sorted[0];
  const b = sorted.find((v) => v.version === toV) ?? last;
  const rows = versionDiff(a, b);
  const sel = 'px-2 py-1 bg-surface border border-border rounded-lg text-sm text-text-primary';
  return (
    <Card>
      <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-3"><GitCompare size={16} className="text-accent" /> Compare versions</h2>
      <div className="flex items-center gap-2 text-sm text-text-secondary mb-3 flex-wrap">
        <label htmlFor="diff-from">From</label>
        <select id="diff-from" className={sel} value={a.version} onChange={(e) => setFromV(Number(e.target.value))}>
          {sorted.map((v) => <option key={v.id} value={v.version}>v{v.version}</option>)}
        </select>
        <label htmlFor="diff-to">to</label>
        <select id="diff-to" className={sel} value={b.version} onChange={(e) => setToV(Number(e.target.value))}>
          {sorted.map((v) => <option key={v.id} value={v.version}>v{v.version}</option>)}
        </select>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">{a.version === b.version ? 'Choose two different versions.' : 'These versions are identical.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="version-diff">
            <thead>
              <tr className="border-b border-border text-left text-text-muted">
                <th className="px-2 py-2 font-medium">Field</th>
                <th className="px-2 py-2 font-medium">v{a.version}</th>
                <th className="px-2 py-2 font-medium">v{b.version}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.field} className="align-top">
                  <td className="px-2 py-2 font-mono text-text-secondary">{r.field}</td>
                  <td className="px-2 py-2 text-danger whitespace-pre-wrap break-all">{r.before}</td>
                  <td className="px-2 py-2 text-success whitespace-pre-wrap break-all">{r.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function HistoryCard({ detail, names }: { detail: PolicyDetailData; names: Names }) {
  const byId = new Map(detail.versions.map((v) => [v.id, v.version]));
  const events = [...detail.events].reverse();
  return (
    <Card>
      <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-3"><History size={16} className="text-accent" /> History</h2>
      {events.length === 0 ? (
        <p className="text-xs text-text-muted">No events yet.</p>
      ) : (
        <ol className="space-y-2" data-testid="policy-history">
          {events.map((e) => {
            const d = e.details;
            const extra: string[] = [];
            if (typeof d.supersededBy === 'string') extra.push(`by v${byId.get(d.supersededBy) ?? d.supersededBy}`);
            if (typeof d.enforceFrom === 'string') extra.push(`enforced from ${formatUtc(d.enforceFrom)}`);
            if (typeof d.quorumConfigVersion === 'number') extra.push(`quorum v${d.quorumConfigVersion}`);
            if (d.editedFromCompile === true) extra.push('rule edited after compile');
            if (typeof d.reason === 'string') extra.push(`reason: ${d.reason}`);
            if (typeof d.lapseDays === 'number') extra.push(`after ${d.lapseDays} days`);
            return (
              <li key={e.id} className="flex items-start gap-3 text-xs">
                <span className="text-text-muted whitespace-nowrap w-40 shrink-0" title={e.createdAt}>{formatUtc(e.createdAt)}</span>
                <span className="text-text-primary">
                  <strong>v{e.version}</strong> {EVENT_LABEL[e.event] ?? e.event}
                  <span className="text-text-secondary"> · {formatActor(e.actor, names)}{extra.length > 0 ? ` · ${extra.join(' · ')}` : ''}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function RetireModal({ policyId, policyKey, onClose, onDone }: { policyId: string; policyKey: string; onClose: () => void; onDone: (text: string) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await proposeRetirement(policyId, reason.trim());
      onDone(`Retirement proposed as version ${d.policy.pendingVersion}. The policy stays active until someone other than you approves it.`);
    } catch (err) {
      setError(policyErrorMessage(err, 'Proposing the retirement failed'));
    }
    setBusy(false);
  }
  return (
    <Modal open onClose={onClose} title={`Propose retiring ${policyKey}`}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <p className="text-xs text-text-secondary">Retiring removes the policy from every scan. It weakens enforcement, so it goes through the same four-eyes approval as a new version.</p>
        <label htmlFor="retire-reason" className="block text-xs text-text-muted">Reason *</label>
        <textarea id="retire-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)}
          className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" />
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>{busy ? 'Proposing...' : 'Propose retirement'}</Button>
        </div>
      </form>
    </Modal>
  );
}
