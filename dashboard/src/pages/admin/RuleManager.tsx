import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, History, Lock, LockOpen, Pencil, Plus, Power, PowerOff } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import JurisdictionTag from '../../components/domain/JurisdictionTag';
import { apiErrorMessage, apiErrorWithDetails } from '../../lib/errors';
import { formatDate } from '../../lib/formatters';
import { getSources, type RegulatorySource } from '../../api/sources';
import {
  createRule, listRules, reactivateRule, retireRule, updateRule,
  type AdminRule, type RuleSeverity,
} from '../../api/rules';
import RuleForm from './rules/RuleForm';
import RuleHistory from './rules/RuleHistory';
import {
  buildCreatePayload, buildPatch, emptyRuleForm, formFromRule, validateRuleForm,
  type RuleFormState,
} from './rules/ruleFormModel';

const PAGE_SIZE = 50;

const severityVariant: Record<RuleSeverity, 'danger' | 'warning' | 'info' | 'default'> = {
  critical: 'danger',
  high: 'warning',
  medium: 'info',
  low: 'default',
};

/**
 * Rule management. Mounted at /admin/rules (all rules, filterable by source)
 * and /admin/sources/:sourceId/rules (one source). Rules created or edited here
 * are signed, versioned and locked against re-extraction by the pipeline.
 */
