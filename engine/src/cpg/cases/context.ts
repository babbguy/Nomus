import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgPolicies, cpgPolicyVersions, cpgReviewerContexts, cpgSnippets } from '../../db/schema-cpg.js';
import { generateWithFallback, isLlmProviderConfigured, type LLMResponse } from '../../llm/provider.js';
import {
  buildReviewerContextSystemPrompt, buildReviewerContextUserMessage, CPG_REVIEWER_CONTEXT_PROMPT_VERSION,
} from '../../llm/prompts/cpg-reviewer-context.js';
import { logger } from '../../logger.js';
import { appendAuditEvent } from '../audit/log.js';
import { CpgError } from '../errors.js';
import { extractJson, type Generate } from '../policies/compile.js';
import { getOrgSettings } from '../rbac/seed.js';
import type { CaseFindingRow } from './service.js';

/**
 * Reviewer context (design spec §2.3 T24, owner decision D1): generated
 * plain-English context for one flagged snippet, on first request.
 *
 * - The org setting `reviewerContextLlm` decides whether a snippet may be
 *   sent to the configured provider; off means `disabled` and no call.
 * - Every attempt is stored (append-only), success or failure, labelled with
 *   provider, model and prompt version. A failure is `failed` with its error,
 *   never silent; an explicit retry adds the next attempt, up to five.
 * - Nothing here runs inside a review request, so a slow or failing provider
 *   can never block or fail one.
 */

type Db = BetterSQLite3Database<any>;
export type ReviewerContextRow = typeof cpgReviewerContexts.$inferSelect;
export const MAX_CONTEXT_ATTEMPTS = 5;

const contextOutputSchema = z.object({
  whatItDoes: z.string().trim().min(1).max(1200),
  whyFlagged: z.string().trim().min(1).max(1200),
}).strict();

const defaultGenerate: Generate = (system, user) => generateWithFallback('translator', system, user);

type Target = Pick<CaseFindingRow, 'orgId' | 'snippetHash' | 'policyVersionId' | 'language'>;

function latestAttempt(db: Db, t: Target): ReviewerContextRow | undefined {
  return db.select().from(cpgReviewerContexts).where(and(
    eq(cpgReviewerContexts.orgId, t.orgId), eq(cpgReviewerContexts.snippetHash, t.snippetHash),
    eq(cpgReviewerContexts.policyVersionId, t.policyVersionId), eq(cpgReviewerContexts.promptVersion, CPG_REVIEWER_CONTEXT_PROMPT_VERSION),
  )).orderBy(desc(cpgReviewerContexts.attempt)).limit(1).get();
}

/**
 * The context of a finding: the stored one, or a new attempt when there is
 * none yet (or `retry` after a failure). `null` means disabled for the org.
 */
export async function reviewerContext(db: Db, t: Target, opts: { retry: boolean; actor: string }, generate: Generate = defaultGenerate): Promise<ReviewerContextRow | null> {
  const latest = latestAttempt(db, t);
  if (opts.retry && latest?.status !== 'failed') throw new CpgError(409, 'context_not_failed', 'Only a failed context can be retried');
  if (opts.retry && latest && latest.attempt >= MAX_CONTEXT_ATTEMPTS) {
    throw new CpgError(409, 'retry_limit_reached', `Reviewer context is tried at most ${MAX_CONTEXT_ATTEMPTS} times`);
  }
  if (latest && !opts.retry) return latest;
  if (!getOrgSettings(db, t.orgId)?.reviewerContextLlm) return null;

  const attempt = (latest?.attempt ?? 0) + 1;
  const { content, response, error } = await callProvider(db, t, generate);
  const row: ReviewerContextRow = {
    id: randomUUID(), orgId: t.orgId, snippetHash: t.snippetHash, policyVersionId: t.policyVersionId,
    status: content ? 'generated' : 'failed', whatItDoes: content?.whatItDoes ?? null, whyFlagged: content?.whyFlagged ?? null,
    provider: response?.provider ?? null, model: response?.model ?? null, promptVersion: CPG_REVIEWER_CONTEXT_PROMPT_VERSION,
    attempt, error, createdAt: new Date().toISOString(),
  };
  // A concurrent request may have stored this attempt first; keep the first one.
  const stored = rawSqlite(db).transaction(() => {
    const inserted = db.insert(cpgReviewerContexts).values(row).onConflictDoNothing().run().changes === 1;
    if (inserted) {
      appendAuditEvent(db, {
        orgId: t.orgId, actor: opts.actor, action: 'case.context_generated', targetType: 'reviewer_context', targetId: row.id,
        payload: { snippetHash: t.snippetHash, policyVersionId: t.policyVersionId, status: row.status, attempt, provider: row.provider, model: row.model },
      });
    }
    return inserted;
  })();
  if (!stored) return latestAttempt(db, t)!;
  if (error) logger.warn({ orgId: t.orgId, contextId: row.id, attempt, error }, 'CPG reviewer context failed (recorded)');
  return row;
}

async function callProvider(db: Db, t: Target, generate: Generate): Promise<{ content: z.infer<typeof contextOutputSchema> | null; response: LLMResponse | null; error: string | null }> {
  let response: LLMResponse | null = null;
  try {
    if (generate === defaultGenerate && !isLlmProviderConfigured('translator')) throw new Error('No LLM provider is configured for the translator role');
    const source = db.select({
      snippet: cpgSnippets.normalizedText, policyKey: cpgPolicies.policyKey, title: cpgPolicyVersions.title,
      plainText: cpgPolicyVersions.plainText, rule: cpgPolicyVersions.rule,
    }).from(cpgPolicyVersions)
      .innerJoin(cpgPolicies, eq(cpgPolicies.id, cpgPolicyVersions.policyId))
      .innerJoin(cpgSnippets, and(eq(cpgSnippets.orgId, cpgPolicyVersions.orgId), eq(cpgSnippets.snippetHash, t.snippetHash)))
      .where(and(eq(cpgPolicyVersions.id, t.policyVersionId), eq(cpgPolicyVersions.orgId, t.orgId))).get();
    if (!source) throw new Error('The snippet or policy version of this finding is not stored');
    const ruleMessage = (JSON.parse(source.rule ?? '{}') as { message?: string }).message ?? '';
    response = await generate(buildReviewerContextSystemPrompt(), buildReviewerContextUserMessage({ ...source, ruleMessage, language: t.language }));
    const parsed = contextOutputSchema.safeParse(extractJson(response.content));
    if (!parsed.success) throw new Error('The provider answer is not {"whatItDoes", "whyFlagged"} within 1200 characters each');
    return { content: parsed.data, response, error: null };
  } catch (err) {
    return { content: null, response, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}
