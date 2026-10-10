import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { SkeletonTable } from '../../components/ui/Skeleton';
import {
  LANGUAGES, getQuorum, listPolicies, listStandingExceptions, listStandingProposals, listTeams, propose,
  type PolicyHead, type QuorumConfig, type StandingPattern, type Team,
} from '../../api/cpg';
import { useCpgMe } from '../../hooks/useCpgMe';
import { useCpgLoad } from '../../hooks/useCpgLoad';
import { hasOrgPermission } from '../../lib/cpg-permissions';
import { formatUtc, policyErrorMessage } from '../../lib/cpg-policy';
import {
  EXCEPTION_STATUSES, EXCEPTION_STATUS_LABEL, EXCEPTION_STATUS_VARIANT, exceptionActions, exceptionRows, isoInDays, parseDays,
  requirementText, scopeRule, type ExceptionRow, type ExceptionStatus,
} from '../../lib/cpg-approvals';
import GovernanceHeader from './GovernanceHeader';
import { FilterTabs, InfoNote } from './parts';
import { ExpiryField, ProposalCard, RationaleField, RevokeModal, inputCls } from './decisions/parts';

/**
 * /governance/exceptions (E54, E55, E57, E58, E60): standing exceptions,
 * pending, active, expired, revoked, lapsed (the policy has a newer version)
 * or not approved, including proposals made outside any case. Propose, vote
 * and revoke; the server checks every write on each repository a pattern covers.
 */
export default function GovernanceExceptions() {
  const { me } = useCpgMe();
  const readsPolicies = hasOrgPermission(me, 'policy.read');
  const readsMembers = hasOrgPermission(me, 'org.members.read');
  const actions = exceptionActions(me);
  const { data: rows, error, fetchedAt, reload, retryKeepingData } = useCpgLoad(
    async () => exceptionRows(...await Promise.all([listStandingProposals(), listStandingExceptions()])), 'Failed to load the standing exceptions');
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<ExceptionStatus | ''>('');
  const [policyKey, setPolicyKey] = useState('');
  const [proposing, setProposing] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [policies, setPolicies] = useState<PolicyHead[]>([]);
  const [quorum, setQuorum] = useState<QuorumConfig | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);

  // Reference data, each only when the caller may read it: policies and quorum (policy.read), teams (org.members.read).
  useEffect(() => {
    let cancelled = false;
    if (readsPolicies) {
      listPolicies().then((p) => { if (!cancelled) setPolicies(p); }).catch(() => {});
      getQuorum().then((q) => { if (!cancelled) setQuorum(q.config); }).catch(() => {});
    }
    if (readsMembers) listTeams().then((t) => { if (!cancelled) setTeams(t.filter((x) => !x.archivedAt)); }).catch(() => {});
    return () => { cancelled = true; };
  }, [readsPolicies, readsMembers]);

  const changed = (text: string) => { setNotice(text); setProposing(false); setRevoking(null); reload(); };
  const boards = new Map([...(me?.boards ?? []), ...policies.flatMap((p) => p.owningBoards)].map((b) => [b.id, b.name]));
  const boardName = (id: string) => boards.get(id) || 'another required board';
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const shown = (rows ?? []).filter((r) => (!status || r.status === status) && (!policyKey || r.proposal.policyKey === policyKey));
  const policyKeys = [...new Set((rows ?? []).map((r) => r.proposal.policyKey))].sort();
  const readOnly = me && !me.cpgEnabled ? 'Governance is off for this organization, so exceptions cannot be proposed or voted on.' : null;

  return (
    <div>
      <GovernanceHeader
        icon={ShieldOff}
        title="Standing exceptions"
        subtitle="Approvals that cover future findings matching a pattern, pinned to one policy version, always with an expiry"
        actions={actions.propose && !readOnly ? <Button size="sm" onClick={() => setProposing(true)}>Propose an exception</Button> : undefined}
      />
      {readOnly && (
        <InfoNote role="status">{readOnly}</InfoNote>
      )}
      {notice && <p className="text-sm text-success mb-3" role="status" data-testid="exceptions-notice">{notice}</p>}

      <div className="flex gap-3 mb-4 flex-wrap items-center">
        <FilterTabs
          label="Filter by status"
          options={(['', ...EXCEPTION_STATUSES] as const).map((s) => ({ value: s, label: s ? EXCEPTION_STATUS_LABEL[s] : 'All' }))}
          value={status}
          onChange={setStatus}
        />
        {policyKeys.length > 0 && (
          <select aria-label="Filter by policy" value={policyKey} onChange={(e) => setPolicyKey(e.target.value)}
            className="px-3 py-1.5 bg-surface border border-border rounded-lg text-xs text-text-primary">
            <option value="">Every policy</option>
            {policyKeys.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        )}
      </div>

      {error ? <ErrorState message={error} onRetry={retryKeepingData} />
        : rows === null ? <SkeletonTable rows={4} />
          : shown.length === 0 ? (
            <EmptyState
              title={rows.length === 0 ? 'No standing exceptions yet' : 'No exceptions match these filters'}
              description={rows.length === 0 ? 'Exceptions proposed here or from a review case are listed once proposed.' : 'Choose another status or policy.'}
            />
          ) : (
            <ul className="space-y-3" data-testid="exceptions">
              {shown.map((r) => (
                <ProposalCard key={r.proposal.id} proposal={r.proposal} boardName={boardName} onChanged={changed} voteHidden={readOnly}
                  status={<Badge variant={EXCEPTION_STATUS_VARIANT[r.status]} className="whitespace-nowrap">{EXCEPTION_STATUS_LABEL[r.status]}</Badge>}
                  subject={<ExceptionSubject row={r} teamName={teamName} canRevoke={actions.revoke && !readOnly} onRevoke={setRevoking} />} />
              ))}
            </ul>
          )}
      <DataFreshness fetchedAt={fetchedAt} />

      {proposing && <StandingModal policies={policies} quorum={quorum} teams={teams} onClose={() => setProposing(false)} onDone={changed} />}
      {revoking && <RevokeModal decisionId={revoking} what="standing exception" onClose={() => setRevoking(null)} onDone={changed} />}
    </div>
  );
}

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

