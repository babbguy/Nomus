// 4. MCP server over stdio: initialize, list the tools, and call every tool
// with real arguments. Each must return a valid, non-error result whose
// provenance names the live corpus, and answers must agree with the scanner
// CLI and the engine. With the engine down the tools must fail closed.

import fs from 'node:fs';
import path from 'node:path';
import { startMcp } from '../lib/mcp-client.mjs';
import { freePort } from '../lib/procs.mjs';
import { rulesByFile } from './scanner.mjs';

const TOOLS = ['bill_radar', 'check_applicability', 'get_rule', 'list_frameworks', 'list_jurisdictions', 'regulatory_changes', 'scan_code'];

export async function mcpChecks(ctx) {
  const { gate, repoRoot, webUrl } = ctx;
  const entry = path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'index.js');
  const mcp = await startMcp(entry, { NOMUS_API_URL: webUrl, NOMUS_API_KEY: ctx.data.orgApiKey });
  try {
    const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nomus-release-gate', version: '1' } });
    gate.check('initialize returns server info and a protocol version', !!init.result?.serverInfo?.name && !!init.result?.protocolVersion, 'serverInfo + protocolVersion', JSON.stringify(init.error ?? init.result?.serverInfo));
    mcp.notify('notifications/initialized');
    const list = await mcp.rpc('tools/list', {});
    const names = (list.result?.tools ?? []).map((t) => t.name).sort();
    gate.equal('tools/list offers the documented tools', names, TOOLS);

    const hash = (await ctx.data.orgKey.get('/api/v1/policies/hash')).json;
    const fixture = path.join(ctx.gateRoot, 'e2e', 'fixtures', 'sample-repo');
    const read = (f) => fs.readFileSync(path.join(fixture, f), 'utf8');
    const juris = ['EU', 'US-FED'];

    const valid = (name, r, extra = () => true, describe = '') => {
      const ok = !r.error && !r.isError && r.json && typeof r.json.disclaimer === 'string'
        && r.json.provenance?.corpus?.stateHash === hash.stateHash && extra(r.json);
      gate.check(`${name}${describe ? ` (${describe})` : ''}: valid result with live provenance`, ok,
        `non-error JSON, provenance.corpus.stateHash = ${hash.stateHash.slice(0, 12)}…`,
        r.error ? JSON.stringify(r.error) : r.isError ? r.text.slice(0, 200) : `stateHash ${r.json?.provenance?.corpus?.stateHash?.slice(0, 12)} ${extra(r.json ?? {}) ? '' : `; content check failed: ${JSON.stringify(r.json).slice(0, 200)}`}`);
      return ok;
    };
    const ruleKeysOf = (json) => Object.values(json?.markets ?? {}).flatMap((m) => (m.rules ?? []).map((x) => x.ruleKey));

    // check_applicability: by capability and by code
    const capRes = await mcp.call('check_applicability', { capabilities: ['ai_user_interaction'], jurisdictions: ['EU'] });
    valid('check_applicability', capRes, (j) => ruleKeysOf(j).includes('eu_ai_act.art50.1.chatbot_disclosure'), 'capability ai_user_interaction in EU -> Art. 50(1)');
    const codeRes = await mcp.call('check_applicability', { code: read('src/api/chat.ts'), language: 'typescript', jurisdictions: juris, sector: 'healthcare' });
    valid('check_applicability', codeRes, (j) => (j.capabilitiesEvaluated ?? []).includes('text_generation') && ruleKeysOf(j).length > 0, 'TypeScript code');
    const pyRes = await mcp.call('check_applicability', { code: read('app/chatbot.py'), language: 'python', jurisdictions: juris, sector: 'healthcare', dataTypes: ['phi'] });
    valid('check_applicability', pyRes, (j) => ruleKeysOf(j).some((k) => k.startsWith('hipaa.')), 'Python code with PHI -> HIPAA');
    const none = await mcp.call('check_applicability', { code: 'const total = 1 + 2;', jurisdictions: ['EU'] });
    valid('check_applicability', none, (j) => j.result === 'no_capabilities_detected', 'code without AI usage');

    // get_rule
    const rule = await mcp.call('get_rule', { ruleKey: 'eu_ai_act.art50.1.chatbot_disclosure' });
    valid('get_rule', rule, (j) => JSON.stringify(j).includes('eu_ai_act.art50.1.chatbot_disclosure') && /signature/.test(JSON.stringify(j)), 'by rule key, with signature');
    const missing = await mcp.call('get_rule', { ruleKey: 'no.such.rule' });
    gate.check('get_rule for an unknown rule key is a tool error, not a crash', missing.isError && !missing.error && /not found|no rule/i.test(missing.text), 'isError with "not found"', missing.error ? JSON.stringify(missing.error) : missing.text.slice(0, 160));

    // scan_code agrees with the scanner CLI on the same files
    const files = ['app/chatbot.py', 'app/triage.py', 'src/api/chat.ts'].map((p) => ({ path: p, content: read(p) }));
    const sc = await mcp.call('scan_code', { files, jurisdictions: juris, sector: 'healthcare' });
    valid('scan_code', sc, (j) => Array.isArray(j.findings) && j.findings.length > 0, 'fixture files');
    if (ctx.data.scan && sc.json?.findings) {
      const cli = rulesByFile(ctx.data.scan.findings);
      const viaMcp = rulesByFile(sc.json.findings);
      gate.check('scan_code finds the same rules per file as the scanner CLI', JSON.stringify(cli) === JSON.stringify(viaMcp),
        Object.fromEntries(Object.entries(cli).map(([k, v]) => [k, v.length])), Object.fromEntries(Object.entries(viaMcp).map(([k, v]) => [k, v.length])));
    }

    // Catalogue tools
    const fw = await mcp.call('list_frameworks', {});
    valid('list_frameworks', fw, (j) => JSON.stringify(j).length > 200);
    const lj = await mcp.call('list_jurisdictions', {});
    valid('list_jurisdictions', lj, (j) => ['EU', 'US-FED'].every((c) => JSON.stringify(j).includes(`"${c}"`)), 'includes EU and US-FED');
    const rc = await mcp.call('regulatory_changes', { since: '2000-01-01T00:00:00Z', jurisdictions: ['EU'] });
    valid('regulatory_changes', rc, (j) => /eu_ai_act\./.test(JSON.stringify(j)), 'EU since 2000 lists EU AI Act rules');
    const br = await mcp.call('bill_radar', {});
    valid('bill_radar', br);
    gate.check('stdout carries only JSON-RPC messages', mcp.notJson.length === 0, 'no stray output', mcp.notJson.slice(0, 2));
  } finally {
    await mcp.close();
  }

  // Fail closed when the engine cannot be reached
  const port = await freePort();
  const down = await startMcp(entry, { NOMUS_API_URL: `http://127.0.0.1:${port}`, NOMUS_API_KEY: ctx.data.orgApiKey });
  try {
    await down.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nomus-release-gate', version: '1' } });
    down.notify('notifications/initialized');
    const r = await down.call('check_applicability', { capabilities: ['ai_user_interaction'], jurisdictions: ['EU'] });
    gate.check('with the engine unreachable, tools fail closed (status unknown)', r.isError && /unknown/i.test(r.text), 'isError, says compliance status is unknown', r.text.slice(0, 160));
  } finally {
    await down.close();
  }
}
