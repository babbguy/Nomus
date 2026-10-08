import { create } from 'zustand';

export interface PipelineProgress {
  sourceId?: string;
  sourceName?: string;
  step: number;
  stepName: string;
  batch?: number;
  totalBatches?: number;
  percentComplete?: number;
  chunks?: number;
  requirementsSoFar?: number;
  rulesCreated?: number;
  rulesUpdated?: number;
  durationMs?: number;
  candidateRules?: number;
  /** Set on the single event that ends a run (or a Scrape All cycle). */
  done?: boolean;
  outcome?: 'completed' | 'no_change' | 'error';
  error?: string;
  stepReached?: number;
  scrapeAllSummary?: {
    total: number;
    succeeded: number;
    failed: number;
    noChange: number;
    totalRulesCreated: number;
    totalRulesUpdated: number;
    failures: Array<{ name: string; error?: string }>;
  };
}

/** Pipeline steps: 1 fetch, 2 clean, 3 verify, 4 extract + score, 5 promote. */
export const PIPELINE_STEPS = 5;

interface PipelineState {
  progress: PipelineProgress | null;
  sseConnected: boolean;
  setProgress: (p: PipelineProgress | null) => void;
  initSSE: () => void;
}

let _sse: EventSource | null = null;
let _dismissTimer: ReturnType<typeof setTimeout> | null = null;
let _retryCount = 0;
const MAX_RETRIES = 20;
const BASE_DELAY_MS = 5000;
const MAX_DELAY_MS = 60000;

export const usePipelineStore = create<PipelineState>((set) => ({
  progress: null,
  sseConnected: false,
  setProgress: (progress) => set({ progress }),

  initSSE: () => {
    // Only create one SSE connection globally
    if (_sse) return;

    _sse = new EventSource('/api/v1/stream', { withCredentials: true });
    set({ sseConnected: true });
    _retryCount = 0;

    _sse.addEventListener('pipeline.progress', (e) => {
      try {
        const data = JSON.parse(e.data) as PipelineProgress;
        set({ progress: data });

        // Clear progress 8 seconds after the run's end event. (Step numbers
        // and percentComplete also reach their maximum mid-run.)
        if (data.done) {
          if (_dismissTimer) clearTimeout(_dismissTimer);
          _dismissTimer = setTimeout(() => {
            set({ progress: null });
          }, 8000);
        }
      } catch { /* ignore */ }
    });

    _sse.onerror = () => {
      _sse?.close();
      _sse = null;
      set({ sseConnected: false });

      _retryCount++;
      if (_retryCount > MAX_RETRIES) return;

      // Exponential backoff: 5s, 10s, 20s, 40s, 60s (capped)
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, _retryCount - 1), MAX_DELAY_MS);
      setTimeout(() => {
        usePipelineStore.getState().initSSE();
      }, delay);
    };
  },
}));
