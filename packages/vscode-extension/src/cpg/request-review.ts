// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { z } from 'zod';
import type { CorporateFinding } from '@nomus/scanner';
import type { CaseTracker } from './case-status';
import type { CorporateController } from './corporate-controller';
import type { CpgClient, CpgResult } from './cpg-client';
import { caseStateText, reviewResultText, sentence } from './corporate-format';
import { readGitContext } from './git-context';

/**
 * The review-case commands (design spec §10.3, §10.4): request a review for
 * the branch's blocking findings, reply to a change request, resubmit, and
 * open the case. Nothing is queued: a request that fails is not sent later
 * without the user knowing. Justifications and replies are kept as drafts in
 * `workspaceState` until the server accepts them, so a cancelled, offline or
 * refused attempt loses nothing.
 */

export interface CaseCommandDeps {
  context: vscode.ExtensionContext;
  client: CpgClient;
  corporate: CorporateController;
  cases: CaseTracker;
}

const NEEDS_REVIEW = new Set(['needs_review', 'changes_requested', 'expired']);
const meSchema = z.object({
  identity: z.enum(['session', 'user_key', 'org_key']),
  cpgEnabled: z.boolean(),
  permissions: z.array(z.object({ key: z.string() }).passthrough()),
}).passthrough();
const commentSchema = z.object({ id: z.string().uuid() }).passthrough();

const info = (text: string, ...actions: string[]) => vscode.window.showInformationMessage(`Nomus: ${text}`, ...actions);
const error = (text: string, ...actions: string[]) => vscode.window.showErrorMessage(`Nomus: ${text}`, ...actions);
const DRAFT_SAVED = 'Your justifications are saved as a draft.';

export const draftKey = (repo: string, branch: string) => `nomus.cpg.drafts:${repo}@${branch}`;

/** The failure of a request, in the user's words. */
function failureText<T>(res: Extract<CpgResult<T>, { ok: false }>, what: string, keep = ''): string {
  const text = res.offline ? `Nomus is unreachable: ${what} not sent.` : `${what[0].toUpperCase()}${what.slice(1)} not sent: ${sentence(res.message)}`;
  return `${text} ${keep}`.trim();
}

function validJustification(value: string): string | undefined {
  const n = value.trim().length;
  return n < 20 ? `At least 20 characters (${n} so far)` : n > 4000 ? `At most 4000 characters (${n})` : undefined;
}

