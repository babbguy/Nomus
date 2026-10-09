import { and, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  bundleHashOf, bundleSignedText, corporateBundleSchema, corporateRuleSchema, sortBundlePolicies, BUNDLE_KIND,
  type BundlePolicy, type CorporateBundle,
} from '@nomus/scanner/corporate';
import { PolicyCache } from '../../core/policy-cache.js';
import { cpgBoards, cpgPolicies, cpgPolicyHeads, cpgPolicyVersionEvents, cpgPolicyVersions } from '../../db/schema-cpg.js';
import { broadcastEvent } from '../../sse/manager.js';
import { ensureOrgRbac, getOrgSettings } from '../rbac/seed.js';
import { cpgSign } from '../policies/signing.js';

/**
 * The signed corporate policy bundle of an org (design spec §8.6): every
 * active policy version (including those still in their grace period, which
 * carry a future enforceFrom), its rule, tier, owning boards and activation
 * signature. Scanners evaluate it locally; the server never re-scans code.
 *
 * Cached per org (`cpg:<orgId>`) and invalidated whenever its content can
 * change: activation, retirement, settings and board renames.
 */

type Db = BetterSQLite3Database<any>;

export interface BuiltBundle {
  bundle: CorporateBundle;
  /** Strong ETag: the content hash plus the enabled flag (both are signed). */
  etag: string;
}

const cache = new PolicyCache<BuiltBundle>(500, 300);

export function bundleCacheKey(orgId: string): string {
  return `cpg:${orgId}`;
}

/** Drop an org's cached bundle and tell its connected clients (SSE, org-scoped) to refetch. */
export function invalidateCorporateBundle(orgId: string, reason: string): void {
  cache.invalidate(bundleCacheKey(orgId));
  broadcastEvent({ type: 'cpg.bundle.changed', data: { orgId, reason }, jurisdiction: '', orgId });
}

function activePolicies(db: Db, orgId: string): Array<Omit<BundlePolicy, 'activationSignature'> & { activationSignature: string }> {
  const rows = db.select({ head: cpgPolicyHeads, policy: cpgPolicies, version: cpgPolicyVersions })
    .from(cpgPolicyHeads)
    .innerJoin(cpgPolicies, eq(cpgPolicies.id, cpgPolicyHeads.policyId))
    .innerJoin(cpgPolicyVersions, eq(cpgPolicyVersions.id, cpgPolicyHeads.activeVersionId))
    .where(and(eq(cpgPolicyHeads.orgId, orgId), eq(cpgPolicyHeads.state, 'active')))
    .all();
  if (rows.length === 0) return [];

  const boardIds = [...new Set(rows.flatMap((r) => JSON.parse(r.version.owningBoardIds) as string[]))];
  const names = new Map(db.select({ id: cpgBoards.id, name: cpgBoards.name }).from(cpgBoards).where(inArray(cpgBoards.id, boardIds)).all().map((b) => [b.id, b.name]));
  const activations = db.select({ versionId: cpgPolicyVersionEvents.versionId, details: cpgPolicyVersionEvents.details })
    .from(cpgPolicyVersionEvents)
    .where(and(inArray(cpgPolicyVersionEvents.versionId, rows.map((r) => r.version.id)), eq(cpgPolicyVersionEvents.event, 'activated')))
    .all();
  const activatedAt = new Map(activations.map((a) => [a.versionId, (JSON.parse(a.details) as { activatedAt: string }).activatedAt]));

  return rows.map(({ head, policy, version }) => {
    const at = activatedAt.get(version.id);
    if (!head.enforceFrom || !head.activationSignature || !at || !version.rule || !version.ruleHash) {
      // An active head always has these (CHECK constraints and the activation transaction); refuse to sign a partial bundle.
      throw new Error(`Active policy ${policy.policyKey} v${version.version} is missing activation data`);
    }
    return {
      policyId: policy.id,
      policyKey: policy.policyKey,
      version: version.version,
      title: version.title,
      tier: version.tier,
      owningBoards: (JSON.parse(version.owningBoardIds) as string[]).map((id) => ({ id, name: names.get(id) ?? '' })),
      enforceFrom: head.enforceFrom,
      activatedAt: at,
      rule: corporateRuleSchema.parse(JSON.parse(version.rule)),
      ruleHash: version.ruleHash,
      activationSignature: head.activationSignature,
    };
  });
}

/** Build (or return the cached) signed bundle of an org. */
export function getCorporateBundle(db: Db, orgId: string): BuiltBundle {
  const cached = cache.get(bundleCacheKey(orgId));
  if (cached) return cached;

  let settings = getOrgSettings(db, orgId);
  if (!settings) {
    ensureOrgRbac(db, orgId);
    settings = getOrgSettings(db, orgId);
  }
  const enabled = settings?.enabled ?? false;
  const policies = enabled ? sortBundlePolicies(activePolicies(db, orgId)) : [];
  const generatedAt = new Date().toISOString();
  const bundleHash = bundleHashOf(policies);
  const unsigned = { kind: BUNDLE_KIND, enabled, orgId, generatedAt, bundleHash, policies, minScannerVersion: '1.2.0' as const };
  const bundle = corporateBundleSchema.parse({ ...unsigned, signature: cpgSign(bundleSignedText(unsigned)) });
  const built = { bundle, etag: `"${bundleHash}.${enabled ? 'on' : 'off'}"` };
  cache.set(bundleCacheKey(orgId), built);
  return built;
}
