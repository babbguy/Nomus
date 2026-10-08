import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

// ─── Multi-Tenancy ──────────────────────────────────────────────

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  jurisdictionAccess: text('jurisdiction_access').notNull().default('[]'), // JSON array
  industry: text('industry'),
  subIndustry: text('sub_industry'),
  // Opt-in display of the org name on the PUBLIC attestation verify
  // endpoint. Private by default — public pages must never leak org identity
  // unless the org explicitly opted in.
  showOrgOnPublicVerify: integer('show_org_on_public_verify', { mode: 'boolean' }).notNull().default(false),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  label: text('label').notNull(),
  scopes: text('scopes').notNull().default('[]'), // JSON array
  rateLimitRpm: integer('rate_limit_rpm').notNull().default(60),
  lastUsedAt: text('last_used_at'),
  expiresAt: text('expires_at'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_api_keys_hash').on(table.keyHash),
  index('idx_api_keys_org').on(table.orgId),
]);

export const usageRecords = sqliteTable('usage_records', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  apiKeyId: text('api_key_id').notNull().references(() => apiKeys.id),
  endpoint: text('endpoint').notNull(),
  method: text('method').notNull(),
  statusCode: integer('status_code').notNull(),
  responseMs: integer('response_ms').notNull(),
  recordedAt: text('recorded_at').notNull(),
}, (table) => [
  index('idx_usage_org_time').on(table.orgId, table.recordedAt),
]);

// ─── Regulatory Sources ─────────────────────────────────────────

export const regulatorySources = sqliteTable('regulatory_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  jurisdiction: text('jurisdiction').notNull(),
  url: text('url').notNull(),
  parserType: text('parser_type', { enum: ['html', 'pdf'] }).notNull(),
  selectorConfig: text('selector_config').notNull().default('{}'), // JSON
  scrapeFrequencyHours: integer('scrape_frequency_hours').notNull().default(24),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  lastScrapedAt: text('last_scraped_at'),
  lastContentHash: text('last_content_hash'),
  provenanceGrade: text('provenance_grade').default('G'), // A-G
  tier: integer('tier').notNull().default(1), // 1-4: launch, data protection, standards, industry
  category: text('category').default('ai_regulation'), // ISO-aligned category
  // Ownership. 'registry' rows track the built-in registry and are re-synced on
  // every start; 'customized' rows started as built-ins but were edited by an
  // admin and are never touched by the sync; 'custom' rows were added by an
  // admin. NULL only on legacy rows, which the next sync classifies.
  origin: text('origin', { enum: ['registry', 'custom', 'customized'] }),
  // Lowercased registry name this row was seeded from (NULL for custom sources).
  registryKey: text('registry_key'),
  slaMaxAgeHours: integer('sla_max_age_hours').notNull().default(48),
  slaMinCompleteness: integer('sla_min_completeness').notNull().default(80),
  connectivityStatus: text('connectivity_status').default('unknown'), // unknown, reachable, blocked, timeout, error, captcha
  connectivityCheckedAt: text('connectivity_checked_at'),
  connectivityError: text('connectivity_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastSuccessfulScrapeAt: text('last_successful_scrape_at'),
  // Self-healing scraper memory: which strategy last worked for this source
  lastSuccessfulStrategy: text('last_successful_strategy'), // direct, google_cache, wayback, pdf_direct, repaired
  // auto = can be scraped automatically, manual = requires file upload (paywalled/login)
  ingestionMode: text('ingestion_mode', { enum: ['auto', 'manual'] }).notNull().default('auto'),
  // ACCESS-ESCALATION: this source is JS-rendered / bot-walled and a plain HTTP
  // fetch cannot capture it — go straight to a headless browser capture
  // (provenance 'rendered') before falling through to manual upload.
  needsHeadless: integer('needs_headless', { mode: 'boolean' }).notNull().default(false),
  // Terminal manual-upload state: set when every automated tier (scrape +
  // headless) is exhausted, so the admin UI/API can surface "awaiting manual
  // upload". Cleared automatically on the next successful capture.
  needsManualUpload: integer('needs_manual_upload', { mode: 'boolean' }).notNull().default(false),
  manualUploadReason: text('manual_upload_reason'),
  // Manual upload support — when set, pipeline processes this content instead of live scraping
  pendingUploadFile: text('pending_upload_file'), // original filename
  pendingUploadHash: text('pending_upload_hash'), // content hash of uploaded file
  pendingUploadAt: text('pending_upload_at'), // when the file was uploaded
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_sources_jurisdiction').on(table.jurisdiction),
  index('idx_sources_tier').on(table.tier),
]);

export const rawSnapshots = sqliteTable('raw_snapshots', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => regulatorySources.id),
  contentHash: text('content_hash').notNull(),
  content: text('content').notNull(),
  scrapedAt: text('scraped_at').notNull(),
  // ─── Provenance (added 2026-04-07 for source-exact guarantee) ───
  // The original HTTP response — required to prove a stored regulation
  // matches what was published at the source URL at scrape time.
  rawBytesHash: text('raw_bytes_hash'),         // SHA-256 of unmodified HTTP body
  rawBytesSize: integer('raw_bytes_size'),       // Original body size in bytes
  rawContent: text('raw_content'),               // The full unmodified body (text or base64 PDF)
  fetchedUrl: text('fetched_url'),               // Final URL after redirects
  httpStatus: integer('http_status'),            // HTTP status code (200, 301, etc.)
  contentType: text('content_type'),             // Content-Type response header
  userAgent: text('user_agent'),                 // UA that succeeded
  // ─── Provenance honesty (canonical model — see hunter/provenance.ts) ───
  // 'byte_exact': rawContent IS the unmodified single HTTP body (hash = server bytes).
  // 'assembled': Nomus's concatenation of multiple fetches — hash covers OUR
  //   assembly; per-fetch server hashes live in the manifest. Only reaches
  //   storage when EVERY expected section was captured (scraper hard-fails on skip).
  // 'healed': content came from an alternative source (Wayback/PDF) after the
  //   primary fetch failed quality; provenance fields describe THAT fetch.
  // 'stale_cache': served from local cache; no live HTTP provenance. NEVER promotable.
  // 'upload': the customer supplied the document file directly.
  provenanceMode: text('provenance_mode').notNull().default('byte_exact'),
  provenanceManifest: text('provenance_manifest'), // JSON: per-fetch {url, bytesHash, bytesSize, status} for assembled snapshots
  // ─── API-first ingestion (adapter framework) ───────────────────────────
  // Which ingestion channel produced this snapshot: 'official_api' (government
  // API/bulk feed, byte-exact against the served artifact) vs the HTML scraper.
  ingestionChannel: text('ingestion_channel'), // 'official_api' | 'bulk' | 'rss' | 'scrape' | null
  // The official immutable version coordinate (JSON PointInTimeCoordinate): the
  // exact version of the law this snapshot represents (eCFR date + title/part,
  // FR document number + publication date, EUR-Lex CELEX version) — an official
  // reference, not merely a fetch timestamp.
  pointInTimeCoordinate: text('point_in_time_coordinate'),
  // True only for snapshots written by a successful promotion. Lets the read
  // path serve the last known-good promoted snapshot and hold unverified captures.
  promoted: integer('promoted', { mode: 'boolean' }).notNull().default(false),
}, (table) => [
  index('idx_snapshots_source_time').on(table.sourceId, table.scrapedAt),
  index('idx_snapshots_raw_hash').on(table.rawBytesHash),
]);

