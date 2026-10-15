import { apiErrorWithDetails } from './errors';

/**
 * Message for a failed governance call: a contract mismatch keeps its own
 * message (it names the endpoint and the field), API errors use the server's
 * `{ error, code, details }` envelope, anything else the fallback.
 */
export function cpgErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.name === 'CpgContractError') return err.message;
  return apiErrorWithDetails(err, fallback);
}

/** The machine code of a CPG error response (`forbidden`, `last_org_admin`, ...), if any. */
export function cpgErrorCode(err: unknown): string | null {
  const code = (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  return typeof code === 'string' ? code : null;
}
