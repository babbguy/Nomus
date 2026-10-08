import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock dependencies
const mockTenant = {
  orgId: 'org-1',
  apiKeyId: 'key-1',
  scopes: ['read:policies', 'evaluate', 'admin'],
  rateLimitRpm: 100,
};

vi.mock('../../tenant/resolver.js', () => ({
  resolveApiKey: vi.fn((token: string) => {
    if (token === 'valid-key') return mockTenant;
    if (token === 'read-only-key') return { ...mockTenant, scopes: ['read:policies'] };
    return null;
  }),
}));

vi.mock('../../tenant/usage.js', () => ({
  recordUsage: vi.fn(),
}));

// Per-test role mock — flipped between admin/member to verify session-path scope checks.
let __mockUserRole: 'platform_admin' | 'member' = 'platform_admin';
let __mockMustChangePassword = false;

vi.mock('../../db/client.js', () => {
  return {
    getDb: () => ({
      select: () => ({
        from: (table: any) => ({
          where: (_condition: any) => ({
            get: () => {
              // Identify which table is being queried by the mocked schema
              // marker. The mock for db/schema.js below uses string keys we
              // can read off `table`.
              if (table?.__name === 'sessions') {
                return {
                  id: 'session-1',
                  userId: 'user-1',
                  tokenHash: 'unused-in-test',
                  expiresAt: new Date(Date.now() + 86400000).toISOString(),
                  createdAt: new Date().toISOString(),
                };
              }
              if (table?.__name === 'users') {
                return {
                  id: 'user-1',
                  orgId: 'org-1',
                  isActive: true,
                  role: __mockUserRole,
                  mustChangePassword: __mockMustChangePassword,
                };
              }
              return null;
            },
          }),
        }),
      }),
    }),
  };
});

vi.mock('../../db/schema.js', () => ({
  sessions: { __name: 'sessions', tokenHash: 'token_hash' },
  users: { __name: 'users', id: 'id', isActive: 'is_active' },
  organizations: { __name: 'organizations', id: 'id' },
}));

import { requireAuth, requireSession, requireSessionOrApiKey } from './auth.js';

describe('auth middleware', () => {
  describe('requireAuth (API key)', () => {
    it('rejects requests without Authorization header', async () => {
      const app = new Hono();
      app.use('*', requireAuth());
      app.get('/', (c) => c.json({ ok: true }));

      const res = await app.request('/');
      expect(res.status).toBe(401);
    });

    it('rejects invalid API keys', async () => {
      const app = new Hono();
      app.use('*', requireAuth());
      app.get('/', (c) => c.json({ ok: true }));

      const res = await app.request('/', {
        headers: { Authorization: 'Bearer invalid-key' },
      });
      expect(res.status).toBe(401);
    });

    it('accepts valid API keys', async () => {
      const app = new Hono();
      app.use('*', requireAuth());
      app.get('/', (c) => c.json({ ok: true }));

      const res = await app.request('/', {
        headers: { Authorization: 'Bearer valid-key' },
      });
      expect(res.status).toBe(200);
    });

    it('enforces required scopes', async () => {
      const app = new Hono();
      app.use('*', requireAuth('admin'));
      app.get('/', (c) => c.json({ ok: true }));

      // read-only-key only has 'read:policies' scope
      const res = await app.request('/', {
        headers: { Authorization: 'Bearer read-only-key' },
      });
      expect(res.status).toBe(403);
    });

    it('allows requests with sufficient scopes', async () => {
      const app = new Hono();
      app.use('*', requireAuth('admin'));
      app.get('/', (c) => c.json({ ok: true }));

      const res = await app.request('/', {
        headers: { Authorization: 'Bearer valid-key' },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('requireSessionOrApiKey', () => {
    it('rejects when neither session nor API key is provided', async () => {
      const app = new Hono();
      app.use('*', requireSessionOrApiKey());
      app.get('/', (c) => c.json({ ok: true }));

      const res = await app.request('/');
      expect(res.status).toBe(401);
    });

    it('accepts valid API key via Bearer token', async () => {
      const app = new Hono();
      app.use('*', requireSessionOrApiKey());
      app.get('/', (c) => c.json({ ok: true }));

      const res = await app.request('/', {
        headers: { Authorization: 'Bearer valid-key' },
      });
      expect(res.status).toBe(200);
    });

    it('enforces scopes on API key auth', async () => {
      const app = new Hono();
      app.use('*', requireSessionOrApiKey('admin'));
      app.get('/', (c) => c.json({ ok: true }));

      const res = await app.request('/', {
        headers: { Authorization: 'Bearer read-only-key' },
      });
      expect(res.status).toBe(403);
    });

    // Regression test for the session branch
    // used to skip scope enforcement entirely, letting any authenticated
    // member walk through admin-gated routes.
    it('enforces scopes on session-cookie auth — non-admin member rejected from admin route', async () => {
      __mockUserRole = 'member';
      try {
        const app = new Hono();
        app.use('*', requireSessionOrApiKey('admin'));
        app.get('/', (c) => c.json({ ok: true }));

        const res = await app.request('/', {
          headers: { Cookie: 'nomus_session=any-token' },
        });
        expect(res.status).toBe(403);
      } finally {
        __mockUserRole = 'platform_admin';
      }
    });

    it('allows session-cookie auth when role grants the required scope', async () => {
      __mockUserRole = 'platform_admin';
      const app = new Hono();
      app.use('*', requireSessionOrApiKey('admin'));
      app.get('/', (c) => c.json({ ok: true }));

      const res = await app.request('/', {
        headers: { Cookie: 'nomus_session=any-token' },
      });
      expect(res.status).toBe(200);
    });

    it('rejects a temporary-password session with 403 password_change_required', async () => {
      __mockMustChangePassword = true;
      try {
        const app = new Hono();
        app.use('*', requireSessionOrApiKey());
        app.get('/', (c) => c.json({ ok: true }));

        const res = await app.request('/', { headers: { Cookie: 'nomus_session=any-token' } });
        expect(res.status).toBe(403);
        const body = await res.json() as { code: string; error: string };
        expect(body.code).toBe('password_change_required');
        expect(body.error).toMatch(/password change/i);
      } finally {
        __mockMustChangePassword = false;
      }
    });

    it('does not apply the password-change gate to API keys', async () => {
      __mockMustChangePassword = true;
      try {
        const app = new Hono();
        app.use('*', requireSessionOrApiKey());
        app.get('/', (c) => c.json({ ok: true }));

        const res = await app.request('/', { headers: { Authorization: 'Bearer valid-key' } });
        expect(res.status).toBe(200);
      } finally {
        __mockMustChangePassword = false;
      }
    });
  });

  describe('requireSession', () => {
    it('allows a normal session', async () => {
      const app = new Hono();
      app.use('*', requireSession());
      app.get('/', (c) => c.json({ ok: true }));
      const res = await app.request('/', { headers: { Cookie: 'nomus_session=any-token' } });
      expect(res.status).toBe(200);
    });

    it('rejects a temporary-password session with 403 password_change_required', async () => {
      __mockMustChangePassword = true;
      try {
        const app = new Hono();
        app.use('*', requireSession());
        app.get('/', (c) => c.json({ ok: true }));

        const res = await app.request('/', { headers: { Cookie: 'nomus_session=any-token' } });
        expect(res.status).toBe(403);
        const body = await res.json() as { code: string };
        expect(body.code).toBe('password_change_required');
      } finally {
        __mockMustChangePassword = false;
      }
    });
  });
});
