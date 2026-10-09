import { z } from 'zod';
import { tierSchema } from './cpg-schemas';

/**
 * Response contracts of the review-case and approvals API (/api/v1/cpg/cases,
 * /proposals, /decisions and /exceptions, E41 to E60), mirroring engine/src/cpg/contracts.ts and the shared case status of
 * @nomus/scanner/corporate. Strict like cpg-schemas.ts, and zod-only so the
 * engine's route tests can parse real responses with it.
 */

const uuid = z.string().uuid();
const isoDate = z.string().datetime();
const fingerprint = z.string().regex(/^[0-9a-f]{64}:corp\.[a-z0-9][a-z0-9._-]{0,84}:[1-9][0-9]{0,6}$/);

export const caseStateSchema = z.enum(['open', 'in_review', 'changes_requested', 'decided', 'closed']);
export const laneStateSchema = z.enum(['needs_review', 'changes_requested', 'decided']);
export const resolutionStatusSchema = z.enum(['advisory', 'grace', 'approved', 'excepted', 'rejected', 'expired', 'pending', 'changes_requested', 'needs_review']);

export const caseLaneSchema = z.object({
  boardId: uuid, boardName: z.string(), state: laneStateSchema, blocking: z.number().int(), decided: z.number().int(),
}).strict();

/** `user:<id>` or `system:<what>`, with the user's name when it is a user. */
export const actorRefSchema = z.object({ actor: z.string(), name: z.string().nullable() }).strict();

export const caseSummarySchema = z.object({
  id: uuid, ref: z.string(), repo: z.string(), branch: z.string(), prNumber: z.number().int().nullable(),
  state: caseStateSchema, closeReason: z.string().nullable(), latestRevision: z.number().int(),
  openedAt: isoDate, updatedAt: isoDate, closedAt: isoDate.nullable(),
  openedBy: actorRefSchema, lanes: z.array(caseLaneSchema),
}).strict();

export const caseListSchema = z.object({ items: z.array(caseSummarySchema), nextCursor: z.string().nullable() }).strict();

export const findingResolutionSchema = z.object({
  fingerprint, status: resolutionStatusSchema, blocking: z.boolean(), tier: tierSchema, enforceFrom: isoDate.nullable(),
  decisionId: uuid.nullable(), exceptionDecisionId: uuid.nullable(), expiresAt: isoDate.nullable(),
}).strict();

export const caseStatusSchema = z.object({
  id: uuid, ref: z.string(), repo: z.string(), branch: z.string(), prNumber: z.number().int().nullable(),
  state: caseStateSchema, closeReason: z.string().nullable(), latestRevision: z.number().int(), url: z.string().url(),
  lanes: z.array(caseLaneSchema),
  openChangeRequests: z.array(z.object({
    commentId: uuid, boardName: z.string(), authorName: z.string(), body: z.string(), fingerprints: z.array(fingerprint), createdAt: isoDate,
  }).strict()),
  resolutions: z.array(findingResolutionSchema),
  updatedAt: isoDate,
}).strict();

export const justificationSchema = z.object({
  id: uuid, fingerprint, authorUserId: uuid, authorName: z.string(), body: z.string(), createdAt: isoDate,
}).strict();

export const caseCommentSchema = z.object({
  id: uuid, threadId: uuid, parentId: uuid.nullable(), kind: z.enum(['comment', 'change_request', 'reply']), boardId: uuid.nullable(),
  fingerprints: z.array(fingerprint), authorUserId: uuid, authorName: z.string(), body: z.string(), createdAt: isoDate,
}).strict();

export const revisionSummarySchema = z.object({
  revision: z.number().int().min(1), source: z.enum(['vscode', 'ci', 'dashboard']), headSha: z.string().nullable(),
  findingsDigest: z.string().regex(/^[0-9a-f]{64}$/), addedCount: z.number().int(), carriedCount: z.number().int(),
  resolvedCount: z.number().int(), createdAt: isoDate,
}).strict();

export const caseClosureSchema = z.object({
  reason: z.string(), note: z.string().nullable(), closedAt: isoDate, closedBy: actorRefSchema,
  record: z.record(z.unknown()), signature: z.string(), signatureValid: z.boolean(),
}).strict();

export const caseDetailSchema = z.object({
  case: caseStatusSchema,
  openedAt: isoDate,
  openedBy: actorRefSchema,
  closure: caseClosureSchema.nullable(),
  viewer: z.object({
    comment: z.boolean(), review: z.boolean(), close: z.boolean(), withdraw: z.boolean(), revoke: z.boolean(), selfApproval: z.boolean(),
  }).strict(),
  revisions: z.array(revisionSummarySchema),
  justifications: z.array(justificationSchema),
  comments: z.array(caseCommentSchema),
}).strict();

export const caseFindingSchema = z.object({
  id: uuid, fingerprint, policyId: uuid, policyKey: z.string(), policyTitle: z.string(), policyVersion: z.number().int(),
  tier: tierSchema, blocking: z.boolean(), owningBoardIds: z.array(uuid), statusAtRevision: z.enum(['new', 'carried']),
  filePath: z.string(), startLine: z.number().int(), endLine: z.number().int(), language: z.string().nullable(),
  snippet: z.string(), justification: justificationSchema.nullable(), contextStatus: z.enum(['none', 'generated', 'failed']),
}).strict();

export const revisionDetailSchema = z.object({ revision: revisionSummarySchema, findings: z.array(caseFindingSchema) }).strict();

export const reviewerContextSchema = z.object({
  findingId: uuid, status: z.enum(['disabled', 'generated', 'failed']), label: z.string().nullable(),
  whatItDoes: z.string().nullable(), whyFlagged: z.string().nullable(), provider: z.string().nullable(), model: z.string().nullable(),
  promptVersion: z.number().int(), attempt: z.number().int().nullable(), error: z.string().nullable(), createdAt: isoDate.nullable(),
}).strict();

