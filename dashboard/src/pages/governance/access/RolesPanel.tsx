import { useState } from 'react';
import { Plus, Lock } from 'lucide-react';
import Card from '../../../components/ui/Card';
import Badge from '../../../components/ui/Badge';
import Button from '../../../components/ui/Button';
import Modal from '../../../components/ui/Modal';
import EmptyState from '../../../components/ui/EmptyState';
import { archiveRole, createRole, updateRole, type Permission, type PermissionCategory, type Role } from '../../../api/cpg';
import { cpgErrorMessage } from '../../../lib/cpg-errors';
import { formatDate } from '../../../lib/formatters';
import { inputCls, ORG_ADMIN_LOCKED, permissionGroups, rolePatch, type AccessData } from './helpers';
import { NoticeLine, type Notice } from '../parts';

const CATEGORY_LABELS: Record<PermissionCategory, string> = {
  org: 'Organization',
  rbac: 'Access control',
  policy: 'Policies',
  case: 'Review cases',
  exception: 'Exceptions',
  audit: 'Audit',
  integration: 'Integrations',
  ci: 'CI',
};

/** Roles tab: the permission matrix of every active role; create, edit and archive (rbac.roles.manage). */
export default function RolesPanel({ data, canManage, onChanged }: { data: AccessData; canManage: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [archiving, setArchiving] = useState<Role | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <p className="text-sm text-text-muted max-w-3xl">
          A role is a set of permissions. The seven system roles exist in every organization; Org Admin never approves
          anything by itself. {canManage ? 'You can edit any role and add custom ones.' : 'Only an Org Admin can change roles.'}
        </p>
        {canManage && <Button size="sm" onClick={() => setEditing('new')}><Plus size={14} /> New role</Button>}
      </div>
      <NoticeLine notice={notice} className="text-xs mb-3" />

      <RoleMatrix roles={data.roles} permissions={data.permissions} canManage={canManage} onEdit={(r) => setEditing(r)} onArchive={(r) => setArchiving(r)} />

      {editing && (
        <RoleEditor
          role={editing === 'new' ? null : editing}
          permissions={data.permissions}
          onClose={() => setEditing(null)}
          onSaved={(r, created) => { setEditing(null); setNotice({ type: 'ok', text: created ? `Role ${r.name} created.` : `Role ${r.name} saved.` }); onChanged(); }}
        />
      )}
      {archiving && (
        <ArchiveRoleModal
          role={archiving}
          onClose={() => setArchiving(null)}
          onDone={() => { setNotice({ type: 'ok', text: `Role ${archiving.name} archived.` }); setArchiving(null); onChanged(); }}
        />
      )}
    </div>
  );
}

