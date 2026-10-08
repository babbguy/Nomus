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

/**
 * apiErrorMessage for requests made with responseType 'blob' (downloads):
 * the error body arrives as a Blob, so the server's message has to be read
 * out of it first, or users only ever see the generic fallback.
 */
export async function blobApiErrorMessage(err: unknown, fallback: string): Promise<string> {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text()) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message;
    } catch {
      // not JSON: fall through to the fallback
    }
    return fallback;
  }
  return apiErrorMessage(err, fallback);
}
