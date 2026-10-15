import type { CpgEvent, Delivery, Integration, IntegrationInput, IntegrationKind } from '../api/cpg';

/** Pure helpers for the integrations page: labels, the editor form and the delivery log. No React, no network. */

export const KIND_LABELS: Record<IntegrationKind, string> = { email: 'Email', jira: 'Jira', webhook: 'Webhook' };

/** The events a user can subscribe to (`integration.test` is sent by the Test button and needs no subscription). */
export const EVENT_OPTIONS: Array<{ value: CpgEvent; label: string }> = [
  { value: 'case.review_requested', label: 'Review requested' },
  { value: 'case.changes_requested', label: 'Changes requested' },
  { value: 'case.replied', label: 'Reply on a case' },
  { value: 'decision.recorded', label: 'Decision recorded' },
  { value: 'case.closed', label: 'Case closed' },
  { value: 'exception.expiring', label: 'Exception expiring' },
  { value: 'exception.expired', label: 'Exception expired' },
];
const EVENT_LABELS = new Map<string, string>([...EVENT_OPTIONS.map((e) => [e.value, e.label] as const), ['integration.test', 'Test']]);
export const eventLabel = (event: string) => EVENT_LABELS.get(event) ?? event;

export interface IntegrationForm {
  kind: IntegrationKind;
  name: string;
  enabled: boolean;
  events: CpgEvent[];
  boardIds: string[];
  includeBoardMembers: boolean;
  notifyDevelopers: boolean;
  extraRecipients: string;
  baseUrl: string;
  accountEmail: string;
  projectKey: string;
  issueType: string;
  labels: string;
  apiToken: string;
  url: string;
}

export function emptyForm(kind: IntegrationKind): IntegrationForm {
  return {
    kind, name: '', enabled: true, events: ['case.review_requested', 'case.changes_requested'], boardIds: [],
    includeBoardMembers: true, notifyDevelopers: true, extraRecipients: '',
    baseUrl: '', accountEmail: '', projectKey: '', issueType: 'Task', labels: 'nomus', apiToken: '', url: '',
  };
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
export const splitList = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export function formFromIntegration(i: Integration): IntegrationForm {
  const c = i.config;
  return {
    ...emptyForm(i.kind), name: i.name, enabled: i.enabled, events: i.events.filter((e) => e !== 'integration.test'), boardIds: i.boardIds,
    includeBoardMembers: c.includeBoardMembers !== false, notifyDevelopers: c.notifyDevelopers !== false, extraRecipients: list(c.extraRecipients).join(', '),
    baseUrl: text(c.baseUrl), accountEmail: text(c.accountEmail), projectKey: text(c.projectKey), issueType: text(c.issueType) || 'Task',
    labels: list(c.labels).join(', '), url: text(c.url),
  };
}

export function configFromForm(f: IntegrationForm): Record<string, unknown> {
  if (f.kind === 'email') return { includeBoardMembers: f.includeBoardMembers, notifyDevelopers: f.notifyDevelopers, extraRecipients: splitList(f.extraRecipients) };
  if (f.kind === 'jira') {
    return { baseUrl: f.baseUrl.trim(), accountEmail: f.accountEmail.trim(), projectKey: f.projectKey.trim().toUpperCase(), issueType: f.issueType.trim() || 'Task', labels: splitList(f.labels) };
  }
  return { url: f.url.trim() };
}

export function inputFromForm(f: IntegrationForm): IntegrationInput {
  return {
    kind: f.kind, name: f.name.trim(), boardIds: f.boardIds, events: f.events, enabled: f.enabled, config: configFromForm(f),
    ...(f.kind === 'jira' ? { apiToken: f.apiToken } : {}),
  };
}

/** Why the form cannot be saved yet (null when it can). The server still validates everything. */
export function formProblem(f: IntegrationForm, editing: boolean): string | null {
  if (!f.name.trim()) return 'Enter a name.';
  if (f.events.length === 0) return 'Choose at least one event.';
  if (f.kind === 'webhook' && !f.url.trim()) return 'Enter the webhook URL.';
  if (f.kind === 'jira') {
    if (!f.baseUrl.trim() || !f.accountEmail.trim() || !f.projectKey.trim()) return 'Enter the Jira site URL, account email and project key.';
    if (!editing && f.apiToken.length < 8) return 'Enter the Jira API token (at least 8 characters).';
  }
  return null;
}

/** What an integration's secret is called, or null when it has none. */
export const secretLabel = (kind: IntegrationKind) => (kind === 'jira' ? 'API token' : kind === 'webhook' ? 'Signing secret' : null);

/** The last attempt's failure in words (HTTP status or error), or null when there is none. */
export function lastError(d: Delivery): string | null {
  const a = d.attemptHistory[d.attemptHistory.length - 1];
  if (!a || (a.error === null && (a.httpStatus === null || a.httpStatus < 400))) return null;
  return a.error ?? `HTTP ${a.httpStatus}`;
}

/** The case reference carried in a delivery's stored summary, if it has one. */
export function deliveryCaseRef(d: Delivery): string | null {
  const ref = ((d.payload as { summary?: { case?: { ref?: unknown } | null } } | null)?.summary?.case)?.ref;
  return typeof ref === 'string' ? ref : null;
}

/** Failed deliveries nobody has retried yet: a retry is a new delivery that names the failed one. */
export function openFailures(items: readonly Delivery[]): Delivery[] {
  const retried = new Set(items.map((d) => d.retryOf).filter(Boolean));
  return items.filter((d) => d.status === 'failed' && !retried.has(d.id));
}

/** The webhook headers and payload, shown as help, with the secret placeholder named plainly. */
export const WEBHOOK_HEADERS = `POST <your URL>
Content-Type: application/json
X-Nomus-Event: case.review_requested
X-Nomus-Delivery-Id: <uuid, the same on every attempt>
X-Nomus-Timestamp: <ISO-8601 UTC, new on every attempt>
X-Nomus-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>`;

export const WEBHOOK_PAYLOAD = `{
  "event": "case.review_requested",
  "deliveryId": "<uuid>",
  "occurredAt": "<ISO-8601 UTC>",
  "org": { "id": "<uuid>", "slug": "example", "name": "Example Org" },
  "case": { "id": "<uuid>", "ref": "CPG-1A2B3C4D", "repo": "example/payments", "branch": "feat/llm-gateway",
            "prNumber": 42, "state": "in_review", "revision": 1, "url": "<link to the case>" },
  "board": { "id": "<uuid>", "name": "AI Review Board" },
  "counts": { "blocking": 2, "advisory": 0, "approved": 0, "rejected": 0, "excepted": 0,
              "byTier": { "review-required": 1, "prohibited": 1 }, "files": 2 },
  "policies": [ { "key": "corp.no-direct-openai", "version": 2, "title": "...", "tier": "prohibited" } ],
  "decision": null,
  "link": "<link to the case>"
}`;

export const WEBHOOK_VERIFY = `const expected = 'sha256=' + crypto.createHmac('sha256', secret)
  .update(timestamp + '.' + rawBody).digest('hex');
// compare with X-Nomus-Signature in constant time (crypto.timingSafeEqual),
// reject if the timestamp is more than 300 seconds from your clock,
// and ignore a delivery id you have already processed.`;
