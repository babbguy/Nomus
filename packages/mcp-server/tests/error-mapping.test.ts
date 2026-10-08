import { describe, it, expect, afterEach } from 'vitest';
import {
  startStubEngine,
  deadEngineUrl,
  STUB_API_KEY,
  type StubEngine,
} from './stub-engine.js';
import { connectHarness, payloadOf, textOf, type Harness } from './harness.js';

const FIXTURE = "import Anthropic from '@anthropic-ai/sdk';\n";

describe('error mapping and fail-closed behavior', () => {
  let stub: StubEngine | undefined;
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    await stub?.close();
    stub = undefined;
  });

  it('401: invalid API key produces an explicit invalid-key error, not an empty success', async () => {
    stub = await startStubEngine();
    harness = await connectHarness({ apiUrl: stub.url, apiKey: 'nk_test_wrong_key' });

    const result = await harness.callTool('check_applicability', {
      capabilities: ['text_generation'],
      jurisdictions: ['EU'],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/401/);
    expect(textOf(result)).toMatch(/invalid or expired API key/i);
    expect(textOf(result)).toMatch(/NOMUS_API_KEY/);
  });

  it('403: maps to a key-permissions message', async () => {
    stub = await startStubEngine();
    stub.override('GET /api/v1/templates', {
      status: 403,
      body: { message: "Insufficient permissions. Required: read:policies" },
    });
    harness = await connectHarness({ apiUrl: stub.url, apiKey: STUB_API_KEY });

    const result = await harness.callTool('list_frameworks');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/lacks the required permissions/i);
    expect(textOf(result)).toMatch(/read:policies/);
  });

  it('network failure: check_applicability fails closed with an unknown-status error', async () => {
    const url = await deadEngineUrl();
    harness = await connectHarness({ apiUrl: url, apiKey: STUB_API_KEY });

    const result = await harness.callTool('check_applicability', {
      capabilities: ['text_generation'],
      jurisdictions: ['EU'],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/unreachable/i);
    expect(textOf(result)).toMatch(/UNKNOWN/);
    expect(textOf(result)).toMatch(/do NOT treat this as "no obligations apply"/i);
  });

  it('network failure: scan_code (scanner NomusApiError path) fails closed too', async () => {
    const url = await deadEngineUrl();
    harness = await connectHarness({ apiUrl: url, apiKey: STUB_API_KEY });

    const result = await harness.callTool('scan_code', {
      files: [{ path: 'src/ai.ts', content: FIXTURE }],
      jurisdictions: ['EU'],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Nomus API request failed/i);
    expect(textOf(result)).toMatch(/UNKNOWN/);
  });

  it('network failure: get_rule fails closed (no silent "not found")', async () => {
    const url = await deadEngineUrl();
    harness = await connectHarness({ apiUrl: url, apiKey: STUB_API_KEY });

    const result = await harness.callTool('get_rule', { ruleKey: 'eu_ai_act.art52.transparency' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/unreachable/i);
    expect(textOf(result)).not.toMatch(/not found/i);
  });

  it('429: retries with backoff and succeeds when the rate limit clears', async () => {
    stub = await startStubEngine();
    stub.override('GET /api/v1/templates', {
      status: 429,
      body: { error: 'Rate limit exceeded' },
      headers: { 'retry-after': '1' },
      times: 1,
    });
    harness = await connectHarness({ apiUrl: stub.url, apiKey: STUB_API_KEY });

    const result = await harness.callTool('list_frameworks');
    const payload = payloadOf(result);
    expect((payload.frameworks as unknown[]).length).toBe(2);

    const calls = stub.requests.filter((r) => r.path === '/api/v1/templates');
    expect(calls.length).toBe(2); // 429 then success
  }, 15_000);

  it('429: persistent rate limiting surfaces an explicit rate-limit error after retries', async () => {
    stub = await startStubEngine();
    stub.override('GET /api/v1/templates', {
      status: 429,
      body: { error: 'Rate limit exceeded' },
      headers: { 'retry-after': '1' },
    });
    harness = await connectHarness({ apiUrl: stub.url, apiKey: STUB_API_KEY });

    const result = await harness.callTool('list_frameworks');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/rate limit/i);
    expect(textOf(result)).toMatch(/429/);

    const calls = stub.requests.filter((r) => r.path === '/api/v1/templates');
    expect(calls.length).toBe(3); // first attempt + 2 retries
  }, 15_000);

  it('5xx: server errors fail closed with unknown compliance status', async () => {
    stub = await startStubEngine();
    stub.override('POST /api/v1/simulate', { status: 500, body: { error: 'boom' } });
    harness = await connectHarness({ apiUrl: stub.url, apiKey: STUB_API_KEY });

    const result = await harness.callTool('check_applicability', {
      capabilities: ['text_generation'],
      jurisdictions: ['EU'],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/HTTP 500/);
    expect(textOf(result)).toMatch(/UNKNOWN/);
  });

  it('degrades provenance explicitly (never silently) when only the hash endpoint fails', async () => {
    stub = await startStubEngine();
    stub.override('GET /api/v1/policies/hash', { status: 500, body: { error: 'hash oops' } });
    harness = await connectHarness({ apiUrl: stub.url, apiKey: STUB_API_KEY });

    const result = await harness.callTool('check_applicability', {
      capabilities: ['text_generation'],
      jurisdictions: ['EU'],
    });
    const payload = payloadOf(result);
    const provenance = payload.provenance as { corpus: unknown; notes: string[] };
    expect(provenance.corpus).toBeNull();
    expect(provenance.notes.join(' ')).toMatch(/Corpus state hash unavailable/);
  });
});
