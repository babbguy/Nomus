import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';

import Spinner from '../../components/ui/Spinner';
import ErrorState from '../../components/ui/ErrorState';
import { apiErrorMessage } from '../../lib/errors';
import api from '../../api/client';
import { getPolicies, type Policy } from '../../api/policies';

export default function FeedbackSubmit() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedRule, setSelectedRule] = useState('');
  const [feedbackType, setFeedbackType] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function fetchPolicies() {
    getPolicies()
      .then((r) => {
        setPolicies(r.policies);
        setLoading(false);
      })
      .catch((err) => {
        setLoadError(apiErrorMessage(err, 'Failed to load policy rules'));
        setLoading(false);
      });
  }

  function load() {
    setLoading(true);
    setLoadError(null);
    fetchPolicies();
  }

  useEffect(() => {
    fetchPolicies();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedRule || !feedbackType) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.post('/feedback', {
        ruleId: selectedRule,
        feedbackType,
        description: description || undefined,
      });
      setSuccess(true);
      setSelectedRule('');
      setFeedbackType('');
      setDescription('');
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      // Keep the form contents so the user can retry
      setSubmitError(apiErrorMessage(err, 'Failed to submit feedback'));
    }
    setSubmitting(false);
  }

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;
  if (loadError) return <ErrorState message={loadError} onRetry={load} />;

  return (
    <div>
      <h1 className="text-xl font-semibold text-text-primary mb-6">Submit Feedback</h1>
      <p className="text-sm text-text-secondary mb-6">
        Help improve Nomus's accuracy by reporting issues with policy rules.
        Your feedback directly refines how regulations are interpreted.
      </p>

      {success && (
        <div className="mb-4 p-3 bg-success/15 border border-success/30 text-success text-sm rounded-lg">
          Feedback submitted. Thank you for helping improve Nomus.
        </div>
      )}

      <Card>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">Policy Rule</label>
            <select
              value={selectedRule}
              onChange={(e) => setSelectedRule(e.target.value)}
              required
              className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary"
            >
              <option value="">Select a rule...</option>
              {policies.map((p) => (
                <option key={p.id} value={p.id}>{p.ruleKey} — {p.humanSummary.slice(0, 60)}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">Feedback Type</label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: 'false_positive', label: 'False Positive', desc: 'Rule triggered when it shouldn\'t have' },
                { value: 'false_negative', label: 'False Negative', desc: 'Rule didn\'t trigger when it should have' },
                { value: 'inaccurate', label: 'Inaccurate', desc: 'Rule content is wrong or misleading' },
                { value: 'helpful', label: 'Helpful', desc: 'This rule is accurate and useful' },
              ].map(({ value, label, desc }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFeedbackType(value)}
                  className={`text-left p-3 rounded-lg border text-sm transition ${
                    feedbackType === value
                      ? 'border-accent bg-accent-dim text-accent'
                      : 'border-border bg-surface text-text-secondary hover:bg-surface-hover'
                  }`}
                >
                  <p className="font-medium">{label}</p>
                  <p className="text-xs mt-0.5 opacity-70">{desc}</p>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">Details (optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Any additional context..."
              className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted resize-none"
            />
          </div>

          {submitError && <p className="text-sm text-danger" role="alert">{submitError}</p>}

          <Button type="submit" disabled={!selectedRule || !feedbackType || submitting}>
            <Send size={14} /> {submitting ? 'Submitting...' : 'Submit Feedback'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
