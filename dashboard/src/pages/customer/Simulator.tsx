import { useEffect, useState } from 'react';
import { Zap, AlertTriangle, CheckCircle, XCircle, Globe, ChevronDown, ChevronUp } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';

import SeverityBadge from '../../components/domain/SeverityBadge';
import EffectBadge from '../../components/domain/EffectBadge';
import JurisdictionTag from '../../components/domain/JurisdictionTag';
import { runSimulation, getSimulationVocabulary, type SimulateResult, type SimulateInput, type SimulationVocabulary } from '../../api/simulate';
import { apiErrorMessage } from '../../lib/errors';
import { JURISDICTIONS } from '@nomus/shared';

// Capabilities, data types and sectors are the values the active rules are
// written in (GET /simulate/vocabulary): a rule applies only on an exact match.
function TagSelector({ options, selected, onToggle, label }: {
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  label: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-text-secondary mb-2">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onToggle(opt)}
            className={`px-2.5 py-1 text-xs rounded-full border transition ${
              selected.includes(opt)
                ? 'bg-accent-dim text-accent border-accent-border'
                : 'bg-surface text-text-muted border-border hover:border-border-bright'
            }`}
          >
            {opt.replace(/_/g, ' ')}
          </button>
        ))}
      </div>
    </div>
  );
}

