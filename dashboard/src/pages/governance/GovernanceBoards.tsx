import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Landmark, Plus, UserPlus, X } from 'lucide-react';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Modal from '../../components/ui/Modal';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import DataFreshness from '../../components/ui/DataFreshness';
import { SkeletonCard } from '../../components/ui/Skeleton';
import {
  addBoardMember, archiveBoard, createBoard, listBoards, listPolicies, removeBoardMember, updateBoard,
  type Board, type BoardKind, type OrgUser, type PolicyHead,
} from '../../api/cpg';
import { useCpgMe } from '../../hooks/useCpgMe';
import { useOrgUsers } from '../../hooks/useOrgUsers';
import { useCpgLoad } from '../../hooks/useCpgLoad';
import { hasOrgPermission } from '../../lib/cpg-permissions';
import { formatUtcDate, policyErrorMessage } from '../../lib/cpg-policy';
import GovernanceHeader from './GovernanceHeader';
import { StateBadge, TierBadge } from './policies/parts';

const inputCls = 'w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent';
const KINDS: Array<{ value: BoardKind; label: string }> = [
  { value: 'governance', label: 'Governance' },
  { value: 'legal', label: 'Legal' },
  { value: 'ai', label: 'AI' },
  { value: 'security', label: 'Security' },
  { value: 'custom', label: 'Custom' },
];
const kindLabel = (k: BoardKind) => KINDS.find((x) => x.value === k)?.label ?? k;

type Notice = { type: 'ok' | 'err'; text: string } | null;

/** /governance/boards (E19–E24, E31): review boards, their members, and the policies each one owns. */
export default function GovernanceBoards() {
  const { me } = useCpgMe();
  const canManage = hasOrgPermission(me, 'boards.manage');
  const { users, error: usersError } = useOrgUsers(canManage && hasOrgPermission(me, 'org.members.read'));
  const { data, error, fetchedAt, reload, retry } = useCpgLoad(() => Promise.all([listBoards(), listPolicies()]), 'Failed to load the boards');
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState<Board | 'new' | null>(null);

  async function run(action: () => Promise<unknown>, ok: string, fail: string) {
    setNotice(null);
    try {
      await action();
      setNotice({ type: 'ok', text: ok });
      reload();
    } catch (err) {
      setNotice({ type: 'err', text: policyErrorMessage(err, fail) });
    }
  }

  return (
    <div>
      <GovernanceHeader
        icon={Landmark}
        title="Review boards"
        subtitle="Boards own policies and review their findings"
        actions={canManage ? <Button size="sm" onClick={() => setEditing('new')}><Plus size={14} /> New board</Button> : undefined}
      />
      {notice && (
        <p className={`text-sm mb-3 ${notice.type === 'ok' ? 'text-success' : 'text-danger'}`} role={notice.type === 'err' ? 'alert' : 'status'} data-testid="boards-notice">{notice.text}</p>
      )}
      {usersError && <ErrorState compact message={`${usersError}; adding members is unavailable until the user list loads.`} />}
      {error ? (
        <ErrorState message={error} onRetry={retry} />
      ) : data === null ? (
        <div className="space-y-4"><SkeletonCard /><SkeletonCard /></div>
      ) : (
        <>
          <BoardsView
            boards={data[0]}
            policies={data[1]}
            users={users}
            canManage={canManage}
            onEdit={(b) => setEditing(b)}
            onArchive={(b) => void run(() => archiveBoard(b.id), `Board ${b.name} archived.`, `Failed to archive ${b.name}`)}
            onAddMember={(b, u) => void run(() => addBoardMember(b.id, u.id), `${u.email} added to ${b.name}.`, `Failed to add ${u.email}`)}
            onRemoveMember={(b, userId, label) => void run(() => removeBoardMember(b.id, userId), `${label} removed from ${b.name}.`, `Failed to remove ${label}`)}
          />
          <DataFreshness fetchedAt={fetchedAt} className="mt-2" />
        </>
      )}
      {editing && (
        <BoardEditor
          board={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(b, created) => { setEditing(null); setNotice({ type: 'ok', text: created ? `Board ${b.name} created.` : `Board ${b.name} saved.` }); reload(); }}
        />
      )}
    </div>
  );
}

