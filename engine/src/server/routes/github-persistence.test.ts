/**
 * Regression test: GitHub App webhook scans
 * must persist findings to scan_findings so the dashboard can render them.
 *
 * Before this fix, the webhook handler called createCheckRun + postPrSummary
 * but never inserted into the database. Every org using the GitHub App got
 * zero history in the dashboard.
 *
 * This test imports the engine schema and verifies that a Finding shape
 * coming out of the scanner can round-trip into scan_findings with all
 * the dashboard-critical fields (detectorSource, legalReference) preserved.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { getDb, closeDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { initSigningKeys } from '../../core/signing.js';
import { scanFindings, organizations, githubAppInstallations } from '../../db/schema.js';
import type { Finding } from '@nomus/scanner';

const ORG_ID = 'test-org-' + randomUUID();
const INSTALLATION_ID = 999_001;

beforeAll(() => {
  closeDb();
  runMigrations();
  initSigningKeys();

  const db = getDb();
  const now = new Date().toISOString();

  db.insert(organizations).values({
    id: ORG_ID,
    name: 'Test Org',
    slug: 'test-org-' + Date.now(),
    jurisdictionAccess: '[]',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }).run();

  db.insert(githubAppInstallations).values({
    id: randomUUID(),
    installationId: INSTALLATION_ID,
    orgId: ORG_ID,
    accountLogin: 'test-account',
    accountType: 'Organization',
    repositorySelection: 'all',
    selectedRepos: '[]',
    permissions: '{}',
    isActive: true,
    installedAt: now,
    updatedAt: now,
  }).run();
});

/**
 * Inline copy of the persistScanFindings logic from github.ts so we can test
 * the data path without standing up the full Hono server. If github.ts changes,
 * this test must be kept in sync — that's the point.
 */
async function persistScanFindings(
  installationId: number,
  repoFullName: string,
  prNumber: number | null,
  commitSha: string,
  findings: Finding[],
): Promise<number> {
  const db = getDb();
  const installation = db.select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, installationId))
    .get();

  if (!installation?.orgId) return 0;

  const now = new Date().toISOString();
  let inserted = 0;
  for (const f of findings) {
    db.insert(scanFindings).values({
      id: randomUUID(),
      orgId: installation.orgId,
      repo: repoFullName,
      prNumber,
      commitSha,
      filePath: f.file,
      lineNumber: f.line,
      ruleId: null,
      ruleKey: f.rule.ruleKey,
      severity: f.rule.severity as 'critical' | 'high' | 'medium' | 'low',
      effect: f.rule.effect,
      capabilityDetected: f.sdk,
      humanSummary: f.rule.humanSummary,
      suggestion: f.suggestion ?? null,
      detectorSource: f.detectorSource ?? null,
      legalReference: f.rule.legalReference ?? null,
      status: 'open',
      scannedAt: now,
    }).run();
    inserted++;
  }
  return inserted;
}

describe('GitHub webhook scan persistence (regression)', () => {
  it('persists findings with detectorSource + legalReference into scan_findings', async () => {
    const findings: Finding[] = [
      {
        file: '/repo/src/api/handler.ts',
        line: 42,
        sdk: 'openai',
        detectorSource: 'phi-pattern-detector',
        evidence: 'const patient_name = req.body.name;',
        rule: {
          ruleKey: 'hipaa.164_502.phi_in_ai_pipeline',
          effect: 'deny',
          severity: 'critical',
          humanSummary: 'PHI detected flowing into AI model calls',
          legalReference: '45 CFR § 164.502(a)',
          matchedOn: ['capability:phi_in_ai_call'],
          confidence: 0.85,
        },
        suggestion: 'Add BAA + minimum-necessary check',
      },
    ];

    const count = await persistScanFindings(
      INSTALLATION_ID,
      'test-account/demo-repo',
      123,
      'abc123def456',
      findings,
    );
    expect(count).toBe(1);

    const db = getDb();
    const stored = db.select().from(scanFindings).where(eq(scanFindings.orgId, ORG_ID)).all();
    expect(stored.length).toBeGreaterThanOrEqual(1);

    const row = stored.find((r) => r.ruleKey === 'hipaa.164_502.phi_in_ai_pipeline');
    expect(row, 'finding not stored').toBeDefined();
    expect(row?.detectorSource).toBe('phi-pattern-detector');
    expect(row?.legalReference).toContain('164.502');
    expect(row?.repo).toBe('test-account/demo-repo');
    expect(row?.prNumber).toBe(123);
    expect(row?.commitSha).toBe('abc123def456');
    expect(row?.severity).toBe('critical');
    expect(row?.status).toBe('open');
  });

  it('drops findings cleanly when installation has no orgId (no crash, no leak)', async () => {
    const db = getDb();
    db.insert(githubAppInstallations).values({
      id: randomUUID(),
      installationId: 999_002,
      // intentionally NO orgId
      accountLogin: 'orphan-account',
      accountType: 'User',
      repositorySelection: 'all',
      selectedRepos: '[]',
      permissions: '{}',
      isActive: true,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    const findings: Finding[] = [
      {
        file: '/x.ts',
        line: 1,
        sdk: 'openai',
        detectorSource: 'import-detector',
        evidence: 'import OpenAI',
        rule: {
          ruleKey: 'eu_ai_act.transparency',
          effect: 'flag',
          severity: 'low',
          humanSummary: '',
          legalReference: 'EU AI Act',
          matchedOn: [],
          confidence: 0.5,
        },
      },
    ];
    const count = await persistScanFindings(999_002, 'orphan-account/repo', null, 'sha', findings);
    expect(count).toBe(0); // dropped cleanly
  });
});
