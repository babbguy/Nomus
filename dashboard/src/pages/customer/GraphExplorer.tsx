import { useEffect, useState, useRef } from 'react';
import { GitFork, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import Card from '../../components/ui/Card';

import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import ErrorState from '../../components/ui/ErrorState';
import JurisdictionTag from '../../components/domain/JurisdictionTag';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface GraphNode {
  id: string;
  referenceKey: string;
  title: string;
  jurisdiction: string;
  nodeType: string;
  contentSummary: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface ImpactResult {
  sourceNode: GraphNode;
  impactedNodes: Array<{
    id: string;
    referenceKey: string;
    title: string;
    jurisdiction: string;
    distance: number;
    relationship: string;
  }>;
}

const nodeTypeColors: Record<string, string> = {
  article: '#00e5a0',
  definition: '#3b82f6',
  penalty: '#ef4444',
  obligation: '#f59e0b',
};

export default function GraphExplorer() {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [impact, setImpact] = useState<ImpactResult | null>(null);
  const [conflicts, setConflicts] = useState<unknown[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      api.get('/graph/nodes'),
      api.get('/graph/conflicts'),
    ]).then(([nodesRes, conflictsRes]) => {
      const loadedNodes = nodesRes.data.nodes.map((n: GraphNode, i: number) => ({
        ...n,
        x: 400 + Math.cos((i / nodesRes.data.nodes.length) * Math.PI * 2) * 200,
        y: 300 + Math.sin((i / nodesRes.data.nodes.length) * Math.PI * 2) * 200,
      }));
      setNodes(loadedNodes);
      setConflicts(conflictsRes.data.conflicts);
      setLoading(false);
    }).catch(() => {
      setError('Failed to load graph data.');
      setLoading(false);
    });
  }

  useEffect(() => {
    Promise.all([
      api.get('/graph/nodes'),
      api.get('/graph/conflicts'),
    ]).then(([nodesRes, conflictsRes]) => {
      const loadedNodes = nodesRes.data.nodes.map((n: GraphNode, i: number) => ({
        ...n,
        x: 400 + Math.cos((i / nodesRes.data.nodes.length) * Math.PI * 2) * 200,
        y: 300 + Math.sin((i / nodesRes.data.nodes.length) * Math.PI * 2) * 200,
      }));
      setNodes(loadedNodes);
      setConflicts(conflictsRes.data.conflicts);
      setLoading(false);
    }).catch(() => {
      setError('Failed to load graph data.');
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!canvasRef.current || nodes.length === 0) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    const canvas = canvasRef.current;
    canvas.width = canvas.offsetWidth * 2;
    canvas.height = canvas.offsetHeight * 2;
    ctx.scale(2, 2);

    ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);
    ctx.save();
    ctx.scale(zoom, zoom);

    // Draw nodes
    for (const node of nodes) {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const color = nodeTypeColors[node.nodeType] ?? '#6b7280';
      const isSelected = selectedNode?.id === node.id;

      // Node circle
      ctx.beginPath();
      ctx.arc(x, y, isSelected ? 10 : 7, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      if (isSelected) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Label
      ctx.fillStyle = '#9ca3af';
      ctx.font = '9px IBM Plex Sans, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(node.referenceKey, x, y + 18);
    }

    ctx.restore();
  }, [nodes, selectedNode, zoom]);

  async function handleNodeClick(node: GraphNode) {
    setSelectedNode(node);
    setImpactError(null);
    setImpact(null);
    try {
      const { data } = await api.get(`/graph/impact/${node.id}`);
      setImpact(data);
    } catch (err) {
      setImpactError(apiErrorMessage(err, 'Failed to load impact trace'));
    }
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / zoom;
    const y = (e.clientY - rect.top) / zoom;

    // Find closest node
    let closest: GraphNode | null = null;
    let minDist = 20;
    for (const node of nodes) {
      const dx = (node.x ?? 0) - x;
      const dy = (node.y ?? 0) - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDist) {
        minDist = dist;
        closest = node;
      }
    }

    if (closest) handleNodeClick(closest);
  }

  if (error) {
    return (
      <div className="flex flex-col items-center py-20 gap-3">
        <p className="text-sm text-danger">{error}</p>
        <button onClick={load} className="px-4 py-2 text-sm bg-accent text-accent-text rounded-lg hover:opacity-90 transition">Retry</button>
      </div>
    );
  }

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-accent-dim">
            <GitFork size={20} className="text-accent" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-text-primary">Knowledge Graph</h1>
            <p className="text-sm text-text-secondary">Regulatory cross-references and relationships</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="accent">{nodes.length} nodes</Badge>
          {conflicts.length > 0 && <Badge variant="danger">{conflicts.length} conflicts</Badge>}
        </div>
      </div>

      {nodes.length === 0 ? (
        <EmptyState title="No graph nodes yet" description="Cross-references appear here once they are recorded in the knowledge graph. Running the regulation pipeline does not add them in this version." />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Canvas */}
          <Card className="lg:col-span-2 p-0 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <div className="flex gap-1">
                {Object.entries(nodeTypeColors).map(([type, color]) => (
                  <span key={type} className="flex items-center gap-1 text-[10px] text-text-muted">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                    {type}
                  </span>
                ))}
              </div>
              <div className="flex gap-1">
                <button onClick={() => setZoom((z) => Math.min(z + 0.2, 3))} className="p-1 text-text-muted hover:text-text-primary"><ZoomIn size={14} /></button>
                <button onClick={() => setZoom((z) => Math.max(z - 0.2, 0.4))} className="p-1 text-text-muted hover:text-text-primary"><ZoomOut size={14} /></button>
                <button onClick={() => setZoom(1)} className="p-1 text-text-muted hover:text-text-primary"><Maximize2 size={14} /></button>
              </div>
            </div>
            <canvas
              ref={canvasRef}
              className="w-full cursor-crosshair"
              style={{ height: 500, background: '#0a0b0f' }}
              onClick={handleCanvasClick}
            />
          </Card>

          {/* Detail Panel */}
          <div className="space-y-4">
            {selectedNode ? (
              <>
                <Card glow>
                  <h3 className="text-sm font-semibold text-accent mb-1">{selectedNode.referenceKey}</h3>
                  <p className="text-sm text-text-primary mb-2">{selectedNode.title}</p>
                  <p className="text-xs text-text-secondary mb-3">{selectedNode.contentSummary}</p>
                  <div className="flex items-center gap-2">
                    <JurisdictionTag code={selectedNode.jurisdiction} />
                    <Badge variant="default">{selectedNode.nodeType}</Badge>
                  </div>
                </Card>

                {impactError && (
                  <Card>
                    <ErrorState compact message={impactError} onRetry={() => handleNodeClick(selectedNode)} />
                  </Card>
                )}

                {impact && impact.impactedNodes.length > 0 && (
                  <Card>
                    <h3 className="text-sm font-semibold text-text-secondary mb-2">
                      Impact Trace ({impact.impactedNodes.length} connected)
                    </h3>
                    <div className="space-y-2">
                      {impact.impactedNodes.map((n) => (
                        <div key={n.id} className="flex items-center justify-between py-1.5">
                          <div className="min-w-0">
                            <p className="text-xs font-mono text-accent truncate">{n.referenceKey}</p>
                            <p className="text-xs text-text-muted">{n.title}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <Badge variant="default">{n.relationship}</Badge>
                            <span className="text-[10px] text-text-muted">depth {n.distance}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
              </>
            ) : (
              <Card>
                <p className="text-sm text-text-muted text-center py-8">
                  Click a node on the graph to see details and trace its regulatory impact.
                </p>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
