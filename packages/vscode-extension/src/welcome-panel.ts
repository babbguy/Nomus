import * as vscode from 'vscode';
import { AuthManager } from './auth';

export class WelcomePanel {
  private static instance: WelcomePanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private authManager: AuthManager,
    extensionUri: vscode.Uri,
  ) {
    this.panel = panel;

    const logoWideUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'logo-wide.svg'),
    );
    const iconUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg'),
    );

    this.panel.webview.html = getHtmlContent(logoWideUri, iconUri);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'signIn':
            this.authManager.startSignIn();
            break;
          case 'enterApiKey':
            await this.authManager.enterApiKeyManually();
            break;
        }
      },
      undefined,
      this.disposables,
    );

    // Auto-close when auth succeeds
    this.disposables.push(
      this.authManager.onDidChangeAuth((authenticated) => {
        if (authenticated) {
          this.dispose();
        }
      }),
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static createOrShow(context: vscode.ExtensionContext, authManager: AuthManager): void {
    if (WelcomePanel.instance) {
      WelcomePanel.instance.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'nomus.welcome',
      'Nomus AI Compliance',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    WelcomePanel.instance = new WelcomePanel(panel, authManager, context.extensionUri);
  }

  dispose(): void {
    WelcomePanel.instance = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.panel.dispose();
  }
}

function getHtmlContent(logoWideUri: vscode.Uri, iconUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src ${logoWideUri.scheme}://*;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .container {
      max-width: 480px;
      text-align: center;
      padding: 40px;
    }
    .logo-wide {
      max-width: 280px;
      height: auto;
      margin: 0 auto 8px;
      display: block;
    }
    .subtitle {
      font-size: 14px;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 32px;
    }
    .features {
      text-align: left;
      margin: 0 auto 32px;
      max-width: 360px;
    }
    .feature {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 10px 0;
      font-size: 13px;
    }
    .feature-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: var(--vscode-badge-background, #0078d4);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .feature-icon svg {
      width: 18px;
      height: 18px;
      fill: var(--vscode-badge-foreground, #fff);
    }
    .feature-text strong {
      display: block;
      margin-bottom: 2px;
    }
    .feature-text span {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .sign-in-btn {
      display: inline-block;
      padding: 10px 32px;
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-button-foreground, #fff);
      background: var(--vscode-button-background, #0078d4);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .sign-in-btn:hover {
      opacity: 0.9;
    }
    .footer {
      margin-top: 16px;
      font-size: 12px;
    }
    .footer a {
      color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: none;
      cursor: pointer;
    }
    .footer a:hover {
      text-decoration: underline;
    }
    .divider {
      border: none;
      border-top: 1px solid var(--vscode-widget-border, #333);
      margin: 24px 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <img src="${logoWideUri}" alt="Nomus" class="logo-wide" />
    <p class="subtitle">Real-time regulatory applicability mapping for AI SDKs</p>

    <div class="features">
      <div class="feature">
        <div class="feature-icon">
          <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
        </div>
        <div class="feature-text">
          <strong>Detect AI SDK Usage</strong>
          <span>Scans for Anthropic, OpenAI, Google AI, AWS Bedrock, and more</span>
        </div>
      </div>
      <div class="feature">
        <div class="feature-icon">
          <svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 9h-2V7h2v4zm0 4h-2v-2h2v2zm-3-1H8v-2h2v2zm0-4H8V7h2v4zm6 4h-2v-2h2v2zm0-4h-2V7h2v4z"/></svg>
        </div>
        <div class="feature-text">
          <strong>Regulatory Rules</strong>
          <span>EU AI Act, NIST AI RMF, US Executive Orders, and more</span>
        </div>
      </div>
      <div class="feature">
        <div class="feature-icon">
          <svg viewBox="0 0 24 24"><path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/></svg>
        </div>
        <div class="feature-text">
          <strong>Actionable Guidance</strong>
          <span>Fix suggestions and legal references for every finding</span>
        </div>
      </div>
    </div>

    <button class="sign-in-btn" id="signIn">Sign In to Nomus</button>

    <hr class="divider">

    <p class="footer">
      <a href="#" id="enterApiKey">Or enter an API key manually</a>
    </p>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('signIn').addEventListener('click', () => {
      vscode.postMessage({ command: 'signIn' });
    });
    document.getElementById('enterApiKey').addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ command: 'enterApiKey' });
    });
  </script>
</body>
</html>`;
}
