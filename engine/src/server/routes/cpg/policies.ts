import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { AppEnv } from '../../app.js';
import { getDb } from '../../../db/client.js';
import { cpgCompileRecords } from '../../../db/schema-cpg.js';
import { compilePolicy, compileRequestSchema } from '../../../cpg/policies/compile.js';
import {
  castVote, getPolicy, getVersion, proposeRetirement, proposeVersion, votesOf, userNames, withdrawVersion,
} from '../../../cpg/policies/service.js';
import { buildPolicyExport, serializeCompileRecord, serializeHeads, serializePolicyDetail } from '../../../cpg/policies/serialize.js';
import { invalidateCorporateBundle } from '../../../cpg/bundle/build.js';
import {
  emptyRequestSchema, listOf, policyHeadResponseSchema, policyListQuerySchema, proposePolicyRequestSchema,
  proposeVersionRequestSchema, retirePolicyRequestSchema, voteRequestSchema, voteResponseSchema,
} from '../../../cpg/contracts.js';
import { CpgError, notFound } from '../../../cpg/errors.js';
import { actorFrom, cpgAuth, handle, parseBody, parseQuery, pathParam, requireEither } from './helpers.js';

/**
 * The corporate policy registry (design spec §8, E29 to E37 and E39):
 * compile, propose, vote (four-eyes), withdraw, retire, read and export the
 * policy log. Writes need a browser session. Compiled output is never
 * activated here; only the configured number of approvals by people other
 * than the author and the compile requester activates a version.
 */
export const cpgPolicyRoutes = new Hono<AppEnv>();

const readable = cpgAuth('policy.read', { scope: 'read:policies', allowUserKey: true });

// E29 compile
cpgPolicyRoutes.post('/compile', ...cpgAuth('policy.author'), handle(async (c) => {
  const request = await parseBody(c, compileRequestSchema);
  const actor = actorFrom(c);
  const db = getDb();
  if (request.policyId) getPolicy(db, actor.orgId, request.policyId);
  const record = await compilePolicy(db, { orgId: actor.orgId, actor: `user:${actor.userId}`, request });
  return c.json(serializeCompileRecord(record), 201);
}));

// E30
cpgPolicyRoutes.get('/compile/:id', ...cpgAuth(null), handle((c) => {
  const actor = actorFrom(c);
  requireEither(actor, 'policy.author', 'policy.approve');
  const record = getDb().select().from(cpgCompileRecords)
    .where(and(eq(cpgCompileRecords.id, pathParam(c, 'id')), eq(cpgCompileRecords.orgId, actor.orgId))).get();
  if (!record) throw notFound('Compile record');
  return c.json(serializeCompileRecord(record));
}));

// E39 export (registered before /policies/:id)
cpgPolicyRoutes.get('/policies/export', ...cpgAuth('audit.export'), handle((c) => {
  const format = c.req.query('format') ?? 'json';
  if (format !== 'json') throw new CpgError(400, 'invalid_input', 'format must be json', [{ path: ['format'], message: 'only json is supported' }]);
  return c.json(buildPolicyExport(getDb(), actorFrom(c).orgId));
}));

// E31
cpgPolicyRoutes.get('/policies', ...readable, handle((c) => {
  const { state } = parseQuery(c, policyListQuerySchema);
  return c.json(listOf(policyHeadResponseSchema).parse({ items: serializeHeads(getDb(), actorFrom(c).orgId, state) }));
}));

// E32 propose a new policy
cpgPolicyRoutes.post('/policies', ...cpgAuth('policy.author'), handle(async (c) => {
  const body = await parseBody(c, proposePolicyRequestSchema);
  const actor = actorFrom(c);
  const db = getDb();
  const { policyId } = await proposeVersion(db, { orgId: actor.orgId, actorUserId: actor.userId, ...body });
  return c.json(serializePolicyDetail(db, actor.orgId, policyId), 201);
}));

// E33
cpgPolicyRoutes.get('/policies/:id', ...readable, handle((c) =>
  c.json(serializePolicyDetail(getDb(), actorFrom(c).orgId, pathParam(c, 'id')))));

// E34 propose a new version
cpgPolicyRoutes.post('/policies/:id/versions', ...cpgAuth('policy.author'), handle(async (c) => {
  const body = await parseBody(c, proposeVersionRequestSchema);
  const actor = actorFrom(c);
  const db = getDb();
  const policyId = pathParam(c, 'id');
  getPolicy(db, actor.orgId, policyId);
  await proposeVersion(db, { orgId: actor.orgId, actorUserId: actor.userId, policyId, ...body });
  return c.json(serializePolicyDetail(db, actor.orgId, policyId), 201);
}));

// E35 propose retirement
cpgPolicyRoutes.post('/policies/:id/retire', ...cpgAuth('policy.author'), handle(async (c) => {
  const body = await parseBody(c, retirePolicyRequestSchema);
  const actor = actorFrom(c);
  const db = getDb();
  const policyId = pathParam(c, 'id');
  proposeRetirement(db, { orgId: actor.orgId, actorUserId: actor.userId, policyId, reason: body.reason });
  return c.json(serializePolicyDetail(db, actor.orgId, policyId), 201);
}));

// E36 vote
cpgPolicyRoutes.post('/policy-versions/:id/votes', ...cpgAuth('policy.approve'), handle(async (c) => {
  const body = await parseBody(c, voteRequestSchema);
  const actor = actorFrom(c);
  const db = getDb();
  const versionId = pathParam(c, 'id');
  const result = castVote(db, { orgId: actor.orgId, voterUserId: actor.userId, versionId, vote: body.vote, comment: body.comment ?? '' });
  if (result.voteId === null) throw new CpgError(409, 'proposal_not_pending', 'The proposal has lapsed and is now expired', { reason: 'lapsed' });
  if (result.effect.bundleChanged) invalidateCorporateBundle(actor.orgId, result.status === 'retired' ? 'policy_retired' : 'policy_activated');
  const vote = votesOf(db, [versionId]).find((v) => v.id === result.voteId)!;
  return c.json(voteResponseSchema.parse({
    vote: {
      id: vote.id, versionId, voterUserId: vote.voterUserId, voterName: userNames(db, [vote.voterUserId]).get(vote.voterUserId) ?? '',
      vote: vote.vote, comment: vote.comment, quorumConfigVersion: vote.quorumConfigVersion, createdAt: vote.createdAt,
    },
    versionState: result.status,
  }), 201);
}));

// E37 withdraw (the author only)
cpgPolicyRoutes.post('/policy-versions/:id/withdraw', ...cpgAuth(null), handle(async (c) => {
  await parseBody(c, emptyRequestSchema);
  const actor = actorFrom(c);
  const db = getDb();
  getVersion(db, actor.orgId, pathParam(c, 'id'));
  const { policyId } = withdrawVersion(db, { orgId: actor.orgId, actorUserId: actor.userId, versionId: pathParam(c, 'id') });
  return c.json(serializePolicyDetail(db, actor.orgId, policyId));
}));
