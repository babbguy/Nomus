import { describe, it, expect } from 'vitest';
import { shouldRedirectToLogin } from './auth-redirect';

describe('shouldRedirectToLogin', () => {
  it.each([
    '/verify/3f1c9a52-7d0e-4b8a-9c11-0a5d2e6f7b88',
    '/transparency',
    '/ledger',
    '/login',
    '/forgot-password',
    '/reset-password',
    '/change-password',
  ])('never redirects on the public route %s', (pathname) => {
    expect(shouldRedirectToLogin(pathname, '/policies')).toBe(false);
    expect(shouldRedirectToLogin(pathname, '/auth/me')).toBe(false);
  });

  it('never redirects for the /auth/me session probe, on any page', () => {
    expect(shouldRedirectToLogin('/', '/auth/me')).toBe(false);
    expect(shouldRedirectToLogin('/dashboard', '/auth/me')).toBe(false);
    expect(shouldRedirectToLogin('/dashboard', '/auth/me?x=1')).toBe(false);
    expect(shouldRedirectToLogin('/dashboard', '/api/v1/auth/me')).toBe(false);
  });

  it('redirects when a protected page gets a 401 from another endpoint', () => {
    expect(shouldRedirectToLogin('/', '/policies')).toBe(true);
    expect(shouldRedirectToLogin('/dashboard', '/attestations')).toBe(true);
    expect(shouldRedirectToLogin('/settings/team', undefined)).toBe(true);
  });

  it('does not treat look-alike paths as public', () => {
    expect(shouldRedirectToLogin('/verifying', '/policies')).toBe(true);
    expect(shouldRedirectToLogin('/ledger-admin', '/policies')).toBe(true);
    expect(shouldRedirectToLogin('/dashboard', '/users/auth/me-not')).toBe(true);
  });
});
