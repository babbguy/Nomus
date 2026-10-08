// 1. Bring-up: a fresh database starts cleanly, seeds its sources and rule
// sets, the admin bootstrap works (env admin, bootstrap key, invited member
// with a forced password change) and every rule passes the integrity check.

import { Client, waitFor } from '../lib/http.mjs';

export async function bringUp(ctx) {
  const { gate, engineUrl, webUrl, secrets, expected, engine } = ctx;
  gate.section('bring-up');

  const healthy = await waitFor(async () => {
    if (engine.exited) return 'exited';
    try { const r = await fetch(`${engineUrl}/health`); return r.status === 200 ? 'ok' : null; } catch { return null; }
  }, { timeout: 90_000, interval: 300 });
  if (!gate.check('engine starts on a fresh database and answers /health', healthy === 'ok', '200 within 90 s',
    healthy === 'exited' ? `engine exited ${JSON.stringify(engine.exited)}: ${engine.lines.slice(-5).map((l) => l.text).join(' | ')}` : 'no answer')) {
    return false;
  }
  const ready = await fetch(`${engineUrl}/ready`).then((r) => r.status).catch(() => 0);
  gate.equal('GET /ready', ready, 200);
  const viaWeb = await fetch(`${webUrl}/api/v1/status`).then((r) => r.status).catch(() => 0);
  gate.equal('dashboard origin proxies /api to the engine', viaWeb, 200);

  // Bootstrap API key (admin scope) from NOMUS_ADMIN_BOOTSTRAP_KEY
  const api = new Client(webUrl);
  const adminKey = api.withKey(secrets.bootstrapKey);
  const tenants = await adminKey.get('/api/v1/tenants');
  gate.equal('bootstrap admin key is accepted (GET /tenants)', tenants.status, 200);
  const badKey = await api.withKey('nk_live_not-a-real-key-000000000000').get('/api/v1/tenants');
  gate.equal('an unknown API key is rejected', badKey.status, 401);

  // Seeded sources and rules
  const hash = await adminKey.get('/api/v1/policies/hash');
  const ruleCount = hash.json?.ruleCount;
  gate.equal('seeded active rule count matches expectations.json', ruleCount, expected.seed.activeRules);
  gate.check('corpus state hash is a sha-256 hex string', /^[0-9a-f]{64}$/.test(hash.json?.stateHash ?? ''), '64 hex chars', hash.json?.stateHash);
  const sources = await adminKey.get('/api/v1/sources');
  const sourceList = Array.isArray(sources.json) ? sources.json : sources.json?.sources;
  gate.equal('seeded regulatory source count matches expectations.json', sourceList?.length, expected.seed.sources);
  const jurisdictions = await adminKey.get('/api/v1/policies?limit=1000');
  const ruleJur = new Set((jurisdictions.json?.policies ?? jurisdictions.json?.rules ?? []).map((r) => r.jurisdiction));
  const missingJur = expected.seed.ruleJurisdictions.filter((j) => !ruleJur.has(j));
  gate.check('seeded rules cover the expected jurisdictions', missingJur.length === 0, expected.seed.ruleJurisdictions, missingJur.length ? `missing ${missingJur.join(', ')}` : 'all present');

  // Rule integrity: every active rule's signature verifies
  const integ = await adminKey.post('/api/v1/admin/verify-integrity');
  gate.check('rule integrity check passes for every rule', integ.status === 200 && integ.json?.corrupted?.length === 0 && integ.json?.valid === integ.json?.total && integ.json?.total === ruleCount,
    `200, 0 corrupted, valid = total = ${ruleCount}`, `${integ.status} ${JSON.stringify(integ.json)?.slice(0, 200)}`);

  // Admin login from NOMUS_ADMIN_EMAIL / NOMUS_ADMIN_PASSWORD
  const wrong = await api.login(secrets.adminEmail, `${secrets.adminPassword}x`);
  gate.equal('admin login with a wrong password is rejected', wrong.status, 401);
  const adminLogin = await api.login(secrets.adminEmail, secrets.adminPassword);
  gate.check('admin signs in with the bootstrap credentials', adminLogin.status === 200 && adminLogin.json?.user?.role === 'platform_admin' && adminLogin.client,
    '200, role platform_admin, session cookie', `${adminLogin.status} ${JSON.stringify(adminLogin.json?.user ?? adminLogin.json)}`);
  if (!adminLogin.client) return false;
  const admin = adminLogin.client;
  gate.equal('bootstrap admin is not asked to change the password set in the environment', adminLogin.json?.user?.mustChangePassword, false);

  // Customer organization, invited member with a forced password change
  const slug = expected.org.slug;
  const org = await adminKey.post('/api/v1/tenants', { name: expected.org.name, slug });
  gate.equal('admin creates an organization', org.status, 201);
  if (org.status !== 201) return false;
  const orgId = org.json.id;
  const memberEmail = expected.org.memberEmail;
  const invite = await admin.post('/api/v1/users', { email: memberEmail, name: 'Gate Member', orgId, role: 'member' });
  gate.check('admin invites a member and receives a temporary password', invite.status === 201 && typeof invite.json?.tempPassword === 'string',
    '201 with tempPassword', `${invite.status} ${JSON.stringify(invite.json)?.slice(0, 200)}`);
  if (invite.status !== 201) return false;
  const temp = invite.json.tempPassword;
  const first = await api.login(memberEmail, temp);
  gate.check('member first sign-in with the temporary password must change it', first.status === 200 && first.json?.user?.mustChangePassword === true,
    '200, mustChangePassword true', `${first.status} ${JSON.stringify(first.json?.user)}`);
  if (!first.client) return false;
  // The temporary password is only for setting a real one: until then the
  // session must not reach the product API (it was enforced only in the
  // dashboard's router, so the API served everything to the temp session).
  const early = await first.client.get('/api/v1/org');
  const earlyKey = await first.client.post('/api/v1/org/api-keys', { label: 'before-password-change', scopes: ['read:policies'] });
  gate.check('a session that must change its password is refused by the API until it does', early.status === 403 && earlyKey.status === 403,
    'GET /org 403 and POST /org/api-keys 403', `GET /org ${early.status}, POST /org/api-keys ${earlyKey.status}`);
  const memberPassword = `Member-${Math.random().toString(36).slice(2, 10)}-Gate!`;
  const change = await first.client.post('/api/v1/auth/force-change-password', { password: memberPassword });
  gate.equal('member sets a new password', change.status, 200);
  const again = await api.login(memberEmail, memberPassword);
  gate.check('member signs in with the new password, no change required', again.status === 200 && again.json?.user?.mustChangePassword === false,
    '200, mustChangePassword false', `${again.status} ${JSON.stringify(again.json?.user)}`);
  const oldPw = await api.login(memberEmail, temp);
  gate.equal('the temporary password no longer works', oldPw.status, 401);
  if (!again.client) return false;
  const member = again.client;

  // Organization profile and API key (Settings page, self-service)
  const profile = await member.patch('/api/v1/org', { industry: expected.org.industry, jurisdictionAccess: expected.org.jurisdictions });
  gate.check('member sets the organization profile (industry, jurisdictions)', profile.status === 200 && profile.json?.industry === expected.org.industry,
    `200 industry ${expected.org.industry}`, `${profile.status} ${JSON.stringify(profile.json)?.slice(0, 200)}`);
  const key = await member.post('/api/v1/org/api-keys', { label: 'release gate', scopes: ['read:policies', 'evaluate', 'stream'] });
  gate.check('member creates an organization API key', key.status === 201 && /^nk_live_/.test(key.json?.key ?? ''), '201 nk_live_ key', `${key.status} ${JSON.stringify(key.json)?.slice(0, 120)}`);
  if (key.status !== 201) return false;
  const orgKey = api.withKey(key.json.key);
  const me = await orgKey.get('/api/v1/policies/hash');
  gate.equal('organization key reads the corpus hash', me.status, 200);
  const adminOnly = await orgKey.get('/api/v1/tenants');
  gate.equal('organization key cannot use admin endpoints', adminOnly.status, 403);

  Object.assign(ctx.data, {
    api, admin, adminKey, member, orgKey, orgId, orgSlug: slug, orgApiKey: key.json.key,
    memberEmail, memberPassword, seedRuleCount: ruleCount, seedStateHash: hash.json?.stateHash, sources: sourceList,
  });
  return true;
}

