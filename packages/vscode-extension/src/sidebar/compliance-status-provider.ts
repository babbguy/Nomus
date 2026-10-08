import * as vscode from 'vscode';
import { NomusApiClient } from '../api-client';

interface ComplianceScore {
  overallScore: number;
  scoresByJurisdiction: Record<string, number>;
  rulesActive: number;
  openFindings: number;
  aiBomSystemCount: number;
  highRiskSystems: number;
  benchmarkScore: number | null;
  computedAt: string;
}

interface LocalFindingsSummary {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * Tree data provider for the Compliance Status sidebar view.
 * Shows overall score, jurisdiction scores, and key metrics.
 *
 * The displayed score incorporates BOTH backend (org-level) findings
 * AND local scan findings from the current workspace, ensuring the
 * score accurately reflects all known issues.
 */
export class ComplianceStatusProvider implements vscode.TreeDataProvider<StatusItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<StatusItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private data: ComplianceScore | null = null;
  private apiClient: NomusApiClient;
  private localFindings: LocalFindingsSummary = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };

  constructor(apiClient: NomusApiClient) {
    this.apiClient = apiClient;
  }

  /** Update the local scan findings and re-render the tree. */
  setLocalFindings(findings: { severity: string }[]): void {
    this.localFindings = { total: findings.length, critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) {
      if (f.severity === 'critical') this.localFindings.critical++;
      else if (f.severity === 'high') this.localFindings.high++;
      else if (f.severity === 'medium') this.localFindings.medium++;
      else this.localFindings.low++;
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  async refresh(): Promise<void> {
    this.data = await this.apiClient.get<ComplianceScore>('/api/v1/compliance/score');
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Compute the effective score by applying local finding deductions
   * to the backend score. Uses the same severity weights as the engine:
   * critical = -5, high = -3, medium = -1, low = 0.
   */
  private getEffectiveScore(): number {
    if (!this.data) return 0;
    const deductions =
      this.localFindings.critical * 5 +
      this.localFindings.high * 3 +
      this.localFindings.medium * 1;
    return Math.max(0, Math.min(100, this.data.overallScore - deductions));
  }

  getTreeItem(element: StatusItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: StatusItem): StatusItem[] {
    if (element) {
      // Jurisdiction children
      if (element.contextValue === 'jurisdictions' && this.data) {
        return Object.entries(this.data.scoresByJurisdiction)
          .sort(([, a], [, b]) => a - b)
          .map(([j, score]) => new StatusItem(
            j,
            `${score.toFixed(0)}%`,
            getScoreIcon(score),
            vscode.TreeItemCollapsibleState.None,
            'jurisdiction',
          ));
      }
      return [];
    }

    if (!this.data) {
      return [new StatusItem(
        'Sign in to view compliance status',
        '',
        'info',
        vscode.TreeItemCollapsibleState.None,
        'hint',
      )];
    }

    const items: StatusItem[] = [];

    // Effective score incorporates local scan findings
    const effectiveScore = this.getEffectiveScore();

    items.push(new StatusItem(
      `Score: ${effectiveScore.toFixed(0)}%`,
      getScoreLabel(effectiveScore),
      getScoreIcon(effectiveScore),
      vscode.TreeItemCollapsibleState.None,
      'score',
    ));

    // Key metrics
    items.push(new StatusItem(
      `Active Rules: ${this.data.rulesActive}`,
      '',
      'checklist',
      vscode.TreeItemCollapsibleState.None,
      'metric',
    ));

    // Total findings = backend open findings + local scan findings
    const totalFindings = this.data.openFindings + this.localFindings.total;
    if (totalFindings > 0) {
      items.push(new StatusItem(
        `Open Findings: ${totalFindings}`,
        this.localFindings.total > 0 ? `${this.localFindings.total} in workspace` : '',
        'warning',
        vscode.TreeItemCollapsibleState.None,
        'metric',
      ));
    }

    items.push(new StatusItem(
      `AI Systems: ${this.data.aiBomSystemCount}`,
      this.data.highRiskSystems > 0 ? `${this.data.highRiskSystems} high-risk` : '',
      'server',
      vscode.TreeItemCollapsibleState.None,
      'metric',
    ));

    if (this.data.benchmarkScore != null) {
      items.push(new StatusItem(
        `Benchmark: ${this.data.benchmarkScore.toFixed(0)}%`,
        '',
        'beaker',
        vscode.TreeItemCollapsibleState.None,
        'metric',
      ));
    }

    // Jurisdictions (expandable)
    if (Object.keys(this.data.scoresByJurisdiction).length > 0) {
      items.push(new StatusItem(
        'Jurisdictions',
        `${Object.keys(this.data.scoresByJurisdiction).length} tracked`,
        'globe',
        vscode.TreeItemCollapsibleState.Collapsed,
        'jurisdictions',
      ));
    }

    return items;
  }
}

class StatusItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    iconId: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(iconId);
  }
}

function getScoreIcon(score: number): string {
  if (score >= 80) return 'pass-filled';
  if (score >= 60) return 'warning';
  return 'error';
}

function getScoreLabel(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 80) return 'Good';
  if (score >= 60) return 'Fair';
  if (score >= 40) return 'Needs Work';
  return 'Critical';
}
