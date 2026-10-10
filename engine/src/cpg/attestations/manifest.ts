import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { z } from 'zod';
import { canonicalJson, compileGlobList, repoInputSchema, sha256Hex } from '@nomus/scanner/corporate';
import { cpgAttestationLinks, cpgAttestationManifests, cpgCiRuns, cpgDecisions } from '../../db/schema-cpg.js';
import { getCorporateBundle } from '../bundle/build.js';
import { closurePayload } from '../cases/close.js';
import { getCase } from '../cases/service.js';
import { latestDecisions } from '../decisions/resolve.js';
import { standingExceptions } from '../decisions/standing.js';
import { CpgError } from '../errors.js';
import { cpgSign } from '../policies/signing.js';
import { getOrgSettings } from '../rbac/seed.js';

/**
 * The governance manifest of an attestation (design spec §13.4). It is signed
 * separately from the receipt, whose payload is unchanged, and lists by
 * signature hash every CPG record in force for a repository at the
 * attestation instant: the active approvals (snippet and bulk), the standing
 * exceptions that cover the repository (and branch), and, when a case is
 * named, its signed closure record and the CI runs that record lists.
 */

const MANIFEST_KIND = 'nomus.cpg-attestation-manifest.v1';

/** The optional `governance` extra of POST /evaluate, outside the shared schema and the signed actionContext. */
export const governanceExtrasSchema = z.object({
  governance: z.object({
    repo: repoInputSchema,
    branch: z.string().min(1).max(255).optional(),
    caseId: z.string().uuid().optional(),
  }).strict().optional(),
});
type GovernanceRequest = NonNullable<z.infer<typeof governanceExtrasSchema>['governance']>;

export type ItemType = typeof cpgAttestationLinks.$inferSelect['itemType'];
interface ManifestItem { type: ItemType; id: string; signatureSha256: string }

/** Every CPG record in force for the request at `at`, sorted by (type, id). */
function manifestItems(db: Db, orgId: string, req: GovernanceRequest, at: string): ManifestItem[] {
  const signed: Array<{ type: ItemType; id: string; signature: string }> = [];

  // Approvals: the latest snippet or bulk decision of each fingerprint, if it approves and is unexpired.
  const fingerprints = db.selectDistinct({ fp: cpgDecisions.fingerprint }).from(cpgDecisions)
    .where(and(eq(cpgDecisions.orgId, orgId), eq(cpgDecisions.repo, req.repo), inArray(cpgDecisions.scope, ['snippet', 'bulk']))).all()
    .map((r) => r.fp!);
  for (const d of latestDecisions(db, orgId, req.repo, fingerprints, at).values()) {
    if (d.outcome === 'approve' && d.expiresAt! > at) signed.push({ type: 'decision', id: d.id, signature: d.signature });
  }

  // Standing exceptions: unexpired, unrevoked, on the policy's active version (D11), covering the repo and branch.
  for (const x of standingExceptions(db, orgId)) {
    const live = x.decision.expiresAt! > at && (x.revocation === null || x.revocation.revokedAt > at) && x.activeVersion === x.pattern.policyVersion;
    const branches = x.pattern.conditions.branches;
    const covers = compileGlobList([...x.pattern.repos, ...x.teamRepos])(req.repo) && (!req.branch || !branches || compileGlobList(branches)(req.branch));
    if (live && covers) signed.push({ type: 'decision', id: x.decision.id, signature: x.decision.signature });
  }

  if (req.caseId) {
    const c = getCase(db, orgId, req.caseId);
    if (c.repo !== req.repo) throw new CpgError(422, 'case_repo_mismatch', 'The case belongs to another repository');
    if (!c.closedAt || !c.closureSignature) throw new CpgError(409, 'case_open', 'Only a closed case has a signed closure record');
    signed.push({ type: 'case_closure', id: c.id, signature: c.closureSignature });
    const runIds = closurePayload(db, c).ciRunIds;
    if (runIds.length > 0) {
      for (const r of db.select({ id: cpgCiRuns.id, signature: cpgCiRuns.signature }).from(cpgCiRuns).where(inArray(cpgCiRuns.id, runIds)).all()) {
        signed.push({ type: 'ci_run', ...r });
      }
    }
  }

  return signed.map((s) => ({ type: s.type, id: s.id, signatureSha256: sha256Hex(s.signature) }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}

/**
 * Sign and store the manifest of a just-created attestation. Call inside the
 * transaction that created the receipt, so a refusal leaves no receipt.
 */
export function writeManifest(db: Db, receipt: { id: string; orgId: string; evaluatedAt: string }, req: GovernanceRequest): { itemCount: number } {
  if (!getOrgSettings(db, receipt.orgId)?.enabled) {
    throw new CpgError(403, 'cpg_disabled', 'Corporate policies are not enabled for this organization');
  }
  const items = manifestItems(db, receipt.orgId, req, receipt.evaluatedAt);
  const bundleHash = getCorporateBundle(db, receipt.orgId).bundle.bundleHash;
  const signedPayload = canonicalJson({
    kind: MANIFEST_KIND, attestationId: receipt.id, orgId: receipt.orgId, evaluatedAt: receipt.evaluatedAt,
    repo: req.repo, branch: req.branch ?? null, bundleHash, items,
  });
  db.insert(cpgAttestationManifests).values({
    attestationId: receipt.id, orgId: receipt.orgId, repo: req.repo, branch: req.branch ?? null, evaluatedAt: receipt.evaluatedAt,
    bundleHash, signedPayload, signature: cpgSign(signedPayload), createdAt: new Date().toISOString(),
  }).run();
  if (items.length > 0) {
    db.insert(cpgAttestationLinks).values(items.map((i) => ({ attestationId: receipt.id, itemType: i.type, itemId: i.id, itemSignatureSha256: i.signatureSha256 }))).run();
  }
  return { itemCount: items.length };
}

/** Per attestation with a manifest: its link count by item type. */
export function manifestCounts(db: Db, attestationIds: readonly string[]): Map<string, Record<ItemType, number>> {
  const by = new Map<string, Record<ItemType, number>>();
  if (attestationIds.length === 0) return by;
  for (const m of db.select({ id: cpgAttestationManifests.attestationId }).from(cpgAttestationManifests)
    .where(inArray(cpgAttestationManifests.attestationId, [...attestationIds])).all()) {
    by.set(m.id, { decision: 0, case_closure: 0, ci_run: 0 });
  }
  if (by.size === 0) return by;
  for (const l of db.select({ id: cpgAttestationLinks.attestationId, type: cpgAttestationLinks.itemType }).from(cpgAttestationLinks)
    .where(inArray(cpgAttestationLinks.attestationId, [...by.keys()])).all()) {
    by.get(l.id)![l.type] += 1;
  }
  return by;
}
