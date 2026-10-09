// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { glob } from 'glob';
import { fetchCorporateBundle } from './corporate/bundle-client.js';
import type { BundlePolicy, CorporateBundle } from './corporate/contracts.js';
import { compileGlobList, toPosixPath } from './corporate/glob.js';
import { languageOf } from './corporate/languages.js';
import {
  evaluateCorporateRules, MAX_CORPORATE_FILE_BYTES, toRepoRelative,
  type CorporateFinding as MatchedCorporateFinding,
} from './corporate/matcher.js';
import type { CorporateFinding, CorporateFindingStatus } from './match/rule-matcher.js';

/**
 * Corporate policy evaluation for a scan (design spec §8.6, Phase 3).
 *
 * The bundle is fetched and its signatures verified BEFORE any of its rules
 * is used (`fetchCorporateBundle` throws NomusApiError on any failure, so a
 * tampered bundle never reaches the matcher). Evaluation is the pure,
 * deterministic matcher of `@nomus/scanner/corporate`: no LLM, no network.
 * The only clock read is the grace-period check, and callers can pin it
 * with `now`.
 *
 * Corporate rules ignore `.nomus.yml` `ignore` and `detectors` (decision
 * D14): the files come from the repository itself, minus the fixed
 * exclusions (`.git`, `node_modules`, files over 2 MB, binary files).
 */

export type CorporateMode = 'auto' | 'off';