export function RoleMatrix({ roles, permissions, canManage, onEdit, onArchive }: {
  roles: Role[];
  permissions: Permission[];
  canManage: boolean;
  onEdit: (r: Role) => void;
  onArchive: (r: Role) => void;
}) {
  const active = roles.filter((r) => !r.archivedAt);
  const archived = roles.filter((r) => r.archivedAt);
  if (active.length === 0) return <EmptyState title="No roles" description="System roles are created automatically; reload the page." />;

  return (
    <>
      <Card className="p-0 overflow-x-auto">
        <table className="w-full text-sm" data-testid="role-matrix">
          <thead>
            <tr className="border-b border-border text-left text-text-muted align-bottom">
              <th className="px-4 py-3 font-medium min-w-[240px]">Permission</th>
              {active.map((r) => (
                <th key={r.id} className="px-3 py-3 font-medium text-center min-w-[110px]">
                  <span className="block text-text-primary">{r.name}</span>
                  <span className="block mt-1"><Badge variant={r.isSystem ? 'default' : 'accent'}>{r.isSystem ? 'System' : 'Custom'}</Badge></span>
                  {canManage && (
                    <span className="flex justify-center gap-1 mt-1">
                      <button type="button" className="text-xs text-accent hover:underline" onClick={() => onEdit(r)} aria-label={`Edit role ${r.name}`}>Edit</button>
                      {!r.isSystem && (
                        <button type="button" className="text-xs text-text-muted hover:text-danger" onClick={() => onArchive(r)} aria-label={`Archive role ${r.name}`}>Archive</button>
                      )}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {permissionGroups(permissions).map(([category, perms]) => (
              <PermissionGroupRows key={category} label={CATEGORY_LABELS[category]} perms={perms} roles={active} />
            ))}
          </tbody>
        </table>
      </Card>

      {archived.length > 0 && (
        <Card className="mt-4">
          <h3 className="text-sm font-semibold text-text-secondary mb-2">Archived roles</h3>
          <div className="divide-y divide-border">
            {archived.map((r) => (
              <div key={r.id} className="flex items-center justify-between py-2 text-sm gap-4">
                <span className="text-text-primary">{r.name} <span className="font-mono text-xs text-text-muted">{r.key}</span></span>
                <span className="text-xs text-text-muted">Archived {formatDate(r.archivedAt)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

function PermissionGroupRows({ label, perms, roles }: { label: string; perms: Permission[]; roles: Role[] }) {
  return (
    <>
      <tr className="bg-surface-raised/40">
        <td colSpan={roles.length + 1} className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</td>
      </tr>
      {perms.map((p) => (
        <tr key={p.key} className="border-t border-border hover:bg-surface-hover transition">
          <td className="px-4 py-2" title={p.description}>
            <span className="font-mono text-xs text-text-primary">{p.key}</span>
            {!p.scopable && <span className="ml-2 text-[10px] text-text-muted">org only</span>}
          </td>
          {roles.map((r) => {
            const has = r.permissions.includes(p.key);
            return (
              <td key={r.id} className="px-3 py-2 text-center" aria-label={`${r.name} ${has ? 'has' : 'does not have'} ${p.key}`}>
                {has ? <span className="text-accent">●</span> : <span className="text-text-muted opacity-40">·</span>}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

function RoleEditor({ role, permissions, onClose, onSaved }: {
  role: Role | null;
  permissions: Permission[];
  onClose: () => void;
  onSaved: (r: Role, created: boolean) => void;
}) {
  const [key, setKey] = useState('');
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<string[]>(role?.permissions ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = role?.isSystem && role.key === 'org_admin' ? ORG_ADMIN_LOCKED : [];
  const keyValid = /^[a-z][a-z0-9_]{0,49}$/.test(key);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!role) {
        const r = await createRole({ key, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), permissions: selected });
        onSaved(r, true);
      } else {
        const patch = rolePatch(role, { name, description, permissions: selected });
        if (!patch) { setError('Nothing changed.'); setBusy(false); return; }
        onSaved(await updateRole(role.id, patch), false);
      }
    } catch (err) {
      setError(cpgErrorMessage(err, 'Failed to save the role'));
    }
    setBusy(false);
  }

  const toggle = (k: string) => setSelected((prev) => (prev.includes(k) ? prev.filter((p) => p !== k) : [...prev, k]));

  return (
    <Modal open onClose={onClose} title={role ? `Edit role: ${role.name}` : 'New role'} width="max-w-2xl">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {!role && (
          <div>
            <label htmlFor="role-key" className="block text-xs text-text-muted mb-1">Key * (lowercase letters, digits and _, cannot be changed later)</label>
            <input id="role-key" required value={key} onChange={(e) => setKey(e.target.value)} className={`${inputCls} font-mono`} placeholder="release_manager" maxLength={50} />
            {key !== '' && !keyValid && <p className="text-xs text-danger mt-1">Start with a letter; use only lowercase letters, digits and _.</p>}
          </div>
        )}
        {role?.isSystem && (
          <p className="text-xs text-text-muted">System role <span className="font-mono">{role.key}</span>. Changes apply to everyone who holds it and are recorded in the audit log.</p>
        )}
        <div>
          <label htmlFor="role-name" className="block text-xs text-text-muted mb-1">Name *</label>
          <input id="role-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label htmlFor="role-description" className="block text-xs text-text-muted mb-1">Description</label>
          <textarea id="role-description" maxLength={500} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} />
        </div>
        <fieldset>
          <legend className="block text-xs text-text-muted mb-1">Permissions ({selected.length} selected)</legend>
          <div className="max-h-80 overflow-y-auto border border-border rounded-lg p-3 space-y-3">
            {permissionGroups(permissions).map(([category, perms]) => (
              <div key={category}>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1">{CATEGORY_LABELS[category]}</p>
                {perms.map((p) => {
                  const isLocked = locked.includes(p.key);
                  return (
                    <label key={p.key} className="flex items-start gap-2 text-sm text-text-secondary py-0.5">
                      <input type="checkbox" className="mt-1" checked={selected.includes(p.key)} disabled={isLocked} onChange={() => toggle(p.key)} />
                      <span>
                        <span className="font-mono text-xs text-text-primary">{p.key}</span>
                        {isLocked && <Lock size={11} className="inline ml-1 text-text-muted" aria-label="required" />}
                        {!p.scopable && <span className="ml-2 text-[10px] text-text-muted">org only</span>}
                        <span className="block text-xs text-text-muted">{p.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
          {locked.length > 0 && <p className="text-xs text-text-muted mt-1">Org Admin always keeps {locked.join(' and ')}, so the organization can never lock itself out.</p>}
        </fieldset>
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim() || (!role && !keyValid)}>{busy ? 'Saving...' : role ? 'Save role' : 'Create role'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ArchiveRoleModal({ role, onClose, onDone }: { role: Role; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await archiveRole(role.id);
      onDone();
    } catch (err) {
      setError(cpgErrorMessage(err, 'Failed to archive the role'));
    }
    setBusy(false);
  }
  return (
    <Modal open onClose={onClose} title="Archive role" width="max-w-md">
      <p className="text-sm text-text-secondary mb-3">
        Archiving <strong>{role.name}</strong> removes its permissions from everyone who holds it, on their next request. It can no
        longer be granted or edited. This cannot be undone.
      </p>
      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={() => void confirm()} disabled={busy}>{busy ? 'Archiving...' : 'Archive role'}</Button>
      </div>
    </Modal>
  );
}
