import { Hono } from 'hono';
import { randomUUID, createHash } from 'node:crypto';
import { eq, and, ne, inArray, sql, desc } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { aiBomSystems, aiBomSnapshots, scanFindings, policyRules, organizations } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { safeJson } from '../utils.js';
import { invalidateComplianceScore } from '../../core/compliance-score-cache.js';

export const aiBomRoutes = new Hono<AppEnv>();

aiBomRoutes.use('*', requireSessionOrApiKey('evaluate'));
aiBomRoutes.use('*', rateLimit());

// ─── Helpers ─────────────────────────────────────────────────────

function parseJsonField(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeSystem(row: typeof aiBomSystems.$inferSelect) {
  return {
    ...row,
    capabilities: parseJsonField(row.capabilities),
    dataFlows: parseJsonField(row.dataFlows),
    jurisdictions: parseJsonField(row.jurisdictions),
    regulatoryTags: parseJsonField(row.regulatoryTags),
    scanFindingIds: parseJsonField(row.scanFindingIds),
    metadata: parseJsonField(row.metadata),
  };
}

/**
 * Auto-classify risk based on EU AI Act Annex III categories.
 * Systems matching high-risk categories get 'high'; others default to 'limited'.
 */
function classifyRisk(
  systemType: string,
  purpose: string,
  capabilities: string[],
  euAiActCategory?: string | null,
): 'unacceptable' | 'high' | 'limited' | 'minimal' | 'unclassified' {
  // Annex III high-risk categories
  const highRiskCategories = [
    'biometric_identification',
    'critical_infrastructure',
    'education_vocational',
    'employment_workers',
    'essential_services',
    'law_enforcement',
    'migration_asylum',
    'administration_of_justice',
  ];

  if (euAiActCategory && highRiskCategories.includes(euAiActCategory)) {
    return 'high';
  }

  // Unacceptable: social scoring, real-time biometric in public
  const unacceptablePatterns = ['social_scoring', 'real_time_biometric_public', 'subliminal_manipulation'];
  const purposeLower = purpose.toLowerCase();
  if (unacceptablePatterns.some((p) => purposeLower.includes(p))) {
    return 'unacceptable';
  }

  // High-risk heuristics based on capabilities
  const highRiskCapabilities = ['biometric', 'facial_recognition', 'credit_scoring', 'hiring', 'medical_diagnosis'];
  if (capabilities.some((cap) => highRiskCapabilities.some((hr) => cap.toLowerCase().includes(hr)))) {
    return 'high';
  }

  // Limited transparency: chatbots, emotion recognition, deepfakes
  const limitedPatterns = ['chatbot', 'emotion_recognition', 'deepfake', 'text_generation', 'content_generation'];
  if (capabilities.some((cap) => limitedPatterns.some((lp) => cap.toLowerCase().includes(lp)))) {
    return 'limited';
  }

  return 'minimal';
}

// ─── GET /summary — Dashboard summary ───────────────────────────

aiBomRoutes.get('/summary', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;

  const systems = db.select().from(aiBomSystems)
    .where(and(eq(aiBomSystems.orgId, orgId), eq(aiBomSystems.isActive, true)))
    .all();

  const byRisk: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byDeployment: Record<string, number> = {};
  const jurisdictionSet = new Set<string>();
  let withoutRiskClassification = 0;
  let withoutJurisdictions = 0;

  for (const sys of systems) {
    byRisk[sys.riskClassification] = (byRisk[sys.riskClassification] || 0) + 1;
    byType[sys.systemType] = (byType[sys.systemType] || 0) + 1;
    byDeployment[sys.deploymentType] = (byDeployment[sys.deploymentType] || 0) + 1;

    if (sys.riskClassification === 'unclassified') withoutRiskClassification++;

    const jurisdictions = JSON.parse(sys.jurisdictions || '[]') as string[];
    if (jurisdictions.length === 0) withoutJurisdictions++;
    for (const j of jurisdictions) jurisdictionSet.add(j);
  }

  const byJurisdiction: Record<string, number> = {};
  for (const sys of systems) {
    const jurisdictions = JSON.parse(sys.jurisdictions || '[]') as string[];
    for (const j of jurisdictions) {
      byJurisdiction[j] = (byJurisdiction[j] || 0) + 1;
    }
  }

  return c.json({
    totalSystems: systems.length,
    byRiskLevel: byRisk,
    bySystemType: byType,
    byJurisdiction,
    byDeploymentStatus: byDeployment,
    complianceGaps: {
      withoutRiskClassification,
      withoutJurisdictions,
    },
  });
});

