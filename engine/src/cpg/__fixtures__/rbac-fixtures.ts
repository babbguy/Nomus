/**
 * Test fixtures for the CPG tests: orgs, users, sessions and API keys written
 * straight to the database (the way the existing route tests do), plus a
 * request helper for the real Hono app. Used only by *.test.ts files.
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { apiKeys, organizations, sessions, users } from '../../db/schema.js';

let seq = 0;
/** Strictly increasing ISO timestamps so creation order is deterministic. */
export function nextIso(): string {
  seq += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, seq)).toISOString();
}

export function makeOrg(label = 'Org'): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().insert(organizations).values({
    id, name: `${label} ${id.slice(0, 6)}`, slug: `${label.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${id.slice(0, 8)}`,
    jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now,
  }).run();
  return id;
}

export interface TestUser { id: string; orgId: string; email: string; cookie: string }

export function makeUser(orgId: string, opts: {
  role?: 'member' | 'platform_admin'; mustChangePassword?: boolean; isActive?: boolean; createdAt?: string; id?: string;
} = {}): TestUser {
  const id = opts.id ?? randomUUID();
  const createdAt = opts.createdAt ?? nextIso();
  const email = `${id}@gate.example.org`;
  getDb().insert(users).values({
    id, orgId, email, passwordHash: 'x-not-a-real-hash', name: `User ${id.slice(0, 4)}`,
    role: opts.role ?? 'member', authProvider: 'local', mustChangePassword: opts.mustChangePassword ?? false,
    isActive: opts.isActive ?? true, createdAt, updatedAt: createdAt,
  }).run();
  return { id, orgId, email, cookie: makeSession(id) };
}

export function makeSession(userId: string): string {
  const token = randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  getDb().insert(sessions).values({
    id: randomUUID(), userId, tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), createdAt: now,
  }).run();
  return `nomus_session=${token}`;
}

/** An API key; bound to `userId` when given (as the VS Code device sign-in mints it). */
export function makeKey(orgId: string, userId: string | null, scopes = ['read:policies', 'evaluate', 'stream'], label = 'test key'): { id: string; key: string } {
  const key = `nk_live_${randomBytes(24).toString('base64url')}`;
  const id = randomUUID();
  getDb().insert(apiKeys).values({
    id, orgId, keyHash: createHash('sha256').update(key).digest('hex'), keyPrefix: key.slice(0, 12), label,
    scopes: JSON.stringify(scopes), rateLimitRpm: 100000, isActive: true, createdAt: new Date().toISOString(), userId,
  }).run();
  return { id, key };
}

export interface CallResult { status: number; json: any; text: string; headers: Headers }

export async function call(app: Hono<any>, method: string, path: string, opts: { cookie?: string; bearer?: string; body?: unknown; rawBody?: string } = {}): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined || opts.rawBody !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(`http://localhost${path}`, {
    method, headers, redirect: 'manual',
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