export interface CorporateScanOptions {
  /** `auto` fetches the org bundle when an API key is configured; `off` (the default) skips corporate policies. */
  mode: CorporateMode;
  /** A bundle the caller has already verified (the VS Code extension's cache); used instead of fetching. */
  bundle?: CorporateBundle;
  /** The instant grace periods are compared with; defaults to the current time. */
  now?: Date;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface CorporateScanSummary {
  /** True when a verified bundle was used for this scan. */
  available: boolean;
  /** The org has corporate policy governance switched on (false when no bundle was used). */
  enabled: boolean;
  orgId: string | null;
  bundleHash: string | null;
  policyCount: number;
  /** Files that were in scope of at least one active policy and were evaluated. */
  scannedFileCount: number;
  /** Lines longer than 4,096 characters that line_regex rules skipped (§8.4.3). */
  skippedLongLines: number;
  /** Files in scope that were skipped: over 2 MB, binary, or outside the repository. */
  skippedFileCount: number;
}

export interface CorporateScanOutcome {
  findings: CorporateFinding[];
  summary: CorporateScanSummary;
}

/** Files are read in batches so a large repository is never held in memory at once. */
const READ_BATCH = 500;

/** The summary of a scan that did not use corporate policies. */
export function corporateOff(): CorporateScanSummary {
  return {
    available: false, enabled: false, orgId: null, bundleHash: null,
    policyCount: 0, scannedFileCount: 0, skippedLongLines: 0, skippedFileCount: 0,
  };
}

/**
 * The local status of a corporate finding before any review (Phase 3 has no
 * decisions yet): `advisory` for advisory policies, `grace` until the
 * policy's enforce-from instant, otherwise `needs_review`, which blocks.
 */
export function corporateStatusOf(policy: Pick<BundlePolicy, 'tier' | 'enforceFrom'>, now: Date): { status: CorporateFindingStatus; blocking: boolean } {
  if (policy.tier === 'advisory') return { status: 'advisory', blocking: false };
  if (now.getTime() < Date.parse(policy.enforceFrom)) return { status: 'grace', blocking: false };
  return { status: 'needs_review', blocking: true };
}

/**
 * Resolve the bundle a scan uses. `off`, or no API key: none. A bundle
 * passed by the caller is used as is. Otherwise fetch and verify it; any
 * failure throws NomusApiError (fail closed). An engine that predates CPG
 * (404) gives `null`: no corporate policy can exist there.
 */
export async function resolveCorporateBundle(
  options: CorporateScanOptions | undefined,
  apiUrl: string,
  apiKey: string | undefined,
): Promise<CorporateBundle | null> {
  if (!options || options.mode !== 'auto') return null;
  if (options.bundle) return options.bundle;
  if (!apiKey) return null;
  const res = await fetchCorporateBundle({ apiUrl, apiKey, fetchImpl: options.fetchImpl });
  return res.available ? res.bundle : null;
}

function activePolicies(bundle: CorporateBundle): BundlePolicy[] {
  return bundle.enabled ? bundle.policies : [];
}

function summaryFor(bundle: CorporateBundle): CorporateScanSummary {
  return {
    ...corporateOff(),
    available: true,
    enabled: bundle.enabled,
    orgId: bundle.orgId,
    bundleHash: bundle.bundleHash,
    policyCount: activePolicies(bundle).length,
  };
}

function enrich(f: MatchedCorporateFinding, p: BundlePolicy, file: string, now: Date): CorporateFinding {
  const { status, blocking } = corporateStatusOf(p, now);
  return {
    source: 'corporate',
    file,
    filePath: f.filePath,
    language: f.language,
    startLine: f.startLine,
    endLine: f.endLine,
    anchorLine: f.anchorLine,
    matchedBy: f.matchedBy,
    policyKey: f.policyKey,
    policyVersion: f.policyVersion,
    tier: p.tier,
    status,
    blocking,
    enforceFrom: p.enforceFrom,
    fingerprint: f.fingerprint,
    snippetHash: f.snippetHash,
    snippet: f.snippet,
    truncated: f.truncated,
    rule: {
      policyId: p.policyId,
      policyKey: p.policyKey,
      version: p.version,
      title: p.title,
      tier: p.tier,
      message: f.message,
      owningBoards: p.owningBoards.map((b) => ({ id: b.id, name: b.name })),
      enforceFrom: p.enforceFrom,
      activatedAt: p.activatedAt,
      policyReference: `Corporate policy ${p.policyKey} v${p.version}: ${p.title}`,
    },
  };
}

interface Batch {
  files: Array<readonly [string, string]>;
  /** repo-relative path → the path the caller knows the file by */
  original: Map<string, string>;
}

async function evaluateBatches(
  batches: AsyncIterable<Batch> | Iterable<Batch>,
  bundle: CorporateBundle,
  now: Date,
  preSkipped = 0,
): Promise<CorporateScanOutcome> {
  const summary = summaryFor(bundle);
  summary.skippedFileCount = preSkipped;
  const policies = activePolicies(bundle);
  if (policies.length === 0) return { findings: [], summary };
  const byKey = new Map(policies.map((p) => [p.policyKey, p]));
  const inputs = policies.map((p) => ({ policyKey: p.policyKey, version: p.version, rule: p.rule }));
  const findings: CorporateFinding[] = [];
  for await (const batch of batches) {
    const result = await evaluateCorporateRules(batch.files, inputs);
    summary.scannedFileCount += result.scannedFileCount;
    summary.skippedLongLines += result.skippedLongLines;
    summary.skippedFileCount += result.skippedFiles.length;
    for (const f of result.findings) {
      const p = byKey.get(f.policyKey);
      if (!p) continue; // cannot happen: the matcher only reports the policies it was given
      findings.push(enrich(f, p, batch.original.get(f.filePath) ?? f.filePath, now));
    }
  }
  findings.sort((a, b) => (a.filePath !== b.filePath ? (a.filePath < b.filePath ? -1 : 1)
    : a.startLine !== b.startLine ? a.startLine - b.startLine
      : a.policyKey !== b.policyKey ? (a.policyKey < b.policyKey ? -1 : 1) : a.endLine - b.endLine));
  return { findings, summary };
}

/** A predicate: is this repo-relative path in scope of at least one active policy? */
function scopeOf(policies: readonly BundlePolicy[]): (path: string) => boolean {
  const scopes = policies.map((p) => ({
    include: compileGlobList(p.rule.files.include),
    exclude: compileGlobList(p.rule.files.exclude),
    languages: p.rule.files.languages ? new Set<string>(p.rule.files.languages) : null,
  }));
  return (path) => scopes.some((s) => s.include(path) && !s.exclude(path) && (!s.languages || s.languages.has(languageOf(path))));
}

/**
 * Evaluate the bundle's active policies over a repository on disk. Every
 * file under `rootDir` is a candidate (dotfiles included, symlinks not
 * followed) except `.git` and `node_modules`; only files in scope of some
 * policy are read. `generated` lists files the caller itself wrote during
 * this run (the GitHub Action's SARIF reports), which are not the
 * repository's code.
 */
export async function runCorporateScanOnDisk(
  rootDir: string,
  bundle: CorporateBundle,
  options: { now?: Date; generated?: readonly string[] } = {},
): Promise<CorporateScanOutcome> {
  const now = options.now ?? new Date();
  const root = resolve(rootDir);
  const policies = activePolicies(bundle);
  if (policies.length === 0) return evaluateBatches([], bundle, now);
  const inScope = scopeOf(policies);
  const generated = new Set((options.generated ?? []).map((f) => toPosixPath(relative(root, resolve(root, f)))));
  const paths = (await glob('**/*', {
    cwd: root, dot: true, nodir: true, posix: true, follow: false,
    ignore: ['**/.git/**', '**/node_modules/**'],
  })).map((p) => toPosixPath(p)).filter((p) => inScope(p) && !generated.has(p)).sort();

  let tooLarge = 0;
  async function* batches(): AsyncGenerator<Batch> {
    for (let i = 0; i < paths.length; i += READ_BATCH) {
      const files: Array<readonly [string, string]> = [];
      const original = new Map<string, string>();
      for (const rel of paths.slice(i, i + READ_BATCH)) {
        const abs = resolve(root, rel);
        // Skip a file over the size limit without reading it; the matcher would skip it anyway.
        if ((await stat(abs)).size > MAX_CORPORATE_FILE_BYTES) { tooLarge++; continue; }
        files.push([rel, await readFile(abs, 'utf8')] as const);
        original.set(rel, abs);
      }
      yield { files, original };
    }
  }
  const outcome = await evaluateBatches(batches(), bundle, now);
  outcome.summary.skippedFileCount += tooLarge;
  return outcome;
}

/**
 * Evaluate the bundle's active policies over in-memory files. Keys may be
 * absolute (made relative to `rootDir`) or repository-relative; each
 * finding's `file` is the key the caller used.
 */
export async function runCorporateScan(
  files: Iterable<readonly [string, string]>,
  rootDir: string,
  bundle: CorporateBundle,
  options: { now?: Date } = {},
): Promise<CorporateScanOutcome> {
  const root = resolve(rootDir);
  const entries: Array<readonly [string, string]> = [];
  const original = new Map<string, string>();
  let outside = 0;
  for (const [key, content] of files) {
    const rel = toRepoRelative(isAbsolute(key) ? relative(root, key) : key);
    if (rel === null) { outside++; continue; }
    entries.push([rel, content] as const);
    original.set(rel, key);
  }
  return evaluateBatches([{ files: entries, original }], bundle, options.now ?? new Date(), outside);
}

/**
 * The dashboard origin for an API URL, derived as the VS Code extension's
 * "Open Dashboard" does: same origin, except the local development ports
 * (3100 → 5173) and an `api.` host prefix. Undefined when it does not parse.
 */
export function dashboardUrlFromApiUrl(apiUrl: string): string | undefined {
  try {
    const u = new URL(apiUrl);
    if (u.port === '3100') u.port = '5173';
    if (u.hostname.startsWith('api.')) u.hostname = u.hostname.replace(/^api\./, '');
    return u.origin;
  } catch {
    return undefined;
  }
}
