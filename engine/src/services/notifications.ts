import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { platformSettings } from '../db/schema.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { decryptFromStorage } from '../core/crypto.js';

// ─── Settings Cache (same pattern as llm/provider.ts) ────────

let _cache: Map<string, string> | null = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000;

function getSettings(): Map<string, string> {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) return _cache;
  try {
    const db = getDb();
    const rows = db.select().from(platformSettings).all();
    _cache = new Map(rows.map((r) => [r.key, r.value]));
  } catch {
    _cache = new Map();
  }
  _cacheTime = now;
  return _cache;
}

function getSetting(key: string, fallback: string = ''): string {
  return getSettings().get(key) ?? fallback;
}

export function invalidateNotificationCache(): void {
  _cache = null;
  _cacheTime = 0;
}

// ─── Channel Config ──────────────────────────────────────────

function isEmailEnabled(): boolean {
  return getSetting('notification.email.enabled', 'false') === 'true';
}

function isSmsEnabled(): boolean {
  return getSetting('notification.sms.enabled', 'false') === 'true';
}

function getEmailRecipients(): string[] {
  try {
    const json = getSetting('notification.email.recipients', '[]');
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const fallback = env().NOMUS_NOTIFICATION_EMAIL ?? env().NOMUS_ADMIN_EMAIL;
    return fallback ? [fallback] : [];
  }
}

export function getPushTopics(): string[] {
  try {
    const json = getSetting('notification.push.topics', '[]');
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const fallback = env().NOMUS_NTFY_TOPIC;
    return fallback ? [fallback] : [];
  }
}

type EventChannel = 'email+sms' | 'email' | 'sms' | 'none';

function getEventChannel(event: string): EventChannel {
  const defaults: Record<string, EventChannel> = {
    'notification.on.pipeline_success': 'email',
    'notification.on.pipeline_error': 'email+sms',
    'notification.on.scout_review': 'email',
    'notification.on.scout_signal': 'email+sms',
  };
  return (getSetting(event, defaults[event] ?? 'none')) as EventChannel;
}

function shouldEmail(event: string): boolean {
  if (!isEmailEnabled()) return false;
  const ch = getEventChannel(event);
  return ch === 'email' || ch === 'email+sms';
}

function shouldPush(event: string): boolean {
  const enabled = getSetting('notification.push.enabled', 'false') === 'true';
  if (!enabled) return false;
  const ch = getEventChannel(event);
  return ch === 'sms' || ch === 'email+sms'; // "sms" channel now routes to push
}

function shouldSlack(): boolean {
  const url = getSetting('notification.slack.webhook_url', '') || env().NOMUS_SLACK_WEBHOOK_URL;
  return !!url;
}

/**
 * Which alert channels can actually DELIVER right now (G4, 2026-07-25).
 * Empty array = every tier-2/3 scraper event, pipeline failure, and pending-
 * amendment warning decays to a log line nobody is watching. The scheduler
 * checks this at startup and complains loudly.
 */
export function getConfiguredAlertChannels(): string[] {
  const channels: string[] = [];
  if (isEmailEnabled() && isEmailConfigured()) channels.push('email');
  if (getSetting('notification.push.enabled', 'false') === 'true' && getPushTopics().length > 0) {
    channels.push('push');
  }
  if (shouldSlack()) channels.push('slack');
  return channels;
}

// ─── Email (Resend) ──────────────────────────────────────────

/**
 * Whether this instance can deliver email at all (a Resend API key is
 * configured via platform settings or env). uses this to REJECT
 * email reliance-subscription creation up front instead of silently
 * accepting subscriptions that could never be notified.
 */
export function isEmailConfigured(): boolean {
  return !!getResendApiKey();
}

/**
 * The Resend API key: the one saved on the Notifications page (stored
 * encrypted, so it must be decrypted — it was sent as the ciphertext and every
 * email failed) or NOMUS_RESEND_API_KEY. Used for alerts, invitations and
 * password resets alike.
 */
export function getResendApiKey(): string | undefined {
  const stored = getSetting('notification.apiKeys.resend', '');
  if (stored) {
    try {
      return decryptFromStorage(stored);
    } catch {
      return stored; // saved before keys were encrypted
    }
  }
  return env().NOMUS_RESEND_API_KEY || undefined;
}

