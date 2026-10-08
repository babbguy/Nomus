import { describe, it, expect } from 'vitest';
import { loadConfig, configWarnings, ConfigError } from '../src/config.js';

describe('loadConfig', () => {
  it('loads a valid config and strips trailing slashes from the URL', () => {
    const config = loadConfig({
      NOMUS_API_URL: 'http://localhost:3100/',
      NOMUS_API_KEY: 'nk_test_abc123',
    });
    expect(config.apiUrl).toBe('http://localhost:3100');
    expect(config.apiKey).toBe('nk_test_abc123');
  });

  it('throws a ConfigError naming NOMUS_API_URL when it is missing', () => {
    expect(() => loadConfig({ NOMUS_API_KEY: 'nk_test_abc' })).toThrowError(ConfigError);
    expect(() => loadConfig({ NOMUS_API_KEY: 'nk_test_abc' })).toThrowError(/NOMUS_API_URL/);
  });

  it('throws a ConfigError naming NOMUS_API_KEY when it is missing', () => {
    expect(() => loadConfig({ NOMUS_API_URL: 'http://localhost:3100' })).toThrowError(/NOMUS_API_KEY/);
  });

  it('collects ALL problems in one error when both are missing', () => {
    try {
      loadConfig({});
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/NOMUS_API_URL/);
      expect(message).toMatch(/NOMUS_API_KEY/);
    }
  });

  it('rejects a non-URL value', () => {
    expect(() =>
      loadConfig({ NOMUS_API_URL: 'not a url', NOMUS_API_KEY: 'nk_test_abc' }),
    ).toThrowError(/not a valid URL/);
  });

  it('rejects non-http(s) protocols', () => {
    expect(() =>
      loadConfig({ NOMUS_API_URL: 'ftp://example.com', NOMUS_API_KEY: 'nk_test_abc' }),
    ).toThrowError(/http\(s\)/);
  });

  it('treats empty/whitespace values as missing', () => {
    expect(() =>
      loadConfig({ NOMUS_API_URL: '   ', NOMUS_API_KEY: 'nk_test_abc' }),
    ).toThrowError(/NOMUS_API_URL/);
    expect(() =>
      loadConfig({ NOMUS_API_URL: 'http://localhost:3100', NOMUS_API_KEY: '  ' }),
    ).toThrowError(/NOMUS_API_KEY/);
  });
});

describe('configWarnings', () => {
  it('is silent for a nk_test_ key', () => {
    expect(configWarnings({ apiUrl: 'http://localhost:3100', apiKey: 'nk_test_abc' })).toEqual([]);
  });

  it('advises least scope for a nk_live_ key', () => {
    const warnings = configWarnings({ apiUrl: 'http://localhost:3100', apiKey: 'nk_live_abc' });
    expect(warnings.join(' ')).toMatch(/only the 'read:policies' and 'evaluate' scopes/);
  });

  it('flags keys that do not look like Nomus keys', () => {
    const warnings = configWarnings({ apiUrl: 'http://localhost:3100', apiKey: 'sk-something' });
    expect(warnings.join(' ')).toMatch(/does not look like a Nomus key/);
  });
});
