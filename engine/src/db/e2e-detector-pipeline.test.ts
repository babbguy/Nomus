/**
 * E2E pipeline tests — covers PHASE3_GAP_CLOSURE criteria E2E1-E2E6.
 *
 * Validates the FULL pipeline:
 *   detector -> signal -> capability -> seeded rule -> finding (with legalReference)
 *
 * Uses an in-memory SQLite DB seeded with sources + Phase 3 rules + the eight
 * extra regulatory frameworks. Runs detectors directly against fixture content
 * and matches their capabilities against the seeded rule conditions, mirroring
 * what `simulate.ts` does over HTTP.
 *
 * NOT mocked. NOT stubbed. The seeded rules and detector outputs are the real
 * production code paths.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and } from 'drizzle-orm';

import { getDb, closeDb } from './client.js';
import { runMigrations } from './migrate.js';
import { seedPhase3Rules } from './seed-phase3-rules.js';
import { policyRules, regulatorySources } from './schema.js';
import { REGULATORY_SOURCES } from '../hunter/sources/registry.js';
import { randomUUID } from 'node:crypto';

import {
  PhiPatternDetector,
  RiskClassifier,
  SdkUsageDetector,
  DataFlowDetector,
  ImportDetector,
  type DetectorContext,
  type DetectorPlugin,
} from '@nomus/scanner';

interface MatchedRule {
  ruleKey: string;
  legalReference: string;
  severity: string;
  effect: string;
}

interface PipelineFinding {
  file: string;
  line: number;
  detectorSource: string;
  rule: MatchedRule;
}

/**
 * Mirror of simulate.ts matching logic, run against the in-memory DB.
 *
 * Honors the same jurisdiction filter that production simulate uses
 * (`jurisdiction = market OR jurisdiction = 'INTL'`) so this test cannot give
 * false confidence about rules that are dead in production.
 */
function matchSeededRules(
  signals: Array<{ file: string; line: number; source: string; capabilities: string[] }>,
  targetMarkets: string[] = ['EU', 'US-FED'],
): PipelineFinding[] {
  const db = getDb();
  const findings: PipelineFinding[] = [];

  // Pull rules per market (matches simulate.ts behavior including INTL fallthrough)
  const rulesByMarket = new Map<string, ReturnType<typeof db.select.prototype.from>>();
  const allActiveRules = db.select().from(policyRules).where(eq(policyRules.isActive, true)).all();
  const applicableRules = allActiveRules.filter(
    (r) => targetMarkets.includes(r.jurisdiction) || r.jurisdiction === 'INTL',
  );
  void rulesByMarket;

  for (const signal of signals) {
    for (const rule of applicableRules) {
      let conditions: { action?: string };
      try {
        conditions = JSON.parse(rule.conditions);
      } catch {
        continue;
      }
      if (!conditions.action) continue;
      if (signal.capabilities.includes(conditions.action)) {
        findings.push({
          file: signal.file,
          line: signal.line,
          detectorSource: signal.source,
          rule: {
            ruleKey: rule.ruleKey,
            legalReference: rule.legalReference,
            severity: rule.severity,
            effect: rule.effect,
          },
        });
      }
    }
  }

  return findings;
}

async function runDetectors(
  files: Map<string, string>,
  detectors: DetectorPlugin[],
  sector?: string,
) {
  const ctx: DetectorContext = {
    rootDir: '/tmp',
    files: Array.from(files.keys()),
    fileContents: files,
    config: { jurisdictions: ['EU', 'US-FED'], sector },
  };
  const all: Array<{ file: string; line: number; source: string; capabilities: string[] }> = [];
  for (const d of detectors) {
    const sigs = await d.detect(ctx);
    all.push(...sigs);
  }
  return all;
}

