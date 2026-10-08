import { useMemo, useState } from 'react';
import Modal from '../../../components/ui/Modal';
import Button from '../../../components/ui/Button';
import type { RegulatorySource } from '../../../api/sources';
import {
  RULE_CATEGORIES, RULE_EFFECTS, RULE_INDUSTRY_SCOPES, RULE_SEVERITIES,
  type AdminRule,
} from '../../../api/rules';
import {
  parseConditions, validateRuleForm,
  type RuleFormState,
} from './ruleFormModel';

const inputClasses = 'w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:border-accent focus:ring-1 focus:ring-accent/50 outline-none transition disabled:opacity-60';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-secondary mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-text-muted mt-1">{hint}</span>}
    </label>
  );
}

/**
 * Create / edit modal for a rule. The server stays authoritative; the checks
 * here (and the live conditions parser) just catch mistakes before the round trip.
 */
export default function RuleForm({
  open, mode, rule, form, setForm, sources, saving, error, onSubmit, onClose,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  /** The rule being edited (edit mode). */
  rule?: AdminRule | null;
  form: RuleFormState;
  setForm: React.Dispatch<React.SetStateAction<RuleFormState>>;
  sources: RegulatorySource[];
  saving: boolean;
  error: string | null;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const [submitted, setSubmitted] = useState(false);
  const [conditionsTouched, setConditionsTouched] = useState(false);
  const conditions = useMemo(() => parseConditions(form.conditionsText), [form.conditionsText]);
  // Only flag the conditions once the admin has edited them or tried to save.
  const showConditionsError = !conditions.ok && (conditionsTouched || submitted);
  const problems = useMemo(() => validateRuleForm(form, mode), [form, mode]);
  const set = <K extends keyof RuleFormState>(key: K, value: RuleFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (problems.length === 0) onSubmit();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'create' ? 'New rule' : `Edit rule ${rule?.ruleKey ?? ''}`}
      width="max-w-3xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === 'edit' && rule && (
          <p className="text-xs text-text-muted">
            Saving creates version {rule.version + 1}, re-signs the rule, and locks it: the extraction pipeline will no
            longer overwrite it.
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Source">
            <select
              value={form.sourceId}
              onChange={(e) => {
                const source = sources.find((s) => s.id === e.target.value);
                setForm((f) => ({ ...f, sourceId: e.target.value, jurisdiction: f.jurisdiction || source?.jurisdiction || '' }));
              }}
              disabled={mode === 'edit'}
              required
              className={inputClasses}
            >
              <option value="">Choose a source...</option>
              {sources.filter((s) => s.isActive || s.id === form.sourceId).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Rule key" hint="Unique. Lowercase, dot-separated, e.g. acme.art5.transparency. Cannot be changed later.">
            <input
              value={form.ruleKey}
              onChange={(e) => set('ruleKey', e.target.value)}
              disabled={mode === 'edit'}
              required
              maxLength={128}
              placeholder="acme.art5.transparency"
              className={`${inputClasses} font-mono`}
            />
          </Field>
          <Field label="Jurisdiction" hint="Defaults to the source's jurisdiction. Evaluation matches this code exactly.">
            <input
              value={form.jurisdiction}
              onChange={(e) => set('jurisdiction', e.target.value.toUpperCase())}
              maxLength={16}
              placeholder="e.g. EU, US-CA"
              className={`${inputClasses} font-mono`}
            />
          </Field>
          <Field label="Category">
            <select value={form.category} onChange={(e) => set('category', e.target.value)} className={inputClasses}>
              {[...new Set([...RULE_CATEGORIES, form.category])].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Effect">
            <select value={form.effect} onChange={(e) => set('effect', e.target.value as typeof form.effect)} className={inputClasses}>
              {RULE_EFFECTS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Severity">
            <select value={form.severity} onChange={(e) => set('severity', e.target.value as typeof form.severity)} className={inputClasses}>
              {RULE_SEVERITIES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
        </div>

        <Field
          label="Conditions (JSON)"
          hint='The rule applies when every key equals the same-named value in the evaluated action, e.g. {"action": "text_generation", "sector": "healthcare"}. Values must be non-empty strings.'
        >
          <textarea
            value={form.conditionsText}
            onChange={(e) => { setConditionsTouched(true); set('conditionsText', e.target.value); }}
            rows={5}
            spellCheck={false}
            aria-invalid={showConditionsError}
            className={`${inputClasses} font-mono ${showConditionsError ? 'border-danger focus:border-danger focus:ring-danger/40' : ''}`}
          />
          {showConditionsError && <span className="block text-xs text-danger mt-1" role="alert">{conditions.error}</span>}
        </Field>

        <Field label="Summary" hint="What the obligation requires, in plain language (at least 10 characters).">
          <textarea
            value={form.humanSummary}
            onChange={(e) => set('humanSummary', e.target.value)}
            rows={3}
            maxLength={2000}
            required
            className={inputClasses}
          />
        </Field>
        <Field label="Legal reference" hint="Citation, e.g. Regulation (EU) 2024/1689, Article 50(1).">
          <input
            value={form.legalReference}
            onChange={(e) => set('legalReference', e.target.value)}
            maxLength={500}
            required
            className={inputClasses}
          />
        </Field>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Effective date">
            <input type="date" value={form.effectiveDate} onChange={(e) => set('effectiveDate', e.target.value)} required className={inputClasses} />
          </Field>
          <Field label="Expires (optional)">
            <input type="date" value={form.expiresAt} onChange={(e) => set('expiresAt', e.target.value)} className={inputClasses} />
          </Field>
          <Field label="Industries" hint='Comma-separated; "all" applies to every industry.'>
            <input value={form.industriesText} onChange={(e) => set('industriesText', e.target.value)} className={inputClasses} />
          </Field>
          <Field label="Industry scope">
            <select value={form.industryScope} onChange={(e) => set('industryScope', e.target.value)} className={inputClasses}>
              {RULE_INDUSTRY_SCOPES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Industry notes (optional)">
          <input value={form.industryNotes} onChange={(e) => set('industryNotes', e.target.value)} maxLength={2000} className={inputClasses} />
        </Field>

        {submitted && problems.length > 0 && (
          <ul className="text-xs text-danger list-disc pl-5 space-y-0.5" role="alert">
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}
        {error && <p className="text-xs text-danger" role="alert">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? 'Saving...' : mode === 'create' ? 'Create rule' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
