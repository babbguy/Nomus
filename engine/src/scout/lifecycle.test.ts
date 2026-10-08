import { describe, it, expect } from 'vitest';
import {
  LIFECYCLE_STAGES,
  PHASES,
  getStage,
  getProgress,
  isTerminal,
  isValidStageId,
  getStagesByPhase,
  getJurisdictionMapping,
  getJurisdictionStageIds,
  US_FED_MAPPING,
  EU_MAPPING,
  UK_MAPPING,
  type StageId,
} from './lifecycle.js';

// ─── Lifecycle Model ───────────────────────────────────────────

describe('LIFECYCLE_STAGES', () => {
  it('contains exactly 26 stages', () => {
    expect(LIFECYCLE_STAGES).toHaveLength(26);
  });

  it('has unique stage IDs', () => {
    const ids = LIFECYCLE_STAGES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every stage has a valid phase', () => {
    const phases = new Set<string>(PHASES);
    for (const stage of LIFECYCLE_STAGES) {
      expect(phases.has(stage.phase)).toBe(true);
    }
  });

  it('progress values are in 0-100 range', () => {
    for (const stage of LIFECYCLE_STAGES) {
      expect(stage.progress).toBeGreaterThanOrEqual(0);
      expect(stage.progress).toBeLessThanOrEqual(100);
    }
  });
});

// ─── getStage ──────────────────────────────────────────────────

describe('getStage', () => {
  it('returns the correct stage for a known ID', () => {
    const stage = getStage('introduced');
    expect(stage).toBeDefined();
    expect(stage!.id).toBe('introduced');
    expect(stage!.label).toBe('Introduced / Filed');
    expect(stage!.progress).toBe(20);
    expect(stage!.phase).toBe('drafting');
  });

  it('returns undefined for an unknown ID', () => {
    expect(getStage('nonexistent')).toBeUndefined();
  });

  it('returns correct data for every stage', () => {
    for (const expected of LIFECYCLE_STAGES) {
      const actual = getStage(expected.id);
      expect(actual).toEqual(expected);
    }
  });
});

// ─── getProgress ───────────────────────────────────────────────

describe('getProgress', () => {
  it('returns correct progress for known stages', () => {
    expect(getProgress('rumor')).toBe(5);
    expect(getProgress('signed')).toBe(95);
    expect(getProgress('in_force')).toBe(100);
  });

  it('returns 0 for terminal stages', () => {
    expect(getProgress('died')).toBe(0);
    expect(getProgress('stalled')).toBe(0);
    expect(getProgress('repealed')).toBe(0);
  });

  it('returns 0 for unknown stage IDs', () => {
    expect(getProgress('unknown_stage')).toBe(0);
  });
});

// ─── isTerminal ────────────────────────────────────────────────

describe('isTerminal', () => {
  it('returns true for terminal stages', () => {
    expect(isTerminal('died')).toBe(true);
    expect(isTerminal('stalled')).toBe(true);
    expect(isTerminal('repealed')).toBe(true);
  });

  it('returns false for non-terminal stages', () => {
    expect(isTerminal('introduced')).toBe(false);
    expect(isTerminal('signed')).toBe(false);
    expect(isTerminal('in_force')).toBe(false);
    expect(isTerminal('rumor')).toBe(false);
  });

  it('returns false for unknown stage IDs', () => {
    expect(isTerminal('unknown')).toBe(false);
  });
});

// ─── isValidStageId ────────────────────────────────────────────

describe('isValidStageId', () => {
  it('returns true for all defined stage IDs', () => {
    for (const stage of LIFECYCLE_STAGES) {
      expect(isValidStageId(stage.id)).toBe(true);
    }
  });

  it('returns false for invalid strings', () => {
    expect(isValidStageId('')).toBe(false);
    expect(isValidStageId('fake')).toBe(false);
    expect(isValidStageId('INTRODUCED')).toBe(false); // case-sensitive
  });
});

// ─── getStagesByPhase ──────────────────────────────────────────