export default function RuleManager() {
  const { sourceId: routeSourceId } = useParams<{ sourceId?: string }>();
  const navigate = useNavigate();

  const [sources, setSources] = useState<RegulatorySource[]>([]);
  const [rules, setRules] = useState<AdminRule[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [sourceFilter, setSourceFilter] = useState(routeSourceId ?? '');
  const [jurisdiction, setJurisdiction] = useState('');
  const [includeInactive, setIncludeInactive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<AdminRule | null>(null);
  const [form, setForm] = useState<RuleFormState>(emptyRuleForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);

  // The route param wins over the dropdown when present.
  const activeSourceId = routeSourceId ?? sourceFilter;
  const activeSource = useMemo(() => sources.find((s) => s.id === activeSourceId), [sources, activeSourceId]);

  useEffect(() => {
    getSources()
      .then((r) => setSources(r.sources))
      .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load sources')));
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await listRules({
        sourceId: activeSourceId || undefined,
        jurisdiction: jurisdiction.trim().toUpperCase() || undefined,
        includeInactive,
        limit: PAGE_SIZE,
        offset,
      });
      setRules(r.rules);
      setTotal(r.total);
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorMessage(err, 'Failed to load rules'));
    } finally {
      setLoading(false);
    }
  }, [activeSourceId, jurisdiction, includeInactive, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setForm(emptyRuleForm(activeSourceId, activeSource?.jurisdiction ?? ''));
    setFormError(null);
    setFormMode('create');
  }

  function openEdit(rule: AdminRule) {
    setEditing(rule);
    setForm(formFromRule(rule));
    setFormError(null);
    setFormMode('edit');
  }

  function closeForm() {
    setFormMode(null);
    setEditing(null);
    setFormError(null);
  }

  async function handleSubmit() {
    if (validateRuleForm(form, formMode ?? 'create').length > 0) return;
    setSaving(true);
    setFormError(null);
    try {
      if (formMode === 'create') {
        const created = await createRule(buildCreatePayload(form));
        setNotice(`Rule ${created.ruleKey} created and active. It is locked against re-extraction.`);
      } else if (editing) {
        const patch = buildPatch(form, editing);
        if (Object.keys(patch).length === 0) {
          setFormError('Nothing changed.');
          setSaving(false);
          return;
        }
        const updated = await updateRule(editing.id, patch);
        setNotice(`Rule ${updated.ruleKey} saved as version ${updated.version}. It is locked against re-extraction.`);
      }
      closeForm();
      await load();
    } catch (err) {
      setFormError(apiErrorWithDetails(err, 'Failed to save the rule'));
    } finally {
      setSaving(false);
    }
  }

  async function act(fn: () => Promise<string>, fallback: string) {
    setActionError(null);
    try {
      setNotice(await fn());
    } catch (err) {
      setActionError(apiErrorMessage(err, fallback));
    }
    await load();
  }

  const handleRetire = (rule: AdminRule) => {
    if (!confirm(`Retire rule "${rule.ruleKey}"?\n\nIt stops applying immediately and disappears from policy bundles and evaluations. You can reactivate it later.`)) return;
    void act(async () => { await retireRule(rule.id); return `Rule ${rule.ruleKey} retired.`; }, 'Failed to retire the rule');
  };
  const handleReactivate = (rule: AdminRule) =>
    void act(async () => { await reactivateRule(rule.id); return `Rule ${rule.ruleKey} reactivated.`; }, 'Failed to reactivate the rule');
  const handleUnlock = (rule: AdminRule) => {
    if (!confirm(`Hand "${rule.ruleKey}" back to the extraction pipeline?\n\nThe next successful extraction that produces this rule key will overwrite your edits (as a new version).`)) return;
    void act(async () => { await updateRule(rule.id, { locked: false }); return `Rule ${rule.ruleKey} unlocked.`; }, 'Failed to unlock the rule');
  };

  const canCreate = sources.some((s) => s.isActive);
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rules.length, total);

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div>
      {routeSourceId && (
        <Link to="/admin/sources" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-accent mb-3 transition">
          <ArrowLeft size={12} /> Back to sources
        </Link>
      )}

      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h1 className="text-xl font-semibold text-text-primary">
          Rules{activeSource ? `: ${activeSource.name}` : ''}
        </h1>
        <div className="flex gap-2 items-center">
          <Badge variant="accent">{total} rules</Badge>
          <Button variant="primary" onClick={openCreate} disabled={!canCreate} className="text-xs">
            <Plus size={14} /> New rule
          </Button>
        </div>
      </div>
      <p className="text-xs text-text-muted mb-4 max-w-3xl">
        Rules you create or edit are signed, versioned and locked: re-extracting the source will not overwrite them.
        Retired rules stop applying everywhere immediately.
      </p>

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {!routeSourceId && (
            <select
              value={sourceFilter}
              onChange={(e) => { setSourceFilter(e.target.value); setOffset(0); }}
              aria-label="Filter by source"
              className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary max-w-xs"
            >
              <option value="">All sources</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}{s.isActive ? '' : ' (inactive)'}</option>)}
            </select>
          )}
          <input
            value={jurisdiction}
            onChange={(e) => { setJurisdiction(e.target.value.toUpperCase()); setOffset(0); }}
            placeholder="Jurisdiction (e.g. EU)"
            aria-label="Filter by jurisdiction"
            maxLength={16}
            className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder-text-muted w-44"
          />
          <label className="flex items-center gap-2 text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => { setIncludeInactive(e.target.checked); setOffset(0); }}
              className="w-4 h-4 rounded border-border accent-accent"
            />
            Show retired rules
          </label>
        </div>
      </Card>

      {activeSource && !activeSource.isActive && (
        <Card className="mb-4 border-warning/30">
          <p className="text-sm text-warning">
            This source is inactive, so its rules do not apply and new rules cannot be added.
            Reactivate it on the <button className="underline" onClick={() => navigate('/admin/sources')}>Sources</button> page
            to restore the rules its deactivation retired.
          </p>
        </Card>
      )}

      {notice && (
        <Card className="mb-4 border-accent/30">
          <p className="text-sm text-text-secondary" role="status">{notice}</p>
        </Card>
      )}
      {actionError && (
        <Card className="mb-4 border-danger/30">
          <ErrorState compact message={actionError} />
        </Card>
      )}

      {loadError ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : rules.length === 0 ? (
        <EmptyState title="No rules found" description={includeInactive ? 'Create one with "New rule".' : 'Try showing retired rules.'} />
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <Card key={rule.id} className={rule.isActive ? '' : 'opacity-70'}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-mono text-text-primary break-all">{rule.ruleKey}</p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <JurisdictionTag code={rule.jurisdiction} />
                    <Badge variant={severityVariant[rule.severity]}>{rule.severity}</Badge>
                    <Badge variant="default">{rule.effect}</Badge>
                    <Badge variant="default">v{rule.version}</Badge>
                    {rule.locked && (
                      <span title="Created or edited by an admin: the extraction pipeline will not overwrite it">
                        <Badge variant="accent"><Lock size={10} className="mr-1" />Locked</Badge>
                      </span>
                    )}
                    {!rule.isActive && <Badge variant="danger">Retired</Badge>}
                  </div>
                  <p className="text-sm text-text-secondary mt-2">{rule.humanSummary}</p>
                  <p className="text-xs text-text-muted mt-1">
                    {rule.legalReference} · effective {formatDate(rule.effectiveDate)}
                    {rule.expiresAt ? ` · expires ${formatDate(rule.expiresAt)}` : ''}
                    {!routeSourceId && rule.sourceName ? ` · ${rule.sourceName}` : ''}
                  </p>
                  <p className="text-xs text-text-muted mt-1 font-mono break-all">
                    when {Object.entries(rule.conditions).map(([k, v]) => `${k} = ${v}`).join(', ')}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => setHistoryId(rule.id)} className="p-1.5 rounded-lg hover:bg-surface-overlay text-text-muted hover:text-accent transition" title="History" aria-label="History">
                    <History size={14} />
                  </button>
                  <button onClick={() => openEdit(rule)} className="p-1.5 rounded-lg hover:bg-surface-overlay text-text-muted hover:text-text-primary transition" title="Edit" aria-label="Edit">
                    <Pencil size={14} />
                  </button>
                  {rule.locked && (
                    <button onClick={() => handleUnlock(rule)} className="p-1.5 rounded-lg hover:bg-surface-overlay text-text-muted hover:text-warning transition" title="Hand back to the extraction pipeline" aria-label="Unlock">
                      <LockOpen size={14} />
                    </button>
                  )}
                  {rule.isActive ? (
                    <button onClick={() => handleRetire(rule)} className="p-1.5 rounded-lg hover:bg-danger/10 text-text-muted hover:text-danger transition" title="Retire" aria-label="Retire">
                      <PowerOff size={14} />
                    </button>
                  ) : (
                    <button onClick={() => handleReactivate(rule)} className="p-1.5 rounded-lg hover:bg-success/10 text-text-muted hover:text-success transition" title="Reactivate" aria-label="Reactivate">
                      <Power size={14} />
                    </button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 text-xs text-text-muted">
          <span>{pageStart}-{pageEnd} of {total}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</Button>
            <Button variant="secondary" size="sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</Button>
          </div>
        </div>
      )}

      {formMode && (
        <RuleForm
          open
          mode={formMode}
          rule={editing}
          form={form}
          setForm={setForm}
          sources={sources}
          saving={saving}
          error={formError}
          onSubmit={() => void handleSubmit()}
          onClose={closeForm}
        />
      )}
      <RuleHistory ruleId={historyId} onClose={() => setHistoryId(null)} />
    </div>
  );
}
