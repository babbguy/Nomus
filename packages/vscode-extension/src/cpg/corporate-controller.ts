// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import type { CorporateBundle, CorporateFinding } from '@nomus/scanner';
import type { DiagnosticsProvider } from '../diagnostics';
import { BundleCache, DEFAULT_MAX_CACHE_AGE_HOURS, type BundleState } from './bundle-cache';
import type { CorporateViewProvider } from './corporate-view';
import { readGitContext, type GitContext } from './git-context';
import { formatUtc } from './corporate-format';
import { apiUrlSetting, resolveApiKey } from './cpg-client';

/**
 * Corporate policy findings in the editor (design spec §10, Phase 3:
 * findings only). Owns the verified bundle, the corporate findings per file
 * and the Corporate Policies view; the diagnostics provider renders them in
 * the shared `nomus` collection next to the regulatory diagnostics.
 *
 * VS Code is advisory (brief §4.4) but it fails visibly: an unusable bundle
 * (offline with no cache, expired, rejected by verification, refused by the
 * server) clears every corporate diagnostic and says why, in the view and in
 * an error message. Nothing is uploaded: the bundle is fetched and the rules
 * run locally on the open file or the workspace.
 */

type ApiKeyGetter = () => Promise<string | undefined>;

export interface CorporateControllerOptions {
  context: vscode.ExtensionContext;
  getApiKey: ApiKeyGetter;
  diagnostics: DiagnosticsProvider;
  view: CorporateViewProvider;
  cache?: BundleCache;
  now?: () => Date;
}

/** The sentence with its first letter capitalized. */
export const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const ERROR_KINDS = new Set<BundleState['kind']>(['unavailable', 'expired', 'rejected', 'denied']);

export class CorporateController {
  private readonly context: vscode.ExtensionContext;
  private readonly getApiKey: ApiKeyGetter;
  private readonly diagnostics: DiagnosticsProvider;
  private readonly view: CorporateViewProvider;
  private readonly cache: BundleCache;
  private readonly now: () => Date;
  private state: BundleState | null = null;
  /** uri string → findings of that file, computed with the bundle whose hash is `findingsBundleHash`. */
  private readonly findings = new Map<string, { uri: vscode.Uri; findings: CorporateFinding[] }>();
  private findingsBundleHash: string | null = null;
  /** A file was checked with the current bundle (so an empty list means no findings). */
  private checked = false;
  private repository: GitContext | null = null;
  private lastNotified: string | null = null;
  private unavailableShown = false;
  /** While held (a scan in progress), error notices wait here for the scan to report them in one message. */
  private held: string[] | null = null;

  constructor(opts: CorporateControllerOptions) {
    this.context = opts.context;
    this.getApiKey = opts.getApiKey;
    this.diagnostics = opts.diagnostics;
    this.view = opts.view;
    this.now = opts.now ?? (() => new Date());
    this.cache = opts.cache ?? new BundleCache({
      store: opts.context.globalState,
      now: this.now,
      maxAgeHours: () => {
        const h = vscode.workspace.getConfiguration('nomus').get<number>('corporate.maxCacheAgeHours', DEFAULT_MAX_CACHE_AGE_HOURS);
        return typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : DEFAULT_MAX_CACHE_AGE_HOURS;
      },
    });
  }

  private enabledSetting(): boolean {
    return vscode.workspace.getConfiguration('nomus').get<boolean>('corporate.enabled', true) !== false;
  }

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Drop every corporate diagnostic and finding (bundle unusable, signed out, or a new bundle). */
  private clearFindings(): void {
    for (const { uri } of this.findings.values()) this.diagnostics.setCorporateFindings(uri, []);
    this.findings.clear();
    this.findingsBundleHash = null;
    this.checked = false;
  }

  private render(): void {
    if (!this.enabledSetting()) {
      this.view.setState({ kind: 'off', reason: 'setting' });
      return;
    }
    if (!this.state) {
      this.view.setState({ kind: 'off', reason: 'signed_out' });
      return;
    }
    this.view.setState({
      kind: 'bundle',
      bundle: this.state,
      findings: [...this.findings.values()].flatMap((e) => e.findings),
      checked: this.checked,
      repository: this.repository,
    });
  }

  /** An error notice (a sentence without the "Nomus: " prefix): shown now, or held for the scan's one message. */
  private report(text: string): void {
    if (this.held) this.held.push(text);
    else void vscode.window.showErrorMessage(`Nomus: ${text}`);
  }

  /**
   * Hold error notices until `releaseNotices()`: a scan then reports them
   * together with its own result in one notification. The caller must
   * release them (in a `finally`), so nothing is ever dropped.
   */
  holdNotices(): void {
    this.held ??= [];
  }

  /** The held notices, oldest first; notices are shown immediately again. */
  releaseNotices(): string[] {
    const notices = this.held ?? [];
    this.held = null;
    return notices;
  }

  /** When the findings shown come from a cached bundle (offline): one sentence saying so, else null. */
  cachedNote(): string | null {
    return this.state?.kind === 'offline' ? `Corporate policy findings are shown from the policy bundle cached ${formatUtc(this.state.fetchedAt)}.` : null;
  }

