import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The module holds init state at module scope, so each test imports a fresh
 * copy via resetModules after setting the env mock. Sentry is fully mocked —
 * no network, no real SDK behavior.
 */

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  captureException: vi.fn(),
  withScope: vi.fn((cb: (scope: { setTag: (k: string, v: unknown) => void }) => void) =>
    cb({ setTag: vi.fn() }),
  ),
  lastInitOptions: null as null | { beforeSend?: (e: unknown) => unknown },
}));

const envMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('@sentry/node', () => ({
  init: (opts: { beforeSend?: (e: unknown) => unknown }) => {
    sentry.lastInitOptions = opts;
    sentry.init(opts);
  },
  flush: (t?: number) => sentry.flush(t),
  captureException: (e: unknown) => sentry.captureException(e),
  withScope: (cb: (scope: { setTag: (k: string, v: unknown) => void }) => void) => sentry.withScope(cb),
}));

vi.mock('../config/env.js', () => ({ env: () => envMock.value }));
vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshModule(env: Record<string, unknown>) {
  envMock.value = env;
  vi.resetModules();
  return import('./error-tracking.js');
}

beforeEach(() => {
  sentry.init.mockClear();
  sentry.flush.mockClear();
  sentry.captureException.mockClear();
  sentry.withScope.mockClear();
  sentry.lastInitOptions = null;
});

describe('error-tracking — disabled (no DSN)', () => {
  it('is a true no-op: SDK never initialized', async () => {
    const m = await freshModule({ NOMUS_ENV: 'production' });
    m.initErrorTracking();
    expect(sentry.init).not.toHaveBeenCalled();
    expect(m.isErrorTrackingEnabled()).toBe(false);
  });

  it('captureError does nothing when disabled', async () => {
    const m = await freshModule({ NOMUS_ENV: 'production' });
    m.initErrorTracking();
    m.captureError(new Error('boom'), { subsystem: 'api' });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('flush is a no-op when disabled', async () => {
    const m = await freshModule({ NOMUS_ENV: 'production' });
    m.initErrorTracking();
    await m.flushErrorTracking();
    expect(sentry.flush).not.toHaveBeenCalled();
  });
});

describe('error-tracking — enabled (DSN set)', () => {
  const enabledEnv = {
    NOMUS_ENV: 'production',
    NOMUS_SENTRY_DSN: 'https://key@example.ingest.sentry.io/1',
    NOMUS_SENTRY_TRACES_SAMPLE_RATE: 0,
  };

  it('initializes the SDK once and is idempotent', async () => {
    const m = await freshModule(enabledEnv);
    m.initErrorTracking();
    m.initErrorTracking();
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(m.isErrorTrackingEnabled()).toBe(true);
  });

  it('captureError reports with a subsystem tag', async () => {
    const m = await freshModule(enabledEnv);
    m.initErrorTracking();
    const setTag = vi.fn();
    sentry.withScope.mockImplementationOnce((cb: (s: { setTag: typeof setTag }) => void) => cb({ setTag }));
    const err = new Error('pipeline failed');
    m.captureError(err, { subsystem: 'hunter', context: { sourceId: 'src-1' } });
    expect(sentry.captureException).toHaveBeenCalledWith(err);
    expect(setTag).toHaveBeenCalledWith('subsystem', 'hunter');
    expect(setTag).toHaveBeenCalledWith('sourceId', 'src-1');
  });

  it('captureError never throws even if the SDK throws', async () => {
    const m = await freshModule(enabledEnv);
    m.initErrorTracking();
    sentry.captureException.mockImplementationOnce(() => {
      throw new Error('sentry down');
    });
    expect(() => m.captureError(new Error('x'), { subsystem: 'api' })).not.toThrow();
  });

  it('beforeSend strips request body, query string, user, and extra', async () => {
    const m = await freshModule(enabledEnv);
    m.initErrorTracking();
    const beforeSend = sentry.lastInitOptions?.beforeSend;
    expect(beforeSend).toBeTypeOf('function');
    const scrubbed = beforeSend!({
      request: {
        method: 'POST',
        url: 'https://api.example.com/v1/simulate?token=secret&j=EU',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { ssn: '123-45-6789' } as any,
        cookies: 'session=abc',
        headers: { authorization: 'Bearer x' },
      },
      user: { id: 'org-123', email: 'a@b.com' },
      extra: { regulation: 'full text here' },
    }) as {
      request: Record<string, unknown>;
      user?: unknown;
      extra?: unknown;
    };
    expect(scrubbed.request.method).toBe('POST');
    expect(scrubbed.request.url).toBe('https://api.example.com/v1/simulate'); // query stripped
    expect(scrubbed.request.data).toBeUndefined();
    expect(scrubbed.request.cookies).toBeUndefined();
    expect(scrubbed.request.headers).toBeUndefined();
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.extra).toBeUndefined();
  });

  it('flush awaits the SDK when enabled', async () => {
    const m = await freshModule(enabledEnv);
    m.initErrorTracking();
    await m.flushErrorTracking(500);
    expect(sentry.flush).toHaveBeenCalledWith(500);
  });
});
