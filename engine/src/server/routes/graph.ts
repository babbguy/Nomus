import { Hono } from 'hono';
import { eq, and, type SQLWrapper } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { graphNodes } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { traceImpact } from '../../graph/traverser.js';
import { detectConflicts } from '../../graph/conflict-detector.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import { safeParseInt } from '../utils.js';

export const graphRoutes = new Hono<AppEnv>();

graphRoutes.use('*', requireSessionOrApiKey('read:policies'));
graphRoutes.use('*', rateLimit());

// Query graph nodes
graphRoutes.get('/nodes', (c) => {
  const db = getDb();
  const jurisdiction = c.req.query('jurisdiction');
  const nodeType = c.req.query('type');
  const limit = Math.min(safeParseInt(c.req.query('limit'), 500), 1000);
  const offset = safeParseInt(c.req.query('offset'), 0);

  const conditions: SQLWrapper[] = [];
  if (jurisdiction) conditions.push(eq(graphNodes.jurisdiction, jurisdiction));
  if (nodeType) conditions.push(eq(graphNodes.nodeType, nodeType as typeof graphNodes.nodeType.enumValues[number]));

  const query = db.select().from(graphNodes);
  const nodes = (conditions.length > 0 ? query.where(and(...conditions)) : query)
    .limit(limit).offset(offset).all();

  return c.json({ count: nodes.length, nodes, _disclaimer: LEGAL_DISCLAIMER });
});

// Trace impact of a node change
graphRoutes.get('/impact/:nodeId', (c) => {
  const nodeId = c.req.param('nodeId');
  const maxDepth = safeParseInt(c.req.query('depth'), 3);

  const db = getDb();
  const node = db.select().from(graphNodes)
    .where(eq(graphNodes.id, nodeId))
    .get();

  if (!node) return c.json({ error: 'Node not found' }, 404);

  const impact = traceImpact(nodeId, maxDepth);

  return c.json({
    sourceNode: node,
    impactedNodes: impact,
    totalImpacted: impact.length,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// List cross-jurisdiction conflicts
graphRoutes.get('/conflicts', (c) => {
  const conflicts = detectConflicts();

  return c.json({
    count: conflicts.length,
    conflicts,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});