function ExceptionSubject({ row: { proposal: p, exception: x, status }, teamName, canRevoke, onRevoke }: {
  row: ExceptionRow; teamName: (id: string) => string; canRevoke: boolean; onRevoke: (decisionId: string) => void;
}) {
  const pattern = p.pattern;
  if (!pattern) return null;
  const c = pattern.conditions;
  const conditions = [
    c.branches && `branches ${c.branches.join(', ')}`,
    c.languages && `languages ${c.languages.join(', ')}`,
    c.maxLinesPerFinding !== undefined && `at most ${c.maxLinesPerFinding} lines per finding`,
    c.snippetMustMatch && `snippet matches /${c.snippetMustMatch.source}/${c.snippetMustMatch.flags}`,
  ].filter(Boolean);
  const item = (label: string, values: string[]) => values.length > 0 && (
    <div><p className="text-text-muted">{label}</p><ul className="font-mono text-text-primary">{values.map((v) => <li key={v} className="break-all">{v}</li>)}</ul></div>
  );
  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {item('Repositories', pattern.repos)}
        {item('Teams', pattern.teamIds.map(teamName))}
        {item('Paths', pattern.paths)}
        {item('Excluded paths', pattern.excludePaths)}
        <div><p className="text-text-muted">Conditions</p><p className="text-text-primary">{conditions.length > 0 ? conditions.join('; ') : 'None'}</p></div>
        {p.caseId && <div><p className="text-text-muted">Proposed from</p><Link to={`/governance/cases/${p.caseId}`} className="text-accent hover:underline">a review case</Link></div>}
      </div>
      {x && (
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <p className="text-text-secondary" data-testid="exception-state">
            Approved {formatUtc(x.finalizedAt)}.{status === 'lapsed' ? ` It applied to ${x.policyKey} v${x.policyVersion}, which is no longer the active version; propose it again for the current one.`
              : status === 'revoked' || status === 'expired' ? ' It no longer applies.' : ''}
          </p>
          {status === 'active' && canRevoke && <Button size="sm" variant="ghost" onClick={() => onRevoke(x.id)}>Revoke</Button>}
        </div>
      )}
    </div>
  );
}

