import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './loader.js';

let dir: string;

function writeConfig(body: string, name = '.nomus.yml'): void {
  writeFileSync(join(dir, name), body, 'utf-8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nomus-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.NOMUS_TEST_KEY;
});

describe('loadConfig', () => {
  it('reads a list written at the same indentation as its key', () => {
    writeConfig(['nomus:', '  jurisdictions:', '  - EU', '  - US-CA', ''].join('\n'));
    expect(loadConfig(dir).nomus.jurisdictions).toEqual(['EU', 'US-CA']);
  });

  it('reads four-space indentation', () => {
    writeConfig(['nomus:', '    jurisdictions:', '        - UK', '    sector: healthcare', ''].join('\n'));
    const { nomus } = loadConfig(dir);
    expect(nomus.jurisdictions).toEqual(['UK']);
    expect(nomus.sector).toBe('healthcare');
  });

  it('reads nested detectors, booleans and numbers', () => {
    writeConfig([
      'nomus:',
      '  jurisdictions: [EU]',
      '  max_taint_depth: 5',
      '  detectors:',
      '    phi_pattern: false',
      '    data_flow: false',
      '',
    ].join('\n'));
    const { nomus } = loadConfig(dir);
    expect(nomus.max_taint_depth).toBe(5);
    expect(nomus.detectors.phi_pattern).toBe(false);
    expect(nomus.detectors.data_flow).toBe(false);
    expect(nomus.detectors.import).toBe(true);
  });

  it('expands $NAME values from the environment', () => {
    process.env.NOMUS_TEST_KEY = 'nk_live_from_env';
    writeConfig(['nomus:', '  api_key: $NOMUS_TEST_KEY', '  jurisdictions: [EU]', ''].join('\n'));
    expect(loadConfig(dir).nomus.api_key).toBe('nk_live_from_env');
  });

  it('fails clearly when a referenced environment variable is unset', () => {
    writeConfig(['nomus:', '  api_key: $NOMUS_TEST_KEY', '  jurisdictions: [EU]', ''].join('\n'));
    expect(() => loadConfig(dir)).toThrow(/NOMUS_TEST_KEY is not set/);
  });

  it('reports malformed YAML instead of ignoring it', () => {
    writeConfig(['nomus:', '  jurisdictions: [EU', ''].join('\n'));
    expect(() => loadConfig(dir)).toThrow(/Invalid YAML in \.nomus\.yml/);
  });

  it('reports values that fail validation', () => {
    writeConfig(['nomus:', '  jurisdictions: []', ''].join('\n'));
    expect(() => loadConfig(dir)).toThrow(/Invalid \.nomus\.yml[\s\S]*jurisdictions/);
  });

  it('still reads .nomus.json', () => {
    writeConfig(JSON.stringify({ nomus: { jurisdictions: ['JP'] } }), '.nomus.json');
    expect(loadConfig(dir).nomus.jurisdictions).toEqual(['JP']);
  });
});
