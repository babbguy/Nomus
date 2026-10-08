import { eq, and, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client.js';
import { graphEdges, graphNodes, policyRules, regulatorySignals } from '../db/schema.js';
import type { ConflictAlert } from '@nomus/shared';
import { logger } from '../logger.js';

/**
 * Find all cross-jurisdiction conflicts in the knowledge graph.
 * These are edges of type "conflicts_with" where the two nodes
 * belong to different jurisdictions.
 */
export function detectConflicts(): ConflictAlert[] {
  const db = getDb();

  const conflictEdges = db.select().from(graphEdges)
    .where(eq(graphEdges.edgeType, 'conflicts_with'))
    .all();

  const conflicts: ConflictAlert[] = [];

  for (const edge of conflictEdges) {
    const fromNode = db.select().from(graphNodes)
      .where(eq(graphNodes.id, edge.fromNodeId))
      .get();
    const toNode = db.select().from(graphNodes)
      .where(eq(graphNodes.id, edge.toNodeId))
      .get();

    if (!fromNode || !toNode) continue;

    // Only report cross-jurisdiction conflicts
    if (fromNode.jurisdiction !== toNode.jurisdiction) {
      conflicts.push({
        jurisdictionA: fromNode.jurisdiction,
        jurisdictionB: toNode.jurisdiction,
        nodeA: {
          id: fromNode.id,
          sourceId: fromNode.sourceId,
          nodeType: fromNode.nodeType as 'article' | 'definition' | 'penalty' | 'obligation',
          referenceKey: fromNode.referenceKey,
          title: fromNode.title,
          contentSummary: fromNode.contentSummary,
          jurisdiction: fromNode.jurisdiction,
          createdAt: fromNode.createdAt,
          updatedAt: fromNode.updatedAt,
        },
        nodeB: {
          id: toNode.id,
          sourceId: toNode.sourceId,
          nodeType: toNode.nodeType as 'article' | 'definition' | 'penalty' | 'obligation',
          referenceKey: toNode.referenceKey,
          title: toNode.title,
          contentSummary: toNode.contentSummary,
          jurisdiction: toNode.jurisdiction,
          createdAt: toNode.createdAt,
          updatedAt: toNode.updatedAt,
        },
        edge: {
          id: edge.id,
          fromNodeId: edge.fromNodeId,
          toNodeId: edge.toNodeId,
          edgeType: edge.edgeType as 'conflicts_with',
          confidence: edge.confidence,
          description: edge.description,
          createdAt: edge.createdAt,
        },
        description: edge.description,
      });
    }
  }

  return conflicts;
}

/**
 * Automatically detect cross-jurisdiction conflicts from policy rules.
 * Finds rules with the same category but different effects across jurisdictions.
 * Creates graph edges and radar signals for newly discovered conflicts.
 */
export function autoDetectConflicts(): { newConflicts: number } {
  const db = getDb();
  const rules = db.select().from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();

  // Group rules by category
  const byCategory: Record<string, typeof rules> = {};
  for (const rule of rules) {
    if (!byCategory[rule.category]) byCategory[rule.category] = [];
    byCategory[rule.category].push(rule);
  }

  let newConflicts = 0;
  const now = new Date().toISOString();

  for (const [category, categoryRules] of Object.entries(byCategory)) {
    // Compare rules across jurisdictions
    for (let i = 0; i < categoryRules.length; i++) {
      for (let j = i + 1; j < categoryRules.length; j++) {
        const ruleA = categoryRules[i];
        const ruleB = categoryRules[j];

        // Only cross-jurisdiction
        if (ruleA.jurisdiction === ruleB.jurisdiction) continue;

        // Only if effects conflict (deny vs flag, deny vs allow_with_audit, etc.)
        if (ruleA.effect === ruleB.effect) continue;

        // Check if this conflict is already tracked
        const existingEdge = db.select().from(graphEdges)
          .where(eq(graphEdges.description, `auto:${ruleA.ruleKey}↔${ruleB.ruleKey}`))
          .get();

        if (existingEdge) continue;

        // Create conflict graph nodes if they don't exist, then create edge
        const nodeAId = ensureGraphNode(db, ruleA, now);
        const nodeBId = ensureGraphNode(db, ruleB, now);

        db.insert(graphEdges).values({
          id: randomUUID(),
          fromNodeId: nodeAId,
          toNodeId: nodeBId,
          edgeType: 'conflicts_with',
          confidence: 0.8,
          description: `auto:${ruleA.ruleKey}↔${ruleB.ruleKey}`,
          createdAt: now,
        }).run();

        // Create radar signal for the conflict
        db.insert(regulatorySignals).values({
          id: randomUUID(),
          title: `Conflict: ${ruleA.jurisdiction} vs ${ruleB.jurisdiction} on ${category}`,
          jurisdiction: ruleA.jurisdiction,
          stage: 'active',
          likelihoodPercent: 100,
          summary: `${ruleA.ruleKey} (${ruleA.effect}) conflicts with ${ruleB.ruleKey} (${ruleB.effect}). ${ruleA.jurisdiction} and ${ruleB.jurisdiction} have different requirements for ${category}.`,
          detectedAt: now,
          createdAt: now,
          updatedAt: now,
        }).run();

        newConflicts++;
      }
    }
  }

  if (newConflicts > 0) {
    logger.info({ newConflicts }, 'Auto-detected cross-jurisdiction conflicts');
  }

  return { newConflicts };
}

function ensureGraphNode(db: ReturnType<typeof getDb>, rule: { id: string; ruleKey: string; jurisdiction: string; humanSummary: string; sourceId: string; category: string }, now: string): string {
  // Check if node exists for this rule
  const existing = db.select().from(graphNodes)
    .where(eq(graphNodes.referenceKey, rule.ruleKey))
    .get();

  if (existing) return existing.id;

  const nodeId = randomUUID();
  db.insert(graphNodes).values({
    id: nodeId,
    sourceId: rule.sourceId,
    nodeType: 'obligation',
    referenceKey: rule.ruleKey,
    title: rule.ruleKey,
    contentSummary: rule.humanSummary,
    jurisdiction: rule.jurisdiction,
    createdAt: now,
    updatedAt: now,
  }).run();

  return nodeId;
}
