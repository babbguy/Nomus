// 6. Evaluate -> attestation -> verify. /evaluate and /simulate must agree
// on which rules apply; attestations go through supersede, revoke and expiry;
// the evidence export verifies offline with a standard Ed25519 library
// against the published key; tampered bundles are rejected.

import crypto from 'node:crypto';
import { sleep } from '../lib/http.mjs';

export async function attestationChecks(ctx) {
  const { gate } = ctx;
  const member = ctx.data.orgKey;
  const anon = ctx.data.api.anonymous();

  // ── /evaluate and /simulate agree on applicability ──
  const vocab = (await member.get('/api/v1/simulate/vocabulary')).json;
  const caps = vocab?.capabilities ?? [];
  gate.check('simulate vocabulary lists the rule capabilities', caps.length > 10, '> 10 capabilities', caps.length);
  const disagreements = [];
  let compared = 0;
  for (const market of ['EU', 'US-FED']) {
    for (const sector of [undefined, 'healthcare']) {
      for (const cap of caps) {
        const ev = await ctx.data.adminKey.post('/api/v1/evaluate', { action: cap, jurisdiction: market, context: { region: market, ...(sector ? { sector } : {}) } });
        const sim = await member.post('/api/v1/simulate', { capabilities: [cap], targetMarkets: [market], ...(sector ? { sector } : {}) });
        if (ev.status !== 200 || sim.status !== 200) { disagreements.push(`${cap}/${market}/${sector ?? '-'}: HTTP ${ev.status}/${sim.status}`); continue; }
        compared++;
        const a = (ev.json.rulesEvaluated ?? []).filter((r) => r.matched).map((r) => r.ruleKey).sort();
        const b = (sim.json.markets?.[market]?.rules ?? []).map((r) => r.ruleKey).sort();
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          const onlyEv = a.filter((k) => !b.includes(k));
          const onlySim = b.filter((k) => !a.includes(k));
          disagreements.push(`${cap} in ${market}${sector ? ` (${sector})` : ''}: evaluate-only [${onlyEv.join(', ')}] simulate-only [${onlySim.join(', ')}]`);
        }
      }
    }
  }
  gate.check(`/evaluate and /simulate match the same rules (${compared} capability x market x sector cases)`, disagreements.length === 0 && compared > 0,
    'identical rule sets', disagreements.length ? `${disagreements.length} differ, e.g. ${disagreements.slice(0, 3).join(' | ')}` : `${compared} compared`);
  const phi = await member.post('/api/v1/evaluate', { action: 'phi_in_ai_call', jurisdiction: 'US-FED', context: { sector: 'healthcare' } });
  gate.check('PHI sent to an AI model under US-FED is never signed "compliant"', phi.json?.result && phi.json.result !== 'compliant', 'non_compliant or requires_review', `${phi.json?.result} (${(phi.json?.rulesEvaluated ?? []).filter((r) => r.matched).length} rules matched)`);

  // ── Lifecycle ──
  const evalCtx = { action: 'ai_user_interaction', jurisdiction: 'EU', context: { region: 'EU' } };
  const a1 = await member.post('/api/v1/evaluate', evalCtx);
  gate.check('evaluate returns a signed attestation', a1.status === 200 && /^[0-9a-f-]{36}$/.test(a1.json?.id ?? '') && !!a1.json?.signature && a1.json?.result === 'requires_review',
    '200, id, signature, result requires_review (Art. 50 disclosure)', `${a1.status} ${a1.json?.result}`);
  const id1 = a1.json?.id;
  if (!id1) return;
  const v1 = await member.get(`/api/v1/attestations/${id1}/verify`);
  gate.check('authenticated verify: signature valid, status valid', v1.json?.signatureValid === true && v1.json?.status === 'valid', 'true / valid', `${v1.json?.signatureValid} / ${v1.json?.status}`);
  const p1 = await anon.get(`/api/v1/verify/${id1}`);
  gate.check('public verify (no auth): signature valid, status valid, no org data', p1.status === 200 && p1.json?.signatureValid === true && p1.json?.status === 'valid' && !('actionContext' in (p1.json ?? {})) && p1.json?.orgDisplayName === null,
    '200, valid, actionContext withheld, org name private', `${p1.status} ${p1.json?.signatureValid} ${p1.json?.status} org=${p1.json?.orgDisplayName}`);

  const sup = await member.post('/api/v1/evaluate', { ...evalCtx, supersedes: id1 });
  const id2 = sup.json?.id;
  gate.check('evaluate with supersedes creates a replacement', sup.status === 200 && sup.json?.supersedes === id1, `supersedes ${id1}`, `${sup.status} ${sup.json?.supersedes}`);
  const p1b = await anon.get(`/api/v1/verify/${id1}`);
  gate.check('superseded attestation: public status superseded, still signature-valid', p1b.json?.status === 'superseded' && p1b.json?.supersededBy === id2 && p1b.json?.signatureValid === true,
    `superseded by ${id2}`, `${p1b.json?.status} by ${p1b.json?.supersededBy}`);
  const sup2 = await member.post('/api/v1/evaluate', { ...evalCtx, supersedes: id1 });
  gate.equal('an attestation cannot be superseded twice', sup2.status, 409);

  const rev = await member.post(`/api/v1/attestations/${id2}/revoke`, { reason: 'Release gate: system retired' });
  gate.check('revoke an attestation', rev.status === 200 && rev.json?.status === 'revoked' && rev.json?.alreadyRevoked === false, 'revoked', `${rev.status} ${JSON.stringify(rev.json)?.slice(0, 120)}`);
  const rev2 = await member.post(`/api/v1/attestations/${id2}/revoke`, { reason: 'a different reason' });
  gate.check('revoking again keeps the original revocation', rev2.json?.alreadyRevoked === true && rev2.json?.revokedAt === rev.json?.revokedAt && rev2.json?.revocationReason === 'Release gate: system retired',
    'alreadyRevoked, same time and reason', JSON.stringify(rev2.json)?.slice(0, 160));
  const p2 = await anon.get(`/api/v1/verify/${id2}`);
  gate.check('revoked attestation: public status revoked with reason', p2.json?.status === 'revoked' && p2.json?.revocationReason === 'Release gate: system retired', 'revoked + reason', `${p2.json?.status} ${p2.json?.revocationReason}`);
  const crossOrg = await ctx.data.adminKey.post(`/api/v1/attestations/${id1}/revoke`, { reason: 'another organization' });
  gate.equal('another organization cannot revoke it', crossOrg.status, 403);

  const past = await member.post('/api/v1/evaluate', { ...evalCtx, expiresAt: '2020-01-01T00:00:00Z' });
  gate.equal('an expiry in the past is rejected', past.status, 400);
  const soon = new Date(Date.now() + 4000).toISOString();
  const ex = await member.post('/api/v1/evaluate', { ...evalCtx, expiresAt: soon });
  const id3 = ex.json?.id;
  const p3a = await anon.get(`/api/v1/verify/${id3}`);
  gate.check('attestation with a future expiry is valid until then', p3a.json?.status === 'valid' && p3a.json?.expiresAt === soon, `valid, expiresAt ${soon}`, `${p3a.json?.status} ${p3a.json?.expiresAt}`);
  await sleep(Math.max(0, Date.parse(soon) - Date.now()) + 1200);
  const p3b = await anon.get(`/api/v1/verify/${id3}`);
  gate.check('after its expiry it verifies as expired', p3b.json?.status === 'expired' && p3b.json?.signatureValid === true, 'expired, signature still valid', `${p3b.json?.status} ${p3b.json?.signatureValid}`);

  gate.equal('public verify of an unknown id is 404', (await anon.get(`/api/v1/verify/${crypto.randomUUID()}`)).status, 404);
  const malformed = await anon.get('/api/v1/verify/not-a-uuid');
  gate.check('public verify of a malformed id is a 4xx, not a 5xx', malformed.status >= 400 && malformed.status < 500, '4xx', malformed.status);

  // ── Evidence export, offline verification, tampering ──
  const wk = (await anon.get('/.well-known/nomus-keys')).json;
  const jwk = wk?.keys?.[0];
  let jwkKey = null;
  try { jwkKey = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' }); } catch { /* reported below */ }
  gate.check('the published key is a standard Ed25519 JWK (RFC 8037) that crypto libraries import', !!jwkKey, 'createPublicKey({format: "jwk"}) succeeds', `x is ${jwk?.x?.length} chars: ${String(jwk?.x).slice(0, 24)}…`);

  const exp = await member.get(`/api/v1/attestations/${id1}/export?format=json`);
  const bundle = exp.json;
  gate.check('evidence export (JSON) downloads a bundle', exp.status === 200 && bundle?.bundleType === 'nomus-attestation-evidence' && /attachment/.test(exp.headers.get('content-disposition') ?? ''),
    '200 attachment nomus-attestation-evidence', `${exp.status} ${bundle?.bundleType}`);
  if (!bundle) return;
  const published = jwkKey ?? spkiKey(jwk?.x);
  const record = (await anon.get(`/api/v1/verify/${id1}`)).json;
  const verdict = verifyBundle(bundle, published, record);
  gate.check('the export verifies offline (Ed25519 over the canonical payload, published key, public record)', verdict.ok, 'valid', verdict.reasons);
  gate.equal('the export reports the current lifecycle status', bundle.attestation.status, 'superseded');

  const tampered = {
    'result changed in the bundle only': (b) => { b.attestation.result = 'compliant'; },
    'result changed in the bundle and the signed payload': (b) => {
      b.attestation.result = 'compliant';
      b.verification.signedPayloadCanonicalJson = b.verification.signedPayloadCanonicalJson.replace(/"result":"[a-z_]+"/, '"result":"compliant"');
    },
    'signature altered': (b) => {
      const s = Buffer.from(b.verification.signature, 'base64'); s[5] ^= 0xff;
      b.verification.signature = s.toString('base64'); b.attestation.signature = b.verification.signature;
    },
    're-signed with another key': (b) => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      b.attestation.result = 'compliant';
      b.verification.signedPayloadCanonicalJson = b.verification.signedPayloadCanonicalJson.replace(/"result":"[a-z_]+"/, '"result":"compliant"');
      b.verification.signature = crypto.sign(null, Buffer.from(b.verification.signedPayloadCanonicalJson), privateKey).toString('base64');
      b.attestation.signature = b.verification.signature;
      b.verification.publicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    },
    'evaluation time moved': (b) => {
      b.attestation.evaluatedAt = '2020-01-01T00:00:00.000Z';
      b.verification.signedPayloadCanonicalJson = b.verification.signedPayloadCanonicalJson.replace(/"evaluatedAt":"[^"]+"/, '"evaluatedAt":"2020-01-01T00:00:00.000Z"');
    },
  };
  for (const [name, mutate] of Object.entries(tampered)) {
    const b = structuredClone(bundle);
    mutate(b);
    const v = verifyBundle(b, published, record);
    gate.check(`a tampered bundle is rejected: ${name}`, !v.ok, 'rejected', v.ok ? 'accepted' : v.reasons[0]);
  }
  const forged = structuredClone(bundle);
  forged.attestation.id = crypto.randomUUID();
  gate.equal('a bundle for an attestation the instance never issued has no public record (404)', (await anon.get(`/api/v1/verify/${forged.attestation.id}`)).status, 404);

  const html = await member.get(`/api/v1/attestations/${id1}/export?format=html`);
  gate.check('evidence export (HTML) renders the attestation', html.status === 200 && /text\/html/.test(html.headers.get('content-type') ?? '') && html.text.includes(id1) && !/undefined|NaN/.test(html.text),
    '200 text/html with the id', `${html.status} ${html.headers.get('content-type')}`);

  const list = await member.get('/api/v1/attestations?limit=5');
  ctx.data.attestationTotal = list.json?.total;
  gate.check('attestation list reports the organization total', Number.isInteger(list.json?.total) && list.json.total >= 4, '>= 4', list.json?.total);
}

