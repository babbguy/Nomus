// CPG Phase 1: org-scoped RBAC on the real built engine (design spec §16.1,
// release-gate checks 1 to 9).
//
// Runs against the gate-health org from bring-up (which never enables CPG)
// only to read what the v1.1.0 -> v1.2.0 migration gave its member, and
// otherwise against the second org created by cpg-setup.mjs.

import crypto from 'node:crypto';
import { Client } from '../lib/http.mjs';

const permsOf = (me) => new Set((me?.json?.permissions ?? []).map((p) => p.key));

function roleKeysOf(usersRes, userId) {
  const u = (usersRes?.json?.items ?? []).find((x) => x.id === userId);
  return u ? u.grants.map((g) => g.roleKey).sort() : null;
}

/** The VS Code device sign-in over plain HTTP with the user's session cookie. */
async function deviceSignIn(ctx, client) {
  const { webUrl } = ctx;
  const anon = new Client(webUrl);
  const state = crypto.randomUUID();
  const authorize = await anon.get(`/api/v1/auth/device/authorize?state=${state}&callback_uri=${encodeURIComponent('vscode://nomus.nomus/auth-callback')}`, { redirect: 'manual' });
  const callback = await client.get(`/api/v1/auth/device/callback?device_state=${state}`, { redirect: 'manual' });
  const location = callback.headers.get('location') ?? '';
  let code = null;
  try { code = new URL(location.replace('vscode://', 'http://')).searchParams.get('code'); } catch { /* reported below */ }
  const token = code ? await anon.post('/api/v1/auth/device/token', { code }) : { status: 0, json: null };
  return { authorize: authorize.status, callback: callback.status, location, token: token.status, apiKey: token.json?.apiKey ?? null, userEmail: token.json?.userEmail ?? null };
}

