// CPG Phase 2: the corporate policy registry on the real built engine
// (design spec §16.2, release-gate checks 1 to 10).
//
// Runs against the gate-policy org from cpg-setup.mjs. Signatures are
// verified OFFLINE here, with node:crypto and the public key from
// /.well-known/nomus-keys, independently of the product's own code; the
// built scanner library is then exercised against the same bundle. At the
// end the org's governance is switched off again, so the areas after this
// one see the org as cpg-rbac left it.

import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, seen5xx, waitFor } from '../lib/http.mjs';
import { subscribe } from '../lib/sse.mjs';

// ── offline verification helpers (independent of the engine and scanner code) ──
const canonical = (v) => JSON.stringify(sortDeep(v));
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
function verifyEd25519(spkiB64, text, sigB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(sigB64 ?? '', 'base64'));
  } catch {
    return false;
  }
}
function verifyBundleOffline(spki, b) {
  if (!b || b.kind !== 'nomus.cpg-bundle.v1') return 'not a bundle';
  if (!verifyEd25519(spki, canonical({ kind: b.kind, orgId: b.orgId, enabled: b.enabled, bundleHash: b.bundleHash, generatedAt: b.generatedAt }), b.signature)) return 'bundle signature does not verify';
  const sorted = [...b.policies].sort((x, y) => (x.policyKey < y.policyKey ? -1 : x.policyKey > y.policyKey ? 1 : 0));
  const content = sorted.map(({ activationSignature, ...rest }) => rest);
  if (sha256(canonical({ policies: content })) !== b.bundleHash) return 'bundle hash does not recompute';
  for (const p of b.policies) {
    if (sha256(canonical(p.rule)) !== p.ruleHash) return `rule hash of ${p.policyKey} does not recompute`;
    const payload = {
      kind: 'nomus.cpg-policy.v1', orgId: b.orgId, policyId: p.policyId, policyKey: p.policyKey, version: p.version, title: p.title, tier: p.tier,
      owningBoardIds: p.owningBoards.map((x) => x.id), ruleHash: p.ruleHash, enforceFrom: p.enforceFrom, activatedAt: p.activatedAt,
    };
    if (!verifyEd25519(spki, canonical(payload), p.activationSignature)) return `activation signature of ${p.policyKey} does not verify`;
  }
  return null;
}

// ── example code (only ever sent to the engine, never to the LLM) ──
const OPENAI_CALL = (marker) => `import OpenAI from 'openai';\nconst client = new OpenAI();\n// ${marker}\nexport const ask = (q) => client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: q }] });\n`;
const MARKERS = ['gate-example-marker-violating-51c2', 'gate-example-marker-compliant-8e07', 'gate-example-marker-mismatch-3b9d', 'gate-example-marker-model-77aa', 'gate-example-marker-pii-0f4e'];
const PII_CALL = `import OpenAI from 'openai';\nconst openai = new OpenAI();\n// ${MARKERS[4]}\nexport async function summarize(user) {\n  const ssn = user.ssn;\n  return openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: ssn }] });\n}\n`;

const TEXT = {
  openai: 'Engineers must not call direct OpenAI APIs from services; every call goes through the approved LLM gateway.',
  model: 'The gpt-4-32k model is retired: no new code may reference gpt-4-32k.',
  pii: 'Never send personal data to an AI model without a review by Legal.',
  taste: 'Every AI integration must be well designed and show good taste.',
  unknown: 'Quarterly architecture reviews happen on the first Monday of each quarter.',
};

