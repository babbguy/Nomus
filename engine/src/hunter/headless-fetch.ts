/**
 * Headless Browser Fetch — the ACCESS-ESCALATION automated tier.
 * =============================================================
 *
 * A residual set of official-adjacent sources block plain HTTP bots or render
 * their document only after running JavaScript (e.g. the California legislature
 * JSF/XHTML bill viewer). A polite `fetch()` gets an empty shell or a challenge
 * page — never the regulation. For those sources this module launches a real
 * headless Chromium, runs the page's JavaScript, and captures the rendered DOM.
 *
 * The owner decision is a SPLIT: this Playwright path is the AUTOMATED
 * escalation; manual upload remains the human fallback. Anti-bot defenses evolve
 * and will eventually evade any scraper, so when headless is unavailable or hits
 * a challenge we do NOT return a guessed/partial/challenge page — we surface a
 * blocked/unavailable result and let the caller hold the source for manual
 * upload (refuse-to-guess).
 *
 * ─── CI / DEPLOY SAFETY (do not regress) ──────────────────────────────────────
 * Playwright's browser binaries are ~150MB and are NOT required for the engine
 * to build, for `npm ci`, or for the test suite to run:
 *   • The dependency is `playwright-core` (NOT `playwright`) — it never downloads
 *     browsers on install.
 *   • Playwright is LAZY-IMPORTED inside the fetch call, never at module load, so
 *     importing this file costs nothing and needs no browser.
 *   • Headless is gated on NOMUS_HEADLESS_ENABLED (default false) AND on the
 *     browser binary actually being present. When disabled or absent we return
 *     `unavailable` and the source escalates to manual-hold.
 *   • Enabling headless on a host requires: `npx playwright install chromium`.
 *
 * The provenance of a rendered capture is the dedicated `rendered` tier (see
 * hunter/provenance.ts): promotable, but never byte-exact — the JS-mutated DOM
 * is not the raw HTTP body, and we keep that honest.
 */

import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

// ─── Result contract ──────────────────────────────────────────────────────────

export interface HeadlessSuccess {
  kind: 'success';
  /** The fully rendered DOM (outer HTML) after the page's JavaScript ran. */
  renderedHtml: string;
  /** SHA-256 of the rendered HTML bytes (utf-8). Provenance = 'rendered'. */
  rawBytesHash: string;
  /** Size of the rendered HTML in bytes (utf-8). */
  rawBytesSize: number;
  /** Final URL after any client/server redirects. */
  finalUrl: string;
  /** Best-effort content-type (Playwright renders HTML → text/html). */
  contentType: string;
  /** Always 'rendered' — see hunter/provenance.ts. */
  provenanceMode: 'rendered';
}

export interface HeadlessUnavailable {
  kind: 'unavailable';
  /** Why headless could not run at all (disabled / not installed). */
  reason: string;
}

export interface HeadlessBlocked {
  kind: 'blocked';
  /** Why the capture is not usable (challenge page / navigation failure). */
  reason: string;
}

export type HeadlessFetchResult = HeadlessSuccess | HeadlessUnavailable | HeadlessBlocked;

// ─── Minimal structural Playwright surface (kept local so this file needs no ──
//     top-level playwright import and stays lazy) ────────────────────────────

