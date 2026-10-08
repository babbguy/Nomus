import * as vscode from 'vscode';

export interface DiagnosticFinding {
  file: string;
  line: number;
  sdk: string;
  severity: string;
  ruleKey: string;
  humanSummary: string;
  legalReference: string;
  suggestion?: string;
  detectorSource?: string;
}

const SEVERITY_MAP: Record<string, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  high: vscode.DiagnosticSeverity.Error,
  medium: vscode.DiagnosticSeverity.Warning,
  low: vscode.DiagnosticSeverity.Information,
};

export class DiagnosticsProvider implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('nomus');
  }

  setFindings(uri: vscode.Uri, findings: DiagnosticFinding[]) {
    const diagnostics = findings.map((f) => {
      const line = Math.max(0, f.line - 1);
      const range = new vscode.Range(line, 0, line, 1000);
      const severity = SEVERITY_MAP[f.severity] ?? vscode.DiagnosticSeverity.Warning;

      const diagnostic = new vscode.Diagnostic(range, `[${f.ruleKey}] ${f.humanSummary}`, severity);
      diagnostic.source = 'Nomus';
      diagnostic.code = { value: f.ruleKey, target: vscode.Uri.parse(`https://github.com/babbguy/Nomus/tree/main/docs`) };

      if (f.legalReference) {
        diagnostic.relatedInformation = [
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(uri, range),
            `Legal: ${f.legalReference}`
          ),
        ];
      }

      return diagnostic;
    });

    this.collection.set(uri, diagnostics);
  }

  clear() {
    this.collection.clear();
  }

  dispose() {
    this.collection.dispose();
  }
}
