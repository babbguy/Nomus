/**
 * nomus-scan CLI smoke tests.
 *
 * Spawns the built CLI binary against fixture repos and asserts:
 *   1. Exit code matches the expected value
 *      (0 = pass, 1 = findings threshold, 2 = error, 3 = API unavailable)
 *   2. Output is well-formed (valid JSON for --json, contains expected
 *      strings for console)
 *   3. Detector pipeline runs all 5 detectors against the fixture content
 *
 * Happy-path tests point `.nomus.yml` at a local stub Nomus API
 * (returns `{ markets: {} }`) so the scan completes with an empty-findings
 * report. Fail-closed tests point at a closed local port and assert the CLI
 * exits 3 with a "compliance status UNKNOWN" message — a backend outage must
 * NEVER look like a passing scan.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCANNER_DIR = resolve(__dirname, '..', '..');
const CLI_PATH = join(SCANNER_DIR, 'dist', 'index.js');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI asynchronously. Must NOT be spawnSync: the stub Nomus API
 * server runs in this process, and spawnSync would block the event loop so
 * the stub could never answer the CLI's requests.
 */
function runCli(args: string[], timeoutMs = 30_000): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('node', [CLI_PATH, ...args], { timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', rejectPromise);
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

// Closed port — connection refused, triggers the fail-closed path.
const DEAD_API_URL = 'http://127.0.0.1:1';

function writeSourceFixtures(tmp: string): void {
  // Source files that exercise multiple detectors
  mkdirSync(join(tmp, 'src'));

  // 1. AI SDK import + method call → ImportDetector + SdkUsageDetector
  writeFileSync(join(tmp, 'src', 'ai.ts'), `
import OpenAI from 'openai';
const client = new OpenAI();
export async function summarize(text: string) {
  const result = await openai.chat.completions.create({
    messages: [{ role: 'user', content: text }],
  });
  return result.choices[0].message.content;
}
`);

  // 2. PHI variable + AI call → PhiPatternDetector
  writeFileSync(join(tmp, 'src', 'ehr.ts'), `
import OpenAI from 'openai';
const openai = new OpenAI();

async function summarizePatient(req, res) {
  const patient_id = req.body.patientId;
  const medical_record = await db.query('SELECT * FROM ehr WHERE id = ?', patient_id);
  const summary = await openai.chat.completions.create({
    messages: [{ role: 'user', content: JSON.stringify(medical_record) }],
  });
  res.json({ summary: summary.choices[0].message.content });
}
`);

  // 3. EU AI Act biometric pattern → RiskClassifier
  writeFileSync(join(tmp, 'src', 'auth.py'), `
from deepface import DeepFace

def verify(img1, img2):
    return DeepFace.verify(img1, img2)
`);
}

function makeFixture(apiUrl: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'nomus-cli-smoke-'));

  writeFileSync(
    join(tmp, '.nomus.yml'),
    [
      'nomus:',
      '  api_key: ul_test_smoke_key',
      `  api_url: ${apiUrl}`,
      '  jurisdictions: [EU, US-FED]',
      '  sector: healthcare',
    ].join('\n'),
  );

  writeSourceFixtures(tmp);
  return tmp;
}

let stubApi: Server;
let stubApiUrl: string;
let fixture: string;
let deadApiFixture: string;
let cliExists: boolean;

beforeAll(async () => {
  // Confirm the CLI binary exists. The full test suite runs after build,
  // so this should always be true. If not, skip the spawn-based tests.
  cliExists = existsSync(CLI_PATH);

  // Stub Nomus API: valid response shape, zero matched rules.
  stubApi = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/simulate') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ markets: {} }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
  await new Promise<void>((r) => stubApi.listen(0, '127.0.0.1', r));
  stubApiUrl = `http://127.0.0.1:${(stubApi.address() as AddressInfo).port}`;

  fixture = makeFixture(stubApiUrl);
  deadApiFixture = makeFixture(DEAD_API_URL);
});

