import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FilePlus2, Plus, Trash2, Wand2, ShieldCheck } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import ErrorState from '../../components/ui/ErrorState';
import {
  compilePolicy, getPolicy, getQuorum, listBoards, proposePolicy, proposePolicyVersion,
  type Board, type CodeExample, type CompileRecord, type PolicyDetail, type QuorumVersion, type Tier,
} from '../../api/cpg';
import { TIER_DESCRIPTION, TIER_LABEL, policyErrorMessage } from '../../lib/cpg-policy';
import { compileInputProblems, ruleEditProblems, tomorrowUtc } from '../../lib/cpg-policy-forms';
import GovernanceHeader from './GovernanceHeader';
import CompileResult from './policies/CompileResult';

const inputCls = 'w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted placeholder:opacity-60 focus:outline-none focus:border-accent';
const POLICY_KEY_RE = /^corp\.[a-z0-9][a-z0-9._-]{0,84}$/;
const TIERS: Tier[] = ['advisory', 'review-required', 'prohibited'];

type GraceMode = 'default' | 'days' | 'date';

/**
 * /governance/policies/new (E29, E32, E34): write a policy in plain English,
 * compile it into a deterministic rule, check it against examples, and
 * propose it. `?policy=<id>` proposes a new version of an existing policy.
 * Nothing written here is active until someone other than the author
 * approves it.
 */