// ─── Policy Rules (Core Output) ─────────────────────────────────

export const policyRules = sqliteTable('policy_rules', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => regulatorySources.id),
  ruleKey: text('rule_key').notNull(),
  version: integer('version').notNull().default(1),
  jurisdiction: text('jurisdiction').notNull(),
  category: text('category').notNull(),
  conditions: text('conditions').notNull(), // JSON
  effect: text('effect', { enum: ['deny', 'allow_with_audit', 'require_disclosure', 'flag'] }).notNull(),
  severity: text('severity', { enum: ['critical', 'high', 'medium', 'low'] }).notNull(),
  humanSummary: text('human_summary').notNull(),
  legalReference: text('legal_reference').notNull(),
  effectiveDate: text('effective_date').notNull(),
  expiresAt: text('expires_at'),
  industries: text('industries').notNull().default('["all"]'), // JSON array
  industryScope: text('industry_scope').notNull().default('global'), // global, sector_specific, subsector_specific
  industryNotes: text('industry_notes').notNull().default(''),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  // A locked rule was created or edited by a person; extraction never overwrites it.
  locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
  signature: text('signature').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_rules_key_unique').on(table.ruleKey),
  index('idx_rules_jurisdiction').on(table.jurisdiction),
  index('idx_rules_category').on(table.category),
  index('idx_rules_active').on(table.isActive),
]);

// ─── Knowledge Graph ──────────────────────────────────

export const graphNodes = sqliteTable('graph_nodes', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => regulatorySources.id),
  nodeType: text('node_type', { enum: ['article', 'definition', 'penalty', 'obligation'] }).notNull(),
  referenceKey: text('reference_key').notNull(),
  title: text('title').notNull(),
  contentSummary: text('content_summary').notNull(),
  jurisdiction: text('jurisdiction').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_graph_nodes_ref').on(table.referenceKey),
  index('idx_graph_nodes_jurisdiction').on(table.jurisdiction),
]);

export const graphEdges = sqliteTable('graph_edges', {
  id: text('id').primaryKey(),
  fromNodeId: text('from_node_id').notNull().references(() => graphNodes.id),
  toNodeId: text('to_node_id').notNull().references(() => graphNodes.id),
  edgeType: text('edge_type', { enum: ['defines', 'requires', 'references', 'conflicts_with', 'parallels'] }).notNull(),
  confidence: real('confidence').notNull(),
  description: text('description').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_edges_from').on(table.fromNodeId),
  index('idx_edges_to').on(table.toNodeId),
  index('idx_edges_type').on(table.edgeType),
]);

// ─── Compliance Attestation ───────────────────────────

export const attestationReceipts = sqliteTable('attestation_receipts', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  actionContext: text('action_context').notNull(), // JSON
  rulesEvaluated: text('rules_evaluated').notNull(), // JSON
  result: text('result', { enum: ['compliant', 'non_compliant', 'requires_review'] }).notNull(),
  jurisdiction: text('jurisdiction').notNull(),
  policyStateHash: text('policy_state_hash').notNull(),
  signature: text('signature').notNull(),
  evaluatedAt: text('evaluated_at').notNull(),
  // ─── Attestation lifecycle ────────────────────────────
  // The Ed25519 signature covers ONLY the immutable attested facts
  // ({ id, orgId, actionContext, result, jurisdiction, policyStateHash,
  // evaluatedAt } — see core/attestation-lifecycle.ts). The fields below are
  // operational lifecycle state, reported SEPARATELY from signature validity:
  // a revoked attestation still has a valid signature but must never be
  // presented as currently valid.
  /** Receipt format version — lets the format evolve without breaking old receipts. */
  schemaVersion: integer('schema_version').notNull().default(1),
  /** UTC ISO-8601 (Z). Null = never expires. */
  expiresAt: text('expires_at'),
  /** UTC ISO-8601 (Z). Immutable once set. */
  revokedAt: text('revoked_at'),
  /** Required when revokedAt is set. Immutable once set. */
  revocationReason: text('revocation_reason'),
  /** Attestation id that replaced this one (same org, set at creation of the new one). */
  supersededBy: text('superseded_by'),
  /** UTC ISO-8601 — when the nightly expiry sweep notified subscribers (exactly-once marker). */
  expiryNotifiedAt: text('expiry_notified_at'),
}, (table) => [
  index('idx_attestations_org_time').on(table.orgId, table.evaluatedAt),
  index('idx_attestations_result').on(table.result),
]);

// Reliance subscriptions — third parties (auditors, customers of
// customers, insurers) register to be notified when an attestation's
// lifecycle status changes (revoked / superseded / expired). Created via the
// PUBLIC subscribe endpoint (strictly validated + per-IP rate-limited).

