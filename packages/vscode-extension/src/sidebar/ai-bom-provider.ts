import * as vscode from 'vscode';
import { NomusApiClient } from '../api-client';

interface AiBomSystem {
  id: string;
  name: string;
  systemType: string;
  provider: string;
  modelName: string;
  riskClassification: string;
  jurisdictions: string[];
  deploymentType: string;
  isActive: boolean;
}

interface AiBomSummary {
  totalSystems: number;
  byRisk: Record<string, number>;
  byType: Record<string, number>;
  systems: AiBomSystem[];
}

/**
 * Tree data provider for the AI Bill of Materials sidebar view.
 * Shows AI systems grouped by risk classification.
 */
export class AiBomProvider implements vscode.TreeDataProvider<BomItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BomItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private systems: AiBomSystem[] = [];
  private apiClient: NomusApiClient;

  constructor(apiClient: NomusApiClient) {
    this.apiClient = apiClient;
  }

  async refresh(): Promise<void> {
    const data = await this.apiClient.get<{ count: number; systems: AiBomSystem[] }>('/api/v1/ai-bom');
    this.systems = data?.systems ?? [];
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: BomItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BomItem): BomItem[] {
    if (element) {
      // Systems under a risk group
      if (element.contextValue === 'risk-group') {
        return this.systems
          .filter((s) => s.riskClassification === element.riskLevel)
          .map((s) => new BomItem(
            s.name,
            `${s.provider} ${s.modelName}`.trim() || s.systemType,
            getTypeIcon(s.systemType),
            vscode.TreeItemCollapsibleState.None,
            'system',
            s.id,
          ));
      }
      return [];
    }

    if (this.systems.length === 0) {
      return [new BomItem(
        'No AI systems registered',
        'Run "Generate AI-BOM" to detect',
        'info',
        vscode.TreeItemCollapsibleState.None,
        'hint',
      )];
    }

    // Group by risk classification
    const groups: Record<string, AiBomSystem[]> = {};
    for (const s of this.systems) {
      const risk = s.riskClassification || 'unclassified';
      if (!groups[risk]) groups[risk] = [];
      groups[risk].push(s);
    }

    const riskOrder = ['unacceptable', 'high', 'limited', 'minimal', 'unclassified'];
    return riskOrder
      .filter((r) => groups[r]?.length)
      .map((risk) => {
        const item = new BomItem(
          `${risk.charAt(0).toUpperCase() + risk.slice(1)} Risk`,
          `${groups[risk].length} system${groups[risk].length > 1 ? 's' : ''}`,
          getRiskIcon(risk),
          vscode.TreeItemCollapsibleState.Collapsed,
          'risk-group',
        );
        item.riskLevel = risk;
        return item;
      });
  }
}

class BomItem extends vscode.TreeItem {
  riskLevel?: string;

  constructor(
    label: string,
    description: string,
    iconId: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
    systemId?: string,
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(iconId);
    if (systemId) {
      this.tooltip = `Click to view in dashboard`;
      this.command = {
        command: 'nomus.openDashboard',
        title: 'Open in Dashboard',
      };
    }
  }
}

function getRiskIcon(risk: string): string {
  switch (risk) {
    case 'unacceptable': return 'error';
    case 'high': return 'warning';
    case 'limited': return 'info';
    case 'minimal': return 'pass';
    default: return 'question';
  }
}

function getTypeIcon(type: string): string {
  switch (type) {
    case 'model': return 'symbol-method';
    case 'pipeline': return 'git-merge';
    case 'agent': return 'robot';
    case 'embedding': return 'database';
    case 'fine_tune': return 'settings-gear';
    default: return 'symbol-misc';
  }
}
