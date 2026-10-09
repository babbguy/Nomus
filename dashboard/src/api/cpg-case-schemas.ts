import { z } from 'zod';
import { tierSchema } from './cpg-schemas';

/**
 * Response contracts of the review-case API (/api/v1/cpg/cases, E41 to
 * E52), mirroring engine/src/cpg/contracts.ts and the shared case status of
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
  viewer: z.object({ comment: z.boolean(), review: z.boolean(), close: z.boolean(), withdraw: z.boolean() }).strict(),
  revisions: z.array(revisionSummarySchema),
  justifications: z.array(justificationSchema),
  comments: z.array(caseCommentSchema),
}).strict();

export const caseFindingSchema = z.object({
  id: uuid, fingerprint, policyId: uuid, policyKey: z.string(), policyTitle: z.string(), policyVersion: z.number().int(),
  tier: tierSchema, blocking: z.boolean(), owningBoardIds: z.array(uuid), statusAtRevision: z.enum(['new', 'carried']),
  filePath: z.string(), startLine: z.number().int(), endLine: z.number().int(), language: z.string().nullable(),
  snippet: z.string(), justification: justificationSchema.nullable(),
}).strict();

export const revisionDetailSchema = z.object({ revision: revisionSummarySchema, findings: z.array(caseFindingSchema) }).strict();

export const reviewerContextSchema = z.object({
  findingId: uuid, status: z.enum(['disabled', 'generated', 'failed']), label: z.string().nullable(),
  whatItDoes: z.string().nullable(), whyFlagged: z.string().nullable(), provider: z.string().nullable(), model: z.string().nullable(),
  promptVersion: z.number().int(), attempt: z.number().int().nullable(), error: z.string().nullable(), createdAt: isoDate.nullable(),
}).strict();

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
