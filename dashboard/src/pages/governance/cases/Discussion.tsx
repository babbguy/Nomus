import { useState } from 'react';
import { MessagesSquare, ShieldAlert } from 'lucide-react';
import Card from '../../../components/ui/Card';
import Badge from '../../../components/ui/Badge';
import Button from '../../../components/ui/Button';
import { addCaseComment, requestCaseChanges, type CaseComment, type CaseDetail, type CaseFinding } from '../../../api/cpg';
import { formatUtc, policyErrorMessage } from '../../../lib/cpg-policy';
import { threadsOf, type CaseActions } from '../../../lib/cpg-cases';

type Notify = (text: string) => void;

/**
 * Change requests and comments, as threads with their replies. Writing is
 * offered only when the case is writable and the caller may comment.
 */
export function Discussion({ detail, actions, onPosted }: { detail: CaseDetail; actions: CaseActions; onPosted: Notify }) {
  const threads = threadsOf(detail.comments);
  const open = new Set(detail.case.openChangeRequests.map((r) => r.commentId));
  const boardName = new Map(detail.case.lanes.map((l) => [l.boardId, l.boardName]));
  const canWrite = !actions.readOnly && !actions.comment;
  const [replyTo, setReplyTo] = useState<string | null>(null);

  return (
    <Card>
      <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-3"><MessagesSquare size={16} className="text-accent" /> Change requests and comments</h2>
      {threads.length === 0 ? (
        <p className="text-sm text-text-muted mb-3">No change requests or comments yet.</p>
      ) : (
        <ul className="space-y-3 mb-4" data-testid="case-threads">
          {threads.map(({ root, replies }) => (
            <li key={root.id} className="border border-border rounded-lg p-3">
              <CommentView c={root} label={root.kind === 'change_request'
                ? <><Badge variant={open.has(root.id) ? 'warning' : 'success'}>{open.has(root.id) ? 'Changes requested' : 'Change request resolved'}</Badge>
                  <span className="text-xs text-text-muted">{boardName.get(root.boardId ?? '') || 'Board'} · {root.fingerprints.length} finding{root.fingerprints.length === 1 ? '' : 's'}</span></>
                : null} />
              {replies.length > 0 && (
                <ul className="mt-2 ml-4 pl-3 border-l border-border space-y-2">
                  {replies.map((r) => <li key={r.id}><CommentView c={r} label={null} /></li>)}
                </ul>
              )}
              {canWrite && (replyTo === root.id
                ? <div className="mt-2 ml-4"><CommentForm caseId={detail.case.id} threadId={root.id} onCancel={() => setReplyTo(null)} onPosted={(t) => { setReplyTo(null); onPosted(t); }} /></div>
                : <button type="button" className="mt-2 text-xs text-accent hover:underline" onClick={() => setReplyTo(root.id)}>Reply</button>)}
            </li>
          ))}
        </ul>
      )}
      {canWrite ? <CommentForm caseId={detail.case.id} onPosted={onPosted} />
        : !actions.readOnly && actions.comment && <Blocked text={actions.comment} />}
    </Card>
  );
}

function CommentView({ c, label }: { c: CaseComment; label: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        {label}
        <span className="text-xs text-text-secondary">{c.authorName || c.authorUserId}</span>
        <span className="text-xs text-text-muted">{formatUtc(c.createdAt)}</span>
      </div>
      <p className="text-sm text-text-primary whitespace-pre-wrap mt-1">{c.body}</p>
    </div>
  );
}

export function Blocked({ text }: { text: string }) {
  return <p className="text-xs text-text-secondary flex items-start gap-2" data-testid="action-blocked"><ShieldAlert size={14} className="text-warning shrink-0" /> {text}</p>;
}

const textareaClass = 'w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary';

function CommentForm({ caseId, threadId, onPosted, onCancel }: { caseId: string; threadId?: string; onPosted: Notify; onCancel?: () => void }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = `comment-${threadId ?? 'new'}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addCaseComment(caseId, body.trim(), threadId);
      setBody('');
      onPosted(threadId ? 'Reply posted.' : 'Comment posted.');
    } catch (err) {
      setError(policyErrorMessage(err, 'Posting failed'));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2">
      <label htmlFor={fieldId} className="block text-xs text-text-muted">{threadId ? 'Your reply' : 'Add a comment'}</label>
      <textarea id={fieldId} rows={threadId ? 2 : 3} maxLength={8000} value={body} onChange={(e) => setBody(e.target.value)} className={textareaClass} />
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" size="sm" disabled={busy || !body.trim()}>{busy ? 'Posting...' : threadId ? 'Reply' : 'Comment'}</Button>
      </div>
    </form>
  );
}

/**
 * Request changes on one lane (a board the caller belongs to): pick the
 * lane's findings and say what must change. It goes back to the developer.
 */
export function RequestChangesForm({ detail, actions, findings, onPosted }: {
  detail: CaseDetail; actions: CaseActions; findings: CaseFinding[]; onPosted: Notify;
}) {
  const [boardId, setBoardId] = useState(actions.reviewLanes[0]?.boardId ?? '');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const laneFindings = findings.filter((f) => f.owningBoardIds.includes(boardId));
  const lane = actions.reviewLanes.find((l) => l.boardId === boardId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestCaseChanges(detail.case.id, { boardId, body: body.trim(), fingerprints: [...picked] });
      setBody('');
      setPicked(new Set());
      onPosted(`Changes requested for the ${lane?.boardName ?? 'board'} lane. The developer is asked to reply.`);
    } catch (err) {
      setError(policyErrorMessage(err, 'Requesting changes failed'));
    }
    setBusy(false);
  }

  const toggle = (fp: string) => setPicked((s) => { const n = new Set(s); if (n.has(fp)) n.delete(fp); else n.add(fp); return n; });

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2" data-testid="request-changes">
      {actions.reviewLanes.length > 1 && (
        <select aria-label="Lane" value={boardId} onChange={(e) => { setBoardId(e.target.value); setPicked(new Set()); }}
          className="px-3 py-1.5 bg-surface border border-border rounded-lg text-xs text-text-primary">
          {actions.reviewLanes.map((l) => <option key={l.boardId} value={l.boardId}>{l.boardName}</option>)}
        </select>
      )}
      <fieldset className="space-y-1">
        <legend className="text-xs text-text-muted mb-1">Findings of the {lane?.boardName} lane that must change</legend>
        {laneFindings.map((f) => (
          <label key={f.id} className="flex items-start gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={picked.has(f.fingerprint)} onChange={() => toggle(f.fingerprint)} className="mt-0.5" />
            <span><span className="text-text-primary">{f.policyTitle}</span> <span className="font-mono">{f.filePath}:{f.startLine}</span></span>
          </label>
        ))}
      </fieldset>
      <label htmlFor="request-changes-body" className="block text-xs text-text-muted">What must change</label>
      <textarea id="request-changes-body" rows={3} maxLength={8000} value={body} onChange={(e) => setBody(e.target.value)} className={textareaClass} />
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={busy || !body.trim() || picked.size === 0}>{busy ? 'Sending...' : 'Request changes'}</Button>
      </div>
    </form>
  );
}
