import * as vscode from 'vscode';
import { DiagnosticsProvider, type DiagnosticFinding } from './diagnostics';
import { FindingsTreeProvider } from './sidebar/findings-provider';
import { ComplianceStatusProvider } from './sidebar/compliance-status-provider';
import { StatusBarManager } from './status-bar';
import { loadWorkspaceConfig, WorkspaceConfigError } from './workspace-config';
import type { CorporateController } from './cpg/corporate-controller';

const SUPPORTED_LANGUAGES = new Set([
  'typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'python', 'java', 'go',
]);

type ApiKeyGetter = () => Promise<string | undefined>;

/**
 * Name-based check for @nomus/scanner's NomusApiError (mirrors the
 * scanner's own `isNomusApiError` guard). Checked by name rather than a
 * static `instanceof` import so the scanner stays lazily loaded via the
 * dynamic imports below.
 *
 * When this matches, the Nomus API failed and compliance status is
 * UNKNOWN — we must show an error and must NOT render a clean/green state.
 * (Distinct from the intentional offline import-only mode, which is the
 * explicit no-API-key path, not an error fallback.)
 */
function isNomusApiError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NomusApiError';
}

export async function scanCurrentFile(
  diagnostics: DiagnosticsProvider,
  findings: FindingsTreeProvider,
  statusBar: StatusBarManager,
  doc?: vscode.TextDocument,
  getApiKey?: ApiKeyGetter,
  complianceStatus?: ComplianceStatusProvider,
  corporate?: CorporateController,
) {
  const document = doc ?? vscode.window.activeTextEditor?.document;
  if (!document) return;
  if (!SUPPORTED_LANGUAGES.has(document.languageId)) {
    // Corporate policies can cover any file (a model name in a config file);
    // regulatory scanning stays limited to the supported languages.
    if (corporate) diagnostics.setCorporateFindings(document.uri, await corporate.evaluateDocument(document));
    return;
  }

  // Corporate findings first: they do not depend on the regulatory API, so an
  // API failure below still leaves them shown (they render in the same set call).
  const corporateFindings = corporate ? await corporate.evaluateDocument(document) : undefined;

  try {
    const { detectImportsInContent } = await import('@nomus/scanner/detect');
    const { mapCapabilities, getAllCapabilities } = await import('@nomus/scanner/capabilities');

    const content = document.getText();
    const imports = detectImportsInContent(content, document.fileName);

    if (imports.length === 0) {
      diagnostics.setFindings(document.uri, [], corporateFindings);
      findings.setFindings([]);
      statusBar.update(0);
      complianceStatus?.setLocalFindings([]);
      return;
    }

    const capabilities = mapCapabilities(imports);
    const allCaps = getAllCapabilities(capabilities);

    // Resolve API key: SecretStorage → settings fallback
    const apiKey = (await getApiKey?.()) ?? vscode.workspace.getConfiguration('nomus').get<string>('apiKey', '') ?? '';

    let diagnosticFindings: DiagnosticFinding[];

    if (apiKey) {
      const config = vscode.workspace.getConfiguration('nomus');
      const { runScanFromContents } = await import('@nomus/scanner');
      const files = new Map([[document.fileName, content]]);
      const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.';
      const apiUrl = config.get<string>('apiUrl', 'http://localhost:3100');
      // The workspace's .nomus.yml takes precedence over the jurisdictions setting.
      const workspaceConfig = await loadWorkspaceConfig(rootDir, apiKey, apiUrl);
      const jurisdictions = workspaceConfig?.jurisdictions ?? config.get<string[]>('jurisdictions', ['EU']);
      const result = await runScanFromContents(files, {
        rootDir,
        apiKey,
        apiUrl,
        jurisdictions,
        config: workspaceConfig ?? { jurisdictions, api_key: apiKey, api_url: apiUrl },
      });

      diagnosticFindings = result.findings.map((f) => ({
        file: f.file,
        line: f.line,
        sdk: f.sdk,
        severity: f.rule.severity,
        ruleKey: f.rule.ruleKey,
        humanSummary: f.rule.humanSummary,
        legalReference: f.rule.legalReference,
        suggestion: f.suggestion,
        detectorSource: f.detectorSource,
      }));
    } else {
      // Offline mode — show import detections as informational
      diagnosticFindings = imports.map((imp) => ({
        file: imp.file,
        line: imp.line,
        sdk: imp.sdk,
        severity: 'medium',
        ruleKey: 'scan.ai_sdk_detected',
        humanSummary: `AI SDK "${imp.sdk}" detected — sign in to Nomus for full compliance analysis`,
        legalReference: '',
      }));
    }

    console.log(`Nomus: ${diagnosticFindings.length} finding(s) in ${document.fileName}`);
    diagnostics.setFindings(document.uri, diagnosticFindings, corporateFindings);
    findings.setFindings(diagnosticFindings);
    statusBar.update(diagnosticFindings.length);
    complianceStatus?.setLocalFindings(diagnosticFindings);
  } catch (err) {
    // Fail closed: leave existing regulatory diagnostics/status untouched (no
    // green state). Corporate findings were computed independently.
    if (corporateFindings) diagnostics.setCorporateFindings(document.uri, corporateFindings);
    if (err instanceof WorkspaceConfigError) {
      vscode.window.showErrorMessage(`Nomus: cannot use the workspace configuration — ${err.message}`);
      return;
    }
    if (isNomusApiError(err)) {
      console.error('Nomus API unreachable:', err);
      vscode.window.showErrorMessage('Nomus API unreachable — results unavailable. Compliance status is unknown.');
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Nomus scan error:', err);
    vscode.window.showErrorMessage(`Nomus scan error: ${msg}`);
  }
}

export async function scanWorkspace(
  diagnostics: DiagnosticsProvider,
  findingsProvider: FindingsTreeProvider,
  statusBar: StatusBarManager,
  getApiKey?: ApiKeyGetter,
  complianceStatus?: ComplianceStatusProvider,
  corporate?: CorporateController,
) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage('No workspace folder open');
    return;
  }

  const config = vscode.workspace.getConfiguration('nomus');
  const apiKey = (await getApiKey?.()) ?? config.get<string>('apiKey', '') ?? '';

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Nomus: Scanning workspace...',
    cancellable: false,
  }, async () => {
    try {
      // The verified bundle (or none): the scan never fetches one itself here,
      // so an unusable bundle is reported once, by the controller.
      const corporateBundle = corporate ? await corporate.bundleForWorkspaceScan() : null;
      const { runScan } = await import('@nomus/scanner');
      // The workspace's .nomus.yml takes precedence over the jurisdictions setting.
      const workspaceConfig = await loadWorkspaceConfig(
        folder.uri.fsPath,
        apiKey || undefined,
        config.get<string>('apiUrl', 'http://localhost:3100'),
      );
      const jurisdictions = workspaceConfig?.jurisdictions ?? config.get<string[]>('jurisdictions', ['EU']);
      const result = await runScan({
        rootDir: folder.uri.fsPath,
        apiKey: apiKey || undefined,
        apiUrl: config.get<string>('apiUrl'),
        failOn: config.get<string>('failOn', 'medium'),
        jurisdictions,
        ...(corporateBundle ? { corporate: { mode: 'auto' as const, bundle: corporateBundle } } : {}),
        ...(workspaceConfig ? { config: workspaceConfig } : apiKey ? {
          config: {
            jurisdictions,
            api_key: apiKey,
            api_url: config.get<string>('apiUrl', 'http://localhost:3100'),
          },
        } : {}),
      });

      const byFile = new Map<string, DiagnosticFinding[]>();
      for (const f of result.findings) {
        const finding: DiagnosticFinding = {
          file: f.file,
          line: f.line,
          sdk: f.sdk,
          severity: f.rule.severity,
          ruleKey: f.rule.ruleKey,
          humanSummary: f.rule.humanSummary,
          legalReference: f.rule.legalReference,
          suggestion: f.suggestion,
          detectorSource: f.detectorSource,
        };
        const arr = byFile.get(f.file) ?? [];
        arr.push(finding);
        byFile.set(f.file, arr);
      }

      for (const [file, fileFindings] of byFile) {
        diagnostics.setFindings(vscode.Uri.file(file), fileFindings);
      }

      if (corporate && corporateBundle) corporate.applyWorkspaceFindings(result.corporateFindings);

      const allFindings = Array.from(byFile.values()).flat();
      findingsProvider.setFindings(allFindings);
      statusBar.update(result.counts.total);
      complianceStatus?.setLocalFindings(allFindings);

      vscode.window.showInformationMessage(
        `Nomus: Scanned ${result.fileCount} files — ${result.counts.total} finding(s) (${result.counts.critical} critical, ${result.counts.high} high)`
      );
    } catch (err) {
      // Fail closed: leave existing diagnostics/status untouched (no green state).
      if (err instanceof WorkspaceConfigError) {
        vscode.window.showErrorMessage(`Nomus: cannot use the workspace configuration — ${err.message}`);
        return;
      }
      if (isNomusApiError(err)) {
        vscode.window.showErrorMessage('Nomus API unreachable — results unavailable. Compliance status is unknown.');
        return;
      }
      vscode.window.showErrorMessage(`Nomus scan failed: ${(err as Error).message}`);
    }
  });
}
