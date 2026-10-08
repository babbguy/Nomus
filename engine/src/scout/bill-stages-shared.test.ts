// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * The dashboard's Bill Tracker uses @nomus/shared BILL_STAGES; the engine
 * stores lifecycle ids from scout/lifecycle.ts. They must be the same set
 * (the dashboard used its own names, so stage filters matched nothing).
 */
import { describe, it, expect } from 'vitest';
import { BILL_STAGES, ENACTED_BILL_STAGES, ENDED_BILL_STAGES } from '@nomus/shared';
import { LIFECYCLE_STAGES } from './lifecycle.js';
import { mapStageToOutcome } from './outcome-recorder.js';

describe('bill stage vocabulary', () => {
  it('shared stages are the engine lifecycle stages, in order', () => {
    expect(BILL_STAGES.map((s) => s.id)).toEqual(LIFECYCLE_STAGES.map((s) => s.id));
    expect(BILL_STAGES.map((s) => s.phase)).toEqual(LIFECYCLE_STAGES.map((s) => s.phase));
  });

  it('enacted stages match the outcome recorder', () => {
    for (const s of LIFECYCLE_STAGES) {
      expect(ENACTED_BILL_STAGES.includes(s.id), s.id).toBe(mapStageToOutcome(s.id) === 'enacted');
    }
    expect(mapStageToOutcome(ENDED_BILL_STAGES[0])).toBe('failed');
  });
});
