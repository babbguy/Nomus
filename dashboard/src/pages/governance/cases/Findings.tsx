import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquareText, Sparkles } from 'lucide-react';
import Badge from '../../../components/ui/Badge';
import Button from '../../../components/ui/Button';
import Spinner from '../../../components/ui/Spinner';
import ErrorState from '../../../components/ui/ErrorState';
import { getReviewerContext, type CaseFinding, type FindingResolution, type ReviewerContext } from '../../../api/cpg';
import { formatUtc, policyErrorMessage } from '../../../lib/cpg-policy';
import { RESOLUTION_LABEL, RESOLUTION_VARIANT } from '../../../lib/cpg-cases';
import { GeneratedNotice, TierBadge } from '../policies/parts';

/** The engine tries reviewer context at most this many times (MAX_CONTEXT_ATTEMPTS). */
const MAX_CONTEXT_ATTEMPTS = 5;

/**
 * The findings of one revision: policy, tier, status, location, the snippet
 * as stored on the server, the developer's justification and, on request,
 * the generated reviewer context. `resolutions` are the latest revision's
 * (null when an older revision is shown).
 */
export function FindingList({ caseId, findings, resolutions }: {
  caseId: string;
  findings: CaseFinding[];
  resolutions: Map<string, FindingResolution> | null;
}) {
  if (findings.length === 0) return <p className="text-sm text-text-muted">This revision has no findings: every earlier finding was fixed.</p>;
  return (
    <ul className="space-y-4" data-testid="case-findings">
      {findings.map((f) => {
        const r = resolutions?.get(f.fingerprint);
        return (
          <li key={f.id} className="border border-border rounded-lg p-4 space-y-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <Link to={`/governance/policies/${f.policyId}`} className="text-text-primary font-medium hover:text-accent">{f.policyTitle}</Link>
                <p className="font-mono text-xs text-text-muted">{f.policyKey} v{f.policyVersion}</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <TierBadge tier={f.tier} />
                {r ? <Badge variant={RESOLUTION_VARIANT[r.status]}>{RESOLUTION_LABEL[r.status]}</Badge>
                  : <Badge>{f.blocking ? 'Blocking' : 'Not blocking'}</Badge>}
                <Badge>{f.statusAtRevision === 'new' ? 'New in this revision' : 'Carried over'}</Badge>
              </div>
            </div>
            <div>
              <p className="font-mono text-xs text-text-secondary mb-1">{f.filePath}:{f.startLine === f.endLine ? f.startLine : `${f.startLine}-${f.endLine}`}</p>
              <pre className="text-xs font-mono bg-surface border border-border rounded-lg p-3 overflow-x-auto whitespace-pre" data-testid="finding-snippet"><code>{f.snippet}</code></pre>
            </div>
            <div className="text-sm">
              <p className="text-xs text-text-muted mb-1 flex items-center gap-1"><MessageSquareText size={12} /> Developer&apos;s justification</p>
              {f.justification ? (
                <>
                  <p className="text-text-primary whitespace-pre-wrap">{f.justification.body}</p>
                  <p className="text-xs text-text-muted mt-1">{f.justification.authorName || f.justification.authorUserId} · {formatUtc(f.justification.createdAt)}</p>
                </>
              ) : (
                <p className="text-text-muted text-xs">{f.blocking ? 'None yet. The developer justifies blocking findings when requesting review.' : 'None: this finding does not block, so it needs no review.'}</p>
              )}
            </div>
            <ContextPanel caseId={caseId} findingId={f.id} />
          </li>
        );
      })}
    </ul>
  );
}

type ContextState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; text: string } | { kind: 'loaded'; context: ReviewerContext };

/**
 * Generated reviewer context (owner decision D1), fetched on request: the
 * first request generates it when the organization allows it, and the
 * result is stored, so later requests are free. Always labelled as generated.
 */
function ContextPanel({ caseId, findingId }: { caseId: string; findingId: string }) {
  const [state, setState] = useState<ContextState>({ kind: 'idle' });

  async function load(retry: boolean) {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'loaded', context: await getReviewerContext(caseId, findingId, retry) });
    } catch (err) {
      setState({ kind: 'error', text: policyErrorMessage(err, 'Loading the reviewer context failed') });
    }
  }

  const frame = (children: React.ReactNode) => (
    <div className="border-t border-border pt-3" data-testid="reviewer-context">
      <p className="text-xs text-text-muted mb-2 flex items-center gap-1"><Sparkles size={12} /> Reviewer context</p>
      {children}
    </div>
  );

  if (state.kind === 'idle') {
    return frame(
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-text-secondary">A plain-English explanation of this snippet, generated by the organization&apos;s LLM provider. It is generated once and kept.</p>
        <Button size="sm" variant="secondary" onClick={() => void load(false)}>Show reviewer context</Button>
      </div>,
    );
  }
  if (state.kind === 'loading') return frame(<p className="text-xs text-text-secondary flex items-center gap-2"><Spinner className="w-3 h-3" /> Loading the reviewer context...</p>);
  if (state.kind === 'error') return frame(<ErrorState compact message={state.text} onRetry={() => void load(false)} />);

  const c = state.context;
  if (c.status === 'disabled') {
    return frame(<p className="text-xs text-text-secondary">Reviewer context is off for this organization. An Org Admin can turn it on in Governance settings.</p>);
  }
  if (c.status === 'failed') {
    const canRetry = (c.attempt ?? 0) < MAX_CONTEXT_ATTEMPTS;
    return frame(
      <div className="space-y-2">
        <p className="text-xs text-danger" role="alert">
          Generating it failed{c.attempt ? ` (attempt ${c.attempt} of ${MAX_CONTEXT_ATTEMPTS})` : ''}: {c.error ?? 'no reason was recorded'}.
          {canRetry ? '' : ' No more attempts are allowed.'}
        </p>
        {canRetry && <Button size="sm" variant="secondary" onClick={() => void load(true)}>Try again</Button>}
      </div>,
    );
  }
  return frame(
    <div className="space-y-2">
      <GeneratedNotice provider={c.provider} model={c.model}>
        Context for reviewers, generated {formatUtc(c.createdAt)}. It is not the developer&apos;s justification and it decides nothing.
      </GeneratedNotice>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        <div><p className="text-xs text-text-muted mb-1">What this code does</p><p className="text-text-primary whitespace-pre-wrap">{c.whatItDoes}</p></div>
        <div><p className="text-xs text-text-muted mb-1">Why it was flagged</p><p className="text-text-primary whitespace-pre-wrap">{c.whyFlagged}</p></div>
      </div>
    </div>,
  );
}
