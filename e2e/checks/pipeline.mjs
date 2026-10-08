// 8. Regulation pipeline through the manual-upload path, with the fake LLM:
// uploading the Illinois AI Video Interview Act (820 ILCS 42) produces the
// expected signed rules; an identical re-upload changes nothing; and the
// upload path never touches the live source URL or its scrape health.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { subscribe } from '../lib/sse.mjs';
import { waitFor } from '../lib/http.mjs';

export async function pipelineChecks(ctx) {
  const { gate, repoRoot, webUrl, expected } = ctx;
  const admin = ctx.data.adminKey;
  const html = fs.readFileSync(path.join(ctx.gateRoot, 'e2e', 'fixtures', 'il-aivia.html'), 'utf8');

  const sources = (await admin.get('/api/v1/sources')).json;
  const list = Array.isArray(sources) ? sources : sources?.sources ?? [];
  const src = list.find((s) => /820 ILCS 42/.test(s.name));
  if (!gate.check('the registry has the Illinois AI Video Interview Act source', !!src, 'source named "... (820 ILCS 42)"', list.length)) return;
  const sid = src.id;

  const state = async () => {
    const all = (await admin.get('/api/v1/sources')).json;
    const s = (Array.isArray(all) ? all : all?.sources ?? []).find((x) => x.id === sid);
    const rules = (await admin.get(`/api/v1/sources/${sid}/rules`)).json;
    const hash = (await ctx.data.orgKey.get('/api/v1/policies/hash')).json;
    const radar = (await admin.get('/api/v1/radar')).json?.count;
    const bills = (await admin.get('/api/v1/radar/v2/stats')).json?.totalBills;
    return { source: s, rules: rules?.rules ?? [], hash, radar, bills };
  };
  const health = (s) => ({ url: s?.url, ingestionMode: s?.ingestionMode, connectivityStatus: s?.connectivityStatus, consecutiveFailures: s?.consecutiveFailures, needsManualUpload: s?.needsManualUpload, connectivityError: s?.connectivityError ?? null });

  const s0 = await state();
  const events = subscribe(`${webUrl}/api/v1/stream`, { key: ctx.secrets.bootstrapKey });
  await waitFor(() => events.events.some((e) => e.event === 'connected'), { timeout: 10_000 });

  const process = async (label) => {
    const llmBefore = ctx.llm?.calls.length ?? 0;
    const netBefore = probeNet(ctx.probeFile).length;
    const up = await admin.post(`/api/v1/sources/upload-content/${sid}`, { content: html, filename: 'il-aivia.html', contentType: 'html' });
    const expectHash = crypto.createHash('sha256').update(html).digest('hex');
    gate.check(`${label}: upload accepted`, up.status === 201 && up.json?.status === 'pending_upload' && up.json?.content_hash === expectHash, `201 pending_upload ${expectHash.slice(0, 12)}…`, `${up.status} ${up.json?.status} ${String(up.json?.content_hash).slice(0, 12)}`);
    const seen = events.events.length;
    const start = await admin.post(`/api/v1/admin/scrape/${sid}`);
    gate.equal(`${label}: processing starts`, start.json?.status, 'processing');
    const done = await waitFor(() => events.events.slice(seen).find((e) => e.event === 'pipeline.progress' && e.json?.sourceId === sid && e.json?.done), { timeout: 120_000 });
    const net = probeNet(ctx.probeFile).slice(netBefore).filter((n) => !isLoopback(n.host));
    return { done: done?.json ?? null, llmCalls: (ctx.llm?.calls.length ?? 0) - llmBefore, external: net, newEvents: events.events.slice(seen) };
  };

  // ── First upload ──
  const r1 = await process('upload');
  gate.check('upload: the run ends with one done event, outcome completed', r1.done?.outcome === 'completed', 'completed', JSON.stringify(r1.done)?.slice(0, 200) ?? 'no done event within 120 s');
  const s1 = await state();
  gate.equal('upload: rules created (fake LLM, deterministic)', r1.done?.rulesCreated, expected.pipeline.rulesCreated);
  gate.equal('upload: the source now has those rules', s1.rules.length, expected.pipeline.rulesCreated);
  const unsigned = s1.rules.filter((r) => !r.isActive || !/^us_il\./.test(r.ruleKey));
  gate.check('upload: every extracted rule is active and keyed to US-IL', unsigned.length === 0 && s1.rules.length > 0, 'all active us_il.*', unsigned.map((r) => r.ruleKey).slice(0, 3));
  const refs = s1.rules.map((r) => r.legalReference);
  gate.check('upload: rules cite the sections they came from (Sec. 5, 10, 15, 20)', ['Sec. 5', 'Sec. 10', 'Sec. 15', 'Sec. 20'].every((sec) => refs.some((x) => String(x).includes(sec))), 'Sec. 5, 10, 15, 20', [...new Set(refs)]);
  gate.equal('upload: corpus grows by the extracted rules', s1.hash.ruleCount, s0.hash.ruleCount + expected.pipeline.rulesCreated);
  const integ = (await admin.post('/api/v1/admin/verify-integrity')).json;
  gate.check('upload: every rule (including the new ones) passes the integrity check', integ?.corrupted?.length === 0 && integ?.total === s1.hash.ruleCount, `0 corrupted of ${s1.hash.ruleCount}`, JSON.stringify(integ)?.slice(0, 120));
  const created = r1.newEvents.filter((e) => e.event === 'policy.created' && e.json?.jurisdiction === 'US-IL');
  gate.equal('upload: subscribers receive one policy.created event per rule', created.length, expected.pipeline.rulesCreated);
  gate.check('upload: the engine made no request outside this machine (no live fetch of the source URL)', r1.external.length === 0, 'only loopback (fake LLM)', r1.external.map((n) => n.url).slice(0, 3));
  gate.equal('upload: the source\'s live-scrape settings and health are untouched', health(s1.source), health(s0.source));
  const content = (await admin.get(`/api/v1/sources/${sid}/content`)).json;
  gate.check('upload: the served text is the uploaded file, labelled as an upload', content?.provenanceMode === 'upload' && content?.contentHash === s1.source?.lastContentHash && /Artificial Intelligence Video Interview Act/.test(content?.content ?? ''),
    'provenanceMode upload, the promoted content', `${content?.provenanceMode} ${content?.provenanceLabel} ${String(content?.contentHash).slice(0, 12)}`);
  const sim = await ctx.data.orgKey.post('/api/v1/simulate', { capabilities: ['high_risk_employment', 'processes_user_input'], targetMarkets: ['US-IL'] });
  gate.check('upload: the extracted rules apply in /simulate for US-IL', (sim.json?.markets?.['US-IL']?.rules ?? []).some((r) => /^us_il\./.test(r.ruleKey)), 'us_il.* rules', (sim.json?.markets?.['US-IL']?.rules ?? []).map((r) => r.ruleKey).slice(0, 3));

  // ── Identical re-upload ──
  const r2 = await process('re-upload');
  const s2 = await state();
  gate.check('re-upload: the run ends with one done event and creates or updates nothing', !!r2.done && r2.done.outcome !== 'error' && r2.done.rulesCreated === 0 && r2.done.rulesUpdated === 0,
    'done, 0 created, 0 updated', JSON.stringify(r2.done)?.slice(0, 200) ?? 'no done event');
  gate.equal('re-upload: same corpus hash', s2.hash.stateHash, s1.hash.stateHash);
  gate.equal('re-upload: same rules and versions', s2.rules.map((r) => `${r.ruleKey}@${r.version}`).sort(), s1.rules.map((r) => `${r.ruleKey}@${r.version}`).sort());
  gate.equal('re-upload: no new radar signal or bill', [s2.radar, s2.bills], [s1.radar, s1.bills]);
  gate.equal('re-upload: no policy events', r2.newEvents.filter((e) => e.event?.startsWith('policy.')).map((e) => e.event), []);
  gate.check('re-upload: no request outside this machine', r2.external.length === 0, 'only loopback', r2.external.map((n) => n.url).slice(0, 3));
  gate.equal('re-upload: source health still untouched', health(s2.source), health(s0.source));
  if (r2.llmCalls > 0) gate.note(`identical re-upload re-ran extraction: ${r2.llmCalls} LLM calls, outcome "${r2.done?.outcome}" (uploads always reprocess the full file by design)`);

  const badIds = events.events.filter((e) => e.id !== undefined && !/^\d+$/.test(e.id)).map((e) => `${e.event} id=${e.id}`);
  gate.check('every stream event id is a sequence number (so Last-Event-ID replay resumes correctly)', badIds.length === 0, 'numeric ids (or none)', [...new Set(badIds.map((x) => x.replace(/id=.*/, 'id=<uuid>')))].slice(0, 4));

  const unknownPrompts = (ctx.llm?.calls ?? []).filter((c) => c.kind === 'unrecognized');
  gate.check('every LLM prompt the pipeline sent is one the fake LLM recognises', unknownPrompts.length === 0, 'none unrecognised', unknownPrompts.map((c) => c.system.slice(0, 80)).slice(0, 2));
  await events.close();
  ctx.data.pipelineRules = s1.rules.length;
}

export function probeNet(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x?.kind === 'net');
}

export function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}