export default function PolicyNew() {
  const [params] = useSearchParams();
  const policyId = params.get('policy');
  const navigate = useNavigate();
  const [now] = useState(() => Date.now());

  // Reference data: boards (owners), quorum (grace defaults), and the existing policy for a new version.
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [quorum, setQuorum] = useState<QuorumVersion | null>(null);
  const [base, setBase] = useState<PolicyDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Step 1: text and examples.
  const [plainText, setPlainText] = useState('');
  const [violating, setViolating] = useState<CodeExample[]>([{ path: '', code: '' }]);
  const [compliant, setCompliant] = useState<CodeExample[]>([]);
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [record, setRecord] = useState<CompileRecord | null>(null);
  const [compiledInput, setCompiledInput] = useState<string | null>(null);
  const inputKey = JSON.stringify({ plainText: plainText.trim(), violating, compliant });
  const stale = record !== null && compiledInput !== inputKey;
  const inputProblems = compileInputProblems(plainText, violating, compliant);

  // Step 2: the proposal.
  const [policyKey, setPolicyKey] = useState('');
  const [title, setTitle] = useState('');
  const [tier, setTier] = useState<Tier>('review-required');
  const [boardIds, setBoardIds] = useState<string[]>([]);
  const [graceMode, setGraceMode] = useState<GraceMode>('default');
  const [graceDays, setGraceDays] = useState('14');
  const [enforceDate, setEnforceDate] = useState('');
  const [editRule, setEditRule] = useState(false);
  const [ruleText, setRuleText] = useState('');
  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listBoards(), getQuorum(), policyId ? getPolicy(policyId) : Promise.resolve(null)])
      .then(([b, q, p]) => {
        if (cancelled) return;
        setBoards(b);
        setQuorum(q);
        setBase(p);
        setLoadError(null);
        if (p) {
          const current = p.versions.find((v) => v.version === p.policy.activeVersion) ?? p.versions[p.versions.length - 1];
          if (current) {
            setPlainText(current.kind === 'define' ? current.plainText : '');
            setTitle(current.title);
            setTier(current.tier);
            setBoardIds(current.owningBoards.map((x) => x.id));
          }
        }
      })
      .catch((err) => { if (!cancelled) setLoadError(policyErrorMessage(err, 'Failed to load boards and the quorum configuration')); });
    return () => { cancelled = true; };
  }, [policyId, reloadKey]);

  async function compile() {
    setCompiling(true);
    setCompileError(null);
    setProposeError(null);
    try {
      const r = await compilePolicy({
        plainText: plainText.trim(),
        policyId: policyId ?? undefined,
        examples: { violating: violating.map(trimExample), compliant: compliant.map(trimExample) },
      });
      setRecord(r);
      setCompiledInput(inputKey);
      if (r.status === 'compiled' && r.compiledRule) {
        setRuleText(JSON.stringify(r.compiledRule, null, 2));
        setEditRule(false);
        const s = r.suggestion;
        if (s && s.expressible) {
          if (!policyId) {
            setPolicyKey((k) => k || s.suggestedKey);
            setTier(s.suggestedTier);
          }
          setTitle((t) => t || s.title);
        }
      }
    } catch (err) {
      setCompileError(policyErrorMessage(err, 'The compile request failed'));
    }
    setCompiling(false);
  }

  const activeBoards = useMemo(() => (boards ?? []).filter((b) => !b.archivedAt), [boards]);
  const defaultGrace = quorum ? (base?.policy.activeVersion ? quorum.config.gracePeriod.newVersionDefaultDays : quorum.config.gracePeriod.newPolicyDefaultDays) : null;
  const ruleProblems = editRule ? ruleEditProblems(ruleText) : [];
  const graceN = Number(graceDays);
  const proposalProblems: string[] = [];
  if (!policyId && !POLICY_KEY_RE.test(policyKey)) proposalProblems.push('The key must be corp. followed by lowercase letters, digits, ., _ or - (for example corp.no-direct-openai).');
  if (title.trim().length < 3 || title.trim().length > 120) proposalProblems.push('The title needs 3 to 120 characters.');
  if (boardIds.length === 0) proposalProblems.push('Choose at least one owning board.');
  if (graceMode === 'days' && !(Number.isInteger(graceN) && graceN >= 0 && graceN <= 365)) proposalProblems.push('Grace days must be a whole number from 0 to 365.');
  if (graceMode === 'date' && !(enforceDate && enforceDate >= tomorrowUtc(now))) proposalProblems.push(`Choose an enforce-from date from ${tomorrowUtc(now)} (UTC) onwards.`);
  proposalProblems.push(...ruleProblems);

  async function propose() {
    if (!record) return;
    setProposing(true);
    setProposeError(null);
    try {
      const input = {
        compileRecordId: record.id,
        title: title.trim(),
        tier,
        owningBoardIds: boardIds,
        rule: editRule ? JSON.parse(ruleText) as unknown : undefined,
        graceDays: graceMode === 'days' ? graceN : undefined,
        enforceFrom: graceMode === 'date' ? `${enforceDate}T00:00:00.000Z` : undefined,
      };
      const detail = policyId ? await proposePolicyVersion(policyId, input) : await proposePolicy({ ...input, policyKey });
      navigate(`/governance/policies/${detail.policy.policyId}`, { state: { proposed: true } });
    } catch (err) {
      setProposeError(policyErrorMessage(err, 'The proposal failed'));
    }
    setProposing(false);
  }

  const heading = policyId ? `New version${base ? ` of ${base.policy.policyKey}` : ''}` : 'New corporate policy';

  return (
    <div>
      <GovernanceHeader icon={FilePlus2} title={heading} subtitle="Plain English in, a deterministic rule out; nothing is active until someone else approves it" />

      <Card className="mb-4 border-info/30">
        <p className="text-sm text-text-secondary flex items-start gap-2">
          <ShieldCheck size={16} className="text-info shrink-0 mt-0.5" />
          <span>
            An LLM turns your text into a rule; your examples are checked on the server with the scanner&apos;s own matcher and are never sent to the LLM.
            Proposing creates a version that waits for approval. <strong className="text-text-primary">It never becomes active until someone other than you approves it</strong> (four-eyes).
          </span>
        </p>
      </Card>

      {loadError ? (
        <ErrorState message={loadError} onRetry={() => { setLoadError(null); setReloadKey((k) => k + 1); }} />
      ) : boards === null || quorum === null ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <div className="space-y-4">
          <Card>
            <h2 className="text-sm font-semibold text-text-primary mb-3">1. Describe the policy</h2>
            <label htmlFor="policy-text" className="block text-xs text-text-muted mb-1">Policy text * (20 to 8,000 characters; say what code must not do, concretely)</label>
            <textarea id="policy-text" rows={4} value={plainText} onChange={(e) => setPlainText(e.target.value)} className={inputCls}
              placeholder="For example: Services must not call the OpenAI SDK directly; every call goes through the approved LLM gateway in src/llm/gateway." />
            <p className="text-xs text-text-muted mt-1">{plainText.trim().length} characters</p>

            <ExampleEditor title="Violating examples * (code the rule must flag)" kind="violating" items={violating} onChange={setViolating} min={1} />
            <ExampleEditor title="Compliant examples (code the rule must not flag)" kind="compliant" items={compliant} onChange={setCompliant} min={0} />

            {plainText !== '' && inputProblems.length > 0 && (
              <ul className="mt-3 text-xs text-warning list-disc pl-5" data-testid="compile-input-problems">{inputProblems.map((p) => <li key={p}>{p}</li>)}</ul>
            )}
            {compileError && <p className="text-sm text-danger mt-3" role="alert">{compileError}</p>}
            <div className="flex justify-end mt-4">
              <Button onClick={() => void compile()} disabled={compiling || inputProblems.length > 0}>
                <Wand2 size={14} /> {compiling ? 'Compiling...' : record ? 'Compile again' : 'Compile'}
              </Button>
            </div>
          </Card>

          {record && <CompileResult record={record} stale={stale} />}

          {record && record.status === 'compiled' && !stale && (
            <Card>
              <h2 className="text-sm font-semibold text-text-primary mb-1">2. Propose it for approval</h2>
              <p className="text-xs text-text-muted mb-4">The suggestions above are pre-filled; check each one. The version is recorded as yours and someone else must approve it.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {!policyId && (
                  <div>
                    <label htmlFor="policy-key" className="block text-xs text-text-muted mb-1">Key * (cannot be changed later)</label>
                    <input id="policy-key" value={policyKey} onChange={(e) => setPolicyKey(e.target.value)} className={`${inputCls} font-mono`} maxLength={89} />
                  </div>
                )}
                <div>
                  <label htmlFor="policy-title" className="block text-xs text-text-muted mb-1">Title *</label>
                  <input id="policy-title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} maxLength={120} />
                </div>
                <div>
                  <label htmlFor="policy-tier" className="block text-xs text-text-muted mb-1">Severity tier *</label>
                  <select id="policy-tier" value={tier} onChange={(e) => setTier(e.target.value as Tier)} className={inputCls}>
                    {TIERS.map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
                  </select>
                  <p className="text-xs text-text-muted mt-1">{TIER_DESCRIPTION[tier]}</p>
                </div>
                <fieldset>
                  <legend className="block text-xs text-text-muted mb-1">Owning boards * (they review findings of this policy)</legend>
                  {activeBoards.length === 0 ? (
                    <p className="text-xs text-warning">No active boards yet. An Org Admin creates boards first (they own policies and review their findings).</p>
                  ) : (
                    <div className="space-y-1">
                      {activeBoards.map((b) => (
                        <label key={b.id} className="flex items-center gap-2 text-sm text-text-primary">
                          <input type="checkbox" checked={boardIds.includes(b.id)}
                            onChange={(e) => setBoardIds((ids) => e.target.checked ? [...ids, b.id] : ids.filter((x) => x !== b.id))} />
                          {b.name} <span className="text-xs text-text-muted">({b.kind})</span>
                        </label>
                      ))}
                    </div>
                  )}
                </fieldset>
                <fieldset className="md:col-span-2">
                  <legend className="block text-xs text-text-muted mb-1">Grace period (findings stay advisory until the policy is enforced)</legend>
                  <div className="flex flex-wrap items-center gap-4 text-sm text-text-primary">
                    <label className="flex items-center gap-2">
                      <input type="radio" name="grace" checked={graceMode === 'default'} onChange={() => setGraceMode('default')} />
                      Quorum default ({defaultGrace} day{defaultGrace === 1 ? '' : 's'} after approval)
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" name="grace" checked={graceMode === 'days'} onChange={() => setGraceMode('days')} />
                      <input type="number" min={0} max={365} value={graceDays} onChange={(e) => { setGraceDays(e.target.value); setGraceMode('days'); }}
                        className="w-20 px-2 py-1 bg-surface border border-border rounded-lg text-sm" aria-label="Grace days" /> days after approval
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" name="grace" checked={graceMode === 'date'} onChange={() => setGraceMode('date')} />
                      Enforce from
                      <input type="date" min={tomorrowUtc(now)} value={enforceDate} onChange={(e) => { setEnforceDate(e.target.value); setGraceMode('date'); }}
                        className="px-2 py-1 bg-surface border border-border rounded-lg text-sm" aria-label="Enforce from date (UTC)" /> 00:00 UTC
                    </label>
                  </div>
                  <p className="text-xs text-text-muted mt-1">If approval comes after the chosen date, the policy is enforced from the moment of approval.</p>
                </fieldset>
                <div className="md:col-span-2">
                  <label className="flex items-center gap-2 text-sm text-text-primary">
                    <input type="checkbox" checked={editRule} onChange={(e) => setEditRule(e.target.checked)} />
                    Edit the compiled rule before proposing
                  </label>
                  {editRule && (
                    <div className="mt-2">
                      <textarea aria-label="Edited rule (JSON)" rows={14} value={ruleText} onChange={(e) => setRuleText(e.target.value)} className={`${inputCls} font-mono text-xs`} spellCheck={false} />
                      <p className="text-xs text-text-muted mt-1">
                        The server checks an edited rule again (vocabularies, regex safety, globs) and re-runs your examples against it; the version records that it was edited and how.
                      </p>
                    </div>
                  )}
                </div>
              </div>
              {proposalProblems.length > 0 && (
                <ul className="mt-3 text-xs text-warning list-disc pl-5" data-testid="proposal-problems">{proposalProblems.map((p) => <li key={p}>{p}</li>)}</ul>
              )}
              {proposeError && <p className="text-sm text-danger mt-3" role="alert" data-testid="propose-error">{proposeError}</p>}
              <div className="flex justify-end mt-4">
                <Button onClick={() => void propose()} disabled={proposing || proposalProblems.length > 0}>
                  {proposing ? 'Proposing...' : 'Propose for approval'}
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function trimExample(e: CodeExample): CodeExample {
  return { path: e.path.trim(), code: e.code };
}

function ExampleEditor({ title, kind, items, onChange, min }: { title: string; kind: string; items: CodeExample[]; onChange: (v: CodeExample[]) => void; min: number }) {
  const set = (i: number, patch: Partial<CodeExample>) => onChange(items.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs text-text-muted">{title}</p>
        {items.length < 10 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...items, { path: '', code: '' }])}><Plus size={12} /> Add</Button>
        )}
      </div>
      {items.length === 0 && <p className="text-xs text-text-muted">None.</p>}
      <div className="space-y-3">
        {items.map((e, i) => (
          <div key={i} className="border border-border rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <input aria-label={`${kind} example ${i + 1} path`} value={e.path} onChange={(ev) => set(i, { path: ev.target.value })}
                className={`${inputCls} font-mono text-xs`} placeholder="File path, for example src/app/chat.ts" maxLength={300} />
              {items.length > min && (
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${kind} example ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 size={12} /></Button>
              )}
            </div>
            <textarea aria-label={`${kind} example ${i + 1} code`} rows={5} value={e.code} onChange={(ev) => set(i, { code: ev.target.value })}
              className={`${inputCls} font-mono text-xs`} spellCheck={false} placeholder="Paste the code" />
          </div>
        ))}
      </div>
    </div>
  );
}
