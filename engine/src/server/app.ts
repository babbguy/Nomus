import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from '../config/env.js';
import { loggingMiddleware } from './middleware/logging.js';
import { securityHeaders } from './middleware/security.js';
import { errorHandler, handleAppError } from './middleware/error-handler.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { tenantRoutes } from './routes/tenants.js';
import { policyRoutes, wellKnownRoutes } from './routes/policies.js';
import { evaluateRoutes } from './routes/evaluate.js';
import { auditRoutes } from './routes/audit.js';
import { streamRoutes } from './routes/stream.js';
import { graphRoutes } from './routes/graph.js';
import { feedbackRoutes } from './routes/feedback.js';
import { sourceRoutes } from './routes/sources.js';
import { adminRoutes } from './routes/admin.js';
import { diffRoutes } from './routes/diffs.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { simulateRoutes } from './routes/simulate.js';
import { radarRoutes } from './routes/radar.js';
import { radarV2Routes } from './routes/radar-v2.js';
import { badgeRoutes } from './routes/badge.js';
import { modusProxyRoutes } from './routes/modus-proxy.js';
import { modusIntegrationRoutes } from './routes/modus-integration.js';
import { ontologyRoutes } from './routes/ontology.js';
import { transparencyRoutes } from './routes/transparency.js';
import { transparencyAccuracyRoutes } from './routes/transparency-accuracy.js';
import { chainRoutes } from './routes/chain.js';
import { scanRoutes } from './routes/scan.js';
import { clauseMapRoutes } from './routes/clause-map.js';
import { userRoutes } from './routes/users.js';
import { orgRoutes } from './routes/org.js';
import { githubRoutes } from './routes/github.js';
import { githubOAuthRoutes } from './routes/github-oauth.js';
import { oauthRoutes } from './routes/oauth.js';
import { scoutRoutes } from './routes/scout.js';
import { deviceAuthRoutes } from './routes/device-auth.js';
import { settingsRoutes } from './routes/settings.js';
import { sourceHealthRoutes } from './routes/source-health.js';
import { aiBomRoutes } from './routes/ai-bom.js';
import { benchmarkRoutes } from './routes/benchmarks.js';
import { simulationRoutes } from './routes/simulations.js';
import { compliancePostureRoutes } from './routes/compliance-posture.js';
import { forgeAdminRoutes, ledgerPublicRoutes } from './routes/forge.js';
import { templateRoutes } from './routes/templates.js';
import { auditExportRoutes } from './routes/audit-export.js';
import { verifyPublicRoutes } from './routes/verify.js';
import { adminRuleRoutes } from './routes/admin-rules.js';

export type AppEnv = {
  Variables: {
    orgId?: string;
    apiKeyId?: string;
    /** Set for session (browser) auth: the signed-in user's id. */
    userId?: string;
    scopes?: string[];
    rateLimitRpm?: number;
    /** Per-org SSE connection cap (NOMUS_MAX_SSE_CONNECTIONS_PER_ORG) */
    maxSseConnections?: number;
    requestId: string;
  };
};

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Errors thrown by route handlers reach onError, not the middleware below.
  app.onError(handleAppError);

  // Global middleware
  app.use('*', errorHandler());
  app.use('*', securityHeaders());
  app.use('*', loggingMiddleware());
  app.use('*', cors({
    origin: env().NOMUS_CORS_ORIGIN,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400,
  }));

  // Public routes
  app.route('/', healthRoutes);
  app.route('/', wellKnownRoutes);
  app.route('/api/v1/auth', authRoutes);
  app.route('/api/v1/badge', badgeRoutes);
  app.route('/api/v1/transparency', transparencyRoutes);
  app.route('/api/v1/transparency/accuracy', transparencyAccuracyRoutes);
  app.route('/api/v1/ledger', ledgerPublicRoutes);
  app.route('/api/v1/chain', chainRoutes);
  app.route('/api/v1/auth/device', deviceAuthRoutes);
  // Public attestation verification + reliance subscriptions
  app.route('/api/v1/verify', verifyPublicRoutes);

  // Authenticated routes
  app.route('/api/v1/tenants', tenantRoutes);
  app.route('/api/v1/policies', policyRoutes);
  app.route('/api/v1/evaluate', evaluateRoutes);
  app.route('/api/v1/attestations', auditRoutes);
  app.route('/api/v1/stream', streamRoutes);
  app.route('/api/v1/graph', graphRoutes);
  app.route('/api/v1/feedback', feedbackRoutes);
  app.route('/api/v1/simulate', simulateRoutes);
  app.route('/api/v1/radar', radarRoutes);
  app.route('/api/v1/radar/v2', radarV2Routes);
  app.route('/api/v1/sources', sourceRoutes);
  app.route('/api/v1/admin', adminRoutes);
  app.route('/api/v1/admin/diffs', diffRoutes);
  app.route('/api/v1/admin/rules', adminRuleRoutes);
  app.route('/api/v1/admin/ontology', ontologyRoutes);
  app.route('/api/v1/users', userRoutes);
  app.route('/api/v1/org', orgRoutes);
  app.route('/api/v1/dashboard', dashboardRoutes);
  app.route('/api/v1/scan', scanRoutes);
  app.route('/api/v1/modus', modusProxyRoutes);
  app.route('/api/v1/admin/modus', modusIntegrationRoutes);
  app.route('/api/v1/scout', scoutRoutes);
  app.route('/api/v1/settings', settingsRoutes);
  app.route('/api/v1/admin/source-health', sourceHealthRoutes);
  app.route('/api/v1/ai-bom', aiBomRoutes);
  app.route('/api/v1/benchmarks', benchmarkRoutes);
  app.route('/api/v1/simulations', simulationRoutes);
  app.route('/api/v1/compliance', compliancePostureRoutes);
  app.route('/api/v1/clause-map', clauseMapRoutes);
  app.route('/api/v1/admin/forge', forgeAdminRoutes);
  app.route('/api/v1/templates', templateRoutes);
  app.route('/api/v1/audit-export', auditExportRoutes);

  // OAuth providers
  app.route('/api/v1/auth/oauth', oauthRoutes);

  // GitHub App
  app.route('/api/v1/github', githubRoutes);
  app.route('/api/v1/auth/github', githubOAuthRoutes);

  return app;
}
