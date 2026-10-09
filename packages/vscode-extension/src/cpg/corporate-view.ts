// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import type { CorporateFinding } from '@nomus/scanner';
import type { BundleState } from './bundle-cache';
import type { GitContext } from './git-context';
import type { CaseView } from './case-status';
import {
  bundleStatusText, caseLabel, changeRequestText, formatUtc, groupFindings, laneText, ownersText, statusText, type FindingGroup, type Resolution,
} from './corporate-format';

/**
 * The "Corporate Policies" view (`nomus.corporate`, design spec §10.2): the
 * branch's review case (lanes, open change requests, what to do next), the
 * groups of findings, the repository row and the bundle status row. When the
 * bundle is not usable the view shows why, and never an empty "no
 * violations" list.
 */

export type CorporateViewState =
  | { kind: 'off'; reason: 'setting' | 'signed_out' }
  | {
    kind: 'bundle';
    bundle: BundleState;
    findings: readonly CorporateFinding[];
    /** At least one file was checked with this bundle (an empty list then means no findings). */
    checked: boolean;
    repository: GitContext | null;
  };

type ChangeRequest = Extract<CaseView, { kind: 'case' }>['status']['openChangeRequests'][number];

type Node =
  | { type: 'message'; label: string; tooltip?: string; icon?: string; command?: string }
  | { type: 'case'; view: Extract<CaseView, { kind: 'case' }> }
  | { type: 'changeRequest'; request: ChangeRequest }
  | { type: 'group'; group: FindingGroup }
  | { type: 'finding'; finding: CorporateFinding };