// ─── GET /export/:format — Export AI-BOM as JSON or PDF ──────────

aiBomRoutes.get('/export/:format', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const format = c.req.param('format');

  if (format !== 'json' && format !== 'pdf') {
    return c.json({ error: 'Invalid format. Use json or pdf.' }, 400);
  }

  const systems = db.select().from(aiBomSystems)
    .where(and(eq(aiBomSystems.orgId, orgId), eq(aiBomSystems.isActive, true)))
    .orderBy(aiBomSystems.name)
    .all();

  const org = db.select().from(organizations)
    .where(eq(organizations.id, orgId))
    .get();

  const now = new Date().toISOString();

  // Risk summary
  const riskSummary: Record<string, number> = {};
  const jurisdictionSet = new Set<string>();
  let highRiskCount = 0;

  for (const sys of systems) {
    riskSummary[sys.riskClassification] = (riskSummary[sys.riskClassification] || 0) + 1;
    if (sys.riskClassification === 'high' || sys.riskClassification === 'unacceptable') highRiskCount++;
    const jurisdictions = JSON.parse(sys.jurisdictions || '[]') as string[];
    for (const j of jurisdictions) jurisdictionSet.add(j);
  }

  const serializedSystems = systems.map(serializeSystem);

  let exportData: string;

  if (format === 'json') {
    const bomDocument = {
      schema: 'nomus-ai-bom-v1',
      organization: org?.name ?? orgId,
      generatedAt: now,
      systemCount: systems.length,
      riskSummary,
      jurisdictionSummary: {
        count: jurisdictionSet.size,
        jurisdictions: Array.from(jurisdictionSet).sort(),
      },
      complianceFramework: 'EU AI Act (Regulation 2024/1689)',
      systems: serializedSystems,
    };
    exportData = JSON.stringify(bomDocument, null, 2);
  } else {
    // PDF: generate HTML content for client-side rendering
    const systemRows = serializedSystems.map((sys) => `
      <tr>
        <td>${escapeHtml(sys.name)}</td>
        <td>${escapeHtml(sys.systemType)}</td>
        <td>${escapeHtml(sys.provider)}</td>
        <td>${escapeHtml(sys.modelName)}</td>
        <td class="risk-${sys.riskClassification}">${escapeHtml(sys.riskClassification)}</td>
        <td>${escapeHtml(sys.deploymentType)}</td>
        <td>${escapeHtml(sys.purpose)}</td>
      </tr>
    `).join('');

    exportData = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AI Bill of Materials - ${escapeHtml(org?.name ?? orgId)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; color: #1a1a1a; }
    h1 { border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
    .meta { color: #666; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 13px; }
    th { background: #f5f5f5; font-weight: 600; }
    .risk-unacceptable { color: #dc2626; font-weight: 700; }
    .risk-high { color: #ea580c; font-weight: 700; }
    .risk-limited { color: #ca8a04; }
    .risk-minimal { color: #16a34a; }
    .risk-unclassified { color: #6b7280; }
    .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 20px 0; }
    .summary-card { border: 1px solid #ddd; border-radius: 8px; padding: 16px; }
    .summary-card h3 { margin: 0 0 8px 0; font-size: 14px; color: #666; }
    .summary-card .value { font-size: 28px; font-weight: 700; }
  </style>
</head>
<body>
  <h1>AI Bill of Materials (AI-BOM)</h1>
  <p class="meta">Organization: ${escapeHtml(org?.name ?? orgId)} | Generated: ${now} | EU AI Act Article 11 Compliance</p>

  <div class="summary-grid">
    <div class="summary-card"><h3>Total AI Systems</h3><div class="value">${systems.length}</div></div>
    <div class="summary-card"><h3>High Risk Systems</h3><div class="value">${highRiskCount}</div></div>
    <div class="summary-card"><h3>Jurisdictions</h3><div class="value">${jurisdictionSet.size}</div></div>
  </div>

  <h2>Risk Distribution</h2>
  <table>
    <tr><th>Risk Level</th><th>Count</th></tr>
    ${Object.entries(riskSummary).map(([level, count]) => `<tr><td>${escapeHtml(level)}</td><td>${count}</td></tr>`).join('')}
  </table>

  <h2>AI Systems Inventory</h2>
  <table>
    <thead>
      <tr><th>Name</th><th>Type</th><th>Provider</th><th>Model</th><th>Risk</th><th>Deployment</th><th>Purpose</th></tr>
    </thead>
    <tbody>${systemRows}</tbody>
  </table>

  <footer style="margin-top:40px;border-top:1px solid #ddd;padding-top:10px;color:#999;font-size:12px;">
    Generated by Nomus Regulatory Applicability Engine. This document is for regulatory compliance purposes under EU AI Act Article 11.
  </footer>
</body>
</html>`;
  }

  // Compute hash of exported data
  const bomHash = createHash('sha256').update(exportData).digest('hex');

  // Save snapshot
  const snapshotId = randomUUID();
  db.insert(aiBomSnapshots).values({
    id: snapshotId,
    orgId,
    systemCount: systems.length,
    highRiskCount,
    jurisdictionCount: jurisdictionSet.size,
    bomHash,
    exportFormat: format,
    exportData,
    generatedAt: now,
  }).run();

  return c.json({
    snapshotId,
    format,
    bomHash,
    systemCount: systems.length,
    highRiskCount,
    jurisdictionCount: jurisdictionSet.size,
    generatedAt: now,
    data: format === 'json' ? JSON.parse(exportData) : exportData,
  });
});

// ─── POST /generate — Auto-generate AI-BOM from scan findings ────

/** AI provider behind each SDK name the scanner reports. */
const SDK_PROVIDERS: Record<string, string> = {
  'openai': 'OpenAI',
  'com.openai': 'OpenAI',
  'openai-go': 'OpenAI',
  'anthropic': 'Anthropic',
  '@anthropic-ai/sdk': 'Anthropic',
  'com.anthropic': 'Anthropic',
  'anthropic-sdk-go': 'Anthropic',
  '@google/generative-ai': 'Google',
  'google.generativeai': 'Google',
  '@aws-sdk/client-bedrock-runtime': 'AWS Bedrock',
  'boto3-bedrock': 'AWS Bedrock',
  'aws-bedrock': 'AWS Bedrock',
  'cohere-ai': 'Cohere',
  'cohere': 'Cohere',
  '@huggingface/inference': 'Hugging Face',
  'huggingface_hub': 'Hugging Face',
  'replicate': 'Replicate',
};

/** EU AI Act Annex III rule keys → the euAiActCategory values classifyRisk knows. */
const ANNEX_III_CATEGORIES: Array<[RegExp, string]> = [
  [/^eu_ai_act\.annex_iii\.1/, 'biometric_identification'],
  [/^eu_ai_act\.annex_iii\.2\./, 'critical_infrastructure'],
  [/^eu_ai_act\.annex_iii\.3\./, 'education_vocational'],
  [/^eu_ai_act\.annex_iii\.4\./, 'employment_workers'],
  [/^eu_ai_act\.annex_iii\.5\./, 'essential_services'],
  [/^eu_ai_act\.annex_iii\.6\./, 'law_enforcement'],
  [/^eu_ai_act\.annex_iii\.7\./, 'migration_asylum'],
  [/^eu_ai_act\.annex_iii\.8\./, 'administration_of_justice'],
];

/**
 * EU AI Act risk tier implied by the obligations the scanner found:
 * Article 5 (prohibited practices) → unacceptable, an Annex III category →
 * high, Article 50 transparency duties → limited, anything else → minimal.
 */
function riskFromRuleKeys(ruleKeys: string[]): {
  risk: 'unacceptable' | 'high' | 'limited' | 'minimal';
  euAiActCategory: string | null;
} {
  if (ruleKeys.some((k) => /^eu_ai_act\.art5\./.test(k))) return { risk: 'unacceptable', euAiActCategory: null };
  for (const key of ruleKeys) {
    const hit = ANNEX_III_CATEGORIES.find(([re]) => re.test(key));
    if (hit) return { risk: 'high', euAiActCategory: hit[1] };
  }
  if (ruleKeys.some((k) => /^eu_ai_act\.art50\./.test(k))) return { risk: 'limited', euAiActCategory: null };
  return { risk: 'minimal', euAiActCategory: null };
}

aiBomRoutes.post('/generate', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const now = new Date().toISOString();

  // Every finding that has not been dismissed describes AI usage in the code.
  const findings = db.select().from(scanFindings)
    .where(and(eq(scanFindings.orgId, orgId), ne(scanFindings.status, 'dismissed')))
    .all();

  if (findings.length === 0) {
    return c.json({ created: 0, updated: 0, totalGroups: 0, message: 'No scan findings found for this organization' });
  }

  // One AI system per (repository, AI provider). The scanner names the SDK in
  // capabilityDetected; '@anthropic-ai/sdk' and 'anthropic' are one provider.
  const groups = new Map<string, { repo: string; provider: string; findings: typeof findings }>();
  for (const f of findings) {
    const provider = SDK_PROVIDERS[f.capabilityDetected] ?? f.capabilityDetected;
    const key = `${f.repo}::${provider}`;
    const group = groups.get(key) ?? { repo: f.repo, provider, findings: [] };
    group.findings.push(f);
    groups.set(key, group);
  }

  // Jurisdiction of every rule the findings reference (INTL is not a market).
  const ruleJurisdiction = new Map(
    db.select({ ruleKey: policyRules.ruleKey, jurisdiction: policyRules.jurisdiction }).from(policyRules).all()
      .map((r) => [r.ruleKey, r.jurisdiction]),
  );

  let created = 0;
  let updated = 0;

  // Systems are written one at a time (not in a transaction), so a failure
  // part way through still leaves committed rows: invalidate whatever happens.
  try {
  for (const { repo, provider, findings: groupFindings } of groups.values()) {
    const ruleKeys = [...new Set(groupFindings.map((f) => f.ruleKey))];
    const sdks = [...new Set(groupFindings.map((f) => f.capabilityDetected))].sort();
    const jurisdictions = [...new Set(
      ruleKeys.map((k) => ruleJurisdiction.get(k)).filter((j): j is string => !!j && j !== 'INTL'),
    )].sort();
    const regulatoryTags = [...new Set(ruleKeys.map((k) => k.split('.')[0]))].sort();
    const { risk, euAiActCategory } = riskFromRuleKeys(ruleKeys);
    const name = `${provider} (${repo})`;
    const knownProvider = Object.values(SDK_PROVIDERS).includes(provider);
    const metadata = {
      repo,
      findingCount: groupFindings.length,
      sdks,
      autoRiskClassification: risk,
    };

    let existing = db.select().from(aiBomSystems)
      .where(and(eq(aiBomSystems.orgId, orgId), eq(aiBomSystems.name, name)))
      .get();

    // Earlier versions named scanner systems "<sdk> (<repo>)", one per SDK
    // spelling. Adopt the first such system (keeping its id and history) and
    // retire the other spellings so the inventory does not list them twice.
    const legacy = db.select().from(aiBomSystems)
      .where(and(
        eq(aiBomSystems.orgId, orgId),
        eq(aiBomSystems.detectedFrom, 'scanner'),
        eq(aiBomSystems.isActive, true),
        inArray(aiBomSystems.name, sdks.map((sdk) => `${sdk} (${repo})`)),
      ))
      .all()
      .filter((row) => row.name !== name);
    let toRetire = legacy;
    if (!existing && legacy.length > 0) {
      const [adopt, ...rest] = legacy;
      db.update(aiBomSystems).set({
        name,
        ...(knownProvider ? { provider, systemType: adopt.systemType === 'other' ? 'model' as const : adopt.systemType } : {}),
        purpose: `AI integration via ${sdks.join(', ')}`,
        updatedAt: now,
      }).where(eq(aiBomSystems.id, adopt.id)).run();
      existing = db.select().from(aiBomSystems).where(eq(aiBomSystems.id, adopt.id)).get();
      toRetire = rest;
    }
    for (const row of toRetire) {
      db.update(aiBomSystems).set({ isActive: false, updatedAt: now }).where(eq(aiBomSystems.id, row.id)).run();
    }

    if (existing) {
      // Refresh what the scanner knows. Keep a risk tier a person has set:
      // only replace it while it still equals the last auto-classification.
      const previous = parseJsonField(existing.metadata) as { autoRiskClassification?: string } | null;
      const autoManaged = existing.riskClassification === 'unclassified'
        || existing.riskClassification === previous?.autoRiskClassification;
      db.update(aiBomSystems).set({
        description: `Auto-detected from ${groupFindings.length} scan finding(s) in repository ${repo}`,
        capabilities: JSON.stringify(sdks),
        jurisdictions: JSON.stringify(jurisdictions),
        regulatoryTags: JSON.stringify(regulatoryTags),
        scanFindingIds: JSON.stringify(groupFindings.map((f) => f.id)),
        metadata: JSON.stringify(metadata),
        ...(autoManaged ? { riskClassification: risk, euAiActCategory } : {}),
        updatedAt: now,
      }).where(eq(aiBomSystems.id, existing.id)).run();
      updated++;
      continue;
    }

    db.insert(aiBomSystems).values({
      id: randomUUID(),
      orgId,
      name,
      description: `Auto-detected from ${groupFindings.length} scan finding(s) in repository ${repo}`,
      systemType: knownProvider ? 'model' : 'other',
      provider: knownProvider ? provider : '',
      modelName: '',
      version: '',
      purpose: `AI integration via ${sdks.join(', ')}`,
      capabilities: JSON.stringify(sdks),
      dataFlows: '[]',
      jurisdictions: JSON.stringify(jurisdictions),
      riskClassification: risk,
      euAiActCategory,
      regulatoryTags: JSON.stringify(regulatoryTags),
      deploymentType: 'development',
      detectedFrom: 'scanner',
      scanFindingIds: JSON.stringify(groupFindings.map((f) => f.id)),
      lastAssessedAt: null,
      isActive: true,
      metadata: JSON.stringify(metadata),
      createdAt: now,
      updatedAt: now,
    }).run();

    created++;
  }
  } finally {
    invalidateComplianceScore(orgId);
  }

  return c.json({ created, updated, totalGroups: groups.size }, 201);
});

// ─── GET / — List all AI-BOM systems ─────────────────────────────

aiBomRoutes.get('/', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;

  const riskFilter = c.req.query('riskClassification');
  const typeFilter = c.req.query('systemType');
  const jurisdictionFilter = c.req.query('jurisdiction');
  const deploymentFilter = c.req.query('deploymentType');
  const activeFilter = c.req.query('isActive');

  let systems = db.select().from(aiBomSystems)
    .where(eq(aiBomSystems.orgId, orgId))
    .orderBy(desc(aiBomSystems.updatedAt))
    .all();

  // Apply filters
  if (riskFilter) systems = systems.filter((s) => s.riskClassification === riskFilter);
  if (typeFilter) systems = systems.filter((s) => s.systemType === typeFilter);
  if (deploymentFilter) systems = systems.filter((s) => s.deploymentType === deploymentFilter);
  if (activeFilter !== undefined) {
    const isActive = activeFilter !== 'false';
    systems = systems.filter((s) => s.isActive === isActive);
  } else {
    // Default: only active systems
    systems = systems.filter((s) => s.isActive);
  }
  if (jurisdictionFilter) {
    systems = systems.filter((s) => {
      const jurisdictions = JSON.parse(s.jurisdictions || '[]') as string[];
      return jurisdictions.includes(jurisdictionFilter);
    });
  }

  // Summary of the listed systems (the AI-BOM page reads it; without it the
  // page's cards showed 0 systems next to a table of systems).
  const listedJurisdictions = new Set<string>();
  for (const s of systems) {
    for (const j of JSON.parse(s.jurisdictions || '[]') as string[]) listedJurisdictions.add(j);
  }

  return c.json({
    count: systems.length,
    systems: systems.map(serializeSystem),
    summary: {
      total: systems.length,
      highRisk: systems.filter((s) => s.riskClassification === 'high' || s.riskClassification === 'unacceptable').length,
      unclassified: systems.filter((s) => s.riskClassification === 'unclassified').length,
      jurisdictions: listedJurisdictions.size,
    },
  });
});

// ─── POST / — Register a new AI system ───────────────────────────

aiBomRoutes.post('/', async (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const { data: rawBody, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const body = rawBody as Record<string, any>;
  const now = new Date().toISOString();

  if (!body.name || !body.systemType) {
    return c.json({ error: 'name and systemType are required' }, 400);
  }

  const validTypes = ['model', 'pipeline', 'agent', 'embedding', 'fine_tune', 'other'];
  if (!validTypes.includes(body.systemType)) {
    return c.json({ error: `Invalid systemType. Must be one of: ${validTypes.join(', ')}` }, 400);
  }
  // Same enums PATCH enforces (POST stored any value, outside the schema enum).
  const validDeployments = ['production', 'staging', 'development', 'retired'];
  if (body.deploymentType !== undefined && !validDeployments.includes(body.deploymentType)) {
    return c.json({ error: `Invalid deploymentType. Must be one of: ${validDeployments.join(', ')}` }, 400);
  }
  const capabilities = Array.isArray(body.capabilities) ? body.capabilities : [];
  const dataFlows = Array.isArray(body.dataFlows) ? body.dataFlows : [];
  const jurisdictions = Array.isArray(body.jurisdictions) ? body.jurisdictions : [];

  // Auto-classify risk if not provided
  const riskClassification = body.riskClassification
    || classifyRisk(body.systemType, body.purpose || '', capabilities, body.euAiActCategory);

  const validRisks = ['unacceptable', 'high', 'limited', 'minimal', 'unclassified'];
  if (!validRisks.includes(riskClassification)) {
    return c.json({ error: `Invalid riskClassification. Must be one of: ${validRisks.join(', ')}` }, 400);
  }

  const id = randomUUID();

  db.insert(aiBomSystems).values({
    id,
    orgId,
    name: body.name,
    description: body.description || '',
    systemType: body.systemType,
    provider: body.provider || '',
    modelName: body.modelName || '',
    version: body.version || '',
    purpose: body.purpose || '',
    capabilities: JSON.stringify(capabilities),
    dataFlows: JSON.stringify(dataFlows),
    jurisdictions: JSON.stringify(jurisdictions),
    riskClassification,
    euAiActCategory: body.euAiActCategory || null,
    regulatoryTags: JSON.stringify(Array.isArray(body.regulatoryTags) ? body.regulatoryTags : []),
    deploymentType: body.deploymentType || 'development',
    detectedFrom: 'manual',
    scanFindingIds: '[]',
    lastAssessedAt: null,
    isActive: true,
    metadata: JSON.stringify(body.metadata || {}),
    createdAt: now,
    updatedAt: now,
  }).run();
  invalidateComplianceScore(orgId);

  const created = db.select().from(aiBomSystems)
    .where(eq(aiBomSystems.id, id))
    .get();

  return c.json(serializeSystem(created!), 201);
});

// ─── GET /:id — Get single AI system with matched rules ──────────

aiBomRoutes.get('/:id', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const id = c.req.param('id');

  const system = db.select().from(aiBomSystems)
    .where(and(eq(aiBomSystems.id, id), eq(aiBomSystems.orgId, orgId)))
    .get();

  if (!system) return c.json({ error: 'AI system not found' }, 404);

  // Match regulatory rules based on jurisdictions + regulatoryTags
  const jurisdictions = JSON.parse(system.jurisdictions || '[]') as string[];
  const regulatoryTags = JSON.parse(system.regulatoryTags || '[]') as string[];

  let matchedRules: (typeof policyRules.$inferSelect)[] = [];

  if (jurisdictions.length > 0 || regulatoryTags.length > 0) {
    const allRules = db.select().from(policyRules)
      .where(eq(policyRules.isActive, true))
      .all();

    matchedRules = allRules.filter((rule) => {
      const matchesJurisdiction = jurisdictions.includes(rule.jurisdiction);
      const matchesTag = regulatoryTags.includes(rule.ruleKey);
      return matchesJurisdiction || matchesTag;
    });
  }

  return c.json({
    ...serializeSystem(system),
    matchedRules: matchedRules.map((r) => ({
      id: r.id,
      ruleKey: r.ruleKey,
      jurisdiction: r.jurisdiction,
      category: r.category,
      severity: r.severity,
      effect: r.effect,
      humanSummary: r.humanSummary,
      effectiveDate: r.effectiveDate,
    })),
  });
});

// ─── PATCH /:id — Update AI system ───────────────────────────────

aiBomRoutes.patch('/:id', async (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const id = c.req.param('id');
  const { data: rawBody, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const body = rawBody as Record<string, any>;

  const existing = db.select().from(aiBomSystems)
    .where(and(eq(aiBomSystems.id, id), eq(aiBomSystems.orgId, orgId)))
    .get();

  if (!existing) return c.json({ error: 'AI system not found' }, 404);

  // Build update set, excluding immutable fields
  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };

  const stringFields = ['name', 'description', 'provider', 'modelName', 'version', 'purpose', 'euAiActCategory'] as const;
  for (const field of stringFields) {
    if (body[field] !== undefined) updates[field] = body[field];
  }

  const enumFields: Record<string, string[]> = {
    systemType: ['model', 'pipeline', 'agent', 'embedding', 'fine_tune', 'other'],
    riskClassification: ['unacceptable', 'high', 'limited', 'minimal', 'unclassified'],
    deploymentType: ['production', 'staging', 'development', 'retired'],
  };

  for (const [field, validValues] of Object.entries(enumFields)) {
    if (body[field] !== undefined) {
      if (!validValues.includes(body[field])) {
        return c.json({ error: `Invalid ${field}. Must be one of: ${validValues.join(', ')}` }, 400);
      }
      updates[field] = body[field];
    }
  }

  const jsonFields = ['capabilities', 'dataFlows', 'jurisdictions', 'regulatoryTags', 'metadata'] as const;
  for (const field of jsonFields) {
    if (body[field] !== undefined) {
      updates[field] = JSON.stringify(body[field]);
    }
  }

  if (body.isActive !== undefined) updates.isActive = body.isActive;
  if (body.lastAssessedAt !== undefined) updates.lastAssessedAt = body.lastAssessedAt;

  db.update(aiBomSystems)
    .set(updates)
    .where(and(eq(aiBomSystems.id, id), eq(aiBomSystems.orgId, orgId)))
    .run();
  invalidateComplianceScore(orgId);

  const updated = db.select().from(aiBomSystems)
    .where(eq(aiBomSystems.id, id))
    .get();

  return c.json(serializeSystem(updated!));
});

// ─── DELETE /:id — Soft delete (set isActive=false) ──────────────

aiBomRoutes.delete('/:id', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const id = c.req.param('id');

  const result = db.update(aiBomSystems)
    .set({ isActive: false, updatedAt: new Date().toISOString() })
    .where(and(eq(aiBomSystems.id, id), eq(aiBomSystems.orgId, orgId)))
    .run();

  if (result.changes === 0) return c.json({ error: 'AI system not found' }, 404);
  invalidateComplianceScore(orgId);

  return c.json({ message: 'AI system deactivated' });
});

// ─── HTML escaping helper ────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
