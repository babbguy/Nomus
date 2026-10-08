import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Users } from 'lucide-react';
import Card from '../../components/ui/Card';
import Spinner from '../../components/ui/Spinner';
import ErrorState from '../../components/ui/ErrorState';
import { useAuthStore } from '../../stores/authStore';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: string;
}

export default function Team() {
  const { org, user } = useAuthStore();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const isAdmin = user?.role === 'platform_admin';

  const fetchMembers = useCallback(
    () =>
      api.get('/org/members')
        .then(({ data }) => {
          setMembers(Array.isArray(data?.members) ? data.members : []);
          setLoadError(null);
        })
        .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load team members')))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  function retry() {
    setLoading(true);
    void fetchMembers();
  }

  return (
    <div className="p-6 animate-page">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-accent-dim">
          <Users size={20} className="text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Team</h1>
          <p className="text-sm text-text-secondary">Members of {org?.name}</p>
        </div>
      </div>

      <p className="text-sm text-text-muted mb-4" data-testid="team-note">
        {isAdmin ? (
          <>
            This list is read-only. Add, change or deactivate users in{' '}
            <Link to="/admin/users" className="text-accent hover:underline">Admin &rarr; Users</Link>.
          </>
        ) : (
          'Users are managed by a platform administrator (Admin → Users). Ask an administrator to add or change members.'
        )}
      </p>

      <Card>
        <h2 className="text-sm font-semibold text-text-secondary mb-4">Members</h2>

        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner className="w-6 h-6" />
          </div>
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={retry} />
        ) : members.length === 0 ? (
          <p className="text-sm text-text-muted py-4">No team members found.</p>
        ) : (
          <div className="divide-y divide-border">
            {members.map((m) => (
              <div key={m.id} className="flex items-center justify-between py-3 gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text-primary font-medium truncate">
                    {m.name || m.email}
                    {m.id === user?.id && <span className="ml-2 text-xs text-text-muted">(you)</span>}
                  </p>
                  <p className="text-xs text-text-muted truncate">{m.email}</p>
                  <p className="text-xs text-text-muted">
                    Joined {new Date(m.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!m.isActive && (
                    <span className="text-xs text-warning px-2 py-1 bg-warning/15 rounded-lg">Inactive</span>
                  )}
                  <span className="text-xs text-text-muted px-2 py-1 bg-surface-raised rounded-lg">
                    {m.role === 'platform_admin' ? 'Platform admin' : 'Member'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