export const attestationSubscriptions = sqliteTable('attestation_subscriptions', {
  id: text('id').primaryKey(),
  attestationId: text('attestation_id').notNull().references(() => attestationReceipts.id),
  channel: text('channel', { enum: ['email', 'webhook'] }).notNull(),
  /** Email address (channel=email) or HTTPS/HTTP webhook URL (channel=webhook). */
  target: text('target').notNull(),
  /**
   * Per-subscription HMAC secret for the webhook channel — notifications are
   * signed with the V2 scheme  (X-Nomus-Signature-V2 over
   * `${timestamp}.${body}`). Returned exactly once at creation. Null for email.
   */
  secret: text('secret'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_att_subs_attestation').on(table.attestationId),
]);

// ─── Feedback Loop ────────────────────────────────────

export const policyFeedback = sqliteTable('policy_feedback', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  ruleId: text('rule_id').notNull().references(() => policyRules.id),
  feedbackType: text('feedback_type', { enum: ['false_positive', 'false_negative', 'inaccurate', 'helpful'] }).notNull(),
  description: text('description'),
  status: text('status', { enum: ['pending', 'reviewed', 'applied'] }).notNull().default('pending'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_feedback_rule').on(table.ruleId),
  index('idx_feedback_status').on(table.status),
]);

// ─── Pipeline + Audit ───────────────────────────────────────────

export const pipelineRuns = sqliteTable('pipeline_runs', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => regulatorySources.id),
  status: text('status', { enum: ['completed', 'no_change', 'typo_only', 'error'] }).notNull(),
  stepReached: integer('step_reached').notNull(),
  diffDetected: integer('diff_detected', { mode: 'boolean' }).notNull().default(false),
  classification: text('classification'),
  rulesCreated: integer('rules_created').notNull().default(0),
  rulesUpdated: integer('rules_updated').notNull().default(0),
  llmProvider: text('llm_provider'),
  llmModel: text('llm_model'),
  llmTokensIn: integer('llm_tokens_in'),
  llmTokensOut: integer('llm_tokens_out'),
  llmCostCents: integer('llm_cost_cents'),
  errorMessage: text('error_message'),
  durationMs: integer('duration_ms').notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at').notNull(),
}, (table) => [
  index('idx_pipeline_source_time').on(table.sourceId, table.startedAt),
  index('idx_pipeline_status').on(table.status),
]);

export const policyEvents = sqliteTable('policy_events', {
  id: text('id').primaryKey(),
  eventType: text('event_type', { enum: ['policy.created', 'policy.updated', 'policy.revoked', 'conflict.detected'] }).notNull(),
  ruleId: text('rule_id').references(() => policyRules.id),
  payload: text('payload').notNull(), // JSON
  payloadSignature: text('payload_signature').notNull(),
  sequence: integer('sequence').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_events_sequence').on(table.sequence),
  index('idx_events_type').on(table.eventType),
]);

export const stateHashes = sqliteTable('state_hashes', {
  id: text('id').primaryKey(),
  hash: text('hash').notNull(),
  ruleCount: integer('rule_count').notNull(),
  computedAt: text('computed_at').notNull(),
});

export const shadowTestResults = sqliteTable('shadow_test_results', {
  id: text('id').primaryKey(),
  testName: text('test_name').notNull(),
  inputContext: text('input_context').notNull(), // JSON
  expectedEffect: text('expected_effect').notNull(),
  actualEffect: text('actual_effect').notNull(),
  passed: integer('passed', { mode: 'boolean' }).notNull(),
  durationMs: integer('duration_ms').notNull(),
  runAt: text('run_at').notNull(),
});

// ─── Portal Users + Sessions ────────────────────────────────────

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),  // nullable for OAuth users
  name: text('name').notNull(),
  role: text('role', { enum: ['platform_admin', 'member'] }).notNull().default('member'),
  authProvider: text('auth_provider').notNull().default('local'), // local, google, github
  providerId: text('provider_id'), // external OAuth ID
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_users_email').on(table.email),
  index('idx_users_org').on(table.orgId),
]);

export const passwordResetTokens = sqliteTable('password_reset_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  expiresAt: text('expires_at').notNull(),
  used: integer('used', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_reset_token').on(table.tokenHash),
]);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_sessions_token').on(table.tokenHash),
]);

// ─── Regulatory Radar (Predictive Intelligence) ─────────────────

export const regulatorySignals = sqliteTable('regulatory_signals', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').references(() => regulatorySources.id),
  title: text('title').notNull(),
  jurisdiction: text('jurisdiction').notNull(),
  stage: text('stage', { enum: ['signal', 'draft', 'committee', 'adopted', 'active'] }).notNull().default('signal'),
  likelihoodPercent: integer('likelihood_percent').notNull().default(50),
  summary: text('summary').notNull(),
  sourceUrl: text('source_url'),
  detectedAt: text('detected_at').notNull(),
  expectedEffectiveDate: text('expected_effective_date'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_signals_jurisdiction').on(table.jurisdiction),
  index('idx_signals_stage').on(table.stage),
]);

// ─── Ontology ───────────────────────────────────────────────────

export const ontologyTerms = sqliteTable('ontology_terms', {
  id: text('id').primaryKey(),
  term: text('term').notNull(),
  type: text('type', { enum: ['obligation', 'definition', 'risk_level', 'technical_requirement', 'penalty', 'applicability'] }).notNull(),
  jurisdiction: text('jurisdiction').notNull().default('universal'),
  sourceArticle: text('source_article').notNull(),
  description: text('description').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_ontology_type').on(table.type),
  index('idx_ontology_jurisdiction').on(table.jurisdiction),
]);

// ─── Scout (Regulatory Signal Discovery) ────────────────────────

export const scoutFeeds = sqliteTable('scout_feeds', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  feedType: text('feed_type', { enum: ['rss', 'atom', 'google_news', 'webpage', 'gov_api'] }).notNull(),
  apiConfig: text('api_config'), // JSON: GovApiConfig — only for gov_api feeds
  category: text('category').notNull().default('general'),
  jurisdiction: text('jurisdiction').notNull().default('global'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  checkIntervalHours: integer('check_interval_hours').notNull().default(6),
  lastCheckedAt: text('last_checked_at'),
  lastItemCount: integer('last_item_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_scout_feeds_active').on(table.isActive),
]);

