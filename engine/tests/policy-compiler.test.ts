import { describe, it, expect } from 'vitest';
import { canonicalJSON } from '../src/core/policy-compiler.js';

describe('canonicalJSON', () => {
  it('sorts keys alphabetically', () => {
    const result = canonicalJSON({ zebra: 'z', apple: 'a', mango: 'm' });
    expect(result).toBe('{"apple":"a","mango":"m","zebra":"z"}');
  });

  it('produces deterministic output regardless of input order', () => {
    const a = canonicalJSON({ b: 2, a: 1, c: 3 });
    const b = canonicalJSON({ c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('handles nested objects', () => {
    const result = canonicalJSON({ z: { b: 2, a: 1 }, a: 'first' });
    // Top-level keys sorted, nested object preserved as JSON.stringify handles it
    expect(result).toContain('"a":"first"');
    expect(result).toContain('"z":{');
  });

  it('handles empty object', () => {
    expect(canonicalJSON({})).toBe('{}');
  });

  it('handles arrays as values', () => {
    const result = canonicalJSON({ tags: ['b', 'a'], name: 'test' });
    expect(result).toContain('"name":"test"');
    expect(result).toContain('"tags":["b","a"]');
  });

  it('handles null values', () => {
    const result = canonicalJSON({ a: null as unknown, b: 'present' });
    expect(result).toContain('"a":null');
  });

  it('produces no whitespace', () => {
    const result = canonicalJSON({ key: 'value', another: 'one' });
    expect(result).not.toMatch(/\s/);
  });
});
