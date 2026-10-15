/**
 * Thrown when the Nomus API cannot be reached, returns a non-2xx status,
 * or returns a response the scanner cannot interpret.
 *
 * Consumers MUST treat this as "compliance status UNKNOWN" and fail closed —
 * never as an empty (passing) scan result. A backend outage must never turn
 * a CI compliance gate green.
 *
 * Lives in its own module (re-exported by match/rule-matcher.ts) so the
 * corporate bundle client can throw it without importing the HTTP client of
 * the regulatory matcher.
 */
export class NomusApiError extends Error {
  /** Underlying error or offending response payload, for diagnostics. */
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message, detail instanceof Error ? { cause: detail } : undefined);
    this.name = 'NomusApiError';
    this.detail = detail;
  }
}

/**
 * Type guard that survives module duplication (bundlers, npm-linked copies)
 * where `instanceof NomusApiError` may fail across realms.
 */
export function isNomusApiError(err: unknown): err is NomusApiError {
  return err instanceof Error && err.name === 'NomusApiError';
}
