/**
 * headless-fetch — the ACCESS-ESCALATION automated tier.
 *
 * The browser is ALWAYS mocked: these tests never launch real Chromium, so the
 * whole suite passes with NO browser binary installed (the CI-safety contract).
 * Two mocking styles are exercised:
 *   • an injected `chromiumLoader` (clean, no module resolution), and
 *   • vi.mock('playwright-core') — proving the LAZY-IMPORTED module is what gets
 *     driven, and that importing this file needs no browser.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// The lazy-imported playwright-core module, mocked. Only the "lazy import" test
// (which uses the default loader) drives this; every other test injects its own
// chromiumLoader and never touches this mock.
const lazy = vi.hoisted(() => ({ chromium: null as unknown }));
vi.mock('playwright-core', () => ({ get chromium() { return lazy.chromium; } }));

import { fetchHeadless, looksLikeChallenge, type ChromiumLoader } from './headless-fetch.js';

const LEGAL_PARA =
  'The provider of a covered artificial intelligence system that is made available to a California ' +
  'resident shall include a clear and conspicuous disclosure identifying content as generated or ' +
  'substantially modified by the system, retain documentation of the training data provenance, and ' +
  'make available a free public detection tool. Nothing in this section relieves a provider of any ' +
  'other obligation imposed by law with respect to the transparency of artificial intelligence.';

/** A realistic rendered document: passes validateContent (>500 chars, >100 words). */
function renderedBillHtml(): string {
  return `<!DOCTYPE html><html><head><title>AB-2013 Bill Text</title></head><body>` +
    `<div id="bill_all"><h1>Assembly Bill No. 2013</h1>` +
    `<p>${LEGAL_PARA}</p><p>${LEGAL_PARA}</p><p>${LEGAL_PARA}</p></div></body></html>`;
}

interface FakeOpts {
  html?: string;
  title?: string;
  status?: number;
  launchThrows?: string;
  gotoThrows?: string;
  proxyBox?: { server?: string };
  teardown?: { context: boolean; browser: boolean };
}

/** Build a structural playwright chromium double. Never touches a real browser. */
function fakeChromium(opts: FakeOpts) {
  return {
    launch: vi.fn(async (launchOpts: Record<string, unknown>) => {
      if (opts.proxyBox) opts.proxyBox.server = (launchOpts.proxy as { server?: string })?.server;
      if (opts.launchThrows) throw new Error(opts.launchThrows);
      return {
        newContext: vi.fn(async () => ({
          newPage: vi.fn(async () => ({
            goto: vi.fn(async () => {
              if (opts.gotoThrows) throw new Error(opts.gotoThrows);
              return { status: () => opts.status ?? 200, headers: () => ({}) };
            }),
            waitForLoadState: vi.fn(async () => {}),
            content: vi.fn(async () => opts.html ?? renderedBillHtml()),
            title: vi.fn(async () => opts.title ?? 'AB-2013 Bill Text'),
            url: vi.fn(() => 'https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?final'),
          })),
          close: vi.fn(async () => { if (opts.teardown) opts.teardown.context = true; }),
        })),
        close: vi.fn(async () => { if (opts.teardown) opts.teardown.browser = true; }),
      };
    }),
  };
}

const loaderFor = (opts: FakeOpts): ChromiumLoader => async () => fakeChromium(opts) as never;
const URL = 'https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240AB2013';

describe('fetchHeadless — enablement gate', () => {
  it('returns unavailable when headless is disabled (never imports playwright)', async () => {
    const r = await fetchHeadless(URL, { enabled: false });
    expect(r.kind).toBe('unavailable');
    if (r.kind === 'unavailable') expect(r.reason).toMatch(/NOMUS_HEADLESS_ENABLED/);
  });

  it('returns unavailable when playwright-core is not installed (loader → null)', async () => {
    const r = await fetchHeadless(URL, { enabled: true, chromiumLoader: async () => null });
    expect(r.kind).toBe('unavailable');
    if (r.kind === 'unavailable') expect(r.reason).toMatch(/playwright-core is not installed/);
  });

  it('returns unavailable when the Chromium binary was never installed', async () => {
    const r = await fetchHeadless(URL, {
      enabled: true,
      chromiumLoader: loaderFor({ launchThrows: "browserType.launch: Executable doesn't exist at C:\\ms-playwright\\chromium\\headless_shell.exe" }),
    });
    expect(r.kind).toBe('unavailable');
    if (r.kind === 'unavailable') expect(r.reason).toMatch(/npx playwright install chromium/);
  });
});

