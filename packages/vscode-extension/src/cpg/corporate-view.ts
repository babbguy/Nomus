// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import type { CorporateFinding } from '@nomus/scanner';
import type { BundleState } from './bundle-cache';
import type { GitContext } from './git-context';
import { bundleStatusText, groupFindings, ownersText, statusText, type FindingGroup } from './corporate-format';

/**
 * The "Corporate Policies" view (`nomus.corporate`, design spec §10.2).
 * Phase 3 shows findings only: groups of findings, the repository row and
 * the bundle status row. When the bundle is not usable the view shows why,
 * and never an empty "no violations" list.
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

type Node =
  | { type: 'message'; label: string; tooltip?: string; icon?: string }
  | { type: 'group'; group: FindingGroup }
  | { type: 'finding'; finding: CorporateFinding };

export class CorporateViewProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private state: CorporateViewState = { kind: 'off', reason: 'signed_out' };

  setState(state: CorporateViewState): void {
    this.state = state;
    this.emitter.fire();
  }

  getState(): CorporateViewState {
    return this.state;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'message') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      if (node.tooltip) item.tooltip = node.tooltip;
      if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
      item.contextValue = 'nomus.corporate.message';
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
    item.description = f.status === 'advisory' ? f.tier : `${f.tier} · ${statusText(f)}`;
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
    const groups = groupFindings(s.findings).map((group) => ({ type: 'group' as const, group }));
    const repo: Node[] = s.repository
      ? [{ type: 'message', label: s.repository.ok ? `Repository: ${s.repository.repo} @ ${s.repository.branch}` : `Repository: ${s.repository.message}` }]
      : [];
    const empty: Node[] = groups.length > 0 ? [] : [{
      type: 'message',
      label: s.checked ? 'No corporate policy findings in the scanned files' : 'No files checked yet: save a file or run "Nomus: Scan Workspace"',
    }];
    return [...groups, ...empty, ...repo, status];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
