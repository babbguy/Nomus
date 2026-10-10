import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { CorporateController } from '../src/cpg/corporate-controller';
import { CorporateViewProvider } from '../src/cpg/corporate-view';
import { DiagnosticsProvider } from '../src/diagnostics';
import type { BundleCache, BundleLoad } from '../src/cpg/bundle-cache';
import { signedBundle, signedPolicy } from './helpers/corporate';

const BUNDLE = signedBundle([signedPolicy()]);
const verified: BundleLoad = { state: { kind: 'verified', bundle: BUNDLE, fetchedAt: '2026-10-09T09:41:00.000Z', checkedAt: '2026-10-09T09:41:00.000Z' }, discardedCache: null };

let root: string;
let loads: BundleLoad[];
let errors: string[];
let apiKey: string | undefined;

function setup() {
  const diagnostics = new DiagnosticsProvider(() => undefined);
  const view = new CorporateViewProvider();
  const cache = { load: vi.fn(async () => loads.shift() ?? verified) } as unknown as BundleCache;
  const controller = new CorporateController({
    context: { globalState: { get: () => undefined, update: async () => {} } } as unknown as vscode.ExtensionContext,
    getApiKey: async () => apiKey, diagnostics, view, cache, now: () => new Date('2026-10-09T12:00:00.000Z'),
  });
  const store = (diagnostics as unknown as { collection: { _store: Map<string, any[]> } }).collection._store;
  return { controller, view, cache, store };
}
const doc = (rel: string, text: string) => ({ uri: vscode.Uri.file(join(root, rel)), fileName: join(root, rel), getText: () => text, languageId: 'typescript' }) as unknown as vscode.TextDocument;

