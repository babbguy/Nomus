/**
 * Regulatory Expansion verification — checks rule coverage for 12 regulatory frameworks.
 *
 * Walks each framework's expected rules and registry entries against the seeded in-memory DB and the
 * filesystem (registry, scout feeds). Each `it` block checks one expectation.
 *
 * Frameworks covered:
 *   NIS2, DORA, FDA 21 CFR 11, FDA AI/ML SaMD, GLBA, SOC 2,
 *   NIST AI RMF, ISO 27001, CCPA/CPRA, FERPA, TRIsM, NIST CSF 2.0
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and, like, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { getDb, closeDb } from './client.js';
import { runMigrations } from './migrate.js';
import { initSigningKeys } from '../core/signing.js';
import { policyRules, regulatorySources } from './schema.js';
import { REGULATORY_SOURCES } from '../hunter/sources/registry.js';
import { seedPhase3Rules } from './seed-phase3-rules.js';
import { seedNis2Rules } from './seed-nis2-rules.js';
import { seedDoraRules } from './seed-dora-rules.js';
import { seedFdaRules } from './seed-fda-rules.js';
import { seedCcpaRules } from './seed-ccpa-rules.js';
import { seedFerpaRules, FERPA_EFFECTIVE_DATE } from './seed-ferpa-rules.js';
import { seedGlbaRules } from './seed-glba-rules.js';
import { seedIso27001Rules } from './seed-iso27001-rules.js';
import { seedSoc2Rules, TSC_2017_EFFECTIVE_DATE } from './seed-soc2-rules.js';
import { seedTrismRules, TRISM_PUBLICATION_DATE } from './seed-trism-rules.js';
import { seedNistRules } from './seed-nist-rules.js';
import { seedNistCsfRules } from './seed-nist-csf-rules.js';

const REGISTRY_FILE = resolve(__dirname, '../hunter/sources/registry.ts');
const FEEDS_FILE = resolve(__dirname, '../scout/default-feeds.ts');
const SEED_FILE = resolve(__dirname, './seed.ts');

let registryContent = '';
let feedsContent = '';
let seedContent = '';

function ruleCount(prefix: string): number {
  const db = getDb();
  const r = db
    .select({ c: sql<number>`count(*)` })
    .from(policyRules)
    .where(like(policyRules.ruleKey, `${prefix}%`))
    .get();
  return r?.c ?? 0;
}

function findRule(pattern: string) {
  const db = getDb();
  return db.select().from(policyRules).where(like(policyRules.ruleKey, pattern)).all();
}

function expectIdempotent(seedFn: () => { created: number; skipped: number }) {
  const first = seedFn();
  const totalAfterFirst = first.created + first.skipped;
  const second = seedFn();
  const totalAfterSecond = second.created + second.skipped;
  // After the first call rules exist; second call must skip them all
  expect(second.created).toBe(0);
  expect(totalAfterSecond).toBeGreaterThanOrEqual(totalAfterFirst);
}

beforeAll(() => {
  closeDb();
  runMigrations();
  // Some seed functions sign their inserts (signature column on policy_rules).
  // Initialize the keypair before any seeding runs.
  initSigningKeys();
  registryContent = readFileSync(REGISTRY_FILE, 'utf-8');
  feedsContent = readFileSync(FEEDS_FILE, 'utf-8');
  seedContent = readFileSync(SEED_FILE, 'utf-8');

  // Seed regulatory sources from the registry
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

  // Seed all rule frameworks
  seedPhase3Rules(db as any);
  seedNis2Rules(db as any);
  seedDoraRules(db as any);
  seedFdaRules();
  seedCcpaRules(db as any);
  seedFerpaRules(db as any);
  seedGlbaRules(db as any);
  seedIso27001Rules(db as any);
  seedSoc2Rules(db as any);
  seedTrismRules(db as any);
  seedNistRules(db as any);
  seedNistCsfRules(db as any);
});

// ════════════════════════════════════════════════════════════════════
// Segment 1: EU Clients
// ════════════════════════════════════════════════════════════════════

describe('NIS2 Directive (NIS2-1..NIS2-10)', () => {
  it('NIS2-1: source registered', () => expect(/nis2/i.test(registryContent)).toBe(true));
  it('NIS2-2: seed-nis2-rules.ts exists', () => expect(typeof seedNis2Rules).toBe('function'));
  it('NIS2-7: at least one nis2 rule seeded', () => expect(ruleCount('nis2')).toBeGreaterThan(0));
  it('NIS2-8: scout feed for NIS2', () => expect(/nis2/i.test(feedsContent)).toBe(true));
  it('NIS2-9: idempotent', () => expectIdempotent(() => seedNis2Rules(getDb() as any)));
  it('NIS2-10: integrated into seedDatabase', () => expect(/seedNis2Rules/.test(seedContent)).toBe(true));
});

describe('DORA (DORA-1..DORA-10)', () => {
  it('DORA-1: source registered', () => expect(/dora/i.test(registryContent)).toBe(true));
  it('DORA-2: seed-dora-rules.ts exists', () => expect(typeof seedDoraRules).toBe('function'));
  it('DORA-7: at least one dora rule seeded', () => expect(ruleCount('dora')).toBeGreaterThan(0));
  it('DORA-8: dora rules tagged for finance', () => {
    const rules = findRule('dora%');
    expect(rules.length).toBeGreaterThan(0);
    const anyFinance = rules.some((r) => /finance/i.test(r.industries));
    expect(anyFinance).toBe(true);
  });
  it('DORA-9: scout feed for DORA', () => expect(/dora/i.test(feedsContent)).toBe(true));
  it('DORA-10: idempotent + integrated', () => {
    expect(/seedDoraRules/.test(seedContent)).toBe(true);
    expectIdempotent(() => seedDoraRules(getDb() as any));
  });
});

// ════════════════════════════════════════════════════════════════════
// Segment 2: US Healthcare
// ════════════════════════════════════════════════════════════════════

describe('FDA 21 CFR Part 11 (FDA-1..FDA-8)', () => {
  it('FDA-1: source registered', () => expect(/fda/i.test(registryContent)).toBe(true));
  it('FDA-2: seed-fda-rules.ts exists', () => expect(typeof seedFdaRules).toBe('function'));
  it('FDA-7: at least one FDA rule seeded', () => {
    expect(ruleCount('fda')).toBeGreaterThan(0);
  });
  it('FDA-7: scout feed for FDA AI/ML', () => expect(/fda/i.test(feedsContent)).toBe(true));
  it('FDA-8: integrated into seedDatabase', () => expect(/seedFdaRules/.test(seedContent)).toBe(true));
});

describe('FDA AI/ML SaMD (SAMD-1..SAMD-7)', () => {
  it('SAMD-2: at least one SaMD/AI-ML rule seeded under fda namespace', () => {
    // SaMD rules live under the same seed-fda-rules.ts file in our impl
    const samdRules = findRule('fda%');
    expect(samdRules.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// Segment 3: US Finance
// ════════════════════════════════════════════════════════════════════

describe('GLBA Safeguards Rule (GLBA-1..GLBA-10)', () => {
  it('GLBA-1: source registered', () => expect(/glba/i.test(registryContent)).toBe(true));
  it('GLBA-2: seed-glba-rules.ts exists', () => expect(typeof seedGlbaRules).toBe('function'));
  it('GLBA-3-7: at least one glba rule seeded', () => expect(ruleCount('glba')).toBeGreaterThan(0));
  it('GLBA-8: glba rules tagged finance', () => {
    const rules = findRule('glba%');
    expect(rules.some((r) => /finance/i.test(r.industries))).toBe(true);
  });
  it('GLBA-9: scout feed for GLBA', () => expect(/glba/i.test(feedsContent)).toBe(true));
  it('GLBA-10: idempotent + integrated', () => {
    expect(/seedGlbaRules/.test(seedContent)).toBe(true);
    expectIdempotent(() => seedGlbaRules(getDb() as any));
  });
});

describe('SOC 2 (SOC2-1..SOC2-10)', () => {
  it('SOC2-1: source registered', () => expect(/soc.?2/i.test(registryContent)).toBe(true));
  it('SOC2-2: seed-soc2-rules.ts exists', () => expect(typeof seedSoc2Rules).toBe('function'));
  it('SOC2-3-8: at least one soc2 rule seeded', () => expect(ruleCount('soc2')).toBeGreaterThan(0));
  it('SOC2-9: scout feed for SOC 2', () => expect(/soc.?2/i.test(feedsContent)).toBe(true));
  it('SOC2-10: idempotent + integrated', () => {
    expect(/seedSoc2Rules/.test(seedContent)).toBe(true);
    expectIdempotent(() => seedSoc2Rules(getDb() as any));
  });
});

// ════════════════════════════════════════════════════════════════════
// Segment 4: General Enterprise
// ════════════════════════════════════════════════════════════════════

describe('NIST AI RMF (NIST-1..NIST-9)', () => {
  it('NIST-1: source registered', () => expect(/nist.+ai/i.test(registryContent)).toBe(true));
  it('NIST-2: seed-nist-rules.ts exists', () => expect(typeof seedNistRules).toBe('function'));
  it('NIST-7: at least one NIST AI RMF rule seeded', () => {
    expect(ruleCount('nist_ai_rmf')).toBeGreaterThan(0);
  });
  it('NIST-8: scout feed for NIST', () => expect(/nist/i.test(feedsContent)).toBe(true));
  it('NIST-9: idempotent + integrated', () => {
    expect(/seedNistRules/.test(seedContent)).toBe(true);
    expectIdempotent(() => seedNistRules(getDb() as any));
  });
});

describe('ISO 27001:2022 (ISO-1..ISO-9)', () => {
  it('ISO-1: source registered', () => expect(/iso.?27001/i.test(registryContent)).toBe(true));
  it('ISO-2: seed-iso27001-rules.ts exists', () => expect(typeof seedIso27001Rules).toBe('function'));
  it('ISO-7: at least one iso27001 rule seeded', () => {
    expect(ruleCount('iso27001')).toBeGreaterThan(0);
  });
  it('ISO-8: scout feed for ISO', () => expect(/iso.?27001/i.test(feedsContent)).toBe(true));
  it('ISO-9: idempotent + integrated', () => {
    expect(/seedIso27001Rules/.test(seedContent)).toBe(true);
    expectIdempotent(() => seedIso27001Rules(getDb() as any));
  });
});

describe('CCPA/CPRA (CCPA-1..CCPA-9)', () => {
  it('CCPA-1: source registered', () => expect(/ccpa|cpra/i.test(registryContent)).toBe(true));
  it('CCPA-2: seed-ccpa-rules.ts exists', () => expect(typeof seedCcpaRules).toBe('function'));
  it('CCPA-3-6: at least one ccpa rule seeded', () => {
    expect(ruleCount('ccpa')).toBeGreaterThan(0);
  });
  it('CCPA-7: ccpa rules use US-CA jurisdiction', () => {
    const rules = findRule('ccpa%');
    expect(rules.length).toBeGreaterThan(0);
    const allCa = rules.every((r) => r.jurisdiction === 'US-CA' || r.jurisdiction === 'US');
    expect(allCa).toBe(true);
  });
  it('CCPA-8: scout feed for CCPA', () => expect(/ccpa|cpra/i.test(feedsContent)).toBe(true));
  it('CCPA-9: idempotent + integrated', () => {
    expect(/seedCcpaRules/.test(seedContent)).toBe(true);
    expectIdempotent(() => seedCcpaRules(getDb() as any));
  });
});

// ════════════════════════════════════════════════════════════════════
// Segment 5: Remaining
// ════════════════════════════════════════════════════════════════════

describe('FERPA (FERPA-1..FERPA-8)', () => {
  it('FERPA-1: source registered', () => expect(/ferpa/i.test(registryContent)).toBe(true));
  it('FERPA-2: seed-ferpa-rules.ts exists', () => expect(typeof seedFerpaRules).toBe('function'));
  it('FERPA-3-5: at least one ferpa rule seeded', () => expect(ruleCount('ferpa')).toBeGreaterThan(0));
  it('FERPA-6: ferpa rules tagged for education', () => {
    const rules = findRule('ferpa%');
    expect(rules.some((r) => /education/i.test(r.industries))).toBe(true);
  });
  it('FERPA-7: scout feed for FERPA', () => expect(/ferpa/i.test(feedsContent)).toBe(true));
  it('FERPA-8: idempotent + integrated', () => {
    expect(/seedFerpaRules/.test(seedContent)).toBe(true);
    expectIdempotent(() => seedFerpaRules(getDb() as any));
  });
});

describe('TRiSM (TRISM-1..TRISM-8)', () => {
  it('TRISM-2: seed-trism-rules.ts exists', () => expect(typeof seedTrismRules).toBe('function'));
  it('TRISM-7: at least one trism rule seeded', () => expect(ruleCount('trism')).toBeGreaterThan(0));
  it('TRISM-8: idempotent + integrated', () => {
    expect(/seedTrismRules/.test(seedContent)).toBe(true);
    expectIdempotent(() => seedTrismRules(getDb() as any));
  });
});

describe('NIST CSF 2.0 (CSF-1..CSF-8)', () => {
  it('CSF-1: source registered', () => expect(/cybersecurity.*framework|nist.*csf/i.test(registryContent)).toBe(true));
  it('CSF-2: seed-nist-csf-rules.ts exists', () => expect(typeof seedNistCsfRules).toBe('function'));
  it('CSF-7: at least one nist_csf rule seeded', () => expect(ruleCount('nist_csf')).toBeGreaterThan(0));
  it('CSF-8: idempotent + integrated', () => {
    expect(/seedNistCsfRules/.test(seedContent)).toBe(true);
    expectIdempotent(() => seedNistCsfRules(getDb() as any));
  });
});

// ════════════════════════════════════════════════════════════════════
// Cross-cutting: legalReference quality + minimum rule counts
// ════════════════════════════════════════════════════════════════════

describe('Cross-cutting rule quality', () => {
  it('every seeded rule has a non-empty legalReference', () => {
    const db = getDb();
    const rules = db.select().from(policyRules).all();
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.legalReference, `${r.ruleKey} missing legalReference`).toBeTruthy();
      expect(r.legalReference.length).toBeGreaterThan(5);
    }
  });

  it('every rule has parseable JSON conditions', () => {
    const db = getDb();
    const rules = db.select().from(policyRules).all();
    for (const r of rules) {
      expect(() => JSON.parse(r.conditions), `${r.ruleKey} bad conditions`).not.toThrow();
    }
  });

  it('every rule has a real conditions.action that some detector can emit', () => {
    // Capabilities that the live Phase 3 detectors emit. Any rule whose
    // conditions.action is NOT in this set is a dead rule (will never fire).
    // This is the test that v2.0 missed and the integrity audit caught.
    const KNOWN_CAPABILITIES = new Set([
      // PHI/PII detector
      'contains_phi', 'contains_pii', 'contains_financial',
      'handles_phi', 'handles_pii', 'handles_financial',
      'phi_in_ai_call', 'pii_in_ai_call',
      'logs_phi', 'logs_pii',
      // Risk classifier
      'high_risk_biometric', 'high_risk_critical_infra',
      'high_risk_education', 'high_risk_employment',
      'high_risk_essential_services', 'high_risk_law_enforcement',
      'high_risk_migration', 'high_risk_justice',
      'handles_biometric',
      // SDK usage / import
      'text_generation', 'embeddings', 'image_generation',
      'speech_to_text', 'text_to_speech', 'content_moderation',
      'model_finetuning', 'classification', 'rerank',
      // Data flow
      'processes_user_input', 'returns_ai_to_user',
      'logs_ai_output', 'stores_ai_output', 'sends_to_third_party',
      // Transparency detector (EU AI Act Article 50)
      'ai_user_interaction', 'generates_ai_content',
      'generates_synthetic_media', 'emotion_recognition',
      // Misc
      'contains_secret',
    ]);

    const db = getDb();
    const rules = db.select().from(policyRules).all();
    const orphans: string[] = [];
    for (const r of rules) {
      let cond: { action?: string };
      try { cond = JSON.parse(r.conditions); } catch { continue; }
      if (cond.action && !KNOWN_CAPABILITIES.has(cond.action)) {
        orphans.push(`${r.ruleKey} -> ${cond.action}`);
      }
    }
    if (orphans.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`Orphan rules (action not emitted by any detector): ${orphans.length}`);
      // eslint-disable-next-line no-console
      console.warn(orphans.slice(0, 10).join('\n'));
    }
    // No more than 5% orphan rules. Tighter would be 0 but the regulatory
    // seed files may include forward-looking rules for capabilities the
    // detectors don't yet emit (e.g. specific incident-reporting flows).
    expect(orphans.length / rules.length).toBeLessThan(0.05);
  });

  it('jurisdiction filter test: INTL rules are reachable from EU/US-FED markets', () => {
    // Mirror of simulate.ts production WHERE clause. The query includes an
    // OR jurisdiction='INTL' clause; this test makes sure it stays in place.
    const db = getDb();
    const intlRules = db
      .select()
      .from(policyRules)
      .where(and(eq(policyRules.isActive, true), eq(policyRules.jurisdiction, 'INTL')))
      .all();
    expect(intlRules.length).toBeGreaterThan(0); // PCI DSS lives here
    // The PCI rule must exist and be retrievable via the INTL bucket.
    const pci = intlRules.find((r) => /pci/i.test(r.ruleKey));
    expect(pci, 'PCI DSS rule not found in INTL jurisdiction').toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// Stronger framework-specific assertions
// ════════════════════════════════════════════════════════════════════

describe('Framework rule counts (minimum thresholds)', () => {
  // These are minimum rule-count thresholds per framework.
  // A weak seed file that ships one stub rule will fail these checks.
  const MIN_COUNTS: Array<[string, number, string]> = [
    ['nis2', 4, 'NIS2-3..NIS2-6 require 4+ distinct rules'],
    ['dora', 5, 'DORA-3..DORA-7 require 5+ distinct rules'],
    ['fda', 3, 'FDA-3..FDA-5 require 3+ rules'],
    ['glba', 5, 'GLBA-3..GLBA-7 require 5+ rules'],
    ['soc2', 6, 'SOC2-3..SOC2-8 require 6+ rules'],
    ['nist_ai_rmf', 10, 'NIST-7 requires 10+ rules total'],
    ['iso27001', 4, 'ISO-3..ISO-6 require 4+ rules (target is 10)'],
    ['ccpa', 4, 'CCPA-3..CCPA-6 require 4+ rules'],
    ['ferpa', 3, 'FERPA-3..FERPA-5 require 3+ rules'],
    ['trism', 4, 'TRISM-3..TRISM-6 require 4+ rules'],
    ['nist_csf', 4, 'CSF-3..CSF-6 require 4+ rules'],
  ];

  for (const [prefix, min, why] of MIN_COUNTS) {
    it(`${prefix}: at least ${min} distinct rules seeded — ${why}`, () => {
      const count = ruleCount(prefix);
      expect(count).toBeGreaterThanOrEqual(min);
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// effective_date must state when the obligation applies,
// never the seed-run timestamp.
// ════════════════════════════════════════════════════════════════════

describe('sourced effective dates (FDA, FERPA, SOC 2, TRiSM)', () => {
  function dateOf(ruleKey: string): string | undefined {
    const db = getDb();
    return db
      .select({ effectiveDate: policyRules.effectiveDate })
      .from(policyRules)
      .where(eq(policyRules.ruleKey, ruleKey))
      .get()?.effectiveDate;
  }

  // FDA per-rule dates (mixed citations → per-rule vintages)
  const FDA_DATE_CASES: Array<[string, string, string]> = [
    ['fda.21cfr11.10.system_controls', '1997-08-20', '21 CFR Part 11 effective date (62 FR 13430)'],
    ['fda.21cfr11.10e.audit_trails', '1997-08-20', '21 CFR Part 11 effective date (62 FR 13430)'],
    ['fda.21cfr11.50.signature_integrity', '1997-08-20', '21 CFR Part 11 effective date (62 FR 13430)'],
    ['fda.aiml_samd.predetermined_change_control', '2023-04-03', 'PCCP draft guidance FR availability'],
    ['fda.aiml_samd.gmlp', '2021-10-27', 'GMLP guiding principles publication'],
    ['fda.aiml_samd.transparency', '2021-01-12', 'AI/ML SaMD Action Plan publication'],
    ['fda.postmarket.real_world_performance', '2021-01-12', 'AI/ML SaMD Action Plan publication'],
    ['samd.iec62304.software_lifecycle', '2015-06-26', 'IEC 62304 AMD1:2015 publication'],
    ['samd.imdrf.risk_classification', '2014-09-18', 'IMDRF/SaMD WG/N12 final document'],
    ['samd.cybersecurity', '2023-09-27', 'Premarket cybersecurity final guidance (FR 2023-20955)'],
  ];

  for (const [key, date, why] of FDA_DATE_CASES) {
    it(`FDA: ${key} → ${date} (${why})`, () => {
      expect(dateOf(key)).toBe(date);
    });
  }

  it(`FERPA: every rule → ${FERPA_EFFECTIVE_DATE} (76 FR 75604, effective 2012-01-03)`, () => {
    const rules = findRule('ferpa%');
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.effectiveDate, r.ruleKey).toBe(FERPA_EFFECTIVE_DATE);
    }
    expect(FERPA_EFFECTIVE_DATE).toBe('2012-01-03');
  });

  it(`SOC 2: every rule → ${TSC_2017_EFFECTIVE_DATE} (2017 TSC mandatory for periods ending on/after 2018-12-15)`, () => {
    const rules = findRule('soc2%');
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.effectiveDate, r.ruleKey).toBe(TSC_2017_EFFECTIVE_DATE);
    }
    expect(TSC_2017_EFFECTIVE_DATE).toBe('2018-12-15');
  });

  it(`TRiSM: every rule → ${TRISM_PUBLICATION_DATE} (Gartner Market Guide publication — framework, not law)`, () => {
    const rules = findRule('trism%');
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.effectiveDate, r.ruleKey).toBe(TRISM_PUBLICATION_DATE);
    }
    expect(TRISM_PUBLICATION_DATE).toBe('2021-09-01');
  });

  it('no seeded rule in these four frameworks carries a timestamp-shaped effective_date', () => {
    const prefixes = ['fda%', 'samd%', 'ferpa%', 'soc2%', 'trism%'];
    for (const p of prefixes) {
      for (const r of findRule(p)) {
        // Seed-run timestamps are full ISO datetimes; sourced dates are YYYY-MM-DD.
        expect(r.effectiveDate, `${r.ruleKey} looks like a seed-run timestamp`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('refresh: unsigned v1 rows with a stale seed-run timestamp get corrected on reseed (FERPA)', () => {
    const db = getDb();
    const stale = new Date().toISOString();
    db.update(policyRules)
      .set({ effectiveDate: stale })
      .where(eq(policyRules.ruleKey, 'ferpa.99_30.consent_required'))
      .run();
    seedFerpaRules(db as any);
    expect(dateOf('ferpa.99_30.consent_required')).toBe(FERPA_EFFECTIVE_DATE);
  });

  it('refresh: signed v1 FDA rows get corrected on reseed (signature excludes effective_date)', () => {
    const db = getDb();
    const stale = new Date().toISOString();
    db.update(policyRules)
      .set({ effectiveDate: stale })
      .where(eq(policyRules.ruleKey, 'fda.21cfr11.10.system_controls'))
      .run();
    seedFdaRules();
    expect(dateOf('fda.21cfr11.10.system_controls')).toBe('1997-08-20');
  });

  it('refresh does not touch rows the Hunter has versioned past v1', () => {
    const db = getDb();
    const stale = '2099-01-01';
    db.update(policyRules)
      .set({ effectiveDate: stale, version: 2 })
      .where(eq(policyRules.ruleKey, 'trism.modelops.inventory'))
      .run();
    seedTrismRules(db as any);
    expect(dateOf('trism.modelops.inventory')).toBe(stale);
    // Restore for any later assertions
    db.update(policyRules)
      .set({ effectiveDate: TRISM_PUBLICATION_DATE, version: 1 })
      .where(eq(policyRules.ruleKey, 'trism.modelops.inventory'))
      .run();
  });
});
