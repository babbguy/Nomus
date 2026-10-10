import { useCallback, useEffect, useState, type DependencyList } from 'react';
import { cpgErrorCode } from '../lib/cpg-errors';
import { policyErrorMessage } from '../lib/cpg-policy';

/**
 * A governance page's data: loaded on mount, whenever `deps` change and on
 * `reload`; an answer that arrives after unmount or a newer load is dropped.
 * `reload` keeps what is shown until the new answer. After a failure, `retry`
 * clears the error and the data (the skeleton shows); `retryKeepingData` only
 * the error.
 */
export function useCpgLoad<T>(load: () => Promise<T>, fallback: string, deps: DependencyList = [], message = policyErrorMessage) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<{ text: string; code: string | null } | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [key, setKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => { if (!cancelled) { setData(d); setError(null); setFetchedAt(new Date().toISOString()); } })
      .catch((err) => { if (!cancelled) setError({ text: message(err, fallback), code: cpgErrorCode(err) }); });
    return () => { cancelled = true; };
    // `load`, `fallback` and `message` are read fresh on each run; `deps` says when to run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, key]);

  const reload = useCallback(() => setKey((k) => k + 1), []);
  const retryKeepingData = useCallback(() => { setError(null); setKey((k) => k + 1); }, []);
  const retry = useCallback(() => { setData(null); retryKeepingData(); }, [retryKeepingData]);
  return { data, error: error?.text ?? null, errorCode: error?.code ?? null, fetchedAt, reload, retry, retryKeepingData };
}
