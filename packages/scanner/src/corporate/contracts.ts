import { z } from 'zod';
import { canonicalJson, sha256Hex } from './canonical.js';
import { corporateRuleSchema } from './rule-schema.js';
import { TIERS } from './vocab.js';

/**
 * Client contracts shared by the engine, the VS Code extension and the
 * GitHub Action (design spec §8.6, §9.3). Phase 2 defines the bundle; the
 * review-case and CI contracts are added by later phases.
 *
 * The signed payload builders live here too, so the server that signs and
 * the client that verifies build byte-identical canonical JSON.
 */

const isoDate = z.string().datetime();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const bundlePolicySchema = z.object({
  policyId: z.string().uuid(),
  policyKey: z.string().regex(/^corp\.[a-z0-9][a-z0-9._-]{0,84}$/),
  version: z.number().int().min(1),
  title: z.string().min(3).max(120),
  tier: z.enum(TIERS),
  /** In the order they were signed (sorted by id). */
  owningBoards: z.array(z.object({ id: z.string().uuid(), name: z.string() }).strict()).min(1),
  /** Before this instant the policy is advisory everywhere (grace period). */
  enforceFrom: isoDate,
  activatedAt: isoDate,
  rule: corporateRuleSchema,
  ruleHash: sha256,
  activationSignature: z.string().min(1),
}).strict();

export const corporateBundleSchema = z.object({
  kind: z.literal('nomus.cpg-bundle.v1'),
  /** cpg_org_settings.enabled; policies is [] when false. */
  enabled: z.boolean(),
  orgId: z.string().uuid(),
  generatedAt: isoDate,
  /** sha256(canonicalJson({policies})) over the policies sorted by key, without activationSignature. */
  bundleHash: sha256,
  policies: z.array(bundlePolicySchema),
  minScannerVersion: z.literal('1.2.0'),
  /** Ed25519 over canonicalJson({kind, orgId, enabled, bundleHash, generatedAt}). */
  signature: z.string().min(1),
}).strict();

export type BundlePolicy = z.infer<typeof bundlePolicySchema>;
export type CorporateBundle = z.infer<typeof corporateBundleSchema>;

export const BUNDLE_KIND = 'nomus.cpg-bundle.v1';
export const POLICY_ACTIVATION_KIND = 'nomus.cpg-policy.v1';

/** sha256 of a rule's canonical JSON (the `ruleHash` of a version). */
export function ruleHashOf(rule: unknown): string {
  return sha256Hex(canonicalJson(rule));
}

function byKey<T extends { policyKey: string }>(a: T, b: T): number {
  return a.policyKey < b.policyKey ? -1 : a.policyKey > b.policyKey ? 1 : 0;
}

/** Policies in bundle order: sorted by policyKey (code-unit order, locale-independent). */
export function sortBundlePolicies<T extends { policyKey: string }>(policies: readonly T[]): T[] {
  return [...policies].sort(byKey);
}

/** The bundle hash: over the sorted policies without their activation signatures. */
export function bundleHashOf(policies: ReadonlyArray<Omit<BundlePolicy, 'activationSignature'> & { activationSignature?: string }>): string {
  const content = sortBundlePolicies(policies).map(({ activationSignature: _sig, ...rest }) => rest);
  return sha256Hex(canonicalJson({ policies: content }));
}

/** The canonical text the bundle signature covers. */
export function bundleSignedText(b: Pick<CorporateBundle, 'orgId' | 'enabled' | 'bundleHash' | 'generatedAt'>): string {
  return canonicalJson({ kind: BUNDLE_KIND, orgId: b.orgId, enabled: b.enabled, bundleHash: b.bundleHash, generatedAt: b.generatedAt });
}

export interface PolicyActivationPayload {
  kind: typeof POLICY_ACTIVATION_KIND;
  orgId: string;
  policyId: string;
  policyKey: string;
  version: number;
  title: string;
  tier: (typeof TIERS)[number];
  owningBoardIds: string[];
  ruleHash: string;
  enforceFrom: string;
  activatedAt: string;
}

/** The activation payload of a bundle policy, as the server signed it (§8.5). */
export function policyActivationPayload(orgId: string, p: Omit<BundlePolicy, 'activationSignature' | 'rule'>): PolicyActivationPayload {
  return {
    kind: POLICY_ACTIVATION_KIND,
    orgId,
    policyId: p.policyId,
    policyKey: p.policyKey,
    version: p.version,
    title: p.title,
    tier: p.tier,
    owningBoardIds: p.owningBoards.map((b) => b.id),
    ruleHash: p.ruleHash,
    enforceFrom: p.enforceFrom,
    activatedAt: p.activatedAt,
  };
}