// The controller loads the scanner lazily; load it once up front (it is large) so no test pays for it.
beforeAll(async () => { await import('@nomus/scanner'); }, 120_000);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nomus-ctl-'));
  (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'p', index: 0 }];
  loads = [];
  errors = [];
  apiKey = 'nk_live_test';
  vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation(((m: string) => { errors.push(m); return Promise.resolve(undefined); }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('CorporateController (Phase 3: findings only)', () => {
  it('evaluates an open document locally with the verified bundle', async () => {
    const { controller, view } = setup();
    const found = await controller.evaluateDocument(doc('src/models.ts', "export const m = 'gpt-4-32k';\n"));
    expect(found.map((f) => [f.policyKey, f.filePath, f.startLine, f.status, f.blocking])).toEqual([['corp.no-direct-openai', 'src/models.ts', 1, 'needs_review', true]]);
    const state = view.getState();
    expect(state.kind === 'bundle' && state.findings.length).toBe(1);
    expect(errors).toEqual([]);
  });

  it('signed out: no fetch, no findings, the view asks to sign in', async () => {
    apiKey = undefined;
    const { controller, view, cache } = setup();
    expect(await controller.evaluateDocument(doc('a.ts', 'gpt-4-32k'))).toEqual([]);
    expect(cache.load).not.toHaveBeenCalled();
    expect(view.getState()).toEqual({ kind: 'off', reason: 'signed_out' });
  });

  it('an unusable bundle clears every corporate diagnostic and says so, once per state', async () => {
    const { controller, store } = setup();
    const d = doc('src/models.ts', "export const m = 'gpt-4-32k';\n");
    const found = await controller.evaluateDocument(d);
    // what commands.ts does with the result
    (controller as unknown as { diagnostics: DiagnosticsProvider }).diagnostics.setFindings(d.uri, [], found);
    expect(store.get(d.uri.toString())).toHaveLength(1);

    loads = [
      { state: { kind: 'rejected', reason: 'The corporate policy bundle signature does not verify' }, discardedCache: null },
      { state: { kind: 'rejected', reason: 'The corporate policy bundle signature does not verify' }, discardedCache: null },
    ];
    expect(await controller.evaluateDocument(d)).toEqual([]);
    expect(store.get(d.uri.toString())).toEqual([]);
    await controller.evaluateDocument(d);
    expect(errors.filter((e) => /was rejected/.test(e))).toHaveLength(1);
  });

  it('a discarded (tampered) cache is reported even when a fresh bundle replaced it', async () => {
    const { controller } = setup();
    loads = [{ ...verified, discardedCache: 'The corporate policy bundle hash does not match its policies' }];
    await controller.evaluateDocument(doc('a.ts', 'x'));
    expect(errors).toEqual(['Nomus: the cached corporate policy bundle failed verification and was discarded (The corporate policy bundle hash does not match its policies). A fresh bundle was downloaded and verified.']);
  });

  it('a discarded cache with no fresh bundle (offline) is one notice, not two', async () => {
    const { controller } = setup();
    loads = [{ state: { kind: 'unavailable', reason: 'Could not reach the endpoint' }, discardedCache: 'The corporate policy bundle hash does not match its policies' }];
    await controller.evaluateDocument(doc('a.ts', 'x'));
    expect(errors).toEqual(['Nomus: the cached corporate policy bundle failed verification and was discarded (The corporate policy bundle hash does not match its policies). '
      + 'No fresh bundle could be downloaded (Could not reach the endpoint), so corporate policy findings cannot be shown.']);
  });

  it('held notices wait for the scan and come back in order; nothing is shown or dropped meanwhile', async () => {
    const { controller } = setup();
    loads = [
      { state: { kind: 'expired', fetchedAt: '2026-10-01T00:00:00.000Z', reason: 'x' }, discardedCache: null },
      { state: { kind: 'denied', status: 401, reason: 'x' }, discardedCache: null },
    ];
    controller.holdNotices();
    await controller.evaluateDocument(doc('a.ts', 'x'));
    await controller.evaluateDocument(doc('a.ts', 'x'));
    expect(errors).toEqual([]);
    expect(controller.releaseNotices()).toEqual([
      'the cached corporate policy bundle (from 2026-10-01 00:00 UTC) is too old to use offline. Corporate policy findings are hidden until it can be refreshed.',
      'the server refused the corporate policy bundle (HTTP 401). Sign in again to see corporate policy findings.',
    ]);
    loads = [{ state: { kind: 'rejected', reason: 'bad signature' }, discardedCache: null }];
    await controller.evaluateDocument(doc('a.ts', 'x'));
    expect(errors).toEqual(['Nomus: the corporate policy bundle was rejected (bad signature). Corporate policy findings are not shown.']);
  });

  it('cachedNote says when the findings come from the offline cache, and only then', async () => {
    const { controller } = setup();
    await controller.evaluateDocument(doc('a.ts', 'x'));
    expect(controller.cachedNote()).toBeNull();
    loads = [{ state: { kind: 'offline', bundle: BUNDLE, fetchedAt: '2026-10-09T09:41:00.000Z', reason: 'Could not reach' }, discardedCache: null }];
    await controller.evaluateDocument(doc('a.ts', 'x'));
    expect(controller.cachedNote()).toBe('Corporate policy findings are shown from the policy bundle cached 2026-10-09 09:41 UTC.');
  });

  it('unavailable is reported once per session; expired and denied each say what to do', async () => {
    const { controller } = setup();
    loads = [
      { state: { kind: 'unavailable', reason: 'Could not reach' }, discardedCache: null },
      verified,
      { state: { kind: 'unavailable', reason: 'Could not reach' }, discardedCache: null },
      { state: { kind: 'expired', fetchedAt: '2026-10-01T00:00:00.000Z', reason: 'x' }, discardedCache: null },
      { state: { kind: 'denied', status: 401, reason: 'x' }, discardedCache: null },
    ];
    for (let i = 0; i < 5; i++) await controller.evaluateDocument(doc('a.ts', 'x'));
    expect(errors.filter((e) => /unavailable/.test(e))).toHaveLength(1);
    expect(errors.some((e) => /too old to use offline/.test(e))).toBe(true);
    expect(errors.some((e) => /HTTP 401\)\. Sign in again/.test(e))).toBe(true);
  });

  it('a disabled org or an engine without CPG: no findings and no error', async () => {
    const { controller, view } = setup();
    loads = [{ state: { ...verified.state, bundle: signedBundle([], false) } as BundleLoad['state'], discardedCache: null }, { state: { kind: 'not_supported' }, discardedCache: null }];
    expect(await controller.evaluateDocument(doc('a.ts', 'gpt-4-32k'))).toEqual([]);
    expect(await controller.evaluateDocument(doc('a.ts', 'gpt-4-32k'))).toEqual([]);
    expect(errors).toEqual([]);
    const s = view.getState();
    expect(s.kind === 'bundle' && s.bundle.kind).toBe('not_supported');
  });

  it('a new bundle (different hash) drops findings computed with the old one', async () => {
    const { controller, view } = setup();
    await controller.evaluateDocument(doc('src/a.ts', 'gpt-4-32k'));
    const other = signedBundle([signedPolicy('corp.other', { policyId: '9c8b7a6f-5e4d-4c3b-8a29-1f0e9d8c7b6a' })]);
    loads = [{ state: { kind: 'verified', bundle: other, fetchedAt: '2026-10-09T12:00:00.000Z', checkedAt: '2026-10-09T12:00:00.000Z' }, discardedCache: null }];
    await controller.refresh();
    const s = view.getState();
    expect(s.kind === 'bundle' && s.findings.length).toBe(0);
  });

  it('nomus.corporate.enabled=false: nothing is fetched and the view says the checks are off', async () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: (k: string, d: unknown) => (k === 'corporate.enabled' ? false : d) } as never);
    const { controller, view, cache } = setup();
    expect(await controller.evaluateDocument(doc('a.ts', 'gpt-4-32k'))).toEqual([]);
    expect(cache.load).not.toHaveBeenCalled();
    expect(view.getState()).toEqual({ kind: 'off', reason: 'setting' });
  });
});