/** The Resend send-email endpoint (NOMUS_RESEND_API_URL, default https://api.resend.com). */
export function resendEndpoint(): string {
  return `${env().NOMUS_RESEND_API_URL.replace(/\/+$/, '')}/emails`;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  /** Body HTML; wrapped in the Nomus email layout. */
  html: string;
  text?: string;
  /** Sent as Resend's Idempotency-Key, so a retried send is delivered once. */
  idempotencyKey?: string;
}

/** What Resend answered: the HTTP status (null when no response) and the error or response excerpt. */
export interface EmailResult { status: number | null; error: string | null; excerpt: string | null }

/** Send one email through Resend and report exactly what happened. Never throws. */
export async function sendEmailDetailed(msg: EmailMessage): Promise<EmailResult> {
  const apiKey = getResendApiKey();
  if (!apiKey) return { status: null, error: 'No Resend API key is configured', excerpt: null };
  try {
    const res = await fetch(resendEndpoint(), {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
        ...(msg.idempotencyKey ? { 'Idempotency-Key': msg.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: env().NOMUS_FROM_EMAIL, to: msg.to, subject: msg.subject, html: wrapEmailHtml(msg.subject, msg.html), text: msg.text }),
    });
    const excerpt = (await res.text()).slice(0, 500);
    return res.ok ? { status: res.status, error: null, excerpt } : { status: res.status, error: `Resend answered ${res.status}`, excerpt };
  } catch (err) {
    return { status: null, error: (err as Error).message.slice(0, 500), excerpt: null };
  }
}

export async function sendEmail(to: string[], subject: string, html: string): Promise<boolean> {
  if (!getResendApiKey()) {
    logger.warn('Notification email skipped — no Resend API key');
    return false;
  }
  const result = await sendEmailDetailed({ to, subject, html });
  if (result.error !== null) {
    logger.error({ status: result.status, err: (result.excerpt ?? result.error).slice(0, 200) }, 'Resend email failed');
    return false;
  }
  logger.info({ to, subject }, 'Notification email sent');
  return true;
}

// ─── Push Notifications (ntfy — free, self-hostable) ─────────

export async function sendPush(topics: string[], title: string, body: string, priority?: string): Promise<boolean> {
  const ntfyUrl = getSetting('notification.ntfy.url', '') || env().NOMUS_NTFY_URL || 'https://ntfy.sh';
  const ntfyToken = getSetting('notification.ntfy.token', ''); // Optional access token for private topics

  if (topics.length === 0) {
    logger.warn('Push notification skipped — no topics configured');
    return false;
  }

  let allOk = true;
  for (const topic of topics) {
    try {
      const headers: Record<string, string> = {
        'Title': title,
        'Priority': priority || 'default',
        'Tags': 'shield,nomus',
      };
      if (ntfyToken) {
        headers['Authorization'] = `Bearer ${ntfyToken}`;
      }

      const res = await fetch(`${ntfyUrl.replace(/\/+$/, '')}/${topic}`, {
        method: 'POST',
        headers,
        body,
      });
      if (!res.ok) {
        const err = await res.text();
        logger.error({ status: res.status, topic, err: err.slice(0, 200) }, 'ntfy push failed');
        allOk = false;
      } else {
        logger.info({ topic }, 'Push notification sent via ntfy');
      }
    } catch (err) {
      logger.error({ topic, error: (err as Error).message }, 'ntfy push error');
      allOk = false;
    }
  }
  return allOk;
}

// ─── Slack Webhook ────────────────────────────────────────────

export async function sendSlack(message: string, title?: string): Promise<boolean> {
  const webhookUrl = getSetting('notification.slack.webhook_url', '') || env().NOMUS_SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    logger.warn('Slack notification skipped — webhook URL not configured');
    return false;
  }

  try {
    const payload = {
      text: title ? `*${title}*\n${message}` : message,
      blocks: [
        ...(title ? [{
          type: 'header',
          text: { type: 'plain_text', text: title, emoji: true },
        }] : []),
        {
          type: 'section',
          text: { type: 'mrkdwn', text: message },
        },
      ],
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.text();
      logger.error({ status: res.status, err: err.slice(0, 200) }, 'Slack webhook failed');
      return false;
    }

    logger.info('Slack notification sent');
    return true;
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Slack webhook error');
    return false;
  }
}

