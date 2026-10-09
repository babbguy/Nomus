#!/usr/bin/env node
// Nomus release gate.
//
// Runs the real, built product the way users do: the production engine on a
// fresh SQLite database (with a deterministic fake LLM and a fake GitHub
// API), the production dashboard build behind a same-origin proxy, and the
// built scanner CLI, GitHub Action bundle, MCP server and VS Code extension
// API calls against it. Every assertion becomes a row of a PASS/FAIL table;
// the process exits 1 if any row fails.
//
//   node e2e/run-gate.mjs            build if needed, then run the gate
//   node e2e/run-gate.mjs --build    rebuild everything first (npm run build:all)
//   node e2e/run-gate.mjs --no-build use the existing build as is
//   node e2e/run-gate.mjs --only=scanner,action   run only some areas (debugging; bring-up always runs)
//   node e2e/run-gate.mjs --target=../other-checkout   test another checkout's build with this gate
//
// Output (screenshots, logs, results.json, summary.md) goes to e2e/out/
// (override with NOMUS_GATE_OUT).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Gate, errText } from './lib/gate.mjs';
import { Client, sleep } from './lib/http.mjs';
import { freePort, startEngine, run, killAll } from './lib/procs.mjs';
import { startFakeLlm } from './lib/fake-llm.mjs';
import { startWebServer } from './lib/web-server.mjs';
import { startSink } from './lib/fake-sink.mjs';
import { startFakeJira } from './lib/fake-jira.mjs';

import { bringUp } from './checks/bring-up.mjs';
import { scannerChecks } from './checks/scanner.mjs';
import { actionChecks } from './checks/action.mjs';
import { mcpChecks } from './checks/mcp.mjs';
import { vscodeChecks } from './checks/vscode.mjs';
import { attestationChecks } from './checks/attestations.mjs';
import { rulesSseChecks } from './checks/rules-sse.mjs';
import { pipelineChecks } from './checks/pipeline.mjs';
import { browserChecks } from './checks/browser.mjs';
import { logChecks } from './checks/server-logs.mjs';
import { resourceChecks, readProbe } from './checks/resources.mjs';
import { cpgSetup } from './checks/cpg-setup.mjs';
import { cpgRbacChecks } from './checks/cpg-rbac.mjs';
import { cpgPolicyChecks } from './checks/cpg-policy.mjs';
import { cpgScannerChecks } from './checks/cpg-scanner.mjs';
import { cpgVscodeChecks } from './checks/cpg-vscode.mjs';
import { cpgCasesChecks } from './checks/cpg-cases.mjs';
import { cpgBrowserChecks } from './checks/cpg-browser.mjs';
import { cpgApprovalsChecks } from './checks/cpg-approvals.mjs';
import { cpgActionChecks } from './checks/cpg-action.mjs';
import { cpgIntegrationsChecks } from './checks/cpg-integrations.mjs';
import { cpgAttestationsChecks } from './checks/cpg-attestations.mjs';

const gateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
// The product under test: this checkout, or --target=<dir> (e.g. an older release).
const repoRoot = path.resolve((args.find((a) => a.startsWith('--target=')) ?? '').slice('--target='.length) || gateRoot);
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length).split(',').filter(Boolean);
const wants = (area) => only.length === 0 || only.includes(area);

const outDir = path.resolve(process.env.NOMUS_GATE_OUT ?? path.join(gateRoot, 'e2e', 'out'));
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'work', 'data'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'screenshots'), { recursive: true });

const gate = new Gate(outDir);
const t0 = Date.now();
let engine = null;
let llm = null;
let web = null;
let slack = null;
let notifySink = null;
let jira = null;

