import { useState } from 'react';
import { Lock, Trash2 } from 'lucide-react';
import Card from '../../../components/ui/Card';
import Button from '../../../components/ui/Button';
import {
  putQuorum, QUORUM_SCOPES,
  type Board, type PolicyHead, type QuorumConfig, type QuorumVersion, type ScopeSlot,
} from '../../../api/cpg';
import { policyErrorMessage, TIER_LABEL } from '../../../lib/cpg-policy';
import {
  EDITABLE_TIERS, SCOPE_LABEL, pathLabel, quorumChanges, quorumIssues, removeAt, setAt, toggledSlot, type QuorumIssue,
} from '../../../lib/cpg-quorum-form';
import FixedRules from './FixedRules';

const numCls = 'w-24 px-2 py-1 bg-surface border border-border rounded-lg text-sm text-text-primary';

/**
 * The quorum form (E26). It validates the draft with the engine's own schema
 * as the admin types, shows every problem next to its field, lists exactly
 * what will change, and needs a change note. Saving creates a new signed
 * version; nothing is ever edited in place.
 */
export default function QuorumEditor({ current, boards, policies, onCancel, onSaved }: {
  current: QuorumVersion;
  boards: Board[];
  policies: PolicyHead[];
  onCancel: () => void;
  onSaved: (v: QuorumVersion) => void;
}) {
  const [draft, setDraft] = useState<QuorumConfig>(() => structuredClone(current.config) as QuorumConfig);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addPolicy, setAddPolicy] = useState('');
  const policyNames = new Map(policies.map((p) => [p.policyId, p.policyKey]));
  const issues = quorumIssues(draft);
  const changes = quorumChanges(current.config as QuorumConfig, draft, policyNames);
  const activeBoards = boards.filter((b) => !b.archivedAt);
  const update = (path: string[], value: unknown) => setDraft((d) => setAt(d, path, value));
  const issuesAt = (prefix: string) => issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await putQuorum(draft, note.trim()));
    } catch (err) {
      setError(policyErrorMessage(err, 'Saving the quorum failed'));
    }
    setBusy(false);
  }

  const overrideIds = Object.keys(draft.policyOverrides);
  const addable = policies.filter((p) => !overrideIds.includes(p.policyId) && p.state !== 'retired');

  return (
    <div className="space-y-4" data-testid="quorum-editor">
      <FixedRules />

      {EDITABLE_TIERS.map((tier) => (
        <Card key={tier}>
          <h2 className="text-sm font-semibold text-text-primary mb-3">{TIER_LABEL[tier]} tier</h2>
          <div className="space-y-4">
            {QUORUM_SCOPES.map((scope) => (
              tier === 'prohibited' && scope === 'bulk' ? (
                <FixedOff key={scope} label={SCOPE_LABEL.bulk} />
              ) : (
                <SlotEditor
                  key={scope}
                  label={SCOPE_LABEL[scope]}
                  idPrefix={`q-${tier}-${scope}`}
                  slot={draft.tiers[tier][scope]}
                  boards={activeBoards}
                  issues={issuesAt(`tiers.${tier}.${scope}`)}
                  onChange={(s) => update(['tiers', tier, scope], s)}
                />
              )
            ))}
          </div>
        </Card>
      ))}

      <Card>
        <h2 className="text-sm font-semibold text-text-primary mb-3">Policies, exceptions and timing</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <NumberField id="q-policy-approvals" label="Approvals to activate a policy version (1 to 5)" value={draft.policyApproval.approvals}
            onChange={(n) => update(['policyApproval', 'approvals'], n)} issues={issuesAt('policyApproval')}
            help="Only Policy Approvers who did not write or compile the version count. There is no setting for self-approval." />
          <NumberField id="q-lapse" label="Proposals lapse after (days, 1 to 90)" value={draft.proposalLapseDays}
            onChange={(n) => update(['proposalLapseDays'], n)} issues={issuesAt('proposalLapseDays')} />
          <NumberField id="q-standing-max" label="Standing exceptions: maximum expiry (days, 1 to 365)" value={draft.standingExceptions.maxExpiryDays}
            onChange={(n) => update(['standingExceptions', 'maxExpiryDays'], n)} issues={issuesAt('standingExceptions.maxExpiryDays')} />
          <NumberField id="q-standing-default" label="Standing exceptions: default expiry (days)" value={draft.standingExceptions.defaultExpiryDays}
            onChange={(n) => update(['standingExceptions', 'defaultExpiryDays'], n)} issues={issuesAt('standingExceptions.defaultExpiryDays')} />
          <label className="flex items-center gap-2 text-text-primary md:col-span-2">
            <input type="checkbox" checked={draft.standingExceptions.allowOrgWideRepoPatterns}
              onChange={(e) => update(['standingExceptions', 'allowOrgWideRepoPatterns'], e.target.checked)} />
            Allow standing exceptions with organization-wide repository patterns (such as <span className="font-mono text-xs">*/*</span>)
          </label>
          <NumberField id="q-grace-new" label="Grace period for a new policy (days, 0 to 365)" value={draft.gracePeriod.newPolicyDefaultDays}
            onChange={(n) => update(['gracePeriod', 'newPolicyDefaultDays'], n)} issues={issuesAt('gracePeriod.newPolicyDefaultDays')} min={0} />
          <NumberField id="q-grace-version" label="Grace period for a new version (days, 0 to 365)" value={draft.gracePeriod.newVersionDefaultDays}
            onChange={(n) => update(['gracePeriod', 'newVersionDefaultDays'], n)} issues={issuesAt('gracePeriod.newVersionDefaultDays')} min={0} />
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-text-primary mb-1">Per-policy overrides</h2>
        <p className="text-xs text-text-muted mb-3">An override replaces a whole scope for one policy; scopes you leave unticked follow the tier.</p>
        <div className="space-y-4">
          {overrideIds.map((policyId) => {
            const head = policies.find((p) => p.policyId === policyId);
            const prohibited = head?.tier === 'prohibited';
            const o = draft.policyOverrides[policyId] ?? {};
            return (
              <div key={policyId} className="border border-border rounded-lg p-3" data-testid="quorum-override">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="font-mono text-sm text-text-primary">{head?.policyKey ?? policyId}{head ? <span className="font-sans text-xs text-text-muted"> · {TIER_LABEL[head.tier]}</span> : null}</p>
                  <Button variant="ghost" size="sm" aria-label={`Remove the override for ${head?.policyKey ?? policyId}`}
                    onClick={() => setDraft((d) => removeAt(d, ['policyOverrides', policyId]))}><Trash2 size={12} /> Remove</Button>
                </div>
                <div className="space-y-3">
                  {QUORUM_SCOPES.map((scope) => {
                    if (scope === 'bulk' && prohibited) return <FixedOff key={scope} label={`${SCOPE_LABEL.bulk} (prohibited policy)`} />;
                    const has = o[scope] !== undefined;
                    return (
                      <div key={scope}>
                        <label className="flex items-center gap-2 text-sm text-text-primary">
                          <input type="checkbox" checked={has} onChange={(e) => setDraft((d) => e.target.checked
                            ? setAt(d, ['policyOverrides', policyId, scope], toggledSlot(true, head && head.tier !== 'advisory' ? d.tiers[head.tier][scope] : undefined))
                            : removeAt(d, ['policyOverrides', policyId, scope]))} />
                          Override: {SCOPE_LABEL[scope]}
                        </label>
                        {has && (
                          <div className="ml-6 mt-2">
                            <SlotEditor label="" idPrefix={`q-o-${policyId}-${scope}`} slot={o[scope] as ScopeSlot} boards={activeBoards}
                              issues={issuesAt(`policyOverrides.${policyId}.${scope}`)} onChange={(s) => update(['policyOverrides', policyId, scope], s)} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {overrideIds.length === 0 && <p className="text-xs text-text-muted">No overrides.</p>}
          {addable.length > 0 && (
            <div className="flex items-center gap-2">
              <select aria-label="Policy to override" value={addPolicy} onChange={(e) => setAddPolicy(e.target.value)} className="px-2 py-1 bg-surface border border-border rounded-lg text-sm text-text-primary">
                <option value="">Add an override for...</option>
                {addable.map((p) => <option key={p.policyId} value={p.policyId}>{p.policyKey} ({TIER_LABEL[p.tier]})</option>)}
              </select>
              <Button variant="secondary" size="sm" disabled={!addPolicy} onClick={() => { update(['policyOverrides', addPolicy], {}); setAddPolicy(''); }}>Add</Button>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-text-primary mb-2">Save as a new version</h2>
        {issues.length > 0 && (
          <div className="mb-3" role="alert" data-testid="quorum-issues">
            <p className="text-sm text-danger font-medium">Fix {issues.length === 1 ? 'this problem' : `these ${issues.length} problems`} before saving:</p>
            <ul className="list-disc pl-5 text-xs text-danger">
              {issues.map((i) => <li key={`${i.path}|${i.message}`}>{pathLabel(i.path, policyNames)}: {i.message}</li>)}
            </ul>
          </div>
        )}
        {changes.length === 0 ? (
          <p className="text-xs text-text-muted mb-3">No changes yet.</p>
        ) : (
          <div className="mb-3 overflow-x-auto">
            <p className="text-xs text-text-muted mb-1">What changes compared with version {current.version}</p>
            <table className="w-full text-xs" data-testid="quorum-changes">
              <tbody className="divide-y divide-border">
                {changes.map((c) => (
                  <tr key={c.field}>
                    <td className="py-1 pr-2 text-text-secondary">{c.field}</td>
                    <td className="py-1 pr-2 text-danger break-all">{c.before}</td>
                    <td className="py-1 text-success break-all">{c.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <label htmlFor="q-note" className="block text-xs text-text-muted mb-1">Change note * (recorded with the version)</label>
        <input id="q-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000}
          className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" placeholder="Why this change" />
        {error && <p className="text-sm text-danger mt-2" role="alert" data-testid="quorum-save-error">{error}</p>}
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || issues.length > 0 || changes.length === 0 || !note.trim()}>
            {busy ? 'Saving...' : `Save as version ${current.version + 1}`}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function FixedOff({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-text-secondary">
      <Lock size={14} className="text-text-muted" /> {label}: never allowed on the Prohibited tier (fixed, not configurable)
    </div>
  );
}

function IssueList({ issues }: { issues: QuorumIssue[] }) {
  if (issues.length === 0) return null;
  return <ul className="text-xs text-danger mt-1">{issues.map((i) => <li key={`${i.path}|${i.message}`}>{i.message}</li>)}</ul>;
}

/**
 * A whole-number input. It keeps what the admin typed, and reports an
 * out-of-range sentinel (-1) for anything that is not a whole number, so the
 * schema flags it; the input itself never shows NaN.
 */
function NumberField({ id, label, value, onChange, issues, help, min = 1 }: {
  id: string; label: string; value: number; onChange: (n: number) => void; issues: QuorumIssue[]; help?: string; min?: number;
}) {
  const [text, setText] = useState(String(value));
  const valid = /^\d+$/.test(text);
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-text-muted mb-1">{label}</label>
      <input id={id} type="number" min={min} value={text} className={numCls}
        onChange={(e) => { setText(e.target.value); onChange(/^\d+$/.test(e.target.value) ? Number(e.target.value) : -1); }} />
      {!valid && <p className="text-xs text-danger mt-1">Enter a whole number.</p>}
      {valid && <IssueList issues={issues} />}
      {help && <p className="text-xs text-text-muted mt-1">{help}</p>}
    </div>
  );
}

function SlotEditor({ label, idPrefix, slot, boards, issues, onChange }: {
  label: string;
  idPrefix: string;
  slot: ScopeSlot;
  boards: Board[];
  issues: QuorumIssue[];
  onChange: (s: ScopeSlot) => void;
}) {
  const fieldIssues = (f: string) => issues.filter((i) => i.path.endsWith(`.${f}`));
  const otherIssues = issues.filter((i) => !['approvals', 'maxExpiryDays', 'defaultExpiryDays', 'extraBoardIds'].some((f) => i.path.endsWith(`.${f}`) || i.path.includes(`.${f}.`)));
  return (
    <div data-testid={idPrefix}>
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" checked={slot.allowed} onChange={(e) => onChange(toggledSlot(e.target.checked, slot))} />
        {label ? `${label}: allowed` : 'Allowed'}
      </label>
      {slot.allowed && (
        <div className="ml-6 mt-2 grid grid-cols-1 md:grid-cols-3 gap-3">
          <NumberField id={`${idPrefix}-approvals`} label="Approvals (1 to 10)" value={slot.approvals}
            onChange={(n) => onChange({ ...slot, approvals: n })} issues={fieldIssues('approvals')} />
          <NumberField id={`${idPrefix}-max`} label="Maximum expiry (days)" value={slot.maxExpiryDays}
            onChange={(n) => onChange({ ...slot, maxExpiryDays: n })} issues={fieldIssues('maxExpiryDays')} />
          <NumberField id={`${idPrefix}-default`} label="Default expiry (days)" value={slot.defaultExpiryDays}
            onChange={(n) => onChange({ ...slot, defaultExpiryDays: n })} issues={fieldIssues('defaultExpiryDays')} />
          <div>
            <label htmlFor={`${idPrefix}-coverage`} className="block text-xs text-text-muted mb-1">Board coverage</label>
            <select id={`${idPrefix}-coverage`} value={slot.boardCoverage} className="px-2 py-1 bg-surface border border-border rounded-lg text-sm text-text-primary"
              onChange={(e) => onChange({ ...slot, boardCoverage: e.target.value as 'all_owning' | 'any_owning' })}>
              <option value="any_owning">A member of any owning board</option>
              <option value="all_owning">A member of each owning board</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${idPrefix}-perm`} className="block text-xs text-text-muted mb-1">Required permission</label>
            <select id={`${idPrefix}-perm`} value={slot.requiredPermission ?? ''} className="px-2 py-1 bg-surface border border-border rounded-lg text-sm text-text-primary"
              onChange={(e) => onChange({ ...slot, requiredPermission: e.target.value === 'exception.approve' ? 'exception.approve' : null })}>
              <option value="">None</option>
              <option value="exception.approve">One approver holds exception.approve</option>
            </select>
          </div>
          <fieldset>
            <legend className="block text-xs text-text-muted mb-1">Extra required boards</legend>
            {boards.length === 0 ? <p className="text-xs text-text-muted">No active boards.</p> : boards.map((b) => (
              <label key={b.id} className="flex items-center gap-2 text-xs text-text-primary">
                <input type="checkbox" checked={slot.extraBoardIds.includes(b.id)}
                  onChange={(e) => onChange({ ...slot, extraBoardIds: e.target.checked ? [...slot.extraBoardIds, b.id] : slot.extraBoardIds.filter((x) => x !== b.id) })} />
                {b.name}
              </label>
            ))}
            <IssueList issues={issues.filter((i) => i.path.includes('.extraBoardIds'))} />
          </fieldset>
          {otherIssues.length > 0 && <div className="md:col-span-3"><IssueList issues={otherIssues} /></div>}
        </div>
      )}
      {!slot.allowed && otherIssues.length > 0 && <IssueList issues={otherIssues} />}
    </div>
  );
}
