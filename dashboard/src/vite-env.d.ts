/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sentry DSN for client-side error tracking. Unset = tracking disabled. */
  readonly VITE_NOMUS_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
