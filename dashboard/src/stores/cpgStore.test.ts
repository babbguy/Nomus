import { describe, it, expect, vi, beforeEach } from 'vitest';
import { me, OWNER_ID, DEV_ID } from '../test/cpg-fixtures';

const getCpgMe = vi.fn();
vi.mock('../api/cpg', () => ({ getCpgMe: () => getCpgMe() }));

const { useCpgStore } = await import('./cpgStore');

beforeEach(() => {
  getCpgMe.mockReset();
  useCpgStore.getState().reset();
});

describe('cpgStore', () => {
  it('loads /cpg/me once per user', async () => {
    getCpgMe.mockResolvedValue(me());
    await useCpgStore.getState().load(OWNER_ID);
    await useCpgStore.getState().load(OWNER_ID);
    expect(getCpgMe).toHaveBeenCalledTimes(1);
    expect(useCpgStore.getState()).toMatchObject({ status: 'ready', userId: OWNER_ID, error: null });
  });

  it('a forced refresh keeps the loaded state visible until the answer arrives', async () => {
    getCpgMe.mockResolvedValueOnce(me());
    await useCpgStore.getState().load(OWNER_ID);
    let resolve!: (v: unknown) => void;
    getCpgMe.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const pending = useCpgStore.getState().load(OWNER_ID, { force: true });
    expect(useCpgStore.getState().status).toBe('ready');
    resolve(me({ cpgEnabled: true }));
    await pending;
    expect(useCpgStore.getState().me?.cpgEnabled).toBe(true);
  });

  it('reports a failure as an error state with a message (never as no permissions)', async () => {
    getCpgMe.mockRejectedValue({ response: { status: 500, data: { error: 'Internal error' } } });
    await useCpgStore.getState().load(OWNER_ID);
    expect(useCpgStore.getState()).toMatchObject({ status: 'error', me: null, error: 'Internal error' });
  });

  it('refuses an answer for a different user than the one asked for', async () => {
    getCpgMe.mockResolvedValue(me());
    await useCpgStore.getState().load(DEV_ID);
    expect(useCpgStore.getState()).toMatchObject({ status: 'error', me: null });
  });

  it('switching user drops the previous user\'s permissions immediately', async () => {
    getCpgMe.mockResolvedValueOnce(me());
    await useCpgStore.getState().load(OWNER_ID);
    getCpgMe.mockReturnValueOnce(new Promise(() => {}));
    void useCpgStore.getState().load(DEV_ID);
    expect(useCpgStore.getState()).toMatchObject({ userId: DEV_ID, me: null, status: 'loading' });
  });

  it('ignores a late answer after reset (sign-out)', async () => {
    let resolve!: (v: unknown) => void;
    getCpgMe.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const pending = useCpgStore.getState().load(OWNER_ID);
    useCpgStore.getState().reset();
    resolve(me());
    await pending;
    expect(useCpgStore.getState()).toMatchObject({ userId: null, me: null, status: 'idle' });
  });

  it('setCpgEnabled updates the loaded identity', async () => {
    getCpgMe.mockResolvedValue(me());
    await useCpgStore.getState().load(OWNER_ID);
    useCpgStore.getState().setCpgEnabled(true);
    expect(useCpgStore.getState().me?.cpgEnabled).toBe(true);
  });
});