export const scoutItems = sqliteTable('scout_items', {
  id: text('id').primaryKey(),
  feedId: text('feed_id').notNull().references(() => scoutFeeds.id),
  title: text('title').notNull(),
  url: text('url').notNull(),
  publishedAt: text('published_at'),
  rawSnippet: text('raw_snippet'),
  status: text('status', { enum: ['pending', 'accepted', 'rejected', 'auto_promoted'] }).notNull().default('pending'),
  keywordScore: real('keyword_score'),
  llmRelevant: integer('llm_relevant', { mode: 'boolean' }),
  confidenceScore: real('confidence_score'),
  extractedSignal: text('extracted_signal'), // JSON: { jurisdiction, stage, likelihood, summary }
  promotedSignalId: text('promoted_signal_id'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: text('reviewed_at'),
  llmCostCents: integer('llm_cost_cents').notNull().default(0),
  discoveredAt: text('discovered_at').notNull(),
}, (table) => [
  uniqueIndex('idx_scout_items_url').on(table.url),
  index('idx_scout_items_feed').on(table.feedId),
  index('idx_scout_items_status').on(table.status),
  index('idx_scout_items_confidence').on(table.confidenceScore),
]);

// ─── Blockchain Anchoring ───────────────────────────────────────

export const chainAnchors = sqliteTable('chain_anchors', {
  id: text('id').primaryKey(),
  stateHash: text('state_hash').notNull(),
  ruleCount: integer('rule_count').notNull(),
  txHash: text('tx_hash').notNull(),
  blockNumber: integer('block_number').notNull(),
  anchoredAt: text('anchored_at').notNull(),
});

// ─── Compliance Badge ───────────────────────────────────────────

export const badgeConfigs = sqliteTable('badge_configs', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  style: text('style', { enum: ['flat', 'rounded', 'pill'] }).notNull().default('rounded'),
  jurisdictions: text('jurisdictions').notNull().default('[]'), // JSON
  showScore: integer('show_score', { mode: 'boolean' }).notNull().default(true),
  showJurisdictions: integer('show_jurisdictions', { mode: 'boolean' }).notNull().default(true),
  customLabel: text('custom_label'),
  isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── Scanner Findings ───────────────────────────────────────────

export const scanFindings = sqliteTable('scan_findings', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  repo: text('repo').notNull(),
  prNumber: integer('pr_number'),
  commitSha: text('commit_sha').notNull(),
  filePath: text('file_path').notNull(),
  lineNumber: integer('line_number').notNull(),
  ruleId: text('rule_id').references(() => policyRules.id),
  ruleKey: text('rule_key').notNull(),
  severity: text('severity', { enum: ['critical', 'high', 'medium', 'low'] }).notNull(),
  effect: text('effect').notNull(),
  capabilityDetected: text('capability_detected').notNull(),
  humanSummary: text('human_summary').notNull(),
  suggestion: text('suggestion'),
  detectorSource: text('detector_source'),
  legalReference: text('legal_reference'),
  status: text('status', { enum: ['open', 'resolved', 'dismissed'] }).notNull().default('open'),
  scannedAt: text('scanned_at').notNull(),
}, (table) => [
  index('idx_scan_org_repo').on(table.orgId, table.repo),
  index('idx_scan_severity').on(table.severity),
  index('idx_scan_status').on(table.status),
]);

// ─── GitHub App ─────────────────────────────────────────────────

export const githubAppInstallations = sqliteTable('github_app_installations', {
  id: text('id').primaryKey(),
  installationId: integer('installation_id').notNull().unique(),
  orgId: text('org_id').references(() => organizations.id),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type', { enum: ['Organization', 'User'] }).notNull(),
  accessToken: text('access_token'), // encrypted
  tokenExpiresAt: text('token_expires_at'),
  repositorySelection: text('repository_selection', { enum: ['all', 'selected'] }).notNull().default('all'),
  selectedRepos: text('selected_repos').notNull().default('[]'), // JSON array
  permissions: text('permissions').notNull().default('{}'), // JSON
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  installedAt: text('installed_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_gh_install_id').on(table.installationId),
  index('idx_gh_install_org').on(table.orgId),
  index('idx_gh_install_account').on(table.accountLogin),
]);

export const webhookEvents = sqliteTable('webhook_events', {
  id: text('id').primaryKey(),
  installationId: integer('installation_id').notNull(),
  event: text('event').notNull(), // pull_request, push, installation
  action: text('action'), // opened, synchronize, created, deleted
  deliveryId: text('delivery_id').notNull().unique(),
  repo: text('repo'),
  payload: text('payload').notNull(), // JSON
  status: text('status', { enum: ['received', 'processing', 'completed', 'failed'] }).notNull().default('received'),
  errorMessage: text('error_message'),
  processedAt: text('processed_at'),
  receivedAt: text('received_at').notNull(),
}, (table) => [
  index('idx_webhook_install').on(table.installationId),
  index('idx_webhook_status').on(table.status),
  index('idx_webhook_delivery').on(table.deliveryId),
]);

// ─── Platform Settings ─────────────────────────────────────────

export const platformSettings = sqliteTable('platform_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // plain text or JSON
  updatedAt: text('updated_at').notNull(),
});

// ─── AI Bill of Materials (Phase 21) ─────────────────────────────

export const aiBomSystems = sqliteTable('ai_bom_systems', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  systemType: text('system_type', { enum: ['model', 'pipeline', 'agent', 'embedding', 'fine_tune', 'other'] }).notNull(),
  provider: text('provider').notNull().default(''), // e.g. OpenAI, Anthropic, Google, custom
  modelName: text('model_name').notNull().default(''), // e.g. gpt-4, claude-3.5-sonnet
  version: text('version').notNull().default(''),
  purpose: text('purpose').notNull().default(''), // business purpose
  capabilities: text('capabilities').notNull().default('[]'), // JSON array: ["text_generation", "classification", "code_generation"]
  dataFlows: text('data_flows').notNull().default('[]'), // JSON array: [{source, destination, dataType, pii}]
  jurisdictions: text('jurisdictions').notNull().default('[]'), // JSON array: where this system operates
  riskClassification: text('risk_classification', { enum: ['unacceptable', 'high', 'limited', 'minimal', 'unclassified'] }).notNull().default('unclassified'),
  euAiActCategory: text('eu_ai_act_category'), // Annex III category if high-risk
  regulatoryTags: text('regulatory_tags').notNull().default('[]'), // JSON array: matched regulation IDs
  deploymentType: text('deployment_type', { enum: ['production', 'staging', 'development', 'retired'] }).notNull().default('development'),
  detectedFrom: text('detected_from', { enum: ['scanner', 'manual', 'import'] }).notNull().default('manual'),
  scanFindingIds: text('scan_finding_ids').notNull().default('[]'), // JSON array: IDs from scanFindings
  lastAssessedAt: text('last_assessed_at'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  metadata: text('metadata').notNull().default('{}'), // JSON: additional provider-specific info
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_aibom_org').on(table.orgId),
  index('idx_aibom_risk').on(table.riskClassification),
  index('idx_aibom_type').on(table.systemType),
]);

export const aiBomSnapshots = sqliteTable('ai_bom_snapshots', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  systemCount: integer('system_count').notNull(),
  highRiskCount: integer('high_risk_count').notNull(),
  jurisdictionCount: integer('jurisdiction_count').notNull(),
  bomHash: text('bom_hash').notNull(), // SHA-256 of full BOM
  exportFormat: text('export_format', { enum: ['json', 'pdf'] }).notNull(),
  exportData: text('export_data').notNull(), // JSON or base64 PDF
  generatedAt: text('generated_at').notNull(),
}, (table) => [
  index('idx_aibom_snap_org').on(table.orgId),
]);

// ─── COMPL-AI Benchmarking (Phase 22) ────────────────────────────

