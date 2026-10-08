import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import {
  startStubEngine,
  deadEngineUrl,
  makeRuleRow,
  STUB_API_KEY,
  STUB_STATE_HASH,
  type StubEngine,
} from './stub-engine.js';
import { connectHarness, payloadOf, textOf, type Harness } from './harness.js';

/** Golden fixture: real Anthropic SDK import the ImportDetector recognizes. */
const ANTHROPIC_FIXTURE = [
  "import Anthropic from '@anthropic-ai/sdk';",
  '',
  'const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });',
  'export async function complete(prompt: string) {',
  "  return client.messages.create({ model: 'claude-opus-4-8', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] });",
  '}',
  '',
].join('\n');

describe('nomus MCP tools (stubbed engine)', () => {
  let stub: StubEngine;
  let harness: Harness;

  beforeAll(async () => {
    stub = await startStubEngine({
      policies: [
        makeRuleRow(),
        makeRuleRow({
          id: 'a1b2c3d4-0000-4000-8000-000000000002',
          ruleKey: 'us_ca.sb1001.bot_disclosure',
          jurisdiction: 'US-CA',
          severity: 'medium',
          legalReference: 'Cal. Bus. & Prof. Code § 17941',
          createdAt: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:00:00.000Z',
        }),
      ],
    });
    harness = await connectHarness({ apiUrl: stub.url, apiKey: STUB_API_KEY });
  });

  afterAll(async () => {
    await harness.close();
    await stub.close();
  });

  const requestsFor = (path: string) => stub.requests.filter((r) => r.path === path);

  // ── tool listing ────────────────────────────────────────────────

  it('exposes all seven tools', async () => {
    const { tools } = await harness.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'bill_radar',
      'check_applicability',
      'get_rule',
      'list_frameworks',
      'list_jurisdictions',
      'regulatory_changes',
      'scan_code',
    ]);
  });

  // ── check_applicability ─────────────────────────────────────────

  describe('check_applicability', () => {
    it('happy path with explicit capabilities: returns matched rules, provenance, disclaimer', async () => {
      const before = requestsFor('/api/v1/simulate').length;
      const result = await harness.callTool('check_applicability', {
        capabilities: ['text_generation'],
        jurisdictions: ['EU'],
        dataTypes: ['pii'],
      });
      const payload = payloadOf(result);

      const markets = payload.markets as Record<string, { rules: Array<Record<string, unknown>> }>;
      expect(markets.EU.rules[0]).toMatchObject({
        ruleKey: 'eu_ai_act.art52.transparency',
        effect: 'require_disclosure',
        severity: 'high',
        legalReference: 'EU AI Act, Article 52(1)',
      });
      expect(payload.overallRisk).toBe('high');
      expect((payload.provenance as { corpus: { stateHash: string } }).corpus.stateHash).toBe(STUB_STATE_HASH);
      expect(payload.disclaimer).toBe(LEGAL_DISCLAIMER);

      // Verify the engine received the simulate call with our inputs.
      const simulateCalls = requestsFor('/api/v1/simulate');
      expect(simulateCalls.length).toBe(before + 1);
      expect(simulateCalls.at(-1)!.body).toMatchObject({
        capabilities: ['text_generation'],
        targetMarkets: ['EU'],
        dataTypes: ['pii'],
      });
      expect(simulateCalls.at(-1)!.authorization).toBe(`Bearer ${STUB_API_KEY}`);
    });

    it('rejects a call with neither capabilities nor code', async () => {
      const result = await harness.callTool('check_applicability', { jurisdictions: ['EU'] });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/at least one of `capabilities` or `code`/);
    });

    it('rejects empty jurisdictions via input validation', async () => {
      const result = await harness.callTool('check_applicability', {
        capabilities: ['text_generation'],
        jurisdictions: [],
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Input validation error/i);
      expect(textOf(result)).toMatch(/jurisdictions/);
    });

    it('returns an explicit non-clearance answer when nothing AI-related is detected', async () => {
      const before = requestsFor('/api/v1/simulate').length;
      const result = await harness.callTool('check_applicability', {
        code: 'export const add = (a: number, b: number) => a + b;\n',
        jurisdictions: ['EU'],
      });
      const payload = payloadOf(result);
      expect(payload.result).toBe('no_capabilities_detected');
      expect(String(payload.summary)).toMatch(/NOT a compliance clearance/);
      expect(payload.disclaimer).toBe(LEGAL_DISCLAIMER);
      // No simulate round trip for the zero-signal early exit.
      expect(requestsFor('/api/v1/simulate').length).toBe(before);
    });
  });

  // ── golden test: code fixture → full applicability answer ───────

  describe('golden: @anthropic-ai/sdk fixture through in-process detection', () => {
    it('derives capabilities in-process, calls /simulate, and returns the full cited answer', async () => {
      const result = await harness.callTool('check_applicability', {
        code: ANTHROPIC_FIXTURE,
        language: 'typescript',
        jurisdictions: ['EU'],
      });
      const payload = payloadOf(result);

      // In-process detection found the Anthropic SDK and its capabilities.
      const detection = payload.detection as {
        capabilities: string[];
        signals: Array<{ detector: string; target: string; evidence: string; line: number }>;
      };
      expect(detection.capabilities).toEqual(
        expect.arrayContaining(['text_generation', 'tool_use', 'content_analysis']),
      );
      const importSignal = detection.signals.find((s) => s.detector === 'import-detector');
      expect(importSignal).toBeDefined();
      expect(importSignal!.target).toBe('@anthropic-ai/sdk');
      expect(importSignal!.evidence).toContain('@anthropic-ai/sdk');

      // The derived capabilities were what the engine was asked about.
      const simulateCall = requestsFor('/api/v1/simulate').at(-1)!;
      expect((simulateCall.body as { capabilities: string[] }).capabilities).toEqual(
        expect.arrayContaining(['text_generation']),
      );
      expect((simulateCall.body as { targetMarkets: string[] }).targetMarkets).toEqual(['EU']);

      // Full result shape: matched rule with citation, provenance, disclaimer.
      const markets = payload.markets as Record<string, { rules: Array<Record<string, unknown>> }>;
      expect(markets.EU.rules).toHaveLength(1);
      expect(markets.EU.rules[0]).toMatchObject({
        ruleKey: 'eu_ai_act.art52.transparency',
        severity: 'high',
        effect: 'require_disclosure',
        legalReference: 'EU AI Act, Article 52(1)',
        matchedOn: ['capability: text_generation'],
      });
      expect(payload.capabilitiesEvaluated).toEqual(expect.arrayContaining(['text_generation']));
      const provenance = payload.provenance as {
        corpus: { stateHash: string; ruleCount: number; computedAt: string };
        nomusApiUrl: string;
        retrievedAt: string;
        notes: string[];
      };
      expect(provenance.corpus.stateHash).toBe(STUB_STATE_HASH);
      expect(provenance.nomusApiUrl).toBe(stub.url);
      expect(provenance.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(provenance.notes.join(' ')).toMatch(/SHA-256/);
      expect(payload.disclaimer).toBe(LEGAL_DISCLAIMER);
    });
  });

  // ── get_rule ────────────────────────────────────────────────────

  describe('get_rule', () => {
    it('resolves a rule key via the list fallback and returns per-rule provenance', async () => {
      const result = await harness.callTool('get_rule', { ruleKey: 'eu_ai_act.art52.transparency' });
      const payload = payloadOf(result);
      const rule = payload.rule as Record<string, unknown>;
      expect(rule.ruleKey).toBe('eu_ai_act.art52.transparency');
      expect(rule.legalReference).toBe('EU AI Act, Article 52(1)');
      expect(rule.signature).toBeTruthy();
      expect(rule.updatedAt).toBe('2026-07-10T00:00:00.000Z');
      expect(payload.disclaimer).toBe(LEGAL_DISCLAIMER);
    });

    it('resolves an internal rule id directly', async () => {
      const result = await harness.callTool('get_rule', {
        ruleKey: 'a1b2c3d4-0000-4000-8000-000000000002',
      });
      const payload = payloadOf(result);
      expect((payload.rule as Record<string, unknown>).ruleKey).toBe('us_ca.sb1001.bot_disclosure');
    });

    it('errors clearly when the rule does not exist', async () => {
      const result = await harness.callTool('get_rule', { ruleKey: 'does.not.exist' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/not found/i);
    });
  });

  // ── scan_code ───────────────────────────────────────────────────

  describe('scan_code', () => {
    it('runs the full scanner over provided contents and maps findings to files', async () => {
      const result = await harness.callTool('scan_code', {
        files: [
          { path: 'src/ai.ts', content: ANTHROPIC_FIXTURE },
          { path: 'src/util.ts', content: 'export const id = <T>(x: T) => x;\n' },
        ],
        jurisdictions: ['EU'],
      });
      const payload = payloadOf(result);

      expect(payload.fileCount).toBe(2);
      expect(payload.capabilities).toEqual(expect.arrayContaining(['text_generation']));
      const findings = payload.findings as Array<{
        file: string;
        line: number;
        rule: { ruleKey: string; severity: string; legalReference: string };
      }>;
      expect(findings.length).toBeGreaterThan(0);
      const aiFinding = findings.find((f) => f.file === 'src/ai.ts');
      expect(aiFinding).toBeDefined();
      expect(aiFinding!.rule.ruleKey).toBe('eu_ai_act.art52.transparency');
      expect(aiFinding!.rule.legalReference).toBe('EU AI Act, Article 52(1)');
      expect(payload.status).toBe('pass'); // default failOn=critical; stub rule is high
      expect(payload.disclaimer).toBe(LEGAL_DISCLAIMER);
      expect((payload.provenance as { corpus: { stateHash: string } }).corpus.stateHash).toBe(STUB_STATE_HASH);
    });

    it('rejects duplicate file paths', async () => {
      const result = await harness.callTool('scan_code', {
        files: [
          { path: 'a.ts', content: 'const x = 1;' },
          { path: 'a.ts', content: 'const y = 2;' },
        ],
        jurisdictions: ['EU'],
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Duplicate file path/);
    });

    it('rejects an empty files array via input validation', async () => {
      const result = await harness.callTool('scan_code', { files: [], jurisdictions: ['EU'] });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Input validation error/i);
      expect(textOf(result)).toMatch(/files/);
    });
  });

  // ── list_frameworks / list_jurisdictions ────────────────────────

  describe('discovery tools', () => {
    it('list_frameworks returns templates with live rule counts', async () => {
      const result = await harness.callTool('list_frameworks');
      const payload = payloadOf(result);
      const frameworks = payload.frameworks as Array<Record<string, unknown>>;
      expect(frameworks.map((f) => f.id)).toEqual(['eu-ai-act-full', 'nist-rmf']);
      expect(frameworks[0]).toMatchObject({ name: 'EU AI Act — Full Coverage', ruleCount: 12 });
      expect(payload.disclaimer).toBe(LEGAL_DISCLAIMER);
    });

    it('list_jurisdictions returns codes with display names and severity summary', async () => {
      const result = await harness.callTool('list_jurisdictions');
      const payload = payloadOf(result);
      const jurisdictions = payload.jurisdictions as Array<{ code: string; name: string | null; maxSeverity: string | null }>;
      expect(jurisdictions).toEqual([
        { code: 'EU', name: 'European Union', maxSeverity: 'high' },
        { code: 'US-CA', name: 'California', maxSeverity: 'medium' },
      ]);
      expect(payload.disclaimer).toBe(LEGAL_DISCLAIMER);
    });
  });

  // ── regulatory_changes ──────────────────────────────────────────

  describe('regulatory_changes', () => {
    it('returns created/updated rules since a timestamp, normalized to UTC', async () => {
      const result = await harness.callTool('regulatory_changes', {
        since: '2026-07-01T02:00:00+02:00', // == 2026-07-01T00:00:00Z
      });
      const payload = payloadOf(result);
      expect(payload.since).toBe('2026-07-01T00:00:00.000Z');

      const changes = payload.changes as Array<Record<string, unknown>>;
      expect(payload.changeCount).toBe(2);
      // Sorted newest first.
      expect(changes[0]).toMatchObject({
        ruleKey: 'us_ca.sb1001.bot_disclosure',
        changeType: 'created', // createdAt 2026-07-15 >= since
      });
      expect(changes[1]).toMatchObject({
        ruleKey: 'eu_ai_act.art52.transparency',
        changeType: 'updated', // createdAt 2026-06-01 < since, updatedAt 2026-07-10 >= since
      });

      const listCall = stub.requests.filter((r) => r.path === '/api/v1/policies' && r.query.since).at(-1)!;
      expect(listCall.query.since).toBe('2026-07-01T00:00:00.000Z');
      expect(listCall.query.limit).toBe('1000');
    });

    it('queries per jurisdiction when a filter is given', async () => {
      const before = stub.requests.length;
      const result = await harness.callTool('regulatory_changes', {
        since: '2026-07-01T00:00:00Z',
        jurisdictions: ['EU', 'US-CA'],
      });
      const payload = payloadOf(result);
      const jurisdictionParams = stub.requests
        .slice(before)
        .filter((r) => r.path === '/api/v1/policies' && r.query.since)
        .map((r) => r.query.jurisdiction)
        .sort();
      expect(jurisdictionParams).toEqual(['EU', 'US-CA']);
      expect(payload.changeCount).toBe(2);
    });

    it('rejects a non-ISO since via input validation', async () => {
      const result = await harness.callTool('regulatory_changes', { since: 'yesterday' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Input validation error/i);
      expect(textOf(result)).toMatch(/since/);
    });
  });

  // ── bill_radar ──────────────────────────────────────────────────

  describe('bill_radar', () => {
    it('returns Scout signals sorted by passage score', async () => {
      const result = await harness.callTool('bill_radar', {});
      const payload = payloadOf(result);
      const bills = payload.bills as Array<Record<string, unknown>>;
      expect(bills.map((b) => b.billNumber)).toEqual(['SB 1047', 'HR 2026']);
      expect(payload.totalTracked).toBe(2);
      expect(payload.disclaimer).toBe(LEGAL_DISCLAIMER);
    });

    it('applies minScore and jurisdiction filters via the engine query', async () => {
      const result = await harness.callTool('bill_radar', {
        jurisdictions: ['US-CA'],
        minScore: 50,
      });
      const payload = payloadOf(result);
      const bills = payload.bills as Array<Record<string, unknown>>;
      expect(bills).toHaveLength(1);
      expect(bills[0].billNumber).toBe('SB 1047');
      const call = stub.requests.filter((r) => r.path === '/api/v1/radar/v2/bills').at(-1)!;
      expect(call.query).toMatchObject({ jurisdiction: 'US-CA', minScore: '50' });
    });
  });
});
