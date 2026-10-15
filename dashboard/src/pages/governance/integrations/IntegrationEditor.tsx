import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import Button from '../../../components/ui/Button';
import Modal from '../../../components/ui/Modal';
import {
  createIntegration, rotateIntegrationSecret, updateIntegration,
  type Board, type CpgEvent, type Integration, type IntegrationKind, type IntegrationWithSecret,
} from '../../../api/cpg';
import { cpgErrorMessage } from '../../../lib/cpg-errors';
import {
  EVENT_OPTIONS, KIND_LABELS, configFromForm, emptyForm, formFromIntegration, formProblem, inputFromForm, secretLabel, type IntegrationForm,
} from '../../../lib/cpg-integrations';

const inputCls = 'w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent';
const checkCls = 'flex items-center gap-2 text-sm text-text-primary';

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-text-muted mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-text-muted mt-1">{hint}</p>}
    </div>
  );
}

/** Create (`integration` null) or edit an integration; the type is fixed once created. */
export function IntegrationEditor({ integration, boards, onClose, onSaved }: {
  integration: Integration | null;
  boards: Board[];
  onClose: () => void;
  /** `secret` is set when a webhook was just created. */
  onSaved: (result: IntegrationWithSecret, created: boolean) => void;
}) {
  const [form, setForm] = useState<IntegrationForm>(() => (integration ? formFromIntegration(integration) : emptyForm('webhook')));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof IntegrationForm>(key: K, value: IntegrationForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggle = (key: 'events' | 'boardIds', value: string) =>
    setForm((f) => {
      const current: string[] = f[key];
      return { ...f, [key]: current.includes(value) ? current.filter((x) => x !== value) : [...current, value] } as IntegrationForm;
    });
  const problem = formProblem(form, !!integration);
  const shownBoards = boards.filter((b) => !b.archivedAt || form.boardIds.includes(b.id));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (integration) {
        const updated = await updateIntegration(integration.id, { name: form.name.trim(), boardIds: form.boardIds, events: form.events, enabled: form.enabled, config: configFromForm(form) });
        onSaved({ integration: updated }, false);
      } else {
        onSaved(await createIntegration(inputFromForm(form)), true);
      }
    } catch (err) {
      setError(cpgErrorMessage(err, 'Failed to save the integration'));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={integration ? `Edit ${integration.name}` : 'Add an integration'} width="max-w-xl">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {!integration && (
          <Field id="int-kind" label="Type">
            <select id="int-kind" value={form.kind} onChange={(e) => setForm({ ...emptyForm(e.target.value as IntegrationKind), name: form.name })} className={inputCls}>
              {(Object.keys(KIND_LABELS) as IntegrationKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </select>
          </Field>
        )}
        <Field id="int-name" label="Name *">
          <input id="int-name" required maxLength={100} value={form.name} onChange={(e) => set('name', e.target.value)} className={inputCls} />
        </Field>

        {form.kind === 'webhook' && (
          <Field id="int-url" label="Webhook URL *" hint="HTTPS only. Private and loopback addresses are refused.">
            <input id="int-url" type="url" required value={form.url} onChange={(e) => set('url', e.target.value)} className={`${inputCls} font-mono`} placeholder="https://hooks.example.com/nomus" />
          </Field>
        )}
        {form.kind === 'jira' && (
          <>
            <Field id="int-base" label="Jira site URL *">
              <input id="int-base" type="url" required value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} className={`${inputCls} font-mono`} placeholder="https://example.atlassian.net" />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field id="int-account" label="Account email *">
                <input id="int-account" type="email" required value={form.accountEmail} onChange={(e) => set('accountEmail', e.target.value)} className={inputCls} />
              </Field>
              <Field id="int-project" label="Project key *">
                <input id="int-project" required maxLength={10} value={form.projectKey} onChange={(e) => set('projectKey', e.target.value)} className={`${inputCls} font-mono`} placeholder="GOV" />
              </Field>
              <Field id="int-issue-type" label="Issue type">
                <input id="int-issue-type" maxLength={50} value={form.issueType} onChange={(e) => set('issueType', e.target.value)} className={inputCls} />
              </Field>
              <Field id="int-labels" label="Labels" hint="Separated by commas.">
                <input id="int-labels" value={form.labels} onChange={(e) => set('labels', e.target.value)} className={inputCls} />
              </Field>
            </div>
            {!integration && (
              <Field id="int-token" label="API token *" hint="Stored encrypted. Afterwards only its last 4 characters are shown.">
                <input id="int-token" type="password" autoComplete="off" required value={form.apiToken} onChange={(e) => set('apiToken', e.target.value)} className={`${inputCls} font-mono`} />
              </Field>
            )}
          </>
        )}
        {form.kind === 'email' && (
          <div className="space-y-2">
            <label className={checkCls}><input type="checkbox" checked={form.includeBoardMembers} onChange={(e) => set('includeBoardMembers', e.target.checked)} /> Email the members of the owning board</label>
            <label className={checkCls}><input type="checkbox" checked={form.notifyDevelopers} onChange={(e) => set('notifyDevelopers', e.target.checked)} /> Email the developer when changes are requested</label>
            <Field id="int-extra" label="Extra recipients" hint="Separated by commas. They receive every event chosen below.">
              <input id="int-extra" value={form.extraRecipients} onChange={(e) => set('extraRecipients', e.target.value)} className={inputCls} placeholder="governance@example.com" />
            </Field>
          </div>
        )}

        <fieldset>
          <legend className="text-xs text-text-muted mb-1">Events *</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            {EVENT_OPTIONS.map((o) => (
              <label key={o.value} className={checkCls}><input type="checkbox" checked={form.events.includes(o.value as CpgEvent)} onChange={() => toggle('events', o.value)} /> {o.label}</label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-xs text-text-muted mb-1">Boards</legend>
          {shownBoards.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {shownBoards.map((b) => <label key={b.id} className={checkCls}><input type="checkbox" checked={form.boardIds.includes(b.id)} onChange={() => toggle('boardIds', b.id)} /> {b.name}</label>)}
            </div>
          )}
          <p className="text-xs text-text-muted mt-1">{form.boardIds.length === 0 ? 'No board selected: notifications for every board are sent.' : 'Only notifications for the selected boards are sent.'}</p>
        </fieldset>
        <label className={checkCls}><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Enabled</label>

        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {problem && <span className="text-xs text-text-muted mr-auto">{problem}</span>}
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !!problem}>{busy ? 'Saving...' : integration ? 'Save changes' : 'Add integration'}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** The webhook signing secret, shown once. */
export function SecretOnceModal({ name, secret, onClose }: { name: string; secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(secret); setCopied(true); } catch { setCopied(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Signing secret for ${name}`}>
      <p className="text-sm text-warning mb-3" role="alert">Copy it now. This secret is shown only once; afterwards Nomus shows only its last 4 characters. If you lose it, rotate the secret.</p>
      <div className="flex items-center gap-2">
        <input readOnly aria-label="Signing secret" value={secret} onFocus={(e) => e.target.select()} className={`${inputCls} font-mono`} data-testid="webhook-secret" />
        <Button type="button" variant="secondary" size="sm" onClick={() => void copy()}>{copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}</Button>
      </div>
      <p className="text-xs text-text-muted mt-3">Use it to verify the X-Nomus-Signature header on every delivery.</p>
      <div className="flex justify-end mt-4"><Button onClick={onClose}>I have copied it</Button></div>
    </Modal>
  );
}

/** Rotate a secret: a webhook gets a new generated one; a Jira integration takes a new API token. */
export function RotateModal({ integration, onClose, onRotated }: {
  integration: Integration;
  onClose: () => void;
  onRotated: (result: IntegrationWithSecret) => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jira = integration.kind === 'jira';
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onRotated(await rotateIntegrationSecret(integration.id, jira ? token : undefined));
    } catch (err) {
      setError(cpgErrorMessage(err, `Failed to rotate the ${secretLabel(integration.kind)?.toLowerCase()}`));
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={jira ? `Replace the API token of ${integration.name}` : `Rotate the signing secret of ${integration.name}`}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {jira ? (
          <Field id="rotate-token" label="New API token *" hint="Stored encrypted. It is used from the next delivery.">
            <input id="rotate-token" type="password" autoComplete="off" required value={token} onChange={(e) => setToken(e.target.value)} className={`${inputCls} font-mono`} />
          </Field>
        ) : (
          <p className="text-sm text-text-secondary">Nomus generates a new secret and shows it once. Deliveries are signed with it from their next attempt, so accept both secrets on your side while you switch.</p>
        )}
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || (jira && token.length < 8)}>{busy ? 'Working...' : jira ? 'Replace token' : 'Rotate secret'}</Button>
        </div>
      </form>
    </Modal>
  );
}
