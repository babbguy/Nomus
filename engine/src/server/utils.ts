/**
 * Safely parse an integer from a query parameter string.
 * Returns defaultVal if the input is undefined, empty, or NaN.
 */
export function safeParseInt(value: string | undefined, defaultVal: number): number {
  if (value === undefined || value === '') return defaultVal;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultVal : parsed;
}

/**
 * Safely parse the JSON body from a Hono request context.
 * Returns { data, error } to avoid unhandled exceptions from malformed JSON.
 */
export async function safeJson<T = unknown>(c: { req: { json: () => Promise<T> } }): Promise<{ data: T; error: null } | { data: null; error: string }> {
  try {
    const data = await c.req.json();
    return { data, error: null };
  } catch {
    return { data: null, error: 'Invalid or missing JSON body' };
  }
}

/**
 * Identify who is making an admin request, for audit trails: the signed-in
 * user for browser sessions, the API key otherwise.
 */
export function actorOf(c: { get: (key: 'userId' | 'apiKeyId') => string | undefined }): string {
  const userId = c.get('userId');
  if (userId) return `user:${userId}`;
  const apiKeyId = c.get('apiKeyId');
  if (apiKeyId) return `apikey:${apiKeyId}`;
  return 'unknown';
}