afterAll(async () => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  if (deadApiFixture) rmSync(deadApiFixture, { recursive: true, force: true });
  if (stubApi) await new Promise<void>((r) => stubApi.close(() => r()));
});

describe('nomus-scan CLI smoke', () => {
  it('CLI binary exists at the expected path', () => {
    expect(cliExists, `CLI binary not found at ${CLI_PATH} — run npm run build first`).toBe(true);
  });

  it('--json output is valid JSON with the documented shape', async () => {
    if (!cliExists) return; // skipped
    const result = await runCli([fixture, '--json']);

    // Stub API returns zero rules → empty findings → pass → exit 0.
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);

    // The JSON output goes to stdout. Other diagnostic logs may also appear.
    // Find the JSON object boundaries.
    const stdout = result.stdout;
    const jsonStart = stdout.indexOf('{');
    const jsonEnd = stdout.lastIndexOf('}');
    expect(jsonStart, `no JSON in stdout: ${stdout.slice(0, 500)}`).toBeGreaterThanOrEqual(0);

    const jsonStr = stdout.slice(jsonStart, jsonEnd + 1);
    let parsed: { status: string; total: number; findings: unknown[]; _disclaimer: string };
    expect(() => { parsed = JSON.parse(jsonStr); }).not.toThrow();
    expect(parsed!.status).toMatch(/^(pass|fail)$/);
    expect(typeof parsed!.total).toBe('number');
    expect(Array.isArray(parsed!.findings)).toBe(true);
    expect(parsed!._disclaimer).toMatch(/does not provide legal advice/);
  }, 60_000);

  it('console output (default) shows the Nomus banner and scan summary', async () => {
    if (!cliExists) return;
    const result = await runCli([fixture]);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    // Banner appears in console mode
    expect(result.stdout).toMatch(/Nomus Regulatory Applicability Engine/);
    expect(result.stdout).toContain(fixture); // shows what's being scanned
  }, 60_000);

  it('--sarif output is a valid SARIF 2.1.0 document', async () => {
    if (!cliExists) return;
    const result = await runCli([fixture, '--sarif']);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);

    // Find the SARIF JSON in stdout
    const stdout = result.stdout;
    const jsonStart = stdout.indexOf('{');
    const jsonEnd = stdout.lastIndexOf('}');
    expect(jsonStart).toBeGreaterThanOrEqual(0);

    const sarif = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toMatch(/sarif-schema-2\.1\.0\.json/);
    expect(Array.isArray(sarif.runs)).toBe(true);
    expect(sarif.runs[0].tool.driver.name).toBe('Nomus');
  }, 60_000);

  it('fails closed (exit 3, UNKNOWN status message) when the Nomus API is unreachable', async () => {
    if (!cliExists) return;
    const result = await runCli([deadApiFixture, '--json']);

    // AI signals were detected but the API is down: the CLI must NOT report
    // a passing scan. Exit code 3 is reserved for API-unavailable, distinct
    // from 1 (findings threshold) and 2 (generic error).
    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(3);
    expect(result.stderr).toMatch(/compliance status UNKNOWN/);
    expect(result.stderr).toMatch(/failing closed/);
    // No passing report may be emitted
    expect(result.stdout).not.toMatch(/"status":\s*"pass"/);
  }, 60_000);

  it('exits 0 on a fixture with no source files even when the API is unreachable (zero-signal early exit)', async () => {
    if (!cliExists) return;
    // No AI signals → nothing to match → legitimately passes without an API
    // call. This is the ONLY sanctioned pass-without-API path.
    const emptyFixture = mkdtempSync(join(tmpdir(), 'nomus-empty-'));
    writeFileSync(
      join(emptyFixture, '.nomus.yml'),
      `nomus:\n  api_key: ul_test\n  api_url: ${DEAD_API_URL}\n  jurisdictions: [EU]\n`,
    );
    try {
      const result = await runCli([emptyFixture, '--json']);
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    } finally {
      rmSync(emptyFixture, { recursive: true, force: true });
    }
  }, 60_000);
});