interface PwResponse {
  status(): number;
  headers(): Record<string, string>;
}
interface PwPage {
  goto(url: string, opts: { waitUntil?: string; timeout?: number }): Promise<PwResponse | null>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  waitForLoadState(state: string, opts?: { timeout?: number }): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwChromium {
  launch(opts: Record<string, unknown>): Promise<PwBrowser>;
}

/** Loads the chromium launcher, or null when playwright-core is not installed. */
export type ChromiumLoader = () => Promise<PwChromium | null>;

export interface HeadlessFetchOptions {
  /** Override the NOMUS_HEADLESS_ENABLED gate (primarily for tests). */
  enabled?: boolean;
  /** Navigation timeout (ms). Default 45s — JS apps are slower than a raw GET. */
  timeoutMs?: number;
  /** Proxy URL for the browser context (NOMUS_HEADLESS_PROXY). */
  proxyUrl?: string;
  /** Override the desktop User-Agent presented to the site. */
  userAgent?: string;
  /** Tiered operational events (mirrors the scraper signature). */
  emit?: (tier: 1 | 2 | 3, message: string, details?: Record<string, unknown>) => void;
  /** Injectable chromium loader for tests. Defaults to a lazy playwright-core import. */
  chromiumLoader?: ChromiumLoader;
}

// ─── Challenge detection ──────────────────────────────────────────────────────
//
// Reuses the CAPTCHA markers from source-health-checker and adds the common
// interstitial-challenge fingerprints (Cloudflare / DataDome / Akamai / PerimeterX).
// A rendered page that matches any of these is a CHALLENGE, not the regulation —
// we treat it as a hard failure and NEVER return it as content.

const CHALLENGE_MARKERS: RegExp[] = [
  /captcha/i,
  /recaptcha/i,
  /hcaptcha/i,
  /cf-challenge/i,
  /cf-browser-verification/i,
  /challenge-platform/i,
  /cloudflare.*(challenge|checking)/i,
  /just a moment\.\.\./i,
  /checking your browser/i,
  /please verify you are (a )?human/i,
  /verify you are human/i,
  /attention required/i,
  /enable javascript and cookies to continue/i,
  /datadome/i,
  /px-captcha/i,
  /perimeterx/i,
  /access denied.*(automated|reference)/i,
];

const CHALLENGE_TITLES: RegExp[] = [
  /just a moment/i,
  /attention required/i,
  /access denied/i,
  /security check/i,
  /verifying you are human/i,
];

/** True when the rendered page looks like an anti-bot challenge, not content. */
export function looksLikeChallenge(html: string, title: string): boolean {
  const head = html.slice(0, 6000);
  for (const re of CHALLENGE_TITLES) {
    if (re.test(title)) return true;
  }
  for (const re of CHALLENGE_MARKERS) {
    if (re.test(head)) return true;
  }
  return false;
}

// ─── Enablement ───────────────────────────────────────────────────────────────

/** Headless is opt-in via NOMUS_HEADLESS_ENABLED=true (default false). */
export function isHeadlessEnabled(): boolean {
  return env().NOMUS_HEADLESS_ENABLED === 'true';
}

/** Proxy URL for the browser context, or undefined. */
export function headlessProxyUrl(): string | undefined {
  const p = env().NOMUS_HEADLESS_PROXY;
  return p && p.trim() !== '' ? p.trim() : undefined;
}

// A realistic, current desktop Chrome fingerprint. Anti-bot heuristics score the
// UA/viewport/locale/timezone triad; presenting a coherent modern desktop
// profile is the honest baseline for capturing a page a human would see.
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Lazy-import playwright-core; null when it (or its browsers) is unavailable. */
const defaultChromiumLoader: ChromiumLoader = async () => {
  try {
    const mod = await import('playwright-core');
    return (mod as unknown as { chromium: PwChromium }).chromium ?? null;
  } catch {
    // playwright-core not installed at all — treat as unavailable, never throw.
    return null;
  }
};

/** Playwright's error when the browser binary was never installed. */
function isBrowserNotInstalled(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Executable doesn'?t exist/i.test(msg) ||
    /playwright install/i.test(msg) ||
    /Failed to launch/i.test(msg) ||
    /browserType\.launch/i.test(msg)
  );
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetch a URL with a headless browser and return the rendered DOM.
 *
 * Contract (discriminated result — the caller NEVER gets a guessed page):
 *   • success     — rendered DOM captured, hashed, provenance 'rendered'.
 *   • unavailable — headless disabled OR playwright/browser not installed.
 *                   The caller escalates the source to manual-hold.
 *   • blocked     — an anti-bot challenge was detected, or navigation failed.
 *                   The caller escalates the source to manual-hold. The
 *                   challenge page is NEVER returned as content.
 *
 * Resource use is bounded: a single context + single page, always torn down in
 * `finally` (context.close() then browser.close()).
 */
export async function fetchHeadless(
  url: string,
  opts: HeadlessFetchOptions = {},
): Promise<HeadlessFetchResult> {
  const emit = opts.emit ?? (() => {});

  const enabled = opts.enabled ?? isHeadlessEnabled();
  if (!enabled) {
    return {
      kind: 'unavailable',
      reason: 'Headless fetch disabled (set NOMUS_HEADLESS_ENABLED=true and run `npx playwright install chromium`).',
    };
  }

  const load = opts.chromiumLoader ?? defaultChromiumLoader;
  const chromium = await load();
  if (!chromium) {
    return {
      kind: 'unavailable',
      reason: 'playwright-core is not installed — headless browser fetch is unavailable.',
    };
  }

  const timeoutMs = opts.timeoutMs ?? 45_000;
  const proxyUrl = opts.proxyUrl ?? headlessProxyUrl();

  let browser: PwBrowser | null = null;
  let context: PwContext | null = null;

  try {
    const launchOpts: Record<string, unknown> = { headless: true };
    if (proxyUrl) launchOpts.proxy = { server: proxyUrl };

    try {
      browser = await chromium.launch(launchOpts);
    } catch (err) {
      // The browser binary was never installed (~150MB, not pulled by npm ci).
      // This is the graceful "not available" path — escalate to manual-hold.
      if (isBrowserNotInstalled(err)) {
        logger.warn({ url, error: (err as Error).message },
          'Headless: Chromium binary not installed — run `npx playwright install chromium`');
        return {
          kind: 'unavailable',
          reason: 'Chromium browser binary not installed — run `npx playwright install chromium` on the host.',
        };
      }
      throw err;
    }

    context = await browser.newContext({
      userAgent: opts.userAgent ?? DEFAULT_UA,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      // Honour the site even when it serves a Do-Not-Track-aware variant.
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const page = await context.newPage();

    let status = 0;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      status = resp?.status() ?? 0;
      // Give client-rendered apps (JSF/XHTML, SPA bill viewers) time to paint the
      // document, but never block past the overall timeout budget.
      try {
        await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 15_000) });
      } catch {
        // networkidle can legitimately never settle (polling widgets); the
        // domcontentloaded DOM is still a valid capture. Proceed.
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ url, error: msg }, 'Headless: navigation failed');
      return { kind: 'blocked', reason: `Headless navigation failed: ${msg}` };
    }

    const finalUrl = page.url();
    const title = await page.title().catch(() => '');
    const renderedHtml = await page.content();

    // A 403/429/5xx that still returned a body is an anti-bot block, not content.
    if (status === 403 || status === 429 || status === 503) {
      return { kind: 'blocked', reason: `Headless received anti-bot status ${status} for ${finalUrl}` };
    }

    if (looksLikeChallenge(renderedHtml, title)) {
      emit(2, 'Headless capture hit an anti-bot challenge — holding for manual upload');
      return { kind: 'blocked', reason: `Anti-bot challenge page detected (title: ${title.slice(0, 80)})` };
    }

    if (!renderedHtml || renderedHtml.length < 200) {
      return { kind: 'blocked', reason: `Headless rendered an empty/too-short document (${renderedHtml.length} bytes)` };
    }

    const rawBytesSize = Buffer.byteLength(renderedHtml, 'utf-8');
    const rawBytesHash = createHash('sha256').update(renderedHtml, 'utf-8').digest('hex');

    logger.info({ url, finalUrl, status, bytes: rawBytesSize },
      'Headless: rendered capture succeeded');

    return {
      kind: 'success',
      renderedHtml,
      rawBytesHash,
      rawBytesSize,
      finalUrl,
      contentType: 'text/html; rendered-dom',
      provenanceMode: 'rendered',
    };
  } catch (err) {
    // Any unexpected failure is treated as a block (never a guessed page).
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ url, error: msg }, 'Headless: unexpected failure');
    return { kind: 'blocked', reason: `Headless fetch error: ${msg}` };
  } finally {
    // Bounded teardown — close the context then the browser, best-effort.
    try { if (context) await context.close(); } catch { /* ignore */ }
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  }
}