export class CorporateViewProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private state: CorporateViewState = { kind: 'off', reason: 'signed_out' };
  private caseView: CaseView | null = null;

  setCase(view: CaseView | null): void {
    this.caseView = view;
    this.emitter.fire();
  }

  setState(state: CorporateViewState): void {
    this.state = state;
    this.emitter.fire();
  }

  getState(): CorporateViewState {
    return this.state;
  }

  /** The server's resolution of a finding, from the branch's case. */
  private resolutionOf(fingerprint: string): Resolution | undefined {
    return this.caseView?.kind === 'case' ? this.caseView.status.resolutions.find((r) => r.fingerprint === fingerprint) : undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'message') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      if (node.tooltip) item.tooltip = node.tooltip;
      if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
      if (node.command) item.command = { command: node.command, title: node.label };
      item.contextValue = 'nomus.corporate.message';
      return item;
    }
    if (node.type === 'changeRequest') {
      const r = node.request;
      const item = new vscode.TreeItem(changeRequestText(r), vscode.TreeItemCollapsibleState.None);
      item.description = formatUtc(r.createdAt);
      item.tooltip = r.body;
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.contextValue = 'nomus.corporate.changeRequest';
      item.command = { command: 'nomus.cpg.replyToChangeRequest', title: 'Reply', arguments: [r.commentId] };
      return item;
    }
    if (node.type === 'case') {
      const { status, asOf, offline } = node.view;
      const item = new vscode.TreeItem(caseLabel(status), vscode.TreeItemCollapsibleState.Expanded);
      item.description = offline ? `as of ${formatUtc(asOf)} (offline)` : status.prNumber ? `PR #${status.prNumber}` : '';
      item.tooltip = `${status.repo} @ ${status.branch}`;
      item.iconPath = new vscode.ThemeIcon('git-pull-request');
      item.contextValue = 'nomus.corporate.case';
      return item;
    }
    if (node.type === 'group') {
      const item = new vscode.TreeItem(`${node.group.label} (${node.group.findings.length})`, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = `nomus.corporate.group.${node.group.id}`;
      return item;
    }
    const f = node.finding;
    const lines = f.startLine === f.endLine ? `${f.startLine}` : `${f.startLine}-${f.endLine}`;
    const item = new vscode.TreeItem(`${f.policyKey} · ${f.filePath}:${lines}`, vscode.TreeItemCollapsibleState.None);
    // An advisory policy's status is "advisory" too: say it once.
    const r = this.resolutionOf(f.fingerprint);
    item.description = f.status === 'advisory' && !r ? f.tier : `${f.tier} · ${statusText(f, r)}`;
    item.tooltip = `${f.rule.title}\n${f.rule.message}\n${ownersText(f)}\nFingerprint: ${f.fingerprint}`;
    item.contextValue = f.blocking ? 'nomus.corporate.finding.blocking' : 'nomus.corporate.finding';
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [vscode.Uri.file(f.file), { selection: new vscode.Range(f.startLine - 1, 0, f.endLine - 1, 0) }],
    };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (node?.type === 'group') return node.group.findings.map((finding) => ({ type: 'finding' as const, finding }));
    if (node?.type === 'case') return this.caseRows(node.view);
    if (node) return [];
    const s = this.state;
    if (s.kind === 'off') {
      return [{
        type: 'message',
        label: s.reason === 'setting' ? 'Corporate policy checks are off (setting nomus.corporate.enabled)' : 'Sign in to Nomus to check corporate policies',
      }];
    }
    const status: Node = { type: 'message', label: bundleStatusText(s.bundle), icon: 'shield', ...('reason' in s.bundle ? { tooltip: s.bundle.reason } : {}) };
    const b = s.bundle;
    if (b.kind === 'not_supported') return [status];
    if (b.kind !== 'verified' && b.kind !== 'offline') {
      // No usable bundle: say so, never show an empty list as if nothing were wrong.
      return [{ type: 'message', label: 'Corporate policy findings cannot be shown until a verified policy bundle is available' }, status];
    }
    if (!b.bundle.enabled) return [{ type: 'message', label: 'Corporate policies are not enabled for this organization' }, status];
    const groups = groupFindings(s.findings, (fp) => this.resolutionOf(fp)).map((group) => ({ type: 'group' as const, group }));
    const repo: Node[] = s.repository
      ? [{ type: 'message', label: s.repository.ok ? `Repository: ${s.repository.repo} @ ${s.repository.branch}` : `Repository: ${s.repository.message}` }]
      : [];
    const empty: Node[] = groups.length > 0 ? [] : [{
      type: 'message',
      label: s.checked ? 'No corporate policy findings in the scanned files' : 'No files checked yet: save a file or run "Nomus: Scan Workspace"',
    }];
    return [...this.caseNodes(s.findings), ...groups, ...empty, ...repo, status];
  }

  /** The case node, or what to do when there is none (§10.4). */
  private caseNodes(findings: readonly CorporateFinding[]): Node[] {
    const v = this.caseView;
    if (!v) return [];
    if (v.kind === 'case') return [{ type: 'case', view: v }];
    if (v.kind === 'error') return [{ type: 'message', label: v.message, icon: 'warning' }];
    return findings.some((f) => f.blocking)
      ? [{ type: 'message', label: 'No review case for this branch: run "Nomus: Request Policy Review"', icon: 'git-pull-request', command: 'nomus.cpg.requestReview' }]
      : [];
  }

  private caseRows({ status: c }: Extract<CaseView, { kind: 'case' }>): Node[] {
    const lanes: Node[] = c.lanes.map((l) => ({ type: 'message', label: laneText(l) }));
    const requests: Node[] = c.openChangeRequests.map((request) => ({ type: 'changeRequest', request }));
    const next: Node[] = c.state === 'changes_requested' && c.openChangeRequests.length === 0
      ? [{ type: 'message', label: 'Every change request is resolved: resubmit for review', icon: 'send', command: 'nomus.cpg.resubmit' }]
      : c.state === 'open'
        ? [{ type: 'message', label: 'Justify the blocking findings: run "Nomus: Request Policy Review"', icon: 'edit', command: 'nomus.cpg.requestReview' }]
        : [];
    return [...lanes, ...requests, ...next, { type: 'message', label: 'Open in dashboard', icon: 'link-external', command: 'nomus.cpg.openCase' }];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
