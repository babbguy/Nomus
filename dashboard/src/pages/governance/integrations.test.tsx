import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { IntegrationCard, TestOutcome } from './GovernanceIntegrations';
import { IntegrationEditor, RotateModal, SecretOnceModal } from './integrations/IntegrationEditor';
import { DeliveryTable } from './integrations/DeliveryLog';
import WebhookHelp from './integrations/WebhookHelp';
import { emptyForm, formFromIntegration, formProblem, inputFromForm, lastError, openFailures, deliveryCaseRef } from '../../lib/cpg-integrations';
import { INTEGRATIONS_REQUIREMENT, meetsRequirement, visibleGovernancePages } from '../../lib/cpg-permissions';
import type { Delivery, Integration } from '../../api/cpg';
import * as fx from '../../test/cpg-fixtures';

const calls: Array<{ method: string; url: string; body?: unknown; params?: unknown }> = [];
let reply: unknown = null;
vi.mock('../../api/client', () => {
  const respond = (method: string) => (url: string, second?: unknown) => {
    calls.push({ method, url, ...(method === 'GET' ? { params: (second as { params?: unknown } | undefined)?.params } : { body: second }) });
    return Promise.resolve({ data: reply });
  };
  return { default: { get: respond('GET'), post: respond('POST'), patch: respond('PATCH') } };
});
const cpg = await import('../../api/cpg');

const T = '2026-10-09T08:00:00.000Z';
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = { boardIds: [], events: ['case.review_requested', 'case.closed'] as Integration['events'], enabled: true, createdBy: 'user:a', createdAt: T, updatedBy: 'user:a', updatedAt: T };
const hook: Integration = { ...base, id: ID(1), kind: 'webhook', name: 'Chat bridge', config: { url: 'https://hooks.example.com/nomus' }, secretLast4: 'a1b2' };
const jira: Integration = {
  ...base, id: ID(2), kind: 'jira', name: 'Jira GOV', boardIds: [fx.BOARD_AI_ID], secretLast4: 'wxyz',
  config: { baseUrl: 'https://example.atlassian.net', accountEmail: 'bot@example.com', projectKey: 'GOV', issueType: 'Task', labels: ['nomus'] },
};
const email: Integration = { ...base, id: ID(3), kind: 'email', name: 'Governance email', config: { includeBoardMembers: true, notifyDevelopers: false, extraRecipients: ['gov@example.com'] }, secretLast4: null };

const delivery = (n: number, over: Partial<Delivery> = {}): Delivery => ({
  id: ID(100 + n), integrationId: hook.id, channel: 'webhook', event: 'case.review_requested', caseId: ID(50), boardId: null,
  payload: { summary: { case: { ref: 'CPG-1A2B3C4D' } } }, payloadSha256: 'a'.repeat(64), retryOf: null, status: 'delivered', attempts: 1,
  nextAttemptAt: null, createdAt: T, updatedAt: T,
  attemptHistory: [{ attempt: 1, startedAt: T, durationMs: 12, httpStatus: 200, error: null, responseExcerpt: 'ok' }],
  ...over,
});
const failed = delivery(1, { status: 'failed', attempts: 1, attemptHistory: [{ attempt: 1, startedAt: T, durationMs: 9, httpStatus: 400, error: 'HTTP 400', responseExcerpt: 'bad' }] });
const pending = delivery(2, {
  status: 'pending', attempts: 2, nextAttemptAt: '2026-10-09T09:30:00.000Z',
  attemptHistory: [{ attempt: 1, startedAt: T, durationMs: 9, httpStatus: 503, error: 'HTTP 503', responseExcerpt: '' }, { attempt: 2, startedAt: T, durationMs: 9, httpStatus: null, error: 'connect ECONNREFUSED', responseExcerpt: null }],
});

function text(node: React.ReactElement): string {
  const html = renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}
const clean = (t: string) => { for (const re of fx.BROKEN) expect(t).not.toMatch(re); };
const noop = () => {};

