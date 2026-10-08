import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createApp } from '../app.js';
import { errorHandler, handleAppError } from './error-handler.js';

function appWith(handler: () => never) {
  const app = new Hono();
  app.onError(handleAppError);
  app.use('*', errorHandler());
  const sub = new Hono();
  sub.get('/x', handler);
  app.route('/api', sub);
  return app;
}

describe('error handling', () => {
  it('returns JSON 500 for an error thrown in a mounted route', async () => {
    const res = await appWith(() => { throw new Error('boom'); }).request('http://t/api/x');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Internal server error', status: 500 });
  });

  it('keeps the status of an HTTPException', async () => {
    const res = await appWith(() => { throw new HTTPException(418, { message: 'teapot' }); }).request('http://t/api/x');
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: 'teapot', status: 418 });
  });

  it('is wired into createApp', async () => {
    const app = createApp();
    app.get('/__throws', () => { throw new Error('boom'); });
    const res = await app.request('http://t/__throws');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
