// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * PATCH /api/v1/auth/profile email change, as the Profile page sends it.
 *
 * End-to-end audit: the page never sent currentPassword, so every email
 * change failed; and an address saved with capitals could never sign in
 * (login looks emails up lowercased).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import bcrypt from 'bcrypt';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { organizations, sessions, users } from '../../db/schema.js';
import type { AppEnv } from '../app.js';
import { authRoutes } from './auth.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/auth', authRoutes);
const TOKEN = 'profile-test-session-token-0000000';
const PASSWORD = 'Profile-Pass-2026!';

beforeAll(async () => {
  runMigrations();
  const db = getDb();
  const orgId = randomUUID();
  const userId = randomUUID();
  const now = new Date().toISOString();
  db.insert(organizations).values({ id: orgId, name: 'Profile Org', slug: `profile-${orgId.slice(0, 8)}`, jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now }).run();
  db.insert(users).values({
    id: userId, orgId, email: 'pat@profile.test', name: 'Pat', role: 'member', passwordHash: await bcrypt.hash(PASSWORD, 4),
    isActive: true, createdAt: now, updatedAt: now,
  } as typeof users.$inferInsert).run();
  db.insert(sessions).values({
    id: randomUUID(), userId, tokenHash: createHash('sha256').update(TOKEN).digest('hex'),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), createdAt: now,
  }).run();
});

const patch = async (body: unknown) => {
  const res = await app.request('/api/v1/auth/profile', {
    method: 'PATCH',
    headers: { Cookie: `nomus_session=${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
};

describe('PATCH /api/v1/auth/profile', () => {
  it('requires the current password to change the email', async () => {
    expect((await patch({ email: 'pat.new@profile.test' })).status).toBe(400);
  });

  it('changes the email with the current password, stored lowercased so the user can sign in', async () => {
    const r = await patch({ name: 'Pat Q', email: 'Pat.New@Profile.TEST', currentPassword: PASSWORD });
    expect(r.status).toBe(200);
    const login = await app.request('/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pat.new@profile.test', password: PASSWORD }),
    });
    expect(login.status).toBe(200);
  });
});
