// 7. Rules and SSE: admin create, update and retire of a rule reach
// subscribers as ordered policy events, filtered by jurisdiction; the corpus
// hash returns to its original value after create-then-retire; reconnect
// replay (Last-Event-ID) honours the filter; the connected-client count
// drops back to 0 when subscribers disconnect.

import { subscribe } from '../lib/sse.mjs';
import { waitFor, sleep } from '../lib/http.mjs';

export async function rulesSseChecks(ctx) {
  const { gate, webUrl } = ctx;
  const key = ctx.data.orgApiKey;
  const member = ctx.data.orgKey;
  const admin = ctx.data.adminKey;
  const clientCount = async () => (await admin.get('/api/v1/dashboard/connected-clients')).json?.count;

  const hash0 = (await member.get('/api/v1/policies/hash')).json;
  gate.equal('no SSE subscribers before the test', await clientCount(), 0);

  const stream = (q, lastEventId) => subscribe(`${webUrl}/api/v1/stream${q}`, { key, lastEventId });
  const eu = stream('?jurisdictions=EU');
  const ca = stream('?jurisdictions=US-CA');
  const all = stream('');
  const connected = await waitFor(() => [eu, ca, all].every((s) => s.events.some((e) => e.event === 'connected')), { timeout: 10_000 });
  gate.check('three subscribers connect through the dashboard origin', connected && eu.status === 200, 'connected events', [eu, ca, all].map((s) => `${s.status} ${s.events.map((e) => e.event).join(',')}${s.error ? ` ${s.error}` : ''}`));
  gate.equal('connected-client count is 3', await clientCount(), 3);

  // ── Admin rule lifecycle ──
  const sources = (await admin.get('/api/v1/sources')).json;
  const euSource = (Array.isArray(sources) ? sources : sources?.sources ?? []).find((s) => s.jurisdiction === 'EU' && /AI Act/i.test(s.name));
  const ruleKey = `eu_ai_act.gate.deepfake_label_${Date.now().toString(36)}`;
  const created = await admin.post('/api/v1/admin/rules', {
    sourceId: euSource?.id, ruleKey, category: 'transparency',
    conditions: { action: 'generates_synthetic_media', region: 'EU' },
    effect: 'require_disclosure', severity: 'high',
    humanSummary: 'Release gate rule: label AI-generated synthetic media.',
    legalReference: 'EU AI Act Article 50(4)', effectiveDate: '2026-08-02',
  });
  gate.check('admin creates a rule', created.status === 201 && created.json?.ruleKey === ruleKey, '201', `${created.status} ${JSON.stringify(created.json)?.slice(0, 160)}`);
  const ruleId = created.json?.id;
  if (!ruleId) return;
  const hash1 = (await member.get('/api/v1/policies/hash')).json;
  gate.check('the corpus hash changes and the rule count grows by one', hash1.stateHash !== hash0.stateHash && hash1.ruleCount === hash0.ruleCount + 1, `new hash, ${hash0.ruleCount + 1} rules`, `${hash1.stateHash === hash0.stateHash ? 'same hash' : 'new hash'}, ${hash1.ruleCount} rules`);
  const sim1 = await member.post('/api/v1/simulate', { capabilities: ['generates_synthetic_media'], targetMarkets: ['EU'] });
  gate.check('the new rule applies at once in /simulate', (sim1.json?.markets?.EU?.rules ?? []).some((r) => r.ruleKey === ruleKey), `includes ${ruleKey}`, (sim1.json?.markets?.EU?.rules ?? []).map((r) => r.ruleKey));
  const bundle1 = (await member.get('/api/v1/policies/bundle?jurisdictions=EU')).json;
  gate.check('the EU policy bundle includes it', (bundle1?.policies ?? []).some((p) => p.ruleKey === ruleKey), 'included', 'missing');

  const edited = await admin.patch(`/api/v1/admin/rules/${ruleId}`, { severity: 'critical' });
  gate.check('admin edits the rule (new signed version)', edited.status === 200 && edited.json?.severity === 'critical' && edited.json?.version === (created.json.version ?? 1) + 1, `200, critical, version ${(created.json.version ?? 1) + 1}`, `${edited.status} ${edited.json?.severity} v${edited.json?.version}`);
  const retired = await admin.post(`/api/v1/admin/rules/${ruleId}/retire`);
  gate.check('admin retires the rule', retired.status === 200 && retired.json?.isActive === false, '200, inactive', `${retired.status} active=${retired.json?.isActive}`);

  const got = await waitFor(() => eu.events.filter((e) => e.json?.ruleKey === ruleKey).length >= 3 && all.events.filter((e) => e.json?.ruleKey === ruleKey).length >= 3, { timeout: 10_000 });
  const ours = (s) => s.events.filter((e) => e.json?.ruleKey === ruleKey);
  gate.check('EU subscriber receives created, updated, revoked in order', JSON.stringify(ours(eu).map((e) => e.event)) === JSON.stringify(['policy.created', 'policy.updated', 'policy.revoked']),
    ['policy.created', 'policy.updated', 'policy.revoked'], got ? ours(eu).map((e) => e.event) : `timed out; got ${ours(eu).map((e) => e.event)}`);
  const ids = ours(eu).map((e) => Number(e.id));
  gate.check('event ids are increasing sequence numbers', ids.length === 3 && ids.every((n, i) => Number.isInteger(n) && (i === 0 || n > ids[i - 1])), 'strictly increasing', ids);
  gate.equal('unfiltered subscriber receives the same events', ours(all).map((e) => `${e.id}:${e.event}`), ours(eu).map((e) => `${e.id}:${e.event}`));
  gate.equal('US-CA subscriber receives none of the EU events', ours(ca).length, 0);

  const hash2 = (await member.get('/api/v1/policies/hash')).json;
  gate.check('after create-then-retire the corpus hash returns to its original value', hash2.stateHash === hash0.stateHash && hash2.ruleCount === hash0.ruleCount, `${hash0.stateHash.slice(0, 16)}… / ${hash0.ruleCount}`, `${hash2.stateHash.slice(0, 16)}… / ${hash2.ruleCount}`);
  const sim2 = await member.post('/api/v1/simulate', { capabilities: ['generates_synthetic_media'], targetMarkets: ['EU'] });
  gate.check('the retired rule no longer applies', !(sim2.json?.markets?.EU?.rules ?? []).some((r) => r.ruleKey === ruleKey), 'absent', 'still applies');
  const integ = (await admin.post('/api/v1/admin/verify-integrity')).json;
  gate.check('integrity check still passes for every active rule', integ?.corrupted?.length === 0 && integ?.total === hash2.ruleCount, `0 corrupted of ${hash2.ruleCount}`, JSON.stringify(integ)?.slice(0, 120));
  const history = (await admin.get(`/api/v1/admin/rules/${ruleId}`)).json;
  gate.check('rule history records the three changes', JSON.stringify(history ?? {}).includes('policy.revoked') || (history?.history ?? history?.events ?? []).length >= 3, 'history with create/update/retire', JSON.stringify(history)?.slice(0, 160));

  // ── Reconnect replay ──
  const before = ids[0] - 1;
  const replayEu = stream('?jurisdictions=EU', before);
  const replayCa = stream('?jurisdictions=US-CA', before);
  await waitFor(() => [replayEu, replayCa].every((s) => s.events.some((e) => e.event === 'connected')), { timeout: 10_000 });
  await sleep(300);
  gate.equal('reconnect with Last-Event-ID replays the missed EU events', ours(replayEu).map((e) => `${e.id}:${e.event}`), ours(eu).map((e) => `${e.id}:${e.event}`));
  const leaked = replayCa.events.filter((e) => e.event?.startsWith('policy.') && e.json?.jurisdiction !== 'US-CA');
  gate.check('replay honours the jurisdictions filter (US-CA gets no EU events)', leaked.length === 0, 'none', leaked.map((e) => `${e.id}:${e.event}:${e.json?.jurisdiction}`).slice(0, 5));

  // ── Disconnect ──
  gate.equal('connected-client count is 5 with the replay subscribers', await clientCount(), 5);
  for (const s of [eu, ca, all, replayEu, replayCa]) await s.close();
  const zero = await waitFor(async () => (await clientCount()) === 0, { timeout: 5000 });
  gate.check('connected-client count returns to 0 after the subscribers disconnect', zero, 0, await clientCount());
  ctx.data.ruleCountAfterSse = hash2.ruleCount;
}
