import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Users, X } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import { SkeletonTable } from '../../components/ui/Skeleton';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
}

export default function TenantList() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function loadOrgs() {
    setLoadError(null);
    try {
      // The API pages at 100 by default; ask for its maximum.
      const { data } = await api.get('/tenants', { params: { limit: 500 } });
      setOrgs(data.tenants);
    } catch (err) {
      setLoadError(apiErrorMessage(err, 'Failed to load tenants'));
    }
    setLoading(false);
  }

  useEffect(() => {
    // Initial mount: loadError already starts null; the retry path clears it
    // via loadOrgs(), so no synchronous reset is needed here.
    api.get('/tenants')
      .then(({ data }) => setOrgs(data.tenants))
      .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load tenants')))
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setActionError(null);
    try {
      await api.post('/tenants', { name: newName, slug: newSlug });
      setShowCreate(false);
      setNewName(''); setNewSlug('');
      await loadOrgs();
    } catch (err) {
      // Keep the form open so the input isn't lost
      setActionError(apiErrorMessage(err, 'Failed to create organization'));
    }
  }

  async function handleToggle(orgId: string, isActive: boolean) {
    setActionError(null);
    try {
      await api.patch(`/tenants/${orgId}`, { isActive: !isActive });
      await loadOrgs();
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to update tenant status'));
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">Tenants</h1>
        <Button onClick={() => setShowCreate(!showCreate)}>
          <Plus size={14} /> New Organization
        </Button>
      </div>

      {actionError && (
        <Card className="mb-4 border-danger/30">
          <ErrorState compact message={actionError} />
        </Card>
      )}

      {showCreate && (
        <Card className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-primary">New Organization</h3>
            <button onClick={() => setShowCreate(false)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
          </div>
          <form onSubmit={handleCreate} className="flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-[180px]">
              <label className="block text-xs text-text-muted mb-1">Name</label>
              <input value={newName}
                onChange={(e) => { setNewName(e.target.value); setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '-')); }}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary" placeholder="Acme Corp" required />
            </div>
            <div className="flex-1 min-w-[180px]">
              <label className="block text-xs text-text-muted mb-1">Slug</label>
              <input value={newSlug} onChange={(e) => setNewSlug(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary font-mono" placeholder="acme-corp" required />
            </div>
            <Button type="submit">Create</Button>
          </form>
        </Card>
      )}

      {loading ? (
        <SkeletonTable rows={5} />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={loadOrgs} />
      ) : orgs.length === 0 ? (
        <EmptyState title="No tenant organizations yet" description="Create your first tenant above." />
      ) : (
        <div className="space-y-2">
          {orgs.map((org) => (
            <Card key={org.id} className="cursor-pointer hover:border-border-bright transition">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3" onClick={() => navigate(`/admin/tenants/${org.id}`)}>
                  <div className="p-2 rounded-lg bg-surface-hover">
                    <Users size={16} className="text-text-secondary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-text-primary">{org.name}</p>
                    <p className="text-xs font-mono text-text-muted">{org.slug}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleToggle(org.id, org.isActive)}>
                    <Badge variant={org.isActive ? 'success' : 'default'}>
                      {org.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
