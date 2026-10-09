// A small stand-in for the VS Code extension host. It provides the parts of
// the `vscode` API the Nomus extension uses, records what the extension
// shows (messages, tree items, diagnostics, opened URLs), and lets the gate
// answer prompts. The real dist/extension.js bundle is loaded against it, so
// the gate exercises the extension's own code: sign-in, API client, views
// and commands.

import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function createHost({ settings, workspaceRoot }) {
  const state = {
    commands: new Map(),
    trees: new Map(),
    uriHandler: null,
    opened: [],
    messages: [],          // { level, text }
    diagnostics: new Map(), // uri string -> Diagnostic[]
    webviewHandlers: [],
    saveHandlers: [],
    quickPick: [],          // queued answers: fn(items) -> item
    inputBox: [],           // queued answers: string
    inputBoxOptions: [],    // the options of each InputBox shown (title, value: a restored draft, …)
    secrets: new Map(),
    globalState: new Map(),
    workspaceState: new Map(),
    statusBar: { text: '' },
  };

  class Disposable { constructor(fn) { this.fn = fn; } dispose() { this.fn?.(); } static from(...d) { return new Disposable(() => d.forEach((x) => x?.dispose?.())); } }
  const disposable = () => new Disposable();

  class EventEmitter {
    constructor() { this.listeners = []; this.event = (l) => { this.listeners.push(l); return new Disposable(() => { this.listeners = this.listeners.filter((x) => x !== l); }); }; }
    fire(v) { for (const l of [...this.listeners]) l(v); }
    dispose() { this.listeners = []; }
  }

  class Uri {
    constructor(scheme, authority, p, query, fragment) { Object.assign(this, { scheme, authority, path: p, query: query ?? '', fragment: fragment ?? '' }); }
    get fsPath() { return this.scheme === 'file' ? path.normalize(this.path.replace(/^\/([A-Za-z]:)/, '$1')) : this.path; }
    toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`; }
    with(c) { return new Uri(c.scheme ?? this.scheme, c.authority ?? this.authority, c.path ?? this.path, c.query ?? this.query, c.fragment ?? this.fragment); }
    static parse(s) {
      const m = /^([a-zA-Z][\w+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(s);
      if (!m) return new Uri('file', '', s);
      return new Uri(m[1], m[2], m[3], m[4], m[5]);
    }
    static file(p) { return new Uri('file', '', p.replace(/\\/g, '/').replace(/^([A-Za-z]:)/, '/$1')); }
    static joinPath(base, ...parts) { return base.with({ path: path.posix.join(base.path, ...parts) }); }
  }

  class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState ?? 0; } }
  class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
  class ThemeColor { constructor(id) { this.id = id; } }
  class MarkdownString {
    constructor(value = '') { this.value = value; }
    appendMarkdown(s) { this.value += s; return this; }
    appendText(s) { this.value += s; return this; }
    appendCodeblock(s) { this.value += `\n\`\`\`\n${s}\n\`\`\`\n`; return this; }
  }
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range { constructor(sl, sc, el, ec) { this.start = new Position(sl, sc); this.end = new Position(el, ec); } }
  class Location { constructor(uri, range) { this.uri = uri; this.range = range; } }
  class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
  class DiagnosticRelatedInformation { constructor(location, message) { this.location = location; this.message = message; } }

  const show = (level) => (text, ...items) => { state.messages.push({ level, text: String(text), items: items.filter((i) => typeof i === 'string') }); return Promise.resolve(undefined); };

  const vscode = {
    Disposable, EventEmitter, Uri, TreeItem, ThemeIcon, ThemeColor, MarkdownString, Position, Range, Location, Diagnostic, DiagnosticRelatedInformation,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    window: {
      showInformationMessage: show('info'),
      showWarningMessage: show('warning'),
      showErrorMessage: show('error'),
      // The queued answer gets the items and the options; with canPickMany it may return an array.
      showQuickPick: async (items, options) => { const a = state.quickPick.shift(); const list = await items; return a ? a(list, options ?? {}) : undefined; },
      showInputBox: async (options) => { state.inputBoxOptions.push(options ?? {}); return state.inputBox.shift(); },
      withProgress: async (_opts, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable() }),
      registerTreeDataProvider: (id, provider) => { state.trees.set(id, provider); return disposable(); },
      createTreeView: (id, opts) => { state.trees.set(id, opts.treeDataProvider); return { dispose() {}, reveal() {} }; },
      registerUriHandler: (h) => { state.uriHandler = h; return disposable(); },
      createStatusBarItem: () => new Proxy(state.statusBar, { get: (t, k) => (k in t ? t[k] : (k === 'show' || k === 'hide' || k === 'dispose' ? () => {} : undefined)), set: (t, k, v) => { t[k] = v; return true; } }),
      createWebviewPanel: () => {
        const panel = {
          webview: { html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, onDidReceiveMessage: (cb) => { state.webviewHandlers.push(cb); return disposable(); }, postMessage: async () => true, options: {} },
          onDidDispose: () => disposable(), onDidChangeViewState: () => disposable(), reveal() {}, dispose() {}, iconPath: undefined, title: '',
        };
        return panel;
      },
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: () => disposable(),
      visibleTextEditors: [],
    },
    workspace: {
      getConfiguration: (section) => ({
        get: (key, def) => { const v = settings[`${section}.${key}`]; return v === undefined ? def : v; },
        has: (key) => settings[`${section}.${key}`] !== undefined,
        update: async (key, value) => { settings[`${section}.${key}`] = value; },
      }),
      workspaceFolders: workspaceRoot ? [{ uri: Uri.file(workspaceRoot), name: path.basename(workspaceRoot), index: 0 }] : undefined,
      onDidSaveTextDocument: (cb) => { state.saveHandlers.push(cb); return disposable(); },
      onDidChangeConfiguration: () => disposable(),
      onDidOpenTextDocument: () => disposable(),
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri, diags) => { state.diagnostics.set(uri.toString(), diags ?? []); },
        delete: (uri) => { state.diagnostics.delete(uri.toString()); },
        clear: () => state.diagnostics.clear(),
        dispose() {},
      }),
    },
    env: { openExternal: async (uri) => { state.opened.push(uri.toString()); return true; }, uriScheme: 'vscode', appName: 'Visual Studio Code' },
    commands: {
      registerCommand: (id, fn) => { state.commands.set(id, fn); return disposable(); },
      executeCommand: async (id, ...args) => (state.commands.has(id) ? state.commands.get(id)(...args) : undefined),
    },
    version: '1.95.0',
  };

  const context = {
    subscriptions: [],
    extensionUri: Uri.file(workspaceRoot ?? process.cwd()),
    extensionPath: workspaceRoot ?? process.cwd(),
    secrets: {
      get: async (k) => state.secrets.get(k),
      store: async (k, v) => { state.secrets.set(k, v); },
      delete: async (k) => { state.secrets.delete(k); },
      onDidChange: () => disposable(),
    },
    globalState: { get: (k, d) => (state.globalState.has(k) ? state.globalState.get(k) : d), update: async (k, v) => { state.globalState.set(k, v); }, keys: () => [...state.globalState.keys()] },
    workspaceState: { get: (k, d) => (state.workspaceState.has(k) ? state.workspaceState.get(k) : d), update: async (k, v) => { if (v === undefined) state.workspaceState.delete(k); else state.workspaceState.set(k, v); }, keys: () => [...state.workspaceState.keys()] },
    asAbsolutePath: (p) => path.join(workspaceRoot ?? process.cwd(), p),
  };

  /** A TextDocument for a file on disk. */
  const document = (file, text, languageId) => ({ uri: Uri.file(file), fileName: file, languageId, getText: () => text, lineCount: text.split('\n').length, isUntitled: false, version: 1 });

  return { vscode, state, context, document };
}

/** Load the bundled extension (CommonJS) with `require('vscode')` answered by the host. */
export function loadExtension(extensionJs, vscode) {
  const origLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'vscode') return vscode;
    return origLoad.call(this, request, ...rest);
  };
  try {
    return createRequire(pathToFileURL(extensionJs))(extensionJs);
  } finally {
    // keep the hook: the bundle may require('vscode') lazily
  }
}

/** Walk a tree data provider and return every item's visible text. */
export async function renderTree(provider, element, depth = 0) {
  const out = [];
  const children = (await provider.getChildren(element)) ?? [];
  for (const child of children) {
    const item = await provider.getTreeItem(child);
    const label = typeof item.label === 'object' ? item.label?.label : item.label;
    const tooltip = typeof item.tooltip === 'object' ? item.tooltip?.value : item.tooltip;
    out.push({ depth, label: String(label), description: item.description === undefined ? '' : String(item.description), tooltip: tooltip === undefined ? '' : String(tooltip) });
    if (item.collapsibleState && depth < 3) out.push(...await renderTree(provider, child, depth + 1));
  }
  return out;
}
