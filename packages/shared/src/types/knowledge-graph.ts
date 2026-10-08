export type GraphNodeType = 'article' | 'definition' | 'penalty' | 'obligation';

export type GraphEdgeType =
  | 'defines'
  | 'requires'
  | 'references'
  | 'conflicts_with'
  | 'parallels';

export interface GraphNode {
  id: string;
  sourceId: string;
  nodeType: GraphNodeType;
  referenceKey: string;
  title: string;
  contentSummary: string;
  jurisdiction: string;
  createdAt: string;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: GraphEdgeType;
  confidence: number;
  description: string;
  createdAt: string;
}

export interface ConflictAlert {
  jurisdictionA: string;
  jurisdictionB: string;
  nodeA: GraphNode;
  nodeB: GraphNode;
  edge: GraphEdge;
  description: string;
}
