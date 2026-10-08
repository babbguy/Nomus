import { useEffect, useCallback, useRef, useState } from 'react';

interface UseSSEOptions {
  jurisdictions?: string[];
  onEvent?: (event: MessageEvent) => void;
  enabled?: boolean;
}

export function useSSE({ jurisdictions = [], onEvent, enabled = true }: UseSSEOptions = {}) {
  const [connected, setConnected] = useState(false);

  const sourceRef = useRef<EventSource | null>(null);
  const onEventRef = useRef(onEvent);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the callback ref up to date without triggering reconnects
  const syncRef = useCallback(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => { syncRef(); }, [syncRef]);

  // Serialize jurisdictions to a stable string for the dependency array
  const jurisdictionsKey = jurisdictions.join(',');

  useEffect(() => {
    if (!enabled) return;

    function connect() {
      const params = new URLSearchParams();
      if (jurisdictionsKey) params.set('jurisdictions', jurisdictionsKey);

      const url = `/api/v1/stream?${params.toString()}`;
      const source = new EventSource(url, { withCredentials: true });
      sourceRef.current = source;

      source.onopen = () => setConnected(true);

      source.addEventListener('connected', () => {
        setConnected(true);
      });

      source.addEventListener('policy.created', (e) => onEventRef.current?.(e));
      source.addEventListener('policy.updated', (e) => onEventRef.current?.(e));
      source.addEventListener('policy.revoked', (e) => onEventRef.current?.(e));
      source.addEventListener('conflict.detected', (e) => onEventRef.current?.(e));

      source.onerror = () => {
        setConnected(false);
        source.close();
        // Auto-reconnect after 5 seconds
        reconnectTimerRef.current = setTimeout(connect, 5000);
      };
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [enabled, jurisdictionsKey]);

  return { connected };
}
