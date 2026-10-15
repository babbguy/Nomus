// Shared setup for the Corporate Policy Governance (CPG) gate areas.
//
// Runs once, before the first selected cpg-* area, against a SECOND org so no
// existing gate expectation changes: the platform admin creates "Gate Policy
// Org" (gate-policy) and invites its owner; the owner (the org's first
// member, so Org Admin) invites the seven governance users with the CPG
// invite endpoint. Every one of them signs in with the temporary password
// and must change it before any /api/v1/cpg call works; what the API
// answered before and after is recorded in ctx.data.cpg.passwordGate for the
// cpg-rbac area to assert.

import crypto from 'node:crypto';
import { sleep } from '../lib/http.mjs';

/**
 * Sign in. The engine allows 10 sign-ins per minute per address and every
 * gate client shares 127.0.0.1, so on a 429 wait for the window to reset
 * (at most once) instead of failing or spoofing the client address.
 */
export async function signIn(ctx, email, password) {
  const { api } = ctx.data;
  let res = await api.login(email, password);
  for (let i = 0; i < 14 && res.status === 429; i++) {
    if (i === 0) ctx.gate.note(`sign-in rate limit reached (10 per minute per address); waiting for the window to reset before signing in ${email}`);
    await sleep(5_000);
    res = await api.login(email, password);
  }
  return res;
}

const newPassword = () => `Gate-${crypto.randomBytes(9).toString('base64url')}-Cpg!`;

/**
 * Sign in with a temporary password, record what /cpg/me and /cpg/settings
 * answer before and after the forced change, and return the signed-in client.
 */
async function firstSignIn(ctx, email, tempPassword) {
  const first = await signIn(ctx, email, tempPassword);
  if (!first.client) return { ok: false, observed: `sign-in ${first.status} ${JSON.stringify(first.json)?.slice(0, 120)}` };
  const meBefore = await first.client.get('/api/v1/cpg/me');
  const settingsBefore = await first.client.get('/api/v1/cpg/settings');
  const password = newPassword();
  const change = await first.client.post('/api/v1/auth/force-change-password', { password });
  const meAfter = await first.client.get('/api/v1/cpg/me');
  return {
    ok: change.status === 200 && meAfter.status === 200,
    client: first.client,
    password,
    userId: meAfter.json?.user?.id ?? null,
    mustChangeAtSignIn: first.json?.user?.mustChangePassword === true,
    before: { me: [meBefore.status, meBefore.json?.code], settings: [settingsBefore.status, settingsBefore.json?.code] },
    after: { me: meAfter.status },
    observed: `change ${change.status}, /cpg/me after ${meAfter.status}`,
  };
}

/** Create the CPG org and users once. Returns false when the areas cannot run. */
export async function cpgSetup(ctx) {
  if (ctx.data.cpg) return true;
  const { gate, expected } = ctx;
  const { admin, adminKey } = ctx.data;
  const cfg = expected.cpg;
  gate.section('cpg-setup');

  const org = await adminKey.post('/api/v1/tenants', { name: cfg.org.name, slug: cfg.org.slug });
  if (!gate.equal(`platform admin creates the CPG org (${cfg.org.slug})`, org.status, 201)) return false;
  const orgId = org.json.id;

  const ownerInvite = await admin.post('/api/v1/users', { email: cfg.org.ownerEmail, name: 'Gate Policy Owner', orgId, role: 'member' });
  if (!gate.check('platform admin invites the org owner with a temporary password', ownerInvite.status === 201 && typeof ownerInvite.json?.tempPassword === 'string',
    '201 with tempPassword', `${ownerInvite.status} ${JSON.stringify(ownerInvite.json)?.slice(0, 160)}`)) return false;
  const ownerSignIn = await firstSignIn(ctx, cfg.org.ownerEmail, ownerInvite.json.tempPassword);
  if (!gate.check('owner signs in, changes the temporary password and reaches /cpg/me', ownerSignIn.ok, 'password changed, /cpg/me 200', ownerSignIn.observed)) return false;

  const owner = { email: cfg.org.ownerEmail, id: ownerInvite.json.id, client: ownerSignIn.client, password: ownerSignIn.password };
  const passwordGate = { owner: { ...ownerSignIn, client: undefined } };
  const users = {};
  for (const [handle, u] of Object.entries(cfg.users)) {
    const invite = await owner.client.post('/api/v1/cpg/users', { email: u.email, name: `Gate ${handle}` });
    if (!gate.check(`Org Admin invites ${u.email} (POST /cpg/users)`, invite.status === 201 && typeof invite.json?.tempPassword === 'string' && invite.json?.user?.mustChangePassword === true,
      '201, tempPassword, mustChangePassword true', `${invite.status} ${JSON.stringify(invite.json)?.slice(0, 160)}`)) return false;
    const s = await firstSignIn(ctx, u.email, invite.json.tempPassword);
    if (!gate.check(`${u.email} changes the temporary password and reaches /cpg/me`, s.ok, 'password changed, /cpg/me 200', s.observed)) return false;
    users[handle] = { email: u.email, id: invite.json.user.id, client: s.client, password: s.password, role: u.role };
    passwordGate[handle] = { ...s, client: undefined };
  }

  ctx.data.cpg = { orgId, owner, users, passwordGate };
  return true;
}
