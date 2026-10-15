/**
 * §5.1 / §16.4: simultaneous find-or-create calls converge on one case.
 * Two worker threads, each with its own connection to one database file,
 * are released together and race through the same branches. BEGIN IMMEDIATE
 * serializes them before they read, so every branch gets exactly one case
 * and no call fails.
 */
import { describe, it, expect, afterAll, onTestFinished } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { runMigrations } from '../../db/migrate.js';

const WORKERS = 2;
/** Workers do not inherit Vitest's TypeScript transform: register tsx in each, then load the worker module. */
const WORKER_SOURCE = `require(${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm/api'))}).register();
import(${JSON.stringify(new URL('../__fixtures__/find-or-create-worker.ts', import.meta.url).href)});`;
const dir = mkdtempSync(join(tmpdir(), 'nomus-cases-race-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Result = { id: string; created: boolean } | { error: string };

describe('find-or-create under concurrency', () => {
  it('two simultaneous callers get the same case for every branch', async () => {
    const dbPath = join(dir, 'race.db');
    const sqlite = new Database(dbPath);
    onTestFinished(() => { sqlite.close(); });
    sqlite.pragma('journal_mode = WAL');
    runMigrations(drizzle(sqlite));
    const orgId = randomUUID();
    const now = new Date().toISOString();
    sqlite.prepare("INSERT INTO organizations (id, name, slug, jurisdiction_access, is_active, created_at, updated_at) VALUES (?, 'Race', ?, '[]', 1, ?, ?)")
      .run(orgId, `race-${orgId}`, now, now);

    const branches = Array.from({ length: 40 }, (_, i) => `feat/race-${i}`);
    const barrier = new SharedArrayBuffer(4);
    const runs = Array.from({ length: WORKERS }, () => new Promise<Result[]>((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { dbPath, orgId, branches, barrier, workers: WORKERS } });
      worker.once('message', resolve);
      worker.once('error', reject);
    }));
    const [first, second] = await Promise.all(runs);

    expect([...first, ...second].filter((r) => 'error' in r)).toEqual([]);
    const ok = (rs: Result[]) => rs as Array<{ id: string; created: boolean }>;
    expect(ok(first).map((r) => r.id)).toEqual(ok(second).map((r) => r.id));
    branches.forEach((_, i) => expect(Number(ok(first)[i].created) + Number(ok(second)[i].created)).toBe(1));
    expect(sqlite.prepare('SELECT count(*) AS cases FROM cpg_cases WHERE org_id = ?').get(orgId)).toEqual({ cases: branches.length });
    expect(sqlite.prepare("SELECT count(*) AS opened FROM cpg_case_events WHERE org_id = ? AND event = 'opened'").get(orgId)).toEqual({ opened: branches.length });
  }, 30_000);
});
