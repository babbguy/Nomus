/**
 * Minimal HTTP client for the Nomus engine API.
 *
 * Fail-closed contract: any transport failure, timeout, non-2xx
 * status, or unparseable response throws {@link NomusHttpError}. The MCP
 * tool layer surfaces that as an explicit MCP error result — NEVER as an
 * empty "no obligations" success. A backend outage must never look like a
 * clean compliance answer.
 *
 * 429 handling: honors Retry-After with bounded backoff (max 2 retries),
 * then fails with an explicit rate-limit error.
 */

import { setTimeout as delay } from 'node:timers/promises';

export type NomusErrorKind =
  | 'unreachable'
  | 'invalid_key'
  | 'forbidden'
  | 'rate_limited'
  | 'not_found'
  | 'bad_request'
  | 'server_error';

export const FAIL_CLOSED_NOTE =
  'Compliance status is UNKNOWN — do NOT treat this as "no obligations apply". ' +
  'Retry when the Nomus API is reachable.';

export class NomusHttpError extends Error {
  constructor(
    message: string,
    readonly kind: NomusErrorKind,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'NomusHttpError';
  }
}

export interface NomusClientOptions {
  /** Per-request timeout in ms. Matches the scanner's 15s default. */
  timeoutMs?: number;
  /** Max retries on 429 (in addition to the first attempt). */
  maxRateLimitRetries?: number;
  /** Cap on a single Retry-After wait, ms. */
  maxRetryWaitMs?: number;
}

type Query = Record<string, string | number | undefined>;

export class NomusClient {
  private readonly timeoutMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly maxRetryWaitMs: number;

  constructor(
    readonly apiUrl: string,
    private readonly apiKey: string,
    options: NomusClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 2;
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? 5_000;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, undefined, body);
  }

  private buildUrl(path: string, query?: Query): string {
    const url = new URL(this.apiUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    query?: Query,
    body?: unknown,
  ): Promise<T> {
    const url = this.buildUrl(path, query);

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        throw new NomusHttpError(
          `Nomus API unreachable at ${this.apiUrl}` +
          `${timedOut ? ` (request timed out after ${this.timeoutMs}ms)` : ` (${detail})`}. ` +
          FAIL_CLOSED_NOTE,
          'unreachable',
        );
      }

      if (res.status === 429 && attempt < this.maxRateLimitRetries) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterSec = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
        const waitMs = Math.min(
          Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 1000,
          this.maxRetryWaitMs,
        );
        await delay(waitMs);
        continue;
      }

      return this.handleResponse<T>(res);
    }
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    // Read the body once; engine errors are JSON but never assume.
    let parsed: unknown;
    let rawText = '';
    try {
      rawText = await res.text();
      parsed = rawText ? JSON.parse(rawText) : undefined;
    } catch {
      parsed = undefined;
    }
    const bodyObj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const bodyMessage =
      typeof bodyObj.message === 'string' ? bodyObj.message
      : typeof bodyObj.error === 'string' ? bodyObj.error
      : undefined;

    if (res.ok) {
      if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
        throw new NomusHttpError(
          `Nomus API returned an unparseable response body (HTTP ${res.status}). ` + FAIL_CLOSED_NOTE,
          'server_error',
          res.status,
          rawText.slice(0, 500),
        );
      }
      return parsed as T;
    }

    switch (res.status) {
      case 400:
        throw new NomusHttpError(
          `Nomus API rejected the request as invalid (400)${bodyMessage ? `: ${bodyMessage}` : ''}.`,
          'bad_request', res.status, parsed,
        );
      case 401:
        throw new NomusHttpError(
          'Nomus API rejected the API key (401): invalid or expired API key. ' +
          "Check NOMUS_API_KEY — it must be a Nomus key (nk_live_… / nk_test_…) with the 'read:policies' and 'evaluate' scopes.",
          'invalid_key', res.status, parsed,
        );
      case 403:
        throw new NomusHttpError(
          `Nomus API key lacks the required permissions (403)${bodyMessage ? `: ${bodyMessage}` : ''}. ` +
          "Issue a key with the 'read:policies' and 'evaluate' scopes.",
          'forbidden', res.status, parsed,
        );
      case 404:
        throw new NomusHttpError(
          `Nomus API resource not found (404)${bodyMessage ? `: ${bodyMessage}` : ''}.`,
          'not_found', res.status, parsed,
        );
      case 429:
        throw new NomusHttpError(
          'Nomus API rate limit exceeded (429) — retries with backoff were exhausted. ' +
          "Wait for your org's per-minute quota to reset and try again. " + FAIL_CLOSED_NOTE,
          'rate_limited', res.status, parsed,
        );
      default:
        throw new NomusHttpError(
          `Nomus API returned HTTP ${res.status}${bodyMessage ? ` (${bodyMessage})` : ''}. ` + FAIL_CLOSED_NOTE,
          'server_error', res.status, parsed,
        );
    }
  }
}
