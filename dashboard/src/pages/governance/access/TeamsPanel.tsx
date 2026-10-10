import { useState } from 'react';
import { Plus } from 'lucide-react';
import Card from '../../../components/ui/Card';
import Badge from '../../../components/ui/Badge';
import Button from '../../../components/ui/Button';
import Modal from '../../../components/ui/Modal';
import EmptyState from '../../../components/ui/EmptyState';
import { createTeam, updateTeam, type Team } from '../../../api/cpg';
import { cpgErrorMessage } from '../../../lib/cpg-errors';
import { formatDate } from '../../../lib/formatters';
import { inputCls, parsePatterns, type AccessData } from './helpers';
import { NoticeLine, TableHead, type Notice } from '../parts';

/** Teams tab: named sets of repository patterns that scope grants; create, edit, archive (rbac.teams.manage). */
export default function TeamsPanel({ data, canManage, onChanged }: { data: AccessData; canManage: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<Team | 'new' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function setArchived(team: Team, archived: boolean) {
    setNotice(null);
    try {
      await updateTeam(team.id, { archived });
      setNotice({ type: 'ok', text: archived ? `Team ${team.name} archived; its grants no longer apply.` : `Team ${team.name} restored.` });
      onChanged();
    } catch (err) {
      setNotice({ type: 'err', text: cpgErrorMessage(err, archived ? 'Failed to archive the team' : 'Failed to restore the team') });
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <p className="text-sm text-text-muted max-w-3xl">
          A team is a set of repository patterns, such as <span className="font-mono text-xs">owner/payments-*</span>. A role granted
          to a team applies only to the repositories its patterns match.
        </p>
        {canManage && <Button size="sm" onClick={() => setEditing('new')}><Plus size={14} /> New team</Button>}
      </div>
      <NoticeLine notice={notice} className="text-xs mb-3" />

      <TeamsTable teams={data.teams} canManage={canManage} onEdit={(t) => setEditing(t)} onArchive={(t, a) => void setArchived(t, a)} />

      {editing && (
        <TeamEditor
          team={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(t, created) => { setEditing(null); setNotice({ type: 'ok', text: created ? `Team ${t.name} created.` : `Team ${t.name} saved.` }); onChanged(); }}
        />
      )}
    </div>
  );
}

export function TeamsTable({ teams, canManage, onEdit, onArchive }: {
  teams: Team[];
  canManage: boolean;
  onEdit: (t: Team) => void;
  onArchive: (t: Team, archived: boolean) => void;
}) {
  if (teams.length === 0) {
    return (
      <EmptyState
        title="No teams yet"
        description={canManage ? 'Create a team to grant roles for a group of repositories.' : 'An Org Admin can create teams to scope roles to repositories.'}
      />
    );
  }
  return (
    <Card className="p-0 overflow-x-auto">
      <table className="w-full text-sm" data-testid="access-teams">
        <TableHead columns={['Team', 'Repository patterns', 'Created', 'Status', canManage && { label: 'Actions', className: 'text-right' }]} />
        <tbody className="divide-y divide-border">
          {teams.map((t) => (
            <tr key={t.id} className="align-top">
              <td className="px-4 py-3">
                <p className="text-text-primary font-medium">{t.name}</p>
                <p className="font-mono text-xs text-text-muted">{t.key}</p>
              </td>
              <td className="px-4 py-3">
                {t.repoPatterns.length === 0 ? (
                  <span className="text-xs text-text-muted">No patterns: matches no repository</span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {t.repoPatterns.map((p) => <span key={p} className="font-mono text-xs px-2 py-0.5 rounded bg-surface-hover text-text-secondary">{p}</span>)}
                  </div>
                )}
              </td>
              <td className="px-4 py-3 text-xs text-text-muted whitespace-nowrap" title={t.createdAt}>{formatDate(t.createdAt)}</td>
              <td className="px-4 py-3">
                <Badge variant={t.archivedAt ? 'warning' : 'success'}>{t.archivedAt ? 'Archived' : 'Active'}</Badge>
              </td>
              {canManage && (
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    {!t.archivedAt && <Button variant="secondary" size="sm" onClick={() => onEdit(t)} aria-label={`Edit team ${t.name}`}>Edit</Button>}
                    <Button variant="ghost" size="sm" onClick={() => onArchive(t, !t.archivedAt)}>{t.archivedAt ? 'Restore' : 'Archive'}</Button>
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

function TeamEditor({ team, onClose, onSaved }: { team: Team | null; onClose: () => void; onSaved: (t: Team, created: boolean) => void }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState(team?.name ?? '');
  const [patternsText, setPatternsText] = useState((team?.repoPatterns ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyValid = /^[a-z][a-z0-9_-]{0,49}$/.test(key);
  const patterns = parsePatterns(patternsText);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!team) {
        onSaved(await createTeam({ key, name: name.trim(), repoPatterns: patterns }), true);
      } else {
        const patch: { name?: string; repoPatterns?: string[] } = {};
        if (name.trim() !== team.name) patch.name = name.trim();
        if ([...team.repoPatterns].sort().join('\n') !== [...patterns].sort().join('\n')) patch.repoPatterns = patterns;
        if (Object.keys(patch).length === 0) { setError('Nothing changed.'); setBusy(false); return; }
        onSaved(await updateTeam(team.id, patch), false);
      }
    } catch (err) {
      setError(cpgErrorMessage(err, 'Failed to save the team'));
    }
    setBusy(false);
  }

  return (
    <Modal open onClose={onClose} title={team ? `Edit team: ${team.name}` : 'New team'}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {!team && (
          <div>
            <label htmlFor="team-key" className="block text-xs text-text-muted mb-1">Key * (lowercase letters, digits, _ and -, cannot be changed later)</label>
            <input id="team-key" required value={key} onChange={(e) => setKey(e.target.value)} className={`${inputCls} font-mono`} placeholder="payments" maxLength={50} />
            {key !== '' && !keyValid && <p className="text-xs text-danger mt-1">Start with a letter; use only lowercase letters, digits, _ and -.</p>}
          </div>
        )}
        <div>
          <label htmlFor="team-name" className="block text-xs text-text-muted mb-1">Name *</label>
          <input id="team-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label htmlFor="team-patterns" className="block text-xs text-text-muted mb-1">Repository patterns (one per line, lowercase; * matches within one segment, a whole ** segment matches any depth)</label>
          <textarea
            id="team-patterns"
            rows={4}
            value={patternsText}
            onChange={(e) => setPatternsText(e.target.value)}
            className={`${inputCls} font-mono`}
            placeholder={'owner/payments-*\nowner/ledger'}
          />
          <p className="text-xs text-text-muted mt-1">{patterns.length} pattern{patterns.length === 1 ? '' : 's'}; at most 50.</p>
        </div>
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim() || (!team && !keyValid) || patterns.length > 50}>
            {busy ? 'Saving...' : team ? 'Save team' : 'Create team'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
