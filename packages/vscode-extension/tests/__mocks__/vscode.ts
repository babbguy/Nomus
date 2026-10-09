/**
 * Minimal vscode module mock for unit testing outside VS Code runtime.
 * Provides just enough API surface to test DiagnosticsProvider, FindingsTreeProvider, and StatusBarManager.
 */

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class Range {
  constructor(
    public startLine: number,
    public startChar: number,
    public endLine: number,
    public endChar: number,
  ) {}
}

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Uri {
  constructor(public fsPath: string, public scheme = 'file') {}
  static file(path: string) { return new Uri(path); }
  static parse(str: string) { return new Uri(str, /^([a-zA-Z][\w+.-]*):/.exec(str)?.[1] ?? 'file'); }
  toString() { return this.fsPath; }
}

export class Diagnostic {
  source?: string;
  code?: { value: string; target: Uri };
  relatedInformation?: DiagnosticRelatedInformation[];

  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity,
  ) {}
}

export class DiagnosticRelatedInformation {
  constructor(
    public location: Location,
    public message: string,
  ) {}
}

export class Location {
  constructor(public uri: Uri, public range: Range) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class ThemeIcon {
  constructor(public id: string, public color?: ThemeColor) {}
}

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  fire(data: T) { for (const l of this.listeners) l(data); }
  dispose() { this.listeners = []; }
}

export class TreeItem {
  description?: string;
  tooltip?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  contextValue?: string;
  iconPath?: ThemeIcon;

  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

// Mock language.createDiagnosticCollection
const languages = {
  createDiagnosticCollection: (name: string) => {
    const store = new Map<string, Diagnostic[]>();
    return {
      name,
      set: (uri: Uri, diagnostics: Diagnostic[]) => { store.set(uri.toString(), diagnostics); },
      get: (uri: Uri) => store.get(uri.toString()),
      clear: () => store.clear(),
      dispose: () => store.clear(),
      _store: store,
    };
  },
};

// Mock window
const window = {
  createStatusBarItem: (_alignment: StatusBarAlignment, _priority: number) => {
    const item = {
      text: '',
      tooltip: '',
      command: '',
      backgroundColor: undefined as ThemeColor | undefined,
      show: () => {},
      hide: () => {},
      dispose: () => {},
    };
    return item;
  },
  activeTextEditor: undefined,
  registerTreeDataProvider: () => ({ dispose: () => {} }),
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  withProgress: async (_opts: unknown, task: (progress: unknown) => Promise<void>) => task({}),
  onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
};

// Mock workspace
const workspace = {
  getConfiguration: (_section: string) => ({
    get: <T>(key: string, defaultValue: T) => defaultValue,
  }),
  workspaceFolders: undefined,
  onDidSaveTextDocument: () => ({ dispose: () => {} }),
};

// Mock commands
const commands = {
  registerCommand: (_command: string, _callback: (...args: unknown[]) => unknown) => ({ dispose: () => {} }),
};

// Mock env
const env = {
  openExternal: () => Promise.resolve(true),
};

export {
  languages,
  window,
  workspace,
  commands,
  env,
};

export const ProgressLocation = {
  Notification: 15,
  SourceControl: 1,
  Window: 10,
};
