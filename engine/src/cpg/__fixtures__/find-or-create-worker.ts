/**
 * Worker for the find-or-create concurrency test: opens its own connection to
 * the shared database file (as a second engine process would), waits at a
 * barrier until every worker is ready, then calls findOrCreateCase for each
 * branch and reports the case ids, or the error code of a failed call.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { findOrCreateCase } from '../cases/service.js';

const { dbPath, orgId, branches, barrier, workers } = workerData as {
  dbPath: string; orgId: string; branches: string[]; barrier: SharedArrayBuffer; workers: number;
};

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);

const gate = new Int32Array(barrier);
Atomics.add(gate, 0, 1);
Atomics.notify(gate, 0);
for (let seen = Atomics.load(gate, 0); seen < workers; seen = Atomics.load(gate, 0)) Atomics.wait(gate, 0, seen, 1000);

const results = branches.map((branch) => {
  try {
    const r = findOrCreateCase(db, { orgId, repo: 'acme/app', branch }, 'user:worker');
    return { id: r.case.id, created: r.created };
  } catch (err) {
    return { error: (err as { code?: string }).code ?? String(err) };
  }
});
sqlite.close();
parentPort!.postMessage(results);