describe('fetchHeadless — success (rendered provenance)', () => {
  it('captures the rendered DOM, hashes it, and marks provenance rendered', async () => {
    const html = renderedBillHtml();
    const teardown = { context: false, browser: false };
    const r = await fetchHeadless(URL, { enabled: true, chromiumLoader: loaderFor({ html, teardown }) });

    expect(r.kind).toBe('success');
    if (r.kind !== 'success') return;
    expect(r.provenanceMode).toBe('rendered');
    expect(r.renderedHtml).toBe(html);
    expect(r.rawBytesHash).toBe(createHash('sha256').update(html, 'utf-8').digest('hex'));
    expect(r.rawBytesSize).toBe(Buffer.byteLength(html, 'utf-8'));
    expect(r.finalUrl).toContain('billTextClient.xhtml');
    // Bounded teardown: context AND browser were closed.
    expect(teardown.context).toBe(true);
    expect(teardown.browser).toBe(true);
  });

  it('passes the proxy URL straight into chromium.launch({ proxy })', async () => {
    const proxyBox: { server?: string } = {};
    const r = await fetchHeadless(URL, {
      enabled: true,
      proxyUrl: 'http://user:pass@proxy.example:8080',
      chromiumLoader: loaderFor({ proxyBox }),
    });
    expect(r.kind).toBe('success');
    expect(proxyBox.server).toBe('http://user:pass@proxy.example:8080');
  });
});

describe('fetchHeadless — blocked (challenge is a FAILURE, never returned as content)', () => {
  it('treats a Cloudflare "Just a moment" interstitial as blocked', async () => {
    const html = '<html><head><title>Just a moment...</title></head><body>' +
      '<div class="cf-browser-verification">Checking your browser before accessing. ' +
      'Please verify you are a human. cf-challenge</div></body></html>';
    const r = await fetchHeadless(URL, { enabled: true, chromiumLoader: loaderFor({ html, title: 'Just a moment...' }) });
    expect(r.kind).toBe('blocked');
    if (r.kind === 'blocked') expect(r.reason).toMatch(/challenge/i);
  });

  it('treats an anti-bot 403 body as blocked', async () => {
    const r = await fetchHeadless(URL, { enabled: true, chromiumLoader: loaderFor({ status: 403, html: renderedBillHtml() }) });
    expect(r.kind).toBe('blocked');
    if (r.kind === 'blocked') expect(r.reason).toMatch(/403/);
  });

  it('treats a navigation failure as blocked (not a guessed page)', async () => {
    const r = await fetchHeadless(URL, { enabled: true, chromiumLoader: loaderFor({ gotoThrows: 'net::ERR_TIMED_OUT' }) });
    expect(r.kind).toBe('blocked');
    if (r.kind === 'blocked') expect(r.reason).toMatch(/navigation failed/i);
  });

  it('treats an empty/too-short render as blocked', async () => {
    const r = await fetchHeadless(URL, { enabled: true, chromiumLoader: loaderFor({ html: '<html></html>' }) });
    expect(r.kind).toBe('blocked');
    if (r.kind === 'blocked') expect(r.reason).toMatch(/empty|too-short/i);
  });
});

describe('fetchHeadless — drives the LAZY-IMPORTED playwright-core module', () => {
  it('uses the default loader (import(playwright-core)) when none is injected', async () => {
    const teardown = { context: false, browser: false };
    lazy.chromium = fakeChromium({ teardown });
    const r = await fetchHeadless(URL, { enabled: true }); // no chromiumLoader → lazy import
    expect(r.kind).toBe('success');
    if (r.kind === 'success') expect(r.provenanceMode).toBe('rendered');
    expect(teardown.browser).toBe(true);
  });
});

describe('looksLikeChallenge', () => {
  it('flags common anti-bot fingerprints and clears real content', () => {
    expect(looksLikeChallenge('<html>captcha required</html>', '')).toBe(true);
    expect(looksLikeChallenge('<html>datadome</html>', '')).toBe(true);
    expect(looksLikeChallenge('<html>ok</html>', 'Attention Required! | Cloudflare')).toBe(true);
    expect(looksLikeChallenge(renderedBillHtml(), 'AB-2013 Bill Text')).toBe(false);
  });
});