export const benchmarkRuns = sqliteTable('benchmark_runs', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  aiBomSystemId: text('ai_bom_system_id').references(() => aiBomSystems.id),
  modelName: text('model_name').notNull(),
  provider: text('provider').notNull(),
  status: text('status', { enum: ['pending', 'running', 'completed', 'failed'] }).notNull().default('pending'),
  benchmarkSuite: text('benchmark_suite').notNull().default('compl-ai-v1'), // e.g. compl-ai-v1, custom
  benchmarksTotal: integer('benchmarks_total').notNull().default(0),
  benchmarksPassed: integer('benchmarks_passed').notNull().default(0),
  benchmarksFailed: integer('benchmarks_failed').notNull().default(0),
  overallScore: real('overall_score'), // 0-100
  resultsByPrinciple: text('results_by_principle').notNull().default('{}'), // JSON: {principle: {score, benchmarks_run, passed, failed}}
  rawResults: text('raw_results').notNull().default('[]'), // JSON: full benchmark output
  estimatedCostCents: integer('estimated_cost_cents'),
  actualCostCents: integer('actual_cost_cents'),
  durationMs: integer('duration_ms'),
  errorMessage: text('error_message'),
  triggeredBy: text('triggered_by').notNull().default('manual'), // manual, scheduled, pipeline
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_benchmark_org').on(table.orgId),
  index('idx_benchmark_model').on(table.modelName),
  index('idx_benchmark_status').on(table.status),
]);

export const benchmarkDefinitions = sqliteTable('benchmark_definitions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  principle: text('principle').notNull(), // EU AI Act principle: fairness, transparency, robustness, etc.
  description: text('description').notNull(),
  methodology: text('methodology').notNull(), // how the benchmark works
  metrics: text('metrics').notNull().default('[]'), // JSON: what's measured
  euAiActArticle: text('eu_ai_act_article'), // mapped article
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  version: text('version').notNull().default('1.0'),
  createdAt: text('created_at').notNull(),
});

// ─── Predictive Simulation (Phase 23) ────────────────────────────

export const simulationRuns = sqliteTable('simulation_runs', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  signalId: text('signal_id').references(() => regulatorySignals.id),
  signalTitle: text('signal_title').notNull(),
  signalJurisdiction: text('signal_jurisdiction').notNull(),
  signalLikelihood: integer('signal_likelihood').notNull(),
  systemsAnalyzed: integer('systems_analyzed').notNull().default(0),
  systemsImpacted: integer('systems_impacted').notNull().default(0),
  impactDetails: text('impact_details').notNull().default('[]'), // JSON: [{systemId, systemName, impact, remediationSteps, estimatedCost}]
  overallRiskLevel: text('overall_risk_level', { enum: ['critical', 'high', 'medium', 'low', 'none'] }).notNull().default('none'),
  estimatedRemediationCost: text('estimated_remediation_cost'), // NUMERIC(18,8) stored as text
  remediationRoadmap: text('remediation_roadmap').notNull().default('[]'), // JSON: [{step, priority, estimatedDays, description}]
  status: text('status', { enum: ['pending', 'running', 'completed', 'failed'] }).notNull().default('pending'),
  errorMessage: text('error_message'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_sim_org').on(table.orgId),
  index('idx_sim_signal').on(table.signalId),
  index('idx_sim_status').on(table.status),
]);

// ─── Source Data Quality Audit ────────────────────────────────────

export const sourceAuditResults = sqliteTable('source_audit_results', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => regulatorySources.id),
  snapshotGrade: text('snapshot_grade', { enum: ['A', 'B', 'C', 'D', 'F'] }),
  ruleCount: integer('rule_count').notNull().default(0),
  issueCount: integer('issue_count').notNull().default(0),
  issues: text('issues').notNull().default('[]'), // JSON: [{type, severity, description, ruleId?}]
  llmReauditScore: real('llm_reaudit_score'), // 1-10, nullable (only set on deep audit)
  llmReauditSample: integer('llm_reaudit_sample').notNull().default(0), // how many rules were re-audited
  overallVerdict: text('overall_verdict', { enum: ['pass', 'warn', 'fail'] }).notNull().default('pass'),
  durationMs: integer('duration_ms').notNull().default(0),
  auditedAt: text('audited_at').notNull(),
}, (table) => [
  index('idx_audit_source').on(table.sourceId),
  index('idx_audit_verdict').on(table.overallVerdict),
  index('idx_audit_time').on(table.auditedAt),
]);

// ─── Continuous Compliance Posture (Phase 24) ────────────────────

export const complianceScores = sqliteTable('compliance_scores', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  overallScore: real('overall_score').notNull(), // 0-100
  scoresByJurisdiction: text('scores_by_jurisdiction').notNull().default('{}'), // JSON: {jurisdiction: score}
  scoresByCategory: text('scores_by_category').notNull().default('{}'), // JSON: {category: score}
  factorsPositive: text('factors_positive').notNull().default('[]'), // JSON: what's helping
  factorsNegative: text('factors_negative').notNull().default('[]'), // JSON: what's hurting
  rulesActive: integer('rules_active').notNull().default(0),
  rulesApplicable: integer('rules_applicable').notNull().default(0),
  openFindings: integer('open_findings').notNull().default(0),
  aiBomSystems: integer('ai_bom_systems').notNull().default(0),
  highRiskSystems: integer('high_risk_systems').notNull().default(0),
  benchmarkScore: real('benchmark_score'), // latest COMPL-AI score
  lastBenchmarkAt: text('last_benchmark_at'),
  triggerEvent: text('trigger_event').notNull(), // what caused recalc: rule_change, scan, benchmark, manual, schedule
  policyStateHash: text('policy_state_hash').notNull(),
  computedAt: text('computed_at').notNull(),
}, (table) => [
  index('idx_compliance_org').on(table.orgId),
  index('idx_compliance_time').on(table.computedAt),
]);

// ─── Staged Content (Pipeline Quality Gate) ────────────────────