export async function cpgPolicyChecks(ctx) {
  const { gate, webUrl, engineUrl, repoRoot } = ctx;
  const { adminKey, orgKey: healthKey, orgApiKey: healthKeyRaw } = ctx.data;
  const { owner, users } = ctx.data.cpg;
  const api = new Client(webUrl);
  const author = users.author.client;
  const approver = users.approver.client;
  const dev = users.dev.client;
  const auditor = users.auditor.client;
  const fiveXxBefore = seen5xx.length;
  const spki = (await api.get('/.well-known/nomus-keys')).json?.keys?.[0]?.spki;
  gate.check('instance public key is published (/.well-known/nomus-keys spki)', typeof spki === 'string' && spki.length > 40, 'base64 SPKI', String(spki).slice(0, 24));

  // The regulatory corpus as it stands when this area starts (the pipeline area has grown it).
  const hash0 = (await healthKey.get('/api/v1/policies/hash')).json;

  // ── 1. enable CPG; the empty bundle verifies offline ──────────────
  const enable = await owner.client.patch('/api/v1/cpg/settings', { enabled: true });
  gate.check('Org Admin enables corporate policy governance (PATCH /cpg/settings)', enable.status === 200 && enable.json?.enabled === true, '200 enabled true', `${enable.status} ${enable.json?.enabled}`);
  const keyRes = await owner.client.post('/api/v1/org/api-keys', { label: 'cpg policy gate', scopes: ['read:policies', 'stream'] });
  const policyKey = keyRes.json?.key;
  const policyOrgKey = api.withKey(policyKey);
  const b0 = await policyOrgKey.get('/api/v1/cpg/bundle');
  gate.check('gate-policy bundle (org key): enabled, no policies, signature verifies offline',
    b0.status === 200 && b0.json?.enabled === true && b0.json?.policies?.length === 0 && verifyBundleOffline(spki, b0.json) === null,
    '200, enabled, [], verifies', `${b0.status} enabled=${b0.json?.enabled} n=${b0.json?.policies?.length} ${verifyBundleOffline(spki, b0.json)}`);

  // ── 2. gate-health (never enabled) ───────────────────────────────
  const hb = await healthKey.get('/api/v1/cpg/bundle');
  gate.check('gate-health bundle: enabled false, no policies, signed', hb.status === 200 && hb.json?.enabled === false && hb.json?.policies?.length === 0 && verifyBundleOffline(spki, hb.json) === null,
    '200, enabled false, [], verifies', `${hb.status} enabled=${hb.json?.enabled} ${verifyBundleOffline(spki, hb.json)}`);

  // ── 3. boards ────────────────────────────────────────────────────
  const ai = await owner.client.post('/api/v1/cpg/boards', { key: 'ai-review', name: 'AI Review Board', kind: 'ai' });
  const legal = await owner.client.post('/api/v1/cpg/boards', { key: 'legal', name: 'Legal Board', kind: 'legal' });
  gate.check('Org Admin creates "AI Review Board" and "Legal Board" (201)', ai.status === 201 && legal.status === 201, '201, 201', `${ai.status}, ${legal.status}`);
  const aiId = ai.json?.id;
  const legalId = legal.json?.id;
  const m1 = await owner.client.post(`/api/v1/cpg/boards/${aiId}/members`, { userId: users['ai-reviewer'].id });
  const m2 = await owner.client.post(`/api/v1/cpg/boards/${legalId}/members`, { userId: users['legal-reviewer'].id });
  const boards = await dev.get('/api/v1/cpg/boards');
  const ownerBoards = await owner.client.get('/api/v1/cpg/boards');
  const aiMembers = (ownerBoards.json?.items ?? []).find((b) => b.id === aiId)?.members?.map((m) => m.userEmail);
  gate.check('board members added; the list shows them to the Org Admin and member counts to a Developer',
    m1.status === 201 && m2.status === 201 && JSON.stringify(aiMembers) === JSON.stringify([users['ai-reviewer'].email]) && (boards.json?.items ?? []).every((b) => b.members === null && b.memberCount === 1),
    '201, 201, members visible to boards.manage only', `${m1.status} ${m2.status} ${JSON.stringify(aiMembers)} ${JSON.stringify((boards.json?.items ?? []).map((b) => [b.key, b.memberCount, b.members]))}`);
  const devBoard = await dev.post('/api/v1/cpg/boards', { key: 'dev-board', name: 'Dev board', kind: 'custom' });
  gate.equal('a Developer cannot create a board (403 forbidden)', [devBoard.status, devBoard.json?.code], [403, 'forbidden']);

  // ── 4. quorum ────────────────────────────────────────────────────
  const q1 = (await owner.client.get('/api/v1/cpg/quorum')).json;
  const seedOk = q1?.version === 1 && q1?.createdBy === 'system:seed' && q1?.config?.tiers?.prohibited?.snippet?.approvals === 2
    && q1?.config?.tiers?.prohibited?.bulk?.allowed === false && q1?.config?.tiers?.['review-required']?.snippet?.approvals === 1
    && q1?.config?.policyApproval?.approvals === 1 && q1?.config?.standingExceptions?.maxExpiryDays === 90 && q1?.config?.standingExceptions?.defaultExpiryDays === 30
    && q1?.config?.gracePeriod?.newPolicyDefaultDays === 14 && sha256(canonical(q1?.config)) === q1?.configHash
    && verifyEd25519(spki, canonical({ kind: 'nomus.cpg-quorum.v1', orgId: ctx.data.cpg.orgId, version: 1, configHash: q1?.configHash, createdAt: q1?.createdAt }), q1?.signature);
  gate.check('quorum v1 is the seed (brief §5 defaults) and its signature verifies offline', seedOk, 'v1 by system:seed, defaults, verifies', JSON.stringify({ v: q1?.version, by: q1?.createdBy, hash: q1?.configHash?.slice(0, 12) }));
  const v2Config = { ...q1.config, proposalLapseDays: 45 };
  const q2 = await owner.client.put('/api/v1/cpg/quorum', { config: v2Config, changeNote: 'Release gate: longer proposal window' });
  gate.check('Org Admin PUT /cpg/quorum creates v2 (201); its signature verifies offline',
    q2.status === 201 && q2.json?.version === 2 && verifyEd25519(spki, canonical({ kind: 'nomus.cpg-quorum.v1', orgId: ctx.data.cpg.orgId, version: 2, configHash: q2.json?.configHash, createdAt: q2.json?.createdAt }), q2.json?.signature),
    '201 v2, verifies', `${q2.status} v${q2.json?.version}`);
  const devQ = await dev.put('/api/v1/cpg/quorum', { config: v2Config, changeNote: 'dev' });
  gate.equal('a Developer cannot change the quorum (403)', devQ.status, 403);
  const bulkCfg = JSON.parse(JSON.stringify(v2Config));
  bulkCfg.tiers.prohibited.bulk = { ...bulkCfg.tiers['review-required'].bulk };
  const bulk = await owner.client.put('/api/v1/cpg/quorum', { config: bulkCfg, changeNote: 'try bulk on prohibited' });
  gate.equal('a config enabling bulk on the prohibited tier is refused (400 invalid_input)', [bulk.status, bulk.json?.code], [400, 'invalid_input']);
  const versions = await auditor.get('/api/v1/cpg/quorum/versions');
  gate.equal('quorum version history has 2 versions (Auditor)', (versions.json?.items ?? []).map((v) => v.version), [1, 2]);

  // ── 5. compile outcomes ──────────────────────────────────────────
  const callsBefore = ctx.llm.calls.filter((c) => c.kind === 'cpg-compile').length;
  const compile = (plainText, violating, compliant = []) => author.post('/api/v1/cpg/compile', { plainText, examples: { violating, compliant } });
  const cOpenai = await compile(TEXT.openai, [{ path: 'src/app/chat.js', code: OPENAI_CALL(MARKERS[0]) }], [{ path: 'src/llm/gateway/client.js', code: OPENAI_CALL(MARKERS[1]) }]);
  const cTaste = await compile(TEXT.taste, [{ path: 'src/app/ui.js', code: `export const x = 1; // ${MARKERS[2]}\n` }]);
  const cMismatch = await compile(TEXT.openai, [{ path: 'src/app/util.js', code: `export const add = (a, b) => a + b; // ${MARKERS[2]}\n` }]);
  const cUnknown = await compile(TEXT.unknown, [{ path: 'src/app/x.js', code: `export const y = 2; // ${MARKERS[2]}\n` }]);
  const outcomes = [cOpenai, cTaste, cMismatch, cUnknown].map((r) => [r.status, r.json?.status]);
  gate.equal('compile outcomes: direct OpenAI compiled, well designed rejected_unexpressible, mismatched example rejected_examples, unrecognised rejected_schema (all 201)',
    outcomes, [[201, 'compiled'], [201, 'rejected_unexpressible'], [201, 'rejected_examples'], [201, 'rejected_schema']]);
  const callsAfter = ctx.llm.calls.filter((c) => c.kind === 'cpg-compile').length;
  const ids = new Set([cOpenai, cTaste, cMismatch, cUnknown].map((r) => r.json?.id));
  gate.check('each compile made exactly one LLM call and one compile record, with no 5xx', callsAfter - callsBefore === 4 && ids.size === 4 && seen5xx.length === fiveXxBefore,
    '4 calls, 4 records, 0 5xx', `${callsAfter - callsBefore} calls, ${ids.size} records, ${seen5xx.length - fiveXxBefore} 5xx`);
  const readBack = await approver.get(`/api/v1/cpg/compile/${cOpenai.json?.id}`);
  gate.check('the compile record reads back (approver) with the verified examples', readBack.status === 200 && readBack.json?.exampleResults?.every((e) => e.passed),
    '200, examples passed', `${readBack.status} ${JSON.stringify(readBack.json?.exampleResults?.map((e) => [e.kind, e.passed]))}`);

  // ── 6. no example code reached the LLM ───────────────────────────
  const compileCalls = ctx.llm.calls.filter((c) => c.kind === 'cpg-compile').slice(callsBefore);
  const leaked = compileCalls.filter((c) => MARKERS.some((m) => c.requestBody.includes(m)) || c.requestBody.includes('chat.completions.create({'));
  const carriedText = compileCalls.every((c) => [TEXT.openai, TEXT.taste, TEXT.unknown].some((t) => c.requestBody.includes(t)));
  gate.check('the fake-LLM log shows each compile prompt carried the policy text and none of the example code', compileCalls.length === 4 && carriedText && leaked.length === 0,
    'policy text present, example code absent', `${compileCalls.length} prompts, text ${carriedText}, leaked ${leaked.length}`);

  // ── 7. corp.no-direct-openai: four-eyes, activation, bundle ──────
  const p1 = await author.post('/api/v1/cpg/policies', { compileRecordId: cOpenai.json?.id, policyKey: 'corp.no-direct-openai', title: 'No direct OpenAI calls', tier: 'prohibited', owningBoardIds: [aiId, legalId], graceDays: 0 });
  const p1Version = p1.json?.policy?.pendingVersionId;
  gate.check('the author proposes corp.no-direct-openai (prohibited, AI + Legal, grace 0): 201 proposed', p1.status === 201 && p1.json?.policy?.state === 'proposed',
    '201 proposed', `${p1.status} ${p1.json?.policy?.state ?? JSON.stringify(p1.json)?.slice(0, 160)}`);
  // Give the author the approver role too: four-eyes must hold by identity, not by missing permission.
  const roles = (await owner.client.get('/api/v1/cpg/roles')).json?.items ?? [];
  const approverRole = roles.find((r) => r.key === 'policy_approver')?.id;
  const g = await owner.client.post(`/api/v1/cpg/users/${users.author.id}/grants`, { roleId: approverRole, scopeType: 'org' });
  const selfVote = await author.post(`/api/v1/cpg/policy-versions/${p1Version}/votes`, { vote: 'approve' });
  gate.equal("the author's own vote, even holding policy.approve: 403 self_approval_forbidden", [g.status, selfVote.status, selfVote.json?.code], [201, 403, 'self_approval_forbidden']);
  const vote1 = await approver.post(`/api/v1/cpg/policy-versions/${p1Version}/votes`, { vote: 'approve', comment: 'Release gate approval' });
  gate.equal("the approver's vote activates it (201, versionState active)", [vote1.status, vote1.json?.versionState], [201, 'active']);
  const b1 = await policyOrgKey.get('/api/v1/cpg/bundle');
  const p1InBundle = (b1.json?.policies ?? []).find((p) => p.policyKey === 'corp.no-direct-openai');
  gate.check('the bundle contains it; bundle and activation signatures verify offline',
    b1.status === 200 && p1InBundle?.tier === 'prohibited' && p1InBundle?.version === 1 && verifyBundleOffline(spki, b1.json) === null,
    'present, prohibited v1, verifies', `${b1.status} ${p1InBundle?.tier} ${verifyBundleOffline(spki, b1.json)}`);
  const etag = b1.headers.get('etag');
  const notModified = await policyOrgKey.get('/api/v1/cpg/bundle', { headers: { 'If-None-Match': etag } });
  gate.check('If-None-Match with the ETag answers 304', notModified.status === 304 && !!etag && etag !== b0.headers.get('etag'), '304, ETag changed by the activation', `${notModified.status} ${etag}`);

  // ── 8. two more policies; grace period; SSE org filter ───────────
  const cModel = await compile(TEXT.model, [{ path: 'src/models.js', code: `// ${MARKERS[3]}\nexport const model = 'gpt-4-32k';\n` }]);
  const p2 = await author.post('/api/v1/cpg/policies', { compileRecordId: cModel.json?.id, policyKey: 'corp.no-gpt-4-32k', title: 'Do not use gpt-4-32k', tier: 'review-required', owningBoardIds: [aiId], graceDays: 14 });
  const vote2 = await approver.post(`/api/v1/cpg/policy-versions/${p2.json?.policy?.pendingVersionId}/votes`, { vote: 'approve' });
  const b2 = await policyOrgKey.get('/api/v1/cpg/bundle');
  const p2InBundle = (b2.json?.policies ?? []).find((p) => p.policyKey === 'corp.no-gpt-4-32k');
  const graceMs = p2InBundle ? Date.parse(p2InBundle.enforceFrom) - Date.parse(p2InBundle.activatedAt) : NaN;
  gate.check('corp.no-gpt-4-32k (review-required, grace 14 days) is in the bundle with a future enforceFrom',
    cModel.json?.status === 'compiled' && p2.status === 201 && vote2.json?.versionState === 'active' && graceMs === 14 * 86_400_000 && Date.parse(p2InBundle.enforceFrom) > Date.now(),
    'compiled, active, enforceFrom = activatedAt + 14 days', `${cModel.json?.status} ${p2.status} ${vote2.json?.versionState} ${p2InBundle?.enforceFrom}`);

  const streamUrl = `${engineUrl}/api/v1/stream`;
  const mine = subscribe(streamUrl, { key: policyKey });
  const theirs = subscribe(streamUrl, { key: healthKeyRaw });
  await waitFor(() => [mine, theirs].every((s) => s.events.some((e) => e.event === 'connected')), { timeout: 10_000 });
  const cPii = await compile(TEXT.pii, [{ path: 'src/summarize.js', code: PII_CALL }]);
  const p3 = await author.post('/api/v1/cpg/policies', { compileRecordId: cPii.json?.id, policyKey: 'corp.no-pii-to-ai', title: 'No personal data in AI calls', tier: 'review-required', owningBoardIds: [legalId], graceDays: 0 });
  const vote3 = await approver.post(`/api/v1/cpg/policy-versions/${p3.json?.policy?.pendingVersionId}/votes`, { vote: 'approve' });
  const b3 = await policyOrgKey.get('/api/v1/cpg/bundle');
  const p3InBundle = (b3.json?.policies ?? []).find((p) => p.policyKey === 'corp.no-pii-to-ai');
  gate.check('corp.no-pii-to-ai (review-required, Legal, grace 0) is active; the bundle has 3 policies and verifies',
    cPii.json?.status === 'compiled' && vote3.json?.versionState === 'active' && p3InBundle?.enforceFrom === p3InBundle?.activatedAt && b3.json?.policies?.length === 3 && verifyBundleOffline(spki, b3.json) === null,
    'active, enforced now, 3 policies, verifies', `${cPii.json?.status} ${vote3.json?.versionState} ${b3.json?.policies?.map((p) => p.policyKey)} ${verifyBundleOffline(spki, b3.json)}`);
  await waitFor(() => mine.events.some((e) => e.event === 'cpg.bundle.changed'), { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 300));
  await mine.close();
  await theirs.close();
  const mineGot = mine.events.filter((e) => e.event === 'cpg.bundle.changed').map((e) => e.json?.orgId);
  const theirsGot = theirs.events.filter((e) => e.event?.startsWith('cpg.'));
  gate.check('SSE: the gate-policy subscriber gets cpg.bundle.changed; the gate-health subscriber gets no CPG event',
    mineGot.length >= 1 && mineGot.every((o) => o === ctx.data.cpg.orgId) && theirsGot.length === 0, 'own org only', `mine ${mineGot.length}, theirs ${theirsGot.length}`);

  // The built scanner library (dist) fetches and verifies the same bundle, then evaluates it locally with no LLM call.
  try {
    const lib = await import(pathToFileURL(path.join(repoRoot, 'packages', 'scanner', 'dist', 'corporate', 'index.js')).href);
    const fetched = await lib.fetchCorporateBundle({ apiUrl: engineUrl, apiKey: policyKey });
    const llmBefore = ctx.llm.calls.length;
    const evaluation = await lib.evaluateCorporateRules(
      [['src/app/chat.js', OPENAI_CALL('local-eval')], ['src/llm/gateway/client.js', OPENAI_CALL('local-eval')], ['src/models.js', "export const m = 'gpt-4-32k';\n"]],
      fetched.bundle.policies.map((p) => ({ policyKey: p.policyKey, version: p.version, rule: p.rule })),
    );
    const found = evaluation.findings.map((f) => `${f.policyKey}@${f.filePath}`).sort();
    gate.check('the built scanner library verifies the bundle and evaluates its rules locally (deterministic, no LLM call)',
      fetched.available && fetched.bundle.policies.length === 3 && JSON.stringify(found) === JSON.stringify(['corp.no-direct-openai@src/app/chat.js', 'corp.no-gpt-4-32k@src/models.js']) && ctx.llm.calls.length === llmBefore,
      'verified 3 policies; 2 findings; no LLM call', `${fetched.available} ${fetched.bundle?.policies?.length} ${JSON.stringify(found)} llm+${ctx.llm.calls.length - llmBefore}`);
  } catch (err) {
    gate.check('the built scanner library verifies the bundle and evaluates its rules locally (deterministic, no LLM call)', false, 'no exception', String(err?.message ?? err));
  }

  // ── 9. the regulatory corpus is untouched ────────────────────────
  const hash1 = (await healthKey.get('/api/v1/policies/hash')).json;
  const integ = (await adminKey.post('/api/v1/admin/verify-integrity')).json;
  gate.check('the regulatory corpus is untouched by CPG: same state hash and rule count, integrity fully valid',
    hash1?.stateHash === hash0?.stateHash && hash1?.ruleCount === hash0?.ruleCount && integ?.corrupted?.length === 0 && integ?.valid === integ?.total && integ?.total === hash0?.ruleCount,
    `${hash0?.stateHash?.slice(0, 16)}… / ${hash0?.ruleCount}`, `${hash1?.stateHash?.slice(0, 16)}… / ${hash1?.ruleCount}; integrity ${integ?.valid}/${integ?.total}`);

  // ── 10. signed export ────────────────────────────────────────────
  const exp = await auditor.get('/api/v1/cpg/policies/export?format=json');
  const e = exp.json;
  const expOk = exp.status === 200 && sha256(canonical(e?.content)) === e?.contentHash
    && verifyEd25519(spki, canonical({ kind: 'nomus.cpg-policy-export.v1', orgId: e?.orgId, exportedAt: e?.exportedAt, contentHash: e?.contentHash }), e?.signature)
    && e?.content?.policies?.length === 3 && e.content.policies.every((p) => p.events.some((ev) => ev.event === 'activated' && ev.details?.signature));
  gate.check('Auditor GET /cpg/policies/export: the export signature and content hash verify offline', expOk, '200, verifies, 3 policies with activation signatures', `${exp.status} ${e?.content?.policies?.length}`);
  const devExport = await dev.get('/api/v1/cpg/policies/export');
  gate.equal('a Developer cannot export the policy log (403)', devExport.status, 403);

  // ── restore: governance off again for the areas after this one ───
  const disable = await owner.client.patch('/api/v1/cpg/settings', { enabled: false });
  const bOff = await policyOrgKey.get('/api/v1/cpg/bundle');
  gate.check('switching governance off again: the bundle is enabled false with no policies (signed, new ETag)',
    disable.status === 200 && bOff.json?.enabled === false && bOff.json?.policies?.length === 0 && verifyBundleOffline(spki, bOff.json) === null && bOff.headers.get('etag') !== etag,
    'enabled false, [], verifies', `${disable.status} enabled=${bOff.json?.enabled} n=${bOff.json?.policies?.length}`);
  if (keyRes.json?.id) await owner.client.del(`/api/v1/org/api-keys/${keyRes.json.id}`);
  ctx.data.cpg.policy = { aiBoardId: aiId, legalBoardId: legalId, policyKeys: ['corp.no-direct-openai', 'corp.no-gpt-4-32k', 'corp.no-pii-to-ai'] };
}
