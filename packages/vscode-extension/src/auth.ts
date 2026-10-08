import * as vscode from 'vscode';

const SECRET_KEY = 'nomus.apiKey';
const SECRET_EMAIL = 'nomus.userEmail';
const SECRET_ORG = 'nomus.orgName';

export class AuthManager implements vscode.UriHandler, vscode.Disposable {
  private _onDidChangeAuth = new vscode.EventEmitter<boolean>();
  readonly onDidChangeAuth = this._onDidChangeAuth.event;

  private pendingState: string | null = null;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /** Get stored API key (SecretStorage first, then settings fallback) */
  async getApiKey(): Promise<string | undefined> {
    const secretKey = await this.context.secrets.get(SECRET_KEY);
    if (secretKey) return secretKey;

    // Backward compat: check settings
    const configKey = vscode.workspace.getConfiguration('nomus').get<string>('apiKey', '');
    return configKey || undefined;
  }

  async isAuthenticated(): Promise<boolean> {
    const key = await this.getApiKey();
    return !!key;
  }

  async getUserEmail(): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_EMAIL);
  }

  async getOrgName(): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_ORG);
  }

  /** Start the browser-based sign-in flow */
  startSignIn(): void {
    const config = vscode.workspace.getConfiguration('nomus');
    const apiUrl = config.get<string>('apiUrl', 'http://localhost:3100');

    // Generate CSRF state
    this.pendingState = crypto.randomUUID();

    const callbackUri = 'vscode://nomus.nomus/auth-callback';
    const authorizeUrl = `${apiUrl}/api/v1/auth/device/authorize`
      + `?state=${encodeURIComponent(this.pendingState)}`
      + `&callback_uri=${encodeURIComponent(callbackUri)}`;

    vscode.env.openExternal(vscode.Uri.parse(authorizeUrl));
  }

  /** Handle the vscode:// callback URI from the browser */
  async handleUri(uri: vscode.Uri): Promise<void> {
    const params = new URLSearchParams(uri.query);
    const code = params.get('code');
    const state = params.get('state');

    if (!code || !state) {
      vscode.window.showErrorMessage('Nomus: Invalid auth callback — missing code or state.');
      return;
    }

    if (state !== this.pendingState) {
      vscode.window.showErrorMessage('Nomus: Auth state mismatch — please try signing in again.');
      return;
    }

    this.pendingState = null;

    // Exchange code for API key
    try {
      const config = vscode.workspace.getConfiguration('nomus');
      const apiUrl = config.get<string>('apiUrl', 'http://localhost:3100');

      const response = await fetch(`${apiUrl}/api/v1/auth/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }));
        vscode.window.showErrorMessage(`Nomus: Sign-in failed — ${(err as any).error}`);
        return;
      }

      const data = await response.json() as { apiKey: string; orgName: string; userEmail: string };

      // Store in SecretStorage (encrypted OS keychain)
      await this.context.secrets.store(SECRET_KEY, data.apiKey);
      await this.context.secrets.store(SECRET_EMAIL, data.userEmail);
      await this.context.secrets.store(SECRET_ORG, data.orgName);

      this._onDidChangeAuth.fire(true);
      vscode.window.showInformationMessage(`Nomus: Signed in as ${data.userEmail} (${data.orgName})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Nomus: Sign-in failed — ${msg}`);
    }
  }

  /** Sign out — clear stored credentials */
  async signOut(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    await this.context.secrets.delete(SECRET_EMAIL);
    await this.context.secrets.delete(SECRET_ORG);
    this._onDidChangeAuth.fire(false);
    vscode.window.showInformationMessage('Nomus: Signed out.');
  }

  /** Manually enter an API key */
  async enterApiKeyManually(): Promise<void> {
    const key = await vscode.window.showInputBox({
      prompt: 'Enter your Nomus API key',
      placeHolder: 'NOMUSX_...',
      password: true,
      ignoreFocusOut: true,
    });

    if (key) {
      await this.context.secrets.store(SECRET_KEY, key);
      this._onDidChangeAuth.fire(true);
      vscode.window.showInformationMessage('Nomus: API key saved.');
    }
  }

  dispose() {
    this._onDidChangeAuth.dispose();
  }
}