export const stagedContent = sqliteTable('staged_content', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => regulatorySources.id),
  snapshotId: text('snapshot_id').references(() => rawSnapshots.id),
  contentHash: text('content_hash').notNull(),
  content: text('content').notNull(),
  fetchedAt: text('fetched_at').notNull(),
  wordCount: integer('word_count').notNull(),
  source: text('source_type', { enum: ['scrape', 'upload'] }).notNull().default('scrape'),

  // Cleaned verbatim regulatory text (output of Step 2: Clean)
  cleanedText: text('cleaned_text'),
  // Raw HTTP provenance — flows from scrape into the promoted snapshot
  rawBytesHash: text('raw_bytes_hash'),
  rawBytesSize: integer('raw_bytes_size'),
  rawContent: text('raw_content'),
  fetchedUrl: text('fetched_url'),
  httpStatus: integer('http_status'),
  contentType: text('content_type'),
  // Provenance honesty — see rawSnapshots / hunter/provenance.ts for mode semantics
  provenanceMode: text('provenance_mode').notNull().default('byte_exact'),
  provenanceManifest: text('provenance_manifest'),
  // API-first ingestion (adapter framework) — carried from scrape into promotion
  ingestionChannel: text('ingestion_channel'),
  pointInTimeCoordinate: text('point_in_time_coordinate'),
  // Structural verification results (Step 3: Verify)
  verificationPassed: integer('verification_passed', { mode: 'boolean' }),
  verificationIssues: text('verification_issues'), // JSON array of VerificationIssue
  verificationStats: text('verification_stats'), // JSON of verification stats
  llmSpotCheckUsed: integer('llm_spot_check_used', { mode: 'boolean' }).notNull().default(false),

  // Quality scoring (legacy — still populated for backward compat)
  qualityGrade: text('quality_grade', { enum: ['A', 'B', 'C', 'D', 'F'] }),
  qualityStructure: real('quality_structure'),
  qualityText: real('quality_text'),
  qualityIssues: text('quality_issues'), // JSON array of issue strings
  qualityDiagnostic: text('quality_diagnostic'), // WHY it failed (captcha, encoding, partial, etc.)

  // Pipeline state — 5-step pipeline: 1=Scrape, 2=Clean, 3=Verify, 4=Extract, 5=Promote
  pipelineStep: integer('pipeline_step').notNull().default(1), // last completed step
  pipelineStatus: text('pipeline_status', {
    enum: ['pending', 'cleaning', 'cleaned', 'verifying', 'verified', 'scoring', 'scored', 'extracting', 'extracted', 'promoting', 'promoted', 'rejected', 'needs_review', 'needs_intervention'],
  }).notNull().default('pending'),
  pipelineError: text('pipeline_error'),
  retryCount: integer('retry_count').notNull().default(0),

  // Self-healing scraper results
  healingAttempted: integer('healing_attempted', { mode: 'boolean' }).notNull().default(false),
  healingStrategy: text('healing_strategy'), // which strategy succeeded, or null if none worked
  healingLog: text('healing_log'), // JSON array of {strategy, result, grade, durationMs}

  // Extraction results (held here until promoted)
  extractedRules: text('extracted_rules'), // JSON array of candidate rules
  extractedCount: integer('extracted_count').notNull().default(0),
  scoredRules: text('scored_rules'), // JSON array of scored/accepted rules
  scoredCount: integer('scored_count').notNull().default(0),
  rejectedCount: integer('rejected_count').notNull().default(0),

  // LLM usage tracking
  llmProvider: text('llm_provider'),
  llmModel: text('llm_model'),
  llmTokensIn: integer('llm_tokens_in').notNull().default(0),
  llmTokensOut: integer('llm_tokens_out').notNull().default(0),
  llmCostCents: integer('llm_cost_cents').notNull().default(0),

  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_staged_source').on(table.sourceId),
  index('idx_staged_status').on(table.pipelineStatus),
]);

// ─── The Forge (Bulk Regulatory Ingestion) ────────────────────

export const forgeJobs = sqliteTable('forge_jobs', {
  id: text('id').primaryKey(),
  documentPath: text('document_path').notNull(),
  jurisdiction: text('jurisdiction').notNull(),
  sourceName: text('source_name').notNull(),
  sourceId: text('source_id').references(() => regulatorySources.id),
  status: text('status', {
    enum: ['queued', 'processing', 'validating', 'scoring', 'committing', 'completed', 'error', 'repairing', 'unrepairable'],
  }).notNull().default('queued'),
  attempt: integer('attempt').notNull().default(1),
  maxAttempts: integer('max_attempts').notNull().default(3),
  errorMessage: text('error_message'),
  errorCategory: text('error_category', {
    enum: ['encoding', 'parse_failure', 'empty_extraction', 'llm_error', 'quality_rejected', 'unknown'],
  }),
  repairStrategy: text('repair_strategy'),
  contentHash: text('content_hash').notNull(),
  fileType: text('file_type', { enum: ['html', 'pdf', 'md'] }).notNull(),
  qualityGrade: text('quality_grade', { enum: ['A', 'B', 'C', 'D', 'F'] }),
  rulesExtracted: integer('rules_extracted').notNull().default(0),
  rulesAccepted: integer('rules_accepted').notNull().default(0),
  rulesRejected: integer('rules_rejected').notNull().default(0),
  rulesDuplicate: integer('rules_duplicate').notNull().default(0),
  rulesFlagged: integer('rules_flagged').notNull().default(0),
  llmTokensIn: integer('llm_tokens_in').notNull().default(0),
  llmTokensOut: integer('llm_tokens_out').notNull().default(0),
  llmCostCents: integer('llm_cost_cents').notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
  queuedAt: text('queued_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
}, (table) => [
  index('idx_forge_jobs_status').on(table.status),
  index('idx_forge_jobs_jurisdiction').on(table.jurisdiction),
  index('idx_forge_jobs_hash').on(table.contentHash),
]);

export const forgeLedger = sqliteTable('forge_ledger', {
  id: text('id').primaryKey(),
  forgeJobId: text('forge_job_id').notNull().references(() => forgeJobs.id),
  documentHash: text('document_hash').notNull(),
  documentName: text('document_name').notNull(),
  jurisdiction: text('jurisdiction').notNull(),
  sourceUrl: text('source_url'),
  fileType: text('file_type', { enum: ['html', 'pdf', 'md'] }).notNull(),
  status: text('status', { enum: ['verified', 'flagged', 'rejected'] }).notNull(),
  qualityGrade: text('quality_grade', { enum: ['A', 'B', 'C', 'D', 'F'] }).notNull(),
  rulesExtracted: integer('rules_extracted').notNull(),
  rulesAccepted: integer('rules_accepted').notNull(),
  rulesRejected: integer('rules_rejected').notNull(),
  processingChain: text('processing_chain').notNull(), // JSON array: ["parse", "validate", "score", "analyze", "commit"]
  llmCostCents: integer('llm_cost_cents').notNull(),
  durationMs: integer('duration_ms').notNull(),
  sourceId: text('source_id').references(() => regulatorySources.id),
  signature: text('signature').notNull(), // Ed25519 signature of entry
  isPublished: integer('is_published', { mode: 'boolean' }).notNull().default(false),
  verifiedAt: text('verified_at').notNull(),
}, (table) => [
  index('idx_forge_ledger_jurisdiction').on(table.jurisdiction),
  index('idx_forge_ledger_status').on(table.status),
  index('idx_forge_ledger_hash').on(table.documentHash),
  index('idx_forge_ledger_published').on(table.isPublished),
]);

// ─── Gatekeeper Logs ────────────────────────────────────────────

export const gatekeeperLogs = sqliteTable('gatekeeper_logs', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => regulatorySources.id),
  snapshotId: text('snapshot_id').notNull(),
  // 'skipped' = the contamination classifier could not run (LLM error / parse
  // fail / content too short). Fail-closed: we record that the gate did NOT run
  // rather than mislabelling the content as clean-verified.
  status: text('status', { enum: ['verified', 'cleaned', 'failed', 'skipped'] }).notNull(),
  issues: text('issues').notNull().default('[]'), // JSON
  strippedBytes: integer('stripped_bytes').notNull().default(0),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_gatekeeper_source').on(table.sourceId),
  index('idx_gatekeeper_status').on(table.status),
]);