/** Propose a standing exception: a pattern on one active policy version, with an expiry within the configured range. */
function StandingModal({ policies, quorum, teams, onClose, onDone }: {
  policies: PolicyHead[]; quorum: QuorumConfig | null; teams: Team[]; onClose: () => void; onDone: (text: string) => void;
}) {
  const [now] = useState(() => Date.now());
  const candidates = policies.filter((p) => p.state === 'active' && p.activeVersion !== null && p.tier !== 'advisory');
  const [policyId, setPolicyId] = useState(candidates[0]?.policyId ?? '');
  const policy = candidates.find((p) => p.policyId === policyId);
  const rule = policy && quorum ? scopeRule(quorum, policy.policyId, policy.tier, 'standing') : null;
  const [days, setDays] = useState(rule ? String(rule.defaultDays) : '30');
  const [repos, setRepos] = useState('');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [paths, setPaths] = useState('');
  const [excludePaths, setExcludePaths] = useState('');
  const [branches, setBranches] = useState('');
  const [languages, setLanguages] = useState<string[]>([]);
  const [maxLines, setMaxLines] = useState('');
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expiryDays = rule ? parseDays(days, rule.maxDays) : null;
  const pickPolicy = (id: string) => {
    const next = candidates.find((p) => p.policyId === id);
    const nextRule = next && quorum ? scopeRule(quorum, next.policyId, next.tier, 'standing') : null;
    setPolicyId(id);
    if (nextRule) setDays(String(nextRule.defaultDays));
  };
  const problem = !quorum ? 'Proposing needs the policies and the quorum configuration, which your role cannot read (policy.read).'
    : !policy ? 'No active policy can take a standing exception.'
      : !rule ? 'The quorum configuration does not allow standing exceptions for this policy.'
        : lines(repos).length + teamIds.length === 0 ? 'Name at least one repository pattern or team.'
          : lines(paths).length === 0 ? 'Name at least one path glob.'
            : maxLines.trim() && parseDays(maxLines, 400) === null ? 'Lines per finding must be a whole number from 1 to 400.'
              : expiryDays === null ? 'Choose a valid expiry.'
                : rationale.trim().length < 20 ? 'Write a rationale of at least 20 characters.' : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!policy || expiryDays === null) return;
    setBusy(true);
    setError(null);
    const pattern: StandingPattern = {
      repos: lines(repos), teamIds, paths: lines(paths), excludePaths: lines(excludePaths), policyKey: policy.policyKey, policyVersion: policy.activeVersion!,
      conditions: {
        ...(lines(branches).length > 0 ? { branches: lines(branches) } : {}),
        ...(languages.length > 0 ? { languages: languages as StandingPattern['conditions']['languages'] } : {}),
        ...(maxLines.trim() ? { maxLinesPerFinding: Number(maxLines) } : {}),
      },
    };
    try {
      await propose({ scope: 'standing', pattern, expiresAt: isoInDays(expiryDays, now), rationale: rationale.trim() });
      onDone('Proposed. The exception applies once its approvers have voted.');
    } catch (err) {
      setError(policyErrorMessage(err, 'Proposing failed'));
      setBusy(false);
    }
  }

  const area = (id: string, label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <div>
      <label htmlFor={id} className="block text-xs text-text-muted mb-1">{label}</label>
      <textarea id={id} rows={2} value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder} className={`${inputCls} font-mono text-xs`} />
    </div>
  );

  return (
    <Modal open onClose={onClose} title="Propose a standing exception" width="max-w-2xl">
      <form onSubmit={(e) => void submit(e)} className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
        <div>
          <label htmlFor="se-policy" className="block text-xs text-text-muted mb-1">Policy *</label>
          <select id="se-policy" value={policyId} onChange={(e) => pickPolicy(e.target.value)} className={inputCls}>
            {candidates.map((p) => <option key={p.policyId} value={p.policyId}>{p.title} ({p.policyKey} v{p.activeVersion}, {p.tier})</option>)}
          </select>
          {rule && (
            <p className="text-xs text-text-secondary mt-1" data-testid="standing-requirement">
              Needs {requirementText(rule)}. You do not vote on your own proposal.
              {' '}It covers version {policy?.activeVersion} only: a new version of the policy makes it lapse.
            </p>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {area('se-repos', 'Repository patterns (one per line, lowercase)', repos, setRepos, 'example-org/app')}
          {area('se-paths', 'Path globs (one per line) *', paths, setPaths, 'src/legacy/**')}
          {area('se-exclude', 'Excluded path globs', excludePaths, setExcludePaths, 'src/legacy/new/**')}
          {area('se-branches', 'Only on branches (globs)', branches, setBranches, 'feat/*')}
        </div>
        {teams.length > 0 && (
          <fieldset>
            <legend className="text-xs text-text-muted mb-1">Teams (their repositories, resolved when findings are checked)</legend>
            <div className="flex gap-3 flex-wrap text-sm">
              {teams.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-text-primary">
                  <input type="checkbox" checked={teamIds.includes(t.id)} onChange={(e) => setTeamIds(e.target.checked ? [...teamIds, t.id] : teamIds.filter((x) => x !== t.id))} />{t.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <fieldset>
            <legend className="text-xs text-text-muted mb-1">Only in languages</legend>
            <div className="flex gap-3 flex-wrap text-sm">
              {LANGUAGES.map((l) => (
                <label key={l} className="flex items-center gap-1 text-text-primary">
                  <input type="checkbox" checked={languages.includes(l)} onChange={(e) => setLanguages(e.target.checked ? [...languages, l] : languages.filter((x) => x !== l))} />{l}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="se-lines" className="block text-xs text-text-muted mb-1">At most this many lines per finding</label>
            <input id="se-lines" type="number" min={1} max={400} value={maxLines} onChange={(e) => setMaxLines(e.target.value)} className={`${inputCls} max-w-[8rem]`} />
          </div>
        </div>
        {rule && <ExpiryField id="se-expiry" days={days} setDays={setDays} maxDays={rule.maxDays} now={now} />}
        <RationaleField id="se-rationale" value={rationale} setValue={setRationale} />
        {problem && <p className="text-xs text-text-muted" data-testid="propose-problem">{problem}</p>}
        {error && <p className="text-sm text-danger" role="alert" data-testid="propose-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || problem !== null}>{busy ? 'Proposing...' : 'Propose'}</Button>
        </div>
      </form>
    </Modal>
  );
}
