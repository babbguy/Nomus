import * as vscode from 'vscode';
import { NomusApiClient } from '../api-client';

interface RegulatorySignal {
  id: string;
  title: string;
  jurisdiction: string;
  stage: string;
  likelihoodPercent: number;
  summary: string;
  expectedEffectiveDate: string | null;
}

/**
 * Tree data provider for the Regulatory Radar sidebar view.
 * Shows upcoming regulatory signals grouped by stage.
 */
export class RadarProvider implements vscode.TreeDataProvider<RadarItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RadarItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private signals: RegulatorySignal[] = [];
  private apiClient: NomusApiClient;

  constructor(apiClient: NomusApiClient) {
    this.apiClient = apiClient;
  }

  async refresh(): Promise<void> {
    const data = await this.apiClient.get<{ signals: RegulatorySignal[] }>('/api/v1/radar');
    this.signals = data?.signals ?? [];
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: RadarItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RadarItem): RadarItem[] {
    if (element) {
      // Signals under a stage group
      if (element.contextValue === 'stage-group') {
        return this.signals
          .filter((s) => s.stage === element.stage)
          .sort((a, b) => b.likelihoodPercent - a.likelihoodPercent)
          .map((s) => {
            const item = new RadarItem(
              s.title,
              `${s.jurisdiction} — ${s.likelihoodPercent}%`,
              getLikelihoodIcon(s.likelihoodPercent),
              vscode.TreeItemCollapsibleState.None,
              'signal',
            );
            item.tooltip = new vscode.MarkdownString(
              `**${s.title}**\n\n` +
              `Jurisdiction: ${s.jurisdiction}\n\n` +
              `Stage: ${s.stage}\n\n` +
              `Likelihood: ${s.likelihoodPercent}%\n\n` +
              (s.expectedEffectiveDate ? `Expected: ${s.expectedEffectiveDate}\n\n` : '') +
              `${s.summary}`,
            );
            return item;
          });
      }
      return [];
    }

    if (this.signals.length === 0) {
      return [new RadarItem(
        'No regulatory signals',
        'Sign in to view radar',
        'info',
        vscode.TreeItemCollapsibleState.None,
        'hint',
      )];
    }

    // Group by stage
    const stageOrder = ['adopted', 'committee', 'draft', 'signal'];
    const groups: Record<string, RegulatorySignal[]> = {};
    for (const s of this.signals) {
      if (!groups[s.stage]) groups[s.stage] = [];
      groups[s.stage].push(s);
    }

    return stageOrder
      .filter((stage) => groups[stage]?.length)
      .map((stage) => {
        const item = new RadarItem(
          stageLabels[stage] || stage,
          `${groups[stage].length} signal${groups[stage].length > 1 ? 's' : ''}`,
          stageIcons[stage] || 'circle-outline',
          vscode.TreeItemCollapsibleState.Collapsed,
          'stage-group',
        );
        item.stage = stage;
        return item;
      });
  }
}

const stageLabels: Record<string, string> = {
  adopted: 'Adopted',
  committee: 'In Committee',
  draft: 'Draft',
  signal: 'Early Signal',
};

const stageIcons: Record<string, string> = {
  adopted: 'pass-filled',
  committee: 'clock',
  draft: 'edit',
  signal: 'pulse',
};

class RadarItem extends vscode.TreeItem {
  stage?: string;

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

function getLikelihoodIcon(likelihood: number): string {
  if (likelihood >= 80) return 'warning';
  if (likelihood >= 50) return 'info';
  return 'circle-outline';
}
