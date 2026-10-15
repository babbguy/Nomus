import { createHash } from 'node:crypto';

/**
 * Canonical JSON for signed and hashed CPG payloads: keys sorted at every
 * depth, no whitespace. Byte-identical to the engine's `canonicalJSON`
 * (engine/src/core/policy-compiler.ts); an engine test pins the parity, so a
 * hash or signature the server computes verifies in the client.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