async function main() {
  // ── Build ────────────────────────────────────────────────────────────
  const required = [
    'engine/dist/index.js', 'dashboard/dist/index.html', 'packages/scanner/dist/index.js',
    'packages/mcp-server/dist/index.js', 'packages/github-action/dist/index.js', 'packages/vscode-extension/dist/extension.js',
  ];
  const missing = required.filter((f) => !fs.existsSync(path.join(repoRoot, f)));
  if (args.includes('--build') || (missing.length && !args.includes('--no-build'))) {
    console.log(`Building (npm run build:all)${missing.length ? `; missing: ${missing.join(', ')}` : ''}...`);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const b = await run(npm, ['run', 'build:all'], { cwd: repoRoot, timeout: 900_000, shell: true });
    fs.writeFileSync(path.join(outDir, 'build.log'), b.stdout + b.stderr);
    if (b.code !== 0) throw new Error(`npm run build:all failed (exit ${b.code}); see ${path.join(outDir, 'build.log')}`);
  }

  // ── Fakes, engine and dashboard ─────────────────────────────────────
  llm = await startFakeLlm({ logFile: path.join(outDir, 'fake-llm.log') });
  slack = await startSink({ logFile: path.join(outDir, 'slack-webhook.log') });
  // CPG integrations: the fake Resend API (under /resend) and the webhook receiver share one sink; Jira has its own fake.
  notifySink = await startSink({
    logFile: path.join(outDir, 'notify-sink.log'),
    respond: (e) => (e.path.startsWith('/resend/') ? { status: 200, json: { id: crypto.randomUUID() } } : null),
  });
  jira = await startFakeJira({ email: 'jira-bot@gate.example.org', token: `jira-${crypto.randomBytes(12).toString('hex')}` });
  const enginePort = await freePort();
  const webPort = await freePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const secrets = {
    adminEmail: 'admin@gate.example.org',
    adminPassword: `Gate-${crypto.randomBytes(12).toString('base64url')}`,
    bootstrapKey: `gate-bootstrap-${crypto.randomBytes(16).toString('hex')}`,
  };
  const engineEnv = {
    // Production mode, as the Docker image runs it: the production startup
    // checks apply and logs are JSON lines.
    NOMUS_ENV: 'production',
    NODE_ENV: 'production',
    NOMUS_PORT: String(enginePort),
    NOMUS_LOG_LEVEL: 'info',
    NOMUS_DB_PATH: path.join(outDir, 'work', 'data', 'nomus.db'),
    NOMUS_SIGNING_KEY_SECRET: crypto.randomBytes(32).toString('hex'),
    NOMUS_ADMIN_BOOTSTRAP_KEY: secrets.bootstrapKey,
    NOMUS_ADMIN_EMAIL: secrets.adminEmail,
    NOMUS_ADMIN_PASSWORD: secrets.adminPassword,
    NOMUS_CORS_ORIGIN: webOrigin,
    // Every LLM role goes to the deterministic fake (OpenAI-compatible).
    NOMUS_OPENAI_API_KEY: 'sk-gate-fake-llm',
    OPENAI_BASE_URL: `${llm.url}/v1`,
    NOMUS_LLM_CLASSIFIER_PROVIDER: 'openai',
    NOMUS_LLM_CLASSIFIER_MODEL: 'gpt-4o-mini',
    NOMUS_LLM_TRANSLATOR_PROVIDER: 'openai',
    NOMUS_LLM_TRANSLATOR_MODEL: 'gpt-4o-mini',
    NOMUS_LLM_FALLBACK_PROVIDER: 'none',
    // No scheduled scraping or Scout news cycle during the run: both fetch
    // the live internet. (Feb 30 never comes.) The gate drives the pipeline
    // itself through the manual-upload path.
    NOMUS_SCRAPE_CRON: '0 0 30 2 *',
    NOMUS_SCOUT_ENABLED: 'false',
    // The engine's fixed-time jobs (state hash, source health probes, data
    // audit, ledger, expiry sweep, shadow tests) run at local hours 0-6, 12
    // and 18. Run the engine in a time zone where it is now about 09:00, so
    // none of them can start during the gate. Stored timestamps are UTC.
    TZ: quietTimeZone(),
    // Alerts go to a local Slack incoming-webhook sink (alerting configured,
    // nothing leaves the machine).
    NOMUS_SLACK_WEBHOOK_URL: `${slack.url}/services/gate/alerts`,
    // CPG integrations reach only the local fakes: email through the fake
    // Resend API (no Resend key is set until the cpg-integrations area), and
    // Jira and webhook targets on 127.0.0.1.
    NOMUS_RESEND_API_URL: `${notifySink.url}/resend`,
    NOMUS_CPG_ALLOW_PRIVATE_TARGETS: 'true',
  };
  const probeFile = path.join(outDir, 'engine-probe.jsonl');
  engine = startEngine({ repoRoot, workDir: path.join(outDir, 'work'), env: engineEnv, logFile: path.join(outDir, 'engine.log'), probeFile });
  web = await startWebServer({ port: webPort, distDir: path.join(repoRoot, 'dashboard', 'dist'), engineUrl: `http://127.0.0.1:${enginePort}` });

  const ctx = {
    gate, repoRoot, gateRoot, outDir, secrets, engine, llm, slack, notifySink, jira, probeFile,
    engineUrl: `http://127.0.0.1:${enginePort}`,
    webUrl: webOrigin,
    shotsDir: path.join(outDir, 'screenshots'),
    expected: JSON.parse(fs.readFileSync(path.join(gateRoot, 'e2e', 'expectations.json'), 'utf8')),
    data: {}, // facts recorded by earlier checks for later cross-checks
  };

  const ok = await bringUp(ctx);
  if (!ok) {
    gate.note('Bring-up failed; the remaining areas need a running, seeded engine and were not run.');
  } else {
    const areas = [
      ['scanner', scannerChecks], ['action', actionChecks], ['mcp', mcpChecks], ['vscode', vscodeChecks],
      ['attestations', attestationChecks], ['rules-sse', rulesSseChecks], ['pipeline', pipelineChecks], ['browser', browserChecks],
      // Corporate Policy Governance (v1.2.0): after every v1.1.0 area, against a
      // second org created by cpg-setup.mjs, so no existing expectation changes.
      ['cpg-rbac', cpgRbacChecks],
      ['cpg-policy', cpgPolicyChecks],
      ['cpg-scanner', cpgScannerChecks],
      ['cpg-vscode', cpgVscodeChecks],
      ['cpg-cases', cpgCasesChecks],
      ['cpg-browser', cpgBrowserChecks],
      // Last: decisions bind (repo, fingerprint), so they would change what later areas see.
      ['cpg-approvals', cpgApprovalsChecks],
      // The Action as the enforcement gate, against the decisions cpg-approvals made.
      ['cpg-action', cpgActionChecks],
      // Corporate policy records in attestations, from the case cpg-approvals closed (before integrations, so no delivery is queued).
      ['cpg-attestations', cpgAttestationsChecks],
      // Email, Jira and webhook deliveries to local fakes; sets the Resend key, so it runs last.
      ['cpg-integrations', cpgIntegrationsChecks],
    ];
    for (const [area, fn] of areas) {
      if (!wants(area)) continue;
      // The shared CPG setup runs once, before the first selected cpg-* area.
      if (area.startsWith('cpg-')) {
        let ready = false;
        try {
          ready = await cpgSetup(ctx);
        } catch (err) {
          gate.check('cpg-setup completed', false, 'no exception', errText(err));
          console.error(err);
        }
        if (!ready) {
          gate.blocked(`${area} checks`, 'the shared CPG setup (cpg-setup.mjs) failed');
          continue;
        }
      }
      gate.section(area);
      try {
        await fn(ctx);
      } catch (err) {
        gate.check(`${area} checks completed`, false, 'no exception', errText(err));
        console.error(err);
      }
      if (engine.exited) {
        gate.check('engine still running', false, 'running', `exited ${JSON.stringify(engine.exited)}`);
        break;
      }
    }
  }

  // ── Resources (idle CPU needs a quiet engine) and logs ──────────────
  gate.section('resources');
  await resourceChecks(ctx);
  await engine.stop();
  gate.section('server-logs');
  await logChecks(ctx);
  return ctx;
}

