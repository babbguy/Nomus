import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodError } from 'zod';

/**
 * CPG error envelope (design spec §9.1): `{ error, code, details? }`.
 * Services throw CpgError; route handlers render it with cpgErrorResponse.
 */
export class CpgError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CpgError';
  }
}

export function cpgErrorResponse(c: Context, err: CpgError): Response {
  const body: { error: string; code: string; details?: unknown } = { error: err.message, code: err.code };
  if (err.details !== undefined) body.details = err.details;
  return c.json(body, err.status);
}

export function cpgError(c: Context, status: ContentfulStatusCode, code: string, error: string, details?: unknown): Response {
  return cpgErrorResponse(c, new CpgError(status, code, error, details));
}

export const notFound = (what: string) => new CpgError(404, 'not_found', `${what} not found`);

export function invalidInput(err: ZodError): CpgError {
  return new CpgError(400, 'invalid_input', 'Invalid input', err.issues);
}