function spkiKey(b64) {
  try { return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' }); } catch { return null; }
}

/**
 * Independent verification, following the bundle's own instructions:
 * the embedded key must be the published key, the Ed25519 signature must
 * verify over the signed payload, the payload must describe this bundle,
 * and the public record must agree.
 */
export function verifyBundle(b, publishedKey, record) {
  const reasons = [];
  const v = b?.verification ?? {};
  const a = b?.attestation ?? {};
  const embedded = spkiKey(v.publicKey);
  if (!embedded || !publishedKey) reasons.push('public key unreadable');
  else if (!embedded.export({ format: 'der', type: 'spki' }).equals(publishedKey.export({ format: 'der', type: 'spki' }))) reasons.push('embedded key is not the instance\'s published key');
  let sigOk = false;
  try { sigOk = crypto.verify(null, Buffer.from(String(v.signedPayloadCanonicalJson), 'utf8'), publishedKey, Buffer.from(String(v.signature), 'base64')); } catch { /* false */ }
  if (!sigOk) reasons.push('signature does not verify under the published key');
  let payload = null;
  try { payload = JSON.parse(v.signedPayloadCanonicalJson); } catch { reasons.push('signed payload is not JSON'); }
  if (payload) {
    for (const k of ['id', 'orgId', 'result', 'jurisdiction', 'policyStateHash', 'evaluatedAt']) {
      if (payload[k] !== a[k]) reasons.push(`bundle ${k} differs from the signed payload`);
    }
    if (JSON.stringify(payload.actionContext) !== JSON.stringify(a.actionContext)) reasons.push('bundle actionContext differs from the signed payload');
  }
  if (a.signature !== v.signature) reasons.push('attestation and verification signatures differ');
  if (!record || record.attestationId !== a.id) reasons.push('no public record for this attestation');
  else {
    if (record.subject?.result !== a.result) reasons.push('public record result differs');
    if (record.attestedAt !== a.evaluatedAt) reasons.push('public record time differs');
    if (record.ruleContext?.stateHash !== a.policyStateHash) reasons.push('public record corpus hash differs');
    if (record.signatureValid !== true) reasons.push('public record signature invalid');
  }
  return { ok: reasons.length === 0, reasons };
}
