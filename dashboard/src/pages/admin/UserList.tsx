import { useEffect, useState } from 'react';
import { Plus, UserCheck, UserX, Key, Pencil, X, Mail } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import { formatRelative } from '../../lib/formatters';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface OrgOption {
  id: string;
  name: string;
  slug: string;
}

interface UserInfo {
  id: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  email: string;
  name: string;
  role: string;
  authProvider: string;
  mustChangePassword: boolean;
  isActive: boolean;
  createdAt: string;
}

export default function UserList() {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [filterOrg, setFilterOrg] = useState('');
  const [form, setForm] = useState({ email: '', name: '', role: 'member', orgId: '', password: '' });
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ tempPassword?: string; message?: string; error?: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [orgsError, setOrgsError] = useState<string | null>(null);

  // Edit modal
  const [editing, setEditing] = useState<UserInfo | null>(null);
  const [editForm, setEditForm] = useState({ name: '', role: '', orgId: '', isActive: true });
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete confirmation
  const [deleting, setDeleting] = useState<UserInfo | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const params: Record<string, string> = {};
      if (filterOrg) params.orgId = filterOrg;
      const { data } = await api.get('/users', { params });
      setUsers(data.users);
    } catch (err) {
      setLoadError(apiErrorMessage(err, 'Failed to load users'));
    }
    setLoading(false);
  }

  function fetchOrgs() {
    api.get('/tenants', { params: { limit: 500 } })
      .then(({ data }) => setOrgs(data.tenants.map((t: OrgOption) => ({ id: t.id, name: t.name, slug: t.slug }))))
      .catch((err) => setOrgsError(apiErrorMessage(err, 'Failed to load organizations')));
  }

  function loadOrgs() {
    setOrgsError(null);
    fetchOrgs();
  }

  useEffect(() => {
    fetchOrgs();
  }, []);

  // Clear a prior user-list error during render when the org filter changes, so
  // the effect below sets no state synchronously.
  const [loadedFilter, setLoadedFilter] = useState(filterOrg);
  if (loadedFilter !== filterOrg) {
    setLoadedFilter(filterOrg);
    setLoadError(null);
  }

  useEffect(() => {
    const params: Record<string, string> = {};
    if (filterOrg) params.orgId = filterOrg;
    api.get('/users', { params })
      .then(({ data }) => setUsers(data.users))
      .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load users')))
      .finally(() => setLoading(false));
  }, [filterOrg]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.orgId) { setResult({ error: 'Please select an organization' }); return; }
    setCreating(true);
    setResult(null);
    try {
      const { data } = await api.post('/users', {
        email: form.email,
        name: form.name,
        role: form.role,
        orgId: form.orgId,
        password: form.password || undefined,
      });
      setResult({ tempPassword: data.tempPassword, message: data.message });
      setForm({ email: '', name: '', role: 'member', orgId: form.orgId, password: '' });
      load();
    } catch (err) {
      setResult({ error: apiErrorMessage(err, 'Failed to create user') });
    }
    setCreating(false);
  }

  async function handleEdit() {
    if (!editing) return;
    setSaving(true);
    setEditError(null);
    try {
      await api.patch(`/users/${editing.id}`, {
        name: editForm.name,
        role: editForm.role,
        orgId: editForm.orgId,
        isActive: editForm.isActive,
      });
      setEditing(null);
      load();
    } catch (err) {
      // Keep the modal open so the input isn't lost
      setEditError(apiErrorMessage(err, 'Failed to save user'));
    }
    setSaving(false);
  }

  async function handleDelete() {
    if (!deleting) return;
    setDeleteError(null);
    try {
      await api.delete(`/users/${deleting.id}`);
      setDeleting(null);
      load();
    } catch (err) {
      // Keep the confirmation open with the error shown
      setDeleteError(apiErrorMessage(err, 'Failed to deactivate user'));
    }
  }

  async function resetPassword(userId: string) {
    try {
      const { data } = await api.post(`/users/${userId}/reset-password`, {});
      setResult({ tempPassword: data.newPassword, message: data.message });
    } catch (err) {
      setResult({ error: apiErrorMessage(err, 'Failed to reset password') });
    }
  }

  async function reactivate(userId: string) {
    try {
      await api.patch(`/users/${userId}`, { isActive: true });
      load();
    } catch (err) {
      setResult({ error: apiErrorMessage(err, 'Failed to reactivate user') });
    }
  }

  function openEdit(u: UserInfo) {
    setEditForm({ name: u.name, role: u.role, orgId: u.orgId, isActive: u.isActive });
    setEditError(null);
    setEditing(u);
  }

  if (loading && users.length === 0) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">User Management</h1>
        <div className="flex items-center gap-3">
          {/* Org Filter */}
          <select value={filterOrg} onChange={(e) => setFilterOrg(e.target.value)}
            className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary">
            <option value="">All Organizations</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <Button onClick={() => setShowCreate(!showCreate)}>
            <Plus size={14} /> Invite User
          </Button>
        </div>
      </div>

      {/* Load failure: organizations (filter + invite form depend on it) */}
      {orgsError && (
        <Card className="mb-4 border-danger/30">
          <ErrorState compact message={orgsError} onRetry={loadOrgs} />
        </Card>
      )}

      {/* Result Banner */}
      {result && (
        <Card className={`mb-4 ${result.error ? 'border-danger/30' : 'border-accent-border'}`}>
          {result.error ? (
            <p className="text-sm text-danger">{result.error}</p>
          ) : (
            <div>
              <p className="text-sm text-accent mb-1">{result.message}</p>
              {result.tempPassword && (
                <div className="p-2 bg-surface rounded-lg mt-2">
                  <p className="text-xs text-text-muted mb-1">Temporary Password:</p>
                  <p className="font-mono text-sm text-text-primary select-all">{result.tempPassword}</p>
                </div>
              )}
            </div>
          )}
          <Button variant="ghost" onClick={() => setResult(null)} className="text-xs mt-2">Dismiss</Button>
        </Card>
      )}

      {/* Create Form */}
      {showCreate && (
        <Card className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-secondary">Invite New User</h3>
            <button onClick={() => setShowCreate(false)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
          </div>
          <form onSubmit={handleCreate} className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">Organization *</label>
              <select value={form.orgId} onChange={(e) => setForm({ ...form, orgId: e.target.value })} required
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary">
                <option value="">Select organization...</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Email *</label>
              <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required type="email"
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" placeholder="user@company.com" />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Name *</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" placeholder="John Doe" />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Role</label>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary">
                <option value="member">Member</option>
                <option value="platform_admin">Platform Admin</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-text-muted mb-1">Password (optional — auto-generated if blank)</label>
              <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} type="password"
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" placeholder="Leave blank to auto-generate" />
            </div>
            <div className="col-span-2 flex items-center gap-2">
              <Button type="submit" disabled={creating}>{creating ? 'Creating...' : 'Create & Send Invitation'}</Button>
              <p className="text-xs text-text-muted flex items-center gap-1"><Mail size={12} /> Invitation email sent automatically</p>
            </div>
          </form>
        </Card>
      )}

      {/* Edit Modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-text-primary">Edit User: {editing.email}</h3>
              <button onClick={() => setEditing(null)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-text-muted mb-1">Name</label>
                <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Organization</label>
                <select value={editForm.orgId} onChange={(e) => setEditForm({ ...editForm, orgId: e.target.value })}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary">
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Role</label>
                <select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary">
                  <option value="member">Member</option>
                  <option value="platform_admin">Platform Admin</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="edit-active" checked={editForm.isActive} onChange={(e) => setEditForm({ ...editForm, isActive: e.target.checked })}
                  className="rounded border-border" />
                <label htmlFor="edit-active" className="text-sm text-text-secondary">Active</label>
              </div>
              {editError && <p className="text-sm text-danger" role="alert">{editError}</p>}
              <div className="flex items-center gap-2 pt-2">
                <Button onClick={handleEdit} disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</Button>
                <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleting && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-sm">
            <h3 className="text-sm font-semibold text-text-primary mb-2">Deactivate User</h3>
            <p className="text-sm text-text-secondary mb-4">
              Are you sure you want to deactivate <strong>{deleting.name}</strong> ({deleting.email})?
              They will no longer be able to sign in.
            </p>
            {deleteError && <p className="text-sm text-danger mb-3" role="alert">{deleteError}</p>}
            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={handleDelete} className="bg-danger hover:bg-danger/80">Deactivate</Button>
              <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
            </div>
          </Card>
        </div>
      )}

      {/* User List */}
      {loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : users.length === 0 ? (
        <EmptyState title="No users" description="Invite your first team member." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-text-muted">
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Organization</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Auth</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-surface-hover transition">
                  <td className="px-4 py-3">
                    <p className="text-text-primary font-medium">{u.name}</p>
                    <p className="text-xs text-text-muted">{u.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-text-secondary text-xs">{u.orgName}</p>
                    <p className="text-[10px] text-text-muted font-mono">{u.orgSlug}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={u.role === 'platform_admin' ? 'accent' : 'default'}>
                      {u.role === 'platform_admin' ? 'Admin' : 'Member'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-text-secondary text-xs capitalize">{u.authProvider}</span>
                    {u.mustChangePassword && (
                      <Badge variant="info" className="ml-1 text-[9px]">Pending</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={u.isActive ? 'success' : 'danger'}>
                      {u.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-text-muted text-xs">{formatRelative(u.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <button onClick={() => openEdit(u)} title="Edit user"
                        className="p-1.5 rounded text-text-muted hover:text-accent hover:bg-accent-dim transition">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => resetPassword(u.id)} title="Reset password"
                        className="p-1.5 rounded text-text-muted hover:text-accent hover:bg-accent-dim transition">
                        <Key size={13} />
                      </button>
                      {u.isActive ? (
                        <button onClick={() => { setDeleteError(null); setDeleting(u); }} title="Deactivate"
                          className="p-1.5 rounded text-text-muted hover:text-danger hover:bg-danger/10 transition">
                          <UserX size={13} />
                        </button>
                      ) : (
                        <button onClick={() => reactivate(u.id)} title="Reactivate"
                          className="p-1.5 rounded text-text-muted hover:text-success hover:bg-success/10 transition">
                          <UserCheck size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
