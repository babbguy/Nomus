import { eq, or } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { graphNodes, graphEdges } from '../db/schema.js';

export interface ImpactNode {
  id: string;
  referenceKey: string;
  title: string;
  jurisdiction: string;
  distance: number;
  relationship: string;
}

/**
 * Trace the impact of a node change through the knowledge graph.
 * BFS traversal following edges outward from the changed node.
 */
export function traceImpact(nodeId: string, maxDepth = 3): ImpactNode[] {
  const db = getDb();
  const visited = new Set<string>();
  const impact: ImpactNode[] = [];
  let frontier = [nodeId];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      visited.add(currentId);

      // Find all edges from/to this node
      const edges = db.select().from(graphEdges)
        .where(or(
          eq(graphEdges.fromNodeId, currentId),
          eq(graphEdges.toNodeId, currentId),
        ))
        .all();

      for (const edge of edges) {
        const neighborId = edge.fromNodeId === currentId ? edge.toNodeId : edge.fromNodeId;
        if (visited.has(neighborId)) continue;

        const neighbor = db.select().from(graphNodes)
          .where(eq(graphNodes.id, neighborId))
          .get();

        if (neighbor) {
          impact.push({
            id: neighbor.id,
            referenceKey: neighbor.referenceKey,
            title: neighbor.title,
            jurisdiction: neighbor.jurisdiction,
            distance: depth,
            relationship: edge.edgeType,
          });
          nextFrontier.push(neighborId);
        }
      }
    }

    frontier = nextFrontier;
  }

  return impact;
}