export function BoardsView({ boards, policies, users, canManage, onEdit, onArchive, onAddMember, onRemoveMember }: {
  boards: Board[];
  policies: PolicyHead[];
  users: OrgUser[] | null;
  canManage: boolean;
  onEdit: (b: Board) => void;
  onArchive: (b: Board) => void;
  onAddMember: (b: Board, u: OrgUser) => void;
  onRemoveMember: (b: Board, userId: string, label: string) => void;
}) {
  const active = boards.filter((b) => !b.archivedAt);
  const archived = boards.filter((b) => b.archivedAt);
  if (boards.length === 0) {
    return (
      <EmptyState
        title="No review boards yet"
        description={canManage ? 'Create a board (for example an AI review board or a legal board); every policy names at least one owning board.' : 'An Org Admin creates boards; every policy names at least one owning board.'}
      />
    );
  }
  return (
    <div className="space-y-4" data-testid="boards">
      {active.map((b) => (
        <BoardCard key={b.id} board={b} owned={policies.filter((p) => p.owningBoards.some((o) => o.id === b.id))} users={users} canManage={canManage}
          onEdit={onEdit} onArchive={onArchive} onAddMember={onAddMember} onRemoveMember={onRemoveMember} />
      ))}
      {active.length === 0 && <EmptyState title="No active boards" description="Every board is archived." />}
      {archived.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-text-secondary mb-2">Archived boards</h2>
          <div className="space-y-2">
            {archived.map((b) => (
              <Card key={b.id} className="py-3">
                <p className="text-sm text-text-primary">{b.name} <span className="font-mono text-xs text-text-muted">{b.key}</span></p>
                <p className="text-xs text-text-muted">Archived {formatUtcDate(b.archivedAt)} (UTC); it can no longer own new policy versions.</p>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BoardCard({ board, owned, users, canManage, onEdit, onArchive, onAddMember, onRemoveMember }: {
  board: Board;
  owned: PolicyHead[];
  users: OrgUser[] | null;
  canManage: boolean;
  onEdit: (b: Board) => void;
  onArchive: (b: Board) => void;
  onAddMember: (b: Board, u: OrgUser) => void;
  onRemoveMember: (b: Board, userId: string, label: string) => void;
}) {
  const [pick, setPick] = useState('');
  const memberIds = new Set((board.members ?? []).map((m) => m.userId));
  const candidates = (users ?? []).filter((u) => u.isActive && !memberIds.has(u.id));
  const chosen = candidates.find((u) => u.id === pick);
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            {board.name} <Badge>{kindLabel(board.kind)}</Badge>
          </h2>
          <p className="font-mono text-xs text-text-muted">{board.key}</p>
          {board.description && <p className="text-sm text-text-secondary mt-1">{board.description}</p>}
        </div>
        {canManage && (
          <div className="flex gap-1">
            <Button variant="secondary" size="sm" onClick={() => onEdit(board)} aria-label={`Edit board ${board.name}`}>Edit</Button>
            <Button variant="ghost" size="sm" onClick={() => onArchive(board)} aria-label={`Archive board ${board.name}`}>Archive</Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <div>
          <p className="text-xs text-text-muted mb-1">Members ({board.memberCount})</p>
          {board.members === null ? (
            <p className="text-xs text-text-secondary">{board.memberCount === 0 ? 'No members yet.' : `${board.memberCount} member${board.memberCount === 1 ? '' : 's'}. Names are visible to people who manage boards.`}</p>
          ) : board.members.length === 0 ? (
            <p className="text-xs text-text-secondary">No members yet. Without members nobody can review this board&apos;s findings.</p>
          ) : (
            <ul className="space-y-1" data-testid={`board-members-${board.key}`}>
              {board.members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-text-primary">{m.userName || m.userEmail || m.userId} <span className="text-xs text-text-muted">{m.userEmail}</span></span>
                  {canManage && (
                    <button type="button" className="text-text-muted hover:text-danger" aria-label={`Remove ${m.userEmail || m.userId} from ${board.name}`}
                      onClick={() => onRemoveMember(board, m.userId, m.userEmail || m.userId)}>
                      <X size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canManage && users !== null && (
            <div className="flex items-center gap-2 mt-2">
              <select aria-label={`Add a member to ${board.name}`} value={pick} onChange={(e) => setPick(e.target.value)} className="px-2 py-1 bg-surface border border-border rounded-lg text-xs text-text-primary min-w-0 flex-1">
                <option value="">{candidates.length === 0 ? 'Every active user is a member' : 'Choose a user...'}</option>
                {candidates.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
              </select>
              <Button size="sm" variant="secondary" disabled={!chosen} onClick={() => { if (chosen) { onAddMember(board, chosen); setPick(''); } }}>
                <UserPlus size={12} /> Add
              </Button>
            </div>
          )}
        </div>
        <div>
          <p className="text-xs text-text-muted mb-1">Policies it owns ({owned.length})</p>
          {owned.length === 0 ? (
            <p className="text-xs text-text-secondary">None.</p>
          ) : (
            <ul className="space-y-1" data-testid={`board-policies-${board.key}`}>
              {owned.map((p) => (
                <li key={p.policyId} className="flex items-center gap-2 text-sm flex-wrap">
                  <Link to={`/governance/policies/${p.policyId}`} className="font-mono text-xs text-text-primary hover:text-accent">{p.policyKey}</Link>
                  <TierBadge tier={p.tier} />
                  <StateBadge state={p.state} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="text-[11px] text-text-muted mt-3">Created {formatUtcDate(board.createdAt)} (UTC)</p>
    </Card>
  );
}

function BoardEditor({ board, onClose, onSaved }: { board: Board | null; onClose: () => void; onSaved: (b: Board, created: boolean) => void }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState(board?.name ?? '');
  const [kind, setKind] = useState<BoardKind>(board?.kind ?? 'governance');
  const [description, setDescription] = useState(board?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyValid = /^[a-z][a-z0-9_-]{0,49}$/.test(key);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!board) {
        onSaved(await createBoard({ key, name: name.trim(), kind, ...(description.trim() ? { description: description.trim() } : {}) }), true);
      } else {
        const patch: { name?: string; description?: string } = {};
        if (name.trim() !== board.name) patch.name = name.trim();
        if (description.trim() !== board.description) patch.description = description.trim();
        if (Object.keys(patch).length === 0) { setError('Nothing changed.'); setBusy(false); return; }
        onSaved(await updateBoard(board.id, patch), false);
      }
    } catch (err) {
      setError(policyErrorMessage(err, 'Failed to save the board'));
    }
    setBusy(false);
  }

  return (
    <Modal open onClose={onClose} title={board ? `Edit board: ${board.name}` : 'New review board'}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {!board && (
          <>
            <div>
              <label htmlFor="board-key" className="block text-xs text-text-muted mb-1">Key * (lowercase letters, digits, _ and -, cannot be changed later)</label>
              <input id="board-key" required value={key} onChange={(e) => setKey(e.target.value)} className={`${inputCls} font-mono`} placeholder="ai-review" maxLength={50} />
              {key !== '' && !keyValid && <p className="text-xs text-danger mt-1">Start with a letter; use only lowercase letters, digits, _ and -.</p>}
            </div>
            <div>
              <label htmlFor="board-kind" className="block text-xs text-text-muted mb-1">Kind *</label>
              <select id="board-kind" value={kind} onChange={(e) => setKind(e.target.value as BoardKind)} className={inputCls}>
                {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            </div>
          </>
        )}
        <div>
          <label htmlFor="board-name" className="block text-xs text-text-muted mb-1">Name *</label>
          <input id="board-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label htmlFor="board-description" className="block text-xs text-text-muted mb-1">Description</label>
          <textarea id="board-description" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} />
        </div>
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim() || (!board && !keyValid)}>{busy ? 'Saving...' : board ? 'Save board' : 'Create board'}</Button>
        </div>
      </form>
    </Modal>
  );
}
