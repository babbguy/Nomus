import * as vscode from 'vscode';

export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private authenticated = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.command = 'nomus.scanFile';
    this.update(0);
    this.item.show();
  }

  setAuthState(authenticated: boolean) {
    this.authenticated = authenticated;
    if (!authenticated) {
      this.item.text = '$(shield) Nomus: Sign In';
      this.item.command = 'nomus.signIn';
      this.item.backgroundColor = undefined;
      this.item.tooltip = 'Sign in to Nomus for full compliance analysis';
    } else {
      this.item.command = 'nomus.scanFile';
      this.update(0);
    }
  }

  update(count: number) {
    if (!this.authenticated) return;

    if (count === 0) {
      this.item.text = '$(shield) Nomus: Clean';
      this.item.backgroundColor = undefined;
      this.item.tooltip = 'No compliance issues found. Click to re-scan.';
    } else {
      this.item.text = `$(shield) Nomus: ${count} issue${count !== 1 ? 's' : ''}`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.tooltip = `${count} compliance finding(s). Click to re-scan.`;
    }
  }

  dispose() {
    this.item.dispose();
  }
}