// ─── Ephemeral State ─────────────────────────────────────────────
// General-purpose key-value store with TTL for state that must survive
// restarts but is not permanent. Used for OAuth CSRF tokens, GitHub
// installation token cache, and similar short-lived state.

export const ephemeralState = sqliteTable('ephemeral_state', {
  key: text('key').primaryKey(),
  namespace: text('namespace').notNull(),  // e.g. 'oauth_csrf', 'github_token'
  value: text('value').notNull(),          // plaintext or encrypted (enc: prefix)
  expiresAt: text('expires_at').notNull(), // ISO-8601 UTC
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_ephemeral_namespace').on(table.namespace),
  index('idx_ephemeral_expires').on(table.expiresAt),
]);

// ─── Scout v2 (Bill Tracking & Legislative Lifecycle) ──────────

export const trackedBills = sqliteTable('tracked_bills', {
  id: text('id').primaryKey(),
  externalId: text('external_id'), // Congress.gov bill number, etc.
  title: text('title').notNull(),
  summary: text('summary'),
  jurisdiction: text('jurisdiction').notNull(), // US-FED, US-CA, EU, UK, etc.
  session: text('session'), // Congress session, Parliament session
  introducedDate: text('introduced_date'), // ISO 8601
  currentStage: text('current_stage').notNull().default('rumor'),
  progressPercent: integer('progress_percent').notNull().default(0),
  passageScore: integer('passage_score'), // 0-100 composite
  passageMomentum: real('passage_momentum'),
  passageBaseRate: real('passage_base_rate'),
  passageSponsorStrength: real('passage_sponsor_strength'),
  passageSentiment: real('passage_sentiment'),
  passagePolitical: real('passage_political'),
  passageOpposition: real('passage_opposition'),
  sourceUrl: text('source_url'),
  sourceFeed: text('source_feed'),
  lastActionDate: text('last_action_date'),
  lastScoreDate: text('last_score_date'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_tracked_bills_jurisdiction').on(table.jurisdiction),
  index('idx_tracked_bills_stage').on(table.currentStage),
  index('idx_tracked_bills_score').on(table.passageScore),
]);

export const billStageHistory = sqliteTable('bill_stage_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  billId: text('bill_id').notNull().references(() => trackedBills.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(),
  enteredAt: text('entered_at').notNull(),
  exitedAt: text('exited_at'),
  source: text('source'), // what triggered the transition
}, (table) => [
  index('idx_bill_stage_history_bill').on(table.billId),
]);

export const billScoreHistory = sqliteTable('bill_score_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  billId: text('bill_id').notNull().references(() => trackedBills.id, { onDelete: 'cascade' }),
  score: integer('score').notNull(),
  momentum: real('momentum'),
  baseRate: real('base_rate'),
  sponsorStrength: real('sponsor_strength'),
  sentiment: real('sentiment'),
  political: real('political'),
  opposition: real('opposition'),
  computedAt: text('computed_at').notNull(),
}, (table) => [
  index('idx_bill_score_history_bill').on(table.billId),
]);

export const billSponsors = sqliteTable('bill_sponsors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  billId: text('bill_id').notNull().references(() => trackedBills.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  party: text('party'),
  chamber: text('chamber'),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  isCommitteeChair: integer('is_committee_chair', { mode: 'boolean' }).notNull().default(false),
  isLeadership: integer('is_leadership', { mode: 'boolean' }).notNull().default(false),
}, (table) => [
  index('idx_bill_sponsors_bill').on(table.billId),
]);

// ─── Scout Accuracy Ledger ─────────────────────────────
//
// bill_outcomes is the immutable public prediction track record: one signed
// row per tracked bill that reached a terminal outcome. Rows are written
// exactly once (UNIQUE on bill_id + conflict-ignore insert) and are NEVER
// updated or deleted — they are the auditable evidence behind the published
// calibration numbers.
//
// NOTE: bill_id deliberately has NO foreign key to tracked_bills. The outcome
// ledger must outlive the operational bill row (e.g. wipe-regulatory-data.ts
// clears tracked_bills; the accuracy ledger must survive that).

export const billOutcomes = sqliteTable('bill_outcomes', {
  id: text('id').primaryKey(),
  /** Tracked bill this outcome belongs to. UNIQUE = the exactly-once guarantee. */
  billId: text('bill_id').notNull().unique(),
  /** Canonical lifecycle stage the bill was in when the outcome was frozen. */
  finalStage: text('final_stage').notNull(),
  outcome: text('outcome', { enum: ['enacted', 'failed', 'withdrawn'] }).notNull(),
  /** UTC ISO-8601 — when the bill reached its terminal outcome. */
  outcomeAt: text('outcome_at').notNull(),
  /** Latest passage score (0-100) computed at-or-before outcomeAt. Null if no history. */
  scoreAtOutcome: real('score_at_outcome'),
  /** Latest score computed at-or-before outcomeAt minus 30 days (primary calibration metric). */
  scoreT30: real('score_t30'),
  /** Latest score computed at-or-before outcomeAt minus 60 days. */
  scoreT60: real('score_t60'),
  /** Latest score computed at-or-before outcomeAt minus 90 days. */
  scoreT90: real('score_t90'),
  /** Highest score ever recorded for the bill. Null if no history. */
  peakScore: real('peak_score'),
  /** JSON: 6-component breakdown of the T30 score (reproducibility), plus sessionEnd marker. */
  componentSnapshot: text('component_snapshot'),
  /** Ed25519 signature over canonicalJSON of the record minus this field. */
  signature: text('signature').notNull(),
  /** UTC ISO-8601 — when Nomus recorded (froze) this outcome. */
  recordedAt: text('recorded_at').notNull(),
  methodologyVersion: integer('methodology_version').notNull().default(1),
});

