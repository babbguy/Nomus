import { useMemo, useState } from 'react';
import { UserPlus, X, Copy, Check, Plus } from 'lucide-react';
import Card from '../../../components/ui/Card';
import Badge from '../../../components/ui/Badge';
import Button from '../../../components/ui/Button';
import Modal from '../../../components/ui/Modal';
import EmptyState from '../../../components/ui/EmptyState';
import {
  createGrant, inviteOrgUser, revokeGrant, updateOrgUser,
  type Grant, type InviteResult, type OrgUser, type Role, type ScopeType,
} from '../../../api/cpg';
import { cpgErrorMessage } from '../../../lib/cpg-errors';
import { describeScope, isCanonicalRepo } from '../../../lib/cpg-permissions';
import { formatDateTime } from '../../../lib/formatters';
import { inputCls, orgOnlyPermissions, type AccessData } from './helpers';

/** Users tab: org users with their active grants; invite, grant, revoke, deactivate (rbac.users.manage). */
export default function UsersPanel({ data, meUserId, canManage, onChanged }: {
  data: AccessData;
  meUserId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [inviting, setInviting] = useState(false);
  const [granting, setGranting] = useState<OrgUser | null>(null);
  const [revoking, setRevoking] = useState<{ user: OrgUser; grant: Grant } | null>(null);
  const [deactivating, setDeactivating] = useState<OrgUser | null>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const teamsById = useMemo(() => new Map(data.teams.map((t) => [t.id, t])), [data.teams]);
  const active = data.users.filter((u) => u.isActive).length;

  async function reactivate(u: OrgUser) {
    setNotice(null);
    try {
      await updateOrgUser(u.id, { isActive: true });
      setNotice({ type: 'ok', text: `${u.email} reactivated.` });
      onChanged();
    } catch (err) {
      setNotice({ type: 'err', text: cpgErrorMessage(err, 'Failed to reactivate the user') });
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <p className="text-sm text-text-muted">
          {data.users.length} user{data.users.length === 1 ? '' : 's'}, {active} active. Every member holds Developer; grant more roles here.
        </p>
        {canManage && <Button size="sm" onClick={() => setInviting(true)}><UserPlus size={14} /> Invite user</Button>}
      </div>

      {notice && (
        <p className={`text-xs mb-3 ${notice.type === 'ok' ? 'text-success' : 'text-danger'}`} role={notice.type === 'err' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}

      <UsersTable
        users={data.users}
        meUserId={meUserId}
        canManage={canManage}
        teamsById={teamsById}
        onGrant={(u) => setGranting(u)}
        onRevoke={(user, grant) => setRevoking({ user, grant })}
        onDeactivate={(u) => setDeactivating(u)}
        onReactivate={(u) => void reactivate(u)}
      />

      {inviting && (
        <InviteModal roles={data.roles} onClose={() => setInviting(false)} onInvited={(r) => { setNotice({ type: 'ok', text: `${r.user.email} invited.` }); onChanged(); }} />
      )}
      {granting && (
        <GrantModal
          user={granting}
          data={data}
          onClose={() => setGranting(null)}
          onGranted={(g) => { setGranting(null); setNotice({ type: 'ok', text: `Granted ${g.roleName} (${describeScope(g, teamsById)}) to ${granting.email}.` }); onChanged(); }}
        />
      )}
      {revoking && (
        <RevokeModal
          target={revoking}
          scopeLabel={describeScope(revoking.grant, teamsById)}
          onClose={() => setRevoking(null)}
          onRevoked={() => { setNotice({ type: 'ok', text: `Revoked ${revoking.grant.roleName} from ${revoking.user.email}.` }); setRevoking(null); onChanged(); }}
        />
      )}
      {deactivating && (
        <DeactivateModal
          user={deactivating}
          onClose={() => setDeactivating(null)}
          onDone={() => { setNotice({ type: 'ok', text: `${deactivating.email} deactivated.` }); setDeactivating(null); onChanged(); }}
        />
      )}
    </div>
  );
}

export function UsersTable({ users, meUserId, canManage, teamsById, onGrant, onRevoke, onDeactivate, onReactivate }: {
  users: OrgUser[];
  meUserId: string;
  canManage: boolean;
  teamsById: ReadonlyMap<string, { name: string; key: string }>;
  onGrant: (u: OrgUser) => void;
  onRevoke: (u: OrgUser, g: Grant) => void;
  onDeactivate: (u: OrgUser) => void;
  onReactivate: (u: OrgUser) => void;
}) {
  if (users.length === 0) {
    return <EmptyState title="No users in this organization" description={canManage ? 'Invite the first user above.' : undefined} />;
  }
  return (
    <Card className="p-0 overflow-x-auto">
      <table className="w-full text-sm" data-testid="access-users">
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th className="px-4 py-3 font-medium">User</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Roles</th>
            {canManage && <th className="px-4 py-3 font-medium text-right">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {users.map((u) => (
            <tr key={u.id} className="align-top">
              <td className="px-4 py-3">
                <p className="text-text-primary font-medium">
                  {u.name || u.email}
                  {u.id === meUserId && <span className="ml-2 text-xs text-text-muted">(you)</span>}
                </p>
                <p className="text-xs text-text-muted whitespace-nowrap">{u.email}</p>
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-col items-start gap-1">
                  <Badge variant={u.isActive ? 'success' : 'warning'}>{u.isActive ? 'Active' : 'Inactive'}</Badge>
                  {u.mustChangePassword && <Badge variant="info" className="whitespace-nowrap">Temporary password</Badge>}
                </div>
              </td>
              <td className="px-4 py-3">
                {u.grants.length === 0 ? (
                  <span className="text-xs text-text-muted">No roles</span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {u.grants.map((g) => (
                      <span
                        key={g.id}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-hover text-xs text-text-secondary"
                        title={`Granted ${formatDateTime(g.grantedAt)}`}
                      >
                        <span className="text-text-primary">{g.roleName}</span>
                        {g.scopeType !== 'org' && <span className="text-text-muted">· {describeScope(g, teamsById)}</span>}
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => onRevoke(u, g)}
                            className="text-text-muted hover:text-danger transition"
                            aria-label={`Revoke ${g.roleName} from ${u.email}`}
                          >
                            <X size={12} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </td>
              {canManage && (
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1 flex-wrap">
                    {u.isActive && <Button variant="secondary" size="sm" onClick={() => onGrant(u)}><Plus size={12} /> Grant role</Button>}
                    {u.isActive && u.id !== meUserId && <Button variant="ghost" size="sm" onClick={() => onDeactivate(u)}>Deactivate</Button>}
                    {!u.isActive && <Button variant="ghost" size="sm" onClick={() => onReactivate(u)}>Reactivate</Button>}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function FormError({ text }: { text: string | null }) {
  return text ? <p className="text-sm text-danger" role="alert">{text}</p> : null;
}

function InviteModal({ roles, onClose, onInvited }: { roles: Role[]; onClose: () => void; onInvited: (r: InviteResult) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roleKeys, setRoleKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);
  const offered = roles.filter((r) => !r.archivedAt && r.key !== 'developer');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await inviteOrgUser({ email: email.trim(), name: name.trim(), ...(roleKeys.length ? { roleKeys } : {}) });
      setResult(r);
      onInvited(r);
    } catch (err) {
      setError(cpgErrorMessage(err, 'Failed to invite the user'));
    }
    setBusy(false);
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.tempPassword);
      setCopied(true);
    } catch {
      setError('Could not copy automatically. Select the password and copy it manually.');
    }
  }

  return (
    <Modal open onClose={onClose} title={result ? 'User invited' : 'Invite user'}>
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            {result.user.email} can sign in with this temporary password and must change it at first sign-in. If email
            delivery is configured, it was also emailed. It is shown only once.
          </p>
          <div className="flex items-center gap-2 p-3 bg-accent-dim border border-accent-border rounded-lg">
            <p className="font-mono text-sm text-text-primary break-all select-all flex-1" data-testid="invite-temp-password">{result.tempPassword}</p>
            <Button variant="secondary" size="sm" onClick={() => void copy()} aria-label="Copy temporary password">
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <FormError text={error} />
          <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <div>
            <label htmlFor="invite-email" className="block text-xs text-text-muted mb-1">Email *</label>
            <input id="invite-email" type="email" required maxLength={320} value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="name@example.com" />
          </div>
          <div>
            <label htmlFor="invite-name" className="block text-xs text-text-muted mb-1">Name *</label>
            <input id="invite-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </div>
          <fieldset>
            <legend className="block text-xs text-text-muted mb-1">Roles (org-wide; Developer is always granted)</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {offered.map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={roleKeys.includes(r.key)}
                    onChange={() => setRoleKeys((prev) => (prev.includes(r.key) ? prev.filter((k) => k !== r.key) : [...prev, r.key]))}
                  />
                  {r.name}
                </label>
              ))}
            </div>
          </fieldset>
          <FormError text={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !email.trim() || !name.trim()}>{busy ? 'Inviting...' : 'Invite'}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function GrantModal({ user, data, onClose, onGranted }: { user: OrgUser; data: AccessData; onClose: () => void; onGranted: (g: Grant) => void }) {
  const roles = data.roles.filter((r) => !r.archivedAt);
  const teams = data.teams.filter((t) => !t.archivedAt);
  const [roleId, setRoleId] = useState('');
  const [scopeType, setScopeType] = useState<ScopeType>('org');
  const [teamId, setTeamId] = useState('');
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const role = roles.find((r) => r.id === roleId);
  const orgOnly = scopeType === 'org' ? [] : orgOnlyPermissions(role, data);
  const repoValue = repo.trim();
  const repoInvalid = scopeType === 'repo' && repoValue !== '' && !isCanonicalRepo(repoValue);
  const ready = !!role && orgOnly.length === 0
    && (scopeType === 'org' || (scopeType === 'team' && !!teamId) || (scopeType === 'repo' && repoValue !== '' && !repoInvalid));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const g = await createGrant(user.id, {
        roleId,
        scopeType,
        ...(scopeType === 'team' ? { scopeId: teamId } : scopeType === 'repo' ? { scopeId: repoValue } : {}),
      });
      onGranted(g);
    } catch (err) {
      setError(cpgErrorMessage(err, 'Failed to grant the role'));
    }
    setBusy(false);
  }

  return (
    <Modal open onClose={onClose} title={`Grant a role to ${user.email}`}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <div>
          <label htmlFor="grant-role" className="block text-xs text-text-muted mb-1">Role *</label>
          <select id="grant-role" value={roleId} onChange={(e) => setRoleId(e.target.value)} className={inputCls} required>
            <option value="">Select a role...</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {role?.description && <p className="text-xs text-text-muted mt-1">{role.description}</p>}
        </div>
        <fieldset>
          <legend className="block text-xs text-text-muted mb-1">Scope</legend>
          <div className="flex gap-4">
            {(['org', 'team', 'repo'] as const).map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm text-text-secondary">
                <input type="radio" name="grant-scope" checked={scopeType === s} onChange={() => setScopeType(s)} />
                {s === 'org' ? 'Whole organization' : s === 'team' ? 'One team' : 'One repository'}
              </label>
            ))}
          </div>
        </fieldset>
        {scopeType === 'team' && (
          teams.length === 0 ? (
            <p className="text-xs text-text-muted">No active teams. Create one on the Teams tab first.</p>
          ) : (
            <div>
              <label htmlFor="grant-team" className="block text-xs text-text-muted mb-1">Team *</label>
              <select id="grant-team" value={teamId} onChange={(e) => setTeamId(e.target.value)} className={inputCls}>
                <option value="">Select a team...</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.repoPatterns.join(', ') || 'no repositories'})</option>)}
              </select>
            </div>
          )
        )}
        {scopeType === 'repo' && (
          <div>
            <label htmlFor="grant-repo" className="block text-xs text-text-muted mb-1">Repository *</label>
            <input id="grant-repo" value={repo} onChange={(e) => setRepo(e.target.value)} className={inputCls} placeholder="owner/name" maxLength={200} />
            {repoInvalid && <p className="text-xs text-danger mt-1">Use the lowercase repository id, such as owner/name.</p>}
          </div>
        )}
        {orgOnly.length > 0 && (
          <p className="text-xs text-warning" role="status">
            {role?.name} includes org-only permissions ({orgOnly.join(', ')}), so it can only be granted to the whole organization.
          </p>
        )}
        <FormError text={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !ready}>{busy ? 'Granting...' : 'Grant role'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function RevokeModal({ target, scopeLabel, onClose, onRevoked }: {
  target: { user: OrgUser; grant: Grant };
  scopeLabel: string;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await revokeGrant(target.grant.id, reason.trim());
      onRevoked();
    } catch (err) {
      setError(cpgErrorMessage(err, 'Failed to revoke the grant'));
    }
    setBusy(false);
  }

  return (
    <Modal open onClose={onClose} title="Revoke role" width="max-w-md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <p className="text-sm text-text-secondary">
          Revoke <strong>{target.grant.roleName}</strong> ({scopeLabel}) from {target.user.email}. It takes effect on their next
          request. A revocation cannot be undone; grant the role again instead.
        </p>
        <div>
          <label htmlFor="revoke-reason" className="block text-xs text-text-muted mb-1">Reason * (recorded in the audit log)</label>
          <textarea id="revoke-reason" required maxLength={500} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
        </div>
        <FormError text={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>{busy ? 'Revoking...' : 'Revoke'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function DeactivateModal({ user, onClose, onDone }: { user: OrgUser; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await updateOrgUser(user.id, { isActive: false });
      onDone();
    } catch (err) {
      setError(cpgErrorMessage(err, 'Failed to deactivate the user'));
    }
    setBusy(false);
  }

  return (
    <Modal open onClose={onClose} title="Deactivate user" width="max-w-md">
      <p className="text-sm text-text-secondary mb-4">
        {user.email} will no longer be able to sign in, and their VS Code key stops working. Their grants are kept and apply
        again if you reactivate them.
      </p>
      <FormError text={error} />
      <div className="flex justify-end gap-2 mt-3">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={() => void confirm()} disabled={busy}>{busy ? 'Deactivating...' : 'Deactivate'}</Button>
      </div>
    </Modal>
  );
}
