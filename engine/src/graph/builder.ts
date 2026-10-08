import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { graphNodes, graphEdges } from '../db/schema.js';
import type { GraphNodeType } from '@nomus/shared';

/**
 * Create or update a node in the regulatory knowledge graph.
 */
export function upsertGraphNode(
  sourceId: string,
  nodeType: GraphNodeType,
  referenceKey: string,
  title: string,
  contentSummary: string,
  jurisdiction: string,
): string {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db.select().from(graphNodes)
    .where(eq(graphNodes.referenceKey, referenceKey))
    .get();

  if (existing) {
    db.update(graphNodes).set({
      title,
      contentSummary,
      updatedAt: now,
    }).where(eq(graphNodes.id, existing.id)).run();
    return existing.id;
  }

  const id = randomUUID();
  db.insert(graphNodes).values({
    id,
    sourceId,
    nodeType,
    referenceKey,
    title,
    contentSummary,
    jurisdiction,
    createdAt: now,
    updatedAt: now,
  }).run();

  return id;
}

/**
 * Create an edge (relationship) between two graph nodes.
 */
export function createGraphEdge(
  fromNodeId: string,
  toNodeId: string,
  edgeType: 'defines' | 'requires' | 'references' | 'conflicts_with' | 'parallels',
  confidence: number,
  description: string,
): string {
  const db = getDb();
  const id = randomUUID();

  db.insert(graphEdges).values({
    id,
    fromNodeId,
    toNodeId,
    edgeType,
    confidence,
    description,
    createdAt: new Date().toISOString(),
  }).run();

  return id;
}

/**
 * Get all existing graph nodes for cross-referencing during translation.
 */
export function getAllGraphNodes() {
  const db = getDb();
  return db.select({
    id: graphNodes.id,
    referenceKey: graphNodes.referenceKey,
    title: graphNodes.title,
    jurisdiction: graphNodes.jurisdiction,
    nodeType: graphNodes.nodeType,
  }).from(graphNodes).all();
}
