import { Hono } from 'hono';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppEnv } from '../../app.js';
import { getDb } from '../../../db/client.js';
import { cpgBoards, cpgPolicies, cpgPolicyVersions } from '../../../db/schema-cpg.js';
import { createQuorumVersion, currentQuorum, getQuorumVersion, listQuorumVersions, type QuorumVersion } from '../../../cpg/quorum/store.js';
import type { QuorumConfig } from '../../../cpg/quorum/schema.js';
import { listOf, putQuorumRequestSchema, quorumVersionResponseSchema, quorumVersionSummarySchema } from '../../../cpg/contracts.js';
import { CpgError, notFound } from '../../../cpg/errors.js';
import { actorFrom, auditActor, cpgAuth, handle, parseBody, pathParam, requireEither } from './helpers.js';

/**
 * The versioned approval quorum (design spec §4, E25 to E28). Reading the
 * current version needs policy.read; history needs audit.read or
 * quorum.manage; a new version needs quorum.manage and a browser session.
 */
export const cpgQuorumRoutes = new Hono<AppEnv>();

const full = (v: QuorumVersion) => quorumVersionResponseSchema.parse({
  version: v.version, config: v.config, configHash: v.configHash, changeNote: v.changeNote,
  createdAt: v.createdAt, createdBy: v.createdBy, signature: v.signature,
});

/** The database-dependent checks of a new configuration (§4.1, after zod). */
function checkAgainstOrg(orgId: string, config: QuorumConfig): void {
  const db = getDb();
  const overrideIds = Object.keys(config.policyOverrides);
  if (overrideIds.length > 0) {
    const known = new Set(db.select({ id: cpgPolicies.id }).from(cpgPolicies)
      .where(and(eq(cpgPolicies.orgId, orgId), inArray(cpgPolicies.id, overrideIds))).all().map((p) => p.id));
    const unknown = overrideIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new CpgError(422, 'unknown_policy', 'policyOverrides names policies that are not in this organization', { policyIds: unknown });
    // A policy with any prohibited version can never get bulk decisions, not even by override.
    const prohibited = db.select({ policyId: cpgPolicyVersions.policyId }).from(cpgPolicyVersions)
      .where(and(inArray(cpgPolicyVersions.policyId, overrideIds), eq(cpgPolicyVersions.tier, 'prohibited'))).all()
      .map((r) => r.policyId);
    const offending = overrideIds.filter((id) => config.policyOverrides[id]?.bulk?.allowed === true && prohibited.includes(id));
    if (offending.length > 0) throw new CpgError(422, 'bulk_forbidden_on_prohibited', 'Bulk decisions cannot be enabled for a prohibited policy', { policyIds: offending });
  }
  const boardIds = new Set<string>();
  const slots = [
    ...(['review-required', 'prohibited'] as const).flatMap((t) => Object.values(config.tiers[t])),
    ...Object.values(config.policyOverrides).flatMap((o) => Object.values(o)),
  ];
  for (const slot of slots) if (slot && slot.allowed) for (const id of slot.extraBoardIds) boardIds.add(id);
  if (boardIds.size > 0) {
    const active = new Set(db.select({ id: cpgBoards.id }).from(cpgBoards)
      .where(and(eq(cpgBoards.orgId, orgId), inArray(cpgBoards.id, [...boardIds]), isNull(cpgBoards.archivedAt))).all().map((b) => b.id));
    const unknown = [...boardIds].filter((id) => !active.has(id));
    if (unknown.length > 0) throw new CpgError(422, 'unknown_board', 'extraBoardIds must be active boards of this organization', { boardIds: unknown });
  }
}

// E25
cpgQuorumRoutes.get('/', ...cpgAuth('policy.read'), handle((c) =>
  c.json(full(currentQuorum(getDb(), actorFrom(c).orgId)))));

// E26
cpgQuorumRoutes.put('/', ...cpgAuth('quorum.manage'), handle(async (c) => {
  const body = await parseBody(c, putQuorumRequestSchema);
  const orgId = actorFrom(c).orgId;
  checkAgainstOrg(orgId, body.config);
  return c.json(full(createQuorumVersion(getDb(), orgId, body.config, body.changeNote, auditActor(c))), 201);
}));

// E27
cpgQuorumRoutes.get('/versions', ...cpgAuth(null), handle((c) => {
  requireEither(actorFrom(c), 'audit.read', 'quorum.manage');
  const items = listQuorumVersions(getDb(), actorFrom(c).orgId).map((v) => ({
    version: v.version, configHash: v.configHash, changeNote: v.changeNote, createdAt: v.createdAt, createdBy: v.createdBy,
  }));
  return c.json(listOf(quorumVersionSummarySchema).parse({ items }));
}));

// E28
cpgQuorumRoutes.get('/versions/:version', ...cpgAuth(null), handle((c) => {
  requireEither(actorFrom(c), 'audit.read', 'quorum.manage');
  const n = Number(pathParam(c, 'version'));
  if (!Number.isInteger(n) || n < 1) throw notFound('Quorum version');
  const v = getQuorumVersion(getDb(), actorFrom(c).orgId, n);
  if (!v) throw notFound('Quorum version');
  return c.json(full(v));
}));
