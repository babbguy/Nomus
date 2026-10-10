import { CheckCircle2, AlertTriangle } from 'lucide-react';
import Card from '../../../components/ui/Card';
import Badge from '../../../components/ui/Badge';
import type { CompileRecord } from '../../../api/cpg';
import { COMPILE_STATUS_HELP, COMPILE_STATUS_LABEL, TIER_LABEL, formatUtc } from '../../../lib/cpg-policy';
import { ExampleResults, GeneratedNotice, Mono, RejectionReasons, RuleView } from './parts';

/**
 * The outcome of one compile (E29/E30), success or rejection. Every
 * outcome is a stored compile record; rejection reasons are shown verbatim.
 * What the LLM produced (the rule and its suggestions) is labelled as
 * generated; the plain-English reading of the rule is derived from its data.
 */
export default function CompileResult({ record, stale = false }: { record: CompileRecord; stale?: boolean }) {
  const ok = record.status === 'compiled';
  const suggestion = record.suggestion;
  return (
    <Card className={ok ? 'border-success/30' : 'border-danger/40'}>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3" data-testid="compile-result">
        <div className="flex items-start gap-2">
          {ok ? <CheckCircle2 size={18} className="text-success shrink-0 mt-0.5" /> : <AlertTriangle size={18} className="text-danger shrink-0 mt-0.5" />}
          <div>
            <p className={`text-sm font-semibold ${ok ? 'text-success' : 'text-danger'}`} role={ok ? 'status' : 'alert'}>{COMPILE_STATUS_LABEL[record.status]}</p>
            <p className="text-xs text-text-secondary mt-0.5 max-w-3xl">{COMPILE_STATUS_HELP[record.status]}</p>
          </div>
        </div>
        <Badge variant={ok ? 'success' : 'danger'} className="font-mono">{record.status}</Badge>
      </div>

      {stale && (
        <p className="text-xs text-warning mb-3" role="status">
          You changed the policy text or the examples after this compile. Compile again before proposing.
        </p>
      )}

      {/* Why it was rejected, verbatim */}
      {suggestion && !suggestion.expressible && (
        <div className="mb-3">
          <p className="text-xs text-text-muted mb-1">Reason given by the model (generated, shown verbatim)</p>
          <p className="text-sm text-danger" data-testid="unexpressible-reason">{suggestion.reason}</p>
          {suggestion.closestExpressible && (
            <p className="text-xs text-text-secondary mt-1">Closest thing Nomus could enforce instead: {suggestion.closestExpressible}</p>
          )}
        </div>
      )}
      {!ok && !(suggestion && !suggestion.expressible) && <div className="mb-3"><RejectionReasons record={record} /></div>}

      {ok && record.compiledRule && (
        <div className="space-y-3">
          <GeneratedNotice provider={record.provider} model={record.model} />
          {suggestion && suggestion.expressible && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              <div><p className="text-text-muted">Suggested key</p><p className="font-mono text-text-primary">{suggestion.suggestedKey}</p></div>
              <div><p className="text-text-muted">Suggested title</p><p className="text-text-primary">{suggestion.title}</p></div>
              <div><p className="text-text-muted">Suggested tier</p><p className="text-text-primary">{TIER_LABEL[suggestion.suggestedTier]}</p></div>
              <div className="md:col-span-3"><p className="text-text-muted">Rationale (generated)</p><p className="text-text-secondary">{suggestion.rationale}</p></div>
              {suggestion.limitations.length > 0 && (
                <div className="md:col-span-3">
                  <p className="text-text-muted">Limitations the model noted (generated)</p>
                  <ul className="list-disc pl-5 text-text-secondary">{suggestion.limitations.map((l, i) => <li key={`${i}-${l}`}>{l}</li>)}</ul>
                </div>
              )}
            </div>
          )}
          <RuleView rule={record.compiledRule} testId="compiled-rule" />
        </div>
      )}

      {record.exampleResults && record.exampleResults.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-text-muted mb-1">Your examples, checked by the same deterministic matcher the scanner runs (examples are never sent to the LLM)</p>
          <ExampleResults results={record.exampleResults} />
        </div>
      )}

      <p className="text-[11px] text-text-muted mt-3">
        Compile record <Mono>{record.id}</Mono> · {formatUtc(record.createdAt)}
        {record.provider ? ` · ${record.provider}${record.model ? `/${record.model}` : ''}` : ''}
      </p>
    </Card>
  );
}
