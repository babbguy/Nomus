import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { regulatorySources, rawSnapshots } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';

// ─── Types ────────────────────────────────────────────────────────

interface DiffSection {
  type: 'added' | 'removed' | 'context';
  content: string;
  lineNumber: number;
}

interface DiffResponse {
  sourceId: string;
  sourceName: string;
  jurisdiction: string;
  previousSnapshot: { date: string; hash: string };
  currentSnapshot: { date: string; hash: string };
  sections: DiffSection[];
  linesAdded: number;
  linesRemoved: number;
  sectionsChanged: number;
}

// ─── LCS-based line diff ──────────────────────────────────────────

function buildLcsTable(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }

  return table;
}

function computeLineDiff(oldText: string, newText: string, contextLines = 3): DiffSection[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const lcsTable = buildLcsTable(oldLines, newLines);

  type DiffOp = { type: 'equal' | 'insert' | 'delete'; line: string; oldIdx: number; newIdx: number };
  const ops: DiffOp[] = [];

  let i = oldLines.length;
  let j = newLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'equal', line: oldLines[i - 1], oldIdx: i, newIdx: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcsTable[i][j - 1] >= lcsTable[i - 1][j])) {
      ops.push({ type: 'insert', line: newLines[j - 1], oldIdx: i, newIdx: j });
      j--;
    } else if (i > 0) {
      ops.push({ type: 'delete', line: oldLines[i - 1], oldIdx: i, newIdx: j });
      i--;
    }
  }

  ops.reverse();

  const isChanged = ops.map((op) => op.type !== 'equal');

  const include = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (isChanged[k]) {
      const start = Math.max(0, k - contextLines);
      const end = Math.min(ops.length - 1, k + contextLines);
      for (let m = start; m <= end; m++) {
        include[m] = true;
      }
    }
  }

  const sections: DiffSection[] = [];
  let lineNum = 1;

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];

    if (!include[k]) {
      if (op.type === 'equal' || op.type === 'insert') lineNum++;
      continue;
    }

    switch (op.type) {
      case 'equal':
        sections.push({ type: 'context', content: op.line, lineNumber: lineNum });
        lineNum++;
        break;
      case 'insert':
        sections.push({ type: 'added', content: op.line, lineNumber: lineNum });
        lineNum++;
        break;
      case 'delete':
        sections.push({ type: 'removed', content: op.line, lineNumber: op.oldIdx });
        break;
    }
  }

  return sections;
}

// ─── Routes ───────────────────────────────────────────────────────

export const diffRoutes = new Hono<AppEnv>();

diffRoutes.use('*', requireSessionOrApiKey('admin'));
diffRoutes.use('*', rateLimit());

diffRoutes.get('/:sourceId', (c) => {
  const sourceId = c.req.param('sourceId');
  const snapshotId = c.req.query('snapshotId') ?? null;
  const db = getDb();

  const source = db.select().from(regulatorySources)
    .where(eq(regulatorySources.id, sourceId))
    .get();

  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  const snapshots = db.select().from(rawSnapshots)
    .where(eq(rawSnapshots.sourceId, sourceId))
    .orderBy(desc(rawSnapshots.scrapedAt))
    .all();

  if (snapshots.length < 2) {
    return c.json({
      error: 'Not enough snapshots for diff. Source needs at least 2 scrape snapshots.',
      snapshotCount: snapshots.length,
    }, 400);
  }

  let currentSnap;
  let previousSnap;

  if (snapshotId) {
    const idx = snapshots.findIndex((s) => s.id === snapshotId);
    if (idx === -1) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }
    if (idx + 1 >= snapshots.length) {
      return c.json({ error: 'No previous snapshot exists before the specified one' }, 400);
    }
    currentSnap = snapshots[idx];
    previousSnap = snapshots[idx + 1];
  } else {
    currentSnap = snapshots[0];
    previousSnap = snapshots[1];
  }

  const sections = computeLineDiff(previousSnap.content, currentSnap.content);

  const linesAdded = sections.filter((s) => s.type === 'added').length;
  const linesRemoved = sections.filter((s) => s.type === 'removed').length;

  let sectionsChanged = 0;
  let inChange = false;
  for (const section of sections) {
    if (section.type !== 'context') {
      if (!inChange) {
        sectionsChanged++;
        inChange = true;
      }
    } else {
      inChange = false;
    }
  }

  const response: DiffResponse = {
    sourceId: source.id,
    sourceName: source.name,
    jurisdiction: source.jurisdiction,
    previousSnapshot: {
      date: previousSnap.scrapedAt,
      hash: previousSnap.contentHash,
    },
    currentSnapshot: {
      date: currentSnap.scrapedAt,
      hash: currentSnap.contentHash,
    },
    sections,
    linesAdded,
    linesRemoved,
    sectionsChanged,
  };

  return c.json(response);
});

diffRoutes.get('/:sourceId/snapshots', (c) => {
  const sourceId = c.req.param('sourceId');
  const db = getDb();

  const source = db.select().from(regulatorySources)
    .where(eq(regulatorySources.id, sourceId))
    .get();

  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  const snapshots = db.select({
    id: rawSnapshots.id,
    contentHash: rawSnapshots.contentHash,
    scrapedAt: rawSnapshots.scrapedAt,
  }).from(rawSnapshots)
    .where(eq(rawSnapshots.sourceId, sourceId))
    .orderBy(desc(rawSnapshots.scrapedAt))
    .all();

  return c.json({ sourceId, sourceName: source.name, count: snapshots.length, snapshots });
});
