/**
 * PhiPatternDetector.
 */
import { describe, it, expect } from 'vitest';
import { PhiPatternDetector, __test__ } from './phi-pattern-detector.js';
import type { DetectorContext } from './detector.js';

const { passesLuhn } = __test__;

function makeCtx(files: Map<string, string>): DetectorContext {
  return {
    rootDir: '/tmp',
    files: Array.from(files.keys()),
    fileContents: files,
    config: { jurisdictions: ['EU', 'US-FED'] },
  };
}

describe('PhiPatternDetector', () => {
  const detector = new PhiPatternDetector();

  it('P1: implements DetectorPlugin shape', () => {
    expect(detector.name).toBe('phi-pattern-detector');
    expect(typeof detector.detect).toBe('function');
  });

  it('P3: detects SSN format', async () => {
    const files = new Map([['/tmp/a.ts', 'const x = "123-67-8901";']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.target === 'ssn')).toBe(true);
  });

  it('P3: detects Luhn-valid credit card', async () => {
    // 4111-1111-1111-1111 is the standard test Visa number (Luhn-valid)
    const files = new Map([['/tmp/a.ts', 'const card = "4111-1111-1111-1111";']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.target === 'credit_card')).toBe(true);
  });

  it('P3: rejects Luhn-invalid digit string', () => {
    expect(passesLuhn('1234-5678-9012-3456')).toBe(false);
    expect(passesLuhn('4111-1111-1111-1111')).toBe(true);
  });

  it('P3: detects email when labeled (e.g. const userEmail = ...)', async () => {
    const files = new Map([['/tmp/a.ts', 'const userEmail = "alice@example.com";']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.target === 'email')).toBe(true);
  });

  it('P3 (FP): does NOT fire on email-shaped strings without an email label', async () => {
    // Reduces noise from JSDoc, README snippets, fixture data
    const files = new Map([['/tmp/a.ts', 'const supportContact = "alice@example.com";']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.target === 'email')).toBe(false);
  });

  it('P3: detects DOB when labeled (e.g. dob: "1985-06-15")', async () => {
    const files = new Map([['/tmp/a.ts', 'const dob = "1985-06-15";']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.target === 'dob')).toBe(true);
  });

  it('P3 (FP): does NOT fire DOB on a release date or createdAt timestamp', async () => {
    const files = new Map([
      ['/tmp/a.ts', 'const RELEASE_DATE = "2024-01-15";\nconst createdAt = "2024-03-15";'],
    ]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.target === 'dob')).toBe(false);
  });

  it('P4: detects PHI variable name pattern', async () => {
    const files = new Map([['/tmp/a.ts', 'const patientId = getId();']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.metadata?.category === 'phi')).toBe(true);
  });

  it('P4: detects PII variable name pattern', async () => {
    const files = new Map([['/tmp/a.ts', 'const ssn = req.body.ssn;']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.metadata?.category === 'pii')).toBe(true);
  });

  it('P5: emits phi_in_ai_call when PHI + AI call coexist', async () => {
    const code = `
      const patientName = "Jane";
      const r = await openai.chat.completions.create({ messages: [{ role: 'user', content: patientName }] });
    `;
    const files = new Map([['/tmp/a.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    const caps = signals.flatMap((s) => s.capabilities);
    expect(caps).toContain('phi_in_ai_call');
  });

  it('P5: emits pii_in_ai_call when PII + AI call coexist', async () => {
    const code = `
      const ssn = "234-56-7890";
      anthropic.messages.create({ messages: [] });
    `;
    const files = new Map([['/tmp/a.py', code]]);
    const signals = await detector.detect(makeCtx(files));
    const caps = signals.flatMap((s) => s.capabilities);
    expect(caps).toContain('pii_in_ai_call');
  });

  it('P6: emits logs_phi when PHI patterns + log call coexist', async () => {
    const code = `
      const patientId = "P123";
      console.log(patientId);
    `;
    const files = new Map([['/tmp/a.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    const caps = signals.flatMap((s) => s.capabilities);
    expect(caps).toContain('logs_phi');
  });

  it('P7: suppresses fake SSN 000-00-0000', async () => {
    const files = new Map([['/tmp/a.ts', 'const placeholder = "000-00-0000";']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.target === 'ssn')).toBe(false);
  });

  it('P7: suppresses patterns inside line comments', async () => {
    const files = new Map([['/tmp/a.ts', '// example: 234-56-7890 not real']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.length).toBe(0);
  });

  it('P7: suppresses patterns inside Python comments', async () => {
    const files = new Map([['/tmp/a.py', '# 234-56-7890 example only']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.length).toBe(0);
  });

  it('P7: suppresses .env.example test files', async () => {
    const files = new Map([['/tmp/.env.example', 'SSN=234-56-7890']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.length).toBe(0);
  });

  it('P8: emits all expected capability strings used by seed-phase3-rules', async () => {
    const code = `
      const ssn = "234-56-7890";
      const card = "4111-1111-1111-1111";
      const patientId = "P123";
      console.log(ssn);
      openai.chat.completions.create({});
    `;
    const files = new Map([['/tmp/a.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    const caps = new Set(signals.flatMap((s) => s.capabilities));
    expect(caps.has('contains_pii')).toBe(true);
    expect(caps.has('contains_phi')).toBe(true);
    expect(caps.has('contains_financial')).toBe(true);
    expect(caps.has('logs_pii')).toBe(true);
    expect(caps.has('pii_in_ai_call')).toBe(true);
  });

  it('P9: import-only files produce no SDK-near findings (no AI call detected)', async () => {
    const files = new Map([['/tmp/a.ts', 'import OpenAI from "openai";\nconst x = "234-56-7890";']]);
    const signals = await detector.detect(makeCtx(files));
    const caps = signals.flatMap((s) => s.capabilities);
    expect(caps).not.toContain('pii_in_ai_call');
    // But still flags contains_pii
    expect(caps).toContain('contains_pii');
  });

  // ── False-positive regression tests (from QA findings 2026-04-07) ──

  it('FP regression: passport.authenticate() does NOT fire pii_var', async () => {
    const code = `
      import passport from 'passport';
      app.use(passport.initialize());
      app.use(passport.session());
      router.post('/login', passport.authenticate('local'), (req, res) => res.json({ ok: true }));
    `;
    const files = new Map([['/tmp/auth.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.target === 'pii_var')).toBe(false);
  });

  it('FP regression: Math.sin in math code does NOT fire pii_var or fin_var', async () => {
    const code = `
      const y = Math.sin(angle);
      function wave(x) { return Math.sin(x) * amplitude; }
    `;
    const files = new Map([['/tmp/math.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.target === 'fin_var' || s.target === 'pii_var')).toBe(false);
  });

  it('FP regression: ISO date in createdAt does NOT fire dob', async () => {
    const code = `
      const RELEASE_DATE = "2024-01-15";
      const createdAt = "2024-03-15";
      const startDate = new Date("2024-06-01");
      schedule("2024-12-31");
    `;
    const files = new Map([['/tmp/dates.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.target === 'dob')).toBe(false);
  });

  it('FP regression: SSN inside string literal IS detected (comment stripper does not corrupt strings)', async () => {
    // The string contains "234-56-7890" — the comment stripper must preserve
    // string literals so the SSN regex still fires.
    const code = 'const sample = "user data: 234-56-7890 // looks like a comment but is not";';
    const files = new Map([['/tmp/preserve.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.target === 'ssn')).toBe(true);
  });

  it('FP regression: "frying pan" / class name Bic does NOT fire fin_var', async () => {
    const code = `
      logger.info("user is using a frying pan today");
      class Bic { constructor() {} }
      const pen = new Bic();
    `;
    const files = new Map([['/tmp/m3.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.target === 'fin_var')).toBe(false);
  });

  it('FP regression: PHI 50 lines from an AI call does NOT get phi_in_ai_call', async () => {
    const filler = Array.from({ length: 50 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const code = `
const patient_name = req.body.name;
${filler}
openai.chat.completions.create({});
`;
    const files = new Map([['/tmp/proximity.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    const phiSig = signals.find((s) => s.target === 'phi_var');
    expect(phiSig).toBeDefined();
    expect(phiSig?.capabilities).not.toContain('phi_in_ai_call');
    expect(phiSig?.capabilities).toContain('contains_phi');
  });

  it('TP control: PHI within proximity DOES get phi_in_ai_call', async () => {
    const code = `
      const patient_name = req.body.name;
      openai.chat.completions.create({ messages: [{ content: patient_name }] });
    `;
    const files = new Map([['/tmp/near.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    const phiSig = signals.find((s) => s.target === 'phi_var');
    expect(phiSig?.capabilities).toContain('phi_in_ai_call');
  });
});
