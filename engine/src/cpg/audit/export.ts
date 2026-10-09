import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { cpgAuditEvents, cpgCases, cpgCiRuns, cpgDecisions, cpgRevocations } from '../../db/schema-cpg.js';
import { closureSignedText } from '../cases/close.js';
import { governanceExportResponseSchema, type GovernanceExportResponse } from '../contracts.js';
import { contentHashOf, cpgSign, exportSignedText, GOVERNANCE_EXPORT_KIND } from '../policies/signing.js';
import { verifyAuditChain } from './log.js';

type Db = BetterSQLite3Database<any>;

/**
 * The signed governance audit export (design spec E73), for the Auditor's
 * `audit.export`: the whole hash-chained audit log from genesis, and every
 * signed decision, revocation, case closure record and CI verdict of the org.
 * One export signature covers the content hash, so the file verifies offline
 * with the instance key from /.well-known/nomus-keys; each record also
 * verifies on its own. The policy log has its own export (E39).
 */
export function buildGovernanceExport(db: Db, orgId: string): GovernanceExportResponse {
  const events = db.select().from(cpgAuditEvents).where(eq(cpgAuditEvents.orgId, orgId)).orderBy(asc(cpgAuditEvents.seq)).all();
  const signed = (id: string, signedPayloadCanonicalJson: string, signature: string) => ({ id, signedPayloadCanonicalJson, signature });
  const closed = db.select().from(cpgCases)
    .where(and(eq(cpgCases.orgId, orgId), isNotNull(cpgCases.closureSignature))).orderBy(asc(cpgCases.closedAt), asc(cpgCases.id)).all();
  const content = {
    chainValid: verifyAuditChain(db, orgId).valid,
    auditEvents: events.map((e) => ({
      id: e.id, seq: e.seq, actor: e.actor, action: e.action, targetType: e.targetType, targetId: e.targetId,
      payload: JSON.parse(e.payload) as Record<string, unknown>, prevHash: e.prevHash, hash: e.hash, createdAt: e.createdAt,
    })),
    decisions: db.select().from(cpgDecisions).where(eq(cpgDecisions.orgId, orgId)).orderBy(asc(cpgDecisions.finalizedAt), asc(cpgDecisions.id)).all()
      .map((d) => signed(d.id, d.signedPayload, d.signature)),
    revocations: db.select().from(cpgRevocations).where(eq(cpgRevocations.orgId, orgId)).orderBy(asc(cpgRevocations.revokedAt), asc(cpgRevocations.id)).all()
      .map((r) => signed(r.id, r.signedPayload, r.signature)),
    caseClosures: closed.map((c) => signed(c.id, closureSignedText(db, c), c.closureSignature!)),
    ciRuns: db.select().from(cpgCiRuns).where(eq(cpgCiRuns.orgId, orgId)).orderBy(asc(cpgCiRuns.evaluatedAt), asc(cpgCiRuns.id)).all()
      .map((r) => signed(r.id, r.signedPayload, r.signature)),
  };
  const exportedAt = new Date().toISOString();
  const contentHash = contentHashOf(content);
  return governanceExportResponseSchema.parse({
    kind: GOVERNANCE_EXPORT_KIND, orgId, exportedAt, content, contentHash,
    signature: cpgSign(exportSignedText({ kind: GOVERNANCE_EXPORT_KIND, orgId, exportedAt, contentHash })),
  });
}