/** `nomus.cpg.requestReview`: justify the branch's blocking findings and send them to the owning boards. */
export async function requestReview(d: CaseCommandDeps): Promise<void> {
  // 1. A user identity with case.create, in an org with corporate policies on.
  const me = await d.client.request('GET', '/me', meSchema);
  if (!me.ok) {
    if (me.code === 'user_identity_required' || me.code === 'unauthenticated') {
      const choice = await error(me.code === 'unauthenticated'
        ? 'Sign in to Nomus to request a policy review.'
        : 'Requesting review needs your Nomus sign-in (not an organization API key). Sign in again?', 'Sign in');
      if (choice === 'Sign in') await vscode.commands.executeCommand('nomus.signIn');
      return;
    }
    void error(failureText(me, 'the review request was'));
    return;
  }
  if (!me.data.cpgEnabled) return void info('Corporate policies are not enabled for this organization.');
  if (!me.data.permissions.some((p) => p.key === 'case.create')) {
    return void error('Requesting a review needs the case.create permission (the Developer role). Ask an Org Admin.');
  }

  // 2. The branch.
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const git = root ? await readGitContext(root) : null;
  if (!root || !git?.ok) return void error(`Cannot request a review: ${git && !git.ok ? git.message : 'open a workspace folder first.'}`);

  // 3. A fresh scan of the workspace with the verified bundle.
  const bundle = await d.corporate.ensureBundle(true);
  if (!bundle) return void error('Corporate policy findings cannot be checked right now (see the Corporate Policies view), so no review was requested.');
  const { runCorporateScanOnDisk } = await import('@nomus/scanner');
  const { findingsStatusResponseSchema, requestReviewResponseSchema } = await import('@nomus/scanner/corporate');
  const findings = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Nomus: Checking corporate policies…' },
    async () => (await runCorporateScanOnDisk(root, bundle)).findings,
  );
  d.corporate.applyWorkspaceFindings(findings);
  const blocking = findings.filter((f) => f.blocking);
  if (blocking.length === 0) return void info('Nothing needs review: no blocking corporate policy findings in this workspace.');
  if (findings.length > 500) return void error(`This branch has ${findings.length} corporate policy findings; a review request holds at most 500.`);

  // 4. Which blocking findings still need review (E53).
  const unique = [...new Map(blocking.map((f) => [f.fingerprint, f])).values()];
  const status = await d.client.request('POST', '/findings/status', findingsStatusResponseSchema, { repo: git.repo, branch: git.branch, fingerprints: unique.map((f) => f.fingerprint) });
  if (!status.ok) return void error(failureText(status, 'the review request was'));
  const pending = new Set(status.data.items.filter((r) => r.blocking && NEEDS_REVIEW.has(r.status)).map((r) => r.fingerprint));
  const candidates = unique.filter((f) => pending.has(f.fingerprint));
  if (candidates.length === 0) return void info('Nothing needs review: every blocking finding is approved or excepted.');

  // 5. Selection (all preselected).
  const lines = (f: CorporateFinding) => (f.startLine === f.endLine ? `${f.startLine}` : `${f.startLine}-${f.endLine}`);
  const picked = await vscode.window.showQuickPick(
    candidates.map((f) => ({ label: `${f.tier.toUpperCase()} · ${f.policyKey} · ${f.filePath}:${lines(f)}`, detail: f.rule.title, picked: true, finding: f })),
    { canPickMany: true, title: 'Request policy review', placeHolder: 'The blocking findings to send for review' },
  );
  if (!picked || picked.length === 0) return;

  // 6. Justifications, kept as drafts until the server accepts them.
  const key = draftKey(git.repo, git.branch);
  const drafts = { ...d.context.workspaceState.get<Record<string, string>>(key, {}) };
  const saveDrafts = () => d.context.workspaceState.update(key, drafts);
  for (let i = 0; i < picked.length; i++) {
    const f = picked[i].finding;
    const body = await vscode.window.showInputBox({
      title: `Justification (${i + 1}/${picked.length}): ${f.policyKey} @ ${f.filePath}:${f.startLine}`,
      placeHolder: 'Why this code is needed and how its risk is controlled (20–4000 characters)',
      value: drafts[f.fingerprint] ?? '', ignoreFocusOut: true, validateInput: validJustification,
    });
    if (body === undefined) {
      await saveDrafts();
      return void info(`Review not requested. ${i > 0 ? DRAFT_SAVED : ''}`.trim());
    }
    drafts[f.fingerprint] = body.trim();
    await saveDrafts();
    const rest = picked.length - i - 1;
    if (i === 0 && rest > 0) {
      const same = `Use this justification for the remaining ${rest} finding${rest === 1 ? '' : 's'}`;
      const choice = await vscode.window.showQuickPick([same, 'Write each one'], { title: 'Justification for the other findings' });
      if (choice === undefined) {
        return void info(`Review not requested. ${DRAFT_SAVED}`);
      }
      if (choice === same) {
        for (const p of picked.slice(1)) drafts[p.finding.fingerprint] = drafts[f.fingerprint];
        await saveDrafts();
        break;
      }
    }
  }

  // 7. Submit: every current finding (a full snapshot), justifications for the picked ones.
  const body = {
    repo: git.repo, branch: git.branch, headSha: git.headSha, bundleHash: bundle.bundleHash,
    findings: findings.map((f) => ({
      fingerprint: f.fingerprint, policyKey: f.policyKey, policyVersion: f.policyVersion, filePath: f.filePath,
      startLine: f.startLine, endLine: f.endLine, language: f.language, snippet: f.snippet,
    })),
    justifications: picked.map((p) => ({ fingerprint: p.finding.fingerprint, body: drafts[p.finding.fingerprint] })),
  };
  const send = () => d.client.request('POST', '/cases/request-review', requestReviewResponseSchema, body);
  let res = await send();
  // The case closed between the status check and the request: the server opens a new one.
  if (!res.ok && res.code === 'case_closed') res = await send();
  if (!res.ok) return void error(failureText(res, 'the review request was', DRAFT_SAVED));

  await d.context.workspaceState.update(key, undefined);
  await d.cases.accept(res.data.case);
  if ((await info(reviewResultText(res.data), 'Open case')) === 'Open case') await vscode.env.openExternal(vscode.Uri.parse(res.data.case.url));
}

