import * as vscode from 'vscode';
import { DiagnosticsProvider } from './diagnostics';
import { FindingsTreeProvider } from './sidebar/findings-provider';
import { ComplianceStatusProvider } from './sidebar/compliance-status-provider';
import { AiBomProvider } from './sidebar/ai-bom-provider';
import { RadarProvider } from './sidebar/radar-provider';
import { StatusBarManager } from './status-bar';
import { scanCurrentFile, scanWorkspace } from './commands';
import { AuthManager } from './auth';
import { WelcomePanel } from './welcome-panel';
import { NomusApiClient } from './api-client';
import { CorporateViewProvider } from './cpg/corporate-view';
import { CorporateController } from './cpg/corporate-controller';
import { CpgClient } from './cpg/cpg-client';
import { CaseTracker } from './cpg/case-status';
import { openCase, replyToChangeRequest, requestReview, resubmit, type CaseCommandDeps } from './cpg/request-review';

let diagnosticsProvider: DiagnosticsProvider;
let findingsProvider: FindingsTreeProvider;
let complianceStatusProvider: ComplianceStatusProvider;
let aiBomProvider: AiBomProvider;
let radarProvider: RadarProvider;
let statusBar: StatusBarManager;
let authManager: AuthManager;
let apiClient: NomusApiClient;
let corporateView: CorporateViewProvider;
let corporate: CorporateController;
let cases: CaseTracker;

