import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeTempDir(): string {
  const dir = join(tmpdir(), `nomus-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('loadConfig', () => {
  it('throws when no config file is found (not process.exit)', () => {
    const dir = makeTempDir();
    try {
      expect(() => loadConfig(dir)).toThrowError(/No .nomus.yml found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses JSON config correctly', () => {
    const dir = makeTempDir();
    const config = {
      nomus: {
        jurisdictions: ['EU'],
        api_key: 'test-key-123',
        api_url: 'http://localhost:3100',
      },
    };
    writeFileSync(join(dir, '.nomus.json'), JSON.stringify(config));
    try {
      const result = loadConfig(dir);
      expect(result.nomus.jurisdictions).toEqual(['EU']);
      expect(result.nomus.api_key).toBe('test-key-123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on invalid config (not process.exit)', () => {
    const dir = makeTempDir();
    // Missing required 'jurisdictions' field
    const config = {
      nomus: {
        api_key: 'test-key',
      },
    };
    writeFileSync(join(dir, '.nomus.json'), JSON.stringify(config));
    try {
      expect(() => loadConfig(dir)).toThrowError(/Invalid .nomus.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves env var references in YAML config', () => {
    const dir = makeTempDir();
    const yaml = `nomus:
  jurisdictions:
    - EU
  api_key: $NOMUS_TEST_KEY_XYZ`;
    writeFileSync(join(dir, '.nomus.yml'), yaml);

    // Set env var
    const originalVal = process.env.NOMUS_TEST_KEY_XYZ;
    process.env.NOMUS_TEST_KEY_XYZ = 'env-resolved-key';
    try {
      const result = loadConfig(dir);
      expect(result.nomus.api_key).toBe('env-resolved-key');
    } finally {
      if (originalVal === undefined) {
        delete process.env.NOMUS_TEST_KEY_XYZ;
      } else {
        process.env.NOMUS_TEST_KEY_XYZ = originalVal;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