beforeEach(() => { calls.length = 0; reply = null; });

describe('integrations API client', () => {
  it('calls the documented endpoints with their bodies', async () => {
    reply = { items: [hook] };
    expect(await cpg.listIntegrations()).toEqual([hook]);
    reply = { integration: hook, secret: 'whsec_abcdefa1b2' };
    const created = await cpg.createIntegration(inputFromForm({ ...emptyForm('webhook'), name: 'Chat bridge', url: 'https://hooks.example.com/nomus' }));
    expect(created.secret).toBe('whsec_abcdefa1b2');
    await cpg.rotateIntegrationSecret(hook.id);
    reply = { integration: jira };
    await cpg.rotateIntegrationSecret(jira.id, 'new-token-1234');
    reply = hook;
    await cpg.updateIntegration(hook.id, { enabled: false });
    reply = delivery(1);
    await cpg.testIntegration(hook.id);
    await cpg.retryDelivery(failed.id);
    reply = { items: [delivery(1)], nextCursor: '7' };
    expect((await cpg.listDeliveries({ status: 'failed', limit: 200, cursor: '9' })).nextCursor).toBe('7');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /cpg/integrations', 'POST /cpg/integrations', `POST /cpg/integrations/${hook.id}/rotate-secret`, `POST /cpg/integrations/${jira.id}/rotate-secret`,
      `PATCH /cpg/integrations/${hook.id}`, `POST /cpg/integrations/${hook.id}/test`, `POST /cpg/deliveries/${failed.id}/retry`, 'GET /cpg/deliveries',
    ]);
    expect(calls[1].body).toMatchObject({ kind: 'webhook', name: 'Chat bridge', boardIds: [], config: { url: 'https://hooks.example.com/nomus' } });
    expect(calls[2].body).toEqual({});
    expect(calls[3].body).toEqual({ apiToken: 'new-token-1234' });
    expect(calls[7].params).toEqual({ status: 'failed', limit: 200, cursor: '9' });
  });

  it('refuses a response that carries a secret in an integration or drifts from the contract', async () => {
    reply = { items: [{ ...hook, secret: 'whsec_leak' }] };
    await expect(cpg.listIntegrations()).rejects.toBeInstanceOf(cpg.CpgContractError);
    reply = { ...delivery(1), status: 'sent' };
    await expect(cpg.testIntegration(hook.id)).rejects.toThrow(/POST \/cpg\/integrations\/:id\/test \(status/);
    reply = { items: [delivery(1)] };
    await expect(cpg.listDeliveries()).rejects.toThrow(/GET \/cpg\/deliveries/);
  });
});

describe('integration form helpers', () => {
  it('builds the create body of each kind', () => {
    expect(inputFromForm({ ...emptyForm('email'), name: ' Mail ', extraRecipients: 'a@example.com, b@example.com' }).config)
      .toEqual({ includeBoardMembers: true, notifyDevelopers: true, extraRecipients: ['a@example.com', 'b@example.com'] });
    const j = inputFromForm({ ...emptyForm('jira'), name: 'J', baseUrl: ' https://example.atlassian.net ', accountEmail: 'bot@example.com', projectKey: 'gov', apiToken: 'token-12345' });
    expect(j).toMatchObject({ kind: 'jira', apiToken: 'token-12345', config: { baseUrl: 'https://example.atlassian.net', projectKey: 'GOV', issueType: 'Task', labels: ['nomus'] } });
    expect(inputFromForm({ ...emptyForm('webhook'), name: 'W', url: 'https://h.example.com/x' })).not.toHaveProperty('apiToken');
  });

  it('round-trips an integration into a form and never puts the test event in the picker', () => {
    expect(formFromIntegration({ ...jira, events: [...jira.events, 'integration.test'] })).toMatchObject({ kind: 'jira', projectKey: 'GOV', baseUrl: 'https://example.atlassian.net', boardIds: [fx.BOARD_AI_ID], events: jira.events });
    expect(formFromIntegration(email)).toMatchObject({ notifyDevelopers: false, extraRecipients: 'gov@example.com' });
  });

  it('says what is missing before saving', () => {
    expect(formProblem(emptyForm('webhook'), false)).toBe('Enter a name.');
    expect(formProblem({ ...emptyForm('webhook'), name: 'W' }, false)).toBe('Enter the webhook URL.');
    expect(formProblem({ ...emptyForm('webhook'), name: 'W', url: 'https://h.example.com', events: [] }, false)).toBe('Choose at least one event.');
    expect(formProblem({ ...emptyForm('jira'), name: 'J', baseUrl: 'https://x.atlassian.net', accountEmail: 'a@example.com', projectKey: 'GOV' }, false)).toMatch(/API token/);
    expect(formProblem({ ...formFromIntegration(jira) }, true)).toBeNull();
  });
});