// accuracy_snapshots is the nightly-computed calibration time series. Rows
// are NEVER deleted — the history of the track record is itself part of the
// track record.

export const accuracySnapshots = sqliteTable('accuracy_snapshots', {
  id: text('id').primaryKey(),
  /** UTC ISO-8601 — when this snapshot was computed. */
  generatedAt: text('generated_at').notNull(),
  methodologyVersion: integer('methodology_version').notNull(),
  /** Total recorded outcomes at generation time. */
  sampleSize: integer('sample_size').notNull(),
  enactedCount: integer('enacted_count').notNull(),
  failedCount: integer('failed_count').notNull(),
  /** Outcomes with a non-null scoreT30 (calibration-eligible). Needed by the public contract. */
  withCalibrationScore: integer('with_calibration_score').notNull().default(0),
  /** Mean squared error of scoreT30/100 vs outcome. Null when no eligible outcomes. */
  brierScore: real('brier_score'),
  /** JSON: ten deciles [{ bucket, predictedMidpoint, observed, n }]. */
  calibrationBuckets: text('calibration_buckets').notNull(),
  /** JSON: { at50, at70, at90 } precision-style hit rates. */
  hitRates: text('hit_rates').notNull(),
  /** JSON: per-jurisdiction [{ jurisdiction, outcomes, enacted, brierScore }]. */
  byJurisdiction: text('by_jurisdiction').notNull(),
  /** True when sampleSize >= MIN_PUBLISH_N (30). */
  published: integer('published', { mode: 'boolean' }).notNull().default(false),
});

export const billNews = sqliteTable('bill_news', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  billId: text('bill_id').notNull().references(() => trackedBills.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  url: text('url').notNull(),
  sourceName: text('source_name'),
  publishedAt: text('published_at'),
  sentiment: text('sentiment', { enum: ['supportive', 'opposed', 'neutral', 'mixed'] }),
  sentimentScore: real('sentiment_score'),
  fetchedAt: text('fetched_at').notNull(),
}, (table) => [
  index('idx_bill_news_bill').on(table.billId),
]);

// ─── Clause Map — heuristic → clause correlation with learning ──
//
// The built-in mapping dataset lives in code (clausemap/dataset.ts) and
// is seeded into clause_mappings. Learned accuracy state (alpha/beta,
// counts, posterior) lives ONLY in the database — reseeding never clobbers
// it. Every posterior change is appended to clause_learning_events so the
// learning trajectory is fully auditable (bank-grade: no silent updates).

export const clauseMappings = sqliteTable('clause_mappings', {
  id: text('id').primaryKey(),
  /** Stable key, e.g. 'phi-in-ai-call::hipaa-164.502a' — upsert identity across reseeds */
  mappingKey: text('mapping_key').notNull(),
  /** Dataset version that last wrote the static fields of this row */
  datasetVersion: integer('dataset_version').notNull().default(1),
  /** Human label for the heuristic, e.g. 'PHI pattern near an AI SDK call' */
  heuristicLabel: text('heuristic_label').notNull(),
  /** JSON HeuristicSignature evaluated by the correlator */
  heuristicJson: text('heuristic_json').notNull(),
  framework: text('framework', { enum: ['EU_AI_ACT', 'HIPAA', 'GDPR'] }).notNull(),
  /** Exact clause citation, e.g. 'Art. 10(5)' or '45 CFR §164.502(a)' */
  clauseCitation: text('clause_citation').notNull(),
  clauseTitle: text('clause_title').notNull(),
  clauseUrl: text('clause_url'),
  /** Why this heuristic maps to this clause — shown verbatim in the dashboard */
  rationale: text('rationale').notNull(),
  /** Beta-Bernoulli prior (pseudo-counts). Static per dataset version. */
  priorAlpha: real('prior_alpha').notNull(),
  priorBeta: real('prior_beta').notNull(),
  /** Learned evidence (fractional pseudo-counts from feedback). Never reseeded. */
  confirmedWeight: real('confirmed_weight').notNull().default(0),
  dismissedWeight: real('dismissed_weight').notNull().default(0),
  /** Posterior mean = (priorAlpha+confirmed)/(priorAlpha+priorBeta+confirmed+dismissed) */
  posterior: real('posterior').notNull(),
  /** How many scans this mapping has fired in (any org) */
  firedCount: integer('fired_count').notNull().default(0),
  /** How many scans the correlator has evaluated this mapping against */
  evaluatedCount: integer('evaluated_count').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_clause_mappings_key').on(table.mappingKey),
  index('idx_clause_mappings_framework').on(table.framework),
  index('idx_clause_mappings_active').on(table.isActive),
]);

export const clauseMatches = sqliteTable('clause_matches', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  mappingId: text('mapping_id').notNull().references(() => clauseMappings.id),
  repo: text('repo').notNull(),
  commitSha: text('commit_sha').notNull(),
  filePath: text('file_path').notNull(),
  /** Anchor line — the first supporting finding's line */
  lineNumber: integer('line_number').notNull(),
  /** JSON array of supporting findings: [{findingId, capability, detector, line, severity}] */
  evidenceJson: text('evidence_json').notNull(),
  /** Confidence at match time = posterior × evidence strength (frozen, auditable) */
  confidence: real('confidence').notNull(),
  /** Live posterior is read from clause_mappings — this row never pretends to be current */
  status: text('status', { enum: ['open', 'confirmed', 'dismissed'] }).notNull().default('open'),
  matchedAt: text('matched_at').notNull(),
  resolvedAt: text('resolved_at'),
}, (table) => [
  index('idx_clause_matches_org_repo').on(table.orgId, table.repo),
  index('idx_clause_matches_mapping').on(table.mappingId),
  index('idx_clause_matches_status').on(table.status),
  // Dedup identity: one open match per (org, repo, mapping, file)
  index('idx_clause_matches_identity').on(table.orgId, table.repo, table.mappingId, table.filePath),
]);

export const clauseLearningEvents = sqliteTable('clause_learning_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  mappingId: text('mapping_id').notNull().references(() => clauseMappings.id),
  eventType: text('event_type', {
    enum: ['seeded', 'scan_fired', 'scan_suppressed', 'feedback_confirm', 'feedback_dismiss', 'dataset_updated'],
  }).notNull(),
  orgId: text('org_id'),
  matchId: text('match_id'),
  posteriorBefore: real('posterior_before').notNull(),
  posteriorAfter: real('posterior_after').notNull(),
  /** JSON context: {repo, filePath, weight, note, ...} */
  detailsJson: text('details_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_clause_events_mapping').on(table.mappingId, table.createdAt),
]);