export async function cpgRbacChecks(ctx) {
  const { gate, expected, webUrl } = ctx;
  const { admin, member, orgId: healthOrgId, orgKey } = ctx.data;
  const { owner, users, passwordGate, orgId } = ctx.data.cpg;
  const api = new Client(webUrl);

  // ── 1. gate-health's member after the RBAC migration ─────────────────
  const memberMe = await member.get('/api/v1/cpg/me');
  const memberPerms = permsOf(memberMe);
  gate.check('gate-health member: GET /cpg/me 200 with Org Admin and Developer permissions',
    memberMe.status === 200 && memberMe.json?.orgId === healthOrgId && memberPerms.has('rbac.users.manage') && memberPerms.has('case.create') && memberMe.json?.cpgEnabled === false,
    '200, rbac.users.manage + case.create, cpgEnabled false', `${memberMe.status} ${JSON.stringify(memberMe.json)?.slice(0, 200)}`);
  const healthUsers = await member.get('/api/v1/cpg/users');
  gate.equal('gate-health member holds org_admin and developer (first member of the org)', roleKeysOf(healthUsers, memberMe.json?.user?.id), ['developer', 'org_admin']);

  // ── 2. platform admin ───────────────────────────────────────────────
  const adminMe = await admin.get('/api/v1/cpg/me');
  gate.check('platform admin: GET /cpg/me 200 with no permissions', adminMe.status === 200 && adminMe.json?.isPlatformAdmin === true && adminMe.json?.permissions?.length === 0,
    '200, isPlatformAdmin, permissions []', `${adminMe.status} ${JSON.stringify(adminMe.json)?.slice(0, 200)}`);
  const adminOrg = await admin.get('/api/v1/org');
  gate.equal('platform admin: GET /org still 200 (legacy access)', adminOrg.status, 200);
  const adminRoles = await admin.get('/api/v1/cpg/roles');
  gate.equal('platform admin gets no implicit CPG permission (GET /cpg/roles 403)', [adminRoles.status, adminRoles.json?.code], [403, 'forbidden']);
  const orgKeyMe = await orgKey.get('/api/v1/cpg/me');
  gate.equal('an org API key has no user identity (GET /cpg/me 403 user_identity_required)', [orgKeyMe.status, orgKeyMe.json?.code], [403, 'user_identity_required']);

  // ── 3. the new org's first member is Org Admin; temp session blocked ─
  const policyUsers = await owner.client.get('/api/v1/cpg/users');
  gate.equal(`${expected.cpg.org.slug}: the first member (${owner.email}) holds org_admin and developer`, roleKeysOf(policyUsers, owner.id), ['developer', 'org_admin']);
  const roles = await owner.client.get('/api/v1/cpg/roles');
  gate.equal(`${expected.cpg.org.slug} has the seven system roles`, (roles.json?.items ?? []).filter((r) => r.isSystem).map((r) => r.key).sort(), expected.cpg.systemRoles);
  gate.check('owner temporary-password session: GET /cpg/me 403 password_change_required, then 200 after the change',
    passwordGate.owner.mustChangeAtSignIn && passwordGate.owner.before.me[0] === 403 && passwordGate.owner.before.me[1] === 'password_change_required' && passwordGate.owner.after.me === 200,
    'mustChangePassword, 403 password_change_required, then 200', JSON.stringify({ before: passwordGate.owner.before, after: passwordGate.owner.after }));

  // ── 4. the seven invited users ──────────────────────────────────────
  const handles = Object.keys(expected.cpg.users);
  const blocked = handles.filter((h) => {
    const p = passwordGate[h];
    return p && p.mustChangeAtSignIn && p.before.me[0] === 403 && p.before.me[1] === 'password_change_required'
      && p.before.settings[0] === 403 && p.before.settings[1] === 'password_change_required' && p.after.me === 200;
  });
  gate.equal('all 7 invited users were refused by /cpg/* (403 password_change_required) until they changed the password', blocked.sort(), [...handles].sort());
  const invited = handles.map((h) => (policyUsers.json?.items ?? []).find((u) => u.email === expected.cpg.users[h].email)).filter(Boolean);
  gate.check('the 7 invited users are active org users with Developer and no temporary password left',
    invited.length === 7 && invited.every((u) => u.isActive && !u.mustChangePassword && u.grants.some((g) => g.roleKey === 'developer')),
    '7 users, active, Developer', JSON.stringify(invited.map((u) => [u.email, u.isActive, u.mustChangePassword, u.grants.map((g) => g.roleKey)])).slice(0, 300));

  // ── 5. grants ───────────────────────────────────────────────────────
  const roleIds = Object.fromEntries((roles.json?.items ?? []).map((r) => [r.key, r.id]));
  const granted = [];
  for (const h of handles) {
    const u = users[h];
    if (u.role === 'developer') continue;
    const g = await owner.client.post(`/api/v1/cpg/users/${u.id}/grants`, { roleId: roleIds[u.role], scopeType: 'org' });
    granted.push([h, g.status, g.json?.roleKey]);
  }
  gate.check('Org Admin grants each seed role (POST /cpg/users/:id/grants 201)', granted.length === 6 && granted.every(([, s, k], i) => s === 201 && k === users[granted[i][0]].role),
    '6 grants, 201', JSON.stringify(granted));
  const expectPerm = { author: 'policy.author', approver: 'policy.approve', 'ai-reviewer': 'case.review', 'legal-reviewer': 'case.review', exceptions: 'exception.approve', auditor: 'audit.export' };
  const holding = [];
  for (const [h, perm] of Object.entries(expectPerm)) {
    const me = await users[h].client.get('/api/v1/cpg/me');
    holding.push([h, perm, permsOf(me).has(perm)]);
  }
  gate.check('each granted user now holds the role\'s permission (GET /cpg/me)', holding.every(([, , ok]) => ok), 'all true', JSON.stringify(holding));
  const devRole = await users.dev.client.post('/api/v1/cpg/roles', { key: 'dev_made', name: 'Dev made', permissions: [] });
  gate.equal('Developer cannot create roles: POST /cpg/roles 403 forbidden', [devRole.status, devRole.json?.code, devRole.json?.details?.permission], [403, 'forbidden', 'rbac.roles.manage']);
  const auditorAudit = await users.auditor.client.get('/api/v1/cpg/audit');
  gate.check('Auditor reads the audit log: GET /cpg/audit 200', auditorAudit.status === 200 && Array.isArray(auditorAudit.json?.items), '200 with items', `${auditorAudit.status}`);
  const devAudit = await users.dev.client.get('/api/v1/cpg/audit');
  gate.equal('Developer cannot read the audit log (403)', devAudit.status, 403);

  // ── 6. the Developer role's legacy grants ───────────────────────────
  const dev = users.dev.client;
  const devPatch = await dev.patch('/api/v1/org', { industry: 'finance' });
  gate.equal('Developer PATCH /org 200 (legacy org.profile.update)', devPatch.status, 200);
  const k1 = await dev.post('/api/v1/org/api-keys', { label: 'cpg gate dev key', scopes: ['read:policies'] });
  gate.equal('Developer creates an org API key: 201 (legacy org.api_keys.manage)', k1.status, 201);
  const developer = (roles.json?.items ?? []).find((r) => r.key === 'developer');
  const cut = await owner.client.patch(`/api/v1/cpg/roles/${developer?.id}`, { permissions: (developer?.permissions ?? []).filter((p) => p !== 'org.api_keys.manage') });
  const k2 = await dev.post('/api/v1/org/api-keys', { label: 'cpg gate dev key 2', scopes: ['read:policies'] });
  gate.equal('after Org Admin removes org.api_keys.manage from Developer: POST /org/api-keys 403', [cut.status, k2.status], [200, 403]);
  const restore = await owner.client.patch(`/api/v1/cpg/roles/${developer?.id}`, { permissions: developer?.permissions ?? [] });
  const k3 = await dev.post('/api/v1/org/api-keys', { label: 'cpg gate dev key 3', scopes: ['read:policies'] });
  gate.equal('after it is restored: POST /org/api-keys 201 again', [restore.status, k3.status], [200, 201]);
  for (const k of [k1, k3]) if (k.json?.id) await dev.del(`/api/v1/org/api-keys/${k.json.id}`);

  // ── 7. last Org Admin ───────────────────────────────────────────────
  const ownerGrant = (policyUsers.json?.items ?? []).find((u) => u.id === owner.id)?.grants.find((g) => g.roleKey === 'org_admin');
  const lastAdmin = await owner.client.post(`/api/v1/cpg/grants/${ownerGrant?.id}/revoke`, { reason: 'gate: try to remove the last Org Admin' });
  gate.equal('revoking the last Org Admin grant: 409 last_org_admin', [lastAdmin.status, lastAdmin.json?.code], [409, 'last_org_admin']);

  // ── 8. VS Code device sign-in: user-bound keys, no cross-user logout ─
  const devSign = await deviceSignIn(ctx, users.dev.client);
  const authorSign = await deviceSignIn(ctx, users.author.client);
  gate.check('device sign-in for dev@ then author@: authorize 302, callback 302 to vscode://, token 200',
    [devSign, authorSign].every((s) => s.authorize === 302 && s.callback === 302 && s.location.startsWith('vscode://nomus.nomus/auth-callback?') && s.token === 200 && /^nk_live_/.test(s.apiKey ?? '')),
    'both flows complete', JSON.stringify([devSign, authorSign].map((s) => ({ ...s, apiKey: s.apiKey ? 'nk_live_…' : null }))));
  const devKeyMe = await api.withKey(devSign.apiKey).get('/api/v1/cpg/me');
  const authorKeyMe = await api.withKey(authorSign.apiKey).get('/api/v1/cpg/me');
  gate.check('both keys stay active after the second sign-in, and each acts as its own user (identity user_key)',
    devKeyMe.status === 200 && devKeyMe.json?.identity === 'user_key' && devKeyMe.json?.user?.email === users.dev.email
      && authorKeyMe.status === 200 && authorKeyMe.json?.identity === 'user_key' && authorKeyMe.json?.user?.email === users.author.email,
    `dev key -> ${users.dev.email}, author key -> ${users.author.email}`,
    `${devKeyMe.status} ${devKeyMe.json?.identity} ${devKeyMe.json?.user?.email}; ${authorKeyMe.status} ${authorKeyMe.json?.identity} ${authorKeyMe.json?.user?.email}`);
  const devScan = await api.withKey(devSign.apiKey).get('/api/v1/policies/hash');
  gate.equal('the user-bound key still reads the corpus (scanning works)', devScan.status, 200);
  const devAgain = await deviceSignIn(ctx, users.dev.client);
  const oldDev = await api.withKey(devSign.apiKey).get('/api/v1/cpg/me');
  const newDev = await api.withKey(devAgain.apiKey).get('/api/v1/cpg/me');
  const authorStill = await api.withKey(authorSign.apiKey).get('/api/v1/cpg/me');
  gate.equal('dev@ signing in again replaces only dev@\'s key (old 401, new 200, author@ still 200)', [oldDev.status, newDev.status, authorStill.status], [401, 200, 200]);

  // ── 9. audit chain ──────────────────────────────────────────────────
  const audit = await users.auditor.client.get('/api/v1/cpg/audit?limit=200');
  const actions = new Set((audit.json?.items ?? []).map((e) => e.action));
  gate.check('GET /cpg/audit: chainValid true, with grant.created and role.permissions_changed events',
    audit.status === 200 && audit.json?.chainValid === true && actions.has('grant.created') && actions.has('role.permissions_changed') && actions.has('user.invited') && actions.has('rbac.migrated'),
    'chainValid true; grant.created, role.permissions_changed, user.invited, rbac.migrated', `${audit.status} chainValid=${audit.json?.chainValid} actions=${[...actions].join(',')}`);
  const seqs = (audit.json?.items ?? []).map((e) => e.seq);
  gate.check('audit events are hash-linked newest first (seq strictly descending, prevHash of each = hash of the next older)',
    seqs.length > 1 && seqs.every((s, i) => i === 0 || seqs[i - 1] === s + 1) && audit.json.items.every((e, i, a) => i === a.length - 1 || e.prevHash === a[i + 1].hash),
    'contiguous chain', JSON.stringify(seqs.slice(0, 10)));
  const settings = await owner.client.get('/api/v1/cpg/settings');
  gate.check(`${expected.cpg.org.slug} stays opt-in: CPG not enabled by any of this`, settings.status === 200 && settings.json?.enabled === false && settings.json?.orgId === orgId,
    'enabled false', `${settings.status} ${JSON.stringify(settings.json)?.slice(0, 160)}`);
}