// Legacy alias for backward compatibility
export const sendSms = sendPush;

// ─── Event Helpers ───────────────────────────────────────────

export async function notifyPipelineComplete(data: {
  sourceName: string;
  rulesCreated: number;
  rulesUpdated: number;
  durationMs: number;
  llmCostCents: number;
}): Promise<void> {
  const event = 'notification.on.pipeline_success';
  const summary = `${data.sourceName}: ${data.rulesCreated} rules created, ${data.rulesUpdated} updated (${(data.durationMs / 1000).toFixed(1)}s, $${(data.llmCostCents / 100).toFixed(2)})`;

  if (shouldEmail(event)) {
    await sendEmail(getEmailRecipients(),
      `Nomus: Pipeline completed — ${data.sourceName}`,
      `<p><strong>${data.sourceName}</strong> scan completed.</p>
       <table style="border-collapse:collapse;margin:12px 0;">
         <tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Rules created</td><td style="font-weight:600;">${data.rulesCreated}</td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Rules updated</td><td style="font-weight:600;">${data.rulesUpdated}</td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Duration</td><td>${(data.durationMs / 1000).toFixed(1)}s</td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">LLM cost</td><td>$${(data.llmCostCents / 100).toFixed(2)}</td></tr>
       </table>`,
    );
  }

  if (shouldPush(event)) {
    await sendPush(getPushTopics(), `Pipeline: ${data.sourceName}`, summary);
  }

  if (shouldSlack()) {
    await sendSlack(summary, `Pipeline Completed — ${data.sourceName}`);
  }
}

export async function notifyPipelineError(data: {
  sourceName: string;
  stepReached: number;
  errorMessage: string;
}): Promise<void> {
  const event = 'notification.on.pipeline_error';

  if (shouldEmail(event)) {
    await sendEmail(getEmailRecipients(),
      `Nomus: Pipeline FAILED — ${data.sourceName}`,
      `<p style="color:#ef4444;font-weight:600;">Pipeline failed at step ${data.stepReached}</p>
       <p><strong>Source:</strong> ${data.sourceName}</p>
       <p><strong>Error:</strong></p>
       <pre style="background:#1a1a1a;padding:12px;border-radius:6px;color:#f87171;font-size:13px;overflow-x:auto;">${escapeHtml(data.errorMessage.slice(0, 500))}</pre>`,
    );
  }

  if (shouldPush(event)) {
    await sendPush(getPushTopics(),
      `ALERT: Pipeline Failed — ${data.sourceName}`,
      `Pipeline failed at step ${data.stepReached}: ${data.errorMessage.slice(0, 200)}`,
      'urgent',
    );
  }

  if (shouldSlack()) {
    await sendSlack(
      `Pipeline failed at step ${data.stepReached}\n*Source:* ${data.sourceName}\n*Error:* \`${escapeHtml(data.errorMessage.slice(0, 300))}\``,
      `Pipeline FAILED — ${data.sourceName}`,
    );
  }
}

export async function notifyScoutSignal(data: {
  title: string;
  jurisdiction: string;
  stage: string;
  likelihood: number;
  summary: string;
}): Promise<void> {
  const event = 'notification.on.scout_signal';

  if (shouldEmail(event)) {
    await sendEmail(getEmailRecipients(),
      `Nomus Scout: New signal — ${data.title}`,
      `<p><strong>${data.title}</strong></p>
       <table style="border-collapse:collapse;margin:12px 0;">
         <tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Jurisdiction</td><td style="font-weight:600;">${data.jurisdiction}</td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Stage</td><td>${data.stage}</td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Likelihood</td><td>${data.likelihood}%</td></tr>
       </table>
       <p>${escapeHtml(data.summary)}</p>`,
    );
  }

  if (shouldPush(event)) {
    await sendPush(getPushTopics(),
      `Scout Signal: ${data.title}`,
      `${data.jurisdiction} — ${data.stage}, ${data.likelihood}% likelihood`,
      data.likelihood >= 80 ? 'high' : 'default',
    );
  }

  if (shouldSlack()) {
    await sendSlack(
      `*${data.title}*\nJurisdiction: ${data.jurisdiction} | Stage: ${data.stage} | Likelihood: ${data.likelihood}%\n${data.summary.slice(0, 300)}`,
      `Scout Signal — ${data.jurisdiction}`,
    );
  }
}

