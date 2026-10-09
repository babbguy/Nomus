// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Guard: the compliance score is cached for 30 s, so every runtime write to a
 * table the score reads must invalidate the cache. This scans the engine
 * source and fails when a file writes one of those tables without calling an
 * invalidation function, so a new write path cannot bring the stale-score bug
 * back. (Behaviour is covered by routes/compliance-score-freshness.test.ts.)
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix as posixPath, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Drizzle table export -> SQL table name, for the tables calculateScore reads. */
const TABLES: Record<string, string> = {
  policyRules: 'policy_rules',
  aiBomSystems: 'ai_bom_systems',
  benchmarkRuns: 'benchmark_runs',
  scanFindings: 'scan_findings',
  organizations: 'organizations',
};

const posix = (p: string) => p.split(sep).join('/');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // __fixtures__ holds test-only helpers (e.g. cpg/__fixtures__), not runtime code.
    if (entry.isDirectory()) { if (entry.name !== '__fixtures__') sourceFiles(full, out); }
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Tables a file writes at runtime (drizzle builders and raw SQL). */
function writtenTables(text: string): Set<string> {
  const found = new Set<string>();
  for (const [ident, sqlName] of Object.entries(TABLES)) {
    const drizzle = new RegExp(`\\.(insert|update|delete)\\(\\s*${ident}\\s*\\)`);
    const raw = new RegExp(`(insert\\s+(or\\s+\\w+\\s+)?into|update|delete\\s+from|replace\\s+into)\\s+["\`]?${sqlName}\\b`, 'i');
    if (drizzle.test(text) || raw.test(text)) found.add(ident);
  }
  return found;
}

const callsAny = (text: string) => /\binvalidate(All)?ComplianceScores?\(/.test(text);
const callsInvalidateAll = (text: string) => /\binvalidateAllComplianceScores\(/.test(text);

/**
 * Files that write a score input without calling an invalidation function,
 * each with the reason that is safe. Keep this list short: a new runtime
 * write path belongs in the first group (call an invalidation function).
 */
const ALLOWED: Record<string, string> = {
  // Startup seeding. src/index.ts runs every seed before the server listens,
  // so no score can be cached yet. The test below checks nothing else imports
  // a seed file, so none of them can run later.
  'db/seed.ts': 'startup seed',
  'db/seed-rules.ts': 'startup seed',
  'db/seed-ccpa-rules.ts': 'startup seed',
  'db/seed-dora-rules.ts': 'startup seed',
  'db/seed-fda-rules.ts': 'startup seed',
  'db/seed-ferpa-rules.ts': 'startup seed',
  'db/seed-glba-rules.ts': 'startup seed',
  'db/seed-iso27001-rules.ts': 'startup seed',
  'db/seed-nis2-rules.ts': 'startup seed',
  'db/seed-nist-csf-rules.ts': 'startup seed',
  'db/seed-nist-rules.ts': 'startup seed',
  'db/seed-phase3-rules.ts': 'startup seed',
  'db/seed-soc2-rules.ts': 'startup seed',
  'db/seed-trism-rules.ts': 'startup seed',
  // Writes inside the CALLER's transaction (Hunter pipeline, Forge worker).
  // Invalidating there would run before the commit; each caller instead calls
  // publishRuleEvents() after commit, and publishRuleEvents() invalidates
  // every org's score (asserted below).
  'core/rule-upsert.ts': 'in-transaction helper; callers invalidate via publishRuleEvents() after commit',
};

describe('compliance score cache invalidation guard', () => {
  const files = sourceFiles(SRC).map((f) => ({ rel: posix(relative(SRC, f)), text: readFileSync(f, 'utf8') }));
  const writers = files
    .map((f) => ({ ...f, tables: writtenTables(f.text) }))
    .filter((f) => f.tables.size > 0);

  it('finds the known write sites (the scan itself has not rotted)', () => {
    const names = writers.map((w) => w.rel);
    for (const expected of [
      'core/rule-management.ts', 'core/rule-upsert.ts', 'server/routes/admin.ts',
      'server/routes/ai-bom.ts', 'server/routes/benchmarks.ts', 'server/routes/github.ts',
      'server/routes/org.ts', 'server/routes/tenants.ts', 'server/routes/scan.ts', 'db/seed-rules.ts',
    ]) {
      expect(names, `${expected} should be detected as a write site`).toContain(expected);
    }
  });

  it('every runtime write to a score input calls an invalidation function', () => {
    const offenders = writers
      .filter((w) => !(w.rel in ALLOWED) && !callsAny(w.text))
      .map((w) => `${w.rel} writes ${[...w.tables].join(', ')}`);
    expect(
      offenders,
      'These files write a table the compliance score reads but never call invalidateComplianceScore(orgId) / '
      + 'invalidateAllComplianceScores() (core/compliance-score-cache.ts). Call it AFTER the write has committed.',
    ).toEqual([]);
  });

  it('every file that writes policy_rules invalidates ALL orgs (rules are global)', () => {
    const offenders = writers
      .filter((w) => w.tables.has('policyRules') && !(w.rel in ALLOWED) && !callsInvalidateAll(w.text))
      .map((w) => w.rel);
    expect(offenders).toEqual([]);
  });

  it('the allow-list has no stale entries', () => {
    const writerNames = new Set(writers.map((w) => w.rel));
    const stale = Object.keys(ALLOWED).filter((rel) => !writerNames.has(rel));
    expect(stale).toEqual([]);
  });

  it('seed files are only imported at startup (db/seed.ts and index.ts), never by runtime code', () => {
    // Resolve each relative import and flag only those that land on db/seed*.ts
    // (the startup regulation seeds). Other modules named seed.ts, such as
    // cpg/rbac/seed.ts (per-org RBAC setup, which writes no score input), are
    // runtime code by design.
    const importsDbSeed = (f: { rel: string; text: string }) =>
      [...f.text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].some((m) => {
        const target = posixPath.normalize(posixPath.join(posixPath.dirname(f.rel), m[1]));
        return /^db\/seed(-[a-z0-9-]+)?\.js$/.test(target);
      });
    const importers = files
      .filter(importsDbSeed)
      .map((f) => f.rel)
      // seed.ts composes the per-regulation seeds and index.ts runs them at boot.
      .filter((rel) => rel !== 'db/seed.ts' && rel !== 'index.ts');
    expect(importers).toEqual([]);
  });

  it('rule-upsert callers publish after commit, and publishing invalidates every score', () => {
    const callers = files.filter((f) => f.text.includes('upsertExtractedRule(') && f.rel !== 'core/rule-upsert.ts');
    expect(callers.map((c) => c.rel).sort()).toEqual(['forge/pvs-worker.ts', 'hunter/pipeline.ts']);
    for (const caller of callers) {
      expect(caller.text, `${caller.rel} must call publishRuleEvents() after its transaction`).toMatch(/\bpublishRuleEvents\(/);
    }
    const mgmt = files.find((f) => f.rel === 'core/rule-management.ts')!.text;
    const publish = mgmt.slice(mgmt.indexOf('export function publishRuleEvents'));
    expect(publish.slice(0, publish.indexOf('\n}\n'))).toMatch(/invalidateAllComplianceScores\(\)/);
  });
});