describe('delivery helpers', () => {
  it('lists only failures nobody has retried', () => {
    const retry = delivery(3, { retryOf: failed.id });
    expect(openFailures([retry, failed, pending]).map((d) => d.id)).toEqual([]);
    expect(openFailures([failed, pending]).map((d) => d.id)).toEqual([failed.id]);
  });

  it('reads the last error and the case reference', () => {
    expect(lastError(failed)).toBe('HTTP 400');
    expect(lastError(pending)).toBe('connect ECONNREFUSED');
    expect(lastError(delivery(4))).toBeNull();
    expect(lastError(delivery(5, { attemptHistory: [] }))).toBeNull();
    expect(deliveryCaseRef(delivery(6))).toBe('CPG-1A2B3C4D');
    expect(deliveryCaseRef(delivery(7, { payload: { summary: { case: null } } }))).toBeNull();
  });
});

describe('integrations page views', () => {
  it('shows a webhook with its masked secret and never a secret value', () => {
    const t = text(<IntegrationCard integration={hook} boards={fx.boards} onTest={noop} onEdit={noop} onRotate={noop} onToggle={noop} />);
    expect(t).toContain('Chat bridge');
    expect(t).toContain('https://hooks.example.com/nomus');
    expect(t).toContain('••••a1b2');
    expect(t).toContain('Every board');
    expect(t).toContain('Review requested, Case closed');
    expect(t).toContain('Rotate secret');
    expect(t).not.toContain('whsec_');
    clean(t);
  });

  it('shows Jira with its board and token mask, and email without a secret', () => {
    const j = text(<IntegrationCard integration={jira} boards={fx.boards} onTest={noop} onEdit={noop} onRotate={noop} onToggle={noop} />);
    expect(j).toContain('https://example.atlassian.net');
    expect(j).toMatch(/Project\s+GOV/);
    expect(j).toContain('AI Review Board');
    expect(j).toContain('API token');
    expect(j).toContain('••••wxyz');
    expect(j).toContain('Replace token');
    const e = text(<IntegrationCard integration={email} boards={fx.boards} onTest={noop} onEdit={noop} onRotate={noop} onToggle={noop} />);
    expect(e).toContain('board members, 1 extra recipient');
    expect(e).not.toContain('Rotate');
    expect(e).not.toContain('Signing secret');
  });

  it('disables Send test on a disabled integration and offers Enable', () => {
    const html = renderToStaticMarkup(<IntegrationCard integration={{ ...hook, enabled: false }} boards={[]} onTest={noop} onEdit={noop} onRotate={noop} onToggle={noop} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Send a test through Chat bridge"/);
    expect(html).toContain('>Enable<');
    expect(html).toContain('Disabled');
  });

  it('reports a test inline: delivered, queued with the next retry in UTC, failed, and a request error', () => {
    expect(text(<TestOutcome test={delivery(1)} />)).toContain('Test delivered on attempt 1.');
    expect(text(<TestOutcome test={pending} />)).toContain('Test not delivered yet: connect ECONNREFUSED. Nomus will retry at Oct 9, 2026, 09:30 UTC.');
    expect(text(<TestOutcome test={failed} />)).toContain('Test failed: HTTP 400.');
    expect(text(<TestOutcome test={{ error: 'Enable the integration before testing it' }} />)).toContain('Enable the integration before testing it');
    expect(text(<TestOutcome test="sending" />)).toContain('Sending a test...');
  });

  it('lists deliveries with status, attempts, last error, next retry and a Retry only on an unretried failure', () => {
    const retried = delivery(8, { status: 'failed', attemptHistory: failed.attemptHistory, retryOf: null });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DeliveryTable items={[failed, pending, delivery(3), retried]} integrations={new Map([[hook.id, hook]])} retriedIds={new Set([retried.id])} canRetry onRetry={noop} />
      </MemoryRouter>,
    );
    const t = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const s of ['Failed', 'Pending', 'Delivered', 'HTTP 400', 'connect ECONNREFUSED', 'Oct 9, 2026, 09:30 UTC', 'Chat bridge', 'CPG-1A2B3C4D', 'Retried']) expect(t).toContain(s);
    expect(html.match(/>Retry</g)).toHaveLength(1);
    clean(t);
  });

  it('shows the webhook help with the exact headers, body and signature recipe', () => {
    const t = text(<WebhookHelp />);
    for (const s of ['X-Nomus-Signature: sha256=', 'X-Nomus-Timestamp', '"event": "case.review_requested"', "timingSafeEqual", 'timestamp + \'.\' + rawBody', 'Read the full reference']) expect(t).toContain(s);
    expect(renderToStaticMarkup(<WebhookHelp />)).toContain('integrations.md');
  });

  it('shows the secret once with a copy-now warning', () => {
    const t = renderToStaticMarkup(<SecretOnceModal name="Chat bridge" secret="whsec_example123" onClose={noop} />);
    expect(t).toContain('Copy it now. This secret is shown only once');
    expect(t).toContain('value="whsec_example123"');
    expect(t).toContain('I have copied it');
  });

  it('renders the editor for a new webhook, an edited Jira (no token field) and the rotate dialogs', () => {
    const add = renderToStaticMarkup(<IntegrationEditor integration={null} boards={fx.boards} onClose={noop} onSaved={noop} />);
    expect(add).toContain('Add an integration');
    expect(add).toContain('Webhook URL *');
    expect(add).toContain('AI Review Board');
    expect(add).toContain('No board selected: notifications for every board are sent.');
    expect(add).toContain('Enter a name.');
    const edit = renderToStaticMarkup(<IntegrationEditor integration={jira} boards={fx.boards} onClose={noop} onSaved={noop} />);
    expect(edit).toContain('Edit Jira GOV');
    expect(edit).not.toContain('id="int-token"');
    expect(renderToStaticMarkup(<RotateModal integration={jira} onClose={noop} onRotated={noop} />)).toContain('New API token *');
    expect(renderToStaticMarkup(<RotateModal integration={hook} onClose={noop} onRotated={noop} />)).toContain('shows it once');
  });
});

describe('integrations page access', () => {
  it('needs integrations.manage and appears in the sidebar list only for holders', () => {
    const admin = fx.me({ permissions: [{ key: 'integrations.manage', scope: 'org', scopeId: null }] });
    expect(meetsRequirement(admin, INTEGRATIONS_REQUIREMENT)).toBe(true);
    expect(visibleGovernancePages(admin).map((p) => p.to)).toContain('/governance/integrations');
    const developer = fx.me({ permissions: [{ key: 'policy.read', scope: 'org', scopeId: null }] });
    expect(meetsRequirement(developer, INTEGRATIONS_REQUIREMENT)).toBe(false);
    expect(visibleGovernancePages(developer).map((p) => p.to)).not.toContain('/governance/integrations');
  });
});