/** `nomus.cpg.replyToChangeRequest`: answer a change request, optionally marking it resolved. */
/** `arg`: a comment id (the row's click), or the tree node (its inline action). */
export async function replyToChangeRequest(d: CaseCommandDeps, arg?: string | { request?: { commentId?: string } }): Promise<void> {
  const kase = d.cases.openCase();
  if (!kase) return void info('There is no open review case for this branch.');
  const id = typeof arg === 'string' ? arg : arg?.request?.commentId;
  let request = kase.openChangeRequests.find((r) => r.commentId === id) ?? (kase.openChangeRequests.length === 1 ? kase.openChangeRequests[0] : undefined);
  if (!request) {
    if (kase.openChangeRequests.length === 0) return void info(`No change request on ${kase.ref} is waiting for a reply.`);
    request = (await vscode.window.showQuickPick(
      kase.openChangeRequests.map((r) => ({ label: `${r.authorName} (${r.boardName})`, detail: r.body, request: r })),
      { title: `Reply to a change request on ${kase.ref}` },
    ))?.request;
    if (!request) return;
  }
  const key = `nomus.cpg.reply:${request.commentId}`;
  const text = await vscode.window.showInputBox({
    title: `Reply to ${request.authorName} (${request.boardName})`, prompt: request.body, placeHolder: 'Your reply, sent to the reviewer on the case',
    value: d.context.workspaceState.get<string>(key, ''), ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'Write a reply' : v.trim().length > 8000 ? 'At most 8000 characters' : undefined),
  });
  if (text === undefined) return;
  await d.context.workspaceState.update(key, text.trim());
  const RESOLVES = 'This resolves the request';
  const choice = await vscode.window.showQuickPick([RESOLVES, 'Reply without resolving it'], { title: 'Does your reply resolve the request?' });
  if (choice === undefined) return void info('Reply not sent. Your text is saved as a draft.');

  const res = await d.client.request('POST', `/cases/${kase.id}/comments`, commentSchema, { kind: 'reply', threadId: request.commentId, resolves: choice === RESOLVES, body: text.trim() });
  if (!res.ok) return void error(failureText(res, 'the reply was', 'Your text is saved as a draft.'));
  await d.context.workspaceState.update(key, undefined);
  await d.cases.refresh(true);
  const now = d.cases.openCase();
  if (now?.state === 'changes_requested' && now.openChangeRequests.length === 0) {
    if ((await info(`Reply sent. Every change request on ${now.ref} is resolved: resubmit the case for review.`, 'Resubmit')) === 'Resubmit') {
      await vscode.commands.executeCommand('nomus.cpg.resubmit');
    }
    return;
  }
  void info(`Reply sent to ${request.authorName}.`);
}

/** `nomus.cpg.resubmit`: send the case back to review once every change request is resolved. */
export async function resubmit(d: CaseCommandDeps): Promise<void> {
  const kase = d.cases.openCase();
  if (!kase) return void info('There is no open review case for this branch.');
  const { caseStatusSchema } = await import('@nomus/scanner/corporate');
  const res = await d.client.request('POST', `/cases/${kase.id}/resubmit`, caseStatusSchema, {});
  if (!res.ok) return void error(failureText(res, 'the resubmission was'));
  await d.cases.accept(res.data);
  void info(`Review case ${res.data.ref} resubmitted: ${caseStateText(res.data.state)}.`);
}

/** `nomus.cpg.openCase`: the case in the dashboard. */
export async function openCase(d: CaseCommandDeps): Promise<void> {
  const kase = d.cases.openCase();
  if (!kase) return void info('There is no open review case for this branch.');
  await vscode.env.openExternal(vscode.Uri.parse(kase.url));
}
