import { z } from 'zod';
import { isoDate, uuid } from './cpg-schemas';


export const CPG_EVENTS = [
  'case.review_requested', 'case.changes_requested', 'case.replied', 'decision.recorded', 'case.closed',
  'exception.expiring', 'exception.expired', 'integration.test',
] as const;
export type CpgEvent = (typeof CPG_EVENTS)[number];
export type IntegrationKind = 'email' | 'jira' | 'webhook';

/** A configured integration (E64 to E67). Secrets arrive only as their last 4 characters. */
export const integrationSchema = z.object({
  id: uuid,
  kind: z.enum(['email', 'jira', 'webhook']),
  name: z.string(),
  boardIds: z.array(uuid),
  events: z.array(z.enum(CPG_EVENTS)),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  secretLast4: z.string().nullable(),
  createdBy: z.string(), createdAt: isoDate,
  updatedBy: z.string(), updatedAt: isoDate,
}).strict();
export type Integration = z.infer<typeof integrationSchema>;

/** Create and rotate answer with the integration and, for a webhook only, its new signing secret. */
export const integrationWithSecretSchema = z.object({ integration: integrationSchema, secret: z.string().optional() }).strict();
export type IntegrationWithSecret = z.infer<typeof integrationWithSecretSchema>;

export const deliverySchema = z.object({
  id: uuid,
  integrationId: uuid,
  channel: z.enum(['email', 'jira', 'webhook']),
  event: z.enum(CPG_EVENTS),
  caseId: uuid.nullable(),
  boardId: uuid.nullable(),
  payload: z.unknown(),
  payloadSha256: z.string(),
  retryOf: uuid.nullable(),
  status: z.enum(['pending', 'delivered', 'failed', 'cancelled']),
  attempts: z.number().int(),
  nextAttemptAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  attemptHistory: z.array(z.object({
    attempt: z.number().int(), startedAt: isoDate, durationMs: z.number().int(),
    httpStatus: z.number().int().nullable(), error: z.string().nullable(), responseExcerpt: z.string().nullable(),
  }).strict()),
}).strict();
export type Delivery = z.infer<typeof deliverySchema>;
export type DeliveryStatus = Delivery['status'];

export const deliveryListSchema = z.object({ items: z.array(deliverySchema), nextCursor: z.string().nullable() }).strict();
export type DeliveryList = z.infer<typeof deliveryListSchema>;
