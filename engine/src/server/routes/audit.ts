import { Hono } from 'hono';
import { eq, and, gte, desc, isNull, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { attestationReceipts, policyRules } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { getPublicKey } from '../../core/signing.js';
import {
  deriveAttestationStatus,
  buildSignedReceiptPayload,
  verifyReceiptSignature,
  verificationInstructions,
  SIGNED_PAYLOAD_DESCRIPTION,
} from '../../core/attestation-lifecycle.js';
import { notifyAttestationStatusChange } from '../../services/attestation-notifier.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import { safeParseInt, safeJson } from '../utils.js';

export const auditRoutes = new Hono<AppEnv>();

auditRoutes.use('*', requireSessionOrApiKey('read:policies'));
auditRoutes.use('*', rateLimit());

// List attestation receipts
auditRoutes.get('/', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const since = c.req.query('since');
  const result = c.req.query('result');
  const limit = Math.min(safeParseInt(c.req.query('limit'), 50), 200);

  const conditions = [eq(attestationReceipts.orgId, orgId)];
  if (since) conditions.push(gte(attestationReceipts.evaluatedAt, since));
  if (result) conditions.push(eq(attestationReceipts.result, result as 'compliant' | 'non_compliant' | 'requires_review'));

  const receipts = db.select().from(attestationReceipts)
    .where(and(...conditions))
    .orderBy(desc(attestationReceipts.evaluatedAt))
    .limit(limit)
    .all();

  const now = new Date().toISOString();
  return c.json({
    count: receipts.length,
    attestations: receipts.map((r) => {
      let actionContext: unknown;
      let rulesEvaluated: unknown;
      try { actionContext = JSON.parse(r.actionContext); } catch { actionContext = r.actionContext; }
      try { rulesEvaluated = JSON.parse(r.rulesEvaluated); } catch { rulesEvaluated = r.rulesEvaluated; }
      return { ...r, actionContext, rulesEvaluated, status: deriveAttestationStatus(r, now) };
    }),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Get single attestation
auditRoutes.get('/:id', (c) => {
  const db = getDb();
  const receipt = db.select().from(attestationReceipts)
    .where(eq(attestationReceipts.id, c.req.param('id')))
    .get();

  if (!receipt) return c.json({ error: 'Attestation not found' }, 404);

  // Verify org ownership
  if (receipt.orgId !== c.get('orgId')) {
    return c.json({ error: 'Not found' }, 404);
  }

  return c.json({
    ...receipt,
    actionContext: JSON.parse(receipt.actionContext),
    rulesEvaluated: JSON.parse(receipt.rulesEvaluated),
    status: deriveAttestationStatus(receipt, new Date().toISOString()),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Independently verify attestation signature + lifecycle status.
// signatureValid and status are ALWAYS reported together — a revoked
// attestation keeps a valid signature but must never read as clean.
auditRoutes.get('/:id/verify', (c) => {
  const db = getDb();
  const receipt = db.select().from(attestationReceipts)
    .where(and(eq(attestationReceipts.id, c.req.param('id')), eq(attestationReceipts.orgId, c.get('orgId')!)))
    .get();

  if (!receipt) return c.json({ error: 'Attestation not found' }, 404);

  const checkedAt = new Date().toISOString();
  const valid = verifyReceiptSignature(receipt);

  return c.json({
    attestationId: receipt.id,
    signatureValid: valid,
    status: deriveAttestationStatus(receipt, checkedAt),
    result: receipt.result,
    evaluatedAt: receipt.evaluatedAt,
    expiresAt: receipt.expiresAt,
    revokedAt: receipt.revokedAt,
    revocationReason: receipt.revocationReason,
    supersededBy: receipt.supersededBy,
    policyStateHash: receipt.policyStateHash,
    checkedAt,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// ─── Revoke ─────────────────────────────────────────────
//
// POST /api/v1/attestations/:id/revoke { reason }
// - requires the 'evaluate' (or 'admin') scope: revocation is a write on
//   attestation state, so a read-only key must not be able to do it.
//   Portal sessions carry 'evaluate' by default.
// - idempotent: revoking an already-revoked attestation returns the ORIGINAL
//   revocation unchanged (immutable once set — reason and timestamp can
//   never be rewritten), and does NOT re-fire notifications.
// - cross-org: 403 (the caller is authenticated; this is a permission error,
//   and attestation existence is already public via /api/v1/verify).

const revokeSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

auditRoutes.post('/:id/revoke', async (c) => {
  const scopes = c.get('scopes') ?? [];
  if (!scopes.includes('evaluate') && !scopes.includes('admin')) {
    return c.json({ error: 'Insufficient permissions. Required: evaluate' }, 403);
  }

  const db = getDb();
  const receipt = db.select().from(attestationReceipts)
    .where(eq(attestationReceipts.id, c.req.param('id')))
    .get();
  if (!receipt) return c.json({ error: 'Attestation not found' }, 404);
  if (receipt.orgId !== c.get('orgId')) {
    return c.json({ error: 'Attestation belongs to another organization' }, 403);
  }

  // Idempotent + immutable: an existing revocation is never modified
  if (receipt.revokedAt) {
    return c.json({
      attestationId: receipt.id,
      status: 'revoked',
      revokedAt: receipt.revokedAt,
      revocationReason: receipt.revocationReason,
      alreadyRevoked: true,
      _disclaimer: LEGAL_DISCLAIMER,
    });
  }

  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = revokeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'A revocation reason is required (3-500 characters)', details: parsed.error.issues }, 400);
  }

  const revokedAt = new Date().toISOString();
  // Guarded write: WHERE revoked_at IS NULL makes first-write-wins explicit
  // even under concurrent revocations — the revocation is immutable once set.
  const updated = db.update(attestationReceipts)
    .set({ revokedAt, revocationReason: parsed.data.reason })
    .where(and(
      eq(attestationReceipts.id, receipt.id),
      isNull(attestationReceipts.revokedAt),
    ))
    .run();

  if (updated.changes === 0) {
    // Lost a race with another revocation — return the winner's record
    const current = db.select().from(attestationReceipts)
      .where(eq(attestationReceipts.id, receipt.id)).get()!;
    return c.json({
      attestationId: current.id,
      status: 'revoked',
      revokedAt: current.revokedAt,
      revocationReason: current.revocationReason,
      alreadyRevoked: true,
      _disclaimer: LEGAL_DISCLAIMER,
    });
  }

  // Notify reliance subscriptions (signed webhooks + email); fire-and-forget
  const updatedReceipt = db.select().from(attestationReceipts)
    .where(eq(attestationReceipts.id, receipt.id)).get()!;
  notifyAttestationStatusChange(updatedReceipt, 'attestation.revoked');

  return c.json({
    attestationId: receipt.id,
    status: 'revoked',
    revokedAt,
    revocationReason: parsed.data.reason,
    alreadyRevoked: false,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// ─── Evidence export ────────────────────────────────────
//
// GET /api/v1/attestations/:id/export?format=json|html (default json)
// Self-contained bundle for audit binders: attestation record, signature,
// public key, the exact signed payload, independent verification
// instructions, cited rule keys with legalReference + rule signatures where
// still available, and the corpus state hash.
//
// Deterministic: for an unchanged attestation + rule corpus the JSON bytes
// are identical except the generatedAt field (and any status change that
// derives from the passage of time, e.g. an expiry crossing).

auditRoutes.get('/:id/export', (c) => {
  const db = getDb();
  const receipt = db.select().from(attestationReceipts)
    .where(eq(attestationReceipts.id, c.req.param('id')))
    .get();

  if (!receipt) return c.json({ error: 'Attestation not found' }, 404);
  if (receipt.orgId !== c.get('orgId')) return c.json({ error: 'Not found' }, 404);

  const format = (c.req.query('format') ?? 'json').toLowerCase();
  if (format !== 'json' && format !== 'html') {
    return c.json({ error: "Invalid format. Use 'json' or 'html'." }, 400);
  }

  let publicKey: string;
  try {
    publicKey = getPublicKey();
  } catch {
    return c.json({ error: 'Verification service unavailable' }, 503);
  }

  const generatedAt = new Date().toISOString();
  const bundle = buildEvidenceBundle(receipt, publicKey, generatedAt);

  if (format === 'html') {
    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Content-Disposition', `inline; filename="nomus-attestation-${receipt.id}.html"`);
    return c.body(renderEvidenceHtml(bundle));
  }

  c.header('Content-Type', 'application/json; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="nomus-attestation-${receipt.id}.json"`);
  // JSON.stringify over a deterministically-constructed object → stable bytes
  return c.body(JSON.stringify(bundle, null, 2));
});

// ─── Evidence bundle construction ───────────────────────────────

type ReceiptRow = typeof attestationReceipts.$inferSelect;

interface EvidenceBundle {
  bundleType: 'nomus-attestation-evidence';
  bundleVersion: 1;
  generatedAt: string;
  attestation: {
    id: string;
    schemaVersion: number;
    orgId: string;
    result: string;
    jurisdiction: string;
    actionContext: unknown;
    rulesEvaluated: unknown;
    policyStateHash: string;
    evaluatedAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    revocationReason: string | null;
    supersededBy: string | null;
    status: string;
    signature: string;
  };
  verification: {
    algorithm: 'ed25519';
    publicKey: string;
    signedPayloadCanonicalJson: string | null;
    signature: string;
    signatureValid: boolean;
    signedPayloadDescription: string;
    instructions: string[];
  };
  citedRules: Array<{
    ruleKey: string;
    version: number;
    effect: string;
    matched: boolean;
    legalReference: string | null;
    currentVersion: number | null;
    ruleSignature: string | null;
  }>;
  corpus: { policyStateHash: string; computedAt: string };
  _disclaimer: string;
}

function buildEvidenceBundle(receipt: ReceiptRow, publicKey: string, generatedAt: string): EvidenceBundle {
  const db = getDb();

  let actionContext: unknown;
  let rulesEvaluated: Array<{ ruleKey: string; version: number; effect: string; matched: boolean }>;
  try { actionContext = JSON.parse(receipt.actionContext); } catch { actionContext = receipt.actionContext; }
  try {
    const parsed = JSON.parse(receipt.rulesEvaluated);
    rulesEvaluated = Array.isArray(parsed) ? parsed : [];
  } catch {
    rulesEvaluated = [];
  }

  // Cited rules: join the receipt's rule snapshot against the current corpus
  // for legalReference + rule signature "where available" — a later rule
  // version (or a removed rule) is reported as such, never silently blended.
  const ruleKeys = [...new Set(rulesEvaluated.map((r) => r.ruleKey))].sort();
  const currentRules = ruleKeys.length > 0
    ? db.select({
        ruleKey: policyRules.ruleKey,
        version: policyRules.version,
        legalReference: policyRules.legalReference,
        signature: policyRules.signature,
      }).from(policyRules)
      .where(inArray(policyRules.ruleKey, ruleKeys))
      .all()
    : [];
  const ruleByKey = new Map(currentRules.map((r) => [r.ruleKey, r]));

  const citedRules = [...rulesEvaluated]
    .sort((a, b) => a.ruleKey.localeCompare(b.ruleKey) || a.version - b.version)
    .map((r) => {
      const current = ruleByKey.get(r.ruleKey);
      return {
        ruleKey: r.ruleKey,
        version: r.version,
        effect: r.effect,
        matched: r.matched,
        legalReference: current?.legalReference ?? null,
        currentVersion: current?.version ?? null,
        ruleSignature: current?.signature ?? null,
      };
    });

  const signedPayload = buildSignedReceiptPayload(receipt);

  return {
    bundleType: 'nomus-attestation-evidence',
    bundleVersion: 1,
    generatedAt,
    attestation: {
      id: receipt.id,
      schemaVersion: receipt.schemaVersion,
      orgId: receipt.orgId,
      result: receipt.result,
      jurisdiction: receipt.jurisdiction,
      actionContext,
      rulesEvaluated,
      policyStateHash: receipt.policyStateHash,
      evaluatedAt: receipt.evaluatedAt,
      expiresAt: receipt.expiresAt,
      revokedAt: receipt.revokedAt,
      revocationReason: receipt.revocationReason,
      supersededBy: receipt.supersededBy,
      status: deriveAttestationStatus(receipt, generatedAt),
      signature: receipt.signature,
    },
    verification: {
      algorithm: 'ed25519',
      publicKey,
      signedPayloadCanonicalJson: signedPayload,
      signature: receipt.signature,
      signatureValid: verifyReceiptSignature(receipt),
      signedPayloadDescription: SIGNED_PAYLOAD_DESCRIPTION,
      instructions: verificationInstructions(),
    },
    citedRules,
    corpus: { policyStateHash: receipt.policyStateHash, computedAt: receipt.evaluatedAt },
    _disclaimer: LEGAL_DISCLAIMER,
  };
}

// ─── Printable HTML rendering (no external assets) ──────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderEvidenceHtml(bundle: EvidenceBundle): string {
  const a = bundle.attestation;
  const v = bundle.verification;

  const statusColor = a.status === 'valid' ? '#166534' : '#991b1b';

  const lifecycleRows = [
    ['Status', a.status.toUpperCase()],
    ['Attested at (UTC)', a.evaluatedAt],
    ['Expires at', a.expiresAt ?? '—'],
    ['Revoked at', a.revokedAt ?? '—'],
    ['Revocation reason', a.revocationReason ?? '—'],
    ['Superseded by', a.supersededBy ?? '—'],
    ['Schema version', String(a.schemaVersion)],
  ];

  const ruleRows = bundle.citedRules.map((r) => `
    <tr>
      <td style="padding:6px 10px;border:1px solid #d1d5db;font-family:monospace;font-size:12px;">${esc(r.ruleKey)}</td>
      <td style="padding:6px 10px;border:1px solid #d1d5db;text-align:center;">${esc(r.version)}</td>
      <td style="padding:6px 10px;border:1px solid #d1d5db;">${esc(r.effect)}</td>
      <td style="padding:6px 10px;border:1px solid #d1d5db;text-align:center;">${r.matched ? 'yes' : 'no'}</td>
      <td style="padding:6px 10px;border:1px solid #d1d5db;">${esc(r.legalReference ?? '(rule no longer in corpus)')}</td>
    </tr>`).join('');

  const instructions = v.instructions.map((s) => `<li style="margin:6px 0;">${esc(s)}</li>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Nomus Attestation Evidence — ${esc(a.id)}</title>
</head>
<body style="margin:0;padding:32px;background:#ffffff;color:#111827;font-family:Georgia,'Times New Roman',serif;line-height:1.5;">
  <div style="max-width:820px;margin:0 auto;">
    <div style="border-bottom:3px solid #111827;padding-bottom:12px;margin-bottom:24px;">
      <h1 style="margin:0;font-size:22px;">Nomus Compliance Attestation — Evidence Pack</h1>
      <p style="margin:4px 0 0;color:#4b5563;font-size:13px;">Generated ${esc(bundle.generatedAt)} · Bundle v${bundle.bundleVersion} · Attestation ${esc(a.id)}</p>
    </div>

    <h2 style="font-size:16px;border-bottom:1px solid #d1d5db;padding-bottom:4px;">1. Attestation</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <tr><td style="padding:6px 10px;border:1px solid #d1d5db;width:220px;color:#4b5563;">Attestation ID</td><td style="padding:6px 10px;border:1px solid #d1d5db;font-family:monospace;">${esc(a.id)}</td></tr>
      <tr><td style="padding:6px 10px;border:1px solid #d1d5db;color:#4b5563;">Result</td><td style="padding:6px 10px;border:1px solid #d1d5db;font-weight:bold;">${esc(a.result)}</td></tr>
      <tr><td style="padding:6px 10px;border:1px solid #d1d5db;color:#4b5563;">Jurisdiction</td><td style="padding:6px 10px;border:1px solid #d1d5db;">${esc(a.jurisdiction)}</td></tr>
      ${lifecycleRows.map(([k, val]) => `<tr><td style="padding:6px 10px;border:1px solid #d1d5db;color:#4b5563;">${esc(k)}</td><td style="padding:6px 10px;border:1px solid #d1d5db;${k === 'Status' ? `font-weight:bold;color:${statusColor};` : ''}">${esc(val)}</td></tr>`).join('')}
    </table>

    <h2 style="font-size:16px;border-bottom:1px solid #d1d5db;padding-bottom:4px;margin-top:28px;">2. Cryptographic verification</h2>
    <p style="font-size:13px;">Signature validity is separate from lifecycle status: a revoked or expired attestation keeps a verifiable signature but must not be relied upon.</p>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <tr><td style="padding:6px 10px;border:1px solid #d1d5db;width:220px;color:#4b5563;">Algorithm</td><td style="padding:6px 10px;border:1px solid #d1d5db;">Ed25519</td></tr>
      <tr><td style="padding:6px 10px;border:1px solid #d1d5db;color:#4b5563;">Signature valid (at generation)</td><td style="padding:6px 10px;border:1px solid #d1d5db;font-weight:bold;color:${v.signatureValid ? '#166534' : '#991b1b'};">${v.signatureValid ? 'YES' : 'NO'}</td></tr>
      <tr><td style="padding:6px 10px;border:1px solid #d1d5db;color:#4b5563;">Signature (base64)</td><td style="padding:6px 10px;border:1px solid #d1d5db;font-family:monospace;font-size:11px;word-break:break-all;">${esc(v.signature)}</td></tr>
      <tr><td style="padding:6px 10px;border:1px solid #d1d5db;color:#4b5563;">Public key (base64 SPKI DER)</td><td style="padding:6px 10px;border:1px solid #d1d5db;font-family:monospace;font-size:11px;word-break:break-all;">${esc(v.publicKey)}</td></tr>
      <tr><td style="padding:6px 10px;border:1px solid #d1d5db;color:#4b5563;">Corpus state hash</td><td style="padding:6px 10px;border:1px solid #d1d5db;font-family:monospace;font-size:11px;word-break:break-all;">${esc(bundle.corpus.policyStateHash)}</td></tr>
    </table>
    <p style="font-size:13px;color:#4b5563;">${esc(v.signedPayloadDescription)}</p>
    <p style="font-size:12px;color:#4b5563;">Signed payload (canonical JSON):</p>
    <pre style="background:#f3f4f6;border:1px solid #d1d5db;padding:12px;font-size:11px;white-space:pre-wrap;word-break:break-all;">${esc(v.signedPayloadCanonicalJson ?? '(action context unparseable — signature cannot be reconstructed)')}</pre>

    <h2 style="font-size:16px;border-bottom:1px solid #d1d5db;padding-bottom:4px;margin-top:28px;">3. Cited rules (${bundle.citedRules.length})</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <tr style="background:#f3f4f6;">
        <th style="padding:6px 10px;border:1px solid #d1d5db;text-align:left;">Rule key</th>
        <th style="padding:6px 10px;border:1px solid #d1d5db;">Version</th>
        <th style="padding:6px 10px;border:1px solid #d1d5db;text-align:left;">Effect</th>
        <th style="padding:6px 10px;border:1px solid #d1d5db;">Matched</th>
        <th style="padding:6px 10px;border:1px solid #d1d5db;text-align:left;">Legal reference</th>
      </tr>
      ${ruleRows || '<tr><td colspan="5" style="padding:6px 10px;border:1px solid #d1d5db;color:#4b5563;">No rules were active for this jurisdiction at evaluation time.</td></tr>'}
    </table>

    <h2 style="font-size:16px;border-bottom:1px solid #d1d5db;padding-bottom:4px;margin-top:28px;">4. Independent verification steps</h2>
    <ol style="font-size:13px;">${instructions}</ol>

    <p style="margin-top:32px;padding-top:12px;border-top:1px solid #d1d5db;font-size:11px;color:#6b7280;">${esc(bundle._disclaimer)}</p>
  </div>
</body></html>`;
}
