import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { canonicalJson, sha256Hex } from '@nomus/scanner/corporate';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgDecisions, cpgRevocations } from '../../db/schema-cpg.js';
import { appendAuditEvent } from '../audit/log.js';
import { refreshOpenCases } from '../cases/service.js';
import { CpgError, notFound } from '../errors.js';
import { cpgSign } from '../policies/signing.js';
import { can, type CpgActor } from '../rbac/can.js';
import type { DecisionRow } from './resolve.js';
import { canOnPattern, ruleOf } from './standing.js';
import { getProposal } from './status.js';

/**
 * Revocation (design spec §7.5, E60): immediate and final. The signed
 * revocation is append-only and unique per decision, so a decision is
 * revoked at most once (409 already_revoked); restoring it means proposing
 * again. The findings it settled return to review at once.
 */

export type RevocationRow = typeof cpgRevocations.$inferSelect;
export const REVOCATION_KIND = 'nomus.cpg-revocation.v1';

export function getDecision(db: Db, orgId: string, id: string): DecisionRow {
  const d = db.select().from(cpgDecisions).where(and(eq(cpgDecisions.id, id), eq(cpgDecisions.orgId, orgId))).get();
  // Cross-org ids are 404, never 403 (§9.1).
  if (!d) throw notFound('Decision');
  return d;
}

/** `decision.revoke` on the decision's repository, or on every repository a standing exception's pattern can touch. */
function mayRevoke(db: Db, actor: CpgActor, d: DecisionRow): boolean {
  if (d.scope !== 'standing') return can(actor, 'decision.revoke', { repo: d.repo! });
  return canOnPattern(actor, 'decision.revoke', ruleOf(db, d.orgId, getProposal(db, d.orgId, d.proposalId).pattern!).pattern);
}

export function revokeDecision(db: Db, actor: CpgActor, decisionId: string, reason: string): RevocationRow {
  return rawSqlite(db).transaction((): RevocationRow => {
    const d = getDecision(db, actor.orgId, decisionId);
    if (!mayRevoke(db, actor, d)) throw new CpgError(403, 'forbidden', 'Missing permission decision.revoke', { permission: 'decision.revoke' });
    if (db.select({ id: cpgRevocations.id }).from(cpgRevocations).where(eq(cpgRevocations.decisionId, d.id)).get()) {
      throw new CpgError(409, 'already_revoked', 'The decision is already revoked');
    }
    const revokedAt = new Date().toISOString();
    const payload = {
      kind: REVOCATION_KIND, id: randomUUID(), orgId: d.orgId, decisionId: d.id, decisionSignatureSha256: sha256Hex(d.signature),
      revokedByUserId: actor.userId, reason, revokedAt,
    };
    const signedPayload = canonicalJson(payload);
    const row: RevocationRow = {
      id: payload.id, orgId: d.orgId, decisionId: d.id, revokedByUserId: actor.userId, reason, revokedAt, signedPayload, signature: cpgSign(signedPayload),
    };
    db.insert(cpgRevocations).values(row).run();
    const userActor = `user:${actor.userId}`;
    appendAuditEvent(db, {
      orgId: d.orgId, actor: userActor, action: 'decision.revoked', targetType: 'decision', targetId: d.id,
      payload: { revocationId: row.id, scope: d.scope, caseId: d.caseId, fingerprint: d.fingerprint },
    });
    refreshOpenCases(db, d.orgId, userActor, revokedAt, d.policyVersionId);
    return row;
  }).immediate();
}
