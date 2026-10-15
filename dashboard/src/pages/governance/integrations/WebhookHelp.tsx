import Card from '../../../components/ui/Card';
import { WEBHOOK_HEADERS, WEBHOOK_PAYLOAD, WEBHOOK_VERIFY } from '../../../lib/cpg-integrations';

const DOCS_URL = 'https://github.com/babbguy/Nomus/blob/develop/docs/api-reference/integrations.md';
const Code = ({ children, label }: { children: string; label: string }) => (
  <pre tabIndex={0} aria-label={label} className="text-xs font-mono bg-surface-raised border border-border rounded-lg p-3 overflow-x-auto whitespace-pre text-text-secondary">{children}</pre>
);

/** What a webhook receives and how to check its signature (collapsed by default). */
export default function WebhookHelp() {
  return (
    <Card>
      <details data-testid="webhook-help">
        <summary className="cursor-pointer text-sm font-semibold text-text-primary">Webhook payload and signature</summary>
        <div className="mt-3 space-y-3 text-sm text-text-secondary">
          <p>Every notification carries a summary and a link into Nomus. It never carries source code, snippets, justifications or file paths.</p>
          <div><p className="text-xs text-text-muted mb-1">Request headers</p><Code label="Webhook request headers">{WEBHOOK_HEADERS}</Code></div>
          <div><p className="text-xs text-text-muted mb-1">JSON body</p><Code label="Webhook JSON body">{WEBHOOK_PAYLOAD}</Code></div>
          <div>
            <p className="text-xs text-text-muted mb-1">Verify the signature with the signing secret, over the raw request body</p>
            <Code label="Signature verification">{WEBHOOK_VERIFY}</Code>
          </div>
          <p>
            Failed deliveries are retried for about 21 hours; a delivery that fails for good is listed in the log, where you can retry it.{' '}
            <a href={DOCS_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">Read the full reference</a>.
          </p>
        </div>
      </details>
    </Card>
  );
}
