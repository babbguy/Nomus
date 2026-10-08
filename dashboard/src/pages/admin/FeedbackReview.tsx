import { useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import EmptyState from '../../components/ui/EmptyState';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';

interface FeedbackSummary {
  ruleId: string;
  ruleKey: string;
  totalFeedback: number;
  falsePositives: number;
  falseNegatives: number;
  inaccurate: number;
  helpful: number;
  accuracyScore: number;
}

export default function FeedbackReview() {
  const [summary, setSummary] = useState<FeedbackSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function fetchSummary() {
    api.get('/dashboard/feedback-summary')
      .then((r) => {
        setSummary(r.data.summary);
        setLoading(false);
      })
      .catch((err) => {
        setError(apiErrorMessage(err, 'Failed to load feedback data.'));
        setLoading(false);
      });
  }

  function load() {
    setLoading(true);
    setError(null);
    fetchSummary();
  }

  useEffect(() => {
    fetchSummary();
  }, []);

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
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-accent-dim">
          <MessageSquare size={20} className="text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Feedback Review</h1>
          <p className="text-sm text-text-secondary">Customer feedback on policy rule accuracy — data flywheel</p>
        </div>
      </div>

      {summary.length === 0 ? (
        <EmptyState title="No feedback yet" description="Customer feedback will appear here as they report issues with policy rules." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-text-muted">
                <th className="px-4 py-3 font-medium">Rule</th>
                <th className="px-4 py-3 font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Helpful</th>
                <th className="px-4 py-3 font-medium">False +</th>
                <th className="px-4 py-3 font-medium">False -</th>
                <th className="px-4 py-3 font-medium">Inaccurate</th>
                <th className="px-4 py-3 font-medium">Accuracy</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {summary.map((s) => (
                <tr key={s.ruleId} className="hover:bg-surface-hover transition">
                  <td className="px-4 py-3 font-mono text-xs text-accent">{s.ruleKey}</td>
                  <td className="px-4 py-3 text-text-primary">{s.totalFeedback}</td>
                  <td className="px-4 py-3 text-success">{s.helpful}</td>
                  <td className="px-4 py-3 text-warning">{s.falsePositives}</td>
                  <td className="px-4 py-3 text-danger">{s.falseNegatives}</td>
                  <td className="px-4 py-3 text-danger">{s.inaccurate}</td>
                  <td className="px-4 py-3">
                    <Badge variant={s.accuracyScore >= 0.8 ? 'success' : s.accuracyScore >= 0.5 ? 'warning' : 'danger'}>
                      {Math.round(s.accuracyScore * 100)}%
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
