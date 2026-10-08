/**
 * Extract a human-readable message from an API error.
 *
 * Prefers the server-provided `response.data.error` (the Nomus API's
 * standard error envelope), then `response.data.message`, then the provided
 * fallback. Never returns an empty string.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const e = err as {
    response?: { data?: { error?: unknown; message?: unknown } };
  } | null;
  const serverError = e?.response?.data?.error;
  if (typeof serverError === 'string' && serverError.trim()) return serverError;
  const serverMessage = e?.response?.data?.message;
  if (typeof serverMessage === 'string' && serverMessage.trim()) return serverMessage;
  return fallback;
}

/**
 * Like apiErrorMessage, but when the server sent validation `details`
 * (Zod issues) appends each one as "field: message" so a 400 tells the admin
 * exactly what to fix.
 */
export function apiErrorWithDetails(err: unknown, fallback: string): string {
  const base = apiErrorMessage(err, fallback);
  const details = (err as { response?: { data?: { details?: unknown } } } | null)?.response?.data?.details;
  if (!Array.isArray(details)) return base;
  const lines = details
    .map((d) => {
      const issue = d as { path?: unknown; message?: unknown };
      const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
      const message = typeof issue.message === 'string' ? issue.message : '';
      return message ? (path ? `${path}: ${message}` : message) : '';
    })
    .filter(Boolean);
  return lines.length > 0 ? `${base} (${lines.join('; ')})` : base;
}
