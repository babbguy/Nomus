import Modal from '../../../components/ui/Modal';
import type { ErrorDetail } from './types';

// ---------------------------------------------------------------------------
// Error detail modal
// ---------------------------------------------------------------------------
export default function ErrorDetailModal({ errorModal, onClose }: {
  errorModal: ErrorDetail | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={errorModal !== null}
      onClose={onClose}
      title="Error Details"
      width="max-w-2xl"
    >
      {errorModal && (
        <div className="space-y-4">
          {/* Source info */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[11px] text-text-muted uppercase tracking-wide mb-0.5">Source</p>
              <p className="text-sm text-text-primary font-medium">{errorModal.sourceName}</p>
            </div>
            <div>
              <p className="text-[11px] text-text-muted uppercase tracking-wide mb-0.5">Source ID</p>
              <p className="text-xs text-text-secondary font-mono">{errorModal.sourceId}</p>
            </div>
            <div className="col-span-2">
              <p className="text-[11px] text-text-muted uppercase tracking-wide mb-0.5">URL</p>
              <a href={errorModal.sourceUrl} target="_blank" rel="noopener noreferrer"
                className="text-xs text-accent hover:underline break-all">{errorModal.sourceUrl}</a>
            </div>
            {errorModal.stepReached != null && (
              <div>
                <p className="text-[11px] text-text-muted uppercase tracking-wide mb-0.5">Step Reached</p>
                <p className="text-sm text-text-primary">{errorModal.stepReached} of 4</p>
              </div>
            )}
            <div>
              <p className="text-[11px] text-text-muted uppercase tracking-wide mb-0.5">Consecutive Failures</p>
              <p className={`text-sm font-medium ${errorModal.consecutiveFailures >= 2 ? 'text-danger' : 'text-text-primary'}`}>
                {errorModal.consecutiveFailures}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-text-muted uppercase tracking-wide mb-0.5">Timestamp</p>
              <p className="text-xs text-text-secondary">{new Date(errorModal.timestamp).toLocaleString()}</p>
            </div>
          </div>

          {/* Full error message */}
          <div>
            <p className="text-[11px] text-text-muted uppercase tracking-wide mb-1.5">Error Message</p>
            <pre className="text-xs font-mono text-danger bg-danger/5 border border-danger/20 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words max-h-64">
              {errorModal.error}
            </pre>
          </div>

          {/* Troubleshooting hints */}
          <div className="p-3 bg-surface-hover rounded-lg">
            <p className="text-[11px] text-text-muted uppercase tracking-wide mb-1.5">Troubleshooting</p>
            <ul className="text-xs text-text-secondary space-y-1">
              <li>• Check if the URL is still accessible in a browser</li>
              <li>• The site may block automated requests (CAPTCHAs, rate limits)</li>
              <li>• For paywalled sources, switch to Manual mode and upload the file</li>
              <li>• Check if the content selector still matches the page structure</li>
              {errorModal.consecutiveFailures >= 3 && (
                <li className="text-danger font-medium">• This source has failed 3+ times — consider uploading manually or updating the URL</li>
              )}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}