describe('getStagesByPhase', () => {
  it('returns 2 stages for pre_legislative', () => {
    const stages = getStagesByPhase('pre_legislative');
    expect(stages).toHaveLength(2);
    expect(stages.map((s) => s.id)).toEqual(['rumor', 'executive_order']);
  });

  it('returns 3 terminal stages', () => {
    const stages = getStagesByPhase('terminal');
    expect(stages).toHaveLength(3);
    const ids = stages.map((s) => s.id);
    expect(ids).toContain('died');
    expect(ids).toContain('stalled');
    expect(ids).toContain('repealed');
  });

  it('all phases have at least one stage', () => {
    for (const phase of PHASES) {
      expect(getStagesByPhase(phase).length).toBeGreaterThan(0);
    }
  });
});

// ─── Jurisdiction Mappings ─────────────────────────────────────

describe('US-FED mapping', () => {
  it('uses all 26 stages', () => {
    expect(US_FED_MAPPING.stages).toHaveLength(26);
  });

  it('every mapped stage ID is valid', () => {
    for (const [, stageId] of US_FED_MAPPING.stages) {
      expect(isValidStageId(stageId)).toBe(true);
    }
  });

  it('jurisdiction code is US-FED', () => {
    expect(US_FED_MAPPING.jurisdiction).toBe('US-FED');
  });
});

describe('EU mapping', () => {
  it('has correct number of stages', () => {
    expect(EU_MAPPING.stages.length).toBeGreaterThanOrEqual(10);
  });

  it('every mapped stage ID is valid', () => {
    for (const [, stageId] of EU_MAPPING.stages) {
      expect(isValidStageId(stageId)).toBe(true);
    }
  });

  it('includes key EU stages', () => {
    const labels = EU_MAPPING.stages.map(([label]) => label);
    expect(labels).toContain('Commission Proposal');
    expect(labels).toContain('EP First Reading');
    expect(labels).toContain('Conciliation Committee');
    expect(labels).toContain('Council Adoption');
    expect(labels).toContain('In Force');
  });

  it('jurisdiction code is EU', () => {
    expect(EU_MAPPING.jurisdiction).toBe('EU');
  });
});

describe('UK mapping', () => {
  it('has correct number of stages', () => {
    expect(UK_MAPPING.stages.length).toBeGreaterThanOrEqual(10);
  });

  it('every mapped stage ID is valid', () => {
    for (const [, stageId] of UK_MAPPING.stages) {
      expect(isValidStageId(stageId)).toBe(true);
    }
  });

  it('includes key UK stages', () => {
    const labels = UK_MAPPING.stages.map(([label]) => label);
    expect(labels).toContain('First Reading');
    expect(labels).toContain('Royal Assent');
    expect(labels).toContain('Committee Stage');
  });

  it('jurisdiction code is UK', () => {
    expect(UK_MAPPING.jurisdiction).toBe('UK');
  });
});

describe('getJurisdictionMapping', () => {
  it('returns mapping for known jurisdictions', () => {
    expect(getJurisdictionMapping('US-FED')).toBe(US_FED_MAPPING);
    expect(getJurisdictionMapping('EU')).toBe(EU_MAPPING);
    expect(getJurisdictionMapping('UK')).toBe(UK_MAPPING);
  });

  it('returns undefined for unknown jurisdictions', () => {
    expect(getJurisdictionMapping('JP')).toBeUndefined();
  });
});

describe('getJurisdictionStageIds', () => {
  it('returns stage IDs for US-FED', () => {
    const ids = getJurisdictionStageIds('US-FED');
    expect(ids.size).toBeGreaterThan(0);
    expect(ids.has('introduced' as StageId)).toBe(true);
    expect(ids.has('signed' as StageId)).toBe(true);
  });

  it('returns empty set for unknown jurisdictions', () => {
    const ids = getJurisdictionStageIds('MARS');
    expect(ids.size).toBe(0);
  });
});
