import * as vscode from 'vscode';
import type { DiagnosticFinding } from '../diagnostics';

const SEVERITY_ICONS: Record<string, string> = {
  critical: '$(error)',
  high: '$(warning)',
  medium: '$(info)',
  low: '$(note)',
};

export class FindingsTreeProvider implements vscode.TreeDataProvider<FindingItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FindingItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private findings: DiagnosticFinding[] = [];

  setFindings(findings: DiagnosticFinding[]) {
    this.findings = findings;
    this._onDidChangeTreeData.fire(undefined);
  }

  clear() {
    this.findings = [];
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: FindingItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FindingItem): FindingItem[] {
    if (element) return [];

    // Group by severity
    const groups = new Map<string, DiagnosticFinding[]>();
    for (const f of this.findings) {
      const arr = groups.get(f.severity) ?? [];
      arr.push(f);
      groups.set(f.severity, arr);
    }

    const items: FindingItem[] = [];
    for (const severity of ['critical', 'high', 'medium', 'low']) {
      const group = groups.get(severity);
      if (!group || group.length === 0) continue;

      for (const finding of group) {
        items.push(new FindingItem(finding));
      }
    }

    return items;
  }
}

class FindingItem extends vscode.TreeItem {
  constructor(finding: DiagnosticFinding) {
    const label = `${SEVERITY_ICONS[finding.severity] ?? ''} ${finding.ruleKey}`;
    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = finding.humanSummary;
    this.tooltip = `${finding.sdk} — ${finding.humanSummary}\n${finding.legalReference}`;

    // Click to navigate to the finding location
    const uri = vscode.Uri.file(finding.file);
    const line = Math.max(0, finding.line - 1);
    this.command = {
      command: 'vscode.open',
      title: 'Go to finding',
      arguments: [uri, { selection: new vscode.Range(line, 0, line, 0) }],
    };

    this.contextValue = 'finding';
  }
}
