/**
 * Provenance for MCP tool answers.
 *
 * The Nomus engine stores a SHA-256 hash of the unmodified HTTP body for
 * every regulation snapshot (`raw_bytes_hash` on `raw_snapshots` — the
 * source-exact guarantee). Those per-snapshot byte hashes are not yet exposed
 * on the customer-facing API surface (they ship with the Provenance Archive
 * API). What IS available today, and what we attach to every answer:
 *
 *  - corpus state hash: SHA-256 over the sorted Ed25519 signatures of every
 *    active rule (`GET /api/v1/policies/hash`), plus its computation time —
 *    a verifiable fingerprint of the exact rule corpus that produced the
 *    answer.
 *  - per-rule fields where the endpoint returns them: `signature` (Ed25519
 *    over the rule's canonical JSON), `legalReference`, `createdAt`,
 *    `updatedAt`.
 *
 * This module never fails a tool call: if the hash endpoint is unreachable
 * the provenance block says so explicitly instead of being silently omitted.
 */

import { NomusClient } from './api-client.js';

export interface CorpusStamp {
  /** SHA-256 over sorted Ed25519 rule signatures of all active rules. */
  stateHash: string;
  /** Number of active rules covered by the hash. */
  ruleCount: number;
  /** When the engine computed the hash (UTC ISO-8601). */
  computedAt: string;
}

export interface Provenance {
  nomusApiUrl: string;
  /** When this MCP server retrieved the answer (UTC ISO-8601). */
  retrievedAt: string;
  /** Corpus fingerprint, or null when the hash endpoint could not be reached. */
  corpus: CorpusStamp | null;
  notes: string[];
}

const PROVENANCE_NOTE =
  'corpus.stateHash is a SHA-256 over the sorted Ed25519 signatures of every active rule in the Nomus ' +
  'corpus at retrieval time — a verifiable fingerprint of the rule set that produced this answer. ' +
  'Nomus additionally stores a SHA-256 of the raw HTTP bytes of every source regulation snapshot ' +
  '(source-exact guarantee); per-snapshot byte hashes are served via the Provenance Archive API. ' +
  'Where rule objects appear in this answer, their `signature`, `legalReference`, and `updatedAt` fields ' +
  'are per-rule provenance.';

interface HashResponse {
  stateHash?: unknown;
  ruleCount?: unknown;
  computedAt?: unknown;
}

/**
 * Fetch the corpus fingerprint. Degrades to an explicit "unavailable" note
 * rather than throwing — provenance must never mask an otherwise-successful
 * answer, and must never be silently absent either.
 */
export async function buildProvenance(client: NomusClient): Promise<Provenance> {
  const retrievedAt = new Date().toISOString();
  try {
    const hash = await client.get<HashResponse>('/api/v1/policies/hash');
    if (
      typeof hash.stateHash === 'string' &&
      typeof hash.ruleCount === 'number' &&
      typeof hash.computedAt === 'string'
    ) {
      return {
        nomusApiUrl: client.apiUrl,
        retrievedAt,
        corpus: {
          stateHash: hash.stateHash,
          ruleCount: hash.ruleCount,
          computedAt: hash.computedAt,
        },
        notes: [PROVENANCE_NOTE],
      };
    }
    return {
      nomusApiUrl: client.apiUrl,
      retrievedAt,
      corpus: null,
      notes: [
        PROVENANCE_NOTE,
        'Corpus state hash unavailable: /api/v1/policies/hash returned an unexpected shape.',
      ],
    };
  } catch (err) {
    return {
      nomusApiUrl: client.apiUrl,
      retrievedAt,
      corpus: null,
      notes: [
        PROVENANCE_NOTE,
        `Corpus state hash unavailable: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}