/** An Etc/GMT zone in which the local time is now between 09:00 and 10:00. */
function quietTimeZone() {
  let offset = 9 - new Date().getUTCHours(); // hours ahead of UTC
  if (offset > 12) offset -= 24;
  if (offset < -12) offset += 24;
  // POSIX-style names: Etc/GMT-3 is three hours AHEAD of UTC.
  return offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

let ctx = null;
try {
  ctx = await main();
} catch (err) {
  gate.check('gate ran to completion', false, 'no exception', errText(err));
  console.error(err);
} finally {
  if (engine && !engine.exited) await engine.stop().catch(() => {});
  if (web) await web.close().catch(() => {});
  if (llm) await llm.close().catch(() => {});
  if (slack) await slack.close().catch(() => {});
  if (notifySink) await notifySink.close().catch(() => {});
  if (jira) await jira.close().catch(() => {});
  if (ctx?.closers) for (const c of ctx.closers) await c().catch(() => {});
  killAll();
}

// ── Report ─────────────────────────────────────────────────────────────
const res = ctx?.resources ?? (ctx ? readProbe(ctx.probeFile, ctx.idleWindow) : null);
const seconds = Math.round((Date.now() - t0) / 1000);
const extra = [
  `- duration: ${seconds} s`,
  res ? `- engine peak RSS: ${(res.peakRss / 1048576).toFixed(1)} MiB (limit 512 MiB)` : '- engine peak RSS: not measured',
  res?.idleCpuPct !== undefined ? `- engine idle CPU: ${res.idleCpuPct.toFixed(2)} % of one core over ${res.idleWindowS} s` : '- engine idle CPU: not measured',
  ...gate.notes.map((n) => `- note: ${n}`),
];
const table = gate.table();
console.log(`\n${'='.repeat(100)}\nRELEASE GATE RESULTS\n${'='.repeat(100)}\n${table}\n`);
for (const l of extra) console.log(l);
const failed = gate.failed.length;
console.log(`\nRELEASE GATE: ${failed === 0 ? 'PASS' : `FAIL (${failed} of ${gate.rows.length} checks failed)`}`);
const summary = gate.markdown(extra);
fs.writeFileSync(path.join(outDir, 'summary.md'), summary);
fs.writeFileSync(path.join(outDir, 'results.txt'), `${table}\n\n${extra.join('\n')}\n`);
gate.write({ seconds, resources: res });
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
await sleep(50);
process.exit(failed === 0 && gate.rows.length > 0 ? 0 : 1);
