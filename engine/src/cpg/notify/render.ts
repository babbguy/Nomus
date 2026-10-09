import { escapeHtml } from '../../services/notifications.js';
import { signPayloadV2 } from '../../services/webhook-dispatcher.js';
import type { CaseNotificationSummary, CpgEvent } from './summary.js';

/**
 * Renderers (design spec §12.3). Each takes only a parsed
 * CaseNotificationSummary, so nothing but its allow-listed fields can reach
 * an email, a Jira issue or a webhook (§12.6).
 */

type Summary = CaseNotificationSummary;

const HEADLINES: Record<CpgEvent, string> = {
  'case.review_requested': 'needs review',
  'case.changes_requested': 'changes requested',
  'case.replied': 'developer replied',
  'decision.recorded': 'decision recorded',
  'case.closed': 'closed',
  'exception.expiring': 'approval expiring',
  'exception.expired': 'approval expired',
  'integration.test': 'test notification',
};

const NOT_COPIED = 'Code, snippets and justifications are held in Nomus and are not copied here. Open Nomus to see them (sign-in and permission required).';

/** The plain-text lines every channel shows, in order. */
function lines(s: Summary): string[] {
  const out: string[] = [];
  const c = s.case;
  if (c) out.push(`Case ${c.ref}: ${c.repo} @ ${c.branch}${c.prNumber === null ? '' : ` (PR #${c.prNumber})`}, state ${c.state.replace('_', ' ')}, revision ${c.revision}`);
  if (s.board) out.push(`Board: ${s.board.name}`);
  if (s.counts) {
    const k = s.counts;
    out.push(`Blocking findings: ${k.blocking} (prohibited ${k.byTier.prohibited}, review-required ${k.byTier['review-required']}) in ${k.files} file${k.files === 1 ? '' : 's'}`);
    out.push(`Approved ${k.approved}, rejected ${k.rejected}, excepted ${k.excepted}, advisory ${k.advisory}`);
  }
  for (const p of s.policies) out.push(`Policy ${p.key} v${p.version}: ${p.title} (${p.tier})`);
  if (s.decision) {
    const d = s.decision;
    out.push(`Decision: ${d.outcome} (${d.scope}, ${d.findingCount} finding${d.findingCount === 1 ? '' : 's'})${d.expiresAt ? `, expires ${d.expiresAt}` : ''}`);
  }
  return out;
}

export function subjectOf(s: Summary): string {
  const where = s.case ? `${s.case.ref} ${HEADLINES[s.event]}: ${s.case.repo} @ ${s.case.branch}` : `${HEADLINES[s.event]} (${s.org.name})`;
  return `[Nomus] ${where}${s.board ? ` (${s.board.name})` : ''}`.slice(0, 250);
}

export function renderEmail(s: Summary): { subject: string; html: string; text: string } {
  const body = lines(s);
  const html = [
    ...body.map((l) => `<p style="margin:0 0 8px;">${escapeHtml(l)}</p>`),
    `<p style="margin:16px 0;"><a href="${escapeHtml(s.link)}" style="color:#dbf227;">Open in Nomus</a></p>`,
    `<p style="margin:0;font-size:12px;color:#9ca3af;">${escapeHtml(NOT_COPIED)}</p>`,
  ].join('\n');
  return { subject: subjectOf(s), html, text: [...body, `Open in Nomus: ${s.link}`, NOT_COPIED].join('\n') };
}

// ─── Jira (Atlassian Document Format) ─────────────────────────────────

const text = (t: string, href?: string) => ({ type: 'text', text: t, ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) });
const paragraph = (...content: object[]) => ({ type: 'paragraph', content });

function adf(s: Summary) {
  return {
    type: 'doc', version: 1,
    content: [
      paragraph(text(subjectOf(s))),
      { type: 'bulletList', content: lines(s).map((l) => ({ type: 'listItem', content: [paragraph(text(l))] })) },
      paragraph(text('Open in Nomus', s.link)),
      paragraph(text(NOT_COPIED)),
    ],
  };
}

/** The label that finds a lane's issue again (idempotent create, §12.3). */
export function jiraLabel(s: Summary): string {
  return s.case && s.board ? `nomus-${s.case.ref.toLowerCase()}-${s.board.id.slice(0, 8)}` : 'nomus-test';
}

export function renderJiraIssue(s: Summary, cfg: { projectKey: string; issueType: string; labels: string[] }) {
  return {
    fields: {
      project: { key: cfg.projectKey },
      issuetype: { name: cfg.issueType },
      summary: subjectOf(s),
      labels: [...new Set([...cfg.labels, 'nomus-cpg', jiraLabel(s)])],
      description: adf(s),
    },
  };
}

export function renderJiraComment(s: Summary) {
  return { body: adf(s) };
}

// ─── Webhook ──────────────────────────────────────────────────────────

/**
 * The body is the summary itself. The signature is HMAC-SHA256 over
 * `timestamp.body` (D13), recomputed for every attempt with a fresh
 * timestamp; the delivery id stays the same.
 */
export function renderWebhook(s: Summary, secret: string, timestamp: string): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(s);
  const signature = `sha256=${signPayloadV2(timestamp, body, secret)}`;
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Nomus/1.2',
      'X-Nomus-Event': s.event,
      'X-Nomus-Delivery-Id': s.deliveryId,
      'X-Nomus-Timestamp': timestamp,
      'X-Nomus-Signature': signature,
      'X-Nomus-Signature-V2': signature,
    },
  };
}
