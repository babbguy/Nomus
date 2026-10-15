/**
 * SQL fragments shared by the numbered CPG migrations, so every table states
 * its conventions (design spec §2.2) with identical text.
 *
 * These helpers return strings that become part of a migration's statements,
 * and so part of its checksum. Never change the text a helper emits: an
 * applied migration whose checksum changes fails startup. Add a new helper
 * instead.
 */

const HEX = '[0-9a-f]';

/** GLOB for a lowercase, hyphenated UUID (8-4-4-4-12 hex digits). */
const UUID_GLOB = `'${HEX.repeat(8)}-${HEX.repeat(4)}-${HEX.repeat(4)}-${HEX.repeat(4)}-${HEX.repeat(12)}'`;

/** GLOB for `new Date().toISOString()`: UTC, milliseconds, trailing Z. */
const ISO_GLOB = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'";

/** CHECK body: the column holds a lowercase hyphenated UUID. */
export function uuidCheck(col: string): string {
  return `(length(${col}) = 36 AND ${col} GLOB ${UUID_GLOB})`;
}

/** CHECK body: the column holds a UTC ISO-8601 timestamp with milliseconds. */
export function isoCheck(col: string): string {
  return `(${col} GLOB ${ISO_GLOB})`;
}

/** CHECK body: a nullable timestamp column is NULL or ISO-8601 UTC. */
export function isoOrNullCheck(col: string): string {
  return `(${col} IS NULL OR ${col} GLOB ${ISO_GLOB})`;
}

/** CHECK body: 0/1 boolean. */
export function boolCheck(col: string): string {
  return `(${col} IN (0, 1))`;
}

/** CHECK body: exactly 64 lowercase hex characters (a SHA-256 digest). */
export function sha256HexCheck(col: string): string {
  return `(length(${col}) = 64 AND ${col} NOT GLOB '*[^0-9a-f]*')`;
}

/**
 * The two triggers that make a table strictly append-only (§2.2): any UPDATE
 * or DELETE aborts with SQLITE_CONSTRAINT_TRIGGER.
 */
export function appendOnlyTriggers(table: string): string[] {
  return [
    `CREATE TRIGGER trg_${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
    `CREATE TRIGGER trg_${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
  ];
}

/** A trigger that forbids DELETE on a projection table (rows are never removed). */
export function noDeleteTrigger(table: string): string {
  return `CREATE TRIGGER trg_${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} rows cannot be deleted'); END`;
}

/**
 * A projection guard (§2.2): an UPDATE that changes any of `immutable`
 * aborts. Columns not listed stay mutable.
 */
export function immutableColumnsTrigger(table: string, immutable: string[]): string {
  const changed = immutable.map((col) => `NEW.${col} IS NOT OLD.${col}`).join(' OR ');
  return `CREATE TRIGGER trg_${table}_immutable_columns BEFORE UPDATE ON ${table} WHEN ${changed} BEGIN SELECT RAISE(ABORT, '${table}: immutable column changed'); END`;
}