beforeAll(() => {
  // Reset singleton in case other tests already opened the DB.
  closeDb();
  // NOMUS_DB_PATH=:memory: from .env.test
  runMigrations();

  // Seed sources from the registry so seedPhase3Rules can resolve sourceId
  const db = getDb();
  const now = new Date().toISOString();
  for (const source of REGULATORY_SOURCES) {
    db.insert(regulatorySources).values({
      id: randomUUID(),
      name: source.name,
      jurisdiction: source.jurisdiction,
      url: source.url,
      parserType: source.parserType,
      selectorConfig: JSON.stringify(source.selectorConfig),
      scrapeFrequencyHours: source.scrapeFrequencyHours ?? 168,
      isActive: true,
      tier: source.tier,
      category: source.category ?? 'ai_regulation',
      ingestionMode: source.ingestionMode,
      provenanceGrade: 'A',
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  seedPhase3Rules(db as any);
});

const phi = new PhiPatternDetector();
const risk = new RiskClassifier();
const sdk = new SdkUsageDetector();
const flow = new DataFlowDetector();
const imp = new ImportDetector();
const ALL: DetectorPlugin[] = [imp, sdk, phi, risk, flow];

describe('E2E pipeline: detector -> signal -> seeded rule -> finding', () => {
  it('E2E1: SSN + AI SDK call -> HIPAA-tagged finding', async () => {
    const files = new Map([
      [
        '/tmp/patient.ts',
        `const patientName = req.body.name;
         const ssn = "234-56-7890";
         const r = await openai.chat.completions.create({ messages: [{ role: 'user', content: patientName }] });
         res.json(r);`,
      ],
    ]);
    const signals = await runDetectors(files, ALL);
    const findings = matchSeededRules(signals);

    const hipaaHit = findings.find((f) => /hipaa/i.test(f.rule.legalReference) || /hipaa/i.test(f.rule.ruleKey));
    expect(hipaaHit, 'expected at least one HIPAA-tagged finding').toBeDefined();
  });

  it('E2E2: PII + AI call -> GDPR-tagged finding', async () => {
    const files = new Map([
      [
        '/tmp/eu.ts',
        `const userEmail = req.body.email;
         const ssn = "234-56-7890";
         await openai.chat.completions.create({ messages: [{ content: userEmail }] });`,
      ],
    ]);
    const signals = await runDetectors(files, ALL);
    const findings = matchSeededRules(signals);
    const gdprHit = findings.find((f) => /gdpr/i.test(f.rule.legalReference) || /gdpr/i.test(f.rule.ruleKey));
    expect(gdprHit, 'expected at least one GDPR-tagged finding').toBeDefined();
  });

  it('E2E3: credit card data -> PCI DSS-tagged finding (INTL rule reachable from EU/US-FED markets)', async () => {
    const files = new Map([
      [
        '/tmp/checkout.ts',
        `const credit_card_number = "4111-1111-1111-1111";
         const card_cvv = "123";
         processPayment(credit_card_number, card_cvv);`,
      ],
    ]);
    const signals = await runDetectors(files, ALL);
    // INTL rules must apply when querying EU or US-FED — this is the
    // production-correct behavior validated by the jurisdiction filter in simulate.ts
    const findings = matchSeededRules(signals, ['EU', 'US-FED']);
    const pciHit = findings.find((f) => /pci/i.test(f.rule.legalReference) || /pci/i.test(f.rule.ruleKey));
    expect(pciHit, 'expected at least one PCI DSS-tagged finding').toBeDefined();
  });

  it('E2E4: face recognition -> EU AI Act Annex III finding', async () => {
    const files = new Map([
      [
        '/tmp/auth.py',
        `from deepface import DeepFace
def verify(a, b): return DeepFace.verify(a, b)`,
      ],
    ]);
    const signals = await runDetectors(files, ALL);
    const findings = matchSeededRules(signals);
    const annexHit = findings.find(
      (f) => /eu_ai_act|annex/i.test(f.rule.ruleKey) || /eu ai act|annex iii/i.test(f.rule.legalReference),
    );
    expect(annexHit, 'expected at least one EU AI Act Annex III finding').toBeDefined();
  });

  it('E2E5: req.body -> AI call -> res.json -> GDPR Art.22 finding', async () => {
    const files = new Map([
      [
        '/tmp/api.ts',
        `app.post('/decide', async (req, res) => {
           const input = req.body.q;
           const r = await openai.chat.completions.create({ messages: [{ content: input }] });
           res.json(r);
         });`,
      ],
    ]);
    const signals = await runDetectors(files, ALL);
    const findings = matchSeededRules(signals);
    const art22 = findings.find((f) => /art22|art\.?\s*22/i.test(f.rule.ruleKey) || /article 22/i.test(f.rule.legalReference));
    expect(art22, 'expected GDPR Art.22 finding from data flow').toBeDefined();
  });

  it('E2E6: dashboard finding shape carries detectorSource for badge rendering', async () => {
    const files = new Map([
      [
        '/tmp/x.ts',
        `const ssn = "234-56-7890";
         await openai.chat.completions.create({});`,
      ],
    ]);
    const signals = await runDetectors(files, ALL);
    const findings = matchSeededRules(signals);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.detectorSource).toBeTruthy();
      expect(typeof f.rule.legalReference).toBe('string');
      expect(f.rule.legalReference.length).toBeGreaterThan(5);
    }
  });
});
