import { describe, it, expect } from 'vitest';
import { PHASE3_RULE_DEFINITIONS } from './seed-phase3-rules.js';

/**
 * Verifies the expected Phase 3 gap-closure rule shapes against
 * the in-memory rule definitions. This proves rule shape correctness
 * without requiring a database. Idempotency (GR22) is enforced by the
 * INSERT-only-if-not-exists logic in seedPhase3Rules() and is exercised
 * implicitly during engine startup.
 */
describe('Phase 3 rule definitions (GR1-GR21)', () => {
  function findByKey(key: string) {
    return PHASE3_RULE_DEFINITIONS.find((r) => r.ruleKey === key);
  }

  function actionOf(key: string): string | undefined {
    const r = findByKey(key);
    if (!r) return undefined;
    try {
      return (JSON.parse(r.conditions) as { action?: string }).action;
    } catch {
      return undefined;
    }
  }

  // GR2-GR4: HIPAA
  it('GR2: hipaa.164_502.phi_in_ai_pipeline -> phi_in_ai_call', () => {
    expect(actionOf('hipaa.164_502.phi_in_ai_pipeline')).toBe('phi_in_ai_call');
  });
  it('GR3: hipaa.164_502.phi_in_source -> contains_phi', () => {
    expect(actionOf('hipaa.164_502.phi_in_source')).toBe('contains_phi');
  });
  it('GR4: hipaa.164_312.phi_logged -> logs_phi', () => {
    expect(actionOf('hipaa.164_312.phi_logged')).toBe('logs_phi');
  });

  // GR5-GR11: GDPR
  it('GR5: gdpr.art5.pii_in_ai_pipeline -> pii_in_ai_call', () => {
    expect(actionOf('gdpr.art5.pii_in_ai_pipeline')).toBe('pii_in_ai_call');
  });
  it('GR6: gdpr.art5.pii_in_source -> contains_pii', () => {
    expect(actionOf('gdpr.art5.pii_in_source')).toBe('contains_pii');
  });
  it('GR7: gdpr.art22.automated_decisions -> returns_ai_to_user', () => {
    expect(actionOf('gdpr.art22.automated_decisions')).toBe('returns_ai_to_user');
  });
  it('GR8: gdpr.art22.user_input_to_ai -> processes_user_input', () => {
    expect(actionOf('gdpr.art22.user_input_to_ai')).toBe('processes_user_input');
  });
  it('GR9: gdpr.art5.ai_output_stored -> stores_ai_output', () => {
    expect(actionOf('gdpr.art5.ai_output_stored')).toBe('stores_ai_output');
  });
  it('GR10: gdpr.art5.ai_output_logged -> logs_ai_output', () => {
    expect(actionOf('gdpr.art5.ai_output_logged')).toBe('logs_ai_output');
  });
  it('GR11: gdpr.art5.ai_output_to_third_party -> sends_to_third_party', () => {
    expect(actionOf('gdpr.art5.ai_output_to_third_party')).toBe('sends_to_third_party');
  });

  // GR12: PCI DSS
  it('GR12: pci_dss.req3.financial_in_source -> contains_financial', () => {
    expect(actionOf('pci_dss.req3.financial_in_source')).toBe('contains_financial');
  });

  // GR13-GR20: EU AI Act Annex III
  const annexCases: Array<[string, string, RegExp]> = [
    ['GR13', 'high_risk_biometric', /^eu_ai_act\.annex_iii\.1a/],
    ['GR14', 'high_risk_critical_infra', /^eu_ai_act\.annex_iii\.2/],
    ['GR15', 'high_risk_education', /^eu_ai_act\.annex_iii\.3/],
    ['GR16', 'high_risk_employment', /^eu_ai_act\.annex_iii\.4/],
    ['GR17', 'high_risk_essential_services', /^eu_ai_act\.annex_iii\.5/],
    ['GR18', 'high_risk_law_enforcement', /^eu_ai_act\.annex_iii\.6/],
    ['GR19', 'high_risk_migration', /^eu_ai_act\.annex_iii\.7/],
    ['GR20', 'high_risk_justice', /^eu_ai_act\.annex_iii\.8/],
  ];

  for (const [gr, action, keyPattern] of annexCases) {
    it(`${gr}: Annex III rule with action=${action} matches ${keyPattern}`, () => {
      const match = PHASE3_RULE_DEFINITIONS.find((r) => {
        if (!keyPattern.test(r.ruleKey)) return false;
        try {
          return (JSON.parse(r.conditions) as { action?: string }).action === action;
        } catch {
          return false;
        }
      });
      expect(match).toBeDefined();
    });
  }

  // EU AI Act Article 50 transparency rules.
  // Art 50 applies from 2026-08-02 — NOT deferred by the Digital Omnibus.
  const art50Cases: Array<[string, string]> = [
    ['eu_ai_act.art50.1.chatbot_disclosure', 'ai_user_interaction'],
    ['eu_ai_act.art50.2.synthetic_content_marking', 'generates_ai_content'],
    ['eu_ai_act.art50.2.synthetic_media_marking', 'generates_synthetic_media'],
    ['eu_ai_act.art50.3.emotion_recognition_disclosure', 'emotion_recognition'],
  ];

  for (const [key, action] of art50Cases) {
    it(`Art 50: ${key} -> ${action}, require_disclosure, effective 2026-08-02`, () => {
      const rule = findByKey(key);
      expect(rule).toBeDefined();
      expect(actionOf(key)).toBe(action);
      expect(rule!.effect).toBe('require_disclosure');
      expect(rule!.effectiveDate).toBe('2026-08-02');
    });
  }

  it('Art 50 rules are EU jurisdiction with region condition', () => {
    for (const [key] of art50Cases) {
      const rule = findByKey(key)!;
      expect(rule.jurisdiction).toBe('EU');
      expect((JSON.parse(rule.conditions) as { region?: string }).region).toBe('EU');
    }
  });

  // GR21: All rules have valid legalReference
  it('GR21: every rule has a non-empty legalReference', () => {
    for (const rule of PHASE3_RULE_DEFINITIONS) {
      expect(rule.legalReference, `${rule.ruleKey} missing legalReference`).toBeTruthy();
      expect(rule.legalReference.length).toBeGreaterThan(10);
    }
  });

  // Sanity: every conditions string parses
  it('every rule has parseable JSON conditions with an action field', () => {
    for (const rule of PHASE3_RULE_DEFINITIONS) {
      const parsed = JSON.parse(rule.conditions) as { action?: string };
      expect(parsed.action, `${rule.ruleKey} missing action`).toBeTruthy();
    }
  });

  // No duplicate ruleKeys (supports idempotency guarantee)
  it('GR22 (shape): rule keys are unique within definitions', () => {
    const keys = PHASE3_RULE_DEFINITIONS.map((r) => r.ruleKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
