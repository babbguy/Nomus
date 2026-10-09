// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import type { z } from 'zod';

/**
 * A typed client for the review-case API (design spec §10.1). Unlike the
 * regulatory `NomusApiClient`, which answers `null` for every failure, it
 * keeps the HTTP status and the server's error code, and validates every
 * success body with its zod contract, so each failure can be told apart:
 * offline, refused, invalid input, or an answer that breaks the contract.
 */

export type CpgResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; message: string; offline: boolean };

const TIMEOUT_MS = 15_000;

export function apiUrlSetting(): string {
  return vscode.workspace.getConfiguration('nomus').get<string>('apiUrl', 'http://localhost:3100').replace(/\/+$/, '');
}

/** The signed-in key, else the `nomus.apiKey` setting. */
export async function resolveApiKey(getApiKey: () => Promise<string | undefined>): Promise<string | undefined> {
  return (await getApiKey()) || vscode.workspace.getConfiguration('nomus').get<string>('apiKey', '') || undefined;
}

export class CpgClient {
  constructor(private readonly getApiKey: () => Promise<string | undefined>) {}

  async request<S extends z.ZodTypeAny>(method: 'GET' | 'POST', path: string, schema: S, body?: unknown): Promise<CpgResult<z.infer<S>>> {
    const apiKey = await resolveApiKey(this.getApiKey);
    if (!apiKey) return { ok: false, status: 401, code: 'unauthenticated', message: 'Sign in to Nomus first.', offline: false };
    let res: Response;
    try {
      res = await fetch(`${apiUrlSetting()}/api/v1/cpg${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: 0, code: 'unreachable', message: 'Nomus is unreachable.', offline: true };
    }
    let json: unknown = null;
    try { json = await res.json(); } catch { /* reported below */ }
    if (!res.ok) {
      const e = (json ?? {}) as { code?: unknown; error?: unknown };
      return {
        ok: false, status: res.status, code: typeof e.code === 'string' ? e.code : `http_${res.status}`,
        message: typeof e.error === 'string' ? e.error : `Nomus answered HTTP ${res.status}.`,
        // A gateway or server failure says nothing about the request: treat it like being offline.
        offline: res.status >= 500,
      };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return { ok: false, status: res.status, code: 'invalid_response', message: 'Nomus sent an answer this extension does not understand (update the extension).', offline: false };
    return { ok: true, status: res.status, data: parsed.data };
  }
}
