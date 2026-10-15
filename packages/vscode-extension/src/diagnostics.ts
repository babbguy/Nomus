import * as vscode from 'vscode';
import type { CorporateFinding } from '@nomus/scanner';
import { corporateMessage, corporateSeverity, ownersText, type CorporateSeverity, type Resolution } from './cpg/corporate-format';

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

const CORPORATE_SEVERITY: Record<CorporateSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

/** Source of corporate policy diagnostics; regulatory ones keep `Nomus` (design spec §10.2). */
export const CORPORATE_SOURCE = 'Nomus Policy';

/** The dashboard page of a corporate policy, or undefined when no dashboard origin is known. */
export type PolicyLink = (policyId: string) => vscode.Uri | undefined;

/** The dashboard origin from `nomus.dashboardUrl`, else derived from `nomus.apiUrl` as "Open Dashboard" does. */
function defaultPolicyLink(policyId: string): vscode.Uri | undefined {
  const config = vscode.workspace.getConfiguration('nomus');
  let base = config.get<string>('dashboardUrl', '') || '';
  if (!base) {
    try {
      const parsed = new URL(config.get<string>('apiUrl', 'http://localhost:3100'));
      if (parsed.port === '3100') parsed.port = '5173';
      if (parsed.hostname.startsWith('api.')) parsed.hostname = parsed.hostname.replace(/^api\./, '');
      base = parsed.origin;
    } catch {
      return undefined;
    }
  }
  return vscode.Uri.parse(`${base.replace(/\/+$/, '')}/governance/policies/${policyId}`);
}

/**
 * Nomus diagnostics. Regulatory and corporate findings share the single
 * `nomus` collection (one entry per file, merged here), and the regulatory
 * diagnostics are built exactly as in v1.1.0; corporate ones follow, with
 * the server's decision on each finding (§10.4) when one is known.
 */
export class DiagnosticsProvider implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection;
  private readonly policyLink: PolicyLink;
  /** uri string → the regulatory diagnostics and corporate findings currently shown for the file */
  private readonly byUri = new Map<string, { uri: vscode.Uri; regulatory: vscode.Diagnostic[]; corporate: readonly CorporateFinding[] }>();
  /** fingerprint → the server's resolution of the finding */
  private resolutions = new Map<string, Resolution>();

  constructor(policyLink: PolicyLink = defaultPolicyLink) {
    this.collection = vscode.languages.createDiagnosticCollection('nomus');
    this.policyLink = policyLink;
  }

  /**
   * Set a file's regulatory findings. `corporate` replaces its corporate
   * findings too; when omitted they are kept.
   */
  setFindings(uri: vscode.Uri, findings: DiagnosticFinding[], corporate?: readonly CorporateFinding[]) {
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

    this.render(uri, diagnostics, corporate ?? this.byUri.get(uri.toString())?.corporate ?? []);
  }

  /**
   * Set a file's corporate findings, keeping its regulatory ones. Clearing a
   * file that never had corporate diagnostics leaves the collection untouched.
   */
  setCorporateFindings(uri: vscode.Uri, corporate: readonly CorporateFinding[]) {
    const entry = this.byUri.get(uri.toString());
    if (corporate.length === 0 && (!entry || entry.corporate.length === 0)) return;
    this.render(uri, entry?.regulatory ?? [], corporate);
  }

  /** The server's resolutions of the branch's findings; every file's corporate diagnostics are rebuilt. */
  setResolutions(resolutions: readonly Resolution[]) {
    this.resolutions = new Map(resolutions.map((r) => [r.fingerprint, r]));
    for (const { uri, regulatory, corporate } of [...this.byUri.values()]) {
      if (corporate.length > 0) this.render(uri, regulatory, corporate);
    }
  }

  private render(uri: vscode.Uri, regulatory: vscode.Diagnostic[], corporate: readonly CorporateFinding[]) {
    this.byUri.set(uri.toString(), { uri, regulatory, corporate });
    this.collection.set(uri, [...regulatory, ...corporate.map((f) => this.corporateDiagnostic(uri, f))]);
  }

  private corporateDiagnostic(uri: vscode.Uri, f: CorporateFinding): vscode.Diagnostic {
    const range = new vscode.Range(Math.max(0, f.startLine - 1), 0, Math.max(0, f.endLine - 1), 1000);
    const r = this.resolutions.get(f.fingerprint);
    const diagnostic = new vscode.Diagnostic(range, corporateMessage(f, r), CORPORATE_SEVERITY[corporateSeverity(f, r)]);
    diagnostic.source = CORPORATE_SOURCE;
    const target = this.policyLink(f.rule.policyId);
    diagnostic.code = target ? { value: f.policyKey, target } : f.policyKey;
    diagnostic.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(uri, range), ownersText(f))];
    return diagnostic;
  }

  clear() {
    this.byUri.clear();
    this.collection.clear();
  }

  dispose() {
    this.collection.dispose();
  }
}
