import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { canonicalJson, sha256Hex } from '@nomus/scanner/corporate';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgQuorumConfigVersions } from '../../db/schema-cpg.js';
import { appendAuditEvent } from '../audit/log.js';
import { CpgError } from '../errors.js';
import { cpgSign, quorumSignedText } from '../policies/signing.js';
import { SEED_QUORUM_CONFIG, quorumConfigSchema, type QuorumConfig } from './schema.js';

/**
 * The versioned, signed quorum configuration store (design spec §4.4).
 * Append-only: a change is a new version (max + 1); a rollback is a new
 * version that copies an old config. Version 1 is the seed (§4.2), written by
 * `system:seed` the first time the org's quorum is needed (signing needs the
 * instance key, which is initialized after the startup migrations).
 */

const QUORUM_SEED_ACTOR = 'system:seed';

export interface QuorumVersion {
  id: string;
  orgId: string;
  version: number;
  config: QuorumConfig;
  configHash: string;
  changeNote: string;
  createdBy: string;
  createdAt: string;
  signature: string;
}

function configHashOf(config: QuorumConfig): string {
  return sha256Hex(canonicalJson(config));
}

function toVersion(row: typeof cpgQuorumConfigVersions.$inferSelect): QuorumVersion {
  // Stored configs are validated on write; a row that no longer parses is corruption, never silently used.
  const config = quorumConfigSchema.parse(JSON.parse(row.config));
  return { ...row, config };
}

function insertVersion(db: Db, orgId: string, version: number, config: QuorumConfig, changeNote: string, createdBy: string): QuorumVersion {
  const createdAt = new Date().toISOString();
  const configHash = configHashOf(config);
  const row = {
    id: randomUUID(),
    orgId,
    version,
    config: canonicalJson(config),
    configHash,
    changeNote,
    createdBy,
    createdAt,
    signature: cpgSign(quorumSignedText({ orgId, version, configHash, createdAt })),
  };
  db.insert(cpgQuorumConfigVersions).values(row).run();
  appendAuditEvent(db, {
    orgId, actor: createdBy, action: 'quorum.version_created', targetType: 'quorum', targetId: row.id,
    payload: { version, configHash, changeNote },
  });
  return { ...row, config };
}

/** The current (highest) version, seeding version 1 if the org has none. */
export function currentQuorum(db: Db, orgId: string): QuorumVersion {
  return rawSqlite(db).transaction(() => {
    const row = db.select().from(cpgQuorumConfigVersions)
      .where(eq(cpgQuorumConfigVersions.orgId, orgId))
      .orderBy(desc(cpgQuorumConfigVersions.version)).limit(1).get();
    if (row) return toVersion(row);
    return insertVersion(db, orgId, 1, SEED_QUORUM_CONFIG, 'Seed configuration (brief §5 defaults)', QUORUM_SEED_ACTOR);
  })();
}

export function getQuorumVersion(db: Db, orgId: string, version: number): QuorumVersion | null {
  const row = db.select().from(cpgQuorumConfigVersions)
    .where(and(eq(cpgQuorumConfigVersions.orgId, orgId), eq(cpgQuorumConfigVersions.version, version))).get();
  return row ? toVersion(row) : null;
}

export function listQuorumVersions(db: Db, orgId: string): QuorumVersion[] {
  currentQuorum(db, orgId);
  return db.select().from(cpgQuorumConfigVersions)
    .where(eq(cpgQuorumConfigVersions.orgId, orgId))
    .orderBy(asc(cpgQuorumConfigVersions.version)).all().map(toVersion);
}

/** Append a new version (PUT /quorum). Database-dependent checks run in the caller first. */
export function createQuorumVersion(db: Db, orgId: string, config: QuorumConfig, changeNote: string, actor: string): QuorumVersion {
  if (!actor.startsWith('user:')) throw new CpgError(403, 'user_identity_required', 'Quorum versions are created by a user');
  return rawSqlite(db).transaction(() => {
    const current = currentQuorum(db, orgId);
    return insertVersion(db, orgId, current.version + 1, config, changeNote, actor);
  })();
}