export function activate(context: vscode.ExtensionContext) {
  diagnosticsProvider = new DiagnosticsProvider();
  findingsProvider = new FindingsTreeProvider();
  statusBar = new StatusBarManager();
  authManager = new AuthManager(context);

  // API client for sidebar views
  apiClient = new NomusApiClient(() => authManager.getApiKey());
  complianceStatusProvider = new ComplianceStatusProvider(apiClient);
  aiBomProvider = new AiBomProvider(apiClient);
  radarProvider = new RadarProvider(apiClient);

  // Corporate policies (CPG): findings from the org's signed policy bundle,
  // evaluated locally and shown next to the regulatory diagnostics.
  corporateView = new CorporateViewProvider();
  corporate = new CorporateController({
    context,
    getApiKey: () => authManager.getApiKey(),
    diagnostics: diagnosticsProvider,
    view: corporateView,
  });
  // The branch's review case (polled; shown in the same view).
  const cpgClient = new CpgClient(() => authManager.getApiKey());
  cases = new CaseTracker(context, cpgClient);
  context.subscriptions.push(cases.onDidChange((view) => corporateView.setCase(view)));
  const caseDeps: CaseCommandDeps = { context, client: cpgClient, corporate, cases };

  // Register URI handler for auth callbacks
  context.subscriptions.push(vscode.window.registerUriHandler(authManager));

  // Register tree views
  vscode.window.registerTreeDataProvider('nomus.findings', findingsProvider);
  vscode.window.registerTreeDataProvider('nomus.complianceStatus', complianceStatusProvider);
  vscode.window.registerTreeDataProvider('nomus.aiBom', aiBomProvider);
  vscode.window.registerTreeDataProvider('nomus.radar', radarProvider);
  vscode.window.registerTreeDataProvider('nomus.corporate', corporateView);

  // Helper to get API key from auth manager
  const getApiKey = () => authManager.getApiKey();

  // Refresh all sidebar views
  async function refreshAllViews() {
    await Promise.all([
      complianceStatusProvider.refresh(),
      aiBomProvider.refresh(),
      radarProvider.refresh(),
      corporate.refresh(),
      cases.refresh(true),
    ]);
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('nomus.scanFile', () =>
      scanCurrentFile(diagnosticsProvider, findingsProvider, statusBar, undefined, getApiKey, complianceStatusProvider, corporate)),
    vscode.commands.registerCommand('nomus.scanWorkspace', () =>
      scanWorkspace(diagnosticsProvider, findingsProvider, statusBar, getApiKey, complianceStatusProvider, corporate)),
    vscode.commands.registerCommand('nomus.clearDiagnostics', () => {
      diagnosticsProvider.clear();
      corporate.clearDiagnostics();
      findingsProvider.clear();
      statusBar.update(0);
      complianceStatusProvider.setLocalFindings([]);
    }),
    vscode.commands.registerCommand('nomus.openDashboard', () => {
      const config = vscode.workspace.getConfiguration('nomus');
      const dashboardUrl = config.get<string>('dashboardUrl', '');
      if (dashboardUrl) {
        vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
      } else {
        // Derive from API URL using proper URL parsing
        const apiUrl = config.get<string>('apiUrl', 'http://localhost:3100');
        try {
          const parsed = new URL(apiUrl);
          // Remove /api path prefix and adjust port for dev environments
          parsed.pathname = '/';
          if (parsed.port === '3100') parsed.port = '5173';
          if (parsed.hostname.startsWith('api.')) {
            parsed.hostname = parsed.hostname.replace(/^api\./, '');
          }
          vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
        } catch {
          vscode.env.openExternal(vscode.Uri.parse('http://localhost:5173'));
        }
      }
    }),
    vscode.commands.registerCommand('nomus.signIn', () => {
      WelcomePanel.createOrShow(context, authManager);
    }),
    vscode.commands.registerCommand('nomus.signOut', async () => {
      await authManager.signOut();
      statusBar.setAuthState(false);
      WelcomePanel.createOrShow(context, authManager);
    }),
    vscode.commands.registerCommand('nomus.refreshViews', () => refreshAllViews()),
    vscode.commands.registerCommand('nomus.cpg.refresh', async () => {
      // Revalidate the policy bundle now (If-None-Match), then re-check the open file.
      await Promise.all([corporate.refresh(), cases.refresh(true)]);
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) await scanCurrentFile(diagnosticsProvider, findingsProvider, statusBar, doc, getApiKey, complianceStatusProvider, corporate);
    }),
    vscode.commands.registerCommand('nomus.cpg.requestReview', () => requestReview(caseDeps)),
    vscode.commands.registerCommand('nomus.cpg.replyToChangeRequest', (arg?: Parameters<typeof replyToChangeRequest>[1]) => replyToChangeRequest(caseDeps, arg)),
    vscode.commands.registerCommand('nomus.cpg.resubmit', () => resubmit(caseDeps)),
    vscode.commands.registerCommand('nomus.cpg.openCase', () => openCase(caseDeps)),
    vscode.commands.registerCommand('nomus.generateAiBom', async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Nomus: Generating AI-BOM from scan findings...' },
        () => apiClient.post('/api/v1/ai-bom/generate'),
      );
      if (result) {
        const created = (result as { created?: number }).created ?? 0;
        vscode.window.showInformationMessage(`Nomus: AI-BOM generated. ${created} systems detected.`);
        aiBomProvider.refresh();
        complianceStatusProvider.refresh();
      } else {
        vscode.window.showWarningMessage('Nomus: Failed to generate AI-BOM. Are you signed in?');
      }
    }),
    vscode.commands.registerCommand('nomus.runBenchmarks', async () => {
      const model = await vscode.window.showInputBox({
        prompt: 'Model name to benchmark (e.g., gpt-4, claude-3.5-sonnet)',
        placeHolder: 'gpt-4o-mini',
      });
      if (!model) return;
      const provider = await vscode.window.showQuickPick(
        ['openai', 'anthropic', 'google', 'custom'],
        { placeHolder: 'Select provider' },
      );
      if (!provider) return;
      const result = await apiClient.post('/api/v1/benchmarks/run', { modelName: model, provider });
      if (result) {
        vscode.window.showInformationMessage(
          `Nomus: Benchmark run recorded for ${model}. Nomus does not execute benchmarks; run them yourself and upload the results to the run.`,
        );
      } else {
        vscode.window.showWarningMessage('Nomus: Failed to record benchmark run.');
      }
    }),
    vscode.commands.registerCommand('nomus.simulateImpact', async () => {
      const signals = await apiClient.get<{ signals: { id: string; title: string; jurisdiction: string }[] }>('/api/v1/radar');
      if (!signals?.signals?.length) {
        vscode.window.showInformationMessage('Nomus: No regulatory signals to simulate. Check the Radar view.');
        return;
      }
      type SignalPickItem = vscode.QuickPickItem & { id: string };
      const pick = await vscode.window.showQuickPick<SignalPickItem>(
        signals.signals.map((s) => ({ label: s.title, description: s.jurisdiction, id: s.id })),
        { placeHolder: 'Select regulatory signal to simulate' },
      );
      if (!pick) return;
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Nomus: Simulating impact of "${pick.label}"...` },
        () => apiClient.post('/api/v1/simulations/run', { signalId: pick.id }),
      );
      if (result) {
        const sim = result as { systemsImpacted?: number; systemsAnalyzed?: number; overallRiskLevel?: string };
        vscode.window.showInformationMessage(
          `Nomus: Simulation complete. ${sim.systemsImpacted ?? 0}/${sim.systemsAnalyzed ?? 0} systems impacted. Risk: ${sim.overallRiskLevel ?? 'unknown'}.`,
        );
      }
    }),
    vscode.commands.registerCommand('nomus.exportReport', async () => {
      const format = await vscode.window.showQuickPick(['json', 'pdf'], { placeHolder: 'Export format' });
      if (!format) return;
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Nomus: Exporting compliance report...' },
        () => apiClient.get(`/api/v1/ai-bom/export/${format}`),
      );
      if (result) {
        vscode.window.showInformationMessage(`Nomus: Report exported as ${format.toUpperCase()}. Check your dashboard.`);
      }
    }),
    vscode.commands.registerCommand('nomus.showComplianceOverview', () => {
      vscode.commands.executeCommand('nomus.complianceStatus.focus');
    }),
  );

  // React to auth state changes
  context.subscriptions.push(
    authManager.onDidChangeAuth(async (authenticated) => {
      statusBar.setAuthState(authenticated);
      if (authenticated) {
        // Refresh all sidebar views on login
        refreshAllViews();
        if (vscode.window.activeTextEditor) {
          scanCurrentFile(diagnosticsProvider, findingsProvider, statusBar,
            vscode.window.activeTextEditor.document, getApiKey, complianceStatusProvider, corporate);
        }
      } else {
        corporate.reset();
        cases.reset();
      }
    }),
  );

  // Auto-scan on save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const config = vscode.workspace.getConfiguration('nomus');
      if (config.get<boolean>('scanOnSave', true)) {
        scanCurrentFile(diagnosticsProvider, findingsProvider, statusBar, doc, getApiKey, complianceStatusProvider, corporate);
      }
      void cases.refresh(); // at most once a minute
    }),
  );

  // Auto-scan on open (debounced)
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (scanTimer) clearTimeout(scanTimer);
      if (editor) {
        scanTimer = setTimeout(() => {
          const config = vscode.workspace.getConfiguration('nomus');
          if (config.get<boolean>('scanOnOpen', true)) {
            scanCurrentFile(diagnosticsProvider, findingsProvider, statusBar, editor.document, getApiKey, complianceStatusProvider, corporate);
          }
        }, 150);
      }
    }),
  );

  // Register disposables
  context.subscriptions.push(diagnosticsProvider, statusBar, authManager, corporateView, cases);

  // Check auth state on activation
  authManager.isAuthenticated().then((authenticated) => {
    statusBar.setAuthState(authenticated);

    if (!authenticated) {
      const hasActivatedBefore = context.globalState.get<boolean>('nomus.hasActivatedBefore', false);

      if (!hasActivatedBefore) {
        // First activation — show welcome panel
        WelcomePanel.createOrShow(context, authManager);
        context.globalState.update('nomus.hasActivatedBefore', true);
      } else {
        // Subsequent activation — show notification (fallback)
        vscode.window.showInformationMessage(
          'Nomus: Sign in for full compliance analysis.',
          'Sign In',
          'Enter API Key',
        ).then((choice) => {
          if (choice === 'Sign In') authManager.startSignIn();
          else if (choice === 'Enter API Key') authManager.enterApiKeyManually();
        });
      }
    } else {
      // Already authenticated — scan active file and load sidebar views
      refreshAllViews();
      if (vscode.window.activeTextEditor) {
        scanCurrentFile(diagnosticsProvider, findingsProvider, statusBar,
          vscode.window.activeTextEditor.document, getApiKey, complianceStatusProvider, corporate);
      }
    }
  });

  console.log('Nomus Regulatory extension activated');
}

export function deactivate() {
  // cleanup handled by disposables
}
