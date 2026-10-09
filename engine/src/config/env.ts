import { z } from 'zod';

const envSchema = z.object({
  NOMUS_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  NOMUS_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  NOMUS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NOMUS_LOG_FORMAT: z.enum(['json', 'text']).default('text'),

  // Database
  NOMUS_DB_PATH: z.string().default('./data/nomus.db'),

  // Security
  NOMUS_SIGNING_KEY_SECRET: z.string().default(''),
  NOMUS_ADMIN_BOOTSTRAP_KEY: z.string().default(''),

  // LLM — Anthropic
  NOMUS_ANTHROPIC_API_KEY: z.string().optional(),
  NOMUS_LLM_CLASSIFIER_PROVIDER: z.enum(['anthropic', 'google', 'openai']).default('anthropic'),
  NOMUS_LLM_CLASSIFIER_MODEL: z.string().default('claude-haiku-4-5-20251001'),

  // LLM — Google
  NOMUS_GOOGLE_AI_KEY: z.string().optional(),
  NOMUS_LLM_TRANSLATOR_PROVIDER: z.enum(['anthropic', 'google', 'openai']).default('anthropic'),
  NOMUS_LLM_TRANSLATOR_MODEL: z.string().default('claude-haiku-4-5-20251001'),

  // LLM — OpenAI
  NOMUS_OPENAI_API_KEY: z.string().optional(),
  NOMUS_LLM_FALLBACK_PROVIDER: z.enum(['anthropic', 'google', 'openai', 'none']).default('none'),

  // Portal Admin (REQUIRED — no defaults in production)
  NOMUS_ADMIN_EMAIL: z.string().email().default('admin@example.com'),
  NOMUS_ADMIN_PASSWORD: z.string().default(''),

  // Modus Integration
  NOMUS_MODUS_API_URL: z.string().optional(),
  NOMUS_MODUS_API_KEY: z.string().optional(),

  // Outbound webhook signing.
  // While 'true' (default), the dispatcher emits the legacy body-only
  // X-Nomus-Signature alongside the timestamp-bound
  // X-Nomus-Signature-V2 so existing consumers keep verifying during the
  // migration window. Set to 'false' once ALL consumers verify V2 — the
  // legacy header stops being sent and replay protection is fully closed.
  NOMUS_WEBHOOK_LEGACY_SIGNATURE: z.enum(['true', 'false']).default('true'),

  // Error tracking. UNSET by default = a true no-op: the Sentry SDK
  // is never initialized, zero network egress, zero overhead. Self-hosted
  // deployments that must keep all telemetry in-house leave this blank.
  // When set, only route/status/error metadata is sent — never request
  // bodies, query strings, regulatory content, or org data (see
  // observability/error-tracking.ts beforeSend).
  NOMUS_SENTRY_DSN: z.string().optional(),
  NOMUS_SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

  // Scheduling — strip surrounding quotes (common .env shell-quoting issue)
  NOMUS_SCRAPE_CRON: z.string().default('0 2 * * *').transform((v) => v.replace(/^['"]|['"]$/g, '')),

  // Raw snapshot retention (days). UNSET by default = raw snapshots are kept
  // FOREVER, because they are the byte-exact provenance record behind the
  // source-exact regulation guarantee (raw_bytes_hash). When set, snapshots
  // older than N days are purged weekly — but the most recent snapshot per
  // source is always kept.
  NOMUS_RAW_SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().positive().optional(),

  // Scout
  NOMUS_CONGRESS_GOV_API_KEY: z.string().default('DEMO_KEY'), // Free from https://api.congress.gov/sign-up/
  NOMUS_SCOUT_ENABLED: z.enum(['true', 'false']).default('true'),
  NOMUS_SCOUT_CRON: z.string().default('0 */6 * * *').transform((v) => v.replace(/^['"]|['"]$/g, '')),
  NOMUS_SCOUT_KEYWORD_THRESHOLD: z.coerce.number().min(0).max(1).default(0.15),
  NOMUS_SCOUT_AUTO_PROMOTE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  NOMUS_SCOUT_LLM_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(10),

  // Headless browser fetch (ACCESS-ESCALATION tier). Default OFF.
  // When 'true', sources that block bots or render via JavaScript (and sources
  // flagged needsHeadless) are escalated to a headless Chromium capture before
  // being held for manual upload. Enabling this requires the browser binary on
  // the host: `npx playwright install chromium` (~150MB). It is NOT pulled by
  // `npm ci` — the engine builds and all tests run without it. When disabled or
  // the browser is absent, headless is skipped and the source escalates to
  // manual-hold (refuse-to-guess).
  NOMUS_HEADLESS_ENABLED: z.enum(['true', 'false']).default('false'),
  // Optional proxy URL passed to the headless browser context
  // (e.g. http://user:pass@host:port or socks5://host:port). Wired straight
  // into chromium.launch({ proxy }).
  NOMUS_HEADLESS_PROXY: z.string().optional(),

  // CORS
  NOMUS_CORS_ORIGIN: z.string().default(''),

  // Internal API URL — used by background tasks (e.g. GitHub webhook scanner)
  // that need to call the engine's own HTTP API. Defaults to a loopback bind
  // on the configured port; set explicitly when the engine sits behind a
  // reverse proxy or runs in a multi-container deployment.
  NOMUS_INTERNAL_API_URL: z.string().optional(),

  // OAuth — Google
  NOMUS_GOOGLE_CLIENT_ID: z.string().optional(),
  NOMUS_GOOGLE_CLIENT_SECRET: z.string().optional(),


  // Rule Approval
  NOMUS_REQUIRE_RULE_APPROVAL: z.enum(['true', 'false']).default('false'),

  // Email — Resend
  NOMUS_RESEND_API_KEY: z.string().optional(),
  NOMUS_FROM_EMAIL: z.string().default('Nomus <noreply@example.com>'),
  NOMUS_RESEND_API_URL: z.string().url().default('https://api.resend.com'),

  // CPG integrations: allow Jira and webhook targets on private or loopback
  // addresses. Off by default; the release gate sets it for its local fakes.
  NOMUS_CPG_ALLOW_PRIVATE_TARGETS: z.enum(['true', 'false']).default('false'),

  // Push Notifications — ntfy (free, self-hostable)
  NOMUS_NTFY_URL: z.string().optional(), // default: https://ntfy.sh
  NOMUS_NTFY_TOPIC: z.string().optional(), // e.g. "nomus-alerts"
  NOMUS_NTFY_TOKEN: z.string().optional(), // optional access token for private topics

  // Slack Webhook
  NOMUS_SLACK_WEBHOOK_URL: z.string().optional(),

  // Notifications
  NOMUS_NOTIFICATION_EMAIL: z.string().optional(),

  // GitHub App
  NOMUS_GITHUB_APP_ID: z.string().optional(),
  NOMUS_GITHUB_APP_PRIVATE_KEY: z.string().optional(), // base64-encoded PEM
  NOMUS_GITHUB_WEBHOOK_SECRET: z.string().optional(),
  NOMUS_GITHUB_CLIENT_ID: z.string().optional(),
  NOMUS_GITHUB_CLIENT_SECRET: z.string().optional(),

  // Request limits (security controls, not plan-based). Generous defaults for
  // a single-tenant self-hosted install; tighten for shared deployments.
  NOMUS_RATE_LIMIT_RPM: z.coerce.number().int().min(1).default(600),
  NOMUS_MAX_API_KEYS_PER_ORG: z.coerce.number().int().min(1).default(100),
  NOMUS_MAX_SSE_CONNECTIONS_PER_ORG: z.coerce.number().int().min(1).default(100),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

/**
 * Validate required secrets and config that must be set in production.
 * In development, missing values get safe defaults with console warnings.
 */
function validateStartupRequirements(config: Env): void {
  const isProd = config.NOMUS_ENV === 'production' || process.env.NODE_ENV === 'production';
  const errors: string[] = [];
  const warnings: string[] = [];

  // NOMUS_SIGNING_KEY_SECRET — required 32+ chars
  if (!config.NOMUS_SIGNING_KEY_SECRET || config.NOMUS_SIGNING_KEY_SECRET.length < 32) {
    if (isProd) {
      errors.push('NOMUS_SIGNING_KEY_SECRET must be set (min 32 chars) in production');
    } else {
      warnings.push('NOMUS_SIGNING_KEY_SECRET is missing or too short (min 32 chars) — set it in engine/.env');
    }
  }

  // NOMUS_ADMIN_BOOTSTRAP_KEY — required 10+ chars
  if (!config.NOMUS_ADMIN_BOOTSTRAP_KEY || config.NOMUS_ADMIN_BOOTSTRAP_KEY.length < 10) {
    if (isProd) {
      errors.push('NOMUS_ADMIN_BOOTSTRAP_KEY must be set (min 10 chars) in production');
    } else {
      warnings.push('NOMUS_ADMIN_BOOTSTRAP_KEY is missing or too short (min 10 chars) — no bootstrap API key will be created');
    }
  }

  // NOMUS_ADMIN_PASSWORD — required 12+ chars
  if (!config.NOMUS_ADMIN_PASSWORD || config.NOMUS_ADMIN_PASSWORD.length < 12) {
    if (isProd) {
      errors.push('NOMUS_ADMIN_PASSWORD must be set (min 12 chars) in production');
    } else {
      warnings.push('NOMUS_ADMIN_PASSWORD is missing or too short (min 12 chars) — no admin user will be created');
    }
  }

  // NOMUS_CORS_ORIGIN — required in production
  if (!config.NOMUS_CORS_ORIGIN) {
    if (isProd) {
      errors.push('NOMUS_CORS_ORIGIN must be set in production (e.g. https://nomus.yourdomain.com)');
    } else {
      warnings.push('NOMUS_CORS_ORIGIN not set — defaulting to http://localhost:5173 for development');
    }
  }

  if (isProd && config.NOMUS_CPG_ALLOW_PRIVATE_TARGETS === 'true') {
    warnings.push('NOMUS_CPG_ALLOW_PRIVATE_TARGETS is true: CPG integrations may target private and loopback addresses');
  }

  // The admin login must not be a shipped placeholder or a publicly listed
  // contact address: a guessable admin identity plus any future password-flow
  // weakness is an unnecessarily large foothold.
  const PUBLISHED_ADMIN_EMAILS = ['admin@example.com'];
  if (isProd && PUBLISHED_ADMIN_EMAILS.includes(config.NOMUS_ADMIN_EMAIL)) {
    errors.push(
      `NOMUS_ADMIN_EMAIL must not be a shipped default or public contact address `
      + `(got "${config.NOMUS_ADMIN_EMAIL}") — set it to a real mailbox you control`,
    );
  }

  // NOMUS_CONGRESS_GOV_API_KEY — DEMO_KEY is the public default and is
  // shared/rate-limited globally. Scout will degrade silently in prod
  // once a noisy neighbour exhausts the bucket.
  if (
    isProd
    && config.NOMUS_SCOUT_ENABLED === 'true'
    && config.NOMUS_CONGRESS_GOV_API_KEY === 'DEMO_KEY'
  ) {
    warnings.push(
      'NOMUS_CONGRESS_GOV_API_KEY is using the public DEMO_KEY in production with Scout enabled — '
      + 'sign up at https://api.congress.gov/sign-up/ to avoid silent rate-limit degradation',
    );
  }

  // Print warnings in dev mode
  for (const w of warnings) {
    console.warn(`[Nomus] WARNING: ${w}`);
  }

  // Fail hard in production
  if (errors.length > 0) {
    console.error('\n[Nomus] FATAL: Missing required configuration for production:\n');
    for (const e of errors) {
      console.error(`  ✗ ${e}`);
    }
    console.error('\nSet these environment variables and restart.\n');
    process.exit(1);
  }
}

export function loadEnv(): Env {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`\n[Nomus] Invalid environment configuration:\n${formatted}\n`);
    process.exit(1);
  }

  const config = result.data;

  // Validate production requirements / warn in dev
  validateStartupRequirements(config);

  // Apply dev-mode fallbacks for optional values
  if (!config.NOMUS_CORS_ORIGIN) {
    config.NOMUS_CORS_ORIGIN = 'http://localhost:5173';
  }

  _env = config;
  return _env;
}

export function env(): Env {
  if (!_env) return loadEnv();
  return _env;
}