  /** One notice per load: a discarded cache and the state it left are reported together. */
  private notify(state: BundleState, discarded: string | null): void {
    const discardedText = discarded ? `the cached corporate policy bundle failed verification and was discarded (${discarded}).` : null;
    const key = state.kind;
    let stateText: string | null = null;
    if (!ERROR_KINDS.has(key)) {
      this.lastNotified = null;
    } else if (this.lastNotified !== key || discardedText) {
      this.lastNotified = key;
      switch (state.kind) {
        case 'unavailable':
          // Once per session (§10.5), unless it explains a discarded cache.
          if (this.unavailableShown && !discardedText) break;
          this.unavailableShown = true;
          stateText = discardedText
            ? `No fresh bundle could be downloaded (${state.reason}), so corporate policy findings cannot be shown.`
            : `the corporate policy bundle is unavailable (${state.reason}). Corporate policy findings cannot be shown.`;
          break;
        case 'expired':
          stateText = `the cached corporate policy bundle (from ${formatUtc(state.fetchedAt)}) is too old to use offline. Corporate policy findings are hidden until it can be refreshed.`;
          break;
        case 'rejected':
          stateText = `the corporate policy bundle was rejected (${state.reason}). Corporate policy findings are not shown.`;
          break;
        case 'denied':
          stateText = `the server refused the corporate policy bundle (HTTP ${state.status}). Sign in again to see corporate policy findings.`;
          break;
      }
    }
    if (discardedText) {
      const after = state.kind === 'verified' ? 'A fresh bundle was downloaded and verified.' : stateText && sentenceCase(stateText);
      this.report(after ? `${discardedText} ${after}` : discardedText);
    } else if (stateText) {
      this.report(stateText);
    }
  }

  /**
   * Load (or revalidate) the bundle and update the state, the view and the
   * notifications. Returns the bundle to evaluate, or null when corporate
   * policies do not apply (off, signed out, not enabled, not supported) or
   * cannot be evaluated (every error state; corporate diagnostics are then cleared).
   */
  async ensureBundle(force = false): Promise<CorporateBundle | null> {
    if (!this.enabledSetting()) {
      this.clearFindings();
      this.state = null;
      this.render();
      return null;
    }
    const apiKey = await resolveApiKey(this.getApiKey);
    if (!apiKey) {
      this.clearFindings();
      this.state = null;
      this.render();
      return null;
    }
    const root = this.workspaceRoot();
    this.repository = root ? await readGitContext(root) : null;
    const { state, discardedCache } = await this.cache.load(apiUrlSetting(), apiKey, { force });
    this.state = state;
    this.notify(state, discardedCache);
    const usable = (state.kind === 'verified' || state.kind === 'offline') && state.bundle.enabled ? state.bundle : null;
    if (!usable || usable.bundleHash !== this.findingsBundleHash) this.clearFindings();
    if (usable) this.findingsBundleHash = usable.bundleHash;
    this.render();
    return usable;
  }

  /** Corporate findings of one open document ([] when corporate policies do not apply). Never throws. */
  async evaluateDocument(document: vscode.TextDocument): Promise<CorporateFinding[]> {
    try {
      const root = this.workspaceRoot();
      if (!root || document.uri.scheme !== 'file') return [];
      const bundle = await this.ensureBundle();
      if (!bundle) return [];
      const { runCorporateScan } = await import('@nomus/scanner');
      const outcome = await runCorporateScan([[document.fileName, document.getText()]], root, bundle, { now: this.now() });
      const findings = outcome.findings.filter((f) => f.file === document.fileName);
      this.findings.set(document.uri.toString(), { uri: document.uri, findings });
      this.checked = true;
      this.render();
      return findings;
    } catch (err) {
      // Not a bundle problem (those are states): surface it, and show nothing stale.
      this.findings.delete(document.uri.toString());
      this.render();
      this.report(`corporate policy check failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** The bundle a workspace scan should use, or null to scan without corporate policies. Never throws. */
  async bundleForWorkspaceScan(): Promise<CorporateBundle | null> {
    try {
      return await this.ensureBundle();
    } catch (err) {
      this.clearFindings();
      this.render();
      this.report(`corporate policy check failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Corporate findings of a workspace scan: replaces every file's corporate diagnostics. */
  applyWorkspaceFindings(findings: readonly CorporateFinding[]): void {
    const byFile = new Map<string, { uri: vscode.Uri; findings: CorporateFinding[] }>();
    for (const f of findings) {
      const uri = vscode.Uri.file(f.file);
      const entry = byFile.get(uri.toString()) ?? { uri, findings: [] };
      entry.findings.push(f);
      byFile.set(uri.toString(), entry);
    }
    for (const [key, { uri }] of this.findings) {
      if (!byFile.has(key)) this.diagnostics.setCorporateFindings(uri, []);
    }
    this.findings.clear();
    for (const [key, entry] of byFile) {
      this.findings.set(key, entry);
      this.diagnostics.setCorporateFindings(entry.uri, entry.findings);
    }
    this.checked = true;
    this.render();
  }

  /** `nomus.cpg.refresh` and `nomus.refreshViews`: revalidate the bundle now. Never throws. */
  async refresh(): Promise<void> {
    try {
      await this.ensureBundle(true);
    } catch (err) {
      this.clearFindings();
      this.render();
      void vscode.window.showErrorMessage(`Nomus: corporate policy refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Signed out, or diagnostics cleared by the user. */
  reset(): void {
    this.clearFindings();
    this.state = null;
    this.lastNotified = null;
    this.render();
  }

  clearDiagnostics(): void {
    this.findings.clear();
    this.render();
  }
}