function RiskIndicator({ risk }: { risk: string }) {
  const config = {
    critical: { color: 'text-critical', bg: 'bg-critical/15', icon: XCircle, label: 'Critical Risk' },
    high: { color: 'text-high', bg: 'bg-high/15', icon: AlertTriangle, label: 'High Risk' },
    medium: { color: 'text-medium', bg: 'bg-medium/15', icon: AlertTriangle, label: 'Medium Risk' },
    low: { color: 'text-low', bg: 'bg-low/15', icon: CheckCircle, label: 'Low Risk' },
    none: { color: 'text-success', bg: 'bg-success/15', icon: CheckCircle, label: 'No Issues' },
  }[risk] ?? { color: 'text-text-muted', bg: 'bg-surface-hover', icon: CheckCircle, label: risk };

  const Icon = config.icon;
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${config.bg}`}>
      <Icon size={18} className={config.color} />
      <span className={`text-sm font-semibold ${config.color}`}>{config.label}</span>
    </div>
  );
}

function MarketCard({ market }: { market: SimulateResult['markets'][string] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <JurisdictionTag code={market.jurisdiction} />
          <RiskIndicator risk={market.riskLevel} />
        </div>
        <div className="flex items-center gap-3 text-sm text-text-secondary">
          <span>{market.triggered} of {market.totalRules} rules triggered</span>
          {market.rules.length > 0 && (
            <button onClick={() => setExpanded(!expanded)} className="text-text-muted hover:text-accent transition">
              {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          )}
        </div>
      </div>

      {expanded && market.rules.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {market.rules.map((rule, i) => (
            <div key={i} className="flex items-start justify-between py-2">
              <div className="min-w-0">
                <p className="font-mono text-xs text-accent">{rule.ruleKey}</p>
                <p className="text-sm text-text-primary mt-0.5">{rule.humanSummary}</p>
                <p className="text-xs text-text-muted mt-0.5">{rule.legalReference}</p>
                <div className="flex gap-1 mt-1">
                  {rule.matchedOn.map((m, j) => (
                    <span key={j} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-hover text-text-muted">{m}</span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-3">
                <SeverityBadge severity={rule.severity} />
                <EffectBadge effect={rule.effect} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function Simulator() {
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [dataTypes, setDataTypes] = useState<string[]>([]);
  const [targetMarkets, setTargetMarkets] = useState<string[]>([]);
  const [sector, setSector] = useState('');
  const [modelType, setModelType] = useState('');
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [vocab, setVocab] = useState<SimulationVocabulary | null>(null);
  const [vocabError, setVocabError] = useState('');

  useEffect(() => {
    getSimulationVocabulary()
      .then(setVocab)
      .catch((err) => setVocabError(apiErrorMessage(err, 'Failed to load the capability vocabulary')));
  }, []);

  function toggle(arr: string[], val: string, setter: (v: string[]) => void) {
    setter(arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]);
  }

  async function handleSimulate() {
    if (capabilities.length === 0 || targetMarkets.length === 0) {
      setError('Select at least one capability and one target market.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const input: SimulateInput = {
        capabilities,
        dataTypes,
        targetMarkets,
        ...(modelType && { modelType }),
        ...(sector && { sector }),
      };
      const data = await runSimulation(input);
      setResult(data);
    } catch (err) {
      setError(apiErrorMessage(err, 'Simulation failed. Please try again.'));
    }
    setLoading(false);
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-accent-dim">
          <Zap size={20} className="text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Compliance Simulator</h1>
          <p className="text-sm text-text-secondary">What regulations apply if you deploy these AI capabilities in these markets?</p>
        </div>
      </div>

      {vocabError && (
        <div className="mb-4 p-3 bg-danger/10 border border-danger/30 text-danger text-sm rounded-lg">{vocabError}</div>
      )}
      {error && (
        <div className="mb-4 p-3 bg-danger/10 border border-danger/30 text-danger text-sm rounded-lg">{error}</div>
      )}

      {/* Input Form */}
      <Card className="mb-6">
        <div className="space-y-5">
          <TagSelector
            label="AI Capabilities *"
            options={vocab?.capabilities ?? []}
            selected={capabilities}
            onToggle={(v) => toggle(capabilities, v, setCapabilities)}
          />

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-2">Target Markets *</label>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(JURISDICTIONS).map(([code]) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => toggle(targetMarkets, code, setTargetMarkets)}
                  className={`px-2.5 py-1 text-xs rounded-full border transition flex items-center gap-1 ${
                    targetMarkets.includes(code)
                      ? 'bg-accent-dim text-accent border-accent-border'
                      : 'bg-surface text-text-muted border-border hover:border-border-bright'
                  }`}
                >
                  <Globe size={10} /> {code}
                </button>
              ))}
            </div>
          </div>

          <TagSelector
            label="Data Types Processed"
            options={vocab?.dataTypes ?? []}
            selected={dataTypes}
            onToggle={(v) => toggle(dataTypes, v, setDataTypes)}
          />

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">Sector</label>
              <select
                value={sector}
                onChange={(e) => setSector(e.target.value)}
                className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary"
              >
                <option value="">Any sector</option>
                {(vocab?.sectors ?? []).map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">Model Type</label>
              <select
                value={modelType}
                onChange={(e) => setModelType(e.target.value)}
                className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary"
              >
                <option value="">Any type</option>
                <option value="generative">Generative (LLM)</option>
                <option value="discriminative">Discriminative (Classifier)</option>
                <option value="embedding">Embedding</option>
                <option value="vision">Vision</option>
                <option value="multimodal">Multimodal</option>
              </select>
            </div>
          </div>

          <Button onClick={handleSimulate} disabled={loading} className="w-full sm:w-auto">
            <Zap size={14} /> {loading ? 'Analyzing...' : 'Run Simulation'}
          </Button>
        </div>
      </Card>

      {/* Results */}
      {result && (
        <div>
          {/* Overall Summary */}
          <Card className="mb-4" glow>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-text-secondary mb-1">Overall Risk Assessment</p>
                <RiskIndicator risk={result.overallRisk} />
              </div>
              <div className="text-right">
                <p className="text-3xl font-bold text-text-primary">{result.totalRulesTriggered}</p>
                <p className="text-xs text-text-muted">rules triggered across {Object.keys(result.markets).length} markets</p>
              </div>
            </div>
          </Card>

          {/* Conflicts */}
          {result.conflicts.length > 0 && (
            <Card className="mb-4 border-warning/30">
              <h3 className="text-sm font-semibold text-warning mb-2 flex items-center gap-2">
                <AlertTriangle size={14} /> Cross-Jurisdiction Conflicts Detected
              </h3>
              <div className="space-y-2">
                {result.conflicts.map((c, i) => (
                  <div key={i} className="text-sm text-text-secondary">
                    <span className="text-text-primary font-medium">{c.jurisdictionA}</span>
                    {' ↔ '}
                    <span className="text-text-primary font-medium">{c.jurisdictionB}</span>
                    {': '}{c.description}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Gap Analysis */}
          {result.gapAnalysis.uncoveredMarkets.length > 0 && (
            <Card className="mb-4">
              <h3 className="text-sm font-semibold text-text-secondary mb-2">Gap Analysis</h3>
              <p className="text-sm text-text-primary">
                No policy rules found for: {result.gapAnalysis.uncoveredMarkets.map((m) => (
                  <JurisdictionTag key={m} code={m} />
                ))}
              </p>
              <p className="text-xs text-text-muted mt-1">
                These markets may not yet have AI-specific regulations in Nomus's database, or the regulations have not been scraped yet.
              </p>
            </Card>
          )}

          {/* Per-Market Breakdown */}
          <h3 className="text-sm font-semibold text-text-secondary mb-3">Market Breakdown</h3>
          <div className="space-y-3">
            {Object.values(result.markets).map((market) => (
              <MarketCard key={market.jurisdiction} market={market} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
