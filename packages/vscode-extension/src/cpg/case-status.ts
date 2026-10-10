// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import type { CaseStatus } from '@nomus/scanner/corporate';
import { apiUrlSetting, type CpgClient } from './cpg-client';
import { caseNotices, closedNotice } from './corporate-format';
import { readGitContext } from './git-context';

/**
 * The review case of the current branch (design spec §10.4, §10.5). Polled
 * with E42 on activation, on refresh, after every case command and on save
 * (at most once a minute); there is no background queue and no SSE.
 *
 * The last status seen is kept per server and branch in `globalState`, so
 * offline the view still shows it, marked "as of <time>", and the next poll
 * can say what changed since: a new change request is a warning with
 * [Reply] / [Open case]; decisions and closing are information messages.
 * Only the current branch's case notifies.
 */

export type CaseView =
  | { kind: 'none' }
  | { kind: 'case'; status: CaseStatus; asOf: string; offline: boolean }
  | { kind: 'error'; message: string };

interface StoredCase { status: CaseStatus; asOf: string }

export const CASE_STATE_PREFIX = 'nomus.cpg.case:';
const POLL_MS = 60_000;

export class CaseTracker {
  private readonly emitter = new vscode.EventEmitter<CaseView | null>();
  /** Fires with the new view; null when there is nothing to show (signed out, no repository). */
  readonly onDidChange = this.emitter.event;
  private view: CaseView | null = null;
  private lastPoll = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: CpgClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  current(): CaseView | null {
    return this.view;
  }

  private set(view: CaseView | null): void {
    this.view = view;
    this.emitter.fire(view);
  }

  /** The open case shown now, if any. */
  openCase(): CaseStatus | null {
    return this.view?.kind === 'case' ? this.view.status : null;
  }

  /** A case status from a command's answer (request review, resubmit): notify and show it without another round trip. */
  async accept(status: CaseStatus): Promise<void> {
    const key = `${CASE_STATE_PREFIX}${apiUrlSetting()}|${status.repo}@${status.branch}`;
    await this.store(key, status, false);
  }

  private async store(key: string, status: CaseStatus, notify: boolean): Promise<void> {
    const prev = this.context.globalState.get<StoredCase>(key);
    const asOf = this.now().toISOString();
    await this.context.globalState.update(key, { status, asOf } satisfies StoredCase);
    this.set({ kind: 'case', status, asOf, offline: false });
    if (notify) for (const n of caseNotices(prev?.status.id === status.id ? prev.status : null, status)) this.show(n.level, n.text, n.actions);
  }

  private show(level: 'info' | 'warning', text: string, actions: string[] = []): void {
    const shown = level === 'warning' ? vscode.window.showWarningMessage(`Nomus: ${text}`, ...actions) : vscode.window.showInformationMessage(`Nomus: ${text}`, ...actions);
    void Promise.resolve(shown).then((choice) => {
      if (choice === 'Reply') void vscode.commands.executeCommand('nomus.cpg.replyToChangeRequest');
      else if (choice === 'Open case') void vscode.commands.executeCommand('nomus.cpg.openCase');
    });
  }

  /** Poll E42 for the workspace's branch; without `force`, at most once a minute. Never throws. */
  async refresh(force = false): Promise<void> {
    if (!force && this.now().getTime() - this.lastPoll < POLL_MS) return;
    this.lastPoll = this.now().getTime();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const git = root ? await readGitContext(root) : null;
    // No repository: the Corporate Policies view already says why on its repository row.
    if (!git?.ok) return this.set(null);
    const key = `${CASE_STATE_PREFIX}${apiUrlSetting()}|${git.repo}@${git.branch}`;
    const { caseByBranchResponseSchema } = await import('@nomus/scanner/corporate');
    const res = await this.client.request('GET', `/cases/by-branch?repo=${encodeURIComponent(git.repo)}&branch=${encodeURIComponent(git.branch)}`, caseByBranchResponseSchema);
    const stored = this.context.globalState.get<StoredCase>(key);
    if (res.ok) {
      if (res.data.case) return this.store(key, res.data.case, true);
      await this.context.globalState.update(key, undefined);
      this.set({ kind: 'none' });
      if (stored) await this.reportClosed(stored.status);
      return;
    }
    // Not signed in, or a server without review cases: nothing to show.
    if (res.status === 401 || res.status === 404) return this.set(null);
    if (res.offline) {
      return this.set(stored ? { kind: 'case', status: stored.status, asOf: stored.asOf, offline: true } : { kind: 'error', message: 'Review case status unavailable: Nomus is unreachable' });
    }
    this.set({ kind: 'error', message: `Review case status unavailable: ${res.message}` });
  }

  /**
   * The case left the branch: say how it was closed (E43). Only a close the
   * server confirms is reported; the case also leaves the branch's answer
   * when governance is switched off, and then it is not closed.
   */
  private async reportClosed(previous: CaseStatus): Promise<void> {
    const { caseStatusSchema } = await import('@nomus/scanner/corporate');
    const { z } = await import('zod');
    const res = await this.client.request('GET', `/cases/${previous.id}`, z.object({ case: caseStatusSchema }).passthrough());
    if (res.ok && res.data.case.state === 'closed') this.show('info', closedNotice(previous.ref, res.data.case.closeReason));
  }

  /** Signed out. */
  reset(): void {
    this.lastPoll = 0;
    this.set(null);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