// ─── Proposals, votes, decisions and standing exceptions (E54 to E60) ───

export const LANGUAGES = ['typescript', 'javascript', 'python', 'java', 'go', 'other'] as const;
const outcomeSchema = z.enum(['approve', 'reject']);
const scopeSchema = z.enum(['snippet', 'bulk', 'standing']);
export const proposalStatusSchema = z.enum(['pending', 'finalized', 'vetoed', 'invalidated', 'void', 'lapsed']);

export const standingPatternSchema = z.object({
  repos: z.array(z.string()), teamIds: z.array(uuid), paths: z.array(z.string()), excludePaths: z.array(z.string()),
  policyKey: z.string(), policyVersion: z.number().int(),
  conditions: z.object({
    branches: z.array(z.string()).optional(), languages: z.array(z.enum(LANGUAGES)).optional(),
    snippetMustMatch: z.object({ source: z.string(), flags: z.enum(['', 'i']) }).strict().optional(), maxLinesPerFinding: z.number().int().optional(),
  }).strict(),
}).strict();

export const proposalVoteSchema = z.object({
  id: uuid, voterUserId: uuid, voterName: z.string(), vote: outcomeSchema, boards: z.array(uuid), permissions: z.array(z.string()), comment: z.string(), createdAt: isoDate,
}).strict();

export const proposalSchema = z.object({
  id: uuid, caseId: uuid.nullable(), scope: scopeSchema, outcome: outcomeSchema, status: proposalStatusSchema,
  policyId: uuid, policyKey: z.string(), policyVersion: z.number().int(), tier: tierSchema,
  fingerprints: z.array(fingerprint), pattern: standingPatternSchema.nullable(), requestedExpiresAt: isoDate.nullable(), rationale: z.string(),
  required: z.object({
    approvals: z.number().int(), boardCoverage: z.enum(['all_owning', 'any_owning']), boardIds: z.array(uuid),
    requiredPermission: z.enum(['exception.approve']).nullable(), maxExpiryDays: z.number().int(), defaultExpiryDays: z.number().int(),
  }).strict(),
  quorumConfigVersionAtCreation: z.number().int(),
  proposer: z.object({ userId: uuid, name: z.string() }).strict(),
  createdAt: isoDate, lapsesAt: isoDate,
  votes: z.array(proposalVoteSchema), decisionIds: z.array(uuid),
  invalidation: z.object({ reason: z.string(), at: isoDate }).strict().nullable(),
  revocations: z.array(z.object({ decisionId: uuid, revokedByName: z.string(), reason: z.string(), revokedAt: isoDate }).strict()),
  viewer: z.object({ canVote: z.boolean(), reason: z.string().nullable() }).strict(),
}).strict();

export const proposalListSchema = z.object({ items: z.array(proposalSchema) }).strict();

export const castVoteSchema = z.object({ vote: proposalVoteSchema, proposalStatus: proposalStatusSchema, decisionIds: z.array(uuid) }).strict();

export const decisionSchema = z.object({
  id: uuid, proposalId: uuid, caseId: uuid.nullable(), scope: scopeSchema, outcome: outcomeSchema,
  repo: z.string().nullable(), fingerprint: fingerprint.nullable(), batchId: uuid.nullable(),
  policyId: uuid, policyKey: z.string(), policyVersion: z.number().int(), expiresAt: isoDate.nullable(),
  approverUserIds: z.array(uuid), quorumConfigVersion: z.number().int(), quorumConfigHash: z.string(), finalizedAt: isoDate,
  signedPayload: z.string(), signature: z.string(), signatureValid: z.boolean(),
}).strict();

export const revocationSchema = z.object({
  id: uuid, decisionId: uuid, revokedByUserId: uuid, reason: z.string(), revokedAt: isoDate, signedPayload: z.string(), signature: z.string(),
}).strict();

export const standingExceptionSchema = z.object({
  id: uuid, proposalId: uuid, caseId: uuid.nullable(), policyId: uuid, policyKey: z.string(), policyVersion: z.number().int(),
  pattern: standingPatternSchema, expiresAt: isoDate, finalizedAt: isoDate, approverUserIds: z.array(uuid),
  status: z.enum(['active', 'expired', 'revoked', 'lapsed']), revocation: revocationSchema.nullable(),
}).strict();

export const standingExceptionListSchema = z.object({ items: z.array(standingExceptionSchema) }).strict();

export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type StandingPattern = z.infer<typeof standingPatternSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type CastVote = z.infer<typeof castVoteSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type StandingException = z.infer<typeof standingExceptionSchema>;

export type CaseState = z.infer<typeof caseStateSchema>;
export type LaneState = z.infer<typeof laneStateSchema>;
export type ResolutionStatus = z.infer<typeof resolutionStatusSchema>;
export type FindingResolution = z.infer<typeof findingResolutionSchema>;
export type CaseLane = z.infer<typeof caseLaneSchema>;
export type ActorRef = z.infer<typeof actorRefSchema>;
export type CaseSummary = z.infer<typeof caseSummarySchema>;
export type CaseList = z.infer<typeof caseListSchema>;
export type CaseDetail = z.infer<typeof caseDetailSchema>;
export type CaseComment = z.infer<typeof caseCommentSchema>;
export type RevisionSummary = z.infer<typeof revisionSummarySchema>;
export type CaseFinding = z.infer<typeof caseFindingSchema>;
export type RevisionDetail = z.infer<typeof revisionDetailSchema>;
export type ReviewerContext = z.infer<typeof reviewerContextSchema>;