export async function notifyScoutReviewNeeded(data: {
  itemCount: number;
  titles: string[];
}): Promise<void> {
  const event = 'notification.on.scout_review';

  if (shouldEmail(event)) {
    const list = data.titles.slice(0, 5).map((t) => `<li>${escapeHtml(t)}</li>`).join('');
    const more = data.itemCount > 5 ? `<p style="color:#9ca3af;">...and ${data.itemCount - 5} more</p>` : '';
    await sendEmail(getEmailRecipients(),
      `Nomus Scout: ${data.itemCount} item(s) need review`,
      `<p><strong>${data.itemCount}</strong> Scout item(s) need manual review:</p>
       <ul style="margin:8px 0;padding-left:20px;">${list}</ul>${more}`,
    );
  }
}

export async function notifySchedulerSummary(data: {
  type: 'scrape' | 'scout' | 'audit';
  sourcesProcessed?: number;
  rulesCreated?: number;
  rulesUpdated?: number;
  feedsProcessed?: number;
  itemsNew?: number;
  itemsAutoPromoted?: number;
  sourcesPassed?: number;
  sourcesWarned?: number;
  sourcesFailed?: number;
  totalIssues?: number;
  totalCostCents?: number;
  durationMs: number;
}): Promise<void> {
  // Summaries always go via email only
  if (!isEmailEnabled()) return;

  const subjects: Record<string, string> = {
    scrape: 'Nomus: Nightly scrape summary',
    scout: 'Nomus: Scout cycle summary',
    audit: 'Nomus: Data quality audit summary',
  };
  const subject = subjects[data.type];

  let rows: string;
  if (data.type === 'scrape') {
    const failedRow = (data.sourcesFailed ?? 0) > 0
      ? `<tr><td style="padding:4px 12px 4px 0;color:#ef4444;">Failed</td><td style="color:#ef4444;">${data.sourcesFailed}</td></tr>`
      : '';
    rows = `<tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Sources</td><td>${data.sourcesProcessed ?? 0}</td></tr>
       ${failedRow}
       <tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Rules created</td><td>${data.rulesCreated ?? 0}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Rules updated</td><td>${data.rulesUpdated ?? 0}</td></tr>`;
  } else if (data.type === 'scout') {
    rows = `<tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Feeds</td><td>${data.feedsProcessed ?? 0}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">New items</td><td>${data.itemsNew ?? 0}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Auto-promoted</td><td>${data.itemsAutoPromoted ?? 0}</td></tr>`;
  } else {
    rows = `<tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Sources audited</td><td>${data.sourcesProcessed ?? 0}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#22c55e;">Passed</td><td>${data.sourcesPassed ?? 0}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#eab308;">Warnings</td><td>${data.sourcesWarned ?? 0}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#ef4444;">Failed</td><td>${data.sourcesFailed ?? 0}</td></tr>
       <tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Total issues</td><td>${data.totalIssues ?? 0}</td></tr>`;
  }

  const costRow = data.totalCostCents != null
    ? `<tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">LLM cost</td><td>$${(data.totalCostCents / 100).toFixed(2)}</td></tr>`
    : '';

  await sendEmail(getEmailRecipients(), subject,
    `<table style="border-collapse:collapse;margin:12px 0;">
       ${rows}
       ${costRow}
       <tr><td style="padding:4px 12px 4px 0;color:#9ca3af;">Duration</td><td>${(data.durationMs / 1000).toFixed(1)}s</td></tr>
     </table>`,
  );
}

// ─── Email Template ──────────────────────────────────────────

function wrapEmailHtml(title: string, content: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#181818;font-family:'Inter',system-ui,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
    <div style="margin-bottom:24px;">
      <span style="font-size:18px;font-weight:700;color:#dbf227;">Nomus</span>
      <span style="font-size:12px;color:#6b7280;margin-left:8px;"></span>
    </div>
    <div style="background:#212121;border:1px solid #3a3a3a;border-radius:8px;padding:24px;color:#f0f2f5;font-size:14px;line-height:1.6;">
      ${content}
    </div>
    <p style="margin-top:20px;font-size:11px;color:#6b7280;text-align:center;">
      Nomus is a regulatory monitoring tool. It does not provide legal advice.
    </p>
  </div>
</body></html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
